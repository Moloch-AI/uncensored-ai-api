// [mock:*] behavior triggers on non-streamed requests, and --unavailable.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CAP_NOTICE, parseTriggers, QUEUE_WAIT_MS } from '../../mock-server/chat.mjs';
import { postChat, startMock, unique, userChat } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({ unavailable: ['qwen3.8-27b-uncensored'] });
});
after(() => mock.close());

async function call(content, extra = {}, token = undefined) {
  const res = await postChat(mock.baseUrl, userChat(content, extra), { token });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

function assertIsoFuture(value, minMs, maxMs) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  const delta = Date.parse(value) - Date.now();
  assert.ok(delta > minMs && delta <= maxMs, `${value} is ${delta} ms ahead`);
}

describe('parseTriggers', () => {
  test('reads names and numeric values', () => {
    const t = parseTriggers('x [mock:flaky=2] y [mock:busy] [mock:slow=150] [MOCK:busy] [mock:]');
    assert.deepEqual(
      [...t.entries()],
      [
        ['flaky', 2],
        ['busy', true],
        ['slow', 150],
      ],
    );
  });
});

describe('quota and limits', () => {
  test('[mock:rate-limit] is 429 Too Many Attempts with Retry-After: 1', async () => {
    const { res, json } = await call('[mock:rate-limit]');
    assert.equal(res.status, 429);
    assert.deepEqual(json, { message: 'Too Many Attempts.' });
    assert.equal(res.headers.get('retry-after'), '1');
    assert.equal(res.headers.get('x-ratelimit-limit'), '60');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
  });

  test('[mock:quota] is 429 quota_exceeded with resets_at an hour ahead', async () => {
    const { res, json } = await call('[mock:quota]');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), null, 'quota errors carry no Retry-After');
    const { error } = json;
    assert.equal(error.type, 'quota_exceeded');
    assert.equal(error.plan, 'pro');
    assert.equal(typeof error.monthly_used, 'number');
    assert.equal(typeof error.monthly_cap, 'number');
    assertIsoFuture(error.resets_at, 3500_000, 3600_000);
  });

  test('[mock:session-quota] is 429 session_quota_exceeded with resets_at', async () => {
    const { res, json } = await call('[mock:session-quota]');
    assert.equal(res.status, 429);
    assert.equal(json.error.type, 'session_quota_exceeded');
    assertIsoFuture(json.error.resets_at, 0, 5 * 3600_000);
  });

  test('[mock:context] is 413 context_length_exceeded', async () => {
    const { res, json } = await call('[mock:context]');
    assert.equal(res.status, 413);
    const { error } = json;
    assert.equal(error.type, 'context_length_exceeded');
    assert.equal(error.context_cap, 65536);
    assert.equal(error.bound_by, 'plan');
    assert.equal(error.plan, 'pro');
    assert.ok(Number.isInteger(error.estimated_tokens) && error.estimated_tokens > error.context_cap);
  });
});

describe('availability and upstream failures', () => {
  test('[mock:busy] is 503 server_busy', async () => {
    const { res, json } = await call('[mock:busy]');
    assert.equal(res.status, 503);
    assert.equal(json.error.type, 'server_busy');
  });

  test('[mock:unavailable] is 503 model_unavailable with the model', async () => {
    const { res, json } = await call('[mock:unavailable]');
    assert.equal(res.status, 503);
    assert.equal(json.error.type, 'model_unavailable');
    assert.equal(json.error.model, 'glm-5.3-flash');
  });

  test('--unavailable ids are 503 model_unavailable and never rerouted', async () => {
    const { res, json } = await call('hi', { model: 'qwen3.8-27b-uncensored' });
    assert.equal(res.status, 503);
    assert.equal(json.error.type, 'model_unavailable');
    assert.equal(json.error.model, 'qwen3.8-27b-uncensored');
    const list = await (
      await fetch(`${mock.baseUrl}/models`, { headers: { Authorization: 'Bearer mock-key' } })
    ).json();
    assert.equal(list.data.find((m) => m.id === 'qwen3.8-27b-uncensored').available, false);
  });

  test('[mock:upstream-error] is 502 upstream_error with status, body, request_id', async () => {
    const { res, json } = await call('[mock:upstream-error]');
    assert.equal(res.status, 502);
    assert.equal(json.error.type, 'upstream_error');
    assert.equal(json.error.status, 500);
    assert.equal(typeof json.error.body, 'string');
    assert.equal(typeof json.error.request_id, 'string');
  });

  test('[mock:timeout] without streaming is 504 upstream_timeout', async () => {
    const { res, json } = await call('[mock:timeout]');
    assert.equal(res.status, 504);
    assert.equal(json.error.type, 'upstream_timeout');
  });

  test('[mock:preempted] without streaming is 502 upstream_unreachable', async () => {
    const { res, json } = await call('[mock:preempted]');
    assert.equal(res.status, 502);
    assert.equal(json.error.type, 'upstream_unreachable');
  });

  test('[mock:cloudflare-524] is 524 with an HTML body and no gateway headers', async () => {
    const { res, text, json } = await call('[mock:cloudflare-524]');
    assert.equal(res.status, 524);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(json, undefined, 'the body is not JSON');
    assert.match(text, /<html/);
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  });

  test('[mock:flaky=N] fails the first N identical bodies with 502, then succeeds', async () => {
    const content = `${unique('flaky')} [mock:flaky=2]`;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(content)).res.status);
    assert.deepEqual(statuses, [502, 502, 200, 200]);

    const failed = await call(`${unique('flaky')} [mock:flaky=1]`);
    assert.equal(failed.json.error.type, 'upstream_unreachable');
    assert.equal(typeof failed.json.error.request_id, 'string');
  });

  test('[mock:flaky=N] counts each distinct body separately', async () => {
    const a = `${unique('a')} [mock:flaky=1]`;
    const b = `${unique('b')} [mock:flaky=1]`;
    assert.equal((await call(a)).res.status, 502);
    assert.equal((await call(b)).res.status, 502);
    assert.equal((await call(a)).res.status, 200);
    assert.equal((await call(b)).res.status, 200);
  });
});

describe('reply modifiers', () => {
  test('[mock:cap] appends the cap notice and finishes with length', async () => {
    const { json } = await call('long answer [mock:cap]');
    assert.equal(json.choices[0].finish_reason, 'length');
    assert.ok(json.choices[0].message.content.endsWith(CAP_NOTICE));
  });

  test('[mock:inline-think] puts a <think> block in content and drops reasoning_content', async () => {
    const { json } = await call('think [mock:inline-think]');
    const { message } = json.choices[0];
    assert.ok(message.content.startsWith('<think>Mock inline reasoning.</think>'));
    assert.equal(message.reasoning_content, undefined);
  });

  test('[mock:queue] without streaming just waits', async () => {
    const started = performance.now();
    const { res } = await call('[mock:queue]');
    assert.equal(res.status, 200);
    assert.ok(performance.now() - started >= QUEUE_WAIT_MS - 5);
  });

  test('[mock:slow=MS] waits before answering', async () => {
    const started = performance.now();
    const { res } = await call('[mock:slow=300]');
    assert.equal(res.status, 200);
    assert.ok(performance.now() - started >= 295);
  });

  test('[mock:slow=MS] lets a client time out, and the server keeps serving', async () => {
    await assert.rejects(
      postChat(mock.baseUrl, userChat('[mock:slow=2000]'), { signal: AbortSignal.timeout(100) }),
      (err) => err.name === 'TimeoutError',
    );
    const res = await fetch(`${mock.origin}/health`);
    assert.equal(res.status, 200);
  });

  test('markers only count in the last user message', async () => {
    const res = await postChat(mock.baseUrl, {
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', content: '[mock:busy]' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'now answer' },
      ],
    });
    assert.equal(res.status, 200);
  });
});
