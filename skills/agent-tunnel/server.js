#!/usr/bin/env node
'use strict';

// agent-tunnel broker
// Zero-dependency message relay so multiple coding agents can talk to each
// other. Built on Node's standard library only (http, fs, url) -- no npm install.
//
// State lives in memory and is mirrored to state.json so a restart does not
// lose the conversation. Single process, localhost by default.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8787', 10);
const STATE_FILE = process.env.TUNNEL_STATE || path.join(__dirname, 'state.json');
const STARTED_AT = Date.now();

// Optional shared bearer token. When set, every request must present
// `Authorization: Bearer <TUNNEL_TOKEN>` and the request is trusted regardless
// of Host/Origin -- this is what makes remote (e.g. ngrok) use safe. When NOT
// set, the broker enforces a localhost-only, browser-hostile guard instead.
const TOKEN = process.env.TUNNEL_TOKEN || '';

// ---------------------------------------------------------------------------
// State
//   seq      - monotonically increasing message counter
//   agents   - id -> { id, description, cursor, subscribedAt, lastSeen }
//   messages - [{ seq, from, to, text, ts }]   (to === "all" means broadcast)
// ---------------------------------------------------------------------------
let state = { seq: 0, agents: {}, messages: [] };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.seq = parsed.seq || 0;
      state.agents = parsed.agents || {};
      state.messages = parsed.messages || [];
    }
  } catch (e) {
    // No state file yet (or unreadable) -- start fresh.
  }
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[tunnel] failed to persist state:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const isValidId = (s) => typeof s === 'string' && ID_RE.test(s);
const nowIso = () => new Date().toISOString();

function reply(res, code, obj) {
  // Deliberately no `Access-Control-Allow-Origin`. This relay is for
  // non-browser clients (curl/node); withholding CORS headers means a browser
  // cannot read responses cross-origin, even if it can fire the request.
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2) + '\n');
}

// Constant-time string comparison for the shared token.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Gatekeeper run before every request (except CORS preflight).
//   - With TUNNEL_TOKEN set: require a matching bearer token; that token is the
//     authentication, so remote/proxied Host values are fine.
//   - Without a token: allow only localhost callers and reject anything that
//     looks like a cross-origin/cross-site browser request (defeats malicious
//     web pages and DNS rebinding against the loopback service).
function authorize(req) {
  if (TOKEN) {
    const header = req.headers['authorization'] || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, TOKEN)) {
      return { ok: false, code: 401, error: 'missing or invalid bearer token' };
    }
    return { ok: true };
  }

  const host = (req.headers['host'] || '').split(':')[0].toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    return { ok: false, code: 403, error: 'host not allowed; set TUNNEL_TOKEN to expose this broker remotely' };
  }

  const origin = req.headers['origin'];
  if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) {
    return { ok: false, code: 403, error: 'cross-origin requests are not allowed' };
  }

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, code: 403, error: 'cross-site requests are not allowed' };
  }

  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function publicAgents() {
  return Object.values(state.agents).map((a) => ({
    id: a.id,
    description: a.description,
    subscribedAt: a.subscribedAt,
    lastSeen: a.lastSeen,
  }));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleRoot(res) {
  reply(res, 200, {
    service: 'agent-tunnel',
    url: `http://${HOST}:${PORT}`,
    endpoints: {
      'GET /health': 'liveness + counts',
      'POST /subscribe': '{ id, description } -> register / identify',
      'GET /agents': 'list connected agents',
      'POST /send': '{ from, to, text } -> send (to = agent id or "all")',
      'GET /inbox?id=ID[&peek=true]': 'unread messages for ID; advances cursor',
      'GET /log?limit=N': 'recent message trail',
    },
  });
}

function handleHealth(res) {
  reply(res, 200, {
    ok: true,
    url: `http://${HOST}:${PORT}`,
    agents: Object.keys(state.agents).length,
    messages: state.messages.length,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  });
}

async function handleSubscribe(req, res) {
  const body = await readBody(req);
  const { id, description } = body;
  if (!isValidId(id)) {
    return reply(res, 400, { ok: false, error: 'id required (letters, digits, . _ - ; max 64)' });
  }
  const existing = state.agents[id];
  if (existing) {
    existing.description = description || existing.description || '';
    existing.lastSeen = nowIso();
  } else {
    // New agent starts at cursor 0 so it receives anything already queued for it.
    state.agents[id] = {
      id,
      description: description || '',
      cursor: 0,
      subscribedAt: nowIso(),
      lastSeen: nowIso(),
    };
  }
  save();

  const agent = state.agents[id];
  const unread = state.messages.filter(
    (m) => m.seq > agent.cursor && m.from !== id && (m.to === id || m.to === 'all')
  ).length;

  reply(res, 200, {
    ok: true,
    id,
    you: { id: agent.id, description: agent.description },
    peers: publicAgents().filter((a) => a.id !== id),
    unread,
  });
}

function handleAgents(res) {
  reply(res, 200, { ok: true, agents: publicAgents() });
}

async function handleSend(req, res) {
  const body = await readBody(req);
  const { from, to, text } = body;
  if (!isValidId(from)) {
    return reply(res, 400, { ok: false, error: 'from required (a valid agent id)' });
  }
  if (to !== 'all' && !isValidId(to)) {
    return reply(res, 400, { ok: false, error: 'to required (an agent id or "all")' });
  }
  if (typeof text !== 'string' || text.length === 0) {
    return reply(res, 400, { ok: false, error: 'text required (non-empty string)' });
  }

  const message = { seq: ++state.seq, from, to, text, ts: nowIso() };
  state.messages.push(message);
  if (state.agents[from]) state.agents[from].lastSeen = message.ts;
  save();

  reply(res, 200, { ok: true, seq: message.seq, message });
}

function handleInbox(res, query) {
  const id = query.get('id');
  const peek = query.get('peek') === 'true';
  if (!isValidId(id)) {
    return reply(res, 400, { ok: false, error: 'id query param required' });
  }
  const agent = state.agents[id];
  if (!agent) {
    return reply(res, 404, { ok: false, error: `unknown agent "${id}" -- POST /subscribe first` });
  }

  const messages = state.messages.filter(
    (m) => m.seq > agent.cursor && m.from !== id && (m.to === id || m.to === 'all')
  );

  agent.lastSeen = nowIso();
  if (!peek && messages.length > 0) {
    // Advance only to the highest seq actually returned to this caller, so a
    // message assigned a higher seq later is never silently skipped.
    agent.cursor = messages[messages.length - 1].seq;
  }
  save(); // persist cursor / lastSeen

  reply(res, 200, { ok: true, id, count: messages.length, messages });
}

function handleLog(res, query) {
  const limit = Math.min(parseInt(query.get('limit') || '50', 10) || 50, 1000);
  const messages = state.messages.slice(-limit);
  reply(res, 200, { ok: true, count: messages.length, messages });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight: answer without granting cross-origin access so browsers
    // fail closed. Non-browser clients (curl/node) never send this.
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const gate = authorize(req);
    if (!gate.ok) {
      return reply(res, gate.code, { ok: false, error: gate.error });
    }

    const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = `${req.method} ${parsed.pathname}`;

    switch (route) {
      case 'GET /':
        return handleRoot(res);
      case 'GET /health':
        return handleHealth(res);
      case 'POST /subscribe':
        return await handleSubscribe(req, res);
      case 'GET /agents':
        return handleAgents(res);
      case 'POST /send':
        return await handleSend(req, res);
      case 'GET /inbox':
        return handleInbox(res, parsed.searchParams);
      case 'GET /log':
        return handleLog(res, parsed.searchParams);
      default:
        return reply(res, 404, { ok: false, error: `no route for ${route}` });
    }
  } catch (e) {
    reply(res, 400, { ok: false, error: e.message });
  }
});

function shutdown() {
  save();
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

load();
server.listen(PORT, HOST, () => {
  console.log(`[tunnel] agent-tunnel listening at http://${HOST}:${PORT}`);
  console.log(`[tunnel] state file: ${STATE_FILE}`);
  console.log(`[tunnel] auth: ${TOKEN ? 'bearer token required (remote-safe)' : 'localhost-only guard (set TUNNEL_TOKEN to expose remotely)'}`);
  console.log(`[tunnel] ${Object.keys(state.agents).length} agent(s), ${state.messages.length} message(s) loaded`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[tunnel] port ${PORT} is already in use. Set PORT=<other> or stop the existing broker.`);
  } else {
    console.error('[tunnel] server error:', e.message);
  }
  process.exit(1);
});
