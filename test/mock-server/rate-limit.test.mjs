// The per-token sliding-window rate limiter and its headers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlidingWindowRateLimiter, WINDOW_MS } from '../../mock-server/rate-limiter.mjs';
import { authHeaders, postChat, startMock, userChat } from './helpers.mjs';

describe('SlidingWindowRateLimiter', () => {
  test('counts down, then refuses with the seconds until a slot frees', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowRateLimiter(3, () => now);
    assert.deepEqual(limiter.take('a'), { allowed: true, limit: 3, remaining: 2, retryAfter: 0 });
    now += 10_000;
    assert.equal(limiter.take('a').remaining, 1);
    now += 10_000;
    assert.equal(limiter.take('a').remaining, 0);
    now += 5_000;
    // The first request (25 s ago) leaves the window in 35 s.
    assert.deepEqual(limiter.take('a'), { allowed: false, limit: 3, remaining: 0, retryAfter: 35 });
  });

  test('the window slides: old requests free their slots', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(2, () => now);
    limiter.take('a');
    now = 30_000;
    limiter.take('a');
    assert.equal(limiter.take('a').allowed, false);
    now = WINDOW_MS + 1; // the first request has left the window
    const next = limiter.take('a');
    assert.equal(next.allowed, true);
    assert.equal(next.remaining, 0);
  });

  test('rejected requests do not use a slot', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1, () => now);
    limiter.take('a');
    for (let i = 0; i < 5; i++) limiter.take('a');
    now = WINDOW_MS + 1;
    assert.equal(limiter.take('a').allowed, true);
  });

  test('Retry-After is at least 1', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1, () => now);
    limiter.take('a');
    now = WINDOW_MS - 1;
    assert.equal(limiter.take('a').retryAfter, 1);
  });

  test('tokens are counted separately', () => {
    const limiter = new SlidingWindowRateLimiter(1, () => 0);
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('b').allowed, true);
    assert.equal(limiter.take('a').allowed, false);
  });

  test('a limit of 0 disables it', () => {
    const limiter = new SlidingWindowRateLimiter(0, () => 0);
    for (let i = 0; i < 100; i++) assert.equal(limiter.take('a').allowed, true);
  });
});

describe('rate limiting over HTTP', () => {
  test('headers count down and the request over the limit is 429 with Retry-After', async () => {
    const mock = await startMock({ rateLimit: 3 });
    try {
      const remaining = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders('rl') });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-ratelimit-limit'), '3');
        remaining.push(res.headers.get('x-ratelimit-remaining'));
        await res.arrayBuffer();
      }
      assert.deepEqual(remaining, ['2', '1', '0']);

      const over = await postChat(mock.baseUrl, userChat('one more'), { token: 'rl' });
      assert.equal(over.status, 429);
      assert.deepEqual(await over.json(), { message: 'Too Many Attempts.' });
      const retryAfter = Number(over.headers.get('retry-after'));
      assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
      assert.equal(over.headers.get('x-ratelimit-limit'), '3');
      assert.equal(over.headers.get('x-ratelimit-remaining'), '0');

      // Another token has its own window; /auth/me is not rate limited.
      assert.equal((await fetch(`${mock.baseUrl}/models`, { headers: authHeaders('other') })).status, 200);
      assert.equal((await fetch(`${mock.origin}/api/auth/me`, { headers: authHeaders('rl') })).status, 200);
    } finally {
      await mock.close();
    }
  });

  test('with --rate-limit 0 there are no rate-limit headers', async () => {
    const mock = await startMock({ rateLimit: 0 });
    try {
      const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-ratelimit-limit'), null);
    } finally {
      await mock.close();
    }
  });
});
