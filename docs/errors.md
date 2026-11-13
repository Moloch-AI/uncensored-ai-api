# Errors and retries

How to read a failed response, and which ones to retry. The reference clients
implement this table; the [OpenAPI spec](../openapi.yaml) documents every
response body.

## Read the status first, then the body

Bodies come in three shapes, and some responses are not JSON at all.

| Shape | Body | Used by |
|---|---|---|
| A. Gateway | `{"error": {"type": "...", "message": "...", ...extra}}` | 402, 413, 429 quota, 502, 503, 504, errors inside a stream |
| B. Validation | `{"message": "...", "errors": {"field": ["..."]}}` | 422 |
| C. Bare message | `{"message": "..."}` | 401, 429 rate limit, 403 (adds `"code": "email_unverified"`) |
| Not JSON | HTML or empty | 524 from Cloudflare, proxies, load balancers |

Messages are written for people and can change. Branch on the status, `type`,
`code`, the extra fields (`resets_at`, `context_cap`, `bound_by`, `model`) and
the headers. Never assume the body parses as JSON.

A decoding order that covers everything:

1. Parse the body as JSON; if that fails, keep the raw text.
2. If it has an `error` object: shape A, use `error.type`.
3. Else if it has an `errors` object: shape B (422).
4. Else if it has `message`: shape C; use `code` when present, otherwise the
   status (401 unauthenticated, 429 rate limit).
5. Otherwise: an unknown body; use the status alone.

## Status table

| Status | `type` / marker | Meaning | Extra fields |
|---|---|---|---|
| 401 | `message: Unauthenticated.` | Key missing, mistyped or revoked. | |
| 402 | `no_active_plan` | No active plan and no credit. | `plan` |
| 403 | `code: email_unverified` | The account's email is not confirmed. | |
| 413 | `context_length_exceeded` | The prompt does not fit the context window. | `estimated_tokens`, `context_cap`, `bound_by` (`plan` or `server`), `plan` |
| 422 | `errors` object | Invalid request: unknown `model`, empty `messages`, bad `role`, out-of-range parameter. | `errors` |
| 429 | `session_quota_exceeded` | The 5-hour session cap was reached. | `resets_at`, `plan`, `session_used`, `session_cap` |
| 429 | `quota_exceeded` | The plan's quota is used and there is no credit. | `resets_at`, `plan`, `monthly_used`/`monthly_cap` or `weekly_used`/`weekly_cap` |
| 429 | `message: Too Many Attempts.` | More than 60 requests in a minute. | `Retry-After` header |
| 502 | `upstream_unreachable`, `upstream_timeout`, `no_usage_accounting` | Upstream problem. | `request_id`, `elapsed_s` |
| 503 | `server_busy` | No slot free. | |
| 503 | `model_unavailable` | No server is serving that model. Never rerouted to another model. | `model` |
| 504 | `upstream_timeout` | Upstream time limit on a plain request. | `request_id`, `elapsed_s` |
| 524 | Cloudflare HTML | Edge timeout (about 100 s) on a plain request. | |
| 4xx/5xx | `upstream_error` | The inference server returned an error; the gateway passes its status on. | `status`, `body`, `request_id` |

Include `request_id` when you contact
[support](https://molochai.dev/contact?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)
about an upstream error.

## Retry decision table

| Error | Retry? | How |
|---|---|---|
| Connection refused, reset, DNS failure, TLS error, connect timeout | yes | backoff |
| 502 (any type) | yes | backoff |
| 503 `server_busy` | yes | backoff |
| 504 | yes | backoff; prefer streaming |
| 524 | yes | backoff; switch long requests to streaming |
| other 5xx (`upstream_error`) | yes | backoff |
| 429 `Too Many Attempts.` | yes | wait `Retry-After` seconds (cap the wait) |
| 429 `quota_exceeded` / `session_quota_exceeded` | **no** | surface `resets_at`; it will not pass before then |
| 503 `model_unavailable` | not automatically | a few manual tries at most, then pick another model (`GET /models` shows `available`) |
| 413 | no | trim the conversation, then send again |
| 401, 402, 403, 422 | no | fix the key, plan, email or request |
| Read timeout on a plain request | not by default | the first attempt may still be running (and counting tokens) |
| Error event inside an open stream | not automatically | part of the reply was already delivered |

### Backoff

Exponential backoff with full jitter:

```text
delay(attempt) = random_uniform(0, min(cap, base * 2^attempt))     attempt = 0, 1, 2, ...
```

The reference clients use `base` 0.5 s, `cap` 8 s and 3 retries, so the upper
bounds of the waits are 0.5 s, 1 s and 2 s. Full jitter spreads clients out, so
a burst of failures does not come back as a synchronized burst of retries.

### Retry-After

The rate-limit 429 carries `Retry-After` in seconds (the time until a slot in
the 60-second window frees up). Wait that long, but cap the wait (the reference
clients cap it at 60 s) so one bad header cannot stall a worker for an hour.
Every response under `/v1` also carries `X-RateLimit-Limit` and
`X-RateLimit-Remaining`, so a client can slow down before it hits the limit.

### Do not stack retry layers

If your code retries and the HTTP library under it retries too, failures
multiply: 3 retries at each of two layers is up to 16 attempts. The official
OpenAI SDKs retry on their own (`max_retries`), and they also retry 429 quota
errors that cannot pass until `resets_at`. Pick one layer: turn the SDK's
retries off and keep your own policy, or keep the SDK's and do not wrap it.

## Seeing it on the wire

[`examples/curl/inspect-errors.sh`](../examples/curl/inspect-errors.sh) prints
status lines, headers and bodies. Against the real API it only makes requests
that cost no tokens (401 and 422 cases). Against the [mock server](mock-server.md)
it also shows every other row of the table, using `[mock:...]` markers.
