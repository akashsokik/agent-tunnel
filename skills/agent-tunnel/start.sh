#!/usr/bin/env sh
# Start the agent-tunnel broker in the background.
# Returns immediately; the broker keeps running across agent turns.
#
# Env overrides: PORT (default 8787), HOST (default 127.0.0.1)

set -e
DIR=$(cd "$(dirname "$0")" && pwd)
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
PIDFILE="$DIR/tunnel.pid"
LOGFILE="$DIR/tunnel.log"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but was not found on PATH" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "agent-tunnel already running (pid $(cat "$PIDFILE")) at http://$HOST:$PORT"
  exit 0
fi

PORT="$PORT" HOST="$HOST" nohup node "$DIR/server.js" >"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"

# Give it a moment to bind, then confirm it is actually up.
sleep 1
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "agent-tunnel started (pid $(cat "$PIDFILE")) at http://$HOST:$PORT"
  echo "logs:  $LOGFILE"
  echo "stop:  sh $DIR/stop.sh"
else
  echo "agent-tunnel failed to start -- see $LOGFILE" >&2
  rm -f "$PIDFILE"
  exit 1
fi
