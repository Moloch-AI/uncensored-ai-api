// Conformance: every response the mock produces must match openapi.yaml.
//
// For each scenario, the test finds the documented response for the
// operation and status, checks the media type, validates the body against the
// documented schema (each SSE data payload against ChatCompletionStreamEvent),
// and checks that the gateway headers the mock sent are documented for that
// response. At the end it checks that every documented status was exercised.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockServer } from '../../mock-server/app.mjs';
import { documentedResponse, formatErrors, operation, responseValidator, spec, streamEventValidator } from './spec.mjs';

const KEY = 'mock-key';
const GATEWAY_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'];

let mock;
let tight; // a mock with a rate limit of 1, for the /models 429
const exercised = new Set();

before(async () => {
  const quiet = { port: 0, delayMs: 0, quiet: true };
  mock = await startMockServer({ ...quiet, unavailable: ['qwen3.8-27b-uncensored'] });
  tight = await startMockServer({ ...quiet, rateLimit: 1 });
});
after(async () => {
  await mock.close();
  await tight.close();
});

/**
 * Call the mock and check the response against the spec.
 * @param {string} method
 * @param {string} specPath path as written in openapi.yaml
 * @param {{base?: string, url?: string, token?: string|null, body?: object}} options
 */
async function conform(method, specPath, { base, url, token = KEY, body } = {}) {
  const target = url ?? `${base ?? mock.baseUrl}${specPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(target, { method, headers, body: body && JSON.stringify(body) });
  const status = res.status;
  exercised.add(`${method} ${specPath} ${status}`);

  const documented = documentedResponse(method, specPath, status);
  assert.ok(documented, `${method} ${specPath} returned ${status}, which openapi.yaml does not document`);

  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  assert.ok(
    documented.content?.[mediaType],
    `${method} ${specPath} ${status}: media type ${mediaType} is not documented`,
  );

  for (const name of GATEWAY_HEADERS) {
    const value = res.headers.get(name);
    if (value === null) continue;
    const documentedHeaders = Object.keys(documented.headers ?? {}).map((h) => h.toLowerCase());
    assert.ok(documentedHeaders.includes(name), `${method} ${specPath} ${status}: header ${name} is not documented`);
    assert.match(value, /^\d+$/, `${name} must be an integer`);
  }

  const text = await res.text();
  if (mediaType === 'text/event-stream') {
    const validate = streamEventValidator();
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)));
    assert.ok(payloads.length > 0);
    for (const payload of payloads) {
      assert.ok(validate(payload), `stream event ${JSON.stringify(payload)}\n${formatErrors(validate)}`);
    }
    assert.ok(text.endsWith('data: [DONE]\n\n'));
    return { status, payloads };
  }

  const validate = responseValidator(method, specPath, status, mediaType);
  const parsed = mediaType === 'application/json' ? JSON.parse(text) : text;
  assert.ok(validate(parsed), `${method} ${specPath} ${status}: ${text}\n${formatErrors(validate)}`);
  return { status, body: parsed };
}

const chat = (content, extra = {}) => ({
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content }],
  ...extra,
});

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

describe('the spec itself', () => {
  test('declares production and mock servers, and bearer auth', () => {
    assert.equal(spec.openapi, '3.1.0');
    assert.deepEqual(
      spec.servers.map((s) => s.url),
      ['https://api.molochai.dev/api/v1', 'http://127.0.0.1:4010/api/v1'],
    );
    assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  });

  test('/auth/me overrides servers to live outside /v1', () => {
    assert.deepEqual(
      spec.paths['/auth/me'].servers.map((s) => s.url),
      ['https://api.molochai.dev/api', 'http://127.0.0.1:4010/api'],
    );
  });

  test('documents exactly the three public operations', () => {
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/auth/me', '/chat/completions', '/models']);
    assert.ok(operation('POST', '/chat/completions'));
    assert.ok(operation('GET', '/models'));
    assert.ok(operation('GET', '/auth/me'));
  });

  test('the request schema lists only the parameters that reach the model', () => {
    const props = Object.keys(spec.components.schemas.ChatCompletionRequest.properties).sort();
    assert.deepEqual(props, [
      'max_tokens',
      'messages',
      'model',
      'stream',
      'temperature',
      'tool_choice',
      'tools',
      'top_p',
    ]);
  });
});

describe('POST /chat/completions', () => {
  const P = '/chat/completions';

  test('200 JSON: text, reasoning-off model, tool call, JSON, cap, inline think, after tool', async () => {
    await conform('POST', P, { body: chat('hello') });
    await conform('POST', P, { body: chat('hello', { model: 'llama-3.3-70b-instruct-abliterated' }) });
    const { body } = await conform('POST', P, { body: chat('weather?', { tools, tool_choice: 'auto' }) });
    await conform('POST', P, { body: chat('reply in JSON') });
    await conform('POST', P, { body: chat('[mock:cap]') });
    await conform('POST', P, { body: chat('[mock:inline-think]') });
    const call = body.choices[0].message.tool_calls[0];
    await conform('POST', P, {
      body: {
        model: 'glm-5.3-flash',
        tools,
        messages: [
          { role: 'user', content: 'weather?' },
          body.choices[0].message,
          { role: 'tool', tool_call_id: call.id, content: '{"temp_c": 4}' },
        ],
      },
    });
  });

  test('200 stream: text, tools, queue, cap, and in-stream errors', async () => {
    for (const content of ['hello', '[mock:queue]', '[mock:cap]', '[mock:inline-think]']) {
      await conform('POST', P, { body: chat(content, { stream: true }) });
    }
    await conform('POST', P, { body: chat('weather?', { stream: true, tools }) });
    const timeout = await conform('POST', P, { body: chat('a b c [mock:timeout]', { stream: true }) });
    assert.equal(timeout.payloads.at(-1).error.type, 'upstream_timeout');
    const preempted = await conform('POST', P, { body: chat('a b c [mock:preempted]', { stream: true }) });
    assert.equal(preempted.payloads.at(-1).error.type, 'preempted');
  });

  test('401, 402, 403', async () => {
    await conform('POST', P, { token: null, body: chat('x') });
    await conform('POST', P, { token: 'mock-no-plan', body: chat('x') });
    await conform('POST', P, { token: 'mock-unverified', body: chat('x') });
  });

  test('413 and 422', async () => {
    await conform('POST', P, { body: chat('[mock:context]') });
    await conform('POST', P, { body: { model: 'unknown-model', messages: [] } });
    await conform('POST', P, { body: chat('x', { temperature: 3, top_p: 2, max_tokens: 0 }) });
    await conform('POST', P, { body: { model: 'glm-5.3-flash', messages: [{ role: 'robot' }] } });
  });

  test('429: rate limit, quota, session quota', async () => {
    await conform('POST', P, { body: chat('[mock:rate-limit]') });
    await conform('POST', P, { body: chat('[mock:quota]') });
    await conform('POST', P, { body: chat('[mock:session-quota]') });
  });

  test('502, 503, 504, 524', async () => {
    await conform('POST', P, { body: chat(`${Date.now()} [mock:flaky=1]`) });
    await conform('POST', P, { body: chat('[mock:upstream-error]') });
    await conform('POST', P, { body: chat('[mock:preempted]') });
    await conform('POST', P, { body: chat('[mock:busy]') });
    await conform('POST', P, { body: chat('[mock:unavailable]') });
    await conform('POST', P, { body: chat('x', { model: 'qwen3.8-27b-uncensored' }) });
    await conform('POST', P, { body: chat('[mock:timeout]') });
    await conform('POST', P, { body: chat('[mock:cloudflare-524]') });
  });
});

describe('GET /models', () => {
  test('200, 401, 402, 403, 429', async () => {
    await conform('GET', '/models');
    await conform('GET', '/models', { token: null });
    await conform('GET', '/models', { token: 'mock-no-plan' });
    await conform('GET', '/models', { token: 'mock-unverified' });
    await conform('GET', '/models', { base: tight.baseUrl, token: 'limited' });
    const { status } = await conform('GET', '/models', { base: tight.baseUrl, token: 'limited' });
    assert.equal(status, 429);
  });
});

describe('GET /auth/me', () => {
  const url = () => `${mock.origin}/api/auth/me`;

  test('200 for a normal, a plan-less and an unverified account; 401 without a key', async () => {
    const { body } = await conform('GET', '/auth/me', { url: url() });
    assert.equal(body.api_base, mock.baseUrl);
    await conform('GET', '/auth/me', { url: url(), token: 'mock-no-plan' });
    await conform('GET', '/auth/me', { url: url(), token: 'mock-unverified' });
    await conform('GET', '/auth/me', { url: url(), token: null });
  });
});

describe('coverage', () => {
  test('every documented status was exercised', () => {
    const missing = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'servers') continue;
        for (const status of Object.keys(op.responses)) {
          if (status === 'default') continue;
          const key = `${method.toUpperCase()} ${path} ${status}`;
          if (!exercised.has(key)) missing.push(key);
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
