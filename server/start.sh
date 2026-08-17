#!/usr/bin/env bash
# start.sh — bring up atlas backend (probe server)
set -e
cd "$(dirname "$0")"

PROBE_PORT=${PROBE_PORT:-3001}

echo "atlas — starting backend"

# --- check env ---
if [ -z "$GROQ_API_KEY" ]; then
  # try loading from .env
  if [ -f .env ]; then
    export $(grep -E '^GROQ_API_KEY=' .env | xargs)
  fi
fi

if [ -z "$GROQ_API_KEY" ]; then
  echo "  WARNING: GROQ_API_KEY not set — chat will fail"
  echo "  set it in .env or export GROQ_API_KEY=your_key"
fi

# --- start probe server ---
if curl -sf http://localhost:$PROBE_PORT/health >/dev/null 2>&1; then
  echo "  probe server: already running on :$PROBE_PORT"
else
  echo "  starting probe server on :$PROBE_PORT..."
  nohup bun run src/server.ts &>/tmp/atlas-probe.log 2>&1 &

  for i in $(seq 1 10); do
    sleep 1
    if curl -sf http://localhost:$PROBE_PORT/health >/dev/null 2>&1; then
      echo "  probe server: ok"
      break
    fi
  done

  if ! curl -sf http://localhost:$PROBE_PORT/health >/dev/null 2>&1; then
    echo "  probe server failed to start"
    cat /tmp/atlas-probe.log
    exit 1
  fi
fi

echo ""
echo "  atlas backend is running"
echo "  probe:    http://localhost:$PROBE_PORT"
echo ""
echo "  open /home/wfc/atlas/index.html in a browser"
echo "  press ctrl+c to stop"
echo ""
wait
