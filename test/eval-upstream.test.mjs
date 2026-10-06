// Robustness evaluation: BrainMCP's upstream MCP client (src/upstream.js) and the
// gateway call path (src/gateway.js, src/gateway-tools.js) against misbehaving
// upstream MCP servers. Tests named "regression: ..." pin defects found in evaluation,
// now fixed; everything else documents behaviour that was already right.
//
// Run: node --import ./test/helpers/register-cf.mjs --test test/eval-upstream.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, fakeCtx, fakeDONamespace, stubFetch } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { ConnectionDO } from '../src/gateway.js';
import { createKey } from '../src/auth.js';
import { storeCredential, loadCredential } from '../src/vault.js';
import { sseMessages } from '../src/upstream.js';

const O = 'https://brain.test';
const VAULT_KEK = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'svc-pat-SECRET-0123456789';
const HOST = 'up.test';
const UP = `https://${HOST}/mcp`;

// ---------------------------------------------------------------- harness (copied from gateway.test.mjs)

let net = stubFetch();

function setup(routes = {}) {
  const env = fakeEnv({ VAULT_KEK });
  env.CONNECTIONS = fakeDONamespace(ConnectionDO, () => env);
  const gh = fakeGitHub(env, {});
  net.restore();
  net = stubFetch(async (req, rec) => {
    const host = new URL(req.url).host;
    if (routes[host]) return routes[host](req, rec);
    if (host === 'api.github.com') return gh.handler(req, rec);
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  return env;
}

const http = async (env, method, path, { token, cookie, body, headers = {} } = {}) => {
  const ctx = fakeCtx();
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(O + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
};

async function rpc(env, token, method, params) {
  const res = await http(env, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method, params } });
  return (await res.json()).result;
}
async function tool(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  try { return JSON.parse(r.content[0].text); } catch { return r; }
}
const rawTool = (env, token, name, args = {}) => rpc(env, token, 'tools/call', { name, arguments: args });

async function superUser(env) {
  await tool(env, env.BRAIN_TOKEN, 'whoami');
  return env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
}
async function login(env, key) {
  const form = new FormData();
  form.set('access_key', key);
  const res = await worker.fetch(new Request(`${O}/app/login`, { method: 'POST', body: form }), env, fakeCtx());
  return res.headers.get('Set-Cookie').split(';')[0];
}
async function consoleHttp(env, cookie, name, args = {}) {
  return http(env, 'POST', '/app/api/tool', { cookie, body: { name, args }, headers: { Origin: O } });
}
const consoleTool = async (env, cookie, name, args = {}) => (await consoleHttp(env, cookie, name, args)).json();

async function bootstrap(routes) {
  const env = setup(routes);
  const uid = await superUser(env);
  const admin = await createKey(env, { name: 'console', role: 'admin', user_id: uid });
  const cookie = await login(env, admin.key);
  const agent = await createKey(env, { name: 'codex', role: 'write', user_id: uid });
  return { env, uid, cookie, agent: agent.key, agentId: agent.id };
}

const allText = (env) => JSON.stringify([
  env.DB.sqlite.prepare('SELECT * FROM audit_events').all(),
  env.DB.sqlite.prepare('SELECT * FROM connections').all(),
  env.DB.sqlite.prepare('SELECT * FROM approvals').all(),
]);

// ---------------------------------------------------------------- misbehaving upstream

const READ_TOOL = { name: 'get_thing', description: 'Get a thing', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } };

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const sseResponse = (text, { status = 200, headers = {} } = {}) => new Response(text, { status, headers: { 'Content-Type': 'text/event-stream', ...headers } });
const ev = (obj, eol = '\n') => `event: message${eol}data: ${JSON.stringify(obj)}${eol}${eol}`;
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const textResult = (t) => ({ content: [{ type: 'text', text: t }] });

/**
 * A scriptable MCP server. Hooks: route(req) for non-/mcp paths, auth(headers),
 * before(msg) to override anything, init(msg), notify(msg), list(msg), call(msg).
 * Each hook returns a Response or undefined (fall through to the well-behaved default).
 */
function server(opts = {}) {
  const s = { tools: (opts.tools || [READ_TOOL]).map((t) => ({ ...t })), sessions: 0, log: [], streams: [] };
  s.count = (method) => s.log.filter((l) => l.method === method).length;
  s.handler = async (req, rec) => {
    const u = new URL(req.url);
    if (opts.route) { const r = await opts.route(req, rec, s); if (r) return r; }
    if (u.pathname !== '/mcp') return new Response('nope', { status: 404 });
    const msg = JSON.parse(rec.body);
    s.log.push({ method: msg.method, id: msg.id, headers: rec.headers });
    const authOk = opts.auth ? opts.auth(rec.headers, s) : rec.headers.authorization === `Bearer ${SECRET}`;
    if (!authOk) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    if (opts.before) { const r = await opts.before(msg, rec, s); if (r) return r; }
    if (msg.method === 'initialize') {
      if (opts.init) { const r = await opts.init(msg, rec, s); if (r) return r; }
      s.sessions++;
      return json(ok(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'evil' } }), { headers: { 'Mcp-Session-Id': `s${s.sessions}` } });
    }
    if (msg.id === undefined) {
      if (opts.notify) { const r = await opts.notify(msg, rec, s); if (r) return r; }
      return new Response(null, { status: 202 });
    }
    if (msg.method === 'tools/list') {
      if (opts.list) { const r = await opts.list(msg, rec, s); if (r) return r; }
      return json(ok(msg.id, { tools: s.tools }));
    }
    if (msg.method === 'tools/call') {
      if (opts.call) { const r = await opts.call(msg, rec, s); if (r) return r; }
      return json(ok(msg.id, textResult(`ran ${msg.params.name}`)));
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  };
  return s;
}

/** Bootstrap, connect svc_x (bearer) to the server, and return call helpers. */
async function rig(s, { routes = {}, connect = true } = {}) {
  const b = await bootstrap({ [HOST]: s.handler, ...routes });
  const r = { ...b, s };
  if (!connect) return r;
  r.created = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'svc', label: 'x', url: UP, auth: 'bearer', secret: SECRET });
  r.id = r.created.id;
  r.call = async (args = {}, toolName = 'get_thing') => {
    const raw = await rawTool(b.env, b.agent, 'call_tool', { connection: 'svc_x', tool: toolName, arguments: args });
    let parsed = null;
    try { parsed = JSON.parse(raw.content[0].text); } catch { /* success: notice text */ }
    return { raw, parsed };
  };
  r.sync = () => consoleTool(b.env, b.cookie, 'gw_connection_sync', { id: r.id });
  r.row = (name) => b.env.DB.sqlite.prepare('SELECT * FROM connection_tools WHERE connection_id = ? AND name = ?').get(r.id, name);
  r.rows = () => b.env.DB.sqlite.prepare('SELECT * FROM connection_tools WHERE connection_id = ? ORDER BY name').all(r.id);
  r.conn = () => b.env.DB.sqlite.prepare('SELECT * FROM connections WHERE id = ?').get(r.id);
  r.review = (args) => consoleTool(b.env, b.cookie, 'gw_tool_review', { id: r.id, ...args });
  return r;
}

async function within(ms, p) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`hung for more than ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

const assertCallOk = (r, msg = '') => {
  assert.ok(!r.parsed?.error, `${msg} expected success, got ${JSON.stringify(r.parsed || r.raw).slice(0, 300)}`);
  assert.equal(r.raw.isError, false);
  assert.match(r.raw.content[0].text, /\[BrainMCP\]/);
};
const assertCallError = (r, re) => {
  assert.ok(r.parsed?.error, `expected an error, got ${JSON.stringify(r.raw).slice(0, 300)}`);
  assert.equal(r.raw.isError, true);
  if (re) assert.match(r.parsed.error, re);
};

// ================================================================ SSE

test('SSE: keep-alive comments, id/retry fields, several events, reply last', async () => {
  const s = server({
    call: (m) => sseResponse(`: keep-alive\n\nretry: 1000\n\nid: 1\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n: ping\n\n${ev(ok(m.id, textResult('sse-ok')))}`),
  });
  const r = await rig(s);
  const out = await r.call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'sse-ok');
});

test('SSE: data split across several data: lines is joined with newlines', async () => {
  const s = server({
    call: (m) => sseResponse(`event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":${m.id},\ndata: "result":{"content":[{"type":"text","text":"joined"}]}}\n\n`),
  });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'joined');
});

test('SSE: CRLF line endings', async () => {
  const s = server({ call: (m) => sseResponse(`: hello\r\n\r\n${ev(ok(m.id, textResult('crlf')), '\r\n')}`) });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'crlf');
});

test('SSE: progress notification and a server->client request before the result', async () => {
  const s = server({
    call: (m) => sseResponse([
      ev({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 50, total: 100 } }),
      // a server request that happens to reuse our numeric id: must not be taken as the reply
      ev({ jsonrpc: '2.0', id: m.id, method: 'roots/list' }),
      ev(ok(m.id, textResult('after-progress'))),
    ].join('')),
  });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'after-progress');
});

test('SSE: an event answering a different id is skipped', async () => {
  const s = server({ call: (m) => sseResponse(ev(ok(m.id + 1000, textResult('WRONG'))) + ev(ok(m.id, textResult('right')))) });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'right');
});

test('SSE: stream ends without the reply -> clear error, no hang', async () => {
  const s = server({ call: () => sseResponse(ev({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })) });
  const out = await within(5000, (await rig(s)).call());
  assertCallError(out, /upstream call failed: upstream sent no reply/);
});

test('SSE: event: error with non-JSON data -> clear error', async () => {
  const s = server({ call: () => sseResponse('event: error\ndata: internal boom\n\n') });
  const out = await within(5000, (await rig(s)).call());
  assertCallError(out, /no reply/);
});

test('SSE: a JSON-RPC error inside the stream is surfaced', async () => {
  const s = server({ call: (m) => sseResponse(ev({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'kaput' } })) });
  const out = await (await rig(s)).call();
  assertCallError(out, /-32603: kaput/);
});

test('regression: SSE stream that stays open after the reply (keep-alive pings) hangs the call', async () => {
  // Spec: the server SHOULD close the stream after the response, but need not. The client
  // already has its reply; readCapped() waits for EOF, so the call blocks for 60s and then fails.
  const enc = new TextEncoder();
  const s = server({
    call: (m, _rec, st) => {
      const body = new ReadableStream({
        start(c) {
          st.streams.push(c);
          c.enqueue(enc.encode(ev(ok(m.id, textResult('early')))));
          c.enqueue(enc.encode(': ping\n\n'));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const r = await rig(s);
  try {
    const out = await within(3000, r.call());
    assertCallOk(out);
    assert.equal(out.raw.content[1].text, 'early');
  } finally {
    for (const c of s.streams) try { c.close(); } catch { /* already closed */ }
  }
});

test('sseMessages unit: blank-line framing, comments, multi-line data', () => {
  const msgs = sseMessages(': c\r\n\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: x\ndata: not json\n\ndata:{"b":2}\n\n');
  assert.deepEqual(msgs, [{ a: 1 }, { b: 2 }]);
});

// ================================================================ JSON bodies

test('JSON: batch (array) reply containing a notification and the response', async () => {
  const s = server({ call: (m) => json([{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, ok(m.id, textResult('batched'))]) });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.equal(out.raw.content[1].text, 'batched');
});

test('JSON: JSON-RPC error object (-32602) -> clear error with code', async () => {
  const s = server({ call: (m) => json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params: id is required' } }) });
  const out = await (await rig(s)).call();
  assertCallError(out, /upstream error -32602: Invalid params/);
});

test('JSON: result with no content, structuredContent only, isError true', async () => {
  let mode = 'empty';
  const s = server({
    call: (m) => {
      if (mode === 'empty') return json(ok(m.id, {}));
      if (mode === 'structured') return json(ok(m.id, { structuredContent: { rows: [1, 2] } }));
      return json(ok(m.id, { content: [{ type: 'text', text: 'tool says no' }], isError: true }));
    },
  });
  const r = await rig(s);
  const empty = await r.call();
  assertCallOk(empty);
  assert.equal(empty.raw.content.length, 1, 'just the BrainMCP notice');
  mode = 'structured';
  const st = await r.call();
  assertCallOk(st);
  assert.deepEqual(st.raw.structuredContent, { rows: [1, 2] });
  mode = 'iserror';
  const ie = await r.call();
  assert.equal(ie.raw.isError, true);
  assert.equal(ie.raw.content[1].text, 'tool says no');
  const audit = r.env.DB.sqlite.prepare("SELECT outcome FROM audit_events WHERE action = 'gw.result' ORDER BY id DESC LIMIT 1").get();
  assert.equal(audit.outcome, 'error');
});

test('JSON: image, audio, resource and resource_link items pass through /mcp intact', async () => {
  const items = [
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'embedded' } },
    { type: 'resource_link', uri: 'https://x.test/doc', name: 'doc', mimeType: 'text/html' },
    { type: 'text', text: 'tail' },
  ];
  const s = server({ call: (m) => json(ok(m.id, { content: items, structuredContent: { n: 5 } })) });
  const out = await (await rig(s)).call();
  assertCallOk(out);
  assert.deepEqual(out.raw.content.slice(1), items);
  assert.deepEqual(out.raw.structuredContent, { n: 5 });
});

test('JSON: text over 100k chars is truncated with a marker; >4MB body is an error', async () => {
  let size = 150000;
  const s = server({ call: (m) => json(ok(m.id, textResult('x'.repeat(size)))) });
  const r = await rig(s);
  const big = await r.call();
  assertCallOk(big);
  assert.ok(big.raw.content[1].text.length < 100100);
  assert.match(big.raw.content[1].text, /truncated by BrainMCP/);
  size = 4.5 * 1024 * 1024;
  const huge = await within(10000, r.call());
  assertCallError(huge, /over 4194304 bytes/);
});

test('regression: content beyond 50 items is dropped without any truncation signal', async () => {
  const s = server({ call: (m) => json(ok(m.id, { content: Array.from({ length: 60 }, (_, i) => ({ type: 'text', text: `item${i}` })) })) });
  const r = await rig(s);
  const res = await consoleTool(r.env, r.cookie, 'call_tool', { connection: 'svc_x', tool: 'get_thing', arguments: {} });
  assert.equal(res.content.length, 50);
  assert.equal(res.truncated, true, 'agent is not told 10 items were dropped');
});

test('JSON: invalid JSON, an HTML error page with 200, and an empty 200 body -> errors, not crashes', async () => {
  let mode = 'invalid';
  const s = server({
    call: () => {
      if (mode === 'invalid') return json('{"jsonrpc":"2.0", "id": ');
      if (mode === 'html') return new Response('<!doctype html><h1>Bad gateway</h1>', { headers: { 'Content-Type': 'text/html' } });
      if (mode === 'empty') return new Response('', { headers: { 'Content-Type': 'application/json' } });
      return undefined;
    },
  });
  const r = await rig(s);
  for (const m of ['invalid', 'html', 'empty']) {
    mode = m;
    const out = await within(5000, r.call());
    assertCallError(out, /^upstream call failed: /);
  }
  mode = 'none';
  assertCallOk(await r.call(), 'the session still works afterwards:');
});

test('JSON: HTML error page error message names the problem (not just a SyntaxError)', async () => {
  const s = server({ call: () => new Response('<!doctype html><h1>Bad gateway</h1>', { headers: { 'Content-Type': 'text/html' } }) });
  const out = await (await rig(s)).call();
  assertCallError(out);
  // Current message is the raw JSON.parse SyntaxError ("Unexpected token '<' ..."). Accept it, but record.
  assert.match(out.parsed.error, /JSON|token|non-JSON|text\/html/i);
});

// ================================================================ HTTP status handling

test('regression: 202 Accepted to a tools/call request is reported as a successful empty result', async () => {
  const s = server({ call: () => new Response(null, { status: 202 }) });
  const out = await (await rig(s)).call();
  assertCallError(out, /no reply|202|no response/i);
});

test('regression: 202 Accepted to initialize is accepted as a ready session (no negotiated version)', async () => {
  let wrong = false;
  const s = server({ init: () => (wrong ? new Response(null, { status: 202 }) : undefined) });
  const r = await rig(s);
  wrong = true;
  r.env.CONNECTIONS.instances.clear();
  const out = await r.call();
  assertCallError(out, /initiali[sz]e/i);
});

test('404 with a session: re-initialize once and succeed', async () => {
  let forgetBefore = 0;
  const s = server({ before: (m, rec, st) => (m.method !== 'initialize' && rec.headers['mcp-session-id'] && Number(rec.headers['mcp-session-id'].slice(1)) <= forgetBefore ? new Response('gone', { status: 404 }) : undefined) });
  const r = await rig(s);
  const inits = s.count('initialize');
  forgetBefore = s.sessions;
  const out = await r.call();
  assertCallOk(out);
  assert.equal(s.count('initialize'), inits + 1);
  assert.equal(s.log.at(-1).headers['mcp-session-id'], `s${s.sessions}`);
});

test('404 with a session forever: bounded retries, clear error, no loop', async () => {
  let broken = false;
  const s = server({ before: (m, rec) => (broken && rec.headers['mcp-session-id'] ? new Response('gone', { status: 404 }) : undefined) });
  const r = await rig(s);
  broken = true;
  const before = s.log.length;
  const out = await within(5000, r.call());
  assertCallError(out, /session expired/);
  assert.ok(s.log.length - before <= 6, `made ${s.log.length - before} requests`);
});

test('404 without a session -> clear error', async () => {
  let broken = false;
  const s = server({ init: () => (broken ? new Response('no such endpoint', { status: 404 }) : undefined) });
  const r = await rig(s);
  broken = true;
  r.env.CONNECTIONS.instances.clear();
  const out = await r.call();
  assertCallError(out, /upstream returned 404/);
});

test('401 on a call with a bearer secret -> auth_required + connect_url, secret never echoed', async () => {
  let revoked = false;
  const s = server({ auth: (h) => !revoked && h.authorization === `Bearer ${SECRET}` });
  const r = await rig(s);
  revoked = true;
  const out = await r.call();
  assertCallError(out, /rejected the stored credential/);
  assert.equal(out.parsed.connect_url, `${O}/#connections`);
  assert.equal(r.conn().status, 'auth_required');
  const again = await r.call();
  assertCallError(again, /auth_required/);
  assert.equal(again.parsed.connect_url, `${O}/#connections`);
  const lc = await tool(r.env, r.agent, 'list_connections');
  assert.equal(lc.connections[0].connect_url, `${O}/#connections`);
  assert.ok(!allText(r.env).includes(SECRET) && !JSON.stringify([out, again, lc]).includes(SECRET));
});

test('403 on one call is a tool error; the connection stays active (only 401 means the credential is bad)', async () => {
  let forbidden = false;
  const s = server({ call: () => (forbidden ? new Response('insufficient_scope', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } }) : undefined) });
  const r = await rig(s);
  forbidden = true;
  const out = await r.call();
  assertCallError(out);
  assert.equal(r.conn().status, 'active');
});

test('500/502/503 -> clear error including the status; session stays usable', async () => {
  let status = 500;
  const s = server({ call: () => (status ? new Response(`err ${status}`, { status }) : undefined) });
  const r = await rig(s);
  for (const st of [500, 502, 503]) {
    status = st;
    const out = await r.call();
    assertCallError(out, new RegExp(`upstream returned ${st}`));
  }
  status = 0;
  assertCallOk(await r.call());
  assert.equal(r.conn().status, 'active');
});

test('regression: an upstream error body that echoes the credential leaks it to the agent, audit log and last_error', async () => {
  // Some servers echo the offending header in 4xx/5xx bodies or JSON-RPC errors.
  let echo = false;
  const s = server({
    call: () => (echo ? new Response(`bad header Authorization: Bearer ${SECRET}`, { status: 500 }) : undefined),
    list: (m) => (echo ? json({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `token ${SECRET} invalid` } }) : undefined),
  });
  const r = await rig(s);
  echo = true;
  const out = await r.call();
  assertCallError(out);
  await r.sync();
  assert.ok(!JSON.stringify(out).includes(SECRET), 'secret reached the agent');
  assert.ok(!allText(r.env).includes(SECRET), 'secret stored in audit/last_error');
});

test('3xx redirects are not followed', async () => {
  let redirect = false;
  const s = server({ call: () => (redirect ? new Response(null, { status: 307, headers: { Location: 'https://evil.test/steal' } }) : undefined) });
  const r = await rig(s, { routes: { 'evil.test': () => json({ stolen: true }) } });
  redirect = true;
  const out = await r.call();
  assertCallError(out, /upstream returned 307/);
  assert.ok(!net.calls.some((c) => c.url.startsWith('https://evil.test')), 'redirect followed');
});

test('timeout (AbortSignal TimeoutError) and network errors -> clear error, connection stays active', async () => {
  let mode = null;
  const s = server({
    call: () => {
      if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (mode === 'net') throw new TypeError('fetch failed');
      return undefined;
    },
  });
  const r = await rig(s);
  mode = 'timeout';
  assertCallError(await r.call(), /timeout/);
  mode = 'net';
  assertCallError(await r.call(), /fetch failed/);
  mode = null;
  assertCallOk(await r.call());
  assert.equal(r.conn().status, 'active');
  const audit = r.env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'gw.result' AND outcome = 'error'").get();
  assert.equal(audit.n, 2);
});

test('the fetch to the upstream carries a timeout signal and redirect: manual', async () => {
  const s = server();
  await rig(s);
  // stubFetch records headers/body only; check the source contract instead via a wrapped fetch
  const seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init) => { seen.push(init); return inner(input, init); };
  try {
    const { mcpPost } = await import('../src/upstream.js');
    await mcpPost(UP, { headers: { Authorization: `Bearer ${SECRET}` }, message: { jsonrpc: '2.0', id: 77, method: 'initialize', params: {} } });
  } finally {
    globalThis.fetch = inner;
  }
  assert.equal(seen[0].redirect, 'manual');
  assert.ok(seen[0].signal instanceof AbortSignal);
});

// ================================================================ sessions & protocol

test('sessions: a server that requires Mcp-Session-Id on every request', async () => {
  const s = server({ before: (m, rec, st) => (m.method !== 'initialize' && rec.headers['mcp-session-id'] !== `s${st.sessions}` ? new Response('missing session', { status: 400 }) : undefined) });
  const r = await rig(s);
  assert.equal(r.created.synced?.tools, 1, JSON.stringify(r.created));
  assertCallOk(await r.call());
});

test('sessions: a server that issues a new session id on every response', async () => {
  let current = null;
  let n = 0;
  const s = server({
    before: (m, rec) => {
      if (m.method === 'initialize') return undefined;
      if (rec.headers['mcp-session-id'] !== current) return new Response('stale session', { status: 400 });
      current = `rot${++n}`;
      if (m.id === undefined) return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': current } });
      if (m.method === 'tools/list') return json(ok(m.id, { tools: [READ_TOOL] }), { headers: { 'Mcp-Session-Id': current } });
      return json(ok(m.id, textResult('rotated')), { headers: { 'Mcp-Session-Id': current } });
    },
    init: (m) => { current = 'rot0'; return json(ok(m.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'r' } }), { headers: { 'Mcp-Session-Id': current } }); },
  });
  const r = await rig(s);
  assert.equal(r.created.synced?.tools, 1, JSON.stringify(r.created));
  assertCallOk(await r.call());
  assertCallOk(await r.call());
});

test('sessions: a server that ignores notifications/initialized (200 empty / 200 text)', async () => {
  for (const reply of [() => new Response('', { status: 200 }), () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }), () => new Response(null, { status: 204 })]) {
    const s = server({ notify: reply });
    const r = await rig(s);
    assert.equal(r.created.synced?.tools, 1, JSON.stringify(r.created));
    assertCallOk(await r.call());
  }
});

test('regression: a server that rejects notifications/initialized with 400 breaks every call', async () => {
  // No reply is expected to a notification; failing the whole session on it is brittle.
  const s = server({ notify: () => new Response('unknown notification', { status: 400 }) });
  const r = await rig(s);
  assert.equal(r.created.synced?.tools, 1, JSON.stringify(r.created));
});

test('regression: client keeps sending MCP-Protocol-Version 2025-06-18 after the server negotiated 2025-03-26', async () => {
  // 2025-06-18 transport: the client MUST send the negotiated version on later requests;
  // a server that only speaks 2025-03-26 and validates the header answers 400.
  const s = server({
    init: (m) => { return json(ok(m.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'old' } }), { headers: { 'Mcp-Session-Id': 'old1' } }); },
    before: (m, rec) => {
      if (m.method === 'initialize') return undefined;
      const v = rec.headers['mcp-protocol-version'];
      if (v && v !== '2025-03-26') return new Response(`Unsupported protocol version ${v}`, { status: 400 });
      return undefined;
    },
  });
  const r = await rig(s);
  assert.equal(r.created.synced?.tools, 1, JSON.stringify(r.created));
});

// ================================================================ tools/list

test('tools/list: pagination across pages', async () => {
  const pages = [[{ ...READ_TOOL, name: 'get_a' }], [{ ...READ_TOOL, name: 'get_b' }], [{ ...READ_TOOL, name: 'get_c' }]];
  const s = server({ list: (m) => { const i = Number(m.params?.cursor || 0); return json(ok(m.id, { tools: pages[i], ...(i < 2 ? { nextCursor: String(i + 1) } : {}) })); } });
  const r = await rig(s);
  assert.equal(r.created.synced.tools, 3);
  assert.deepEqual(r.rows().map((t) => t.name), ['get_a', 'get_b', 'get_c']);
});

test('tools/list: a cursor loop that never ends is bounded at 20 pages', async () => {
  const s = server({ list: (m) => json(ok(m.id, { tools: [{ ...READ_TOOL, name: `get_p${Number(m.params?.cursor || 0)}` }], nextCursor: String(Number(m.params?.cursor || 0) + 1) })) });
  const r = await within(10000, rig(s));
  assert.equal(s.count('tools/list'), 20);
  assert.equal(r.created.synced.tools, 20);
});

test('tools/list: the same cursor repeated forever is bounded too', async () => {
  const s = server({ list: (m) => json(ok(m.id, { tools: [READ_TOOL], nextCursor: 'same' })) });
  const r = await within(10000, rig(s));
  assert.ok(s.count('tools/list') <= 20);
  assert.equal(r.created.synced.tools, 1);
});

test('regression: duplicate tool names produce duplicate search_tools results', async () => {
  const s = server({ tools: [READ_TOOL, { ...READ_TOOL, description: 'Get a thing (dup)' }] });
  const r = await rig(s);
  assert.equal(r.rows().length, 1);
  const found = await tool(r.env, r.agent, 'search_tools', { query: 'thing' });
  assert.equal(found.results.filter((x) => x.tool === 'get_thing').length, 1, JSON.stringify(found.results));
});

test('tools/list: odd names (dots, slashes, unicode, too long, non-string) are kept or skipped, never crash', async () => {
  const tools = [
    { ...READ_TOOL, name: 'repo.get_file' },
    { ...READ_TOOL, name: 'files/get' },
    { ...READ_TOOL, name: 'get_ünicode' },
    { ...READ_TOOL, name: `get_${'x'.repeat(200)}` },
    { ...READ_TOOL, name: 42 },
    { ...READ_TOOL, name: '' },
    null,
    'get_string',
    { ...READ_TOOL, name: 'get_ok' },
  ];
  const s = server({ tools });
  const r = await rig(s);
  assert.deepEqual(r.rows().map((t) => t.name).sort(), ['files/get', 'get_ok', 'repo.get_file']);
  const d = await tool(r.env, r.agent, 'describe_tools', { tools: ['svc_x.repo.get_file', 'svc_x.files/get'] });
  assert.ok(d.tools.every((t) => !t.error), JSON.stringify(d));
  assertCallOk(await r.call({}, 'repo.get_file'));
  // direct (pinned) tools only expose client-safe names
  const pinned = await createKey(r.env, { name: 'pin', role: 'write', user_id: r.uid, pinned: ['svc_x'] });
  const names = (await rpc(r.env, pinned.key, 'tools/list')).tools.map((t) => t.name);
  assert.ok(names.includes('svc_x__get_ok'));
  assert.ok(!names.some((n) => /[./]/.test(n)), names.join(','));
});

test('tools/list: missing inputSchema defaults to an object schema; long descriptions are capped', async () => {
  const s = server({ tools: [{ name: 'get_noschema', description: 'd'.repeat(9000), annotations: { readOnlyHint: true } }] });
  const r = await rig(s);
  const row = r.row('get_noschema');
  assert.deepEqual(JSON.parse(row.input_schema), { type: 'object' });
  assert.equal(row.description.length, 4000);
});

test('regression: a non-object inputSchema / annotations reach pinned clients unvalidated', async () => {
  const s = server({ tools: [
    { name: 'get_bad', description: 'x', inputSchema: 'not a schema', annotations: { readOnlyHint: true } },
    { name: 'get_arr', description: 'x', inputSchema: [1, 2], annotations: { readOnlyHint: true } },
    { name: 'get_ann', description: 'x', inputSchema: { type: 'object' }, annotations: 'readonly please' },
  ] });
  const r = await rig(s);
  const pinned = await createKey(r.env, { name: 'pin', role: 'write', user_id: r.uid, pinned: ['svc_x'] });
  const defs = (await rpc(r.env, pinned.key, 'tools/list')).tools.filter((t) => t.name.startsWith('svc_x__'));
  const problems = [];
  for (const d of defs) {
    if (!(d.inputSchema && typeof d.inputSchema === 'object' && !Array.isArray(d.inputSchema) && d.inputSchema.type === 'object')) problems.push(`${d.name} inputSchema ${JSON.stringify(d.inputSchema)}`);
    if ('annotations' in d && !(d.annotations && typeof d.annotations === 'object' && !Array.isArray(d.annotations))) problems.push(`${d.name} annotations ${JSON.stringify(d.annotations)}`);
  }
  // describe_tools has the same gap
  const desc = await tool(r.env, r.agent, 'describe_tools', { tools: ['svc_x.get_bad', 'svc_x.get_arr'] });
  for (const t of desc.tools) if (!t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) problems.push(`describe ${t.tool} inputSchema ${JSON.stringify(t.inputSchema)}`);
  assert.deepEqual(problems, []);
});

test('tools/list: annotations of the wrong type never upgrade a tool to read', async () => {
  const s = server({ tools: [
    { name: 'post_thing', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'true' } },
    { name: 'make_thing', inputSchema: { type: 'object' }, annotations: 7 },
    { name: 'wipe_all', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 1, destructiveHint: 'yes' } },
  ] });
  const r = await rig(s);
  assert.equal(r.row('post_thing').risk, 'critical', 'a string readOnlyHint is ignored; post_* is a send');
  assert.equal(r.row('make_thing').risk, 'write');
  assert.equal(r.row('wipe_all').risk, 'destructive');
});

test('tools/list: more than 500 tools are capped at 500 without error', async () => {
  const many = Array.from({ length: 650 }, (_, i) => ({ name: `get_t${String(i).padStart(3, '0')}`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
  const s = server({ tools: many });
  const r = await within(30000, rig(s));
  assert.equal(r.created.synced.tools, 500);
  assert.equal(r.rows().length, 500);
});

test('tools/list: a non-array tools field or a missing result -> no crash', async () => {
  let mode = 'object';
  const s = server({ list: (m) => (mode === 'object' ? json(ok(m.id, { tools: { a: 1 } })) : undefined) });
  const r = await rig(s);
  assert.ok(r.created.ok);
  mode = 'ok';
  const synced = await r.sync();
  assert.equal(synced.synced?.tools, 1, JSON.stringify(synced));
});

// ================================================================ sync semantics

test('sync: removed then re-added with the same definition comes back approved; changed comes back "changed"', async () => {
  const s = server({ tools: [READ_TOOL, { ...READ_TOOL, name: 'get_other' }] });
  const r = await rig(s);
  s.tools = [READ_TOOL];
  const a = await r.sync();
  assert.deepEqual(a.synced.removed, ['get_other']);
  assert.equal(r.row('get_other').state, 'removed');
  assertCallError(await r.call({}, 'get_other'), /no tool get_other/);
  s.tools = [READ_TOOL, { ...READ_TOOL, name: 'get_other' }];
  await r.sync();
  assert.equal(r.row('get_other').state, 'approved');
  s.tools = [READ_TOOL];
  await r.sync();
  s.tools = [READ_TOOL, { ...READ_TOOL, name: 'get_other', description: 'now different' }];
  await r.sync();
  assert.equal(r.row('get_other').state, 'changed');
});

test('sync: a renamed tool is removed + pending (not auto-approved)', async () => {
  const s = server();
  const r = await rig(s);
  s.tools = [{ ...READ_TOOL, name: 'get_thing_v2' }];
  const out = await r.sync();
  assert.deepEqual(out.synced.removed, ['get_thing']);
  assert.deepEqual(out.synced.added, ['get_thing_v2']);
  assert.equal(r.row('get_thing_v2').state, 'pending');
  assertCallError(await r.call({}, 'get_thing_v2'), /waiting for review/);
});

test('sync: a hidden tool that changes stays hidden', async () => {
  const s = server();
  const r = await rig(s);
  await r.review({ tools: ['get_thing'], action: 'hide' });
  s.tools = [{ ...READ_TOOL, description: 'changed while hidden' }];
  await r.sync();
  assert.equal(r.row('get_thing').state, 'hidden');
  assertCallError(await r.call(), /hidden/);
});

test('regression: a hidden tool resurfaces as approved after one sync where it was missing (e.g. an empty or 202 tools/list)', async () => {
  let empty = false;
  const s = server({ list: (m) => (empty ? json(ok(m.id, {})) : undefined) });
  const r = await rig(s);
  await r.review({ tools: ['get_thing'], action: 'hide' });
  empty = true;
  await r.sync(); // a transient bad page marks everything removed
  empty = false;
  await r.sync();
  assert.equal(r.row('get_thing').state, 'hidden', `state is ${r.row('get_thing').state}`);
});

test('regression: a tools/list answered with 202 (no result) is treated as "server has zero tools"', async () => {
  let accept = false;
  const s = server({ list: () => (accept ? new Response(null, { status: 202 }) : undefined) });
  const r = await rig(s);
  accept = true;
  const out = await r.sync();
  assert.ok(out.error, `sync should fail, got ${JSON.stringify(out)}`);
  assert.equal(r.row('get_thing').state, 'approved');
});

test('sync: risk_override and egress override survive later syncs', async () => {
  const s = server({ tools: [READ_TOOL, { name: 'post_note', inputSchema: { type: 'object' } }] });
  const r = await rig(s);
  await r.review({ tools: ['get_thing'], action: 'set', risk: 'write', egress: true });
  await r.review({ tools: ['post_note'], action: 'set', egress: false });
  s.tools = [{ ...READ_TOOL, description: 'v2' }, { name: 'post_note', description: 'v2', inputSchema: { type: 'object' } }];
  await r.sync();
  await r.sync();
  assert.equal(r.row('get_thing').risk_override, 'write');
  assert.equal(r.row('get_thing').egress, 1);
  assert.equal(r.row('post_note').egress, 0);
});

test('sync: derived egress follows a risk change when there is no override (read -> write)', async () => {
  const s2 = server({ tools: [{ name: 'note_thing', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
  const r2 = await rig(s2);
  assert.equal(r2.row('note_thing').egress, 0);
  s2.tools = [{ name: 'note_thing', inputSchema: { type: 'object' } }];
  await r2.sync();
  await r2.review({ tools: ['note_thing'], action: 'approve' });
  assert.equal(r2.row('note_thing').risk, 'write');
  assert.equal(r2.row('note_thing').egress, 1, 'a tool that became a writer must count as egress');
});

test('sync: an approved tool whose annotations change is "changed" and blocked until re-approved', async () => {
  const s = server();
  const r = await rig(s);
  s.tools = [{ ...READ_TOOL, annotations: { readOnlyHint: true, openWorldHint: true } }];
  const out = await r.sync();
  assert.deepEqual(out.synced.changed, ['get_thing']);
  assert.equal(r.row('get_thing').state, 'changed');
  assertCallError(await r.call(), /waiting for review/);
  await r.review({ tools: ['get_thing'], action: 'approve' });
  assertCallOk(await r.call());
});

// ================================================================ OAuth refresh

async function oauthRig({ tokenReply, accept }) {
  const st = { refreshes: [], issued: 0, valid: new Set(['at-0']) };
  const authServer = async (req, rec) => {
    const u = new URL(req.url);
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json({ issuer: 'https://auth.up.test', authorization_endpoint: 'https://auth.up.test/authorize', token_endpoint: 'https://auth.up.test/token', registration_endpoint: 'https://auth.up.test/register' });
    }
    if (u.pathname === '/register') return json({ client_id: 'brain-client' }, { status: 201 });
    if (u.pathname === '/token') {
      const f = new URLSearchParams(rec.body);
      st.refreshes.push(f.get('refresh_token'));
      await new Promise((res) => setTimeout(res, 30));
      if (tokenReply) { const r = await tokenReply(f, st); if (r) return r; }
      const n = ++st.issued;
      st.valid.add(`at-${n}`);
      return json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
    }
    return new Response('no', { status: 404 });
  };
  const s = server({
    auth: (h) => (accept || ((t) => st.valid.has(t)))((h.authorization || '').replace('Bearer ', ''), st),
    route: (req) => (new URL(req.url).pathname.startsWith('/.well-known/oauth-protected-resource')
      ? json({ resource: UP, authorization_servers: ['https://auth.up.test'] }) : undefined),
  });
  const r = await rig(s, { routes: { 'auth.up.test': authServer }, connect: false });
  const c = await consoleTool(r.env, r.cookie, 'gw_connection_create', { service: 'svc', label: 'x', url: UP, auth: 'oauth' });
  assert.ok(c.authorize_url, JSON.stringify(c));
  r.id = c.id;
  r.st = st;
  await storeCredential(r.env, c.id, { access_token: 'at-0', refresh_token: 'rt-0', expires_at: Date.now() + 3600e3, client_id: 'brain-client' });
  r.env.DB.sqlite.prepare("UPDATE connections SET status = 'active' WHERE id = ?").run(c.id);
  const synced = await consoleTool(r.env, r.cookie, 'gw_connection_sync', { id: c.id });
  assert.equal(synced.synced?.tools, 1, JSON.stringify(synced));
  r.call = async () => {
    const raw = await rawTool(r.env, r.agent, 'call_tool', { connection: 'svc_x', tool: 'get_thing', arguments: {} });
    let parsed = null;
    try { parsed = JSON.parse(raw.content[0].text); } catch { /* ok */ }
    return { raw, parsed };
  };
  r.conn = () => r.env.DB.sqlite.prepare('SELECT * FROM connections WHERE id = ?').get(c.id);
  /** Store an expired credential and drop the warm DO, as after a cold start. */
  r.expire = async (refresh = 'rt-0') => {
    const cur = await loadCredential(r.env, c.id);
    await storeCredential(r.env, c.id, { ...cur, refresh_token: refresh ?? cur.refresh_token, expires_at: Date.now() - 1000 });
    r.env.CONNECTIONS.instances.clear();
  };
  return r;
}

test('OAuth: expired token -> one refresh, call succeeds, rotated refresh token stored and used next', async () => {
  const r = await oauthRig({});
  await r.expire('rt-0');
  assertCallOk(await r.call());
  assert.deepEqual(r.st.refreshes, ['rt-0']);
  const cred = await loadCredential(r.env, r.id);
  assert.equal(cred.refresh_token, 'rt-1');
  assert.equal(cred.access_token, 'at-1');
  await r.expire(null);
  assertCallOk(await r.call());
  assert.deepEqual(r.st.refreshes, ['rt-0', 'rt-1'], 'the rotated refresh token is used for the next refresh');
  assert.ok(!allText(r.env).includes('rt-1') && !allText(r.env).includes('at-1'));
});

test('OAuth: refresh without rotation keeps the old refresh token', async () => {
  const r = await oauthRig({ tokenReply: (f, st) => { st.valid.add('at-x'); return json({ access_token: 'at-x', expires_in: 3600 }); } });
  await r.expire('rt-0');
  assertCallOk(await r.call());
  assert.equal((await loadCredential(r.env, r.id)).refresh_token, 'rt-0');
});

test('OAuth: invalid_grant -> auth_required, connect_url, clear message', async () => {
  const r = await oauthRig({ tokenReply: () => json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 }) });
  await r.expire('rt-0');
  const out = await r.call();
  assertCallError(out, /reconnect/);
  assert.equal(out.parsed.connect_url, `${O}/#connections`);
  assert.equal(r.conn().status, 'auth_required');
  const again = await r.call();
  assertCallError(again, /auth_required/);
});

test('regression: invalid_grant makes a second (forced) refresh request with the rejected refresh token', async () => {
  const r = await oauthRig({ tokenReply: () => json({ error: 'invalid_grant' }, { status: 400 }) });
  await r.expire('rt-0');
  await r.call();
  assert.equal(r.st.refreshes.length, 1, `refresh requests: ${JSON.stringify(r.st.refreshes)}`);
});

test('OAuth: two parallel calls with an expired token through one ConnectionDO -> exactly one refresh', async () => {
  const r = await oauthRig({});
  await r.expire('rt-0');
  const [a, b] = await within(5000, Promise.all([r.call(), r.call()]));
  assertCallOk(a);
  assertCallOk(b);
  assert.equal(r.env.CONNECTIONS.instances.size, 1);
  assert.deepEqual(r.st.refreshes, ['rt-0']);
});

test('regression: two parallel cold calls initialize two upstream sessions', async () => {
  const r = await oauthRig({});
  r.env.CONNECTIONS.instances.clear();
  const before = r.s.count('initialize');
  await Promise.all([r.call(), r.call()]);
  assert.equal(r.s.count('initialize') - before, 1);
});

test('OAuth: upstream 401 mid-session with an unexpired token -> one forced refresh, then retry succeeds', async () => {
  const r = await oauthRig({});
  r.st.valid.delete('at-0'); // server revoked it early
  const out = await r.call();
  assertCallOk(out);
  assert.deepEqual(r.st.refreshes, ['rt-0']);
  assert.equal(r.conn().status, 'active');
  const authHeaders = r.s.log.filter((l) => l.method === 'tools/call').map((l) => l.headers.authorization);
  assert.deepEqual(authHeaders, ['Bearer at-0', 'Bearer at-1']);
});

test('OAuth: every token rejected after refresh -> auth_required and at most one refresh', async () => {
  let reject = false;
  const r = await oauthRig({ accept: (t, st) => !reject && st.valid.has(t) });
  reject = true;
  const before = r.s.log.length;
  const out = await within(5000, r.call());
  assertCallError(out, /reconnect/);
  assert.equal(out.parsed.connect_url, `${O}/#connections`);
  assert.equal(r.conn().status, 'auth_required');
  assert.equal(r.st.refreshes.length, 1);
  assert.ok(r.s.log.length - before <= 6, `${r.s.log.length - before} upstream requests`);
});

// ================================================================ result passthrough

test('passthrough: /app/api/tool returns plain JSON (RAW symbol is dropped), content items intact', async () => {
  const s = server({ call: (m) => json(ok(m.id, { content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }, { type: 'text', text: 'cap' }], structuredContent: { k: 1 } })) });
  const r = await rig(s);
  const res = await consoleHttp(r.env, r.cookie, 'call_tool', { connection: 'svc_x', tool: 'get_thing', arguments: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.content[0].type, 'image');
  assert.equal(body.content[1].text, 'cap');
  assert.deepEqual(body.structuredContent, { k: 1 });
  assert.equal(body.connection, 'svc_x');
  assert.ok(!Object.keys(body).some((k) => k.includes('raw')));
});

test('passthrough: upstream failure through /app/api/tool is a 400 JSON error, not a 500', async () => {
  const s = server({ call: () => new Response('boom', { status: 502 }) });
  const r = await rig(s);
  const res = await consoleHttp(r.env, r.cookie, 'call_tool', { connection: 'svc_x', tool: 'get_thing', arguments: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /upstream returned 502/);
});
