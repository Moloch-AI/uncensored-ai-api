#!/usr/bin/env bash
# One chat completion, not streamed. Prints the raw JSON response.
#
#   MOLOCHAI_API_KEY=your-api-key ./examples/curl/chat.sh ["prompt"] [model]
#
# MOLOCHAI_BASE_URL defaults to https://api.molochai.dev/api/v1. Point it at
# the mock (http://127.0.0.1:4010/api/v1, key mock-key) to try this offline.
# Exits non-zero on an HTTP error, after printing the error body.
set -euo pipefail

: "${MOLOCHAI_API_KEY:?set MOLOCHAI_API_KEY (keys: https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)}"
BASE_URL="${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}"
BASE_URL="${BASE_URL%/}"
PROMPT="${1:-Explain server-sent events in two sentences.}"
MODEL="${2:-glm-5.3-flash}"

# Encode a shell string as a JSON string (enough for prompts; no jq needed).
json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# A plain request has to finish before Cloudflare's ~100 s edge timeout (524).
# Use stream.sh for long replies.
# -w '\n' ends the output with a newline, also when the request fails.
curl -sS --fail-with-body -w '\n' \
  --connect-timeout 10 --max-time 120 \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $MOLOCHAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": $(json_string "$MODEL"), \"messages\": [{\"role\": \"user\", \"content\": $(json_string "$PROMPT")}]}"
