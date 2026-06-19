#!/usr/bin/env sh
# Continuously watch one agent's inbox and print each new message as it arrives.
#
# Designed to be launched in the BACKGROUND (e.g. Claude Code's Bash
# run_in_background). It long-polls the broker, so it sits idle until a message
# is actually sent -- then it prints, and the harness surfaces that output so the
# coordinating agent can relay the reply without being told to "check the inbox".
#
# Usage:   ID=claude sh ./watch.sh          (or:  sh ./watch.sh claude)
# Env:     PORT (8787), HOST (127.0.0.1), BASE (http://HOST:PORT),
#          WAIT (long-poll seconds per request, default 25),
#          TUNNEL_TOKEN (only if the broker requires a token)
#
# Note: while this is running, do NOT also manually GET /inbox for the same id --
# this watcher consumes the inbox; read new messages from its output instead.
# Stop it by killing this background process.

DIR=$(cd "$(dirname "$0")" && pwd)
ID="${ID:-$1}"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
BASE="${BASE:-http://$HOST:$PORT}"
WAIT="${WAIT:-25}"

if [ -z "$ID" ]; then
  echo "usage: ID=<agent-id> sh ./watch.sh   (or pass the id as the first arg)" >&2
  exit 1
fi

# Optional bearer token, kept in positional params so it expands to nothing when unset.
if [ -n "$TUNNEL_TOKEN" ]; then
  set -- -H "Authorization: Bearer $TUNNEL_TOKEN"
else
  set --
fi

echo "[watch] watching $BASE/inbox?id=$ID (long-poll ${WAIT}s); Ctrl-C or kill to stop"
while true; do
  RESP=$(curl -s "$@" "$BASE/inbox?id=$ID&wait=$WAIT")
  if [ -z "$RESP" ]; then
    echo "[watch] broker unreachable; retrying in 3s" >&2
    sleep 3
    continue
  fi
  # Print only when the response actually carried messages.
  case "$RESP" in
    *'"count": 0'*) : ;;        # nothing new (long-poll already waited)
    *) printf '%s\n' "$RESP" ;;
  esac
done
