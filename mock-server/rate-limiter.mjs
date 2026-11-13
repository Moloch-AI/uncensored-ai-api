// Per-token sliding-window rate limiter.
//
// The gateway allows 60 requests per minute per account and reports the
// budget in X-RateLimit-Limit / X-RateLimit-Remaining. Over the limit it
// answers 429 {"message":"Too Many Attempts."} with Retry-After, the number of
// seconds until a slot frees up. Rejected requests do not use up a slot.

export const WINDOW_MS = 60_000;

export class SlidingWindowRateLimiter {
  /**
   * @param {number} limit requests per window; 0 disables the limiter
   * @param {() => number} now clock in milliseconds (injectable for tests)
   */
  constructor(limit, now = Date.now) {
    this.limit = limit;
    this.now = now;
    /** @type {Map<string, number[]>} token -> request timestamps, oldest first */
    this.hits = new Map();
  }

  /**
   * Record a request for `key` if there is room.
   * @returns {{allowed: boolean, limit: number, remaining: number, retryAfter: number}}
   */
  take(key) {
    if (this.limit <= 0) {
      return { allowed: true, limit: 0, remaining: 0, retryAfter: 0 };
    }
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - WINDOW_MS);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      // The oldest request in the window leaves it at recent[0] + WINDOW_MS.
      const retryAfter = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
      return { allowed: false, limit: this.limit, remaining: 0, retryAfter };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - recent.length,
      retryAfter: 0,
    };
  }
}
