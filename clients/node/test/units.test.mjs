// Pure unit tests: SSE parser, queue comments, stream folding, error
// mapping, retry decisions and the backoff schedule. No network.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  backoffDelay,
  CAP_NOTICE,
  collectStream,
  errorFromResponse,
  MolochAI,
  MolochAIError,
  meUrl,
  parseQueueComment,
  parseRetryAfter,
  retryDecision,
  SSEParser,
} from '../molochai-http.mjs';

function feedAll(parser, text) {
  const events = [];
  for (const line of text.split(/(?<=\n)/)) {
    const event = parser.feed(line);
    if (event !== null) events.push(event);
  }
  return events;
}

describe('SSEParser', () => {
  test('data events end at blank lines', () => {
    assert.deepEqual(feedAll(new SSEParser(), 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'), [
      '{"a":1}',
      '{"b":2}',
      '[DONE]',
    ]);
  });

  test('comments are never payload but reach the callback', () => {
    const seen = [];
    const parser = new SSEParser({ onComment: (t) => seen.push(t) });
    const events = feedAll(parser, ': ka\n\n: queued · position 2 of 3 · waiting 4s\n\ndata: x\n\n: hb\n\n');
    assert.deepEqual(events, ['x']);
    assert.deepEqual(seen, ['ka', 'queued · position 2 of 3 · waiting 4s', 'hb']);
  });

  test('a comment inside an event is skipped', () => {
    assert.deepEqual(feedAll(new SSEParser(), 'data: a\n: ka\ndata: b\n\n'), ['a\nb']);
  });

  test('multi-line data, CRLF and no space after the colon', () => {
    assert.deepEqual(feedAll(new SSEParser(), 'data:one\r\ndata:  two\r\n\r\n'), ['one\n two']);
  });

  test('other fields are ignored; empty blocks dispatch nothing', () => {
    assert.deepEqual(feedAll(new SSEParser(), 'event: message\nid: 7\nretry: 100\ndata: x\n\n\n\n'), ['x']);
  });

  test('flush returns an unterminated event', () => {
    const parser = new SSEParser();
    assert.equal(parser.feed('data: tail\n'), null);
    assert.equal(parser.flush(), 'tail');
    assert.equal(parser.flush(), null);
  });
});

describe('parseQueueComment', () => {
  test('parses the gateway format and nothing else', () => {
    assert.deepEqual(parseQueueComment('queued · position 2 of 3 · waiting 4s'), { position: 2, total: 3, waitedS: 4 });
    for (const text of ['ka', 'hb', 'queued', '']) assert.equal(parseQueueComment(text), null);
  });
});

describe('collectStream', () => {
  const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

  test('joins content and reasoning, reads the usage chunk', async () => {
    const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const result = await collectStream([
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: 'think ' }),
      chunk({ reasoning_content: 'hard' }),
      chunk({ content: 'Hello ' }),
      chunk({ content: null }),
      chunk({ content: 'world' }),
      chunk({}, 'stop'),
      { choices: [], usage },
    ]);
    assert.equal(result.content, 'Hello world');
    assert.equal(result.reasoning, 'think hard');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, usage);
    assert.equal(result.hitOutputCap, false);
  });

  test('joins tool-call fragments by index', async () => {
    const result = await collectStream([
      chunk({ tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'a' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ' 1}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    assert.deepEqual(result.toolCalls, [
      { id: 'c0', type: 'function', function: { name: 'a', arguments: '{"x": 1}' } },
      { id: 'c1', type: 'function', function: { name: 'b', arguments: '{}' } },
    ]);
  });

  test('cap notice and onChunk', async () => {
    const seen = [];
    const result = await collectStream([chunk({ content: `partial${CAP_NOTICE}` }), chunk({}, 'length')], {
      onChunk: (c) => seen.push(c),
    });
    assert.equal(result.hitOutputCap, true);
    assert.equal(seen.length, 2);
  });
});

describe('errorFromResponse', () => {
  test('shape A with resets_at', () => {
    const err = errorFromResponse(
      429,
      { 'Content-Type': 'application/json' },
      '{"error":{"type":"quota_exceeded","message":"cap","resets_at":"2026-12-01T00:00:00+00:00","plan":"pro"}}',
    );
    assert.equal(err.status, 429);
    assert.equal(err.type, 'quota_exceeded');
    assert.equal(err.message, 'cap');
    assert.equal(err.resetsAt.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(err.body.error.plan, 'pro');
    assert.equal(err.retryAfterMs, null);
  });

  test('shape B', () => {
    const err = errorFromResponse(422, {}, '{"message":"bad","errors":{"model":["The selected model is invalid."]}}');
    assert.equal(err.type, 'validation_error');
    assert.deepEqual(err.body.errors.model, ['The selected model is invalid.']);
  });

  test('shape C', () => {
    assert.equal(errorFromResponse(401, {}, '{"message":"Unauthenticated."}').type, 'unauthenticated');
    const rate = errorFromResponse(429, new Headers({ 'Retry-After': '7' }), '{"message":"Too Many Attempts."}');
    assert.equal(rate.type, 'rate_limited');
    assert.equal(rate.retryAfterMs, 7000);
    assert.equal(
      errorFromResponse(403, {}, '{"message":"Verify.","code":"email_unverified"}').type,
      'email_unverified',
    );
    assert.equal(errorFromResponse(404, {}, '{"message":"Not found."}').type, 'http_error');
  });

  test('non-JSON bodies', () => {
    const err = errorFromResponse(524, { 'content-type': 'text/html' }, '<html>timeout</html>');
    assert.equal(err.type, 'cloudflare_timeout');
    assert.equal(err.body, '<html>timeout</html>');
    assert.equal(errorFromResponse(500, {}, '').type, 'http_error');
    assert.equal(errorFromResponse(500, {}, '[1,2]').type, 'http_error');
  });

  test('requestId and toString', () => {
    const err = errorFromResponse(502, {}, '{"error":{"type":"upstream_error","message":"m","request_id":"r-1"}}');
    assert.equal(err.requestId, 'r-1');
    assert.equal(String(err), 'HTTP 502 upstream_error: m');
    assert.equal(String(new MolochAIError('x', { type: 'connection_error' })), 'no response connection_error: x');
  });

  test('parseRetryAfter: seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:30 GMT', 0), 30_000);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter(undefined), null);
  });
});

describe('retryDecision', () => {
  const decide = (status, type, opts) => retryDecision(new MolochAIError('m', { status, type }), opts);

  test('backoff cases', () => {
    for (const [status, type] of [
      [502, 'upstream_unreachable'],
      [502, 'upstream_timeout'],
      [502, 'no_usage_accounting'],
      [502, 'upstream_error'],
      [503, 'server_busy'],
      [504, 'upstream_timeout'],
      [524, 'cloudflare_timeout'],
      [500, 'upstream_error'],
      [null, 'connection_error'],
    ]) {
      assert.equal(decide(status, type), 'backoff', `${status} ${type}`);
    }
  });

  test('rate limit waits Retry-After', () => {
    assert.equal(decide(429, 'rate_limited'), 'retry_after');
  });

  test('never retried', () => {
    for (const [status, type] of [
      [401, 'unauthenticated'],
      [402, 'no_active_plan'],
      [403, 'email_unverified'],
      [413, 'context_length_exceeded'],
      [422, 'validation_error'],
      [429, 'quota_exceeded'],
      [429, 'session_quota_exceeded'],
      [503, 'model_unavailable'],
      [404, 'http_error'],
    ]) {
      assert.equal(decide(status, type), null, `${status} ${type}`);
    }
  });

  test('timeouts only on request; in-stream errors never', () => {
    assert.equal(decide(null, 'timeout'), null);
    assert.equal(decide(null, 'timeout', { retryOnTimeout: true }), 'backoff');
    assert.equal(retryDecision(new MolochAIError('m', { status: 200, type: 'server_busy', inStream: true })), null);
  });
});

describe('backoffDelay', () => {
  test('the bound doubles until the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, { random: () => 1 }));
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test('full jitter scales the bound', () => {
    assert.equal(backoffDelay(3, { random: () => 0 }), 0);
    assert.equal(backoffDelay(3, { random: () => 0.25 }), 1000);
    for (let n = 0; n < 6; n++) {
      const d = backoffDelay(n);
      assert.ok(d >= 0 && d < Math.min(8000, 500 * 2 ** n));
    }
  });
});

describe('configuration', () => {
  test('meUrl', () => {
    assert.equal(meUrl('https://api.molochai.dev/api/v1'), 'https://api.molochai.dev/api/auth/me');
    assert.equal(meUrl('http://127.0.0.1:4010/api/v1/'), 'http://127.0.0.1:4010/api/auth/me');
    assert.throws(() => meUrl('https://api.molochai.dev/openai'), /does not end in \/v1/);
  });

  test('defaults, env and a missing key', () => {
    const saved = { key: process.env.MOLOCHAI_API_KEY, base: process.env.MOLOCHAI_BASE_URL };
    try {
      delete process.env.MOLOCHAI_API_KEY;
      delete process.env.MOLOCHAI_BASE_URL;
      assert.throws(() => new MolochAI(), /No API key/);
      process.env.MOLOCHAI_API_KEY = 'k';
      assert.equal(new MolochAI().baseUrl, 'https://api.molochai.dev/api/v1');
      process.env.MOLOCHAI_BASE_URL = 'http://127.0.0.1:1/api/v1/';
      assert.equal(new MolochAI().baseUrl, 'http://127.0.0.1:1/api/v1');
    } finally {
      for (const [name, value] of [
        ['MOLOCHAI_API_KEY', saved.key],
        ['MOLOCHAI_BASE_URL', saved.base],
      ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('the key is not visible on the instance', () => {
    const client = new MolochAI({ apiKey: 'secret-key' });
    assert.ok(!JSON.stringify(client).includes('secret-key'));
    assert.ok(!Object.values(client).includes('secret-key'));
  });
});
