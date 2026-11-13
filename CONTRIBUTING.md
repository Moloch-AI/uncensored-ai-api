# Contributing

Thanks for helping. This repository is the HTTP contract of the MolochAI API,
so changes here have to stay true to what the API actually does. When in doubt,
open an issue first and describe the behavior you saw (never include an API
key).

## Layout

| Path | What |
|---|---|
| `openapi.yaml` | The OpenAPI 3.1 spec. |
| `mock-server/` | The mock server (Node.js >= 20, no runtime dependencies). `server.mjs` is the CLI; `app.mjs` has routing, auth and rate limiting; `chat.mjs` the chat endpoint. |
| `test/mock-server/` | Mock server tests (`node:test`). |
| `test/conformance/` | Validates mock responses against `openapi.yaml` (Ajv). |
| `test/curl/run-examples.sh` | Runs `examples/curl/*.sh` against the mock. |
| `postman/` | Postman collection (v2.1) with tests, and the real-API and mock environments. |
| `test/postman/run.mjs` | Checks the Postman files and runs the collection with newman against the mock. |
| `clients/python/` | Python reference client, demo and tests. |
| `clients/node/` | Node.js reference client, demo and tests. |
| `docs/` | Protocol notes (streaming, errors, mock server). |

## Setup

```bash
npm ci
python -m pip install -r requirements-dev.txt
```

The mock server and both clients need nothing installed; the dev tools are for
tests and linters.

## Tests

```bash
npm test                      # mock server, spec conformance and Node client
npm run test:mock             # mock server only
npm run test:conformance      # mock responses against openapi.yaml
npm run test:node-client      # Node reference client (starts the mock as a subprocess)
python -m pytest              # Python reference client (needs node on PATH for the mock)
bash test/curl/run-examples.sh  # curl examples against the mock
npm run test:postman          # Postman collection with newman against the mock
```

`npm run test:postman` fetches newman with `npx` (the version is pinned in
`test/postman/run.mjs`), so it needs network the first time. newman is not a
devDependency: its dependency tree carries open `npm audit` advisories that
would otherwise land in this repository's lockfile. Bump the pinned version by
hand. See [postman/README.md](postman/README.md#changing-the-collection) for
editing the collection.

The Python tests also run with the standard library alone:

```bash
python -m unittest discover -s clients/python/tests -t clients/python
```

## Lint

```bash
npm run lint                  # Biome (lint + format check) and Redocly (spec)
npx biome check --write .     # apply Biome fixes and formatting
python -m ruff check .
python -m ruff format --check .
python -m mypy                # strict, configured in pyproject.toml
```

CI also runs `shellcheck` on the bash scripts.

## Rules for changes

- **The mock and the spec move together.** A new status, field or header in the
  mock needs the matching change in `openapi.yaml`, and the conformance test
  must pass. A new `[mock:*]` marker or documented behavior should also get a
  request in the Postman collection. It fails if the mock returns something the spec does not document,
  or if a documented status is never produced.
- **Document real behavior only.** The mock simulates what the gateway is
  documented to do. Do not add features the API does not have.
- **Keep the mock dependency-free** and runnable with `node mock-server/server.mjs`
  (no build step), so `npx github:Moloch-AI/uncensored-ai-api` keeps working.
- **Keep the clients single-file and dependency-free**, heavily commented, and
  in step with each other: a behavior change in one needs the same change and
  test in the other.
- **Every command in the docs must have been run.** If you change a script or
  an example, run it (CI runs the curl scripts against the mock).
- Links to `molochai.dev` and `dash.molochai.dev` pages in docs, comments and
  user-facing output carry
  `?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api`. API base
  URLs never do.
- Do not hardcode the model list as the source of truth in client code; fetch
  `GET /models`. The mock's fixed catalog is test data.
- No secrets anywhere: placeholders are `your-api-key` and, for the mock,
  `mock-key`.

## Pull requests

Keep a pull request to one topic, describe the behavior change, and make sure
`npm test`, `python -m pytest`, the curl checks, `npm run test:postman` and the
linters pass. Line endings are LF (`.gitattributes` enforces it).
