// 422 validation (shape B) for POST /chat/completions.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { postChat, startMock, userChat } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({ rateLimit: 0 });
});
after(() => mock.close());

async function expect422(body, field, message) {
  const res = await postChat(mock.baseUrl, body);
  assert.equal(res.status, 422, JSON.stringify(body));
  const json = await res.json();
  assert.equal(typeof json.message, 'string');
  assert.ok(json.errors && typeof json.errors === 'object', 'errors object');
  assert.deepEqual(json.errors[field], [message], JSON.stringify(json));
  return json;
}

const user = [{ role: 'user', content: 'hi' }];

test('model is required', async () => {
  await expect422({ messages: user }, 'model', 'The model field is required.');
  await expect422({ model: '', messages: user }, 'model', 'The model field is required.');
  await expect422({ model: null, messages: user }, 'model', 'The model field is required.');
});

test('an unknown model id is 422, not 404 or 503', async () => {
  const json = await expect422({ model: 'gpt-4o', messages: user }, 'model', 'The selected model is invalid.');
  assert.equal(json.message, 'The selected model is invalid.');
});

test('model must be a string', async () => {
  await expect422({ model: 42, messages: user }, 'model', 'The model field must be a string.');
});

test('messages are required and non-empty', async () => {
  await expect422({ model: 'glm-5.3-flash' }, 'messages', 'The messages field is required.');
  await expect422({ model: 'glm-5.3-flash', messages: [] }, 'messages', 'The messages field is required.');
  await expect422({ model: 'glm-5.3-flash', messages: 'hi' }, 'messages', 'The messages field must be an array.');
});

test('every message needs a valid role', async () => {
  await expect422(
    { model: 'glm-5.3-flash', messages: [{ content: 'hi' }] },
    'messages.0.role',
    'The messages.0.role field is required.',
  );
  await expect422(
    { model: 'glm-5.3-flash', messages: [...user, { role: 'developer', content: 'x' }] },
    'messages.1.role',
    'The selected messages.1.role is invalid.',
  );
  await expect422(
    { model: 'glm-5.3-flash', messages: ['hi'] },
    'messages.0.role',
    'The messages.0.role field is required.',
  );
});

test('all four roles are accepted', async () => {
  const res = await postChat(mock.baseUrl, {
    model: 'glm-5.3-flash',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
  });
  assert.equal(res.status, 200);
});

test('temperature must be within 0..2', async () => {
  await expect422(
    userChat('hi', { temperature: 2.5 }),
    'temperature',
    'The temperature field must not be greater than 2.',
  );
  await expect422(userChat('hi', { temperature: -0.1 }), 'temperature', 'The temperature field must be at least 0.');
  await expect422(userChat('hi', { temperature: 'warm' }), 'temperature', 'The temperature field must be a number.');
  for (const temperature of [0, 2, 0.7, '0.5', null]) {
    const res = await postChat(mock.baseUrl, userChat('hi', { temperature }));
    assert.equal(res.status, 200, String(temperature));
  }
});

test('top_p must be within 0..1', async () => {
  await expect422(userChat('hi', { top_p: 1.01 }), 'top_p', 'The top p field must not be greater than 1.');
  await expect422(userChat('hi', { top_p: -1 }), 'top_p', 'The top p field must be at least 0.');
  for (const top_p of [0, 1, 0.95]) {
    const res = await postChat(mock.baseUrl, userChat('hi', { top_p }));
    assert.equal(res.status, 200, String(top_p));
  }
});

test('max_tokens is accepted from 1 to 65536', async () => {
  await expect422(userChat('hi', { max_tokens: 0 }), 'max_tokens', 'The max tokens field must be at least 1.');
  await expect422(
    userChat('hi', { max_tokens: 65537 }),
    'max_tokens',
    'The max tokens field must not be greater than 65536.',
  );
  await expect422(userChat('hi', { max_tokens: 1.5 }), 'max_tokens', 'The max tokens field must be an integer.');
  const res = await postChat(mock.baseUrl, userChat('hi', { max_tokens: 1 }));
  assert.equal(res.status, 200);
  // It has no effect: the reply is not cut to one token.
  const body = await res.json();
  assert.ok(body.usage.completion_tokens > 1);
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('stream must be a boolean', async () => {
  await expect422(userChat('hi', { stream: 'yes' }), 'stream', 'The stream field must be true or false.');
});

test('several errors are summarized in message', async () => {
  const json = await expect422(
    { model: 'nope', messages: [], temperature: 9 },
    'model',
    'The selected model is invalid.',
  );
  assert.equal(json.message, 'The selected model is invalid. (and 2 more errors)');
  assert.deepEqual(Object.keys(json.errors), ['model', 'messages', 'temperature']);
});

test('a body that is not JSON is treated as empty', async () => {
  const res = await postChat(mock.baseUrl, '{not json');
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.deepEqual(Object.keys(json.errors), ['model', 'messages']);
});

test('parameters the gateway drops are ignored, not rejected', async () => {
  const res = await postChat(
    mock.baseUrl,
    userChat('hi', {
      stop: ['\n'],
      n: 3,
      seed: 7,
      response_format: { type: 'json_object' },
      top_k: 40,
      frequency_penalty: 1,
      presence_penalty: 1,
      logprobs: true,
      logit_bias: { 1: 2 },
      user: 'someone',
      stream_options: { include_usage: false },
      something_else: true,
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices.length, 1, 'n is ignored');
  assert.equal(body.choices[0].message.content, 'Mock reply from glm-5.3-flash: hi', 'response_format is ignored');
});
