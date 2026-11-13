#!/usr/bin/env bash
# The account behind the key: plan, tier, credit, email_verified, and the
# per-model context limits.
#
#   MOLOCHAI_API_KEY=your-api-key ./examples/curl/me.sh
#
# /auth/me lives outside /v1, so derive it from the base URL by replacing the
# trailing /v1: https://api.molochai.dev/api/v1 -> https://api.molochai.dev/api/auth/me
set -euo pipefail

: "${MOLOCHAI_API_KEY:?set MOLOCHAI_API_KEY (keys: https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)}"
BASE_URL="${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}"
BASE_URL="${BASE_URL%/}"

if [[ "$BASE_URL" != */v1 ]]; then
  echo "me.sh: cannot derive /auth/me: MOLOCHAI_BASE_URL does not end in /v1 ($BASE_URL)" >&2
  exit 2
fi
ME_URL="${BASE_URL%/v1}/auth/me"

curl -sS --fail-with-body -w '\n' \
  --connect-timeout 10 --max-time 30 \
  "$ME_URL" \
  -H "Authorization: Bearer $MOLOCHAI_API_KEY"
