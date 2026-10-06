// Evaluation: MCP protocol surface, memory features (supersession, budgets, hybrid
// search, embeddings), OAuth server additions (CIMD, iss), and regressions.
// Tests named "regression: ..." pin defects found in evaluation, now fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fakeEnv, fakeCtx, stubFetch } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { upsertLocal } from '../src/indexer.js';
import { createKey } from '../src/auth.js';
import { handleOauth } from '../src/oauth.js';
import { spaceStore } from '../src/store.js';
import { fitContext, liveDecisions, rrfFuse, embedPending, estimateTokens } from '../src/memory.js';

const O = 'https://brain.test';
let net = stubFetch();

const NOTES = {
  'vault/projects/pulse.md': '---\ntype: project\nproject: pulse\nstatus: active\nupdated: 2026-10-01\n---\n# pulse\nPulse plan.',
  'vault/projects/other.md': '---\ntype: project\nproject: other\nstatus: active\nupdated: 2026-10-01\n---\n# other\nOther plan.',
  'vault/topics/cache.md': '---\ntype: topic\ntitle: Edge caching\n---\nWe keep hot data near users with a write-through layer.',
  'vault/topics/latency.md': '---\ntype: topic\ntitle: Response time budget\n---\nThe p99 target is 200 ms for reads. zeppelin',
  'vault/notes/pulse-zeppelin.md': '---\ntype: note\nproject: pulse\n---\nPulse zeppelin design.',
  'vault/logs/sessions/2026-10-01_120000_abc.md': '---\ntype: session\nproject: "[[projects/pulse]]"\nsummary: zeppelin day\n---\nzeppelin zeppelin session log',
  'vault/logs/decisions.md': '# Decisions\n',
  'skills/unslop/SKILL.md': '---\nname: unslop\ndescription: cut slop\n---\nUNSLOP BODY',
  'skills/secret/SKILL.md': '---\nname: secret\ndescription: firm only\n---\nSECRET BODY',
  'vault/skills.md': '---\ntype: config\n---\n# Skills\n\ndefault: unslop\n',
};

async function setup(extra = {}) {
  const env = fakeEnv(extra.env || {});
  const gh = fakeGitHub(env, { ...NOTES });
  net.restore();
  net = stubFetch(async (req, rec) => gh.handler(req, rec));
  for (const [p, t] of Object.entries(NOTES)) await upsertLocal(env, p, t);
  await call(env, env.BRAIN_TOKEN, 'whoami');
  const uid = env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
  return { env, gh, uid };
}

const http = async (env, method, path, token, init = {}) => {
  const ctx = fakeCtx();
  const res = await worker.fetch(new Request(O + path, { method, ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...init.headers } }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
};
async function rpcRaw(env, token, body) {
  const res = await http(env, 'POST', '/mcp', token, { body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function rpc(env, token, method, params, id = 1) {
  return (await rpcRaw(env, token, { jsonrpc: '2.0', id, method, params })).body;
}
async function call(env, token, name, args = {}) {
  const r = (await rpc(env, token, 'tools/call', { name, arguments: args })).result;
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

async function superKey(env, uid) {
  return (await createKey(env, { name: 'super', role: 'super', user_id: uid })).key;
}
async function onboard(env, sk, handle) {
  const created = await call(env, sk, 'admin_create_user', { handle });
  assert.equal(created.ok, true, JSON.stringify(created));
  const path = new URL(created.invite_url).pathname;
  const html = await (await http(env, 'POST', path)).text();
  return html.match(/<pre>(bk_[A-Za-z0-9_-]+)<\/pre>/)[1];
}

// --------------------------------------------------------------- fake AI / Vectorize

function fakeAi() {
  const dims = 4096;
  const syn = { airship: 'zeppelin', blimp: 'zeppelin', speed: 'latency' };
  const vec = (t) => {
    const v = new Array(dims).fill(0);
    for (const w of String(t).toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 2)) {
      v[createHash('md5').update(syn[w] || w).digest().readUInt16BE(0) % dims] += 1;
    }
    return v;
  };
  return { calls: 0, async run(model, { text }) { this.calls++; return { data: text.map(vec) }; } };
}
function fakeVectorize() {
  const rows = new Map();
  const cos = (a, b) => {
    let d = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    return d / (Math.sqrt(na * nb) || 1);
  };
  return {
    rows,
    async upsert(vs) { for (const v of vs) rows.set(v.id, v); },
    async deleteByIds(ids) { for (const id of ids) rows.delete(id); },
    async query(vector, { topK, namespace }) {
      return { matches: [...rows.values()].filter((r) => r.namespace === namespace).map((r) => ({ id: r.id, score: cos(vector, r.values) })).sort((a, b) => b.score - a.score).slice(0, topK) };
    },
  };
}
const embedAll = async (env) => {
  const spaces = env.DB.sqlite.prepare("SELECT * FROM spaces WHERE status = 'active'").all().map((r) => ({ ...r }));
  return embedPending(env, spaces, (s) => spaceStore(env, s));
};
async function semanticSetup() {
  const AI = fakeAi();
  const VECTORS = fakeVectorize();
  const s = await setup({ env: { AI, VECTORS } });
  return { ...s, AI, VECTORS };
}

// =============================================================== 1. scope leaks

test('hybrid search: a path-scoped key never gets semantic hits outside its prefixes', async () => {
  const { env, uid } = await semanticSetup();
  await embedAll(env);
  const k = await createKey(env, { name: 'topics', role: 'read', user_id: uid, prefixes: ['vault/topics/cache.md'] });
  const r = await call(env, k.key, 'search', { q: 'airship', include_logs: true });
  assert.equal(r.mode, 'hybrid');
  assert.ok(r.results.every((x) => x.path === 'vault/topics/cache.md'), JSON.stringify(r.results.map((x) => x.path)));
});

test('hybrid search: a project-scoped key sees only its project notes semantically', async () => {
  const { env, uid } = await semanticSetup();
  await embedAll(env);
  const k = await createKey(env, { name: 'pulse', role: 'read', user_id: uid, prefixes: ['project:pulse'] });
  const r = await call(env, k.key, 'search', { q: 'airship', include_logs: true });
  const paths = r.results.map((x) => x.path);
  assert.ok(paths.includes('vault/notes/pulse-zeppelin.md'), JSON.stringify(paths));
  assert.ok(!paths.includes('vault/topics/latency.md'));
  assert.ok(paths.every((p) => p === 'vault/projects/pulse.md' || p.startsWith('vault/notes/pulse') || p.startsWith('vault/logs/sessions/')), JSON.stringify(paths));
});

test('hybrid search: session logs stay out unless include_logs; type/project filters apply to semantic hits', async () => {
  const { env } = await semanticSetup();
  await embedAll(env);
  const plain = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', limit: 50 });
  assert.ok(plain.results.every((x) => x.type !== 'session'), JSON.stringify(plain.results.map((x) => x.path)));
  const logs = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', include_logs: true, limit: 50 });
  assert.ok(logs.results.some((x) => x.type === 'session'));
  const typed = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', type: 'topic', limit: 50 });
  assert.ok(typed.results.length && typed.results.every((x) => x.type === 'topic'), JSON.stringify(typed.results));
  const proj = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', project: 'pulse', limit: 50 });
  assert.ok(proj.results.every((x) => x.project === 'pulse'), JSON.stringify(proj.results.map((x) => [x.path, x.project])));
});

test('regression: hybrid search ignores the folder filter for semantic hits (and lets session logs in with it)', async () => {
  const { env } = await semanticSetup();
  await embedAll(env);
  const r = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', folder: 'vault/topics/', limit: 50 });
  const paths = r.results.map((x) => x.path);
  assert.ok(paths.every((p) => p.startsWith('vault/topics/')), `folder vault/topics/ returned ${JSON.stringify(paths)}`);
});

test('regression: hybrid search returns unrelated notes: semantic hits have no similarity floor', async () => {
  const { env } = await semanticSetup();
  await embedAll(env);
  // cache.md shares no word (or synonym) with the query; FTS finds nothing for it either
  const r = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', limit: 50 });
  assert.ok(!r.results.some((x) => x.path === 'vault/topics/cache.md'), JSON.stringify(r.results.map((x) => x.path)));
});

test('hybrid search: other users, share grantees and space-limited keys stay inside their reach', async () => {
  const { env, uid } = await semanticSetup();
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  const bob = await onboard(env, sk, 'bob');
  await call(env, alice, 'create_project', { slug: 'garden', goal: 'zeppelin garden' });
  await call(env, alice, 'create_project', { slug: 'diary', goal: 'zeppelin diary secret' });
  assert.equal((await call(env, alice, 'create_space', { handle: 'team' })).ok, true);
  assert.equal((await call(env, alice, 'update_note', { space: '@team', path: 'vault/topics/t.md', content: '---\ntype: topic\n---\nteam zeppelin' })).ok, true);
  await call(env, alice, 'share', { project: 'garden', with: 'bob', role: 'viewer' });
  await call(env, bob, 'accept', { space: '@alice', project: 'garden' });
  const emb = await embedAll(env);
  assert.ok(emb.embedded > 5);

  const yash = await call(env, env.BRAIN_TOKEN, 'search', { q: 'airship', limit: 50 });
  assert.ok(yash.results.every((x) => x.space === '@yash'), JSON.stringify(yash.results.map((x) => x.space)));

  const b = await call(env, bob, 'search', { q: 'airship', limit: 50, include_logs: true });
  const bobAlice = b.results.filter((x) => x.space === '@alice').map((x) => x.path);
  assert.ok(bobAlice.includes('vault/projects/garden.md'), JSON.stringify(b.results));
  assert.ok(!bobAlice.includes('vault/projects/diary.md'));
  assert.ok(b.results.every((x) => x.space === '@alice' || x.space === '@bob'));

  const limited = await call(env, alice, 'create_key', { name: 'just-me', role: 'read', spaces: ['@alice'] });
  const l = await call(env, limited.key, 'search', { q: 'airship', limit: 50 });
  assert.ok(l.results.length > 0);
  assert.ok(l.results.every((x) => x.space === '@alice'), JSON.stringify(l.results.map((x) => x.space)));
  const full = await call(env, alice, 'search', { q: 'airship', limit: 50 });
  assert.ok(full.results.some((x) => x.space === '@team'), 'unlimited key reaches the team space');
});

test('resources/list and resources/read never expose skills the key cannot read', async () => {
  const { env, uid } = await setup();
  const all = (await rpc(env, env.BRAIN_TOKEN, 'resources/list')).result.resources.map((r) => r.name);
  assert.ok(all.includes('secret') && all.includes('unslop'));
  const scoped = await createKey(env, { name: 'topics', role: 'read', user_id: uid, prefixes: ['vault/topics/'] });
  const names = (await rpc(env, scoped.key, 'resources/list')).result.resources.map((r) => r.name);
  assert.ok(!names.includes('secret'), JSON.stringify(names));
  const read = await rpc(env, scoped.key, 'resources/read', { uri: 'brain://skills/secret' });
  assert.ok(read.error, JSON.stringify(read));
  assert.equal((await call(env, scoped.key, 'get_skill', { name: 'secret' })).error !== undefined, true);
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  const aliceNames = (await rpc(env, alice, 'resources/list')).result.resources.map((r) => r.name);
  assert.ok(!aliceNames.includes('secret'), JSON.stringify(aliceNames));
  assert.ok((await rpc(env, alice, 'resources/read', { uri: 'brain://skills/secret' })).error);
  assert.match((await rpc(env, alice, 'resources/read', { uri: 'brain://skills/unslop' })).result.contents[0].text, /UNSLOP/);
});

test('regression: resources/list advertises a config-bound skill that resources/read then refuses', async () => {
  const { env, uid } = await setup();
  // a skill bound by the default row after @system was seeded lives only in the owner's space
  await upsertLocal(env, 'skills/prove/SKILL.md', '---\nname: prove\ndescription: prove it\n---\nPROVE BODY');
  await upsertLocal(env, 'vault/skills.md', '---\ntype: config\n---\n# Skills\n\ndefault: unslop, prove\n');
  const scoped = await createKey(env, { name: 'topics', role: 'read', user_id: uid, prefixes: ['vault/topics/'] });
  const listed = (await rpc(env, scoped.key, 'resources/list')).result.resources.map((r) => r.uri);
  for (const uri of listed) {
    const r = await rpc(env, scoped.key, 'resources/read', { uri });
    assert.ok(r.result, `${uri} is listed but read fails: ${JSON.stringify(r.error)}`);
  }
});

test('get_context connections lists only the caller\'s own and accepted, unexpired shared connections', async () => {
  const { env, uid } = await setup();
  const sk = await superKey(env, uid);
  await onboard(env, sk, 'alice');
  const aliceId = env.DB.sqlite.prepare("SELECT id FROM users WHERE handle = 'alice'").get().id;
  const ins = env.DB.sqlite.prepare("INSERT INTO connections (id, owner_id, service, label, transport, url, auth_kind, account, status, created) VALUES (?, ?, ?, ?, 'http', 'https://up.test/mcp', 'none', ?, 'active', datetime('now'))");
  ins.run('c1', uid, 'figma', 'rtp', 'yash@figma');
  ins.run('c2', aliceId, 'gmail', 'personal', 'alice@gmail');
  ins.run('c3', aliceId, 'slack', 'work', 'alice@slack');
  ins.run('c4', aliceId, 'linear', 'old', 'alice@linear');
  env.DB.sqlite.prepare("INSERT INTO connection_grants (connection_id, grantee_id, accepted, created) VALUES ('c2', ?, 0, datetime('now'))").run(uid);
  env.DB.sqlite.prepare("INSERT INTO connection_grants (connection_id, grantee_id, accepted, created) VALUES ('c3', ?, 1, datetime('now'))").run(uid);
  env.DB.sqlite.prepare("INSERT INTO connection_grants (connection_id, grantee_id, accepted, expires, created) VALUES ('c4', ?, 1, datetime('now', '-1 day'), datetime('now'))").run(uid);
  const ctx = await call(env, env.BRAIN_TOKEN, 'get_context', {});
  const accounts = ctx.connections.map((c) => c.account).sort();
  assert.deepEqual(accounts, ['alice@slack', 'yash@figma']);
  assert.ok(ctx.trust.data.includes('connections'));
});

test('check_brain consolidation respects key scope', async () => {
  const { env, uid } = await setup();
  await upsertLocal(env, 'vault/topics/edge-cache.md', '---\ntype: topic\ntitle: Edge caching\n---\nWe keep hot data near users with a write-through layer.');
  await upsertLocal(env, 'vault/private/a.md', '---\ntype: topic\ntitle: Hidden twin\n---\nsecret twin words alpha beta gamma');
  await upsertLocal(env, 'vault/private/b.md', '---\ntype: topic\ntitle: Hidden twin\n---\nsecret twin words alpha beta gamma');
  const k = await createKey(env, { name: 'topics', role: 'read', user_id: uid, prefixes: ['vault/topics/'] });
  const r = await call(env, k.key, 'check_brain');
  const flat = r.consolidation.duplicate_topics.flatMap((d) => d.notes);
  assert.ok(flat.includes('vault/topics/edge-cache.md'));
  assert.ok(flat.every((p) => p.startsWith('vault/topics/')), JSON.stringify(flat));
});

// =============================================================== 2. MCP protocol

test('initialize: capabilities, server info and instructions', async () => {
  const { env } = await setup();
  const r = (await rpc(env, env.BRAIN_TOKEN, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.ok(r.capabilities.tools && r.capabilities.resources);
  assert.equal(r.serverInfo.name, 'brain-mcp');
  assert.match(r.instructions, /get_context/);
  const noVer = (await rpc(env, env.BRAIN_TOKEN, 'initialize', {})).result;
  assert.equal(noVer.protocolVersion, '2025-06-18');
});

test('regression: initialize echoes any protocolVersion the client sends, even ones the server cannot speak', async () => {
  const { env } = await setup();
  const r = (await rpc(env, env.BRAIN_TOKEN, 'initialize', { protocolVersion: 'not-a-version' })).result;
  assert.notEqual(r.protocolVersion, 'not-a-version');
});

test('regression: every tool in tools/list carries annotations (tenant tools have none)', async () => {
  const { env } = await setup();
  const tools = (await rpc(env, env.BRAIN_TOKEN, 'tools/list')).result.tools;
  const brainTools = ['get_context', 'search', 'read_note', 'save', 'check_brain', 'get_skill'];
  for (const n of brainTools) assert.ok(tools.find((t) => t.name === n)?.annotations, n);
  assert.equal(tools.find((t) => t.name === 'search').annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'update_note').annotations.destructiveHint, true);
  const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
  assert.deepEqual(missing, [], `tools without annotations: ${missing.join(', ')}`);
});

test('tools/call: structuredContent equals the parsed text, isError iff result.error', async () => {
  const { env } = await setup();
  for (const [name, args] of [['whoami', {}], ['get_context', { project: 'pulse' }], ['search', { q: 'caching' }], ['read_note', { path: 'vault/topics/cache.md' }],
    ['read_note', { path: 'vault/nope.md' }], ['list_notes', { folder: 'vault/topics/' }], ['check_brain', {}], ['get_skill', { name: 'nope' }], ['list_keys', {}]]) {
    const r = (await rpc(env, env.BRAIN_TOKEN, 'tools/call', { name, arguments: args })).result;
    const parsed = JSON.parse(r.content[0].text);
    assert.equal(r.content[0].type, 'text');
    assert.deepEqual(r.structuredContent, parsed, name);
    assert.equal(r.isError, !!parsed.error, `${name} isError`);
  }
  const unknown = (await rpc(env, env.BRAIN_TOKEN, 'tools/call', { name: 'nope_tool', arguments: {} })).result;
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown tool/);
  const noName = (await rpc(env, env.BRAIN_TOKEN, 'tools/call', {})).result;
  assert.equal(noName.isError, true);
  const forbidden = await createKey(env, { name: 'r', role: 'read', user_id: env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id });
  const denied = (await rpc(env, forbidden.key, 'tools/call', { name: 'update_note', arguments: { path: 'vault/x.md', content: 'x' } })).result;
  assert.equal(denied.isError, true);
  assert.match(JSON.parse(denied.content[0].text).error, /forbidden/);
});

test('JSON-RPC batches, notifications, unknown methods, ping, prompts/list', async () => {
  const { env } = await setup();
  const batch = await rpcRaw(env, env.BRAIN_TOKEN, [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'no/such' },
    42,
    { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
    { jsonrpc: '2.0', method: 'no/such/notification' },
    { jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'read_note', arguments: { path: 'vault/topics/cache.md' } } },
  ]);
  assert.equal(batch.status, 200);
  const byId = new Map(batch.body.map((r) => [r.id, r]));
  assert.equal(batch.body.length, 5);
  assert.deepEqual(byId.get(1).result, {});
  assert.equal(byId.get(2).error.code, -32601);
  assert.equal(byId.get(null).error.code, -32600);
  assert.deepEqual(byId.get(3).result, { prompts: [] });
  assert.equal(byId.get('x').result.structuredContent.path, 'vault/topics/cache.md');
  const onlyNotes = await rpcRaw(env, env.BRAIN_TOKEN, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(onlyNotes.status, 202);
  assert.equal((await rpcRaw(env, env.BRAIN_TOKEN, [])).status, 400);
  assert.equal((await rpcRaw(env, env.BRAIN_TOKEN, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))).status, 400);
  assert.equal((await rpcRaw(env, env.BRAIN_TOKEN, '{not json')).status, 400);
  const single = await rpcRaw(env, env.BRAIN_TOKEN, { jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.ok(!Array.isArray(single.body));
  assert.deepEqual((await rpc(env, env.BRAIN_TOKEN, 'resources/templates/list')).result, { resourceTemplates: [] });
  assert.equal((await rpcRaw(env, 'bad-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('resources/read rejects traversal, encoded and foreign URIs without reaching GitHub', async () => {
  const { env } = await setup();
  net.calls.length = 0;
  for (const uri of ['brain://skills/../x', 'brain://skills/..', 'brain://skills/.', 'brain://skills/%2e%2e', 'brain://skills/unslop/../../vault/topics/cache.md',
    'brain://skills/%2e%2e%2fvault', 'file:///etc/passwd', 'brain://skills/', 'brain://notes/vault/topics/cache.md', '', 'brain://skills/unslop\n']) {
    const r = await rpc(env, env.BRAIN_TOKEN, 'resources/read', { uri });
    assert.ok(r.error, `${JSON.stringify(uri)} -> ${JSON.stringify(r)}`);
  }
  assert.ok((await rpc(env, env.BRAIN_TOKEN, 'resources/read', {})).error);
  assert.equal(net.calls.length, 0, JSON.stringify(net.calls.map((c) => c.url)));
  const ok = (await rpc(env, env.BRAIN_TOKEN, 'resources/read', { uri: 'brain://skills/unslop' })).result;
  assert.equal(ok.contents[0].uri, 'brain://skills/unslop');
  assert.equal(ok.contents[0].mimeType, 'text/markdown');
});

// =============================================================== 3. memory

const block = (date, title, { chosen = title, project = 'pulse', sup = null } = {}) =>
  `### [${date}] ${title}\n- **Chosen:** ${chosen}\n- **Why:** w\n- **Project:** [[projects/${project}]]\n${sup ? `- **Supersedes:** ${sup}\n` : ''}`;
const titles = (bs) => bs.map((b) => /^### \[[^\]]*\] (.*)$/m.exec(b)[1]);

test('liveDecisions: truncated titles, [date] prefixes, case and whitespace, chains', () => {
  const long = 'Adopt a very long decision title that keeps going well past the ninety character cutoff for sure yes';
  const trunc = `${long.slice(0, 90)}…`;
  assert.deepEqual(titles(liveDecisions([block('2026-01-01', trunc, { chosen: long }), block('2026-02-01', 'Replace it', { sup: long })])), ['Replace it']);
  assert.deepEqual(titles(liveDecisions([block('2026-01-01', trunc, { chosen: long }), block('2026-02-01', 'Replace it', { sup: trunc })])), ['Replace it']);
  assert.deepEqual(titles(liveDecisions([block('2026-01-01', 'Use Postgres'), block('2026-02-01', 'Go D1', { sup: '[2026-01-01] Use Postgres' })])), ['Go D1']);
  assert.deepEqual(titles(liveDecisions([block('2026-01-01', 'Use   Postgres  Now'), block('2026-02-01', 'Go D1', { sup: '  use postgres now ' })])), ['Go D1']);
  const chain = [block('2026-01-01', 'Plan A'), block('2026-02-01', 'Plan B', { sup: 'Plan A' }), block('2026-03-01', 'Plan C', { sup: 'Plan B' })];
  assert.deepEqual(titles(liveDecisions(chain)), ['Plan C']);
  assert.deepEqual(liveDecisions([block('2026-01-01', 'X', { sup: '[2026-01-01]' })]).length, 1, 'an empty reference hides nothing');
});

test('regression: a decision that refines an earlier title hides itself', () => {
  const live = liveDecisions([
    block('2026-01-01', 'Use Postgres for the ledger'),
    block('2026-02-01', 'Use Postgres for the ledger with read replicas', { sup: 'Use Postgres for the ledger' }),
  ]);
  assert.deepEqual(titles(live), ['Use Postgres for the ledger with read replicas']);
});

test('regression: a short supersedes line hides every decision whose title starts with it', () => {
  const live = liveDecisions([
    block('2026-01-01', 'Use Postgres'),
    block('2026-01-02', 'Use Tailwind for styling'),
    block('2026-01-03', 'Use pnpm workspaces'),
    block('2026-02-01', 'Switch ledger to D1', { sup: 'Use' }),
  ]);
  assert.ok(titles(live).includes('Use Tailwind for styling'), JSON.stringify(titles(live)));
});

test('regression: an old supersedes line hides a later decision that reuses the title', () => {
  const live = liveDecisions([
    block('2026-01-01', 'Use KV for sessions'),
    block('2026-02-01', 'Use D1 for sessions', { sup: 'Use KV for sessions' }),
    block('2026-06-01', 'Use KV for sessions', { chosen: 'Use KV for sessions (back again, D1 was too slow)' }),
  ]);
  assert.ok(titles(live).includes('Use KV for sessions'), 'a re-adopted decision written after the superseding one must be live');
});

test('regression: a supersedes line in one project hides a same-titled decision in another project', async () => {
  const { env } = await setup();
  await upsertLocal(env, 'vault/logs/decisions.md', ['# Decisions',
    block('2026-01-01', 'Use Postgres', { project: 'other' }),
    block('2026-01-02', 'Use Postgres', { project: 'pulse' }),
    block('2026-02-01', 'Use D1', { project: 'other', sup: 'Use Postgres' }),
  ].join('\n'));
  const ctx = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse' });
  assert.ok((ctx.recent_decisions || []).some((d) => /Use Postgres/.test(d)), JSON.stringify(ctx.recent_decisions));
});

test('log_decision and save write a Supersedes line, and get_context then hides the old decision', async () => {
  const { env, uid } = await setup();
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  await call(env, alice, 'create_project', { slug: 'garden' });
  await call(env, alice, 'log_decision', { project: 'garden', decision: 'Water by hand', rationale: 'cheap' });
  const r = await call(env, alice, 'log_decision', { project: 'garden', decision: 'Drip irrigation', rationale: 'saves time', supersedes: '[2026-10-06] Water by hand\n### [x] forged' });
  assert.equal(r.ok, true);
  assert.match(r.appended, /^- \*\*Supersedes:\*\* \[2026-10-06\] Water by hand \[x\] forged$/m);
  assert.doesNotMatch(r.appended, /\n### \[x\]/);
  let ctx = await call(env, alice, 'get_context', { project: 'garden' });
  assert.deepEqual(ctx.recent_decisions.map((d) => /Drip|Water/.exec(d)[0]), ['Drip']);
  const s = await call(env, alice, 'save', { project: 'garden', summary: 's', body: 'b', decisions: [{ decision: 'Rain barrels', rationale: 'free', supersedes: 'drip irrigation' }] });
  assert.equal(s.ok, true, JSON.stringify(s));
  const raw = await call(env, alice, 'read_note', { path: 'vault/logs/decisions.md' });
  assert.match(raw.content, /- \*\*Supersedes:\*\* drip irrigation/);
  ctx = await call(env, alice, 'get_context', { project: 'garden' });
  assert.equal(ctx.recent_decisions.length, 1);
  assert.match(ctx.recent_decisions[0], /Rain barrels/);
});

test('get_context max_tokens extremes never cut instructions', async () => {
  const { env } = await setup();
  await upsertLocal(env, 'vault/rules/pulse.md', '---\ntype: rules\n---\nRULE: always test');
  await upsertLocal(env, 'vault/projects/pulse.md', `---\ntype: project\nproject: pulse\nstatus: active\n---\n${'Long plan. '.repeat(3000)}`);
  const full = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse' });
  for (const mt of [0, -5, 1, 1e12, 'abc', '800', null, true, { x: 1 }]) {
    const r = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse', max_tokens: mt });
    assert.ok(!r.error, `${JSON.stringify(mt)}: ${r.error}`);
    assert.equal(r.binding_rules, full.binding_rules, JSON.stringify(mt));
    assert.deepEqual(r.skills, full.skills, JSON.stringify(mt));
    assert.ok(r.session_id);
  }
  assert.equal((await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse', max_tokens: 0 })).trimmed_to_tokens, undefined);
  const huge = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse', max_tokens: 1e12 });
  assert.equal(huge.trimmed_to_tokens, undefined);
  const one = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse', max_tokens: 1 });
  assert.equal(one.trimmed_to_tokens, 500, 'the floor is 500 tokens');
  assert.ok(estimateTokens(one) < estimateTokens(full));
  // an object that cannot shrink stops instead of looping
  const stuck = fitContext({ skills: 'x'.repeat(10000) }, 600);
  assert.equal(stuck.trimmed_to_tokens, 600);
});

test('search max_tokens keeps at least one result and caps the rest', async () => {
  const { env } = await setup();
  for (let i = 0; i < 8; i++) await upsertLocal(env, `vault/topics/q${i}.md`, `---\ntype: topic\n---\nquokka ${'filler words '.repeat(40)}`);
  const all = await call(env, env.BRAIN_TOKEN, 'search', { q: 'quokka' });
  assert.equal(all.results.length, 8);
  assert.equal((await call(env, env.BRAIN_TOKEN, 'search', { q: 'quokka', max_tokens: 1 })).results.length, 1);
  const mid = await call(env, env.BRAIN_TOKEN, 'search', { q: 'quokka', max_tokens: 200 });
  assert.ok(mid.results.length >= 1 && mid.results.length < 8);
  assert.equal((await call(env, env.BRAIN_TOKEN, 'search', { q: 'quokka', max_tokens: 0 })).results.length, 8);
});

test('rrfFuse: ties keep first-seen order, duplicates within a list add up, empty lists are fine', () => {
  assert.deepEqual(rrfFuse([['a'], ['b']]), ['a', 'b']);
  assert.deepEqual(rrfFuse([['b'], ['a']]), ['b', 'a']);
  assert.deepEqual(rrfFuse([[], []]), []);
  assert.deepEqual(rrfFuse([['a', 'b'], ['b', 'a']]), ['a', 'b']);
});

test('embedPending: idempotent, drops deleted notes, covers hosted spaces, skips without bindings', async () => {
  const { env, uid, VECTORS, AI } = await semanticSetup();
  assert.deepEqual(await embedPending({ ...env, AI: undefined }, [], () => null), { skipped: 'no AI or VECTORS binding' });
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  await call(env, alice, 'create_project', { slug: 'garden', goal: 'zeppelin garden' });
  const r1 = await embedAll(env);
  assert.ok(r1.embedded > 0);
  const aliceSpace = env.DB.sqlite.prepare("SELECT id FROM spaces WHERE handle = 'alice'").get().id;
  assert.ok(env.DB.sqlite.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE space_id = ?').get(aliceSpace).c > 0, 'hosted space embedded');
  assert.ok([...VECTORS.rows.values()].some((v) => v.namespace === aliceSpace));
  const calls = AI.calls;
  assert.deepEqual(await embedAll(env), { embedded: 0, removed: 0 });
  assert.equal(AI.calls, calls, 'no re-embedding of unchanged notes');

  const before = VECTORS.rows.size;
  env.DB.prepare('DELETE FROM notes WHERE path = ?').bind('vault/topics/cache.md');
  env.DB.sqlite.prepare('DELETE FROM notes WHERE path = ?').run('vault/topics/cache.md');
  const r3 = await embedAll(env);
  assert.equal(r3.removed, 1);
  assert.equal(VECTORS.rows.size, before - 1);
  await upsertLocal(env, 'vault/topics/latency.md', '---\ntype: topic\n---\nchanged body');
  assert.equal((await embedAll(env)).embedded, 1);
  // the AI returning no vector for a note is skipped, not fatal
  const env2 = { ...env, AI: { async run() { return { data: [] }; } } };
  await upsertLocal(env, 'vault/topics/new.md', '---\ntype: topic\n---\nnew');
  assert.deepEqual(await embedPending(env2, env.DB.sqlite.prepare("SELECT * FROM spaces WHERE status = 'active'").all().map((r) => ({ ...r })), (s) => spaceStore(env, s)), { embedded: 0, removed: 0 });
});

test('regression: deleting a user leaves their embeddings (plaintext paths in D1, vectors in Vectorize)', async () => {
  const { env, uid, VECTORS } = await semanticSetup();
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  await call(env, alice, 'create_project', { slug: 'garden', goal: 'zeppelin garden' });
  await embedAll(env);
  const aliceSpace = env.DB.sqlite.prepare("SELECT id FROM spaces WHERE handle = 'alice'").get().id;
  const del = await call(env, sk, 'admin_delete_user', { handle: 'alice', confirm: 'alice' });
  assert.ok(!del.error, JSON.stringify(del));
  await embedAll(env);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE space_id = ?').get(aliceSpace).c, 0, 'embeddings rows (note paths) survive deletion');
  assert.ok(![...VECTORS.rows.values()].some((v) => v.namespace === aliceSpace), 'vectors survive deletion');
});

// =============================================================== 4. OAuth server

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const CID = 'https://app.client.test/oauth/client.json';

function oauthEnv(serve) {
  const env = fakeEnv();
  net.restore();
  net = stubFetch(async (req) => serve(req));
  return env;
}
const authorizeQ = (extra = {}) => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, q: new URLSearchParams({ client_id: CID, redirect_uri: 'https://app.client.test/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', ...extra }) };
};
const getAuthorize = (env, q) => handleOauth(new Request(`${O}/authorize?${q}`), env, new URL(`${O}/authorize?${q}`));

test('OAuth CIMD: oversized, redirecting, non-JSON, mismatched and badly-redirecting documents are refused', async () => {
  const good = { client_id: CID, client_name: 'Client', redirect_uris: ['https://app.client.test/cb'] };
  const cases = [
    ['oversized with length', () => Response.json({ ...good, pad: 'x'.repeat(6000) })],
    ['oversized streamed', () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ ...good, pad: 'x'.repeat(6000) }))); c.close(); } }))],
    ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/doc.json' } })],
    ['non-JSON', () => new Response('<html>hi</html>')],
    ['JSON array', () => Response.json([good])],
    ['JSON null', () => new Response('null')],
    ['404', () => new Response('no', { status: 404 })],
    ['client_id mismatch', () => Response.json({ ...good, client_id: 'https://app.client.test/oauth/other.json' })],
    ['http redirect uri', () => Response.json({ ...good, redirect_uris: ['http://app.client.test/cb'] })],
    ['fragment redirect uri', () => Response.json({ ...good, redirect_uris: ['https://app.client.test/cb#x'] })],
    ['no redirect uris', () => Response.json({ ...good, redirect_uris: [] })],
    ['redirect_uris not array', () => Response.json({ ...good, redirect_uris: 'https://app.client.test/cb' })],
    ['too many', () => Response.json({ ...good, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.client.test/cb${i}`) })],
    ['throws', () => { throw new Error('network'); }],
  ];
  for (const [label, serve] of cases) {
    const env = oauthEnv(serve);
    const res = await getAuthorize(env, authorizeQ().q);
    assert.equal(res.status, 400, label);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS c FROM oauth_clients').get().c, 0, `${label}: nothing cached`);
  }
});

test('OAuth CIMD: http and private-host client ids are never fetched; DCR cannot mint URL-shaped ids', async () => {
  const env = oauthEnv(() => Response.json({}));
  for (const cid of ['http://app.client.test/c.json', 'https://127.0.0.1/c.json', 'https://localhost/c.json', 'https://10.0.0.5/c.json', 'https://169.254.169.254/latest', 'https://app.client.test']) {
    const res = await getAuthorize(env, authorizeQ({ client_id: cid }).q);
    assert.equal(res.status, 400, cid);
  }
  assert.equal(net.calls.length, 0, JSON.stringify(net.calls.map((c) => c.url)));
  const reg = await handleOauth(new Request(`${O}/register`, { method: 'POST', body: JSON.stringify({ client_id: CID, client_name: 'Claude', redirect_uris: ['https://evil.test/cb'] }) }), env, new URL(`${O}/register`));
  const body = await reg.json();
  assert.equal(reg.status, 201);
  assert.notEqual(body.client_id, CID);
  assert.doesNotMatch(body.client_id, /^https?:/);
  assert.match(body.client_id, /^[A-Za-z0-9_-]+$/);
  // the attacker's registration does not make CID resolve to their redirect uri
  assert.equal((await getAuthorize(env, authorizeQ({ redirect_uri: 'https://evil.test/cb' }).q)).status, 400);
});

test('OAuth CIMD: cached for its TTL, refetched after; a vanished document stops working', async () => {
  let doc = { client_id: CID, client_name: '<b>Client</b>', redirect_uris: ['https://app.client.test/cb'] };
  let fetches = 0;
  const env = oauthEnv((req) => { fetches++; return doc ? Response.json(doc) : new Response('gone', { status: 404 }); });
  const page = await getAuthorize(env, authorizeQ().q);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /&#60;b&#62;Client&#60;\/b&#62;/, 'client_name is escaped');
  assert.doesNotMatch(html, /Warning:/);
  await getAuthorize(env, authorizeQ().q);
  assert.equal(fetches, 1, 'second request uses the cache');
  doc = { ...doc, redirect_uris: ['https://app.client.test/new'] };
  assert.equal((await getAuthorize(env, authorizeQ({ redirect_uri: 'https://app.client.test/new' }).q)).status, 400, 'still the cached uris');
  env.DB.sqlite.exec("UPDATE oauth_clients SET created = datetime('now', '-25 hours')");
  assert.equal((await getAuthorize(env, authorizeQ({ redirect_uri: 'https://app.client.test/new' }).q)).status, 200, 'refetched after TTL');
  assert.equal(fetches, 2);
  doc = null;
  env.DB.sqlite.exec("UPDATE oauth_clients SET created = datetime('now', '-25 hours')");
  assert.equal((await getAuthorize(env, authorizeQ({ redirect_uri: 'https://app.client.test/new' }).q)).status, 400);
});

test('OAuth: loopback warning on consent, iss on redirect even without state, metadata flags', async () => {
  const doc = { client_id: CID, client_name: 'CLI', redirect_uris: ['http://localhost:3333/cb', 'http://127.0.0.1:4444/cb'] };
  const env = oauthEnv(() => Response.json(doc));
  for (const ru of doc.redirect_uris) {
    const page = await getAuthorize(env, authorizeQ({ redirect_uri: ru }).q);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Warning:<\/b> access goes to a program on this computer/);
  }
  const meta = await (await handleOauth(new Request(`${O}/.well-known/oauth-authorization-server`), env, new URL(`${O}/.well-known/oauth-authorization-server`))).json();
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  const key = await createKey(env, { name: 'k', role: 'read' });
  const { q, verifier } = authorizeQ({ redirect_uri: 'http://localhost:3333/cb' });
  q.delete('state');
  const res = await handleOauth(new Request(`${O}/authorize`, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(q), access_key: key.key }) }), env, new URL(`${O}/authorize`));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.searchParams.get('iss'), O);
  assert.equal(loc.searchParams.get('state'), null);
  const tok = await handleOauth(new Request(`${O}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: CID, redirect_uri: 'http://localhost:3333/cb', code_verifier: verifier }) }), env, new URL(`${O}/token`));
  assert.ok((await tok.json()).access_token);
  // a wrong client_id at the token endpoint still fails
  const { q: q2, verifier: v2 } = authorizeQ({ redirect_uri: 'http://localhost:3333/cb' });
  const res2 = await handleOauth(new Request(`${O}/authorize`, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(q2), access_key: key.key }) }), env, new URL(`${O}/authorize`));
  const code2 = new URL(res2.headers.get('Location')).searchParams.get('code');
  const bad = await handleOauth(new Request(`${O}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: 'https://app.client.test/oauth/other.json', redirect_uri: 'http://localhost:3333/cb', code_verifier: v2 }) }), env, new URL(`${O}/token`));
  assert.equal(bad.status, 400);
});

// =============================================================== 5. regressions

test('regression: get_skill file= still falls through to GitHub for read-only keys (read_note does not)', async () => {
  const { env, uid } = await setup();
  const reader = await createKey(env, { name: 'reader', role: 'read', user_id: uid });
  net.calls.length = 0;
  const r = await call(env, reader.key, 'read_note', { path: 'vault/topics/fresh.md' });
  assert.match(r.error, /not found/);
  assert.equal(net.calls.length, 0);
  await call(env, reader.key, 'get_skill', { name: 'unslop', file: 'references/missing-1.md' });
  assert.equal(net.calls.filter((c) => c.url.includes('/contents/')).length, 0, `read key spent GitHub calls: ${JSON.stringify(net.calls.map((c) => c.url))}`);
});

test('create_key: machine and agent args, inheritance from the parent key, list_keys shape, audit', async () => {
  const { env, uid } = await setup();
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  const k1 = await call(env, alice, 'create_key', { name: 'codex-mbp', role: 'admin', machine: 'MacBook-Pro', agent: 'Codex', agent_tags: ['Coding'] });
  assert.equal(k1.ok, true, JSON.stringify(k1));
  const child = await call(env, k1.key, 'create_key', { name: 'child', role: 'write' });
  assert.equal(child.ok, true, JSON.stringify(child));
  const keys = (await call(env, alice, 'list_keys')).keys;
  const one = keys.find((k) => k.id === k1.id);
  assert.equal(one.machine, 'macbook-pro');
  assert.equal(one.agent, 'codex');
  assert.deepEqual(one.agent_tags, ['coding']);
  assert.deepEqual(one.pinned, []);
  assert.ok(Array.isArray(one.scopes) && !('prefixes' in one));
  const kid = keys.find((k) => k.id === child.id);
  assert.equal(kid.machine, 'macbook-pro', 'child inherits machine');
  assert.equal(kid.agent, 'codex', 'child inherits agent');
  assert.deepEqual(kid.agent_tags, ['coding']);
  const other = await call(env, k1.key, 'create_key', { name: 'other', role: 'read', machine: 'ipad', agent: 'claude' });
  const ok = (await call(env, alice, 'list_keys')).keys.find((k) => k.id === other.id);
  assert.deepEqual([ok.machine, ok.agent], ['ipad', 'claude']);
  for (const bad of [{ machine: '../x' }, { agent: 'Bad Agent!' }, { agent_tags: 'x' }, { agent_tags: ['bad tag!'] }]) {
    const r = await call(env, alice, 'create_key', { name: 'bad', role: 'read', ...bad });
    assert.ok(r.error, JSON.stringify(bad));
  }
  // a session note carries the machine and agent
  await call(env, k1.key, 'create_project', { slug: 'garden' });
  const saved = await call(env, k1.key, 'save', { project: 'garden', summary: 's', body: 'b' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const sessPath = saved.files.find((f) => f.startsWith('vault/logs/sessions/'));
  const note = await call(env, alice, 'read_note', { path: sessPath });
  assert.equal(note.frontmatter.machine, 'macbook-pro');
  assert.equal(note.frontmatter.agent, 'codex');
  const ev = (await call(env, alice, 'audit_log', { action: 'key.create' })).events;
  assert.ok(ev.some((e) => e.target === k1.id), JSON.stringify(ev.slice(0, 3)));
});

test('regression: create_key with a bad agent still creates the machine row', async () => {
  const { env, uid } = await setup();
  const sk = await superKey(env, uid);
  const alice = await onboard(env, sk, 'alice');
  const r = await call(env, alice, 'create_key', { name: 'bad', role: 'read', machine: 'ghost-box', agent: 'Bad Agent!' });
  assert.ok(r.error);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS c FROM machines WHERE name = 'ghost-box'").get().c, 0);
});

test('existing clients that only read content[0].text still work', async () => {
  const { env } = await setup();
  const res = await rpc(env, env.BRAIN_TOKEN, 'tools/call', { name: 'search', arguments: { q: 'caching' } });
  const parsed = JSON.parse(res.result.content[0].text);
  assert.ok(parsed.results.some((r) => r.path === 'vault/topics/cache.md'));
  assert.equal(res.result.content.length, 1);
});
