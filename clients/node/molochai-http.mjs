// MolochAI reference HTTP client: one file, Node.js >= 20, native fetch, no
// dependencies.
//
// Copy this file into your project when you want to call the MolochAI API
// without installing an SDK. It shows everything a client has to get right on
// the wire:
//
//   - bearer auth and the base URL (MOLOCHAI_API_KEY, MOLOCHAI_BASE_URL);
//   - timeouts: a deadline for the response to start and an idle limit while
//     reading the body;
//   - the three error-body shapes, mapped to one MolochAIError with status,
//     type, body, retryAfterMs and resetsAt;
//   - retries: exponential backoff with full jitter for 502, 503 server_busy,
//     504, 524, other 5xx and connection errors; Retry-After (capped) for the
//     rate-limit 429; no retry for quota 429s, model_unavailable, 401, 402,
//     403, 413 or 422;
//   - a server-sent events parser that ignores comment lines but reports
//     queue progress (": queued · position 2 of 3 · waiting 4s") through a
//     callback;
//   - in-stream error events (HTTP 200, then data: {"error": ...}) thrown as
//     errors, and the usage chunk whose `choices` is empty;
//   - /auth/me, which lives outside /v1.
//
// It is a reference, not a package: responses are plain objects in the wire
// format. For a typed SDK, see https://github.com/Moloch-AI/uncensored-ai-node.
//
//   import { MolochAI } from './molochai-http.mjs';
//   const client = new MolochAI(); // reads MOLOCHAI_API_KEY and MOLOCHAI_BASE_URL
//   const reply = await client.chat('glm-5.3-flash', [{ role: 'user', content: 'Hi' }]);
//   console.log(reply.choices[0].message.content);
//
// License: MIT. Source: https://github.com/Moloch-AI/uncensored-ai-api

export const DEFAULT_BASE_URL = 'https://api.molochai.dev/api/v1';

/** Appended to the content when a reply stops at the plan's output cap. */
export const CAP_NOTICE = '\n\n[Response is too large for your current plan. Try a smaller request.]';

const USER_AGENT = 'molochai-http-reference-node/0.1';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Any failed request: an HTTP error, a connection problem, or an error event
 * inside a stream.
 *
 * - `status`: HTTP status; null when no response arrived; 200 for an error
 *   event inside a stream.
 * - `type`: what went wrong, for branching. The gateway's `error.type` when
 *   the body has one (`quota_exceeded`, `server_busy`, ...); `code` for the
 *   403 (`email_unverified`); otherwise a label this client assigns:
 *   `unauthenticated` (401), `validation_error` (422), `rate_limited` (429
 *   "Too Many Attempts."), `cloudflare_timeout` (524), `http_error` (anything
 *   else), `connection_error`, `timeout`, `incomplete_stream`,
 *   `invalid_response`.
 * - `message`: for people; it can change, so do not branch on it.
 * - `body`: parsed JSON, the raw text when it was not JSON, or null.
 * - `headers`: response headers (lower-case names).
 * - `retryAfterMs`: from the Retry-After header, if present.
 * - `resetsAt`: a Date, when a quota error clears (`error.resets_at`).
 * - `inStream`: true when the error arrived as an event in an open stream.
 */
export class MolochAIError extends Error {
  constructor(
    message,
    {
      status = null,
      type = 'http_error',
      body = null,
      headers = {},
      retryAfterMs = null,
      resetsAt = null,
      inStream = false,
      cause,
    } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MolochAIError';
    this.status = status;
    this.type = type;
    this.body = body;
    this.headers = headers;
    this.retryAfterMs = retryAfterMs;
    this.resetsAt = resetsAt;
    this.inStream = inStream;
  }

  /** The gateway's request_id on upstream errors, for support requests. */
  get requestId() {
    const id = this.body?.error?.request_id;
    return typeof id === 'string' ? id : null;
  }

  toString() {
    const where = this.status === null ? 'no response' : `HTTP ${this.status}`;
    return `${where} ${this.type}: ${this.message}`;
  }
}

/** Retry-After is seconds (what the gateway sends) or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function headersToObject(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
  } else {
    for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  }
  return out;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Map an HTTP error response to a MolochAIError.
 *
 * Always check the status first, then the body shape. Bodies come in three
 * shapes, and some are not JSON at all (Cloudflare's 524 page is HTML):
 *
 *   A  {"error": {"type": "...", "message": "...", ...}}   gateway errors
 *   B  {"message": "...", "errors": {"field": ["..."]}}     422 validation
 *   C  {"message": "..."} (+ "code" on the 403)             401, 403, 429 rate limit
 *
 * @param {number} status
 * @param {Headers | Record<string, string>} headers
 * @param {string} text the raw body
 */
export function errorFromResponse(status, headers, text) {
  const lower = headersToObject(headers);
  const retryAfterMs = parseRetryAfter(lower['retry-after']);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON. Never assume JSON.
  }

  const make = (type, message, resetsAt = null) =>
    new MolochAIError(message, {
      status,
      type,
      body: body ?? text,
      headers: lower,
      retryAfterMs,
      resetsAt,
    });

  if (isObject(body) && isObject(body.error)) {
    // shape A
    const { error } = body;
    return make(
      String(error.type || 'http_error'),
      String(error.message || `HTTP ${status}`),
      parseDate(error.resets_at),
    );
  }
  if (isObject(body) && isObject(body.errors)) {
    // shape B
    return make('validation_error', String(body.message || 'Invalid request.'));
  }
  if (isObject(body) && 'message' in body) {
    // shape C
    const type =
      typeof body.code === 'string'
        ? body.code
        : ({ 401: 'unauthenticated', 429: 'rate_limited' }[status] ?? 'http_error');
    return make(type, String(body.message));
  }
  return make(status === 524 ? 'cloudflare_timeout' : 'http_error', `HTTP ${status} with a non-JSON body`);
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * How to retry `error`: 'backoff', 'retry_after' or null.
 *
 *   connection error (no response)                  backoff
 *   timeout                                         null, unless retryOnTimeout
 *   429 rate_limited ("Too Many Attempts.")         retry_after
 *   429 quota_exceeded / session_quota_exceeded     null: surface resetsAt
 *   401, 402, 403, 413, 422                         null: fix the cause
 *   503 model_unavailable                           null: pick another model
 *   502, 503 server_busy, 504, 524, other 5xx       backoff
 *   error event inside an open stream               null: content was already sent
 *   anything else                                   null
 *
 * A timeout is not retried by default: the server may still be generating
 * (and counting tokens for) the first attempt.
 */
export function retryDecision(error, { retryOnTimeout = false } = {}) {
  if (error.inStream) return null;
  if (error.status === null) {
    if (error.type === 'timeout') return retryOnTimeout ? 'backoff' : null;
    return error.type === 'connection_error' ? 'backoff' : null;
  }
  if (error.status === 429) return error.type === 'rate_limited' ? 'retry_after' : null;
  if (error.status === 503 && error.type === 'model_unavailable') return null;
  if (error.status >= 500) return 'backoff';
  return null;
}

/**
 * Exponential backoff with full jitter: uniform in [0, min(capMs, baseMs * 2^attempt)).
 * `attempt` counts from 0 for the first retry.
 */
export function backoffDelay(attempt, { baseMs = 500, capMs = 8000, random = Math.random } = {}) {
  return random() * Math.min(capMs, baseMs * 2 ** attempt);
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

const QUEUE_RE = /queued\s*·\s*position\s+(\d+)\s+of\s+(\d+)\s*·\s*waiting\s+(\d+)s/;

/**
 * Parse ": queued · position 2 of 3 · waiting 4s" (without the colon) into
 * {position, total, waitedS}. Optional progress info: the format is not a
 * contract, so anything that does not parse returns null.
 */
export function parseQueueComment(text) {
  const m = QUEUE_RE.exec(text);
  return m ? { position: Number(m[1]), total: Number(m[2]), waitedS: Number(m[3]) } : null;
}

/**
 * Incremental parser for text/event-stream, fed one line at a time.
 *
 * - an event is a block of lines ended by a blank line;
 * - `data:` lines carry the payload (several are joined with "\n"); one
 *   space after the colon is dropped;
 * - lines starting with ":" are comments, never part of the payload;
 * - other fields (event:, id:, retry:) are not used by this API.
 *
 * `feed` returns the payload of a finished event, or null.
 */
export class SSEParser {
  constructor({ onComment } = {}) {
    this.data = [];
    this.onComment = onComment;
  }

  feed(rawLine) {
    const line = rawLine.replace(/\r?\n$/, '').replace(/\r$/, '');
    if (line === '') {
      if (this.data.length === 0) return null;
      const payload = this.data.join('\n');
      this.data = [];
      return payload;
    }
    if (line.startsWith(':')) {
      this.onComment?.(line.slice(1).trim());
      return null;
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') this.data.push(value);
    return null;
  }

  /** Payload of a final event that was not followed by a blank line. */
  flush() {
    return this.data.length > 0 ? this.feed('') : null;
  }
}

/**
 * Fold chat.completion.chunk objects into one result:
 * {content, reasoning, toolCalls, finishReason, usage, hitOutputCap}.
 *
 * Tool-call arguments arrive whole on this gateway, but other providers send
 * fragments, so they are joined by `index` here.
 *
 * @param {AsyncIterable<object> | Iterable<object>} chunks
 */
export async function collectStream(chunks, { onChunk } = {}) {
  const result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
  const calls = new Map();
  for await (const chunk of chunks) {
    onChunk?.(chunk);
    if (chunk.usage) result.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      // `choices` is empty in the usage chunk
      const delta = choice.delta ?? {};
      result.content += delta.content ?? '';
      result.reasoning += delta.reasoning_content ?? '';
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        if (!calls.has(index)) calls.set(index, { id: null, type: 'function', function: { name: '', arguments: '' } });
        const call = calls.get(index);
        if (fragment.id) call.id = fragment.id;
        call.function.name += fragment.function?.name ?? '';
        call.function.arguments += fragment.function?.arguments ?? '';
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
  }
  result.toolCalls = [...calls.keys()].sort((a, b) => a - b).map((i) => calls.get(i));
  result.hitOutputCap = result.finishReason === 'length' || result.content.endsWith(CAP_NOTICE);
  return result;
}

/**
 * /auth/me lives outside /v1: replace the trailing /v1.
 * meUrl('https://api.molochai.dev/api/v1') === 'https://api.molochai.dev/api/auth/me'
 */
export function meUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base.endsWith('/v1')) throw new Error(`cannot derive /auth/me: base URL does not end in /v1: ${baseUrl}`);
  return `${base.slice(0, -'/v1'.length)}/auth/me`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Small client for the three public endpoints.
 *
 * Options:
 * - apiKey: defaults to MOLOCHAI_API_KEY. Keep keys on a server; they are not
 *   scoped and must never ship to a browser or mobile app.
 * - baseUrl: defaults to MOLOCHAI_BASE_URL, then the production URL.
 * - connectTimeoutMs (10 s): how long a streamed request may take to start
 *   (status and headers). The gateway opens a stream right away, so this
 *   covers connecting and routing.
 * - readTimeoutMs (120 s): how long a plain request may take to start (the
 *   gateway answers only when the whole reply is generated), and the longest
 *   gap between body chunks while reading (keep-alive comments arrive about
 *   once a second during a stream).
 *   fetch does not expose the TCP connect step on its own; Node's fetch gives
 *   up connecting after 10 s by itself.
 * - maxRetries (3): retries after the first attempt (0 disables retrying).
 * - backoffBaseMs (500), backoffMaxMs (8000): see backoffDelay.
 * - maxRetryAfterMs (60 s): longest Retry-After wait honored on a 429; a
 *   longer value is cut to this.
 * - retryOnTimeout (false): also retry timeouts.
 * - sleep, random, fetch: injectable for tests.
 * - onRetry(error, attempt, delayMs): called before each wait.
 *
 * If you also use another HTTP layer that retries (the OpenAI SDKs do),
 * disable one of them so the retries do not multiply.
 */
export class MolochAI {
  #apiKey;
  #sleep;
  #random;
  #fetch;
  #onRetry;

  constructor({
    apiKey = process.env.MOLOCHAI_API_KEY,
    baseUrl = process.env.MOLOCHAI_BASE_URL || DEFAULT_BASE_URL,
    connectTimeoutMs = 10_000,
    readTimeoutMs = 120_000,
    maxRetries = 3,
    backoffBaseMs = 500,
    backoffMaxMs = 8000,
    maxRetryAfterMs = 60_000,
    retryOnTimeout = false,
    sleep = defaultSleep,
    random = Math.random,
    fetch = globalThis.fetch,
    onRetry,
  } = {}) {
    if (!apiKey) throw new Error('No API key: pass apiKey or set MOLOCHAI_API_KEY.');
    this.#apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.connectTimeoutMs = connectTimeoutMs;
    this.readTimeoutMs = readTimeoutMs;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.maxRetryAfterMs = maxRetryAfterMs;
    this.retryOnTimeout = retryOnTimeout;
    this.#sleep = sleep;
    this.#random = random;
    this.#fetch = fetch;
    this.#onRetry = onRetry;
  }

  // The key is a private field, so it never shows up in console.log(client).

  /**
   * POST /chat/completions without streaming; resolves to the chat.completion object.
   *
   * `params` may hold temperature (0-2), top_p (0-1), tools, tool_choice and
   * max_tokens (accepted, but it has no effect: the plan's output cap
   * applies), plus `signal` to cancel. Other OpenAI parameters such as stop,
   * seed or response_format are silently dropped by the gateway; there is no
   * JSON mode.
   *
   * Prefer chatStream for long replies: Cloudflare gives up on a plain
   * response after about 100 seconds (524).
   */
  async chat(model, messages, { signal, ...params } = {}) {
    const payload = { model, messages, ...params, stream: false };
    const sent = await this.#request('POST', `${this.baseUrl}/chat/completions`, payload, { stream: false, signal });
    return this.#readJson(sent);
  }

  /**
   * POST /chat/completions with stream: true; an async generator of
   * chat.completion.chunk objects, including the final usage chunk (whose
   * `choices` is empty). Use collectStream to put them together.
   *
   * Retries happen only before the stream opens. An error event inside the
   * stream throws a MolochAIError with inStream = true.
   *
   * Extra options: onQueue({position, total, waitedS}) while the request
   * waits for a slot; onComment(text) for every comment line; signal.
   */
  async *chatStream(model, messages, { onQueue, onComment, signal, ...params } = {}) {
    const payload = { model, messages, ...params, stream: true };
    const sent = await this.#request('POST', `${this.baseUrl}/chat/completions`, payload, { stream: true, signal });
    const { res } = sent;
    const parser = new SSEParser({
      onComment: (text) => {
        onComment?.(text);
        const progress = parseQueueComment(text);
        if (progress) onQueue?.(progress);
      },
    });
    const meta = { status: res.status, headers: headersToObject(res.headers) };

    for await (const line of this.#lines(sent)) {
      const data = parser.feed(line);
      if (data === null) continue;
      if (data === '[DONE]') return;
      let event;
      try {
        event = JSON.parse(data);
      } catch (cause) {
        throw new MolochAIError('A stream event was not JSON.', {
          ...meta,
          type: 'invalid_response',
          body: data,
          inStream: true,
          cause,
        });
      }
      if (isObject(event?.error)) {
        throw new MolochAIError(String(event.error.message || 'Error in stream.'), {
          ...meta,
          type: String(event.error.type || 'stream_error'),
          body: event,
          inStream: true,
        });
      }
      yield event;
    }
    throw new MolochAIError('The stream ended without [DONE]; the connection was cut.', {
      ...meta,
      type: 'incomplete_stream',
      inStream: true,
    });
  }

  /** GET /models. `available: false` means nothing serves that id right now. */
  async models({ signal } = {}) {
    const sent = await this.#request('GET', `${this.baseUrl}/models`, undefined, { stream: false, signal });
    const body = await this.#readJson(sent);
    return Array.isArray(body.data) ? body.data : [];
  }

  /** GET /api/auth/me: plan, tier, credit, email_verified and per-model context_limit. */
  async me({ signal } = {}) {
    const sent = await this.#request('GET', meUrl(this.baseUrl), undefined, { stream: false, signal });
    return this.#readJson(sent);
  }

  // ------------------------------------------------------------- internals

  /**
   * Send with retries. Resolves to {res, ctx}: an ok Response with its body
   * unread, and what the body readers need to enforce the idle timeout.
   */
  async #request(method, url, payload, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#sendOnce(method, url, payload, options);
      } catch (error) {
        if (!(error instanceof MolochAIError)) throw error; // e.g. the caller aborted
        const delay = this.#retryDelay(error, attempt);
        if (delay === null) throw error;
        this.#onRetry?.(error, attempt + 1, delay);
        await this.#sleep(delay);
      }
    }
  }

  #retryDelay(error, attempt) {
    if (attempt >= this.maxRetries) return null;
    const decision = retryDecision(error, { retryOnTimeout: this.retryOnTimeout });
    if (decision === 'retry_after' && error.retryAfterMs !== null) {
      return Math.min(error.retryAfterMs, this.maxRetryAfterMs);
    }
    if (decision !== null) {
      return backoffDelay(attempt, { baseMs: this.backoffBaseMs, capMs: this.backoffMaxMs, random: this.#random });
    }
    return null;
  }

  async #sendOnce(method, url, payload, { stream, signal }) {
    const headers = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    // One controller per attempt: our timers and the caller's signal both abort it.
    const controller = new AbortController();
    const state = { timedOut: false };
    const abortFromCaller = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);

    const startMs = stream ? this.connectTimeoutMs : this.readTimeoutMs;
    const startTimer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, startMs);

    let res;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      signal?.removeEventListener('abort', abortFromCaller);
      if (signal?.aborted) throw signal.reason ?? cause;
      if (state.timedOut) {
        // A stream that does not start in time is treated like a connect
        // failure (retried); a plain request that does not answer in time may
        // still be running on the server (not retried by default).
        throw new MolochAIError(`No response within ${startMs} ms.`, {
          type: stream ? 'connection_error' : 'timeout',
          cause,
        });
      }
      throw new MolochAIError(`Connection failed: ${cause?.cause?.code ?? cause?.message ?? cause}`, {
        type: 'connection_error',
        cause,
      });
    } finally {
      clearTimeout(startTimer);
    }

    const sent = { res, ctx: { controller, state, signal, abortFromCaller, stream } };
    if (!res.ok) {
      const text = await this.#readText(sent).catch(() => '');
      throw errorFromResponse(res.status, res.headers, text);
    }
    return sent;
  }

  /** Read the body as decoded text pieces, aborting after readTimeoutMs of silence. */
  async *#chunks({ res, ctx }) {
    const { controller, state, signal, abortFromCaller, stream } = ctx;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let idle;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, this.readTimeoutMs);
    };
    try {
      for (;;) {
        arm();
        let result;
        try {
          result = await reader.read();
        } catch (cause) {
          if (signal?.aborted) throw signal.reason ?? cause;
          if (state.timedOut) {
            throw new MolochAIError(`No data for ${this.readTimeoutMs} ms.`, {
              status: res.status,
              type: 'timeout',
              inStream: stream && res.ok,
              cause,
            });
          }
          throw new MolochAIError(`Connection lost while reading: ${cause?.message ?? cause}`, {
            status: res.status,
            type: 'connection_error',
            inStream: stream && res.ok,
            cause,
          });
        }
        if (result.done) break;
        yield decoder.decode(result.value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', abortFromCaller);
      reader.releaseLock();
      controller.abort(); // closes the connection if we stopped early
    }
  }

  /** Split the body into lines, keeping each line's "\n". */
  async *#lines(sent) {
    let buffer = '';
    for await (const piece of this.#chunks(sent)) {
      buffer += piece;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        yield buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer) yield buffer;
  }

  async #readText(sent) {
    let text = '';
    for await (const piece of this.#chunks(sent)) text += piece;
    return text;
  }

  async #readJson(sent) {
    const { res } = sent;
    const text = await this.#readText(sent);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // handled below
    }
    if (!isObject(body)) {
      throw new MolochAIError('Expected a JSON object.', { status: res.status, type: 'invalid_response', body: text });
    }
    return body;
  }
}
