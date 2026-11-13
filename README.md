# uncensored-ai-api

[![CI](https://github.com/Moloch-AI/uncensored-ai-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Moloch-AI/uncensored-ai-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The HTTP contract of the MolochAI API, an OpenAI-compatible API for five less-restricted
("uncensored") open-weight models: an OpenAPI 3.1 spec, curl examples, dependency-free reference
clients in Python and Node.js, and the mock server the rest of the ecosystem tests against.

## Overview

This repository is for developers who call the API without an SDK, or who want to know exactly
what goes over the wire. It is the protocol reference, not a library:

- [`openapi.yaml`](openapi.yaml) describes the three public endpoints, every documented status
  code, the three error-body shapes, the rate-limit headers and the server-sent events format.
- [`examples/curl/`](examples/curl/) has small bash scripts for each endpoint and one that prints
  the error responses with their headers.
- [`clients/`](clients/) has two single-file reference clients (Python standard library, Node.js
  `fetch`) with retries, backoff, timeouts and an SSE parser. They are meant to be read and copied
  into your project, not installed.
- [`mock-server/`](mock-server/) is a zero-dependency Node.js server that simulates the gateway's
  documented behavior, including its failure modes, so clients can be developed and tested offline.

```text
                       openapi.yaml (the contract)
                                 |
        +------------------------+------------------------+
        |                        |                        |
  examples/curl/          clients/python/          mock-server/
  bash + curl             clients/node/            offline test double
        |                 copy-paste clients              ^
        |                        |                        |  CI of this repo and of the
        +-----------+------------+                        |  SDK, CLI, examples and
                    |                                     |  playground repositories
                    v                                     |
     https://api.molochai.dev/api/v1      or     http://127.0.0.1:4010/api/v1
```

If you want a library instead, use an SDK:
[uncensored-ai-python](https://github.com/Moloch-AI/uncensored-ai-python) (sync and async, typed) or
[uncensored-ai-node](https://github.com/Moloch-AI/uncensored-ai-node) (TypeScript). The official
OpenAI SDKs also work: set `OPENAI_BASE_URL=https://api.molochai.dev/api/v1` and `OPENAI_API_KEY`.
They are a fine choice. What they leave to you: they drop SSE comment lines (no queue progress),
they do not parse the gateway's error bodies into fields such as `resets_at`, `context_cap` or
`bound_by`, they retry 429 quota errors that cannot pass before `resets_at`, they have no
`/auth/me`, and they leave in-stream errors and the cap notice to the caller.

### What "uncensored" means here

The models are refusal-reduced builds of open-weight base models: refusal behavior is reduced, not
removed. They still sometimes decline, and they are not more accurate than the base models. The
base developers do not publish or endorse these builds. The
[Acceptable Use Policy](https://molochai.dev/acceptable-use?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)
applies, and an app that faces end users needs its own rules and moderation.

## Features

- OpenAPI 3.1 spec, linted with Redocly, with a conformance test that validates every mock
  response (JSON bodies and each SSE event) against the spec's schemas and checks that every
  documented status code is produced.
- Mock server with no runtime dependencies: real per-token rate limiting with `Retry-After`,
  validation errors in the gateway's shape, streaming with reasoning, keep-alive and queue
  comments, tool calls with arguments built from the tool's JSON schema, JSON replies from a schema
  in the prompt, and `[mock:*]` markers for every documented failure (quota, context, busy,
  unavailable, upstream errors, in-stream errors, Cloudflare 524, flaky upstreams, slow replies).
- Reference clients in Python (>= 3.10, standard library only) and Node.js (>= 20, `fetch`, no
  dependencies), with the same behavior:
  - the three error shapes mapped to one exception with `status`, `type`, `body`, `retry_after`
    and `resets_at`;
  - exponential backoff with full jitter for 502, 503 `server_busy`, 504, 524 and connection
    errors; `Retry-After` (capped) for the rate-limit 429; no retry for quota 429s,
    `model_unavailable`, 401, 402, 403, 413 or 422;
  - separate timeouts for starting and for reading;
  - an SSE parser that ignores comments but reports queue progress through a callback, raises
    in-stream error events, and handles the usage chunk with empty `choices`.
- curl scripts for every endpoint, run against the mock in CI.

## Requirements

- Mock server, Node client, spec tooling: Node.js 20 or newer.
- Python client: Python 3.10 or newer (no packages).
- curl examples: bash and curl 7.76 or newer (`--fail-with-body`). On Windows, use Git Bash or WSL.
- Calling the real API: an API key from
  [dash.molochai.dev/account](https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)
  and an active plan or account credit (there is no free tier; see
  [pricing](https://molochai.dev/pricing?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)).

## Installation

Nothing is published to npm or PyPI yet. Clone the repository:

```bash
git clone https://github.com/Moloch-AI/uncensored-ai-api.git
cd uncensored-ai-api
```

The mock server and the reference clients run without installing anything. To run the tests and
linters, install the development tools:

```bash
npm ci
python -m pip install -r requirements-dev.txt
```

To use a reference client, copy one file into your project:
[`clients/python/molochai_http.py`](clients/python/molochai_http.py) or
[`clients/node/molochai-http.mjs`](clients/node/molochai-http.mjs).

## Quickstart

Start the mock server and point the examples at it. No key or network needed:

```bash
node mock-server/server.mjs --port 4010
# MolochAI mock API listening on http://127.0.0.1:4010/api/v1
```

In a second terminal:

```bash
export MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1
export MOLOCHAI_API_KEY=mock-key

./examples/curl/chat.sh "Hello"
python clients/python/demo.py
node clients/node/demo.mjs
```

The mock's replies are canned text (`Mock reply from glm-5.3-flash: Hello`), not model output.
Against the real API, unset `MOLOCHAI_BASE_URL` and set `MOLOCHAI_API_KEY` to your key.

Other repositories can start the mock without cloning this one (Node.js >= 20 and git):

```bash
npx github:Moloch-AI/uncensored-ai-api --port 4010
```

## Usage examples

### curl

| Script | What it shows |
|---|---|
| [`chat.sh ["prompt"] [model]`](examples/curl/chat.sh) | A plain chat completion (raw JSON). |
| [`stream.sh ["prompt"] [model]`](examples/curl/stream.sh) | The raw SSE stream: comments, chunks, usage chunk, `[DONE]`. |
| [`models.sh`](examples/curl/models.sh) | The model list with `available`. |
| [`me.sh`](examples/curl/me.sh) | The account, from `/api/auth/me` (derived from the base URL). |
| [`inspect-errors.sh`](examples/curl/inspect-errors.sh) | Status lines, headers and bodies of error responses (`curl -i`). Against the mock it also triggers every failure mode. |

```bash
./examples/curl/stream.sh "Name three HTTP status codes worth retrying." llama-3.3-70b-instruct-abliterated
./examples/curl/inspect-errors.sh
```

### Python

```python
from molochai_http import MolochAI, MolochAIError, collect_stream

client = MolochAI()  # reads MOLOCHAI_API_KEY and MOLOCHAI_BASE_URL
messages = [{"role": "user", "content": "Explain server-sent events in one sentence."}]

reply = client.chat("glm-5.3-flash", messages)
print(reply["choices"][0]["message"]["content"])

stream = client.chat_stream(
    "glm-5.3-flash",
    messages,
    on_queue=lambda q: print(f"(queued: position {q.position} of {q.total})"),
)
result = collect_stream(stream)  # content, reasoning, tool_calls, finish_reason, usage
print(result.content, result.usage)

try:
    client.chat("glm-5.3-flash", [{"role": "user", "content": "Hello [mock:quota]"}])
except MolochAIError as err:
    if err.type in ("quota_exceeded", "session_quota_exceeded"):
        print(f"Quota used up; it resets at {err.resets_at}")
    else:
        raise
```

The `[mock:quota]` marker makes the mock answer with a quota error; against the real API the
same code handles a real one.

### Node.js

```js
import { collectStream, MolochAI, MolochAIError } from './molochai-http.mjs';

const client = new MolochAI(); // reads MOLOCHAI_API_KEY and MOLOCHAI_BASE_URL
const messages = [{ role: 'user', content: 'Explain server-sent events in one sentence.' }];

const reply = await client.chat('glm-5.3-flash', messages);
console.log(reply.choices[0].message.content);

const result = await collectStream(
  client.chatStream('glm-5.3-flash', messages, {
    onQueue: (q) => console.log(`(queued: position ${q.position} of ${q.total})`),
  }),
  { onChunk: (chunk) => process.stdout.write(chunk.choices[0]?.delta?.content ?? '') },
);
console.log('\n', result.finishReason, result.usage);

try {
  await client.chat('glm-5.3-flash', [{ role: 'user', content: 'Hello [mock:quota]' }]);
} catch (err) {
  if (!(err instanceof MolochAIError) || err.type !== 'quota_exceeded') throw err;
  console.log(`Quota used up; it resets at ${err.resetsAt.toISOString()}`);
}
```

### Testing your own client against the mock

Put a marker in the last user message to make the mock fail the way the real API can:

```bash
./examples/curl/chat.sh "[mock:busy]"           # 503 server_busy
./examples/curl/chat.sh "[mock:quota]"          # 429 quota_exceeded with resets_at
./examples/curl/stream.sh "a b c [mock:timeout]" # some content, then an in-stream error event
```

All markers, special tokens (`mock-no-plan`, `mock-unverified`) and options are listed in
[docs/mock-server.md](docs/mock-server.md).

## Configuration

Clients and examples:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MOLOCHAI_API_KEY` | yes | | API key (bearer token). Use `mock-key` with the mock. |
| `MOLOCHAI_BASE_URL` | no | `https://api.molochai.dev/api/v1` | Base URL. The mock is `http://127.0.0.1:4010/api/v1`. |

See [.env.example](.env.example). Reference client options:

| Python | Node | Default | Meaning |
|---|---|---|---|
| `connect_timeout` | `connectTimeoutMs` | 10 s | Python: TCP/TLS connect. Node: until a stream starts (fetch does not expose the connect step; Node's fetch also stops connecting after 10 s). |
| `read_timeout` | `readTimeoutMs` | 120 s | Longest wait for any read: the whole generation for a plain request, the gap between events for a stream. |
| `max_retries` | `maxRetries` | 3 | Retries after the first attempt. |
| `backoff_base`, `backoff_max` | `backoffBaseMs`, `backoffMaxMs` | 0.5 s, 8 s | Backoff schedule. |
| `max_retry_after` | `maxRetryAfterMs` | 60 s | Cap on a `Retry-After` wait. |
| `retry_on_timeout` | `retryOnTimeout` | off | Also retry read timeouts (the first attempt may still be running). |
| `on_retry` | `onRetry` | | Called before each retry wait. |

Mock server options (`--port`, `--host`, `--delay-ms`, `--unavailable`, `--rate-limit`, `--quiet`
and their `MOCK_*` environment variables) are in [docs/mock-server.md](docs/mock-server.md#options).

## API reference

Base URL `https://api.molochai.dev/api/v1`, JSON in and out, `Authorization: Bearer <key>`.

| Endpoint | What it does |
|---|---|
| `POST /chat/completions` | Chat completion, plain or streamed (`"stream": true`). |
| `GET /models` | Model ids, display names and whether a server is serving each one now. |
| `GET /api/auth/me` | The account: plan, tier, credit, `email_verified`, per-model `context_limit`. Outside `/v1`: replace the trailing `/v1` of the base URL with `/auth/me`. |

Parameters that reach the model: `model`, `messages`, `stream`, `temperature` (0 to 2), `top_p`
(0 to 1), `tools`, `tool_choice`. `max_tokens` is accepted (1 to 65536) but has no effect: the
plan's output cap is always used. `stop`, `n`, `seed`, `response_format`, `top_k`,
`frequency_penalty`, `presence_penalty`, `logprobs`, `logit_bias`, `user` and `stream_options` are
silently dropped. There is no JSON mode: ask for JSON in the prompt and validate the reply.

Details:

- [openapi.yaml](openapi.yaml): request and response schemas, every status code, headers.
- [docs/streaming.md](docs/streaming.md): the SSE grammar, event order, comments, tool calls, the
  cap notice and in-stream errors.
- [docs/errors.md](docs/errors.md): the three body shapes, the status table and the retry
  decision table.
- [docs/mock-server.md](docs/mock-server.md): the mock's routes, tokens and `[mock:*]` markers.
- [MolochAI documentation](https://molochai.dev/docs?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).

### Models

The public catalog, checked on 2026-11-07. It can change, and there is no version pinning (the
build behind an id can change), so fetch `GET /models` instead of hardcoding it. Current list:
[molochai.dev/models](https://molochai.dev/models?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).

| API id | Base model (developer, license) | Reasoning | Input, per the model card |
|---|---|---|---|
| `glm-5.3-flash` | GLM-5.3-Flash (Z.ai, MIT) | on, high effort | text, images |
| `glm-4.7-flash-uncensored` | GLM-4.7-Flash (Z.ai, MIT) | on, medium | text |
| `gemma4-26b-a4b-qat` | Gemma 4 26B A4B (Google DeepMind, Apache 2.0) | on, medium | text, images |
| `qwen3.8-27b-uncensored` | Qwen3.8-27B (Qwen Team, Apache 2.0) | on, medium | text, images (video input through this API is not documented) |
| `llama-3.3-70b-instruct-abliterated` | Llama-3.3-70B-Instruct (Meta, Llama 3.3 Community License) | off | text |

Reasoning and its effort are fixed per model and cannot be changed per request. Images work only
when the model takes them per its card and the serving server has vision enabled. Model facts
belong to each base model's own card.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 {"message":"Unauthenticated."}` | The header must be `Authorization: Bearer <key>`. Check for a missing, mistyped or revoked key. |
| `402 no_active_plan` | The key is fine; the account has no plan and no credit. A new key will not help. |
| `403 email_unverified` | Confirm the account's email. `GET /api/auth/me` still answers and shows `email_verified: false`. |
| `422` with `"model"` in `errors` | Unknown model id. Use an id from `GET /models`. |
| `503 model_unavailable` | Nothing serves that model right now; it is not rerouted. Check `available` in `GET /models` and pick another model. |
| `429` | Read the body: `Too Many Attempts.` means wait `Retry-After`; `quota_exceeded` or `session_quota_exceeded` means wait until `resets_at`. |
| `524` HTML page | Cloudflare gave up after about 100 s on a plain request. Use streaming. |
| The reply ends with `[Response is too large for your current plan. ...]` | It hit the plan's output cap (`finish_reason: "length"`). `max_tokens` does not change the cap. Ask for a shorter answer or split the task. |
| `molochai-mock: cannot listen on 127.0.0.1:4010: listen EADDRINUSE` | Another process uses the port. Pick another with `--port`, or `--port 0` for any free port. |
| `[mock:flaky=N]` never fails in your tests | The counter is keyed on the request body. Add a nonce so each test sends a unique body. |
| curl scripts fail on Windows `cmd` or PowerShell | They are bash scripts. Run them in Git Bash or WSL. |
| Retries take much longer than expected | Two layers are retrying (for example your code and the OpenAI SDK). Disable one. |

## Security considerations

- API keys are not scoped: a key can read account details and create invoices. Keep keys on a
  server. Never ship one in a browser bundle or a mobile app; put a backend in between.
- Keys do not expire on a timer. Revoke a leaked key in the dashboard and create a new one.
- Keep keys in the environment or a secrets manager. `.env` is in `.gitignore`; commit only
  `.env.example`. The reference clients never print the key (`repr` / `console.log` of a client
  does not include it).
- The mock server accepts any token and is meant for local use. It binds to `127.0.0.1` by
  default; do not expose it on a public interface.
- The models have reduced refusal behavior. If people other than you send prompts through your
  app, add your own rules, moderation and logging appropriate to your use, and follow the
  [Acceptable Use Policy](https://molochai.dev/acceptable-use?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).
- Report vulnerabilities in this repository privately, as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development commands (tests, lint, spec
conformance). Changes to the mock server or the spec should come with tests, and the mock must
keep matching the spec.

## License

[MIT](LICENSE). Copyright (c) 2026 MolochAI.
