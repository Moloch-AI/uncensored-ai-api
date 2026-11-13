#!/usr/bin/env bash
# Show status lines, headers and bodies (-i) for the responses a client has to
# handle, so you can see the three error-body shapes and the rate-limit
# headers on the wire.
#
#   MOLOCHAI_API_KEY=your-api-key ./examples/curl/inspect-errors.sh
#
# Against the real API this makes only requests that cost no tokens: a model
# list, a request without a key (401) and two invalid requests (422). Against
# the local mock (a base URL on 127.0.0.1 or localhost) it also uses the
# mock's [mock:...] markers to show 429s, 413, 503, 504 and Cloudflare's 524.
set -uo pipefail

: "${MOLOCHAI_API_KEY:?set MOLOCHAI_API_KEY (keys: https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)}"
BASE_URL="${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}"
BASE_URL="${BASE_URL%/}"

section() { printf '\n===== %s\n' "$1"; }

# -i prints the status line and headers before the body.
get() {
  local auth=()
  if [[ -n "${2:-}" ]]; then auth=(-H "Authorization: Bearer $2"); fi
  # ${auth[@]+...} keeps bash 3.2 (macOS) happy with an empty array under set -u.
  curl -sS -i --connect-timeout 10 --max-time 30 "$BASE_URL$1" ${auth[@]+"${auth[@]}"}
  echo
}
post_chat() {
  curl -sS -i --connect-timeout 10 --max-time 30 "$BASE_URL/chat/completions" \
    -H "Authorization: Bearer $MOLOCHAI_API_KEY" -H "Content-Type: application/json" -d "$1"
  echo
}

section "200: X-RateLimit-Limit / X-RateLimit-Remaining on a normal request"
get /models "$MOLOCHAI_API_KEY"

section "401: shape C, {\"message\": \"Unauthenticated.\"}. No key sent. Do not retry; fix the key."
get /models ""

section "422: shape B, {\"message\", \"errors\"}. Unknown model id."
post_chat '{"model": "no-such-model", "messages": [{"role": "user", "content": "hi"}]}'

section "422: empty messages and an out-of-range temperature"
post_chat '{"model": "glm-5.3-flash", "messages": [], "temperature": 3}'

case "$BASE_URL" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *)
    printf '\nNot the local mock, so the [mock:...] cases are skipped.\n'
    exit 0
    ;;
esac

mock_case() {
  section "$1"
  post_chat "{\"model\": \"glm-5.3-flash\", \"messages\": [{\"role\": \"user\", \"content\": \"$2\"}]$3}"
}

mock_case "429 rate limit: shape C plus Retry-After. Wait Retry-After seconds." "[mock:rate-limit]" ""
mock_case "429 quota_exceeded: shape A with resets_at. Never auto-retry." "[mock:quota]" ""
mock_case "413 context_length_exceeded: trim, then retry." "[mock:context]" ""
mock_case "503 server_busy: retry with backoff." "[mock:busy]" ""
mock_case "503 model_unavailable: never rerouted; pick another model." "[mock:unavailable]" ""
mock_case "504 upstream_timeout on a plain request: retry, prefer streaming." "[mock:timeout]" ""
mock_case "524 from Cloudflare: HTML, not JSON. Retry, use streaming." "[mock:cloudflare-524]" ""
mock_case "200 stream with an in-stream error event: HTTP status stays 200." "one two three [mock:timeout]" ', "stream": true'
