# agent-tunnel

A zero-dependency message broker, packaged as a [skills.sh](https://www.skills.sh)
skill, that lets multiple coding agents (Claude Code, Codex, etc.) send messages
back and forth and coordinate work.

One agent acts as the **coordinator**: it starts the broker, subscribes itself,
relays tasks to other agents, and polls for their replies. Each other agent is
connected manually by pasting in a short subscribe snippet.

## Quick start

```sh
# start the broker (background)
sh skills/agent-tunnel/start.sh

# subscribe yourself
curl -s -X POST http://127.0.0.1:8787/subscribe \
  -H 'content-type: application/json' \
  -d '{"id":"claude","description":"coordinator"}'

# send to another agent
curl -s -X POST http://127.0.0.1:8787/send \
  -H 'content-type: application/json' \
  -d '{"from":"claude","to":"codex","text":"do the thing"}'

# check your inbox
curl -s "http://127.0.0.1:8787/inbox?id=claude"

# stop
sh skills/agent-tunnel/stop.sh
```

The full agent-facing instructions live in
[`skills/agent-tunnel/SKILL.md`](skills/agent-tunnel/SKILL.md).

## Layout

```
skills/agent-tunnel/
  SKILL.md     instructions the coordinating agent follows
  server.js    the broker (Node standard library only)
  start.sh     launch the broker in the background
  stop.sh      stop the broker
  watch.sh     background long-poll watcher for one agent's inbox
```

No build step, no dependencies. Requires Node.js. ngrok is optional, only if an
agent runs on a different machine.

## Security

The broker is unauthenticated but locked to localhost: it binds `127.0.0.1`,
rejects non-localhost `Host` headers (anti DNS-rebinding), and rejects
cross-origin `Origin` / cross-site `Sec-Fetch-Site` requests, so a malicious web
page open in your browser cannot quietly inject messages your agents would act
on. `curl`/`node` callers are unaffected.

To expose it remotely (e.g. ngrok), set a shared token — this is required, so
you can't accidentally publish an open relay:

```sh
TUNNEL_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" sh ./start.sh
```

When a token is set, every request must include `Authorization: Bearer <token>`.

Residual assumption with no token: any process running as you on the same
machine can reach the broker, and senders are not cryptographically verified —
fine for cooperating agents you control locally. See `skills/agent-tunnel/SKILL.md`
for the full security model.
