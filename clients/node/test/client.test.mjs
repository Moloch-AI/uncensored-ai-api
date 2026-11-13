// The reference client against the mock server, run as a subprocess.
// Retries use an injected sleep that records delays instead of waiting.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { collectStream, MolochAI, MolochAIError } from '../molochai-http.mjs';
import { startMock } from './mock.mjs';

const MODEL = 'glm-5.3-flash';
let mock;
let slowStream;
let counter = 0;

before(async () => {
  [mock, slowStream] = await Promise.all([
    startMock('--unavailable', 'qwen3.8-27b-uncensored', '--rate-limit', '0'),
    startMock('--delay-ms', '400', '--rate-limit', '0'),
  ]);
});
after(async () => {
  await Promise.all([mock.stop(), slowStream.stop()]);
});

/** Bodies differ per test, so [mock:flaky=N] counters never collide. */
const unique = (text) => `${text} #${process.pid}-${Date.now()}-${++counter}`;
const user = (content) => [{ role: 'user', content }];

let sleeps;
let retries;
beforeEach(() => {
  sleeps = [];
  retries = [];
});

function client(options = {}) {
  return new MolochAI({
    apiKey: 'mock-key',
    baseUrl: mock.baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1, // upper bound of the jitter, so delays are predictable
    onRetry: (err, attempt, delay) => retries.push([err.type, attempt, delay]),
    ...options,
  });
}

async function expectError(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof MolochAIError, `expected MolochAIError, got ${err}`);
    return err;
  }
  assert.fail('expected an error');
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('requests', () => {
  test('chat', async () => {
    const reply = await client().chat(MODEL, user('Hello'), { temperature: 0.2, top_p: 0.9, max_tokens: 50 });
    assert.equal(reply.object, 'chat.completion');
    assert.equal(reply.model, MODEL);
    const [choice] = reply.choices;
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(choice.message.content, `Mock reply from ${MODEL}: Hello`);
    assert.equal(choice.message.reasoning_content, `Mock reasoning for ${MODEL}.`);
    assert.equal(reply.usage.total_tokens, reply.usage.prompt_tokens + reply.usage.completion_tokens);
    assert.deepEqual(sleeps, []);
  });

  test('tool call round trip', async () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      },
    ];
    const c = client();
    const first = await c.chat(MODEL, user('Weather in Oslo?'), { tools });
    const { message } = first.choices[0];
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const [call] = message.tool_calls;
    assert.equal(call.function.arguments, '{"city":"example"}');
    const second = await c.chat(
      MODEL,
      [...user('Weather in Oslo?'), message, { role: 'tool', tool_call_id: call.id, content: '4 C' }],
      { tools },
    );
    assert.equal(second.choices[0].message.content, `Mock reply from ${MODEL} after tool get_weather: 4 C`);
  });

  test('models', async () => {
    const models = await client().models();
    assert.equal(models.length, 5);
    assert.equal(models.find((m) => m.id === 'qwen3.8-27b-uncensored').available, false);
  });

  test('me is derived from the base URL', async () => {
    const me = await client().me();
    assert.equal(me.api_base, mock.baseUrl);
    assert.equal(me.email, 'dev@example.com');
  });

  test('a caller abort is passed through, not retried', async () => {
    const controller = new AbortController();
    const pending = client().chat(MODEL, user('[mock:slow=2000]'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.deepEqual(sleeps, []);
  });
});

describe('streaming', () => {
  test('chunks, reasoning and the usage chunk', async () => {
    const chunks = await drain(client().chatStream(MODEL, user('Stream this please')));
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.deepEqual(chunks.at(-1).choices, []);
    const result = await collectStream(chunks);
    assert.equal(result.content, `Mock reply from ${MODEL}: Stream this please`);
    assert.equal(result.reasoning, `Mock reasoning for ${MODEL}.`);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, chunks.at(-1).usage);
  });

  test('queue progress and comments', async () => {
    const queue = [];
    const comments = [];
    const result = await collectStream(
      client().chatStream(MODEL, user('wait [mock:queue]'), {
        onQueue: (q) => queue.push(q),
        onComment: (c) => comments.push(c),
      }),
    );
    assert.deepEqual(queue, [
      { position: 2, total: 3, waitedS: 1 },
      { position: 1, total: 3, waitedS: 2 },
    ]);
    assert.ok(comments.includes('ka'));
    assert.ok(!result.content.includes('queued'));
  });

  test('tool call and cap notice', async () => {
    const tools = [{ type: 'function', function: { name: 'search', parameters: { properties: { q: {} } } } }];
    const withTool = await collectStream(client().chatStream(MODEL, user('find'), { tools }));
    assert.equal(withTool.finishReason, 'tool_calls');
    assert.deepEqual(withTool.toolCalls[0].function, { name: 'search', arguments: '{"q":null}' });

    const capped = await collectStream(client().chatStream(MODEL, user('long [mock:cap]')));
    assert.equal(capped.hitOutputCap, true);
    assert.equal(capped.finishReason, 'length');
  });

  test('in-stream errors are thrown after the content so far, and not retried', async () => {
    for (const [marker, type] of [
      ['[mock:timeout]', 'upstream_timeout'],
      ['[mock:preempted]', 'preempted'],
    ]) {
      const received = [];
      const err = await expectError(
        (async () => {
          for await (const chunk of client().chatStream(MODEL, user(`a b c ${marker}`))) received.push(chunk);
        })(),
      );
      assert.deepEqual([err.status, err.type, err.inStream], [200, type, true]);
      assert.equal((await collectStream(received)).content, 'Mock reply ');
    }
    assert.deepEqual(sleeps, []);
  });

  test('errors before the stream opens are retried', async () => {
    const result = await collectStream(client().chatStream(MODEL, user(unique('[mock:flaky=1]'))));
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(sleeps, [500]);
  });

  test('stopping early closes the stream', async () => {
    for await (const chunk of client().chatStream(MODEL, user('a b c d e f'))) {
      if (chunk.choices[0]?.delta?.content) break;
    }
    // The connection is released: a follow-up request works.
    assert.equal((await client().models()).length, 5);
  });

  test('a stalled stream hits the read timeout', async () => {
    const c = client({ baseUrl: slowStream.baseUrl, readTimeoutMs: 150 });
    const err = await expectError(drain(c.chatStream(MODEL, user('slow chunks'))));
    assert.deepEqual([err.type, err.inStream], ['timeout', true]);
  });
});

describe('error mapping', () => {
  test('401', async () => {
    // fetch trims header values, so "Bearer " + spaces arrives as "Bearer".
    const err = await expectError(client({ apiKey: ' ' }).models());
    assert.deepEqual([err.status, err.type], [401, 'unauthenticated']);
    assert.deepEqual(err.body, { message: 'Unauthenticated.' });
    assert.deepEqual(sleeps, []);
  });

  test('402 and 403 (and /auth/me still answers)', async () => {
    const noPlan = await expectError(client({ apiKey: 'mock-no-plan' }).chat(MODEL, user('hi')));
    assert.deepEqual([noPlan.status, noPlan.type], [402, 'no_active_plan']);
    const unverified = client({ apiKey: 'mock-unverified' });
    const err = await expectError(unverified.models());
    assert.deepEqual([err.status, err.type], [403, 'email_unverified']);
    assert.equal((await unverified.me()).email_verified, false);
    assert.deepEqual(sleeps, []);
  });

  test('413 and 422', async () => {
    const context = await expectError(client().chat(MODEL, user('[mock:context]')));
    assert.deepEqual([context.status, context.type], [413, 'context_length_exceeded']);
    assert.equal(context.body.error.context_cap, 65536);
    const invalid = await expectError(client().chat('no-such-model', user('hi')));
    assert.deepEqual([invalid.status, invalid.type], [422, 'validation_error']);
    assert.deepEqual(invalid.body.errors.model, ['The selected model is invalid.']);
    assert.deepEqual(sleeps, []);
  });

  test('quota 429s are not retried and expose resetsAt', async () => {
    for (const [marker, type] of [
      ['[mock:quota]', 'quota_exceeded'],
      ['[mock:session-quota]', 'session_quota_exceeded'],
    ]) {
      const err = await expectError(client().chat(MODEL, user(marker)));
      assert.deepEqual([err.status, err.type], [429, type]);
      assert.ok(err.resetsAt instanceof Date && err.resetsAt > new Date());
    }
    assert.deepEqual(sleeps, []);
  });

  test('model_unavailable is not retried', async () => {
    const err = await expectError(client().chat('qwen3.8-27b-uncensored', user('hi')));
    assert.deepEqual([err.status, err.type], [503, 'model_unavailable']);
    assert.equal(err.body.error.model, 'qwen3.8-27b-uncensored');
    assert.deepEqual(sleeps, []);
  });
});

describe('retries', () => {
  test('rate limit waits Retry-After, capped', async () => {
    const err = await expectError(client({ maxRetries: 2 }).chat(MODEL, user('[mock:rate-limit]')));
    assert.deepEqual([err.status, err.type, err.retryAfterMs], [429, 'rate_limited', 1000]);
    assert.deepEqual(sleeps, [1000, 1000]);

    sleeps.length = 0;
    await expectError(client({ maxRetries: 1, maxRetryAfterMs: 250 }).chat(MODEL, user('[mock:rate-limit]')));
    assert.deepEqual(sleeps, [250]);
  });

  test('502, 503 server_busy, 504 and 524 back off, then throw', async () => {
    for (const [marker, status, type] of [
      ['[mock:busy]', 503, 'server_busy'],
      ['[mock:upstream-error]', 502, 'upstream_error'],
      ['[mock:timeout]', 504, 'upstream_timeout'],
      ['[mock:preempted]', 502, 'upstream_unreachable'],
      ['[mock:cloudflare-524]', 524, 'cloudflare_timeout'],
    ]) {
      sleeps.length = 0;
      retries.length = 0;
      const err = await expectError(client().chat(MODEL, user(marker)));
      assert.deepEqual([err.status, err.type], [status, type], marker);
      assert.deepEqual(sleeps, [500, 1000, 2000], marker);
      assert.deepEqual(
        retries.map(([, attempt]) => attempt),
        [1, 2, 3],
      );
    }
  });

  test('the 524 body is kept as text', async () => {
    const err = await expectError(client({ maxRetries: 0 }).chat(MODEL, user('[mock:cloudflare-524]')));
    assert.equal(typeof err.body, 'string');
    assert.match(err.body, /<html/);
  });

  test('flaky recovers within the budget, or fails beyond it', async () => {
    const reply = await client().chat(MODEL, user(unique('[mock:flaky=2]')));
    assert.equal(reply.choices[0].finish_reason, 'stop');
    assert.deepEqual(sleeps, [500, 1000]);
    assert.deepEqual(
      retries.map(([type]) => type),
      ['upstream_unreachable', 'upstream_unreachable'],
    );

    sleeps.length = 0;
    const err = await expectError(client({ maxRetries: 2 }).chat(MODEL, user(unique('[mock:flaky=5]'))));
    assert.equal(err.type, 'upstream_unreachable');
    assert.equal(sleeps.length, 2);
  });

  test('maxRetries 0 disables retrying', async () => {
    await expectError(client({ maxRetries: 0 }).chat(MODEL, user('[mock:busy]')));
    assert.deepEqual(sleeps, []);
  });

  test('connection errors are retried', async () => {
    const port = await new Promise((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port: p } = s.address();
        s.close(() => resolve(p));
      });
    });
    const err = await expectError(
      client({ baseUrl: `http://127.0.0.1:${port}/api/v1`, maxRetries: 2, readTimeoutMs: 3000 }).models(),
    );
    assert.deepEqual([err.status, err.type], [null, 'connection_error']);
    assert.deepEqual(sleeps, [500, 1000]);
  });
});

describe('timeouts', () => {
  test('a plain request past readTimeoutMs is not retried by default', async () => {
    const started = performance.now();
    const err = await expectError(client({ readTimeoutMs: 200 }).chat(MODEL, user('[mock:slow=1500]')));
    assert.deepEqual([err.status, err.type], [null, 'timeout']);
    assert.ok(performance.now() - started < 1400);
    assert.deepEqual(sleeps, []);
  });

  test('retried when asked', async () => {
    const c = client({ readTimeoutMs: 200, retryOnTimeout: true, maxRetries: 1 });
    const err = await expectError(c.chat(MODEL, user('[mock:slow=1500]')));
    assert.equal(err.type, 'timeout');
    assert.deepEqual(sleeps, [500]);
  });

  test('a stream that does not start within connectTimeoutMs is a connection error (retried)', async () => {
    const c = client({ connectTimeoutMs: 150, maxRetries: 1 });
    const err = await expectError(drain(c.chatStream(MODEL, user('[mock:slow=1000]'))));
    assert.deepEqual([err.status, err.type, err.inStream], [null, 'connection_error', false]);
    assert.deepEqual(sleeps, [500]);
  });

  test('a slow reply within the timeout succeeds', async () => {
    const reply = await client({ readTimeoutMs: 5000 }).chat(MODEL, user('[mock:slow=300]'));
    assert.equal(reply.choices[0].finish_reason, 'stop');
  });
});
