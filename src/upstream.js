// MCP client for upstream servers (Figma, Linear, Gmail, ...): streamable HTTP,
// JSON or SSE responses, Mcp-Session-Id handling, and an OAuth 2.1 client for the
// servers that want one (discovery, dynamic registration, PKCE, refresh, RFC 9207 iss).

export const CLIENT_PROTOCOL = '2025-06-18';
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 60000;

export class UpstreamAuthError extends Error {
  constructor(message, wwwAuthenticate = null) {
    super(message);
    this.name = 'UpstreamAuthError';
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)\.?$/i;
// Wildcard-DNS services that resolve an embedded IP (127.0.0.1.nip.io -> 127.0.0.1).
const IP_ECHO_DNS = /(^|\.)(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|vcap\.me|lacolhost\.com)\.?$/i;

function privateV4(a, b) {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Eight 16-bit groups of an IPv6 literal (with an optional embedded dotted IPv4), or null. */
function ipv6Groups(h) {
  let s = h;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (x) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function privateIp(host) {
  const h = host.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return privateV4(a, b);
  }
  if (!h.includes(':')) return false;
  const g = ipv6Groups(h);
  if (!g) return true;
  if (g.slice(0, 4).every((x) => x === 0)) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2002) return privateV4(g[1] >> 8, g[1] & 0xff);
  return false;
}

/** An upstream URL BrainMCP may call: https, no credentials, no private or loopback host. Returns the URL or throws. */
let allowLocal = false;
/**
 * Local development only: let upstreams live on this machine (http://localhost) so a
 * fake MCP server can stand in for real apps. Set by DEV_ALLOW_LOCAL_UPSTREAMS in
 * .dev.vars; never set it on a deployed Worker.
 */
export function setUpstreamPolicy(env) {
  allowLocal = env?.DEV_ALLOW_LOCAL_UPSTREAMS === 'true';
}

export function safeUpstreamUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('url is not a valid URL'); }
  if (allowLocal && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && /^https?:$/.test(u.protocol)) { u.hash = ''; return u.toString(); }
  if (u.protocol !== 'https:') throw new Error('upstream URLs must use https');
  if (u.username || u.password) throw new Error('upstream URLs must not carry credentials');
  if (PRIVATE_HOST.test(u.hostname) || privateIp(u.hostname) || IP_ECHO_DNS.test(u.hostname)) throw new Error('upstream URL points at a private or loopback host');
  u.hash = '';
  return u.toString();
}

async function readCapped(res, max = RESPONSE_MAX_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error(`upstream response is over ${max} bytes`); }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** JSON-RPC messages inside an SSE body. */
export function sseMessages(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* keep-alive or non-JSON event */ }
  }
  return out;
}

/** Read an SSE body until the reply with `id` arrives; then stop, even if the server keeps the stream open. */
async function sseReply(res, id, max = RESPONSE_MAX_BYTES) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > max) throw new Error(`upstream response is over ${max} bytes`);
        buf += decoder.decode(value, { stream: true });
      }
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = done ? '' : blocks.pop();
      for (const m of sseMessages(blocks.join('\n\n'))) {
        if (m && m.id === id && ('result' in m || 'error' in m)) return m;
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * One JSON-RPC exchange with an upstream MCP server. Returns { message, sessionId };
 * message is null for notifications. Throws UpstreamAuthError on 401.
 */
export async function mcpPost(url, { headers = {}, sessionId = null, protocolVersion = CLIENT_PROTOCOL, message }) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
    ...headers,
  };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const newSession = res.headers.get('Mcp-Session-Id') || sessionId;
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamAuthError('upstream returned 401', res.headers.get('WWW-Authenticate'));
  }
  if (res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new Error('upstream refused the call (403): the account may lack the permission or scope for it');
  }
  if (res.status === 404 && sessionId) {
    await res.body?.cancel().catch(() => {});
    const e = new Error('upstream session expired');
    e.sessionExpired = true;
    throw e;
  }
  if (res.status === 202 || res.status === 204) {
    await res.body?.cancel().catch(() => {});
    if (message.id !== undefined) throw new Error(`upstream accepted ${message.method} (${res.status}) but sent no reply`);
    return { message: null, sessionId: newSession };
  }
  const type = res.headers.get('Content-Type') || '';
  if (res.ok && message.id !== undefined && type.includes('text/event-stream') && res.body) {
    const reply = await sseReply(res, message.id);
    if (!reply) throw new Error('upstream sent no reply to the request');
    return { message: reply, sessionId: newSession };
  }
  const text = await readCapped(res);
  if (!res.ok) throw new Error(`upstream returned ${res.status}: ${text.slice(0, 200)}`);
  if (message.id === undefined) return { message: null, sessionId: newSession };
  let parsed;
  try { parsed = type.includes('text/event-stream') ? sseMessages(text) : [JSON.parse(text)].flat(); } catch { throw new Error(`upstream sent a reply that is not JSON (HTTP ${res.status})`); }
  const reply = parsed.find((m) => m && m.id === message.id && ('result' in m || 'error' in m));
  if (!reply) throw new Error('upstream sent no reply to the request');
  return { message: reply, sessionId: newSession };
}

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];

let nextId = 1;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });

/** A logical session with one upstream server. `send(message)` handles transport and returns the reply. */
export class UpstreamSession {
  constructor(transport) {
    this.transport = transport;
    this.ready = false;
    this.starting = null;
  }

  async start() {
    if (this.ready) return;
    if (!this.starting) this.starting = this.initialize().finally(() => { this.starting = null; });
    await this.starting;
  }

  async request(method, params) {
    await this.start();
    try {
      return await this.exchange(rpc(method, params));
    } catch (e) {
      if (!e.sessionExpired) throw e;
      this.ready = false;
      this.transport.sessionId = null;
      await this.start();
      return this.exchange(rpc(method, params));
    }
  }

  async exchange(message) {
    const reply = await this.transport.send(message);
    if (reply?.error) throw new Error(`upstream error ${reply.error.code}: ${String(reply.error.message).slice(0, 300)}`);
    return reply?.result;
  }

  async initialize() {
    const result = await this.exchange(rpc('initialize', {
      protocolVersion: CLIENT_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'brainmcp-gateway', version: '1.0.0' },
    }));
    if (!result || typeof result.protocolVersion !== 'string') throw new Error('upstream answered initialize without a protocol version');
    if (!SUPPORTED_PROTOCOLS.includes(result.protocolVersion)) throw new Error(`upstream speaks MCP ${result.protocolVersion}, which BrainMCP does not support`);
    this.transport.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo || null;
    this.instructions = result.instructions || null;
    try {
      await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (e) {
      if (e instanceof UpstreamAuthError) throw e;
    }
    this.ready = true;
  }

  async listTools() {
    const tools = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : undefined);
      if (!Array.isArray(r?.tools)) throw new Error('upstream answered tools/list without a tools array');
      tools.push(...r.tools);
      cursor = r.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return tools;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} });
  }
}

/** Streamable-HTTP transport bound to one URL and a header provider. */
export function httpTransport(url, headers) {
  const t = {
    sessionId: null,
    async send(message) {
      const r = await mcpPost(url, { headers: await headers(), sessionId: t.sessionId, protocolVersion: t.protocolVersion || CLIENT_PROTOCOL, message });
      t.sessionId = r.sessionId;
      return r.message;
    },
  };
  return t;
}

// ------------------------------------------------------------------ OAuth client

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

async function getJson(url) {
  const res = await fetch(safeUpstreamUrl(url), { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
  try { return JSON.parse(await readCapped(res, 256 * 1024)); } catch { return null; }
}

function resourceMetadataFromHeader(h) {
  const m = /resource_metadata="([^"]+)"/i.exec(h || '');
  return m ? m[1] : null;
}

/**
 * Find the authorization server for an MCP URL: protected-resource metadata (RFC 9728),
 * then authorization-server metadata (RFC 8414, with OIDC discovery as a fallback).
 */
export async function discoverOauth(mcpUrl, wwwAuthenticate = null) {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, '');
  const prmCandidates = [resourceMetadataFromHeader(wwwAuthenticate),
    `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let prm = null;
  for (const c of prmCandidates) if ((prm = await getJson(c))) break;
  const issuer = prm?.authorization_servers?.[0] || u.origin;
  const iu = new URL(issuer);
  const ipath = iu.pathname.replace(/\/$/, '');
  const asCandidates = [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`];
  let as = null;
  for (const c of asCandidates) if ((as = await getJson(c))) break;
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error('the upstream server publishes no OAuth authorization server metadata');
  safeUpstreamUrl(as.authorization_endpoint);
  safeUpstreamUrl(as.token_endpoint);
  return { resource: prm?.resource || mcpUrl, issuer: as.issuer || issuer, as };
}

/** Register BrainMCP as a client (RFC 7591) unless a static client was supplied. */
export async function registerClient(as, redirectUri, staticClient = null) {
  if (staticClient?.client_id) return { client_id: staticClient.client_id, client_secret: staticClient.client_secret || null };
  if (!as.registration_endpoint) throw new Error('the upstream server does not allow dynamic registration; supply a client_id');
  const res = await fetch(safeUpstreamUrl(as.registration_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    redirect: 'manual',
    body: JSON.stringify({
      client_name: 'BrainMCP gateway',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await readCapped(res, 64 * 1024);
  if (!res.ok) throw new Error(`client registration failed (${res.status}): ${body.slice(0, 200)}`);
  const j = JSON.parse(body);
  if (!j.client_id) throw new Error('client registration returned no client_id');
  return { client_id: j.client_id, client_secret: j.client_secret || null };
}

export function authorizeUrl({ as, client, redirectUri, state, challenge, scope, resource }) {
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (resource) u.searchParams.set('resource', resource);
  const s = scope || (as.scopes_supported?.includes('offline_access') ? 'offline_access' : '');
  if (s) u.searchParams.set('scope', s);
  return u.toString();
}

async function tokenRequest(as, client, params) {
  const form = new URLSearchParams(params);
  form.set('client_id', client.client_id);
  if (client.client_secret) form.set('client_secret', client.client_secret);
  const res = await fetch(safeUpstreamUrl(as.token_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    redirect: 'manual',
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await readCapped(res, 64 * 1024);
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!res.ok || !j?.access_token) {
    const e = new Error(`token request failed (${res.status}): ${j?.error || text.slice(0, 120)}`);
    e.invalidGrant = j?.error === 'invalid_grant';
    throw e;
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || params.refresh_token || null,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null,
    scope: j.scope || null,
  };
}

export const exchangeCode = (as, client, { code, verifier, redirectUri, resource }) =>
  tokenRequest(as, client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, ...(resource ? { resource } : {}) });

export const refreshTokens = (as, client, { refresh_token, resource }) =>
  tokenRequest(as, client, { grant_type: 'refresh_token', refresh_token, ...(resource ? { resource } : {}) });
