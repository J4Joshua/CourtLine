#!/usr/bin/env bash
#
# Start a Cloudflare quick tunnel pointing at the local CourtLine server and
# print the public https URL on stdout. Everything else goes to stderr so the
# caller can capture just the URL.
#
# Usage: start-tunnel.sh [PORT]   (default 8000)
#
set -euo pipefail

PORT="${1:-8000}"
LOG="/tmp/courtline-cloudflared.log"

# 1. Ensure cloudflared is installed.
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[dev-setup] cloudflared not found; installing via Homebrew..." >&2
  brew install cloudflared >&2
fi

# 2. Kill any quick tunnel we previously started (avoid stacking them).
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
sleep 1

# 3. Launch a new quick tunnel, fully detached so it survives this script.
: > "$LOG"
nohup cloudflared tunnel --url "http://localhost:${PORT}" >"$LOG" 2>&1 &
TUNNEL_PID=$!
echo "[dev-setup] started cloudflared (pid ${TUNNEL_PID}) -> http://localhost:${PORT}" >&2

# 4. Poll the log for the assigned *.trycloudflare.com URL (usually <5s).
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "[dev-setup] ERROR: no tunnel URL after 40s. Last log lines:" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

# 5. Emit the URL (and only the URL) on stdout.
echo "$URL"
