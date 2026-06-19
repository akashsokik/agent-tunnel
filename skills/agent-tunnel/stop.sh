#!/usr/bin/env sh
# Stop the agent-tunnel broker started by start.sh.

DIR=$(cd "$(dirname "$0")" && pwd)
PIDFILE="$DIR/tunnel.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "no pidfile; agent-tunnel is not running"
  exit 0
fi

PID=$(cat "$PIDFILE")
if kill "$PID" 2>/dev/null; then
  echo "agent-tunnel stopped (pid $PID)"
else
  echo "agent-tunnel not running (stale pid $PID)"
fi
rm -f "$PIDFILE"
