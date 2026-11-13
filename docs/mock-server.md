# Mock server

A zero-dependency Node.js (>= 20) HTTP server that reproduces the MolochAI
gateway's documented behavior for offline development and CI: routes, auth,
the three error shapes, rate-limit headers, the SSE stream format, tool calls
and the failure modes a client has to handle. It is a test double. Replies are
canned text built from your request, not model output.

The other repositories in the
[Moloch-AI organization](https://github.com/Moloch-AI) run their tests against
it.

## Start it

```bash
node mock-server/server.mjs --port 4010
# MolochAI mock API listening on http://127.0.0.1:4010/api/v1
```

Without cloning (Node >= 20; npm fetches the repository from GitHub):

```bash
npx github:Moloch-AI/uncensored-ai-api --port 4010
```

Then point any client at it:

```bash
export MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1
export MOLOCHAI_API_KEY=mock-key
```

The OpenAI SDKs work against it too (`OPENAI_BASE_URL`, `OPENAI_API_KEY`).

### Options

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--port <n>` | `MOCK_PORT` | `4010` | Port. `0` picks a free one; the printed line has the real port. |
| `--host <addr>` | `MOCK_HOST` | `127.0.0.1` | Address to bind. |
| `--delay-ms <n>` | `MOCK_DELAY_MS` | `15` | Pause between stream chunks. `0` for fast tests. |
| `--unavailable <ids>` | `MOCK_UNAVAILABLE` | none | Comma-separated model ids reported as `available: false`; chat requests to them return 503 `model_unavailable`. |
| `--rate-limit <n>` | `MOCK_RATE_LIMIT` | `60` | Requests per minute per token. `0` turns the limiter (and its headers) off. |
| `--quiet` | | off | Do not log requests to stderr. |
| `-h`, `--help` | | | Usage. |

Flags win over environment variables. When ready, the server prints exactly one
line to stdout, `MolochAI mock API listening on <base URL>`; wait for it (or
poll `GET /health`) before sending requests. Without `--quiet` it logs one line
per request to stderr, such as
`POST /api/v1/chat/completions 200 glm-5.3-flash stream`.

### From JavaScript tests

The package root exports the server, so Node tests can start it in-process:

```js
import { startMockServer } from 'uncensored-ai-api'; // or a relative path to mock-server/app.mjs

const mock = await startMockServer({ port: 0, delayMs: 0, quiet: true });
// mock.baseUrl === 'http://127.0.0.1:<port>/api/v1'
await mock.close();
```

### From other languages

Start `node mock-server/server.mjs --port 0 --quiet`, read the first stdout
line, and take the base URL from it. The Python tests in this repository do this
in [`clients/python/tests/mock_server.py`](../clients/python/tests/mock_server.py).

## Routes

| Route | Auth | Response |
|---|---|---|
| `GET /health` | none | `200 {"ok":true}` |
| `POST /api/v1/chat/completions` | bearer | chat completion or SSE stream |
| `GET /api/v1/models` | bearer | model list |
| `GET /api/auth/me` | bearer | account |
| anything else | | `404 {"message":"Not found."}` |

## Auth and special tokens

| Token | Result |
|---|---|
| missing or empty | `401 {"message":"Unauthenticated."}` on every route except `/health` |
| `mock-no-plan` | `402 no_active_plan` on `/api/v1/*`, with `X-Should-Retry: false`; `/api/auth/me` answers with `plan: null` |
| `mock-unverified` | `403 {"code":"email_unverified"}` on `/api/v1/*`; `/api/auth/me` answers with `email_verified: false` |
| anything else | accepted |

The checks run in the gateway's order: auth, email verification, rate limit,
plan. `/api/auth/me` is outside `/api/v1` and not behind the email, rate-limit
or plan checks, which is how a real client finds out why the other routes fail.

## Rate limiting

Every `/api/v1` response after the limiter carries `X-RateLimit-Limit` and
`X-RateLimit-Remaining`, from a real sliding 60-second window per token. Over
the limit: `429 {"message":"Too Many Attempts."}` with `Retry-After` set to the
seconds until the oldest request leaves the window. Rejected requests do not use
up a slot.

## Validation (422)

Missing or unknown `model`; missing, empty or non-array `messages`; a message
without a `role` of `system`, `user`, `assistant` or `tool`; `temperature`
outside 0..2; `top_p` outside 0..1; `max_tokens` outside 1..65536 or not an
integer; a non-boolean `stream`. The body is shape B, with field keys such as
`messages.0.role`. A body that is not JSON counts as an empty request. Unknown
parameters (`stop`, `n`, `seed`, `response_format`, ...) are ignored, as the
gateway silently drops them.

## Replies

- Text: `Mock reply from <model>: <first 120 characters of the last user message>`.
  For array content, the text parts are used.
- Reasoning: every model except `llama-3.3-70b-instruct-abliterated` also
  produces `Mock reasoning for <model>.`, as `message.reasoning_content` or as
  `delta.reasoning_content` chunks.
- Usage: `prompt_tokens = ceil(characters of all message contents / 4)`,
  `completion_tokens = ceil((reply + reasoning characters) / 4)`, total = sum.
- Tools: when the request has `tools` and the last message is from the user,
  the reply calls the first tool (`finish_reason: "tool_calls"`,
  `content: null`, id `call_mock_<n>`), with arguments built from the tool's
  JSON schema. When the last message is a `tool` message, the reply is
  `Mock reply from <model> after tool <name>: <first 80 characters of the tool content>`.
- JSON: when a system or user message contains a ```` ```json ```` fenced block
  that parses as a JSON Schema with `properties`, the content is an instance of
  it (strings `"example"` or the first `enum` value, numbers and integers `1`,
  booleans `true`, arrays with one item, objects recursively). Otherwise, if any
  message contains the word `JSON`, the content is
  `{"mock": true, "model": "<model>"}`.
- Ids: `chatcmpl-mock-<n>`, counting up per server.

## Streaming

First a chunk with `delta.role`, then reasoning deltas, a `: ka` comment,
content deltas (split on spaces, keeping the spaces, `--delay-ms` apart), a
chunk with `finish_reason`, the usage chunk with `"choices": []`, then
`data: [DONE]`. A tool call arrives whole in one chunk. See
[streaming.md](streaming.md) for the format.

## Behavior triggers

Put a marker in the **last user message** and the mock does that. Markers in
earlier messages are ignored.

| Marker | Plain request | Streamed request |
|---|---|---|
| `[mock:rate-limit]` | 429 `Too Many Attempts.`, `Retry-After: 1` | same |
| `[mock:quota]` | 429 `quota_exceeded`, `resets_at` one hour ahead, `plan`, `monthly_used`, `monthly_cap`, header `X-Should-Retry: false` | same |
| `[mock:session-quota]` | 429 `session_quota_exceeded`, `resets_at`, header `X-Should-Retry: false` | same |
| `[mock:context]` | 413 `context_length_exceeded`, `context_cap: 65536`, `bound_by: "plan"`, header `X-Should-Retry: false` | same |
| `[mock:busy]` | 503 `server_busy` | same |
| `[mock:unavailable]` | 503 `model_unavailable` with `model` | same |
| `[mock:upstream-error]` | 502 `upstream_error`, `status: 500`, `body`, `request_id` | same |
| `[mock:timeout]` | 504 `upstream_timeout` | some content, then an in-stream `upstream_timeout` event with `elapsed_s`, then `[DONE]` |
| `[mock:preempted]` | 502 `upstream_unreachable` | some content, then an in-stream `preempted` event, then `[DONE]` |
| `[mock:flaky=N]` | the first N requests with an identical body fail with 502 `upstream_unreachable`; request N+1 succeeds | same |
| `[mock:cloudflare-524]` | 524 with an HTML body | same |
| `[mock:queue]` | waits 200 ms | two `: queued · position ...` comments before any data |
| `[mock:cap]` | `finish_reason: "length"`, cap notice appended | same, the notice as a last content delta |
| `[mock:inline-think]` | content starts with `<think>Mock inline reasoning.</think>`, no `reasoning_content` | normal stream (the gateway strips inline think while streaming) |
| `[mock:slow=MS]` | waits MS milliseconds before answering (up to 600000) | same, before the stream opens |

`[mock:flaky=N]` keys its counter on a hash of the raw request body, so make
the body unique per test (add a nonce to the message) or the counter carries
over between tests that share a server.

## Differences from the real API

The mock is for exercising client code, not for predicting real replies.

- Replies, reasoning and tool arguments are canned; token counts are estimates.
- The model list is fixed (the public catalog as checked on 2026-11-07) unless
  `--unavailable` is used. Real clients should always fetch `GET /models`.
- The gateway's identity system message is not simulated.
- `/api/auth/me` returns a fixed account (`dev@example.com`, plan `pro`); for
  `mock-no-plan` it returns `plan`, `plan_expires_at` and `tier` as null.
- Queue and keep-alive timing is compressed: comments are `--delay-ms` apart,
  not a second apart.
- There is no TLS, no Cloudflare in front, and no request size limit.
