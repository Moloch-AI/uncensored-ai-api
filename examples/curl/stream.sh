#!/usr/bin/env bash
# One streamed chat completion. Prints the raw server-sent events as they
# arrive: comment lines (": ka", ": queued ..."), data chunks, the usage chunk
# with "choices": [], and "data: [DONE]".
#
#   MOLOCHAI_API_KEY=your-api-key ./examples/curl/stream.sh ["prompt"] [model]
#
# Exits non-zero if the request fails before the stream opens. Errors after
# the stream opened keep HTTP 200 and arrive as a data event: look for
# data: {"error": ...} in the output.
set -euo pipefail

: "${MOLOCHAI_API_KEY:?set MOLOCHAI_API_KEY (keys: https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)}"
BASE_URL="${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}"
BASE_URL="${BASE_URL%/}"
PROMPT="${1:-Name three HTTP status codes worth retrying, one line each.}"
MODEL="${2:-glm-5.3-flash}"

json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# -N turns off curl's output buffering so events print as they arrive.
# No --max-time: a stream can legitimately run for minutes. Keep-alive
# comments arrive about once a second during silence.
curl -sS -N --fail-with-body \
  --connect-timeout 10 \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $MOLOCHAI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{\"model\": $(json_string "$MODEL"), \"stream\": true, \"messages\": [{\"role\": \"user\", \"content\": $(json_string "$PROMPT")}]}"
