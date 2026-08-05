#!/bin/bash
set -euo pipefail
ROOT="/Users/thiago/pathpoint-boutique"
LOGDIR="$ROOT/.run"
mkdir -p "$LOGDIR"

ensure_next() {
  if ! lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restarting Next.js on :3000" >> "$LOGDIR/keep-alive.log"
    cd "$ROOT"
    nohup npm run dev -- --port 3000 >> "$LOGDIR/next.log" 2>&1 &
    echo $! > "$LOGDIR/next.pid"
    sleep 4
  fi
}

ensure_tunnel() {
  if ! pgrep -f "cloudflared tunnel --url http://localhost:3000" >/dev/null 2>&1; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restarting cloudflared tunnel" >> "$LOGDIR/keep-alive.log"
    : > "$LOGDIR/tunnel.log"
    nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate >> "$LOGDIR/tunnel.log" 2>&1 &
    echo $! > "$LOGDIR/tunnel.pid"
    sleep 5
  fi
  # Refresh public URL file
  rg -o 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOGDIR/tunnel.log" 2>/dev/null | tail -1 > "$LOGDIR/public-url.txt" || true
}

while true; do
  ensure_next
  ensure_tunnel
  sleep 30
done
