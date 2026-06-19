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

Run the start script (it launches the broker in the background and returns immediately):

```sh
sh skills/agent-tunnel/start.sh
```

This prints the URL, e.g. `http://127.0.0.1:8787`. Confirm it is up:

```sh
curl -s http://127.0.0.1:8787/health
```

Use a different port if 8787 is taken: `PORT=9000 sh skills/agent-tunnel/start.sh`.

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

## Optional — expose to a remote agent via ngrok

The broker only listens on localhost. If an agent runs on another machine, in a
separate terminal run:

```sh
ngrok http 8787
```

Share the `https://<id>.ngrok-free.app` forwarding URL in place of
`http://127.0.0.1:8787` in the subscribe snippet. No code change needed.

## Stopping

```sh
sh skills/agent-tunnel/stop.sh
```

State (agents + messages) persists in `skills/agent-tunnel/state.json`, so a
restart resumes the same conversation. Delete that file to start clean.
