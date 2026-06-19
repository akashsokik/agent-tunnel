---
name: agent-tunnel
description: Start a zero-dependency local message broker so multiple coding agents (Claude Code, Codex, etc.) can send messages back and forth and coordinate work. Use when the user wants agents to talk to each other, relay tasks between agents, set up a shared inbox/tunnel, or have one coordinating agent drive others. The coordinating agent starts the broker and hands a subscribe snippet to each other agent.
---

# agent-tunnel

A tiny HTTP message broker that lets several coding agents coordinate. One agent
(usually the one running this skill) acts as the **coordinator**: it starts the
broker, subscribes itself, then relays tasks to other agents and polls for their
replies. Each other agent is connected **manually** by the human pasting in a
short subscribe snippet that you generate.

- Zero dependencies: pure Node standard library, no `npm install`.
- Localhost by default (`http://127.0.0.1:8787`). ngrok is optional, for remote agents.
- On-demand polling: an agent calls `/inbox` when it wants new messages.

## How it works

- Every participant **subscribes** with a unique `id` and a short `description`.
- To talk, an agent POSTs to `/send` with `from`, `to`, and `text`.
  `to` is another agent's id, or `"all"` to broadcast.
- To receive, an agent GETs `/inbox?id=<itself>`. The broker tracks a per-agent
  cursor, so each call returns only messages that agent has not seen yet
  (directed to it or broadcast), and never echoes its own messages back.

## Step 1 — Start the broker

Run the bundled `start.sh` **from this skill's own directory** (it launches the
broker in the background and returns immediately). The directory depends on how
the skill was obtained:

- Installed via `npx skills add` → `.agents/skills/agent-tunnel/`
- Cloned source repo → `skills/agent-tunnel/`

```sh
cd <this-skill-dir> && sh ./start.sh        # e.g. cd .agents/skills/agent-tunnel
```

This prints the URL, e.g. `http://127.0.0.1:8787`. Confirm it is up:

```sh
curl -s http://127.0.0.1:8787/health
```

Use a different port if 8787 is taken: `PORT=9000 sh ./start.sh`.

**Decide whether to require a token (your call as the coordinator):**

- All agents on this one machine, only you running them → start with **no token**.
  The localhost guard already blocks browsers/remote callers, and skipping the
  token keeps the curl snippets clean.
- Shared/multi-user host, or you will expose it remotely (ngrok) → **set a token**
  so every request must authenticate (see "expose to a remote agent" below).

If unsure, start without a token; you can stop and restart with `TUNNEL_TOKEN`
set at any time.

## Step 2 — Subscribe yourself (the coordinator)

Pick an id for yourself, e.g. `claude`:

```sh
curl -s -X POST http://127.0.0.1:8787/subscribe \
  -H 'content-type: application/json' \
  -d '{"id":"claude","description":"Claude Code - coordinator"}'
```

## Step 3 — Connect the other agent(s)

Give the human this block to paste into the other agent (replace `codex` with
that agent's id, and the URL if you changed the port). This is how each agent
"subscribes and identifies itself" over the tunnel:

> You are connected to an agent tunnel at `http://127.0.0.1:8787`. Your id is `codex`.
>
> 1. Subscribe / identify yourself:
> ```sh
> curl -s -X POST http://127.0.0.1:8787/subscribe \
>   -H 'content-type: application/json' \
>   -d '{"id":"codex","description":"Codex CLI"}'
> ```
> 2. Check your inbox for new messages (call this whenever you want to receive):
> ```sh
> curl -s "http://127.0.0.1:8787/inbox?id=codex"
> ```
> 3. Reply / send a message (to a specific agent id, or "all" to broadcast):
> ```sh
> curl -s -X POST http://127.0.0.1:8787/send \
>   -H 'content-type: application/json' \
>   -d '{"from":"codex","to":"claude","text":"on it"}'
> ```
> When you finish a task or have a question, send a message back to `claude`.

## Step 4 — Coordinate

Send a task to another agent:

```sh
curl -s -X POST http://127.0.0.1:8787/send \
  -H 'content-type: application/json' \
  -d '{"from":"claude","to":"codex","text":"Refactor utils/date.js and report back"}'
```

Poll your own inbox for replies:

```sh
curl -s "http://127.0.0.1:8787/inbox?id=claude"
```

Poll in a short loop when you are waiting on a reply (stops as soon as something arrives):

```sh
for i in $(seq 1 30); do
  OUT=$(curl -s "http://127.0.0.1:8787/inbox?id=claude")
  echo "$OUT" | grep -q '"count": 0' || { echo "$OUT"; break; }
  sleep 2
done
```

See who is connected, or the recent message trail:

```sh
curl -s http://127.0.0.1:8787/agents
curl -s "http://127.0.0.1:8787/log?limit=20"
```

## Endpoint reference

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/health` | — | liveness + agent/message counts |
| POST | `/subscribe` | `{id, description}` | register or re-identify (idempotent; keeps your cursor) |
| GET | `/agents` | — | list connected agents |
| POST | `/send` | `{from, to, text}` | send; `to` = an agent id or `"all"` |
| GET | `/inbox` | `?id=ID[&peek=true]` | unread for ID; advances cursor (`peek=true` does not) |
| GET | `/log` | `?limit=N` | last N messages (default 50) |

Notes:
- `id` must match `[A-Za-z0-9._-]`, max 64 chars.
- You can `/send` to an agent that has not subscribed yet; the message waits in
  its inbox until it subscribes and polls.
- `peek=true` lets you look without consuming, useful for debugging.

## Security model

The broker runs unauthenticated by default but is **locked to localhost**:

- It binds `127.0.0.1` only.
- It rejects requests whose `Host` is not localhost (defeats DNS rebinding) and
  any request carrying a cross-origin `Origin` or cross-site `Sec-Fetch-Site`
  header. This stops a malicious web page you happen to have open from calling
  the broker in the background and injecting messages your agents would act on.
- It sends no permissive CORS headers, so a browser cannot read its responses
  cross-origin.

`curl` and server-side `node`/`python` callers send none of those browser
headers, so the normal agent flow is unaffected.

Residual assumption: with no token set, **any process running as you on this
machine** can talk to the broker, and agents do not cryptographically prove the
`from` they claim. That is acceptable for cooperating agents you control on your
own machine. For a shared host or remote exposure, set a token (below).

## Optional — expose to a remote agent (ngrok) with a token

To reach the broker from another machine you MUST set a shared token first
(otherwise the localhost guard rejects the proxied traffic — by design, so you
can't accidentally expose an open relay):

```sh
TUNNEL_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" sh ./start.sh
```

Note the token the broker logs, then in a separate terminal:

```sh
ngrok http 8787
```

When a token is set, **every** request must include it. Give the other agent the
forwarding URL plus the header:

```sh
curl -s -X POST https://<id>.ngrok-free.app/subscribe \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <TUNNEL_TOKEN>' \
  -d '{"id":"codex","description":"Codex CLI"}'
```

Add `-H 'Authorization: Bearer <TUNNEL_TOKEN>'` to the subscribe/send/inbox
snippets in Step 3 as well.

## Stopping

```sh
cd <this-skill-dir> && sh ./stop.sh
```

State (agents + messages) persists in `state.json` inside this skill's
directory, so a restart resumes the same conversation. Delete that file to start
clean.
