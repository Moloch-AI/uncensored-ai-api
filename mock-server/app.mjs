// The MolochAI mock API: routing, auth, rate limiting and the small routes.
//
// This is a test double for offline development and CI. It reproduces the
// gateway's documented behavior (status codes, error shapes, headers, the SSE
// format) with canned replies. It does not run a model.
//
// Request pipeline, in the gateway's order:
//
//   GET /health                      200 {"ok":true}, no auth
//   unknown route                    404 {"message":"Not found."}
//   bearer token missing or empty    401 {"message":"Unauthenticated."}
//   /api/auth/me                     200 account (no rate limit, no plan check)
//   /api/v1/* with "mock-unverified" 403 {"message", "code":"email_unverified"}
//   /api/v1/* over the rate limit    429 {"message":"Too Many Attempts."} + Retry-After
//   /api/v1/* with "mock-no-plan"    402 no_active_plan
//   GET  /api/v1/models              200 model list
//   POST /api/v1/chat/completions    see chat.mjs
//
// Every /api/v1 response after the rate limiter carries X-RateLimit-Limit and
// X-RateLimit-Remaining.

import http from 'node:http';
import { MOCK_CONTEXT_LIMIT, MODELS, modelList } from './catalog.mjs';
import { handleChatCompletions } from './chat.mjs';
import { EMAIL_UNVERIFIED, NO_ACTIVE_PLAN, NOT_FOUND, TOO_MANY_ATTEMPTS, UNAUTHENTICATED } from './errors.mjs';
import { SlidingWindowRateLimiter } from './rate-limiter.mjs';

export { MODELS } from './catalog.mjs';
export { CAP_NOTICE } from './chat.mjs';

export const DEFAULTS = Object.freeze({
  port: 4010,
  host: '127.0.0.1',
  delayMs: 15,
  rateLimit: 60,
  unavailable: [],
  quiet: false,
});

/** Special bearer tokens. Any other non-empty token is accepted. */
export const TOKENS = Object.freeze({
  noPlan: 'mock-no-plan',
  unverified: 'mock-unverified',
});

const ROUTES = {
  'GET /health': { auth: false, handler: health },
  'GET /api/auth/me': { auth: true, v1: false, handler: me },
  'GET /api/v1/models': { auth: true, v1: true, handler: models },
  'POST /api/v1/chat/completions': { auth: true, v1: true, handler: handleChatCompletions },
};

/**
 * Create the request handler without binding a port.
 * @param {Partial<typeof DEFAULTS> & {now?: () => number, log?: (line: string) => void}} options
 */
export function createMockApp(options = {}) {
  const config = normalizeConfig(options);
  const state = {
    completionSeq: 0,
    toolCallSeq: 0,
    requestSeq: 0,
    /** @type {Map<string, number>} body hash -> requests seen, for [mock:flaky=N] */
    flaky: new Map(),
    limiter: new SlidingWindowRateLimiter(config.rateLimit, options.now),
  };
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  async function handle(req, res) {
    const ctx = createContext(req, res, config, state);

    res.on('close', () => {
      if (config.quiet) return;
      const status = res.headersSent ? res.statusCode : 'aborted';
      const extra = [ctx.log.model, ctx.log.stream ? 'stream' : ''].filter(Boolean).join(' ');
      log(`${req.method} ${ctx.path} ${status}${extra ? ` ${extra}` : ''}`);
    });

    try {
      ctx.rawBody = await readBody(req);
      await route(ctx);
    } catch (err) {
      log(`mock error: ${err?.stack ?? err}`);
      if (!res.headersSent) ctx.json(500, { message: 'Server Error' });
      else res.end();
    }
  }

  return { handle, config, state };
}

async function route(ctx) {
  const { req } = ctx;
  const entry = ROUTES[`${req.method} ${ctx.path}`];
  if (!entry) return ctx.json(404, NOT_FOUND);
  if (!entry.auth) return entry.handler(ctx);

  const token = bearerToken(req.headers.authorization);
  if (!token) return ctx.json(401, UNAUTHENTICATED);
  ctx.token = token;

  if (entry.v1) {
    if (token === TOKENS.unverified) return ctx.json(403, EMAIL_UNVERIFIED);

    const rate = ctx.state.limiter.take(token);
    if (rate.limit > 0) {
      ctx.rateHeaders = {
        'X-RateLimit-Limit': String(rate.limit),
        'X-RateLimit-Remaining': String(rate.remaining),
      };
    }
    if (!rate.allowed) {
      return ctx.json(429, TOO_MANY_ATTEMPTS, { 'Retry-After': String(rate.retryAfter) });
    }

    if (token === TOKENS.noPlan) return ctx.json(402, NO_ACTIVE_PLAN);
  }

  return entry.handler(ctx);
}

function health(ctx) {
  ctx.json(200, { ok: true });
}

function models(ctx) {
  ctx.json(200, modelList(ctx.config.unavailable));
}

/**
 * GET /api/auth/me. It lives outside /api/v1 and is not behind the email,
 * rate-limit or plan checks, so an unverified or plan-less account can still
 * read its own state here.
 */
function me(ctx) {
  const { unavailable } = ctx.config;
  const hasPlan = ctx.token !== TOKENS.noPlan;
  const firstAvailable = MODELS.find((m) => !unavailable.has(m.id));
  ctx.json(200, {
    id: 1,
    email: 'dev@example.com',
    plan: hasPlan ? 'pro' : null,
    plan_expires_at: hasPlan ? isoDaysAhead(30) : null,
    tier: hasPlan ? 'pro' : null,
    credit_usd: 0,
    email_verified: ctx.token !== TOKENS.unverified,
    api_base: `http://${ctx.req.headers.host ?? `${ctx.config.host}:${ctx.config.port}`}/api/v1`,
    default_model: firstAvailable?.id ?? null,
    context_limit: MOCK_CONTEXT_LIMIT,
    models: MODELS.map((m) => {
      const available = !unavailable.has(m.id);
      return {
        id: m.id,
        name: m.name,
        available,
        context_limit: available ? MOCK_CONTEXT_LIMIT : null,
      };
    }),
  });
}

function isoDaysAhead(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function bearerToken(header) {
  const match = /^Bearer\s+(.*)$/i.exec(header ?? '');
  const token = match?.[1].trim();
  return token ? token : null;
}

function createContext(req, res, config, state) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ctx = {
    req,
    res,
    config,
    state,
    path: url.pathname.replace(/\/+$/, '') || '/',
    rawBody: '',
    token: null,
    rateHeaders: {},
    log: { model: null, stream: false },
    startedAt: performance.now(),
    /** JSON response with the rate-limit headers (when set) merged in. */
    json(status, body, headers = {}) {
      if (res.destroyed) return;
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...ctx.rateHeaders,
        ...headers,
      });
      res.end(payload);
    },
    /** Raw response without gateway headers (used for the Cloudflare page). */
    raw(status, text, headers = {}) {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(text), ...headers });
      res.end(text);
    },
  };
  return ctx;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeConfig(options) {
  const unavailable =
    typeof options.unavailable === 'string'
      ? options.unavailable.split(',')
      : (options.unavailable ?? DEFAULTS.unavailable);
  return {
    port: options.port ?? DEFAULTS.port,
    host: options.host ?? DEFAULTS.host,
    delayMs: options.delayMs ?? DEFAULTS.delayMs,
    rateLimit: options.rateLimit ?? DEFAULTS.rateLimit,
    quiet: options.quiet ?? DEFAULTS.quiet,
    unavailable: new Set([...unavailable].map((id) => id.trim()).filter(Boolean)),
  };
}

/**
 * Start the mock on a port (0 picks a free one).
 * @returns {Promise<{server: http.Server, port: number, origin: string, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startMockServer(options = {}) {
  const app = createMockApp(options);
  const server = http.createServer((req, res) => {
    app.handle(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.config.port, app.config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address();
  const host = app.config.host.includes(':') ? `[${app.config.host}]` : app.config.host;
  const origin = `http://${host}:${port}`;
  return {
    server,
    port,
    origin,
    baseUrl: `${origin}/api/v1`,
    app,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
