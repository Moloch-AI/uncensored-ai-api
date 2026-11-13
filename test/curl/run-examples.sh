#!/usr/bin/env bash
# Run every script in examples/curl against the mock server and check the
# output. Used by CI; also runnable locally:  bash test/curl/run-examples.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$(mktemp)"

# Port 0: the mock picks a free port and prints the URL it listens on.
node "$ROOT/mock-server/server.mjs" --port 0 --delay-ms 0 --quiet >"$LOG" 2>&1 &
MOCK_PID=$!

stop_mock() {
  # Git Bash on Windows cannot signal a native node.exe; use its Windows PID.
  if [[ -r "/proc/$MOCK_PID/winpid" ]] && command -v taskkill >/dev/null; then
    taskkill //F //PID "$(cat "/proc/$MOCK_PID/winpid")" >/dev/null 2>&1 || true
  fi
  kill "$MOCK_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap stop_mock EXIT

for _ in $(seq 1 50); do
  grep -q "listening on" "$LOG" && break
  sleep 0.1
done
grep -q "listening on" "$LOG" || { cat "$LOG"; echo "mock did not start" >&2; exit 1; }

MOLOCHAI_BASE_URL="$(sed -n 's/^MolochAI mock API listening on //p' "$LOG" | tr -d '\r')"
export MOLOCHAI_BASE_URL
export MOLOCHAI_API_KEY="mock-key"

failures=0
check() {
  local name=$1 pattern=$2 output=$3
  if grep -qF -- "$pattern" <<<"$output"; then
    echo "ok    $name: found $pattern"
  else
    echo "FAIL  $name: missing $pattern"
    while IFS= read -r line; do echo "      | $line"; done <<<"$output"
    failures=$((failures + 1))
  fi
}

out="$(bash "$ROOT/examples/curl/chat.sh" "Hello from curl")"
check chat.sh '"object":"chat.completion"' "$out"
check chat.sh 'Mock reply from glm-5.3-flash: Hello from curl' "$out"

out="$(bash "$ROOT/examples/curl/chat.sh" 'Quotes " and \ backslashes' llama-3.3-70b-instruct-abliterated)"
check "chat.sh (escaping)" 'Quotes \" and \\ backslashes' "$out"

out="$(bash "$ROOT/examples/curl/stream.sh" "Stream this")"
check stream.sh '"delta":{"role":"assistant","content":""}' "$out"
check stream.sh ': ka' "$out"
check stream.sh '"choices":[],"usage"' "$out"
check stream.sh 'data: [DONE]' "$out"

out="$(bash "$ROOT/examples/curl/models.sh")"
check models.sh '"object":"list"' "$out"
check models.sh '"id":"llama-3.3-70b-instruct-abliterated"' "$out"

out="$(bash "$ROOT/examples/curl/me.sh")"
check me.sh '"email":"dev@example.com"' "$out"
check me.sh "\"api_base\":\"$MOLOCHAI_BASE_URL\"" "$out"

out="$(bash "$ROOT/examples/curl/inspect-errors.sh")"
check inspect-errors.sh 'X-RateLimit-Remaining:' "$out"
check inspect-errors.sh '{"message":"Unauthenticated."}' "$out"
check inspect-errors.sh '"errors":{"model":["The selected model is invalid."]}' "$out"
check inspect-errors.sh 'Retry-After: 1' "$out"
check inspect-errors.sh '"type":"quota_exceeded"' "$out"
check inspect-errors.sh 'HTTP/1.1 524' "$out"
check inspect-errors.sh 'data: {"error":{"type":"upstream_timeout"' "$out"

# Error exits: a failing request makes chat.sh exit non-zero and print the body.
set +e
out="$(bash "$ROOT/examples/curl/chat.sh" "hi" no-such-model 2>&1)"
code=$?
set -e
check "chat.sh (422 body)" '"The selected model is invalid."' "$out"
if [[ $code -eq 0 ]]; then
  echo "FAIL  chat.sh: exit code 0 on a 422"
  failures=$((failures + 1))
else
  echo "ok    chat.sh: exit code $code on a 422"
fi

set +e
out="$(MOLOCHAI_API_KEY='' bash "$ROOT/examples/curl/models.sh" 2>&1)"
code=$?
set -e
check "models.sh (no key)" 'set MOLOCHAI_API_KEY' "$out"
[[ $code -ne 0 ]] || { echo "FAIL  models.sh: exit 0 without a key"; failures=$((failures + 1)); }

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all curl example checks passed"
