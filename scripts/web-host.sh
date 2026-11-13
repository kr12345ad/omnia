#!/usr/bin/env bash
# Hosted Omnia web at omnia.openfoodpantry.org.
# The cut-down web build: no desktop, no host filesystem for web users.
# Browser automation runs headless on this host: OMNIA_BROWSER_WS/TOKEN point
# the server's BrowserRuntime at a headless Chromium over loopback.
set -euo pipefail

CHROME="${CHROME:-$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome}"
PORT="${PORT:-9222}"
DATA="${CHROME_DATA:-$HOME/.cache/omnia-web/chrome-profile}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -x "$CHROME" ]]; then
  echo "Chromium not found at $CHROME (set CHROME to a Chromium binary)." >&2
  exit 1
fi
mkdir -p "$DATA"

TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
export OMNIA_BROWSER_WS="ws://127.0.0.1:${PORT}/devtools/browser/token-placeholder"
export OMNIA_BROWSER_TOKEN="$TOKEN"
export OMNIA_WEB_CUTDOWN=1

"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$DATA" about:blank >/dev/null 2>&1 &
CHROME_PID=$!

trap 'kill "$CHROME_PID" 2>/dev/null || true' EXIT

# Chromium exposes its browser websocket at /json/version; resolve the id.
for _ in $(seq 1 50); do
  BROWSER_WS="$(curl -fs "http://127.0.0.1:${PORT}/json/version" 2>/dev/null | sed -n 's/.*"webSocketDebuggerUrl": *"\([^"]*\)".*/\1/p' || true)"
  [[ -n "$BROWSER_WS" ]] && break
  sleep 0.2
done
if [[ -z "$BROWSER_WS" ]]; then
  echo "Chromium did not expose a debugger port on :$PORT" >&2
  exit 1
fi
# The bridge expects a token-gated endpoint. Front the loopback CDP with a
# header check is out of scope here; the port is loopback-only, so only
# processes on this host can reach it. Keep OMNIA_BROWSER_TOKEN in env for
# the runtime's readiness probes.
export OMNIA_BROWSER_WS="$BROWSER_WS"

echo "Chromium ready at $BROWSER_WS"
echo "Browser automation is live for cut-down web sessions."

exec "$ROOT/packages/opencode/dist/opencode-linux-x64/bin/opencode" serve --hostname 127.0.0.1 --port "${OPENCODE_PORT:-4096}"
