#!/usr/bin/env bash
# List models. "available": false means no server is serving that id right
# now; a chat request to it returns 503 model_unavailable.
#
#   MOLOCHAI_API_KEY=your-api-key ./examples/curl/models.sh
set -euo pipefail

: "${MOLOCHAI_API_KEY:?set MOLOCHAI_API_KEY (keys: https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)}"
BASE_URL="${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}"
BASE_URL="${BASE_URL%/}"

curl -sS --fail-with-body -w '\n' \
  --connect-timeout 10 --max-time 30 \
  "$BASE_URL/models" \
  -H "Authorization: Bearer $MOLOCHAI_API_KEY"
