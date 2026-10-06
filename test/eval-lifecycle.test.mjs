// Evaluation: lifecycle, concurrency and data-migration correctness of the gateway.
// Tests named "regression: ..." pin defects found in evaluation, now fixed.
// Run: node --import ./test/helpers/register-cf.mjs --test test/eval-lifecycle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fakeEnv, fakeCtx, fakeDONamespace, stubFetch, sha256hex as sha } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { ConnectionDO } from '../src/gateway.js';
import { createKey } from '../src/auth.js';
import { ensureSchema } from '../src/schema.js';
import { appendEvent } from '../src/audit.js';
import { createUser } from '../src/tenancy.js';

const O = 'https://brain.test';
const VAULT_KEK = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'figma-pat-SECRET-0123456789';
const ROOT = new URL('..', import.meta.url).pathname;

// The production control schema (3) is whatever origin/main shipped.
const V3_SQL = execFileSync('git', ['show', 'origin/main:schema.sql'], { cwd: ROOT, encoding: 'utf8' });
const DEV_SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
// The version the Worker migrates to (the gateway branch bumps it; read it, do not hard-code it).
const TARGET_VERSION = /CONTROL_SCHEMA_VERSION = '(\d+)'/.exec(readFileSync(new URL('../src/schema.js', import.meta.url), 'utf8'))[1];

// ---------------------------------------------------------------- D1 stand-in over an explicit schema

function bindable(v) {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
const plain = (row) => (row ? { ...row } : null);

/**
 * A D1-like binding over a node:sqlite database. Several bindings may share one
 * sqlite handle (separate isolates talking to one D1). `hooks.beforeRun(sql)` may
 * throw to simulate a crash / D1 error on a given statement.
 */
function d1Over(sqlite, hooks = {}) {
  const statement = (sql, args = []) => {
    const exec = () => {
      hooks.beforeRun?.(sql, args);
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    };
    return {
      bind: (...a) => statement(sql, a.map(bindable)),
      async first(col) {
        hooks.beforeRun?.(sql, args);
        const row = plain(sqlite.prepare(sql).get(...args));
        return col ? (row ? row[col] ?? null : null) : row;
      },
      async all() {
        hooks.beforeRun?.(sql, args);
        return { success: true, results: sqlite.prepare(sql).all(...args).map(plain), meta: {} };
      },
      async raw() { return sqlite.prepare(sql).all(...args).map((r) => Object.values(r)); },
      async run() { return exec(); },
      _exec: exec,
    };
  };
  return {
    sqlite,
    batches: [],
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      this.batches.push(stmts.length);
      hooks.beforeBatch?.(stmts);
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
  };
}

function sqliteFrom(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  return db;
}

const tableCols = (sqlite, t) => sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }));
const tables = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts_%' ORDER BY name").all().map((r) => r.name);
const indexes = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

function shape(sqlite) {
  const out = {};
  for (const t of tables(sqlite)) {
    out[t] = Object.fromEntries(tableCols(sqlite, t).map((c) => [c.name, `${c.type}|${c.notnull}|${c.dflt}`]));
  }
  return out;
}

// ---------------------------------------------------------------- shared harness (copied from gateway.test.mjs)

function fakeUpstream({ tools, onCall, auth = (h) => h.authorization === `Bearer ${SECRET}`, delayMs = 0 }) {
  const state = { tools: tools.map((t) => ({ ...t })), sessions: 0, calls: [], inits: [] };
  const json = (body, extra = {}) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...extra } });
  state.handler = async (req, rec) => {
    const u = new URL(req.url);
    if (u.pathname !== '/mcp') return new Response('nope', { status: 404 });
    if (!auth(rec.headers)) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const msg = JSON.parse(rec.body);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (msg.method === 'initialize') {
      state.sessions++;
      state.inits.push(rec.headers.authorization);
      return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': `s${state.sessions}` });
    }
    if (!msg.id) return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: state.tools } });
    if (msg.method === 'tools/call') {
      state.calls.push({ name: msg.params.name, args: msg.params.arguments, auth: rec.headers.authorization, session: rec.headers['mcp-session-id'] });
      const result = onCall ? onCall(msg.params) : { content: [{ type: 'text', text: `ran ${msg.params.name}` }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  };
  return state;
}

const FIGMA_TOOLS = [
  { name: 'get_screenshot', description: 'Render a node as PNG', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'post_comment', description: 'Comment on a file', inputSchema: { type: 'object' } },
  { name: 'delete_file', description: 'Delete a file', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
const GMAIL_TOOLS = [
  { name: 'search_threads', description: 'Search email threads', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'send_message', description: 'Send an email', inputSchema: { type: 'object' } },
  { name: 'create_draft', description: 'Draft an email', inputSchema: { type: 'object' } },
];

let net = stubFetch();

function setup(routes = {}, overrides = {}) {
  const env = fakeEnv({ VAULT_KEK, ...overrides });
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
  if (res.status !== 200) return { httpStatus: res.status };
  return (await res.json()).result;
}
async function tool(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  if (r.httpStatus) return r;
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return r; }
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
async function consoleTool(env, cookie, name, args = {}) {
  const res = await http(env, 'POST', '/app/api/tool', { cookie, body: { name, args }, headers: { Origin: O } });
  return res.json();
}
async function bootstrap(routes, overrides) {
  const env = setup(routes, overrides);
  const uid = await superUser(env);
  const admin = await createKey(env, { name: 'console', role: 'admin', user_id: uid });
  const cookie = await login(env, admin.key);
  const agent = await createKey(env, { name: 'codex', role: 'write', user_id: uid });
  return { env, uid, cookie, agent: agent.key, agentId: agent.id, adminId: admin.id };
}
const q = (env, sql, ...a) => env.DB.sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
const q1 = (env, sql, ...a) => { const r = env.DB.sqlite.prepare(sql).get(...a); return r ? { ...r } : r; };

// ================================================================ 1. PRODUCTION MIGRATION (3 -> 4)

/** A D1 exactly as production has it today: control schema 3, real-looking rows. */
async function v3Database() {
  const sqlite = sqliteFrom(V3_SQL);
  const DB = d1Over(sqlite);
  const env0 = fakeEnv({ DB, VAULT_KEK });
  const s = (sql, ...a) => sqlite.prepare(sql).run(...a);
  s("INSERT INTO meta (k, v) VALUES ('control_schema', '3')");
  s("INSERT INTO users (id, handle, name, status, is_super, can_invite, created) VALUES ('u_super', 'yash', 'Yash', 'active', 1, 1, datetime('now', '-30 days'))");
  s("INSERT INTO spaces (id, handle, owner_id, kind, backing, status, created) VALUES ('s_yash', 'yash', 'u_super', 'personal', 'git', 'active', datetime('now', '-30 days'))");
  s("INSERT INTO members (space_id, user_id, role, created) VALUES ('s_yash', 'u_super', 'owner', datetime('now', '-30 days'))");
  // a second user, created through tenancy.createUser (it only touches v3 tables/columns)
  const { user: bob } = await createUser(env0, { handle: 'bob', name: 'Bob', createdBy: 'u_super' });
  s("INSERT INTO shares (id, space_id, project, grantee_id, role, granted_by, created) VALUES ('sh_1', 's_yash', 'deals', ?, 'read', 'u_super', datetime('now'))", bob.id);
  const keys = {};
  const mk = (id, name, role, userId, parent = null, revoked = 0) => {
    const key = `bk_v3_${id}_${'x'.repeat(20)}`;
    s(`INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked, last_used, user_id, space_limit, parent_key_id)
       VALUES (?, ?, ?, ?, '[]', datetime('now', '-10 days'), NULL, ?, NULL, ?, NULL, ?)`, id, sha(key), name, role, revoked, userId, parent);
    keys[id] = key;
  };
  mk('k_admin', 'laptop admin', 'admin', 'u_super');
  mk('k_child', 'child of admin', 'write', 'u_super', 'k_admin');
  mk('k_bob', 'bob agent', 'write', bob.id);
  mk('k_dead', 'revoked', 'write', 'u_super', null, 1);
  s("INSERT INTO oauth_clients (client_id, redirect_uris, created, client_name) VALUES ('cl_claude', '[\"https://claude.ai/api/mcp/auth_callback\"]', datetime('now'), 'Claude')");
  const connectorToken = 'v3-connector-access-token-0000000000';
  const webSession = 'v3-web-session-token-00000000000000000';
  s("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'cl_claude', datetime('now', '+1 day'), 'write', '[]', 'k_admin')", sha(connectorToken));
  s("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'refresh', 'cl_claude', datetime('now', '+30 day'), 'write', '[]', 'k_admin')", sha('v3-refresh'));
  s("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'webapp', datetime('now', '+1 day'), 'admin', '[]', 'k_admin')", sha(webSession));
  s("INSERT INTO tool_calls (session, day, ts, tool, payload, user_id, key_id) VALUES ('sess1', date('now'), datetime('now'), 'Bash', '{}', 'u_super', 'k_admin')");
  s("INSERT INTO notes (path, title, type, project, body, indexed_at) VALUES ('projects/deals.md', 'Deals', 'project', 'deals', '# Deals', datetime('now'))");
  // the audit hash chain, written by the (unchanged since v3) appender
  for (const action of ['session.login', 'key.create', 'user.create', 'share.create', 'note.write']) {
    await appendEvent({ DB }, { actor_user: 'u_super', actor_key: 'k_admin', via: 'key', action, outcome: 'ok', target: action, detail: '{"v":3}' });
  }
  return { sqlite, DB, keys, connectorToken, webSession, bobId: bob.id };
}

test('migration: src/audit.js is byte-identical to production (so the seeded v3 hash chain is faithful)', () => {
  for (const f of ['src/audit.js']) {
    const prod = execFileSync('git', ['show', `origin/main:${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), prod, `${f} changed since v3; the seed may not be faithful`);
  }
});

test('migration 3 -> current: every new table and column appears, old rows get defaults, version is bumped', async () => {
  const v3 = await v3Database();
  const before = shape(v3.sqlite);
  assert.ok(!before.machines && !before.api_keys.machine_id, 'precondition: really a v3 database');
  const env = setup({}, { DB: v3.DB });
  const me = await tool(env, v3.keys.k_admin, 'whoami');
  assert.equal(me.user, '@yash', JSON.stringify(me).slice(0, 300));

  const after = shape(v3.sqlite);
  for (const t of ['machines', 'connections', 'credentials', 'connection_tools', 'connection_grants', 'rules', 'approvals', 'taint', 'connect_flows', 'embeddings', 'device_codes']) {
    assert.ok(after[t], `table ${t} missing after migration`);
  }
  assert.ok(v3.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tool_fts'").get(), 'tool_fts virtual table missing');
  for (const [t, c] of [['api_keys', 'machine_id'], ['api_keys', 'agent'], ['api_keys', 'agent_tags'], ['api_keys', 'pinned'], ['users', 'notify_url'], ['oauth_clients', 'metadata_url']]) {
    assert.ok(after[t][c], `${t}.${c} missing`);
  }
  for (const idx of ['idx_connections_owner', 'idx_rules_owner', 'idx_approvals_user']) assert.ok(indexes(v3.sqlite).includes(idx), idx);
  const old = v3.sqlite.prepare("SELECT agent_tags, pinned, machine_id FROM api_keys WHERE id = 'k_admin'").get();
  assert.deepEqual({ ...old }, { agent_tags: '[]', pinned: '[]', machine_id: null });
  assert.equal(v3.sqlite.prepare("SELECT v FROM meta WHERE k = 'control_schema'").get().v, TARGET_VERSION);
  // nothing pre-existing was lost
  assert.equal(v3.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 4);
  assert.equal(v3.sqlite.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 1);
  assert.equal(v3.sqlite.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 1);
  assert.equal(v3.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE is_super = 1").get().n, 1, 'bootstrap must not mint a second super');
});

test('migration 3 -> current: existing keys, child keys, connector tokens and web sessions keep working; revoked stays revoked', async () => {
  const v3 = await v3Database();
  const env = setup({}, { DB: v3.DB });
  assert.equal((await tool(env, v3.keys.k_admin, 'whoami')).user, '@yash');
  assert.equal((await tool(env, v3.keys.k_child, 'whoami')).user, '@yash');
  assert.equal((await tool(env, v3.keys.k_bob, 'whoami')).user, '@bob');
  assert.equal((await rpc(env, v3.keys.k_dead, 'tools/list')).httpStatus, 401);
  assert.equal((await tool(env, v3.connectorToken, 'whoami')).user, '@yash', 'a claude.ai connector token minted under v3');
  const cookie = `brain_session=${v3.webSession}`;
  const ov = await consoleTool(env, cookie, 'gw_overview');
  assert.deepEqual(ov.connections, [], JSON.stringify(ov));
  // v3 keys can use the gateway agent tools straight away (no machine, no agent, empty tags)
  const lc = await tool(env, v3.keys.k_admin, 'list_connections');
  assert.deepEqual(lc.connections, []);
  // and a v3 key can be attached to a machine afterwards
  const moved = await consoleTool(env, cookie, 'gw_key_update', { id: 'k_child', machine: 'mbp', agent: 'codex' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal((await tool(env, v3.keys.k_child, 'whoami')).user, '@yash');
});

test('migration 3 -> current: the v3 audit hash chain still verifies, and new gateway events extend it', async () => {
  const v3 = await v3Database();
  const env = setup({}, { DB: v3.DB });
  await tool(env, v3.keys.k_admin, 'whoami'); // first request migrates
  const sk = (await createKey(env, { name: 'super', role: 'super', user_id: 'u_super' })).key;
  const r = await tool(env, sk, 'admin_audit', { verify: true });
  assert.equal(r.chain.ok, true, JSON.stringify(r.chain));
  assert.ok(r.chain.events >= 5);
  await consoleTool(env, `brain_session=${v3.webSession}`, 'gw_settings', { notify_url: 'https://ntfy.sh/x' });
  const r2 = await tool(env, sk, 'admin_audit', { verify: true });
  assert.equal(r2.chain.ok, true);
  assert.ok(r2.chain.events > r.chain.events);
});

test('migration: ensureSchema is idempotent (re-run on a v4 DB, and forced re-run with the marker reset)', async () => {
  const v3 = await v3Database();
  await ensureSchema({ DB: v3.DB });
  const once = shape(v3.sqlite);
  await ensureSchema({ DB: d1Over(v3.sqlite) }); // a second isolate: marker already current, no-op
  v3.sqlite.prepare("UPDATE meta SET v = '3' WHERE k = 'control_schema'").run();
  await ensureSchema({ DB: d1Over(v3.sqlite) }); // forced full re-run over a migrated DB
  assert.deepEqual(shape(v3.sqlite), once);
  assert.equal(v3.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE is_super = 1").get().n, 1);
});

test('migration: a crash part-way through the column step recovers on the next request', async () => {
  const v3 = await v3Database();
  let crash = true;
  const flaky = d1Over(v3.sqlite, { beforeRun: (sql) => { if (crash && /ADD COLUMN agent_tags/.test(sql)) throw new Error('D1_ERROR: Network connection lost.'); } });
  await assert.rejects(ensureSchema({ DB: flaky }), /Network connection lost/);
  assert.equal(v3.sqlite.prepare("SELECT v FROM meta WHERE k = 'control_schema'").get().v, '3', 'version must not advance on a partial run');
  assert.ok(tableCols(v3.sqlite, 'api_keys').some((c) => c.name === 'agent'), 'columns before the crash were applied');
  crash = false;
  await ensureSchema({ DB: flaky }); // same binding: the failed promise must not be cached
  assert.ok(tableCols(v3.sqlite, 'api_keys').some((c) => c.name === 'pinned'));
  assert.equal(v3.sqlite.prepare("SELECT v FROM meta WHERE k = 'control_schema'").get().v, TARGET_VERSION);
});

test('migration: a crash inside the DDL batch rolls the whole batch back and retries cleanly', async () => {
  const v3 = await v3Database();
  let crash = true;
  const flaky = d1Over(v3.sqlite, { beforeRun: (sql) => { if (crash && /CREATE TABLE IF NOT EXISTS approvals/.test(sql)) throw new Error('D1_ERROR: boom'); } });
  await assert.rejects(ensureSchema({ DB: flaky }));
  assert.ok(!tables(v3.sqlite).includes('machines'), 'the DDL batch is one transaction');
  crash = false;
  await ensureSchema({ DB: flaky });
  assert.ok(tables(v3.sqlite).includes('approvals'));
});

test('migration: the DDL batch stays within D1 batch limits and holds the FTS5 create (flag for a real-D1 check)', async () => {
  const v3 = await v3Database();
  const DB = d1Over(v3.sqlite);
  await ensureSchema({ DB });
  assert.ok(DB.batches[0] <= 100, `DDL batch has ${DB.batches[0]} statements`);
  // NOTE: node:sqlite accepts CREATE VIRTUAL TABLE ... fts5 inside BEGIN/COMMIT. Real D1
  // also does (the v3 `fts` table is created the same way by `wrangler d1 execute`), but
  // this cannot be proven offline; see the report.
});

test('migration: dev path (fresh schema.sql, then ensureSchema) and prod path (v3 + migrate) converge on the same schema', async () => {
  const dev = sqliteFrom(DEV_SQL);
  await ensureSchema({ DB: d1Over(dev) });
  const prod = (await v3Database()).sqlite;
  await ensureSchema({ DB: d1Over(prod) });
  const a = shape(dev);
  const b = shape(prod);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'same tables');
  const drift = [];
  for (const t of Object.keys(a)) {
    for (const c of new Set([...Object.keys(a[t]), ...Object.keys(b[t] || {})])) {
      if (a[t][c] !== b[t]?.[c]) drift.push(`${t}.${c}: dev=${a[t][c]} prod=${b[t]?.[c]}`);
    }
  }
  assert.deepEqual(drift, [], 'column drift between schema.sql and src/schema.js');
  assert.deepEqual(indexes(dev), indexes(prod));
});

test('regression: two isolates migrating the same D1 at once: one request fails with "duplicate column name"', async () => {
  const v3 = await v3Database();
  const a = ensureSchema({ DB: d1Over(v3.sqlite) });
  const b = ensureSchema({ DB: d1Over(v3.sqlite) });
  const out = await Promise.allSettled([a, b]);
  const failed = out.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  assert.deepEqual(failed, [], `a first request after deploy returned 500: ${failed.join('; ')}`);
});

// ================================================================ 2. LIFECYCLE

async function gmailSetup() {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const b = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(c.ok, true, JSON.stringify(c));
  return { ...b, gmail, conn: c };
}

test('lifecycle: deleting a connection voids its approvals, drops tools/fts/grants/flows/credential; the old approval cannot be replayed on a re-created one', async () => {
  const { env, cookie, agent, gmail, conn } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message'] } });
  const a1 = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } });
  const a2 = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'x@y.z' } });
  await consoleTool(env, cookie, 'gw_approval_decide', { id: a1.approval_id, decision: 'approve' });
  const bob = await createUser(env, { handle: 'bob', createdBy: 'x' });
  await consoleTool(env, cookie, 'gw_connection_share', { id: conn.id, with: 'bob' });
  await rawTool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'search_threads', arguments: {} }); // taint
  assert.ok(q(env, 'SELECT * FROM taint').length > 0);

  const del = await consoleTool(env, cookie, 'gw_connection_delete', { id: conn.id });
  assert.equal(del.ok, true);
  for (const t of ['connection_tools', 'tool_fts', 'connection_grants', 'connect_flows', 'credentials']) {
    assert.equal(q(env, `SELECT * FROM ${t} WHERE connection_id = ?`, conn.id).length, 0, t);
  }
  assert.deepEqual(q(env, 'SELECT status FROM approvals WHERE id IN (?, ?) ORDER BY id', a1.approval_id, a2.approval_id).map((r) => r.status).sort(), ['void', 'void']);

  // the evicted-or-not ConnectionDO of the old id refuses to run anything
  const stale = await (await env.CONNECTIONS.get(env.CONNECTIONS.idFromName(conn.id)).fetch('https://connection/run', { method: 'POST', body: JSON.stringify({ op: 'call', connection_id: conn.id, tool: 'send_message', args: {} }) })).json();
  assert.deepEqual(stale, { ok: false, error: 'connection not found', auth: false });
  // re-create the same service + label
  const c2 = await consoleTool(env, cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(c2.ok, true);
  assert.notEqual(c2.id, conn.id);
  const replay = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' }, approval_id: a1.approval_id });
  assert.ok(replay.status === 'approval_required' || /no rule permits|forbidden/.test(replay.error || ''), 'an approval from the deleted connection must not carry over');
  assert.equal(gmail.calls.filter((c) => c.name === 'send_message').length, 0);
  assert.equal((await tool(env, (await createKey(env, { name: 'b', role: 'write', user_id: bob.user.id })).key, 'list_connections')).connections.length, 0, 'the old share does not reattach');
  assert.equal(q(env, 'SELECT * FROM connection_tools WHERE connection_id = ?', c2.id).length, 3);
  assert.equal(q(env, 'SELECT * FROM tool_fts WHERE connection_id = ?', c2.id).length, 3, 'no stale fts rows');
});

test('regression: deleting a connection leaves every rule that names it; a re-created connection of the same name inherits them (and the auto read rule piles up)', async () => {
  const { env, cookie, agent, conn } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], risks: ['write'] } });
  await consoleTool(env, cookie, 'gw_connection_delete', { id: conn.id });
  const leftover = q(env, "SELECT id, resource FROM rules WHERE resource LIKE '%gmail_rtp%'");
  // Re-create as a different account under the same name.
  const c2 = await consoleTool(env, cookie, 'gw_connection_create', { service: 'gmail', label: 'rtp', url: 'https://gmail.test/mcp', auth: 'bearer', secret: SECRET, account: 'someone-else@example.com' });
  const draft = await rawTool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'create_draft', arguments: {} });
  const autoRules = q(env, "SELECT id FROM rules WHERE note LIKE 'all my agents may use read tools on gmail_rtp'");
  assert.deepEqual({ leftoverRules: leftover.length, draftRanWithoutNewRule: draft.isError === false, autoReadRules: autoRules.length },
    { leftoverRules: 0, draftRanWithoutNewRule: false, autoReadRules: 1 }, `c2=${c2.id}`);
});

test('regression: a pinned key keeps the deleted connection name and gets direct tools of whatever is re-created under it', async () => {
  const a = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, uid, cookie } = await bootstrap({ 'a.figma.test': a.handler, 'b.figma.test': fakeUpstream({ tools: FIGMA_TOOLS }).handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'work', url: 'https://a.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const pinned = await createKey(env, { name: 'designer', role: 'write', user_id: uid, pinned: ['figma_work'] });
  await consoleTool(env, cookie, 'gw_connection_delete', { id: c.id });
  const keyRow = q1(env, 'SELECT pinned FROM api_keys WHERE id = ?', pinned.id);
  assert.deepEqual(JSON.parse(keyRow.pinned), [], 'delete should unpin the connection from keys');
});

test('lifecycle: revoking a key revokes its children and kills its connector/web tokens; taint stays until the sweep', async () => {
  const { env, cookie, uid, adminId } = await bootstrap();
  const parent = await createKey(env, { name: 'parent', role: 'admin', user_id: uid, parent_key_id: adminId });
  const child = await createKey(env, { name: 'child', role: 'write', user_id: uid, parent_key_id: parent.id });
  const sess = await login(env, parent.key);
  env.DB.sqlite.prepare("INSERT INTO taint (key_id, label, source, exp) VALUES (?, 'untrusted', 'x', datetime('now', '+1 hour'))").run(child.id);
  const sk = (await createKey(env, { name: 'sk', role: 'admin', user_id: uid })).key;
  assert.equal((await tool(env, sk, 'revoke_key', { id: parent.id })).ok, true);
  assert.equal((await rpc(env, child.key, 'tools/list')).httpStatus, 401);
  assert.equal((await http(env, 'POST', '/app/api/tool', { cookie: sess, body: { name: 'gw_overview', args: {} }, headers: { Origin: O } })).status >= 400, true);
  assert.equal(q(env, 'SELECT * FROM oauth_tokens WHERE key_id = ?', parent.id).length, 0);
  assert.equal(q(env, 'SELECT * FROM taint WHERE key_id = ?', child.id).length, 0, 'revoking a key clears its taint');
  assert.ok(cookie);
});

test('regression: approvals requested by a key that was later revoked stay pending and can still be approved', async () => {
  const { env, cookie, uid } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message'] } });
  const k = await createKey(env, { name: 'doomed', role: 'write', user_id: uid });
  const ap = await tool(env, k.key, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } });
  const sk = (await createKey(env, { name: 'sk', role: 'admin', user_id: uid })).key;
  await tool(env, sk, 'revoke_key', { id: k.id });
  const pending = (await consoleTool(env, cookie, 'gw_approvals', { status: 'pending' })).approvals.map((a) => a.id);
  assert.ok(!pending.includes(ap.approval_id), 'the console still asks a human to approve a dead key\'s request');
});

test('lifecycle: revoking a machine revokes its keys and taint; a key can be moved between live machines', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie, uid } = await bootstrap({ 'mcp.figma.test': figma.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET, grant_read: false });
  const adminAgent = (await createKey(env, { name: 'adm', role: 'admin', user_id: uid })).key;
  const k = await tool(env, adminAgent, 'create_key', { name: 'codex@mbp', role: 'write', machine: 'mbp', agent: 'codex' });
  await tool(env, adminAgent, 'create_key', { name: 'x@server', role: 'write', machine: 'server', agent: 'x' });
  const ms = (await consoleTool(env, cookie, 'gw_machines')).machines;
  const server = ms.find((m) => m.name === 'server');
  await consoleTool(env, cookie, 'gw_machine_update', { id: server.id, tags: ['server'] });
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: { machine_tags: ['server'] }, resource: { connections: ['figma_rtp'], risks: ['read'] } });
  assert.match((await tool(env, k.key, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} })).error, /no rule permits/);
  assert.equal((await consoleTool(env, cookie, 'gw_key_update', { id: k.id, machine: 'server' })).ok, true);
  assert.equal((await rawTool(env, k.key, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} })).isError, false, 'moved key picks up the new machine tags at once');
  const mbp = ms.find((m) => m.name === 'mbp');
  await consoleTool(env, cookie, 'gw_machine_revoke', { id: mbp.id });
  assert.equal((await consoleTool(env, cookie, 'gw_key_update', { id: k.id, machine: 'mbp' })).ok, true, 'the revoked name is free again');
  const fresh = (await consoleTool(env, cookie, 'gw_machines')).machines.find((m) => m.name === 'mbp' && !m.revoked);
  assert.ok(fresh && fresh.id !== mbp.id, 'moving onto the name makes a new live machine, never the revoked one');
});

test('regression (UX): a revoked machine name can never be used again, so re-installing a lost laptop as "mbp" is impossible', async () => {
  const { env, cookie, uid } = await bootstrap();
  const adminAgent = (await createKey(env, { name: 'adm', role: 'admin', user_id: uid })).key;
  await tool(env, adminAgent, 'create_key', { name: 'codex@mbp', role: 'write', machine: 'mbp', agent: 'codex' });
  const mbp = (await consoleTool(env, cookie, 'gw_machines')).machines.find((m) => m.name === 'mbp');
  await consoleTool(env, cookie, 'gw_machine_revoke', { id: mbp.id });
  const start = await (await http(env, 'POST', '/device/code', { body: { machine: 'mbp', agent: 'claude-code' } })).json();
  const ok = await consoleTool(env, cookie, 'gw_device_approve', { user_code: start.user_code });
  assert.equal(ok.ok, true, `device login as mbp after revoke: ${JSON.stringify(ok)}`);
});

test('regression: admin_delete_user leaves the user\'s upstream credentials, connections, rules, machines and approvals behind', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, uid } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const sk = (await createKey(env, { name: 'super', role: 'super', user_id: uid })).key;
  const created = await tool(env, sk, 'admin_create_user', { handle: 'carol' });
  const path = new URL(created.invite_url).pathname;
  await http(env, 'GET', path);
  const carolKey = (await (await http(env, 'POST', path)).text()).match(/<pre>(bk_[A-Za-z0-9_-]+)<\/pre>/)[1];
  const carolCookie = await login(env, carolKey);
  const c = await consoleTool(env, carolCookie, 'gw_connection_create', { service: 'figma', label: 'mine', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(c.ok, true, JSON.stringify(c));
  await consoleTool(env, carolCookie, 'gw_connection_share', { id: c.id, with: 'yash' });
  const carol = q1(env, "SELECT id FROM users WHERE handle = 'carol'").id;
  const r = await tool(env, sk, 'admin_delete_user', { handle: 'carol', confirm: 'carol' });
  assert.equal(r.ok, true, JSON.stringify(r));
  // good: the share is dead because the owner is no longer active
  assert.equal((await consoleTool(env, await login(env, sk), 'gw_connection_shares')).incoming.filter((s) => s.accepted).length, 0);
  const left = {
    credentials: q(env, 'SELECT 1 FROM credentials WHERE connection_id = ?', c.id).length,
    connections: q(env, 'SELECT 1 FROM connections WHERE owner_id = ?', carol).length,
    grants: q(env, 'SELECT 1 FROM connection_grants WHERE connection_id = ?', c.id).length,
    rules: q(env, 'SELECT 1 FROM rules WHERE owner_id = ?', carol).length,
    tools: q(env, 'SELECT 1 FROM connection_tools WHERE connection_id = ?', c.id).length,
  };
  assert.deepEqual(left, { credentials: 0, connections: 0, grants: 0, rules: 0, tools: 0 }, 'the deleted user\'s upstream tokens are still in the vault');
});

test('regression: admin_delete_user purge orphans gateway rows (connections/credentials with no owner row)', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, uid } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const sk = (await createKey(env, { name: 'super', role: 'super', user_id: uid })).key;
  const created = await tool(env, sk, 'admin_create_user', { handle: 'dave' });
  const path = new URL(created.invite_url).pathname;
  await http(env, 'GET', path);
  const daveKey = (await (await http(env, 'POST', path)).text()).match(/<pre>(bk_[A-Za-z0-9_-]+)<\/pre>/)[1];
  const c = await consoleTool(env, await login(env, daveKey), 'gw_connection_create', { service: 'figma', label: 'x', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  await tool(env, sk, 'admin_delete_user', { handle: 'dave', confirm: 'dave', purge: true });
  const orphans = q(env, 'SELECT c.id FROM connections c LEFT JOIN users u ON u.id = c.owner_id WHERE u.id IS NULL').length
    + q(env, 'SELECT r.connection_id FROM credentials r LEFT JOIN connections c ON c.id = r.connection_id LEFT JOIN users u ON u.id = c.owner_id WHERE u.id IS NULL').length;
  assert.equal(orphans, 0, `connection ${c.id} survives its purged owner`);
});

test('lifecycle: status pending -> active -> auth_required -> active (bearer secret rotated)', async () => {
  let goodSecret = SECRET;
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, auth: (h) => h.authorization === `Bearer ${goodSecret}` });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'active');
  goodSecret = 'rotated-upstream-secret';
  const r = await tool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  assert.match(r.error, /upstream/);
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'auth_required');
  const blocked = await tool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  assert.match(blocked.error, /auth_required/);
  assert.ok(blocked.connect_url);
  await new Promise((res) => setTimeout(res, 1100)); // see the same-second bug below
  await consoleTool(env, cookie, 'gw_connection_update', { id: c.id, secret: goodSecret });
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'active');
  const ok = await rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  assert.equal(ok.isError, false, JSON.stringify(ok));
});

test('regression: rotating a secret within the same second as the previous store keeps the ConnectionDO session on the OLD secret', async () => {
  let goodSecret = 'right-secret';
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, auth: (h) => h.authorization === `Bearer ${goodSecret}` });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  // typo in the secret: the first sync fails 401 and the DO caches a session holding it
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: 'typo-secret' });
  assert.match(c.warning || '', /sync failed/);
  await consoleTool(env, cookie, 'gw_connection_update', { id: c.id, secret: goodSecret }); // same second
  const synced = await consoleTool(env, cookie, 'gw_connection_sync', { id: c.id });
  assert.equal(synced.ok, true, `sync after fixing the secret: ${JSON.stringify(synced)}`);
  assert.ok(agent);
});

test('regression: one upstream 403 on a single tool call flips the whole connection to auth_required', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const inner = figma.handler;
  figma.handler = async (req, rec) => {
    const m = rec.body ? JSON.parse(rec.body) : null;
    if (m?.method === 'tools/call' && m.params?.arguments?.nodeId === 'forbidden-file') return new Response('no access to this file', { status: 403 });
    return inner(req, rec);
  };
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': (req, rec) => figma.handler(req, rec) });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  await tool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: { nodeId: 'forbidden-file' } });
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'active', 'a per-resource 403 is not a dead credential');
});

test('regression: a successful manual sync does not clear auth_required (a transient 401 needs the secret re-entered)', async () => {
  let flaky = false;
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, auth: (h) => !flaky && h.authorization === `Bearer ${SECRET}` });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  flaky = true;
  await tool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  flaky = false;
  const s = await consoleTool(env, cookie, 'gw_connection_sync', { id: c.id });
  assert.equal(s.ok, true);
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'active');
});

test('lifecycle: scheduled() gateway sweep removes expired taint, flows, device codes; expires stale pending approvals; drops 90-day-old approvals', async () => {
  const { env, uid } = await bootstrap();
  const s = (sql, ...a) => env.DB.sqlite.prepare(sql).run(...a);
  s("INSERT INTO taint (key_id, label, source, exp) VALUES ('k1', 'untrusted', 'a', datetime('now', '-1 minute')), ('k1', 'private', 'a', datetime('now', '+1 hour'))");
  s("INSERT INTO connect_flows (state_hash, connection_id, user_id, session_hash, verifier, redirect_uri, exp) VALUES ('old', 'c', ?, 'h', 'v', 'r', datetime('now', '-1 minute')), ('new', 'c', ?, 'h', 'v', 'r', datetime('now', '+5 minutes'))", uid, uid);
  s("INSERT INTO device_codes (device_hash, user_code, machine, status, exp) VALUES ('d1', 'AAAA-AAAA', 'm', 'pending', datetime('now', '-1 minute')), ('d2', 'BBBB-BBBB', 'm', 'pending', datetime('now', '+5 minutes'))");
  const ap = (id, status, created, expires) => s(`INSERT INTO approvals (id, user_id, key_id, connection_id, tool, args_hash, status, created, expires) VALUES (?, ?, 'k', 'c', 't', 'h', ?, datetime('now', ?), datetime('now', ?))`, id, uid, status, created, expires);
  ap('ap_stale', 'pending', '-1 hour', '-30 minutes');
  s("UPDATE approvals SET args_hash = 'h-stale' WHERE id = 'ap_stale'");
  ap('ap_live', 'pending', '-1 minute', '+29 minutes');
  ap('ap_ancient', 'denied', '-100 days', '-99 days');
  ap('ap_used', 'approved', '-2 hours', '-1 hour');
  const ctx = fakeCtx();
  await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, env, ctx);
  await Promise.all(ctx.pending);
  assert.deepEqual(q(env, 'SELECT label FROM taint').map((r) => r.label), ['private']);
  assert.deepEqual(q(env, 'SELECT state_hash FROM connect_flows').map((r) => r.state_hash), ['new']);
  assert.deepEqual(q(env, 'SELECT device_hash FROM device_codes').map((r) => r.device_hash), ['d2']);
  const st = Object.fromEntries(q(env, 'SELECT id, status FROM approvals').map((r) => [r.id, r.status]));
  assert.equal(st.ap_stale, 'expired');
  assert.equal(st.ap_live, 'pending');
  assert.equal(st.ap_ancient, undefined);
  assert.equal(st.ap_used, 'expired', 'approved-but-expired rows are marked expired');
});

test('regression: the sweep never removes expired connection shares (grants with expires in the past linger forever)', async () => {
  const { env, uid } = await bootstrap();
  env.DB.sqlite.prepare("INSERT INTO connection_grants (connection_id, grantee_id, tools, expires, accepted, created) VALUES ('c_x', ?, '[]', datetime('now', '-1 day'), 1, datetime('now', '-30 days'))").run(uid);
  const ctx = fakeCtx();
  await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, env, ctx);
  await Promise.all(ctx.pending);
  assert.equal(q(env, 'SELECT * FROM connection_grants').length, 0);
});

/** Give every D1 query a network round trip, as real D1 has. Races need this to show. */
function addLatency(env, ms = 2) {
  const db = env.DB;
  const sleep = () => new Promise((r) => setTimeout(r, ms));
  const wrap = (st) => ({
    bind: (...a) => wrap(st.bind(...a)),
    first: async (c) => { await sleep(); return st.first(c); },
    all: async () => { await sleep(); return st.all(); },
    raw: async () => { await sleep(); return st.raw(); },
    run: async () => { await sleep(); return st.run(); },
    _exec: st._exec,
  });
  env.DB = { sqlite: db.sqlite, prepare: (sql) => wrap(db.prepare(sql)), batch: async (s) => { await sleep(); return db.batch(s); }, exec: db.exec };
  return env;
}

// ================================================================ 3. CONCURRENCY

test('regression: parallel call_tool on a cold ConnectionDO initializes the upstream MCP session once per call, not once', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, delayMs: 5 });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  env.CONNECTIONS.instances.clear(); // DO evicted: next calls hit a cold instance
  figma.sessions = 0;
  addLatency(env);
  const out = await Promise.all(Array.from({ length: 5 }, (_, i) => rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: { nodeId: String(i) } })));
  assert.ok(out.every((r) => r.isError === false), JSON.stringify(out.find((r) => r.isError)));
  assert.equal(figma.calls.length, 5);
  assert.equal(figma.sessions, 1, `${figma.sessions} upstream sessions opened for 5 parallel calls`);
});

async function oauthConn({ rotate = true } = {}) {
  let n = 0;
  const live = new Set(['rt-0']);
  const tokens = new Set();
  const tokenHits = [];
  const auth = async (req, rec) => {
    const f = new URLSearchParams(rec.body);
    tokenHits.push(f.get('refresh_token'));
    await new Promise((r) => setTimeout(r, 5));
    if (!live.has(f.get('refresh_token'))) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (rotate) live.delete(f.get('refresh_token'));
    n++;
    live.add(`rt-${n}`);
    tokens.add(`at-${n}`);
    return new Response(JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } });
  };
  const linear = fakeUpstream({ tools: [{ name: 'list_issues', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], auth: (h) => tokens.has((h.authorization || '').replace('Bearer ', '')) });
  const b = await bootstrap({ 'mcp.linear.test': linear.handler, 'auth.linear.test': auth });
  const { storeCredential } = await import('../src/vault.js');
  const c = await consoleTool(b.env, b.cookie, 'gw_connection_create', { service: 'linear', label: 'rtp', url: 'https://mcp.linear.test/mcp', auth: 'none' });
  const meta = { as: { issuer: 'https://auth.linear.test', token_endpoint: 'https://auth.linear.test/token', authorization_endpoint: 'https://auth.linear.test/authorize' }, resource: 'https://mcp.linear.test/mcp', client: { client_id: 'cid' } };
  b.env.DB.sqlite.prepare("UPDATE connections SET auth_kind = 'oauth', oauth = ?, status = 'active' WHERE id = ?").run(JSON.stringify(meta), c.id);
  b.env.DB.sqlite.prepare("INSERT INTO connection_tools (connection_id, name, input_schema, manifest_hash, approved_hash, risk, egress, state) VALUES (?, 'list_issues', '{}', 'h', 'h', 'read', 0, 'approved') ON CONFLICT DO NOTHING").run(c.id);
  await storeCredential(b.env, c.id, { access_token: 'at-expired', refresh_token: 'rt-0', expires_at: Date.now() - 1000, client_id: 'cid' });
  b.env.CONNECTIONS.instances.clear();
  return { ...b, c, linear, tokenHits };
}

test('concurrency: parallel calls with an expired OAuth token refresh exactly once (rotating refresh token survives)', async () => {
  const { env, agent, c, tokenHits } = await oauthConn();
  addLatency(env);
  const out = await Promise.all(Array.from({ length: 5 }, () => rawTool(env, agent, 'call_tool', { connection: 'linear_rtp', tool: 'list_issues', arguments: {} })));
  assert.deepEqual(out.map((r) => r.isError), [false, false, false, false, false], JSON.stringify(out.find((r) => r.isError !== false)));
  assert.deepEqual(tokenHits, ['rt-0'], 'one refresh');
  assert.equal(q1(env, 'SELECT status FROM connections WHERE id = ?', c.id).status, 'active');
});

test('regression: parallel identical calls open duplicate pending approvals (and send duplicate notifications)', async () => {
  const { env, cookie, agent } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message'] } });
  const args = { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } };
  const out = await Promise.all([1, 2, 3].map(() => tool(env, agent, 'call_tool', args)));
  const ids = new Set(out.map((r) => r.approval_id));
  assert.equal(q(env, "SELECT id FROM approvals WHERE status = 'pending'").length, 1, `pending rows for one request; ids returned: ${[...ids].join(',')}`);
});

test('regression: an approve-once approval is spent twice by two parallel calls (double send)', async () => {
  const { env, cookie, agent, gmail } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message'] } });
  const args = { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'a@b.c' } };
  const ap = await tool(env, agent, 'call_tool', args);
  await consoleTool(env, cookie, 'gw_approval_decide', { id: ap.approval_id, decision: 'approve' });
  addLatency(env);
  const out = await Promise.all([1, 2].map(() => rawTool(env, agent, 'call_tool', { ...args, approval_id: ap.approval_id })));
  const sent = gmail.calls.filter((c) => c.name === 'send_message').length;
  assert.equal(sent, 1, `approve-once let ${sent} emails out; results: ${JSON.stringify(out.map((r) => r.isError ?? r.content?.[0]?.text?.slice(0, 40)))}`);
});

test('regression: parallel gw_connection_create with the same service+label creates duplicates (no UNIQUE (owner_id, service, label))', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  addLatency(env);
  const out = await Promise.all([1, 2].map(() => consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET })));
  const rows = q(env, "SELECT id FROM connections WHERE service = 'figma' AND label = 'rtp'");
  const lc = await tool(env, agent, 'list_connections');
  assert.equal(rows.length, 1, `duplicates: ${JSON.stringify(out.map((o) => o.ok ?? o.error))}; list_connections shows ${lc.connections.map((c) => c.connection).join(', ')}`);
});

test('regression: two parallel /device/token polls both receive the freshly minted key', async () => {
  const { env, cookie } = await bootstrap();
  const start = await (await http(env, 'POST', '/device/code', { body: { machine: 'box', agent: 'cli' } })).json();
  await consoleTool(env, cookie, 'gw_device_approve', { user_code: start.user_code });
  const res = await Promise.all([1, 2].map(async () => (await http(env, 'POST', '/device/token', { body: { device_code: start.device_code } })).json()));
  const got = res.filter((r) => r.key);
  assert.equal(got.length, 1, `the key was handed out ${got.length} times`);
});

test('regression: concurrent syncs of a large manifest leave duplicate tool_fts rows (search shows a tool twice)', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: `widget number ${i}`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
  const up = fakeUpstream({ tools: many });
  const { env, cookie, agent } = await bootstrap({ 'big.test': up.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'big', label: 'one', url: 'https://big.test/mcp', auth: 'bearer', secret: SECRET });
  assert.equal(c.synced?.tools, 100, JSON.stringify(c));
  addLatency(env);
  await Promise.all([1, 2, 3].map(() => consoleTool(env, cookie, 'gw_connection_sync', { id: c.id })));
  const fts = q1(env, 'SELECT COUNT(*) AS n FROM tool_fts WHERE connection_id = ?', c.id).n;
  const dup = q1(env, 'SELECT name FROM tool_fts WHERE connection_id = ? GROUP BY name HAVING COUNT(*) > 1 LIMIT 1', c.id);
  const found = dup ? await tool(env, agent, 'search_tools', { query: dup.name.split('_')[1] }) : { results: [] };
  const names = found.results.map((r) => r.tool);
  assert.deepEqual({ fts, searchHits: names }, { fts: 100, searchHits: dup ? [dup.name] : [] });
});

// ================================================================ 4. LIMITS

const seedConnections = (env, uid, n, prefix = 'x') => {
  const ins = env.DB.sqlite.prepare("INSERT INTO connections (id, owner_id, service, label, transport, url, auth_kind, status, created) VALUES (?, ?, 'svc', ?, 'http', 'https://up.test/mcp', 'none', 'active', datetime('now'))");
  for (let i = 0; i < n; i++) ins.run(`c_${prefix}${i}`, uid, `${prefix}${i}`);
};

test('limits: the 61st connection is refused', async () => {
  const up = fakeUpstream({ tools: FIGMA_TOOLS, auth: () => true });
  const { env, uid, cookie } = await bootstrap({ 'up.test': up.handler });
  seedConnections(env, uid, 59);
  assert.equal((await consoleTool(env, cookie, 'gw_connection_create', { service: 'svc', label: 'last', url: 'https://up.test/mcp', auth: 'none' })).ok, true);
  assert.match((await consoleTool(env, cookie, 'gw_connection_create', { service: 'svc', label: 'over', url: 'https://up.test/mcp', auth: 'none' })).error, /limit reached \(60\)/);
});

test('regression: parallel creates at the cap overshoot the 60-connection limit (count-then-insert race)', async () => {
  const up = fakeUpstream({ tools: FIGMA_TOOLS, auth: () => true });
  const { env, uid, cookie } = await bootstrap({ 'up.test': up.handler });
  seedConnections(env, uid, 59);
  addLatency(env);
  await Promise.all(['a', 'b', 'c', 'd'].map((l) => consoleTool(env, cookie, 'gw_connection_create', { service: 'svc', label: `p${l}`, url: 'https://up.test/mcp', auth: 'none' })));
  assert.equal(q1(env, 'SELECT COUNT(*) AS n FROM connections WHERE owner_id = ?', uid).n, 60);
});

test('regression: the auto "read" rule from gw_connection_create bypasses the 300-rule cap', async () => {
  const up = fakeUpstream({ tools: FIGMA_TOOLS, auth: () => true });
  const { env, uid, cookie } = await bootstrap({ 'up.test': up.handler });
  const ins = env.DB.sqlite.prepare("INSERT INTO rules (id, owner_id, effect, subject, resource, created, updated) VALUES (?, ?, 'permit', '{}', '{}', datetime('now'), datetime('now'))");
  for (let i = 0; i < 299; i++) ins.run(`r_seed${i}`, uid);
  assert.equal((await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { risks: ['read'] } })).ok, true);
  assert.match((await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { risks: ['read'] } })).error, /rule limit/);
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'svc', label: 'a', url: 'https://up.test/mcp', auth: 'none' });
  assert.equal(q1(env, 'SELECT COUNT(*) AS n FROM rules WHERE owner_id = ?', uid).n, 300);
});

test('regression: gw_device_approve mints a key past the 20-live-keys limit that create_key enforces', async () => {
  const { env, uid, cookie } = await bootstrap();
  const ins = env.DB.sqlite.prepare("INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, revoked, user_id) VALUES (?, ?, 'seed', 'read', '[]', datetime('now'), 0, ?)");
  const live = () => q1(env, "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked = 0", uid).n;
  for (let i = live(); i < 20; i++) ins.run(`k_seed${i}`, `h${i}`, uid);
  const adm = q1(env, "SELECT id FROM api_keys WHERE user_id = ? AND role = 'admin' LIMIT 1", uid);
  assert.ok(adm);
  const start = await (await http(env, 'POST', '/device/code', { body: { machine: 'box' } })).json();
  const r = await consoleTool(env, cookie, 'gw_device_approve', { user_code: start.user_code });
  assert.ok(r.error && live() === 20, `device approval minted key #${live()}: ${JSON.stringify(r)}`);
});

test('regression: pending approvals have no per-key cap: one agent can queue hundreds (and page the human for each)', async () => {
  const { env, cookie, agent } = await gmailSetup();
  await consoleTool(env, cookie, 'gw_rule_put', { effect: 'permit', subject: {}, resource: { connections: ['gmail_rtp'], tools: ['send_message'] } });
  for (let i = 0; i < 120; i++) await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: `${i}@x.y` } });
  const pending = q1(env, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").n;
  const shown = (await consoleTool(env, cookie, 'gw_approvals', { status: 'pending' })).approvals.length;
  assert.ok(pending <= 50, `${pending} pending approvals for one key; the console shows ${shown}`);
});

test('regression (verify on real D1): syncing a 500-tool server issues >1000 D1 statements in one invocation (600-tool server is capped at 500)', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ name: `t${i}`, description: 'd'.repeat(5000), inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
  const up = fakeUpstream({ tools: many, auth: () => true });
  const { env, cookie } = await bootstrap({ 'up.test': up.handler });
  let statements = 0;
  const batches = [];
  const db = env.DB;
  env.DB = { ...db, sqlite: db.sqlite, prepare: (sql) => { const st = db.prepare(sql); const w = (s) => ({ ...s, bind: (...a) => w(s.bind(...a)), first: (c) => { statements++; return s.first(c); }, all: () => { statements++; return s.all(); }, run: () => { statements++; return s.run(); } }); return w(st); },
    batch: (s) => { statements += s.length; batches.push(s.length); return db.batch(s); } };
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'big', label: 'x', url: 'https://up.test/mcp', auth: 'none' });
  assert.equal(c.synced.tools, 500);
  assert.equal(q1(env, 'SELECT COUNT(*) AS n FROM tool_fts').n, 500);
  assert.ok(Math.max(...batches) <= 100, `largest batch ${Math.max(...batches)}`);
  assert.equal(q1(env, 'SELECT MAX(length(description)) AS n FROM connection_tools').n, 4000);
  // D1 (Workers Paid) allows 1000 queries per invocation. Report the number; assert it.
  assert.ok(statements <= 1000, `one gw_connection_create issued ${statements} D1 statements in ${batches.length} batches`);
});

test('regression: syncTools splits its writes across several batches, so a failure mid-way leaves tool_fts half rebuilt', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: `gadget ${i}`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
  const up = fakeUpstream({ tools: many, auth: () => true });
  const { env, cookie, agent } = await bootstrap({ 'up.test': up.handler });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'big', label: 'x', url: 'https://up.test/mcp', auth: 'none' });
  let n = 0;
  const db = env.DB;
  env.DB = { ...db, sqlite: db.sqlite, prepare: db.prepare, batch: (s) => { if (++n === 1) throw new Error('D1_ERROR: storage operation exceeded timeout'); return db.batch(s); } };
  const r = await consoleTool(env, cookie, 'gw_connection_sync', { id: c.id });
  assert.ok(r.error, 'precondition: the sync failed');
  env.DB = db;
  const fts = q1(env, 'SELECT COUNT(*) AS n FROM tool_fts WHERE connection_id = ?', c.id).n;
  const hit = await tool(env, agent, 'search_tools', { query: '95' });
  assert.deepEqual({ fts, found95: hit.results.length }, { fts: 100, found95: 1 });
});

test('limits: search_tools across 60 connections x 500 tools (30k fts rows) answers via json_each IN-list', async () => {
  const { env, uid, agent } = await bootstrap();
  seedConnections(env, uid, 60, 'z');
  const t = env.DB.sqlite.prepare("INSERT INTO connection_tools (connection_id, name, input_schema, manifest_hash, approved_hash, risk, egress, state) VALUES (?, ?, '{}', 'h', 'h', 'read', 0, 'approved')");
  const f = env.DB.sqlite.prepare('INSERT INTO tool_fts (connection_id, name, text) VALUES (?, ?, ?)');
  env.DB.sqlite.exec('BEGIN');
  for (let c = 0; c < 60; c++) for (let i = 0; i < 500; i++) { t.run(`c_z${c}`, `t${i}`); f.run(`c_z${c}`, `t${i}`, `t${i} common thing number${i}`); }
  env.DB.sqlite.exec('COMMIT');
  env.DB.sqlite.prepare("INSERT INTO rules (id, owner_id, effect, subject, resource, created, updated) VALUES ('r_all', ?, 'permit', '{}', '{\"risks\":[\"read\"]}', datetime('now'), datetime('now'))").run(uid);
  const t0 = Date.now();
  const r = await tool(env, agent, 'search_tools', { query: 'number499', limit: 30 });
  const ms = Date.now() - t0;
  assert.equal(r.results.length, 30);
  assert.ok(ms < 3000, `${ms} ms`);
});
