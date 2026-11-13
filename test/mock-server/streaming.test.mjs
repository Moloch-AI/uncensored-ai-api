// Streaming: SSE framing and event order.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CAP_NOTICE } from '../../mock-server/chat.mjs';
import { postChat, readEvents, startMock, streamedContent, streamedReasoning, userChat } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({ rateLimit: 0 });
});
after(() => mock.close());

async function stream(body) {
  const res = await postChat(mock.baseUrl, { ...body, stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  return readEvents(res);
}

/** Summarize a stream as a list of event kinds, for order checks. */
function shape(events) {
  return events.map((e) => {
    if (e.kind === 'comment') return e.text === 'ka' ? 'ka' : 'comment';
    if (e.raw === '[DONE]') return 'done';
    if (e.json.error) return 'error';
    if (e.json.choices.length === 0) return 'usage';
    const [choice] = e.json.choices;
    if (choice.finish_reason) return 'finish';
    if (choice.delta.role) return 'role';
    if (choice.delta.reasoning_content !== undefined) return 'reasoning';
    if (choice.delta.tool_calls) return 'tool_calls';
    if (choice.delta.content !== undefined) return 'content';
    return 'other';
  });
}

/** Collapse runs: ['a','a','b'] -> ['a','b']. */
function runs(list) {
  return list.filter((x, i) => x !== list[i - 1]);
}

describe('event order', () => {
  test('role, reasoning, ": ka", content, finish, usage, [DONE]', async () => {
    const events = await stream(userChat('stream me please'));
    assert.deepEqual(runs(shape(events)), ['role', 'reasoning', 'ka', 'content', 'finish', 'usage', 'done']);

    const role = events[0].json.choices[0];
    assert.deepEqual(role.delta, { role: 'assistant', content: '' });
    assert.equal(role.finish_reason, null);

    const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason);
    assert.equal(finish.json.choices[0].finish_reason, 'stop');
    assert.deepEqual(finish.json.choices[0].delta, {});
  });

  test('every chunk shares one id, the model and object type', async () => {
    const events = await stream(userChat('ids'));
    const chunks = events.filter((e) => e.json);
    const ids = new Set(chunks.map((e) => e.json.id));
    assert.equal(ids.size, 1);
    assert.match([...ids][0], /^chatcmpl-mock-\d+$/);
    for (const { json } of chunks) {
      assert.equal(json.object, 'chat.completion.chunk');
      assert.equal(json.model, 'glm-5.3-flash');
      assert.equal(typeof json.created, 'number');
    }
  });

  test('content is split on spaces and reassembles to the non-streamed reply', async () => {
    const text = 'one two  three';
    const events = await stream(userChat(text));
    const pieces = events
      .filter((e) => e.json?.choices?.[0]?.delta?.content)
      .map((e) => e.json.choices[0].delta.content);
    assert.deepEqual(pieces.slice(-4), ['one ', 'two ', ' ', 'three']);

    const plain = await (await postChat(mock.baseUrl, userChat(text))).json();
    assert.equal(streamedContent(events), plain.choices[0].message.content);
    assert.equal(streamedReasoning(events), plain.choices[0].message.reasoning_content);
  });

  test('the usage chunk has empty choices and matches the non-streamed usage', async () => {
    const body = userChat('count my tokens');
    const events = await stream(body);
    const usage = events.find((e) => e.json && e.json.choices.length === 0);
    const plain = await (await postChat(mock.baseUrl, body)).json();
    assert.deepEqual(usage.json.usage, plain.usage);
    assert.equal(usage.json.usage.total_tokens, usage.json.usage.prompt_tokens + usage.json.usage.completion_tokens);
  });

  test('the non-reasoning model streams no reasoning', async () => {
    const events = await stream(userChat('hi', { model: 'llama-3.3-70b-instruct-abliterated' }));
    assert.deepEqual(runs(shape(events)), ['role', 'ka', 'content', 'finish', 'usage', 'done']);
  });

  test('framing: every event is "data: ..." or ": ..." followed by a blank line', async () => {
    const res = await postChat(mock.baseUrl, userChat('frame', { stream: true }));
    const raw = await res.text();
    assert.ok(raw.endsWith('data: [DONE]\n\n'));
    for (const block of raw.split('\n\n').filter(Boolean)) {
      assert.match(block, /^(data: .+|: .+)$/);
    }
  });

  test('--delay-ms spaces the chunks out', async () => {
    const slow = await startMock({ delayMs: 20, rateLimit: 0 });
    try {
      const started = performance.now();
      const res = await postChat(slow.baseUrl, userChat('a b c d e', { stream: true }));
      await res.text();
      // role + 4 reasoning + 10 content pieces + finish: at least ~14 pauses.
      assert.ok(performance.now() - started >= 200, 'stream should take at least 200 ms');
    } finally {
      await slow.close();
    }
  });
});

describe('tool calls', () => {
  test('arrive whole in one chunk, then finish_reason tool_calls', async () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      },
    ];
    const events = await stream(userChat('find it', { tools }));
    assert.deepEqual(runs(shape(events)), ['role', 'reasoning', 'ka', 'tool_calls', 'finish', 'usage', 'done']);
    const toolChunks = events.filter((e) => e.json?.choices?.[0]?.delta?.tool_calls);
    assert.equal(toolChunks.length, 1);
    const [call] = toolChunks[0].json.choices[0].delta.tool_calls;
    assert.equal(call.index, 0);
    assert.match(call.id, /^call_mock_\d+$/);
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'search');
    assert.deepEqual(JSON.parse(call.function.arguments), { q: 'example' });
    const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason);
    assert.equal(finish.json.choices[0].finish_reason, 'tool_calls');
  });
});

describe('stream triggers', () => {
  test('[mock:queue] sends queue comments before any data', async () => {
    const events = await stream(userChat('wait [mock:queue]'));
    assert.deepEqual(
      events.slice(0, 2).map((e) => e.text),
      ['queued · position 2 of 3 · waiting 1s', 'queued · position 1 of 3 · waiting 2s'],
    );
    assert.deepEqual(runs(shape(events)), ['comment', 'role', 'reasoning', 'ka', 'content', 'finish', 'usage', 'done']);
  });

  test('[mock:cap] appends the cap notice and finishes with length', async () => {
    const events = await stream(userChat('long [mock:cap]'));
    assert.ok(streamedContent(events).endsWith(CAP_NOTICE));
    const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason);
    assert.equal(finish.json.choices[0].finish_reason, 'length');
    assert.equal(CAP_NOTICE, '\n\n[Response is too large for your current plan. Try a smaller request.]');
  });

  test('[mock:inline-think] streams normally (no <think> in content)', async () => {
    const events = await stream(userChat('think [mock:inline-think]'));
    assert.ok(!streamedContent(events).includes('<think>'));
    assert.equal(streamedReasoning(events), 'Mock reasoning for glm-5.3-flash.');
  });

  test('[mock:timeout] sends some content, an upstream_timeout event, then [DONE]', async () => {
    const events = await stream(userChat('one two three four five [mock:timeout]'));
    assert.deepEqual(runs(shape(events)), ['role', 'reasoning', 'ka', 'content', 'error', 'done']);
    assert.equal(streamedContent(events), 'Mock reply ');
    const error = events.find((e) => e.json?.error).json.error;
    assert.equal(error.type, 'upstream_timeout');
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.elapsed_s, 'number');
  });

  test('[mock:preempted] sends some content, a preempted event, then [DONE]', async () => {
    const events = await stream(userChat('go [mock:preempted]'));
    assert.deepEqual(runs(shape(events)), ['role', 'reasoning', 'ka', 'content', 'error', 'done']);
    const error = events.find((e) => e.json?.error).json.error;
    assert.equal(error.type, 'preempted');
  });

  test('HTTP-level triggers fail before the stream opens', async () => {
    const res = await postChat(mock.baseUrl, userChat('[mock:busy]', { stream: true }));
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal((await res.json()).error.type, 'server_busy');
  });
});

describe('client disconnects', () => {
  test('the server survives a client that hangs up mid-stream', async () => {
    const slow = await startMock({ delayMs: 30, rateLimit: 0 });
    try {
      const controller = new AbortController();
      const res = await postChat(slow.baseUrl, userChat('a b c d e f g h', { stream: true }), {
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      await reader.read();
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));
      const health = await fetch(`${slow.origin}/health`);
      assert.equal(health.status, 200);
    } finally {
      await slow.close();
    }
  });
});
