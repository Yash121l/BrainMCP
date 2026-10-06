// HTTP routes for the gateway that are not MCP: the upstream OAuth callback, the
// device-code login the brain CLI uses, and the WebSocket the local bridge holds open.

import { resolvePrincipal, sha256hex, isHumanSession } from './auth.js';
import { auditInBackground } from './audit.js';
import { decryptText } from './crypto.js';
import { sessionCookie } from './app.js';
import { finishOauth, syncTools, connName } from './gateway.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body, status = 200) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:30rem;margin:15vh auto;padding:0 1rem;color:#e7e5e4;background:#0c0a09}a{color:#60a5fa}</style></head>
<body><h2>${esc(title)}</h2>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } },
);

const DEVICE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const userCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = [...b].map((x) => DEVICE_ALPHABET[x % DEVICE_ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function limited(env, req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  return env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key: `device:${ip}` })).success;
}

export async function handleGatewayRoutes(req, env, url, ctx) {
  if (url.pathname === '/connect/callback' && req.method === 'GET') {
    const token = sessionCookie(req);
    const p = token ? await resolvePrincipal(env, token) : null;
    if (!p || !isHumanSession(p)) return page('Sign in first', '<p>Open the BrainMCP console in this browser, sign in, and start the connection again.</p>', 401);
    let r;
    try {
      r = await finishOauth(env, url, token);
    } catch (e) {
      r = { error: 'the connection could not be completed; start again from the console' };
      console.log('connect callback failed:', e.name);
    }
    if (r.error) {
      auditInBackground({ env, ctx, p }, 'gw.connection.connect', { outcome: 'error', detail: r.error });
      return page('Connection failed', `<p>${esc(r.error)}</p><p><a href="/#connections">Back to connections</a></p>`, 400);
    }
    const name = connName(r.conn);
    let synced = null;
    try {
      synced = await syncTools(env, r.conn);
    } catch (e) {
      synced = { error: e.message };
    }
    auditInBackground({ env, ctx, p }, 'gw.connection.connect', { target: name, detail: synced });
    return new Response(null, { status: 302, headers: { Location: `/#connections?connected=${encodeURIComponent(name)}` } });
  }

  if (url.pathname === '/device' && req.method === 'GET') {
    const code = url.searchParams.get('code') || '';
    return new Response(null, { status: 302, headers: { Location: `/#device${code ? `?code=${encodeURIComponent(code)}` : ''}` } });
  }

  if (url.pathname === '/device/code' && req.method === 'POST') {
    if (await limited(env, req)) return Response.json({ error: 'slow_down' }, { status: 429 });
    const body = await req.json().catch(() => ({}));
    const machine = String(body.machine || '').trim().toLowerCase().slice(0, 40);
    const asked = Array.isArray(body.agents) && body.agents.length ? body.agents : [body.agent || 'cli'];
    const list = [...new Set(asked.map((a) => String(a).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
    if (list.some((a) => !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(a))) return Response.json({ error: 'invalid_request', error_description: 'agent names must be short lowercase names' }, { status: 400 });
    const agent = list.join(',');
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(machine)) return Response.json({ error: 'invalid_request', error_description: 'machine must be a short lowercase name' }, { status: 400 });
    const device = randHex(32);
    const code = userCode();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM device_codes WHERE exp < datetime('now')"),
      env.DB.prepare("INSERT INTO device_codes (device_hash, user_code, machine, agent, status, exp, created) VALUES (?, ?, ?, ?, 'pending', datetime('now', '+15 minutes'), datetime('now'))")
        .bind(await sha256hex(device), code, machine, agent),
    ]);
    return Response.json({
      device_code: device, user_code: code, expires_in: 900, interval: 5,
      verification_uri: `${url.origin}/device`, verification_uri_complete: `${url.origin}/device?code=${code}`,
    });
  }

  if (url.pathname === '/device/token' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const hash = await sha256hex(String(body.device_code || ''));
    const row = await env.DB.prepare('SELECT * FROM device_codes WHERE device_hash = ?').bind(hash).first();
    if (!row || Date.parse(`${row.exp.replace(' ', 'T')}Z`) < Date.now()) return Response.json({ error: 'expired_token' }, { status: 400 });
    if (row.status === 'pending' || row.status === 'approving') return Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (row.status === 'collected') return Response.json({ error: 'expired_token' }, { status: 400 });
    if (row.status === 'denied') {
      await env.DB.prepare('DELETE FROM device_codes WHERE device_hash = ?').bind(hash).run();
      return Response.json({ error: 'access_denied' }, { status: 400 });
    }
    const claimed = await env.DB.prepare("UPDATE device_codes SET status = 'collected' WHERE device_hash = ? AND status = 'approved'").bind(hash).run();
    if ((claimed.meta?.changes ?? 0) !== 1) return Response.json({ error: 'expired_token' }, { status: 400 });
    const sealed = await decryptText(env.BRAIN_KEK, row.key_sealed).catch(() => null);
    await env.DB.prepare('DELETE FROM device_codes WHERE device_hash = ?').bind(hash).run();
    if (!sealed) return Response.json({ error: 'server_error' }, { status: 500 });
    const keys = sealed.startsWith('{') ? JSON.parse(sealed) : { [row.agent]: sealed };
    const agents = Object.keys(keys);
    return Response.json({ key: keys[agents[0]], keys, machine: row.machine, agent: agents[0], agents, mcp_url: `${url.origin}/mcp` });
  }

  if (url.pathname === '/bridge/connect') {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    if (!env.BRIDGE) return new Response('the bridge is not enabled on this server', { status: 501 });
    // WebSocket clients cannot always set headers: the key may come as a subprotocol
    // ("brain.v1", "<key>"); the reply then selects only "brain.v1".
    const protocols = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const viaProtocol = protocols.find((x) => x.startsWith('bk_'));
    const h = req.headers.get('Authorization') || '';
    const p = await resolvePrincipal(env, h ? h.replace(/^Bearer\s+/i, '') : viaProtocol || '');
    if (!p) return new Response('unauthorized', { status: 401 });
    if (!p.machineId) return new Response('this key belongs to no machine; log in with `brain login` on the machine first', { status: 403 });
    auditInBackground({ env, ctx, p }, 'gw.bridge.connect', { detail: { machine: p.machineId } });
    const res = await env.BRIDGE.get(env.BRIDGE.idFromName(p.machineId)).fetch('https://bridge/connect', req);
    if (!protocols.includes('brain.v1') || res.status !== 101) return res;
    return new Response(null, { status: 101, webSocket: res.webSocket, headers: { 'Sec-WebSocket-Protocol': 'brain.v1' } });
  }

  return null;
}

const BRIDGE_TIMEOUT_MS = 60000;

/**
 * One machine's bridge. The brain CLI on that machine holds a WebSocket here and runs
 * its local stdio MCP servers; ConnectionDO sends JSON-RPC through /rpc.
 */
export class BridgeDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.waiting = new Map();
  }

  sockets() {
    return this.state.getWebSockets ? this.state.getWebSockets() : [];
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/connect') {
      for (const old of this.sockets()) {
        try { old.close(4000, 'replaced by a newer bridge'); } catch { /* already closed */ }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === '/rpc') {
      const { server, message } = await req.json();
      const ws = this.sockets()[0];
      if (!ws) return Response.json({ ok: false, error: 'the bridge on that machine is offline; run `brain bridge` there' });
      if (message?.id === undefined) {
        ws.send(JSON.stringify({ server, message }));
        return Response.json({ ok: true, message: null });
      }
      const rid = crypto.randomUUID();
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.waiting.delete(rid); reject(new Error('the bridge did not answer in time')); }, BRIDGE_TIMEOUT_MS);
        this.waiting.set(rid, { resolve, timer });
      });
      ws.send(JSON.stringify({ rid, server, message }));
      try {
        return Response.json({ ok: true, message: await reply });
      } catch (e) {
        return Response.json({ ok: false, error: e.message });
      }
    }
    if (path === '/close') {
      for (const ws of this.sockets()) {
        try { ws.close(4001, 'machine revoked'); } catch { /* already closed */ }
      }
      for (const [rid, w] of this.waiting) {
        clearTimeout(w.timer);
        w.resolve({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'machine revoked' } });
        this.waiting.delete(rid);
      }
      return Response.json({ ok: true });
    }
    if (path === '/status') {
      return Response.json({ online: this.sockets().length > 0, servers: (await this.state.storage.get('servers')) || [] });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    if (m?.type === 'hello' && Array.isArray(m.servers)) {
      await this.state.storage.put('servers', m.servers.map(String).slice(0, 50));
      return;
    }
    const w = m?.rid && this.waiting.get(m.rid);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(m.rid);
    w.resolve(m.error ? { jsonrpc: '2.0', id: m.message?.id ?? null, error: { code: -32000, message: String(m.error).slice(0, 300) } } : m.message);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
  }
}
