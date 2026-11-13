# Postman collection and other API clients

A Postman collection for the MolochAI API whose requests carry tests, two
environments (the real API and the local mock), and notes on importing
[`openapi.yaml`](../openapi.yaml) into Postman, Insomnia, Bruno and Hoppscotch.

The tests check the documented response shapes, never the wording of a reply.
CI runs the whole collection with newman against the
[mock server](../docs/mock-server.md) on every push.

## Files

| File | What it is |
|---|---|
| [`MolochAI.postman_collection.json`](MolochAI.postman_collection.json) | Collection v2.1: 30 requests with tests, bearer auth from `{{apiKey}}`. |
| [`molochai.postman_environment.json`](molochai.postman_environment.json) | The real API: `baseUrl` = `https://api.molochai.dev/api/v1`, `apiKey` empty (type secret). |
| [`mock.postman_environment.json`](mock.postman_environment.json) | The local mock: `baseUrl` = `http://127.0.0.1:4010/api/v1`, `apiKey` = `mock-key`, `isMock` = `true`. |

## Import into Postman

1. In Postman, choose **Import** and select the three JSON files from this
   folder (or drag them in). Postman also imports from a link; paste the raw
   GitHub URL of each file, for example
   `https://raw.githubusercontent.com/Moloch-AI/uncensored-ai-api/main/postman/MolochAI.postman_collection.json`.
2. For the real API, select the **MolochAI API** environment and paste your key
   into `apiKey`. Keys are created at
   [dash.molochai.dev/account](https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).
   For the mock, start it (`node mock-server/server.mjs` in a clone of this
   repository, or `npx github:Moloch-AI/uncensored-ai-api`) and select the
   **MolochAI mock** environment.
3. Send **List models**, then the rest. To run everything at once, use the
   Collection Runner on the collection.

Keep the key in the environment. The collection defines no `apiKey`
variable, so exporting or sharing the collection cannot carry a key with it.
Keys are not scoped (a key can read account details and create invoices) and do
not expire on a timer, so treat an environment that holds one like a password
file.

There is no "Run in Postman" button: Postman requires the collection to live in
a public Postman workspace for one, and this repository does not publish one.
Import the files instead.

## What is in the collection

| Folder | Requests | Against the real API |
|---|---|---|
| Models and account | `GET /models`, `GET /api/auth/me` | No tokens used. |
| Chat completions | plain, streamed, tool calling (two turns), image input, ignored parameters | Runs a model; uses your quota. |
| Errors and edge cases / Any server (no tokens used) | 401 without a key, 422 unknown model, 422 parameter out of range | No tokens used. |
| Errors and edge cases / Mock only ([mock:*] markers and special keys) | 19 requests: 402, 403, 413, the three 429s, 502, a 502 then a successful retry, both 503s, 504, 524, two in-stream errors, queue comments, the cap notice, inline `<think>`, `/api/auth/me` for an unverified account | Skipped. |

Each request's description says what the response means and whether to retry.
Against the real API, a full run sends 11 requests; the API allows 60 requests
per minute per account.

### Variables

| Variable | Set in | Meaning |
|---|---|---|
| `baseUrl` | collection, environments | Base URL of the `/v1` requests. Default `https://api.molochai.dev/api/v1`. |
| `apiKey` | environments | Bearer token. |
| `model` | collection | Model id for the chat requests. Default `glm-5.3-flash`. Pick an id with `available: true` from **List models**. |
| `accountUrl` | derived | URL of `/api/auth/me` (see below). |
| `isMock` | mock environment | `true` lets the mock-only folder run. |

### `/api/auth/me` lives outside `/api/v1`

The account endpoint is `https://api.molochai.dev/api/auth/me`, not under the
base URL. Rather than a second URL to keep in step, the collection's pre-request
script derives `accountUrl` from `baseUrl` by replacing the trailing `/v1` with
`/auth/me`, the same rule the curl example and the reference clients use. Switch
`baseUrl` and the account request follows. If your base URL does not end in
`/v1`, set `accountUrl` yourself (an environment value wins over the derived
one).

### Streaming in Postman

With `"stream": true` the reply is server-sent events. The Postman desktop app
recognizes `Content-Type: text/event-stream` and lists the events in the
response pane as they arrive, instead of showing one body. The test scripts run
after the stream has ended: the collection's test script reads the raw stream
with `pm.response.text()`, parses it like a client has to (skip `:` comment
lines, stop at `data: [DONE]`, check each payload for an `error` key, check for
an empty `choices` before indexing it) and leaves a summary in the local
variable `sse` for the request's own tests. This is how newman and the CI of
this repository run them. We have not checked every version of the Postman app;
if its tests see an empty body for a stream, run that request with newman.

### The mock-only folder

Its requests put `[mock:*]` markers in the last user message or use the mock's
special keys (`mock-no-plan`, `mock-unverified`). To the real API a marker is
plain text: the request would reach a model, use your quota and fail its tests.
So the folder's pre-request script calls `pm.execution.skipRequest()` unless
`isMock` is `true`, which only the mock environment sets. A Collection Runner
or newman run with the MolochAI API environment therefore skips those 19
requests and logs why.

## Tests

The collection-level test script runs after every request and checks:

- error bodies have the shape documented for their status: A
  `{"error": {"type", "message", ...}}` for 402, 413, 502, 503, 504; B
  `{"message", "errors"}` for 422; C `{"message"}` for 401 and 403; A or C for
  429; not JSON for 524 (and allowed for 502, 503 and 504, where a proxy can
  answer with HTML);
- `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `Retry-After`, when present,
  are whole numbers;
- every `chat.completion` has `id`, `created`, `model`, choices with an
  assistant message and a `finish_reason` of `stop`, `length` or `tool_calls`,
  and a `usage` with three whole-number counts;
- every stream has only JSON data payloads and ends with exactly one
  `data: [DONE]`; before it comes either a usage chunk with `"choices": []` or,
  if the stream failed, an error event (shape A) and no usage chunk.

Each request then checks its own status and fields: the tool call's
`arguments` parse as JSON with the required `city`, the 413 carries
`estimated_tokens`, `context_cap` and `bound_by`, quota 429s carry a future
`resets_at`, the rate-limit 429 carries `Retry-After` and no `X-Should-Retry`,
the 402, the 413 and the quota 429s carry `X-Should-Retry: false`, and so on.

What was checked against what:

- The mock: every request, in CI (`npm run test:postman`).
- The real API: only the two requests that cost nothing with an invalid key.
  **401 Unauthenticated (no key)** and **List models** with
  `apiKey=invalid-key-for-testing` both returned
  `401 {"message":"Unauthenticated."}`, and the 401 assertions passed. The
  requests that need a valid key have been run against the mock only.

## Running with newman

[newman](https://github.com/postmanlabs/newman) is Postman's command-line
runner. This repository does not install it as a dependency; npx fetches a
pinned version.

The check CI runs: it starts the mock on a free port, runs the collection with
the mock environment, then runs it again with the MolochAI API environment
pointed at the mock and checks that exactly the mock-only folder was skipped.

```bash
npm run test:postman
```

By hand, against a mock on the default port:

```bash
node mock-server/server.mjs --port 4010
```

In a second terminal:

```bash
npx --yes newman@6.2.3 run postman/MolochAI.postman_collection.json \
  -e postman/mock.postman_environment.json
```

Against the real API, pass the key on the command line instead of writing it
into the environment file:

```bash
npx --yes newman@6.2.3 run postman/MolochAI.postman_collection.json \
  -e postman/molochai.postman_environment.json --env-var "apiKey=$MOLOCHAI_API_KEY"
```

`--folder "<folder or request name>"` (repeatable) runs part of the collection.

## Importing openapi.yaml into other clients

All four clients import the spec. None of them gets every detail right, and
none brings the tests. Below is what each import produced and what to fix by
hand. The checks ran on 2026-11-13; we ran each client's import code where we
could, not the desktop apps.

| Client | What we ran | Result |
|---|---|---|
| Postman | `openapi-to-postmanv2` 6.4.3, the converter behind Postman's OpenAPI import | Imports. Bearer auth from `{{bearerToken}}`. Variables `baseUrl` (production) and `baseUrl1` (mock). `/auth/me` uses its own server, `{{baseUrl2}}` = `https://api.molochai.dev/api` (`baseUrl3` is the mock's). Every documented status becomes a saved example response. |
| Insomnia | The OpenAPI 3 importer from Insomnia's source (`packages/insomnia/src/main/importers/importers/openapi-3.ts` on the `develop` branch, with its pinned `@scalar/openapi-parser` 0.29.19) | Imports. One environment per server, bearer auth from `{{ _.bearerToken }}`. Path-level servers are ignored, so `/auth/me` becomes `{{ _.base_url }}/auth/me`, under `/api/v1`, which does not exist. |
| Bruno | `bru import openapi` from `@usebruno/cli` 4.3.0 | Imports. Environments "Production" and "Local mock server", collection-level bearer auth from `{{token}}`. `/auth/me` gets a request variable `baseUrl: https://api.molochai.dev/api`, which overrides the environment: with the mock environment selected, that request still goes to the real API. |
| Hoppscotch | Not the app or its importer (it depends on Hoppscotch's unpublished data package). We ran its parsing steps with the versions Hoppscotch 2026.10.1 pins (`js-yaml` 4.3.1, `@apidevtools/swagger-parser` 12.1.0 validate and dereference) and read its importer source (`packages/hoppscotch-common/src/helpers/import-export/import/openapi/index.ts`) | Parsing, validation and dereferencing pass. From the source: requests use `<<baseUrl>>`, seeded from the first server; path-level servers are not read, so `/auth/me` ends up under `/api/v1`; request bodies come from the first example; bearer auth sits on the collection with an empty token. |

Fixes after importing:

- **The `/auth/me` URL.** Set it to `https://api.molochai.dev/api/auth/me`
  (mock: `http://127.0.0.1:4010/api/auth/me`). In Postman, change `baseUrl2`
  along with `baseUrl` when you switch to the mock. In Bruno, edit the
  request's `baseUrl` variable, or delete it and write the full URL.
- **The token variable.** Each client names it differently (`bearerToken`,
  `token`, or an empty token on the collection). Put your key there, preferably
  as a secret or environment value.
- **Request bodies.** The Postman converter's "Parameter generation" option,
  offered in Postman's import settings, defaults to Schema, which fills the
  body with `<string>` placeholders; choose Example to get the spec's example
  bodies. Bruno and Hoppscotch use the first example; Insomnia builds the body
  from the request schema's `example`.
- **Streaming.** The spec documents the stream as `text/event-stream` with a
  JSON Schema for each event. None of these imports produces a streaming request
  or a parser for it; add `"stream": true` to a body to try it.

The collection's own test scripts use Postman's `pm` API. We have not checked
how Insomnia, Bruno or Hoppscotch translate them when importing a Postman
collection, which is why this page starts those clients from `openapi.yaml`.

## Changing the collection

- Edit in Postman, export as **Collection v2.1**, and replace the file. Postman
  exports with tabs; run `npx biome format --write postman/` before committing.
- Keep tests shape-based so they pass against the mock and the real API: check
  statuses, types and documented fields, not the text of a reply.
- A request that needs the mock goes in the mock-only folder. The check fails if
  a request outside it sets its own token, or if a run with the MolochAI API
  environment executes anything from it.
- Never commit a key. The check fails if `apiKey` in the MolochAI API
  environment is not empty.
- Run `npm run test:postman` before opening a pull request.
