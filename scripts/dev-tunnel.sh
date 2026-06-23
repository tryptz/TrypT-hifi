#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
LOCAL_URL="${LOCAL_URL:-http://localhost:${PORT}}"

PORT="$PORT" npm run dev &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

sleep "${SERVER_START_DELAY:-5}"
cloudflared tunnel --url "$LOCAL_URL" --no-autoupdate
