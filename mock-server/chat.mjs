// POST /api/v1/chat/completions
//
// The order of checks follows the gateway: validation (422), then quota and
// context checks (429/413), then model availability and upstream problems
// (503/502/504/524), then the reply. Replies are canned text built from the
// request, never model output.

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { findModel } from './catalog.mjs';
import { CLOUDFLARE_524_HTML, gatewayError, NO_RETRY, TOO_MANY_ATTEMPTS, validationError } from './errors.mjs';
import { findJsonSchemaBlock, schemaInstance } from './schema-instance.mjs';
import { isPlainObject, validateChatRequest, wantsStream } from './validation.mjs';

/** Appended to the content when a reply stops at the plan's output cap. */
export const CAP_NOTICE = '\n\n[Response is too large for your current plan. Try a smaller request.]';

/** Longest `[mock:slow=MS]` wait the mock honors. */
const MAX_SLOW_MS = 600_000;
/** How long a non-streamed `[mock:queue]` request waits. */
export const QUEUE_WAIT_MS = 200;
/** Content pieces sent before an in-stream `[mock:timeout]`/`[mock:preempted]` error. */
const PIECES_BEFORE_FAILURE = 2;

/**
 * Parse `[mock:name]` and `[mock:name=N]` markers.
 * @returns {Map<string, number | true>}
 */
export function parseTriggers(text) {
  const triggers = new Map();
  for (const m of text.matchAll(/\[mock:([a-z0-9-]+)(?:=(\d+))?\]/g)) {
    triggers.set(m[1], m[2] === undefined ? true : Number(m[2]));
  }
  return triggers;
}

/** Text of a message: the string content, or the text parts of an array. */
export function messageText(message) {
  if (!isPlainObject(message)) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => isPlainObject(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Characters as code points, so the token estimate does not depend on UTF-16. */
function chars(text) {
  return text ? Array.from(text).length : 0;
}

/** Split on spaces, keeping each space on the piece before it. */
export function splitOnSpaces(text) {
  return text ? text.split(/(?<= )/) : [];
}

/**
 * Handle one chat completions request.
 * @param {object} ctx see app.mjs (res, rawBody, rateHeaders, config, state, log, startedAt)
 */
export async function handleChatCompletions(ctx) {
  const { rawBody, config, state } = ctx;

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {}; // Like the gateway: an unreadable body is an empty request.
  }

  const errors = validateChatRequest(body);
  if (errors) return ctx.json(422, validationError(errors));

  const { model, messages } = body;
  const stream = wantsStream(body);
  ctx.log.model = model;
  ctx.log.stream = stream;

  const lastUser = messages.findLast((m) => m.role === 'user');
  const lastUserText = messageText(lastUser);
  const triggers = parseTriggers(lastUserText);
  const requestId = `mock-req-${++state.requestSeq}`;

  if (triggers.has('slow')) {
    await sleep(Math.min(Number(triggers.get('slow')) || 0, MAX_SLOW_MS));
    if (ctx.res.destroyed) return; // The client gave up while we waited.
  }

  // Throttle and quota checks run before the request reaches a server.
  if (triggers.has('rate-limit')) {
    const headers = { 'Retry-After': '1' };
    if (config.rateLimit > 0) headers['X-RateLimit-Remaining'] = '0';
    return ctx.json(429, TOO_MANY_ATTEMPTS, headers);
  }
  if (triggers.has('session-quota')) {
    return ctx.json(
      429,
      gatewayError(
        'session_quota_exceeded',
        'Per-session token cap reached for your plan. Wait for the session to reset, or upgrade your plan.',
        {
          plan: 'pro',
          session_used: 500000,
          session_cap: 500000,
          resets_at: isoIn(2 * 3600_000),
        },
      ),
      NO_RETRY,
    );
  }
  if (triggers.has('quota')) {
    return ctx.json(
      429,
      gatewayError(
        'quota_exceeded',
        'Monthly token cap reached for your plan. Add account credit to keep going, or wait until the cap resets.',
        {
          plan: 'pro',
          monthly_used: 10000000,
          monthly_cap: 10000000,
          resets_at: isoIn(3600_000),
        },
      ),
      NO_RETRY,
    );
  }

  const promptTokens = Math.ceil(messages.reduce((sum, m) => sum + chars(messageText(m)), 0) / 4);

  if (triggers.has('context')) {
    return ctx.json(
      413,
      gatewayError(
        'context_length_exceeded',
        'This request is larger than your plan allows. Trim the conversation history, or upgrade your plan for a larger context window.',
        {
          plan: 'pro',
          estimated_tokens: Math.max(promptTokens, 70000),
          context_cap: 65536,
          bound_by: 'plan',
        },
      ),
      NO_RETRY,
    );
  }

  // Routing: an id with no server serving it fails; it is never rerouted.
  if (config.unavailable.has(model) || triggers.has('unavailable')) {
    const { name } = findModel(model);
    return ctx.json(
      503,
      gatewayError(
        'model_unavailable',
        `${name} is not available right now: no server is serving it. Choose another model, or retry later.`,
        { model },
      ),
    );
  }
  if (triggers.has('busy')) {
    return ctx.json(
      503,
      gatewayError('server_busy', 'All inference servers are busy right now. Please retry in a minute.'),
    );
  }
  if (triggers.has('flaky')) {
    const key = createHash('sha256').update(rawBody).digest('hex');
    const seen = (state.flaky.get(key) ?? 0) + 1;
    state.flaky.set(key, seen);
    if (seen <= Number(triggers.get('flaky'))) {
      return ctx.json(502, unreachable(requestId, ctx));
    }
  }
  if (triggers.has('upstream-error')) {
    return ctx.json(
      502,
      gatewayError('upstream_error', 'Upstream inference error.', {
        status: 500,
        body: '{"error":{"code":500,"message":"mock upstream failure"}}',
        request_id: requestId,
      }),
    );
  }
  if (triggers.has('cloudflare-524')) {
    // Cloudflare answers at the edge: HTML, and no gateway headers.
    return ctx.raw(524, CLOUDFLARE_524_HTML, { 'Content-Type': 'text/html; charset=UTF-8' });
  }
  if (!stream && triggers.has('timeout')) {
    return ctx.json(
      504,
      gatewayError(
        'upstream_timeout',
        'Upstream inference exceeded the time limit. Try a shorter prompt, or stream the reply.',
        { request_id: requestId, elapsed_s: elapsed(ctx) },
      ),
    );
  }
  if (!stream && triggers.has('preempted')) {
    return ctx.json(502, unreachable(requestId, ctx));
  }

  const reply = buildReply(body, model, state);

  if (stream) return streamReply(ctx, { body, model, reply, triggers, promptTokens });

  if (triggers.has('queue')) await sleep(QUEUE_WAIT_MS);
  return ctx.json(200, completion({ model, reply, triggers, promptTokens, state }));
}

function unreachable(requestId, ctx) {
  return gatewayError('upstream_unreachable', 'Upstream inference unreachable.', {
    request_id: requestId,
    elapsed_s: elapsed(ctx),
  });
}

function elapsed(ctx) {
  return Math.round((performance.now() - ctx.startedAt) / 10) / 100;
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Decide what the assistant "says".
 * @returns {{reasoning: string | null, content: string | null, toolCall: object | null}}
 */
export function buildReply(body, model, state) {
  const { messages, tools } = body;
  const last = messages.at(-1);
  const reasoning = findModel(model).reasoning ? `Mock reasoning for ${model}.` : null;

  // After a tool result: answer using it.
  if (last.role === 'tool') {
    const name = toolNameFor(messages, last);
    const content = `Mock reply from ${model} after tool ${name}: ${messageText(last).slice(0, 80)}`;
    return { reasoning, content, toolCall: null };
  }

  // Tools offered and the user just spoke: call the first tool.
  if (Array.isArray(tools) && tools.length > 0 && last.role === 'user') {
    const fn = isPlainObject(tools[0]?.function) ? tools[0].function : {};
    const params = isPlainObject(fn.parameters) ? fn.parameters : {};
    const args = schemaInstance({ type: 'object', ...params });
    return {
      reasoning,
      content: null,
      toolCall: {
        id: `call_mock_${++state.toolCallSeq}`,
        type: 'function',
        function: {
          name: typeof fn.name === 'string' ? fn.name : 'tool',
          arguments: JSON.stringify(isPlainObject(args) ? args : {}),
        },
      },
    };
  }

  // A ```json schema in a system or user message: reply with an instance.
  let schema = null;
  for (const m of messages) {
    if (m.role !== 'system' && m.role !== 'user') continue;
    schema = findJsonSchemaBlock(messageText(m)) ?? schema;
  }
  if (schema) {
    return { reasoning, content: JSON.stringify(schemaInstance(schema)), toolCall: null };
  }

  // The word JSON anywhere: a fixed JSON object.
  if (messages.some((m) => /\bJSON\b/.test(messageText(m)))) {
    return { reasoning, content: `{"mock": true, "model": "${model}"}`, toolCall: null };
  }

  const lastUser = messages.findLast((m) => m.role === 'user');
  const content = `Mock reply from ${model}: ${messageText(lastUser).slice(0, 120)}`;
  return { reasoning, content, toolCall: null };
}

function toolNameFor(messages, toolMessage) {
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const call = m.tool_calls.find((c) => c?.id === toolMessage.tool_call_id);
    if (typeof call?.function?.name === 'string') return call.function.name;
  }
  return typeof toolMessage.name === 'string' ? toolMessage.name : 'unknown';
}

function finishReason(reply, triggers) {
  if (reply.toolCall) return 'tool_calls';
  return triggers.has('cap') ? 'length' : 'stop';
}

function usage(promptTokens, completionChars) {
  const completionTokens = Math.ceil(completionChars / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** Non-streamed `chat.completion` body. */
function completion({ model, reply, triggers, promptTokens, state }) {
  const message = { role: 'assistant', content: reply.content };
  let reasoning = reply.reasoning;

  if (reply.toolCall) {
    message.tool_calls = [reply.toolCall];
  } else {
    if (triggers.has('cap')) message.content += CAP_NOTICE;
    if (triggers.has('inline-think')) {
      // The server left reasoning inline. The gateway only strips <think>
      // blocks while streaming, so a plain request sees it in `content`.
      message.content = `<think>Mock inline reasoning.</think>\n\n${message.content}`;
      reasoning = null;
    }
  }
  if (reasoning) message.reasoning_content = reasoning;

  const completionChars = chars(message.content) + chars(reasoning) + chars(reply.toolCall?.function.arguments);

  return {
    id: `chatcmpl-mock-${++state.completionSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(reply, triggers) }],
    usage: usage(promptTokens, completionChars),
  };
}

/**
 * Streamed reply. Event order:
 *   [queue comments] -> role chunk -> reasoning deltas -> ": ka" ->
 *   content deltas (or one whole tool call) -> [cap notice] ->
 *   finish_reason chunk -> usage chunk with "choices": [] -> [DONE]
 * `[mock:timeout]` and `[mock:preempted]` cut the stream after a few content
 * pieces with an error event, then [DONE], with no finish or usage chunk.
 */
async function streamReply(ctx, { model, reply, triggers, promptTokens }) {
  const { res, config, state } = ctx;
  const id = `chatcmpl-mock-${++state.completionSeq}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    ...ctx.rateHeaders,
  });

  const open = () => !res.destroyed && !res.writableEnded;
  const write = (text) => open() && res.write(text);
  const data = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`);
  const comment = (text) => write(`: ${text}\n\n`);
  const chunk = (choices, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices,
    ...extra,
  });
  const delta = (d, finish = null) => chunk([{ index: 0, delta: d, finish_reason: finish }]);
  const pause = () => (config.delayMs > 0 ? sleep(config.delayMs) : Promise.resolve());
  const done = () => {
    write('data: [DONE]\n\n');
    if (open()) res.end();
  };

  if (triggers.has('queue')) {
    // Waiting for a slot: comment lines only, before any data event.
    comment('queued · position 2 of 3 · waiting 1s');
    await pause();
    comment('queued · position 1 of 3 · waiting 2s');
    await pause();
  }

  data(delta({ role: 'assistant', content: '' }));

  for (const piece of splitOnSpaces(reply.reasoning)) {
    await pause();
    data(delta({ reasoning_content: piece }));
  }

  comment('ka'); // keep-alive, as sent during silence

  let content = '';
  if (reply.toolCall) {
    // Arguments arrive whole in one chunk on this gateway.
    await pause();
    data(delta({ tool_calls: [{ index: 0, ...reply.toolCall }] }));
  } else {
    const failure = triggers.has('timeout') ? 'timeout' : triggers.has('preempted') ? 'preempted' : null;
    const pieces = splitOnSpaces(reply.content);
    for (const [i, piece] of pieces.entries()) {
      if (failure && i === PIECES_BEFORE_FAILURE) break;
      await pause();
      data(delta({ content: piece }));
      content += piece;
    }
    if (failure) {
      // The stream is already open (HTTP 200), so the error is a data event.
      data(
        failure === 'timeout'
          ? gatewayError('upstream_timeout', 'Server busy or request took too long.', {
              elapsed_s: elapsed(ctx),
            })
          : gatewayError('preempted', 'The server running this reply was reclaimed mid-reply. Retry in a minute.'),
      );
      return done();
    }
    if (triggers.has('cap')) {
      await pause();
      data(delta({ content: CAP_NOTICE }));
      content += CAP_NOTICE;
    }
  }

  await pause();
  data(delta({}, finishReason(reply, triggers)));

  const completionChars = chars(content) + chars(reply.reasoning) + chars(reply.toolCall?.function.arguments);
  data(chunk([], { usage: usage(promptTokens, completionChars) }));
  done();
}
