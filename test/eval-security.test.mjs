// Security evaluation of the gateway. Every test asserts the SECURE behavior.
// Tests named "security regression: ..." pin vulnerabilities found in evaluation, now fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fakeEnv, fakeCtx, fakeDONamespace, stubFetch } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { ConnectionDO } from '../src/gateway.js';
import { createKey } from '../src/auth.js';
import { decide } from '../src/policy.js';
import { safeUpstreamUrl } from '../src/upstream.js';

const O = 'https://brain.test';
const VAULT_KEK = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'figma-pat-SECRET-0123456789';

// ---------------------------------------------------------------- fake upstream MCP

function fakeUpstream({ tools, onCall, auth = (h) => h.authorization === `Bearer ${SECRET}`, onList = null }) {
  const state = { tools: tools.map((t) => ({ ...t })), sessions: 0, calls: [], redirects: [] };
  const json = (body, extra = {}) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...extra } });
  state.handler = async (req, rec) => {
    state.redirects.push(req.redirect);
    const u = new URL(req.url);
    if (u.pathname !== '/mcp') return new Response('nope', { status: 404 });
    if (!auth(rec.headers)) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const msg = JSON.parse(rec.body);
    if (msg.method === 'initialize') {
      state.sessions++;
      return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': `s${state.sessions}` });
    }
    if (!msg.id) return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') {
      if (state.onList) return state.onList(msg, rec);
      return json({ jsonrpc: '2.0', id: msg.id, result: { tools: state.tools } });
    }
    if (msg.method === 'tools/call') {
      state.calls.push({ name: msg.params.name, args: msg.params.arguments, auth: rec.headers.authorization });
      const result = onCall ? onCall(msg.params, rec, msg) : { content: [{ type: 'text', text: `ran ${msg.params.name}` }] };
      if (result instanceof Response) return result;
      if (result?.rpcError) return json({ jsonrpc: '2.0', id: msg.id, error: result.rpcError });
      return json({ jsonrpc: '2.0', id: msg.id, result });
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  };
  state.onList = onList;
  return state;
}

const FIGMA_TOOLS = [
  { name: 'get_screenshot', description: 'Render a node as PNG', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'post_comment', description: 'Comment on a file', inputSchema: { type: 'object' } },
  { name: 'delete_file', description: 'Delete a file', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
const GMAIL_TOOLS = [
  { name: 'search_threads', description: 'Search email threads', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'send_message', description: 'Send an email', inputSchema: { type: 'object' } },
  { name: 'forward_message', description: 'Forward an email', inputSchema: { type: 'object' } },
  { name: 'create_draft', description: 'Draft an email', inputSchema: { type: 'object' } },
];

// ---------------------------------------------------------------- harness

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

const http = async (env, method, path, { token, cookie, body, headers = {}, form } = {}) => {
  const ctx = fakeCtx();
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(O + path, { method, headers: h, body: form || (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
};

async function rpc(env, token, method, params) {
  const res = await http(env, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method, params } });
  return (await res.json()).result;
}
async function tool(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return r; }
}
const rawTool = (env, token, name, args = {}) => rpc(env, token, 'tools/call', { name, arguments: args });

async function superUser(env) {
  await tool(env, env.BRAIN_TOKEN, 'whoami');
  return env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
}

async function loginRes(env, key, headers = {}) {
  const form = new FormData();
  form.set('access_key', key);
  return worker.fetch(new Request(`${O}/app/login`, { method: 'POST', body: form, headers }), env, fakeCtx());
}
async function login(env, key) {
  return (await loginRes(env, key)).headers.get('Set-Cookie').split(';')[0];
}
async function consoleTool(env, cookie, name, args = {}, headers = { Origin: O }) {
  const res = await http(env, 'POST', '/app/api/tool', { cookie, body: { name, args }, headers });
  return res.json();
}

async function bootstrap(routes) {
  const env = setup(routes);
  const uid = await superUser(env);
  const admin = await createKey(env, { name: 'console', role: 'admin', user_id: uid });
  const cookie = await login(env, admin.key);
  const agent = await createKey(env, { name: 'codex', role: 'write', user_id: uid });
  return { env, uid, cookie, adminKey: admin.key, agent: agent.key, agentId: agent.id };
}

/** A second person (@bob) with their own key and console session. */
async function addUser(env, uid, handle = 'bob') {
  const sk = (await createKey(env, { name: `super-${handle}`, role: 'super', user_id: uid })).key;
  const created = await tool(env, sk, 'admin_create_user', { handle });
  const path = new URL(created.invite_url).pathname;
  await http(env, 'GET', path);
  const html = await (await http(env, 'POST', path)).text();
  const key = html.match(/<pre>(bk_[A-Za-z0-9_-]+)<\/pre>/)[1];
  const cookie = await login(env, key);
  const id = env.DB.sqlite.prepare('SELECT id FROM users WHERE handle = ?').get(handle).id;
  return { key, cookie, id };
}

const dbText = (env) => JSON.stringify([
  env.DB.sqlite.prepare('SELECT * FROM audit_events').all(),
  env.DB.sqlite.prepare('SELECT * FROM connections').all(),
  env.DB.sqlite.prepare('SELECT * FROM approvals').all(),
  env.DB.sqlite.prepare('SELECT * FROM connect_flows').all(),
]);

function captureLogs() {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => Object.assign(console, orig) };
}

async function gmailSetup(extra = {}) {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS, ...extra });
  const b = await bootstrap({ 'gmail.test': gmail.handler, ...(extra.routes || {}) });
  const c = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(c.ok, true, JSON.stringify(c));
  await consoleTool(b.env, b.cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message', 'forward_message'] } });
  return { ...b, gmail, connId: c.id };
}

// ================================================================ 1. console-only tools vs agent credentials

test('security regression: an agent key cannot be turned into a web-console session and approve its own call', async () => {
  const { env, agent, agentId } = await gmailSetup();
  const first = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'x@evil.test' } });
  assert.equal(first.status, 'approval_required');
  // The agent holds only its own key. It logs into the console with it…
  const res = await loginRes(env, agent);
  const minted = res.status === 302 ? res.headers.get('Set-Cookie')?.split(';')[0] : null;
  let decided = null;
  if (minted) {
    decided = await consoleTool(env, minted, 'gw_approval_decide', { id: first.approval_id, decision: 'approve' });
    // …or replays the session token as a Bearer on /mcp.
    const viaMcp = await http(env, 'POST', '/mcp', { token: minted.split('=')[1], body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gw_approvals', arguments: {} } } });
    assert.equal(viaMcp.status, 401, 'session token used as Bearer on /mcp must be refused');
  }
  const row = env.DB.sqlite.prepare('SELECT status, decided_by FROM approvals WHERE id = ?').get(first.approval_id);
  assert.notEqual(row.status, 'approved', `agent ${agentId} approved its own call (${JSON.stringify(decided)})`);
});

test('security regression: a connector OAuth token (agent credential) cannot open a web-console session', async () => {
  const { env, agent } = await bootstrap();
  // Register a connector and consent with the agent key, like claude.ai does.
  const reg = await (await http(env, 'POST', '/register', { body: { redirect_uris: ['https://client.test/cb'] } })).json();
  const verifier = 'v'.repeat(50);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const f = new FormData();
  for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: 'https://client.test/cb', code_challenge: challenge, code_challenge_method: 'S256', access_key: agent })) f.set(k, v);
  const auth = await http(env, 'POST', '/authorize', { form: f });
  const code = new URL(auth.headers.get('Location')).searchParams.get('code');
  const tf = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: 'https://client.test/cb', code_verifier: verifier });
  const tok = await (await worker.fetch(new Request(`${O}/token`, { method: 'POST', body: tf }), env, fakeCtx())).json();
  assert.ok(tok.access_token);
  // the connector token itself is refused by gw_* (secure)…
  assert.match((await tool(env, tok.access_token, 'gw_overview')).error, /web console/);
  // …but it can be exchanged for a console session.
  const res = await loginRes(env, tok.access_token);
  assert.notEqual(res.status, 302, 'a connector access token was exchanged for a brain_session cookie');
});

test('console tools: Bearer keys on /app/api/tool, raw keys in the cookie, and foreign Origins are refused', async () => {
  const { env, agent, cookie } = await bootstrap();
  const bearer = await http(env, 'POST', '/app/api/tool', { token: agent, body: { name: 'gw_overview', args: {} }, headers: { Origin: O } });
  assert.equal(bearer.status, 401);
  const rawCookie = await consoleTool(env, `brain_session=${agent}`, 'gw_overview');
  assert.match(rawCookie.error, /unauthorized/, 'a raw key in the cookie is not a session');
  const foreign = await http(env, 'POST', '/app/api/tool', { cookie, body: { name: 'gw_settings', args: { notify_url: null } }, headers: { Origin: 'https://evil.test' } });
  assert.equal(foreign.status, 403);
  const nullOrigin = await http(env, 'POST', '/app/api/tool', { cookie, body: { name: 'gw_settings', args: {} }, headers: { Origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  // every gw_* name refuses an agent key over MCP
  for (const n of ['gw_overview', 'gw_connection_create', 'gw_approval_decide', 'gw_device_approve', 'gw_key_update', 'gw_rule_put', 'gw_connection_share', 'gw_device_lookup']) {
    assert.match((await tool(env, agent, n, {})).error, /web console/, n);
  }
});

test('security regression: /app/login refuses a cross-site POST (login CSRF binds the victim browser to the attacker account)', async () => {
  const { env, uid } = await bootstrap();
  const attackerKey = (await createKey(env, { name: 'attacker', role: 'admin', user_id: uid })).key;
  const res = await loginRes(env, attackerKey, { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(res.status, 403, 'a cross-origin form post minted a session cookie');
});

test('security regression: /app/api/tool refuses a mutating call with no Origin but Sec-Fetch-Site: cross-site', async () => {
  const { env, cookie } = await bootstrap();
  const res = await http(env, 'POST', '/app/api/tool', { cookie, body: { name: 'gw_settings', args: { notify_url: 'https://ntfy.evil.test/x' } }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.status, 403);
});

// ================================================================ 2. IDOR across users

test('IDOR: bob cannot read, change, delete, sync, share, approve or revoke anything of alice', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, uid, cookie, agent, agentId, gmail } = await gmailSetup({ routes: { 'mcp.figma.test': (r, c) => figma.handler(r, c) } });
  const fig = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const rule = await consoleTool(env, cookie, 'gw_rule_put', { effect: 'forbid', subject: {}, resource: { tools: ['delete_file'] } });
  const adminAgent = (await createKey(env, { name: 'aa', role: 'admin', user_id: uid })).key;
  const mk = await tool(env, adminAgent, 'create_key', { name: 'codex@mbp', role: 'write', machine: 'alice-mbp', agent: 'codex' });
  const machineId = env.DB.sqlite.prepare("SELECT id FROM machines WHERE name = 'alice-mbp'").get().id;
  const pending = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } });
  const bob = await addUser(env, uid);

  const attempts = {
    gw_connection_update: { id: fig.id, account: 'pwned', trust: 'trusted' },
    gw_connection_delete: { id: fig.id },
    gw_connection_sync: { id: fig.id },
    gw_connection_tools: { id: fig.id },
    gw_connection_reconnect: { id: fig.id },
    gw_tool_review: { id: fig.id, tool: 'delete_file', action: 'set', risk: 'read' },
    gw_connection_share: { id: fig.id, with: 'bob', tools: ['delete_file'] },
    gw_connection_unshare: { id: fig.id, with: 'bob' },
    gw_rule_put: { id: rule.id, effect: 'permit', subject: {}, resource: {} },
    gw_rule_delete: { id: rule.id },
    gw_rule_test: { key_id: agentId, connection: 'figma_rtp', tool: 'get_screenshot' },
    gw_approval_decide: { id: pending.approval_id, decision: 'approve', scope: 'hour' },
    gw_machine_update: { id: machineId, tags: ['trusted'] },
    gw_machine_revoke: { id: machineId },
    gw_key_update: { id: agentId, agent: 'bobs', pinned: [] },
    gw_connection_accept: { id: fig.id },
  };
  for (const [name, args] of Object.entries(attempts)) {
    const r = await consoleTool(env, bob.cookie, name, args);
    assert.ok(r.error, `${name} succeeded for bob: ${JSON.stringify(r).slice(0, 200)}`);
  }
  const c = env.DB.sqlite.prepare('SELECT account, trust FROM connections WHERE id = ?').get(fig.id);
  assert.deepEqual({ ...c }, { account: null, trust: 'untrusted' });
  assert.equal(env.DB.sqlite.prepare('SELECT effect FROM rules WHERE id = ?').get(rule.id).effect, 'forbid');
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get(pending.approval_id).status, 'pending');
  assert.equal(env.DB.sqlite.prepare('SELECT revoked, tags FROM machines WHERE id = ?').get(machineId).revoked, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT agent FROM api_keys WHERE id = ?').get(agentId).agent, null);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM connection_grants').get().n, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT risk_override FROM connection_tools WHERE connection_id = ? AND name = 'delete_file'").get(fig.id).risk_override, null);
  assert.ok(mk.ok);

  // bob's listings never show alice's things
  for (const n of ['gw_overview', 'gw_rules', 'gw_approvals', 'gw_machines', 'gw_activity', 'gw_connection_shares']) {
    const out = JSON.stringify(await consoleTool(env, bob.cookie, n, {}));
    for (const leak of [fig.id, rule.id, pending.approval_id, machineId, agentId, 'alice-mbp', 'gmail_rtp']) assert.ok(!out.includes(leak), `${n} leaked ${leak}`);
  }
  // and bob's agent cannot reach alice's connections by name
  for (const connection of ['figma_rtp', 'figma_rtp@yash', 'gmail_rtp@yash']) {
    const r = await tool(env, bob.key, 'call_tool', { connection, tool: 'get_screenshot', arguments: {} });
    assert.match(r.error, /no connection/, connection);
  }
  assert.match((await tool(env, bob.key, 'describe_tools', { tools: ['figma_rtp.get_screenshot', 'figma_rtp@yash.get_screenshot'] })).tools.map((t) => t.error).join(), /not found.*not found/);
  assert.equal((await tool(env, bob.key, 'search_tools', { query: 'png screenshot' })).results.length, 0);
  assert.equal((await tool(env, bob.key, 'search_tools', { query: '" OR * NEAR( figma' })).results.length, 0);
  assert.equal(figma.calls.length, 0);
  assert.equal(gmail.calls.length, 0);
});

// ================================================================ 3. approvals

test('approvals are bound to key, tool, arguments and expiry; voided with the connection', async () => {
  const { env, uid, cookie, agent, gmail } = await gmailSetup();
  const agent2 = (await createKey(env, { name: 'claude', role: 'write', user_id: uid })).key;
  const base = { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c', subject: 's' } };
  const first = await tool(env, agent, 'call_tool', base);
  await consoleTool(env, cookie, 'gw_approval_decide', { id: first.approval_id, decision: 'approve' });

  // another key of the same user cannot spend it
  assert.equal((await tool(env, agent2, 'call_tool', { ...base, approval_id: first.approval_id })).status, 'approval_required');
  // another tool cannot spend it
  assert.equal((await tool(env, agent, 'call_tool', { ...base, tool: 'forward_message', approval_id: first.approval_id })).status, 'approval_required');
  // array order is significant
  const arr = await tool(env, agent, 'call_tool', { ...base, arguments: { to: ['a', 'b'] } });
  await consoleTool(env, cookie, 'gw_approval_decide', { id: arr.approval_id, decision: 'approve' });
  assert.equal((await tool(env, agent, 'call_tool', { ...base, arguments: { to: ['b', 'a'] }, approval_id: arr.approval_id })).status, 'approval_required');
  // expired approvals do not count
  env.DB.sqlite.prepare("UPDATE approvals SET expires = datetime('now', '-1 minute') WHERE id = ?").run(first.approval_id);
  assert.equal((await tool(env, agent, 'call_tool', { ...base, approval_id: first.approval_id })).status, 'approval_required');
  assert.equal(gmail.calls.length, 0);
  // an expired pending approval cannot be approved
  const p2 = await tool(env, agent, 'call_tool', { ...base, arguments: { n: 2 } });
  env.DB.sqlite.prepare("UPDATE approvals SET expires = datetime('now', '-1 minute') WHERE id = ?").run(p2.approval_id);
  assert.ok((await consoleTool(env, cookie, 'gw_approval_decide', { id: p2.approval_id, decision: 'approve' })).error);
  // guessed ids
  assert.ok((await consoleTool(env, cookie, 'gw_approval_decide', { id: "ap_' OR 1=1 --", decision: 'approve' })).error);

  // an approval does not survive delete + recreate of a same-named connection
  const p3 = await tool(env, agent, 'call_tool', { ...base, arguments: { n: 3 } });
  await consoleTool(env, cookie, 'gw_approval_decide', { id: p3.approval_id, decision: 'approve', scope: 'hour' });
  const connId = env.DB.sqlite.prepare("SELECT id FROM connections WHERE label = 'rtp'").get().id;
  await consoleTool(env, cookie, 'gw_connection_delete', { id: connId });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET });
  const replay = await tool(env, agent, 'call_tool', { ...base, arguments: { n: 3 }, approval_id: p3.approval_id });
  assert.ok(replay.status === 'approval_required' || /no rule/.test(replay.error || ''), JSON.stringify(replay));
  assert.equal(gmail.calls.length, 0);
  // argument previews are sealed at rest and wiped once decided
  const rows = env.DB.sqlite.prepare('SELECT * FROM approvals').all();
  assert.ok(!JSON.stringify(rows).includes('a@b.c'));
  assert.ok(rows.filter((r) => r.status === 'approved' || r.status === 'denied').every((r) => r.args_sealed === null));
});

test('an approve-once approval cannot be spent twice by concurrent calls', async () => {
  const { env, cookie, agent, gmail } = await gmailSetup();
  const args = { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } };
  const first = await tool(env, agent, 'call_tool', args);
  await consoleTool(env, cookie, 'gw_approval_decide', { id: first.approval_id, decision: 'approve' });
  await Promise.all([1, 2, 3].map(() => rawTool(env, agent, 'call_tool', { ...args, approval_id: first.approval_id })));
  assert.equal(gmail.calls.length, 1, `one approval sent ${gmail.calls.length} emails`);
});

// ================================================================ 4. direct (pinned) tools

test('direct tools: only pinned own connections, policy still applies, shared connections cannot be pinned', async () => {
  const figma = fakeUpstream({ tools: [...FIGMA_TOOLS, { name: 'get__nested', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
  const { env, uid, cookie } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'other', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const pinned = await createKey(env, { name: 'designer', role: 'write', user_id: uid, pinned: ['figma_rtp'] });
  assert.match((await tool(env, pinned.key, 'figma_other__get_screenshot', {})).error, /unknown tool/);
  assert.match((await tool(env, pinned.key, 'figma_rtp__delete_file', {})).error, /forbidden/);
  assert.match((await tool(env, pinned.key, 'figma_rtp__post_comment', {})).error, /forbidden/);
  assert.equal((await rawTool(env, pinned.key, 'figma_rtp__get__nested', {})).isError, false);
  assert.match((await tool(env, pinned.key, '__get_screenshot', {})).error, /unknown tool/);
  assert.equal(figma.calls.length, 1);

  const bob = await addUser(env, uid);
  await consoleTool(env, cookie, 'gw_connection_share', { id: c.id, with: 'bob' });
  await consoleTool(env, bob.cookie, 'gw_connection_accept', { id: c.id });
  const bobKeyId = env.DB.sqlite.prepare('SELECT id FROM api_keys WHERE user_id = ? LIMIT 1').get(bob.id).id;
  assert.ok((await consoleTool(env, bob.cookie, 'gw_key_update', { id: bobKeyId, pinned: ['figma_rtp@yash'] })).error);
  assert.ok((await consoleTool(env, bob.cookie, 'gw_key_update', { id: bobKeyId, pinned: ['figma_rtp'] })).error);
});

// ================================================================ 5. shares

async function shareSetup(grantTools = ['get_screenshot']) {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const b = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp?token=QUERY-SECRET', auth: 'bearer', secret: SECRET, account: 'me@rtp.vc' });
  const bob = await addUser(b.env, b.uid);
  await consoleTool(b.env, b.cookie, 'gw_connection_share', { id: c.id, with: 'bob', tools: grantTools });
  return { ...b, figma, c, bob };
}

test('shares: unaccepted, expired, suspended owner, escalation and console access are all refused', async () => {
  const { env, cookie, figma, c, bob, uid } = await shareSetup();
  const call = (t) => tool(env, bob.key, 'call_tool', { connection: 'figma_rtp@yash', tool: t, arguments: {} });
  assert.match((await call('get_screenshot')).error, /no connection/, 'unaccepted');
  await consoleTool(env, bob.cookie, 'gw_connection_accept', { id: c.id });
  // grantee rules cannot widen the grant, even naming the risk
  await consoleTool(env, bob.cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { risks: ['read', 'write', 'destructive', 'critical'] } });
  await consoleTool(env, bob.cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { tools: ['delete_file', 'post_comment'] } });
  assert.match((await call('delete_file')).error, /share does not include/);
  assert.match((await call('post_comment')).error, /share does not include/);
  // grantee cannot manage, re-share, re-risk, or read the credential/URL
  for (const [n, a] of [['gw_tool_review', { id: c.id, tool: 'delete_file', action: 'set', risk: 'read' }], ['gw_connection_share', { id: c.id, with: 'yash' }],
    ['gw_connection_update', { id: c.id, secret: 'x' }], ['gw_connection_delete', { id: c.id }], ['gw_connection_sync', { id: c.id }], ['gw_connection_reconnect', { id: c.id }]]) {
    assert.ok((await consoleTool(env, bob.cookie, n, a)).error, n);
  }
  const views = JSON.stringify([await consoleTool(env, bob.cookie, 'gw_overview'), await consoleTool(env, bob.cookie, 'gw_connection_tools', { id: c.id }), await tool(env, bob.key, 'list_connections')]);
  for (const leak of [SECRET, 'QUERY-SECRET', 'mcp.figma.test', 'delete_file', 'post_comment']) assert.ok(!views.includes(leak), `grantee view leaked ${leak}`);
  assert.equal((await rawTool(env, bob.key, 'call_tool', { connection: 'figma_rtp@yash', tool: 'get_screenshot', arguments: {} })).isError, false);
  // expired grant
  env.DB.sqlite.prepare("UPDATE connection_grants SET expires = datetime('now', '-1 minute')").run();
  assert.match((await call('get_screenshot')).error, /no connection/, 'expired');
  env.DB.sqlite.prepare('UPDATE connection_grants SET expires = NULL').run();
  // suspended owner
  env.DB.sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(uid);
  assert.match((await call('get_screenshot')).error, /no connection/, 'owner suspended');
  env.DB.sqlite.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(uid);
  // suspended grantee
  env.DB.sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(bob.id);
  assert.equal((await http(env, 'POST', '/mcp', { token: bob.key, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  env.DB.sqlite.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(bob.id);
  // unshare
  await consoleTool(env, cookie, 'gw_connection_unshare', { id: c.id, with: 'bob' });
  assert.match((await call('get_screenshot')).error, /no connection/);
  assert.equal(figma.calls.length, 1);
});

test('security regression: describe_tools on a shared connection shows only the granted tools', async () => {
  const { env, c, bob } = await shareSetup();
  await consoleTool(env, bob.cookie, 'gw_connection_accept', { id: c.id });
  const d = await tool(env, bob.key, 'describe_tools', { tools: ['figma_rtp@yash.delete_file', 'figma_rtp@yash.post_comment'] });
  assert.ok(d.tools.every((t) => t.error), `grantee described non-granted tools: ${JSON.stringify(d.tools.map((t) => t.tool + ':' + (t.error || 'ok')))}`);
});

test("security regression: the owner's forbid rules also bind grantees of a shared connection", async () => {
  const { env, cookie, c, bob, figma } = await shareSetup(['get_screenshot']);
  await consoleTool(env, bob.cookie, 'gw_connection_accept', { id: c.id });
  // owner: nobody may take screenshots from this account any more
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'forbid', subject: {}, resource: { connections: ['figma_rtp'], tools: ['get_screenshot'] } });
  const r = await tool(env, bob.key, 'call_tool', { connection: 'figma_rtp@yash', tool: 'get_screenshot', arguments: {} });
  assert.ok(r.error, 'grantee ignored the owner forbid rule');
  assert.equal(figma.calls.length, 0);
});

// ================================================================ 6. secret leakage

test('security regression: an upstream that echoes the Authorization header in an error never leaks the credential', async () => {
  const echo = (rec) => `bad request; you sent ${rec.headers.authorization}`;
  const figma = fakeUpstream({
    tools: FIGMA_TOOLS,
    onCall: (p, rec, msg) => (p.name === 'get_screenshot'
      ? new Response(echo(rec), { status: 500 })
      : { rpcError: { code: -32000, message: echo(rec) } }),
  });
  const { env, cookie, agent, uid } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['figma_rtp'], risks: ['read', 'write'] } });
  const bob = await addUser(env, uid);
  await consoleTool(env, cookie, 'gw_connection_share', { id: c.id, with: 'bob', tools: ['get_screenshot'] });
  await consoleTool(env, bob.cookie, 'gw_connection_accept', { id: c.id });
  const logs = captureLogs();
  let out;
  try {
    out = JSON.stringify([
      await rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} }),
      await rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'post_comment', arguments: {} }),
      await rawTool(env, bob.key, 'call_tool', { connection: 'figma_rtp@yash', tool: 'get_screenshot', arguments: {} }),
      await consoleTool(env, cookie, 'gw_activity'),
      await consoleTool(env, bob.cookie, 'gw_activity'),
    ]);
  } finally { logs.restore(); }
  assert.ok(figma.calls.length >= 3);
  assert.ok(!out.includes(SECRET), 'the upstream credential reached an agent / the grantee / the activity log');
  assert.ok(!dbText(env).includes(SECRET), 'the upstream credential was written to audit_events / connections');
  assert.ok(!logs.lines.join('\n').includes(SECRET));
});

test('security regression: a failing tool sync that echoes the credential does not store it in last_error or show it in the console', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  figma.onList = (msg, rec) => new Response(`debug: header was ${rec.headers.authorization}`, { status: 502 });
  const sync = await consoleTool(env, cookie, 'gw_connection_sync', { id: c.id });
  const overview = await consoleTool(env, cookie, 'gw_overview');
  assert.ok(!JSON.stringify([sync, overview]).includes(SECRET));
  assert.ok(!dbText(env).includes(SECRET));
});

test('security regression: header auth refuses reserved header names and secrets with control characters', async () => {
  const up = fakeUpstream({ tools: FIGMA_TOOLS, auth: () => true });
  const { env, cookie } = await bootstrap({ 'mcp.figma.test': up.handler });
  let i = 0;
  const create = (args) => consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: `h${i++}`, url: 'https://mcp.figma.test/mcp', auth: 'header', ...args });
  assert.equal((await create({ header_name: 'X-Api-Key', secret: 'ok' })).ok, true, 'sanity');
  const accepted = [];
  for (const h of ['Host', 'Cookie', 'Content-Length', 'Transfer-Encoding', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Content-Type', 'Accept', 'Connection']) {
    const r = await create({ header_name: h, secret: 'x' });
    if (!r.error) accepted.push(h);
  }
  const crlf = await create({ header_name: 'X-Api-Key', secret: 'PART-ONE\r\nX-Injected: PART-TWO' });
  const echoed = JSON.stringify(crlf).includes('PART-ONE') || dbText(env).includes('PART-ONE');
  assert.deepEqual({ accepted, crlfStored: !crlf.error, echoed }, { accepted: [], crlfStored: false, echoed: false },
    `reserved header names accepted: ${accepted.join(', ')}; CRLF secret response: ${JSON.stringify(crlf).slice(0, 160)}`);
});

// ================================================================ 7. SSRF

const PRIVATE_URLS = [
  'https://2130706433/mcp', 'https://0x7f.1/mcp', 'https://0177.0.0.1/mcp', 'https://127.1/mcp', 'https://[::ffff:127.0.0.1]/mcp',
  'https://LOCALHOST/mcp', 'https://foo.localhost/mcp', 'https://169.254.169.254/latest', 'https://metadata.google.internal/x',
  'https://0.0.0.0/mcp', 'https://[::]/mcp', 'https://[fe80::1]/mcp', 'https://[fd00::1]/mcp', 'https://192.168.1.1/mcp', 'https://172.16.0.1/mcp',
  'https://100.64.0.1/mcp', 'https://[0:0:0:0:0:0:0:1]/mcp', 'HTTPS://127.0.0.1/mcp', 'https://127.0.0.1.:443/mcp',
  'https://localhost./mcp', 'https://metadata.google.internal./x', 'https://foo.localhost./mcp', 'https://[::ffff:0:127.0.0.1]/mcp',
  'https://127.0.0.1.nip.io/mcp',
];
const PRIVATE_URLS_MISSED = ['https://[::127.0.0.1]/mcp', 'https://[64:ff9b::127.0.0.1]/mcp', 'https://[fec0::1]/mcp', 'https://[::a9fe:a9fe]/latest'];

test('SSRF: private and loopback upstream URLs are refused in every normalized form', async () => {
  const accepted = PRIVATE_URLS.filter((u) => { try { safeUpstreamUrl(u); return true; } catch { return false; } });
  assert.deepEqual(accepted, []);
  const { env, cookie } = await bootstrap();
  for (const u of ['https://127.0.0.1/', 'https://169.254.169.254/', 'http://ntfy.sh/x']) {
    assert.ok((await consoleTool(env, cookie, 'gw_settings', { notify_url: u })).error, `notify_url ${u}`);
  }
});

test('security regression: SSRF filter refuses IPv4-compatible, NAT64 and site-local IPv6 forms of private addresses', () => {
  const accepted = PRIVATE_URLS_MISSED.filter((u) => { try { safeUpstreamUrl(u); return true; } catch { return false; } });
  assert.deepEqual(accepted, []);
});

test('SSRF: OAuth metadata pointing at private hosts or http is refused before any request', async () => {
  for (const meta of [
    { authorization_endpoint: 'https://127.0.0.1/authorize', token_endpoint: 'https://auth.x.test/token', registration_endpoint: 'https://auth.x.test/register' },
    { authorization_endpoint: 'https://auth.x.test/authorize', token_endpoint: 'http://auth.x.test/token', registration_endpoint: 'https://auth.x.test/register' },
    { authorization_endpoint: 'https://auth.x.test/authorize', token_endpoint: 'https://auth.x.test/token', registration_endpoint: 'https://169.254.169.254/register' },
    { authorization_endpoint: 'javascript:alert(1)', token_endpoint: 'https://auth.x.test/token', registration_endpoint: 'https://auth.x.test/register' },
  ]) {
    const hits = [];
    const as = async (req) => {
      const u = new URL(req.url);
      hits.push(u.pathname);
      if (u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://auth.x.test', ...meta });
      if (u.pathname === '/register') return Response.json({ client_id: 'c' }, { status: 201 });
      return new Response('no', { status: 404 });
    };
    const mcp = async (req) => (new URL(req.url).pathname.startsWith('/.well-known/oauth-protected-resource')
      ? Response.json({ resource: 'https://mcp.x.test/mcp', authorization_servers: ['https://auth.x.test'] }) : new Response('no', { status: 404 }));
    const { env, cookie } = await bootstrap({ 'auth.x.test': as, 'mcp.x.test': mcp });
    const r = await consoleTool(env, cookie, 'gw_connection_create', { service: 'x', label: 'a', url: 'https://mcp.x.test/mcp', auth: 'oauth' });
    assert.ok(r.error, JSON.stringify(meta));
    assert.ok(!net.calls.some((c) => /127\.0\.0\.1|169\.254/.test(c.url)));
  }
  // a protected-resource document naming a private authorization server
  const mcp = async () => Response.json({ resource: 'https://mcp.x.test/mcp', authorization_servers: ['https://169.254.169.254/'] });
  const { env, cookie } = await bootstrap({ 'mcp.x.test': mcp });
  const r = await consoleTool(env, cookie, 'gw_connection_create', { service: 'x', label: 'b', url: 'https://mcp.x.test/mcp', auth: 'oauth' });
  assert.ok(r.error);
  assert.ok(!net.calls.some((c) => c.url.includes('169.254')));
});

test('security regression: every outbound fetch to an upstream-controlled URL refuses redirects (registration, token, notify)', async () => {
  const modes = {};
  const authServer = async (req, rec) => {
    const u = new URL(req.url);
    modes[u.pathname] = req.redirect;
    const j = (b, s = 200) => Response.json(b, { status: s });
    if (u.pathname === '/.well-known/oauth-authorization-server') return j({ issuer: 'https://auth.l.test', authorization_endpoint: 'https://auth.l.test/authorize', token_endpoint: 'https://auth.l.test/token', registration_endpoint: 'https://auth.l.test/register' });
    if (u.pathname === '/register') return j({ client_id: 'bc' }, 201);
    if (u.pathname === '/token') return j({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    return new Response('no', { status: 404 });
  };
  const up = fakeUpstream({ tools: GMAIL_TOOLS, auth: () => true });
  const mcpHost = async (req, rec) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) { modes.prm = req.redirect; return Response.json({ resource: 'https://mcp.l.test/mcp', authorization_servers: ['https://auth.l.test'] }); }
    modes.mcp = req.redirect;
    return up.handler(req, rec);
  };
  const ntfy = async (req) => { modes.notify = req.redirect; return new Response('ok'); };
  const { env, cookie, agent } = await bootstrap({ 'mcp.l.test': mcpHost, 'auth.l.test': authServer, 'ntfy.test': ntfy });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'lin', label: 'a', url: 'https://mcp.l.test/mcp', auth: 'oauth' });
  const state = new URL(c.authorize_url).searchParams.get('state');
  const done = await http(env, 'GET', `/connect/callback?${new URLSearchParams({ code: 'x', state })}`, { cookie });
  assert.equal(done.status, 302);
  await consoleTool(env, cookie, 'gw_settings', { notify_url: 'https://ntfy.test/topic' });
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { tools: ['send_message'] } });
  await tool(env, agent, 'call_tool', { connection: 'lin_a', tool: 'send_message', arguments: {} });
  const following = Object.entries(modes).filter(([, m]) => m !== 'manual' && m !== 'error').map(([k]) => k);
  assert.deepEqual(following, [], `these fetches follow redirects to wherever the upstream points: ${following.join(', ')}`);
});

// ================================================================ 8. OAuth connect callback

async function oauthSetup() {
  const authServer = async (req, rec) => {
    const u = new URL(req.url);
    const j = (b, s = 200) => Response.json(b, { status: s });
    if (u.pathname === '/.well-known/oauth-authorization-server') return j({ issuer: 'https://auth.l.test', authorization_endpoint: 'https://auth.l.test/authorize', token_endpoint: 'https://auth.l.test/token', registration_endpoint: 'https://auth.l.test/register', authorization_response_iss_parameter_supported: true });
    if (u.pathname === '/register') return j({ client_id: 'bc' }, 201);
    if (u.pathname === '/token') return j({ access_token: 'AT-SECRET-1', refresh_token: 'RT-SECRET-1', expires_in: 3600 });
    return new Response('no', { status: 404 });
  };
  const up = fakeUpstream({ tools: [{ name: 'list_issues', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], auth: (h) => h.authorization === 'Bearer AT-SECRET-1' });
  const mcpHost = async (req, rec) => (new URL(req.url).pathname.startsWith('/.well-known/oauth-protected-resource')
    ? Response.json({ resource: 'https://mcp.l.test/mcp', authorization_servers: ['https://auth.l.test'] }) : up.handler(req, rec));
  const b = await bootstrap({ 'mcp.l.test': mcpHost, 'auth.l.test': authServer });
  const c = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'linear', label: 'rtp', url: 'https://mcp.l.test/mcp', auth: 'oauth' });
  const cb = (q, ck) => http(b.env, 'GET', `/connect/callback?${new URLSearchParams(q)}`, { cookie: ck });
  const fresh = async () => new URL((await consoleTool(b.env, b.cookie, 'gw_connection_reconnect', { id: c.id })).authorize_url).searchParams.get('state');
  return { ...b, c, cb, fresh, state: new URL(c.authorize_url).searchParams.get('state') };
}

test('OAuth callback: no session, error param (escaped), missing iss, expired or replayed state all fail', async () => {
  const { env, cookie, cb, fresh, state } = await oauthSetup();
  assert.equal((await cb({ code: 'x', state, iss: 'https://auth.l.test' })).status, 401);
  const s1 = await fresh();
  const err = await cb({ error: '<script>alert(1)</script>', state: s1 }, cookie);
  assert.equal(err.status, 400);
  assert.ok(!(await err.text()).includes('<script>alert'));
  const s2 = await fresh();
  assert.equal((await cb({ code: 'x', state: s2 }, cookie)).status, 400, 'iss missing although the AS advertises it');
  const s3 = await fresh();
  env.DB.sqlite.prepare("UPDATE connect_flows SET exp = datetime('now', '-1 minute')").run();
  assert.equal((await cb({ code: 'x', state: s3, iss: 'https://auth.l.test' }, cookie)).status, 400, 'expired flow');
  const s4 = await fresh();
  assert.equal((await cb({ code: 'x', state: s4, iss: 'https://auth.l.test' }, cookie)).status, 302);
  assert.equal((await cb({ code: 'x', state: s4, iss: 'https://auth.l.test' }, cookie)).status, 400, 'replayed');
  assert.ok(!dbText(env).includes('AT-SECRET-1') && !dbText(env).includes('RT-SECRET-1'));
});

test('security regression: a foreign browser session hitting the callback does not burn the owner\'s pending connect flow', async () => {
  const { env, uid, cookie, cb, state } = await oauthSetup();
  const other = await login(env, (await createKey(env, { name: 'other', role: 'admin', user_id: uid })).key);
  assert.equal((await cb({ code: 'attacker', state, iss: 'https://auth.l.test' }, other)).status, 400);
  assert.equal((await cb({ code: 'x', state, iss: 'https://auth.l.test' }, cookie)).status, 302, 'the legitimate user can no longer finish');
});

// ================================================================ 9. device flow

test('device flow: double approve, poll after deny, role escalation, reuse are all refused', async () => {
  const { env, uid, cookie } = await bootstrap();
  const start = async (machine = 'box') => (await http(env, 'POST', '/device/code', { body: { machine } })).json();
  const poll = async (d) => (await http(env, 'POST', '/device/token', { body: { device_code: d } })).json();
  const a = await start();
  assert.equal((await consoleTool(env, cookie, 'gw_device_approve', { user_code: a.user_code.toLowerCase() })).ok, true);
  assert.ok((await consoleTool(env, cookie, 'gw_device_approve', { user_code: a.user_code })).error, 'approved twice');
  assert.match((await poll(a.device_code)).key, /^bk_/);
  assert.equal((await poll(a.device_code)).error, 'expired_token', 'collected twice');
  const d = await start('box2');
  await consoleTool(env, cookie, 'gw_device_deny', { user_code: d.user_code });
  assert.equal((await poll(d.device_code)).error, 'access_denied');
  assert.equal((await poll(d.device_code)).error, 'expired_token');
  assert.ok((await consoleTool(env, cookie, 'gw_device_approve', { user_code: d.user_code })).error, 'approved after deny');
  // a read session cannot approve; a write session cannot mint admin
  const readCookie = await login(env, (await createKey(env, { name: 'r', role: 'read', user_id: uid })).key);
  const writeCookie = await login(env, (await createKey(env, { name: 'w', role: 'write', user_id: uid })).key);
  const e = await start('box3');
  assert.match((await consoleTool(env, readCookie, 'gw_device_approve', { user_code: e.user_code, role: 'read' })).error, /forbidden/);
  assert.ok((await consoleTool(env, writeCookie, 'gw_device_approve', { user_code: e.user_code, role: 'admin' })).error);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM api_keys WHERE role = 'admin' AND name LIKE '%box3%'").get().n, 0);
  assert.equal((await poll('not-a-real-device-code')).error, 'expired_token');
  assert.equal((await (await http(env, 'POST', '/device/code', { body: { machine: '../../etc' } })).json()).error, 'invalid_request');
  assert.ok(!JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM device_codes').all()).includes(a.device_code), 'device codes are stored hashed');
});

// ================================================================ 10. bridge

test('bridge: keys without a machine, revoked keys, and other users\' machines are refused', async () => {
  const { env, uid, cookie, agent } = await bootstrap();
  let forwarded = [];
  env.BRIDGE = { idFromName: (n) => n, get: (id) => ({ fetch: async () => { forwarded.push(id); return new Response(null, { status: 200 }); } }) };
  const ws = (key, proto) => http(env, 'GET', '/bridge/connect', { token: proto ? undefined : key, headers: { Upgrade: 'websocket', ...(proto ? { 'Sec-WebSocket-Protocol': `brain.v1, ${key}` } : {}) } });
  assert.equal((await ws(agent)).status, 403);
  assert.equal((await ws('bk_nope')).status, 401);
  assert.equal((await ws('bk_nope', true)).status, 401);
  const adminAgent = (await createKey(env, { name: 'aa', role: 'admin', user_id: uid })).key;
  const mk = await tool(env, adminAgent, 'create_key', { name: 'cli@alice-mbp', role: 'write', machine: 'alice-mbp' });
  const aliceMachine = env.DB.sqlite.prepare("SELECT id FROM machines WHERE name = 'alice-mbp'").get().id;
  await ws(mk.key, true);
  assert.deepEqual(forwarded, [aliceMachine]);
  const m = await consoleTool(env, cookie, 'gw_machines');
  await consoleTool(env, cookie, 'gw_machine_revoke', { id: m.machines.find((x) => x.name === 'alice-mbp').id });
  forwarded = [];
  assert.equal((await ws(mk.key)).status, 401, 'revoked machine key');
  assert.deepEqual(forwarded, []);
  // bob cannot point a connection at alice's machine
  const bob = await addUser(env, uid);
  for (const url of ['bridge://alice-mbp/fs', `bridge://${aliceMachine.toLowerCase()}/fs`, 'BRIDGE://alice-mbp/fs', 'bridge://alice-mbp/../x']) {
    const r = await consoleTool(env, bob.cookie, 'gw_connection_create', { service: 'fs', label: 'x', url, auth: 'none' });
    assert.ok(r.error, `${url} accepted`);
  }
  // nor can alice re-use her revoked machine
  assert.ok((await consoleTool(env, cookie, 'gw_connection_create', { service: 'fs', label: 'y', url: 'bridge://alice-mbp/fs', auth: 'none' })).error);
});

// ================================================================ 11. taint

test('taint follows the key across connections', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie, agent, gmail } = await gmailSetup({ routes: { 'mcp.figma.test': (r, c) => figma.handler(r, c) } });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET, trust: 'trusted', sensitivity: 'public' });
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { risks: ['read', 'write'] } });
  assert.equal((await rawTool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'search_threads', arguments: {} })).isError, false);
  assert.equal((await tool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'post_comment', arguments: {} })).status, 'approval_required');
  assert.equal(figma.calls.length, 0);
  assert.equal(gmail.calls.length, 1);
});

test('security regression: a tainted agent cannot shed taint by minting itself a child key', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, uid, cookie } = await bootstrap({ 'gmail.test': gmail.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET });
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], risks: ['read', 'write'] } });
  const adminAgent = (await createKey(env, { name: 'admin agent', role: 'admin', user_id: uid })).key;
  await rawTool(env, adminAgent, 'call_tool', { connection: 'gmail_rtp', tool: 'search_threads', arguments: {} });
  const draft = { connection: 'gmail_rtp', tool: 'create_draft', arguments: { body: 'exfil' } };
  assert.equal((await tool(env, adminAgent, 'call_tool', draft)).status, 'approval_required');
  const child = await tool(env, adminAgent, 'create_key', { name: 'fresh', role: 'write' });
  assert.ok(child.key);
  const r = await rawTool(env, child.key, 'call_tool', draft);
  assert.ok(!gmail.calls.some((c) => c.name === 'create_draft'), `the child key ran the egress tool without approval: ${JSON.stringify(r).slice(0, 120)}`);
});

// ================================================================ 12. policy, rules, injection, DoS

test('policy: forbid beats permit, disabled rules are ignored, globals need super, wildcards never reach high risk', async () => {
  const who = { keyId: 'k', machine: null, agent: null, agentTags: [] };
  const conn = { id: 'gmail_rtp', service: 'gmail' };
  const all = { id: 'a', effect: 'permit', subject: {}, resource: { risks: ['read', 'write', 'destructive', 'critical'] } };
  const forbid = { id: 'f', effect: 'forbid', subject: {}, resource: { tools: ['delete_*'] } };
  assert.equal(decide({ who, conn, tool: { name: 'delete_x', risk: 'destructive' }, rules: [all, forbid] }).decision, 'deny');
  assert.equal(decide({ who, conn, tool: { name: 'delete_x', risk: 'destructive' }, rules: [all, { ...forbid, enabled: 0 }] }).decision, 'allow');
  assert.equal(decide({ who, conn, tool: { name: 'get_x', risk: 'read' }, rules: [{ ...all, enabled: 0 }] }).decision, 'deny');
  assert.equal(decide({ who, conn, tool: { name: 'delete_x', risk: 'destructive' }, rules: [{ id: 'w', effect: 'permit', subject: {}, resource: { tools: ['delete_*'] } }] }).decision, 'deny');
  assert.equal(decide({ who, conn, tool: { name: 'send', risk: 'critical' }, rules: [{ id: 'w', effect: 'permit', subject: {}, resource: { tools: ['*'] } }] }).decision, 'deny');
  assert.equal(decide({ who, conn, tool: { name: 'send', risk: 'critical' }, rules: [all] }).decision, 'approval');
  assert.equal(decide({ who, conn, tool: { name: 'g.e+t', risk: 'read' }, rules: [{ id: 'r', effect: 'permit', subject: {}, resource: { tools: ['g.e+t'] } }] }).decision, 'allow');
  assert.equal(decide({ who, conn, tool: { name: 'gXeet', risk: 'read' }, rules: [{ id: 'r', effect: 'permit', subject: {}, resource: { tools: ['g.e+t'] } }] }).decision, 'deny', 'regex metacharacters are literal');

  const { env, cookie, uid } = await bootstrap();
  assert.match((await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: {}, global: true })).error, /super/);
  const bob = await addUser(env, uid);
  assert.match((await consoleTool(env, bob.cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: {}, global: true })).error, /super/);
  assert.ok((await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { risks: ['godmode'] } })).error);
  assert.ok((await consoleTool(env, cookie, 'gw_rule_put', { effect: 'allow', subject: {}, resource: {} })).error);
  // __proto__ in a rule or in arguments pollutes nothing
  await consoleTool(env, cookie, 'gw_rule_put', JSON.parse('{"effect":"permit","subject":{"__proto__":{"keys":["x"]}},"resource":{"__proto__":{"risks":["critical"]}}}'));
  assert.equal(({}).keys, undefined);
  assert.equal(({}).risks, undefined);
});

test('arguments with __proto__ reach upstream verbatim and pollute nothing', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const res = await http(env, 'POST', '/mcp', { token: agent, headers: { 'Content-Type': 'application/json' },
    body: undefined, form: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_tool","arguments":{"connection":"figma_rtp","tool":"get_screenshot","arguments":{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}}}}' });
  assert.equal(res.status, 200);
  assert.equal(({}).isAdmin, undefined);
  assert.equal(({}).x, undefined);
  assert.equal(figma.calls.length, 1);
});

test('names and labels reject injection; long and odd inputs are bounded', async () => {
  const { env, cookie } = await bootstrap();
  for (const [service, label] of [["figma'; DROP TABLE connections;--", 'x'], ['figma', '../x'], ['figma', 'a_b'], ['fіgma', 'x'], ['Figma', 'x'], ['f', 'x'], ['figma', ''], ['figma', 'x'.repeat(13)]]) {
    const r = await consoleTool(env, cookie, 'gw_connection_create', { service, label, url: 'https://x.test/mcp', auth: 'none' });
    if (service === 'Figma') continue; // lowercased on purpose
    assert.ok(r.error, `${service}/${label} accepted`);
  }
  assert.ok(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM connections').get().n <= 1);
  const big = await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: { agents: Array.from({ length: 5000 }, (_, i) => `a${i}`) }, resource: { tools: ['x'.repeat(81)] } });
  assert.ok(big.error);
  assert.ok((await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'x', url: 'https://x.test/mcp', auth: 'none', default_for: ["project:x') OR 1=1"] })).error);
});

test('security regression: rule globs cannot be made to backtrack catastrophically (ReDoS)', async () => {
  const policyUrl = new URL('../src/policy.js', import.meta.url).href;
  const code = `
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(policyUrl)}).then(({ decide }) => {
      const rule = { id: 'r', effect: 'permit', subject: {}, resource: { tools: ['*a'.repeat(30) + '*b'] } };
      decide({ who: { keyId: 'k', machine: null, agent: null, agentTags: [] }, conn: { id: 'c_x', service: 'c' }, tool: { name: 'a'.repeat(120), risk: 'read' }, rules: [rule] });
      parentPort.postMessage('done');
    });`;
  const w = new Worker(code, { eval: true });
  const finished = await new Promise((resolve) => {
    const t = setTimeout(() => { w.terminate(); resolve(false); }, 1500);
    w.on('message', () => { clearTimeout(t); w.terminate(); resolve(true); });
    w.on('error', () => { clearTimeout(t); resolve(true); });
  });
  assert.ok(finished, 'one 61-character glob against a 120-character tool name pinned the CPU for over 1.5s');
});
