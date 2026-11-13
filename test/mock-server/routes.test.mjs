// Routes, auth, the model list and the account endpoint.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MODELS } from '../../mock-server/catalog.mjs';
import { authHeaders, postChat, startMock, userChat } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({ unavailable: ['gemma4-26b-a4b-qat'] });
});
after(() => mock.close());

describe('routing', () => {
  test('GET /health needs no auth', async () => {
    const res = await fetch(`${mock.origin}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  });

  test('unknown paths are 404 with a bare message', async () => {
    for (const path of ['/', '/api/v1', '/api/v1/completions', '/api/v1/embeddings', '/v1/models']) {
      const res = await fetch(`${mock.origin}${path}`, { headers: authHeaders() });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { message: 'Not found.' });
    }
  });

  test('a known path with the wrong method is 404', async () => {
    const get = await fetch(`${mock.baseUrl}/chat/completions`, { headers: authHeaders() });
    assert.equal(get.status, 404);
    const post = await fetch(`${mock.baseUrl}/models`, { method: 'POST', headers: authHeaders() });
    assert.equal(post.status, 404);
  });

  test('a trailing slash and a query string are tolerated', async () => {
    const res = await fetch(`${mock.baseUrl}/models/?x=1`, { headers: authHeaders() });
    assert.equal(res.status, 200);
  });

  test('requests are logged as one line each', async () => {
    await fetch(`${mock.origin}/health`);
    await postChat(mock.baseUrl, userChat('log me', { stream: true })).then((r) => r.text());
    // The close event fires after the response is flushed.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(mock.logs.includes('GET /health 200'));
    assert.ok(mock.logs.includes('POST /api/v1/chat/completions 200 glm-5.3-flash stream'));
  });
});

describe('auth', () => {
  const protectedRoutes = [
    ['GET', '/api/v1/models'],
    ['POST', '/api/v1/chat/completions'],
    ['GET', '/api/auth/me'],
  ];

  for (const [method, path] of protectedRoutes) {
    test(`${method} ${path}: missing, empty or non-bearer credentials are 401`, async () => {
      for (const authorization of [undefined, '', 'Bearer', 'Bearer   ', 'Basic bW9jazprZXk=', 'mock-key']) {
        const headers = authorization === undefined ? {} : { Authorization: authorization };
        const res = await fetch(`${mock.origin}${path}`, { method, headers });
        assert.equal(res.status, 401, `Authorization: ${authorization}`);
        assert.deepEqual(await res.json(), { message: 'Unauthenticated.' });
        assert.equal(res.headers.get('x-ratelimit-limit'), null);
      }
    });
  }

  test('any other non-empty token is accepted', async () => {
    for (const token of ['mock-key', 'sk-anything', 'x']) {
      const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders(token) });
      assert.equal(res.status, 200, token);
    }
  });

  test('the bearer scheme is case-insensitive', async () => {
    const res = await fetch(`${mock.baseUrl}/models`, { headers: { Authorization: 'bearer mock-key' } });
    assert.equal(res.status, 200);
  });

  test('mock-no-plan gets 402 no_active_plan on /v1 routes, with rate-limit headers', async () => {
    const models = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders('mock-no-plan') });
    assert.equal(models.status, 402);
    const body = await models.json();
    assert.equal(body.error.type, 'no_active_plan');
    assert.equal(typeof body.error.message, 'string');
    assert.ok('plan' in body.error);
    assert.equal(models.headers.get('x-ratelimit-limit'), '60');
    assert.equal(models.headers.get('x-should-retry'), 'false');

    const chat = await postChat(mock.baseUrl, userChat('hi'), { token: 'mock-no-plan' });
    assert.equal(chat.status, 402);
    assert.equal((await chat.json()).error.type, 'no_active_plan');
  });

  test('mock-unverified gets 403 email_unverified on /v1 routes, before the rate limiter', async () => {
    const models = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders('mock-unverified') });
    assert.equal(models.status, 403);
    const body = await models.json();
    assert.equal(body.code, 'email_unverified');
    assert.equal(typeof body.message, 'string');
    assert.equal(body.error, undefined);
    assert.equal(models.headers.get('x-ratelimit-limit'), null);

    const chat = await postChat(mock.baseUrl, userChat('hi'), { token: 'mock-unverified' });
    assert.equal(chat.status, 403);
  });
});

describe('GET /api/v1/models', () => {
  test('lists the five ids with names and availability', async () => {
    const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((m) => m.id),
      MODELS.map((m) => m.id),
    );
    for (const m of body.data) {
      assert.equal(m.object, 'model');
      assert.equal(m.created, 0);
      assert.equal(m.owned_by, 'molochai');
      assert.equal(typeof m.name, 'string');
      assert.equal(m.available, m.id !== 'gemma4-26b-a4b-qat');
    }
    assert.equal(
      body.data.find((m) => m.id === 'llama-3.3-70b-instruct-abliterated').name,
      'Llama-3.3-70B-Instruct-abliterated-GGUF',
    );
  });

  test('carries the rate-limit headers', async () => {
    const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders('headers-token') });
    assert.equal(res.headers.get('x-ratelimit-limit'), '60');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '59');
  });
});

describe('GET /api/auth/me', () => {
  test('returns the account, outside /v1', async () => {
    const res = await fetch(`${mock.origin}/api/auth/me`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.id, 1);
    assert.equal(me.email, 'dev@example.com');
    assert.equal(me.plan, 'pro');
    assert.equal(me.tier, 'pro');
    assert.equal(me.credit_usd, 0);
    assert.equal(me.email_verified, true);
    assert.equal(me.api_base, mock.baseUrl);
    assert.equal(me.default_model, 'glm-5.3-flash');
    assert.equal(me.context_limit, 65536);

    const expires = Date.parse(me.plan_expires_at);
    const days = (expires - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `plan_expires_at ${me.plan_expires_at}`);

    assert.equal(me.models.length, 5);
    const gemma = me.models.find((m) => m.id === 'gemma4-26b-a4b-qat');
    assert.deepEqual(gemma, {
      id: 'gemma4-26b-a4b-qat',
      name: 'Gemma4-26B-A4B-QAT',
      available: false,
      context_limit: null,
    });
    const glm = me.models.find((m) => m.id === 'glm-5.3-flash');
    assert.equal(glm.context_limit, 65536);
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  });

  test('is not behind the email or plan checks', async () => {
    const unverified = await fetch(`${mock.origin}/api/auth/me`, { headers: authHeaders('mock-unverified') });
    assert.equal(unverified.status, 200);
    assert.equal((await unverified.json()).email_verified, false);

    const noPlan = await fetch(`${mock.origin}/api/auth/me`, { headers: authHeaders('mock-no-plan') });
    assert.equal(noPlan.status, 200);
    const body = await noPlan.json();
    assert.equal(body.plan, null);
    assert.equal(body.plan_expires_at, null);
    assert.equal(body.tier, null);
  });

  test('default_model skips unavailable models', async () => {
    const other = await startMock({ unavailable: 'glm-5.3-flash,glm-4.7-flash-uncensored' });
    try {
      const me = await (await fetch(`${other.origin}/api/auth/me`, { headers: authHeaders() })).json();
      assert.equal(me.default_model, 'gemma4-26b-a4b-qat');
    } finally {
      await other.close();
    }
  });
});
