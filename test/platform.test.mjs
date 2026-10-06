import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fakeEnv, fakeCtx, stubFetch } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { upsertLocal } from '../src/indexer.js';
import { createKey } from '../src/auth.js';
import { handleOauth } from '../src/oauth.js';
import { fitContext, liveDecisions, rrfFuse, embedPending, estimateTokens } from '../src/memory.js';

const O = 'https://brain.test';
let net = stubFetch();

const NOTES = {
  'vault/projects/pulse.md': '---\ntype: project\nproject: pulse\nstatus: active\nupdated: 2026-10-01\n---\n# pulse\n' + 'Long project plan. '.repeat(600),
  'vault/topics/cache.md': '---\ntype: topic\ntitle: Edge caching\n---\nWe keep hot data near users with a write-through layer.',
  'vault/topics/latency.md': '---\ntype: topic\ntitle: Response time budget\n---\nThe p99 target is 200 ms for reads.',
  'vault/logs/decisions.md': [
    '# Decisions',
    '### [2026-09-01] Use Postgres for the ledger\n- **Chosen:** Use Postgres for the ledger\n- **Why:** joins\n- **Project:** [[projects/pulse]]',
    '### [2026-10-01] Use D1 for the ledger\n- **Chosen:** Use D1 for the ledger\n- **Why:** one platform\n- **Project:** [[projects/pulse]]\n- **Supersedes:** Use Postgres for the ledger',
  ].join('\n\n'),
  'skills/unslop/SKILL.md': '---\nname: unslop\ndescription: cut slop\n---\nUNSLOP BODY',
  'vault/skills.md': '---\ntype: config\n---\n# Skills\n\ndefault: unslop\n',
};

async function setup(extra = {}) {
  const env = fakeEnv(extra);
  const gh = fakeGitHub(env, { ...NOTES });
  net.restore();
  net = stubFetch(async (req, rec) => {
    const host = new URL(req.url).host;
    if (extra.routes?.[host]) return extra.routes[host](req, rec);
    return gh.handler(req, rec);
  });
  for (const [p, t] of Object.entries(NOTES)) await upsertLocal(env, p, t);
  await call(env, env.BRAIN_TOKEN, 'whoami');
  return { env, gh };
}

async function rpc(env, token, method, params) {
  const ctx = fakeCtx();
  const res = await worker.fetch(new Request(`${O}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env, ctx);
  await Promise.all(ctx.pending);
  return res.json();
}
async function call(env, token, name, args = {}) {
  const r = (await rpc(env, token, 'tools/call', { name, arguments: args })).result;
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

test('decisions: a superseding decision hides the one it replaces', async () => {
  const blocks = NOTES['vault/logs/decisions.md'].split(/\n(?=### \[)/).filter((b) => b.startsWith('### ['));
  const live = liveDecisions(blocks);
  assert.equal(live.length, 1);
  assert.match(live[0], /Use D1/);
  const { env } = await setup();
  const ctx = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse' });
  assert.equal(ctx.recent_decisions.length, 1);
  assert.match(ctx.recent_decisions[0], /Use D1/);
});

test('get_context max_tokens trims data, never instructions', async () => {
  const { env } = await setup();
  const full = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse' });
  const small = await call(env, env.BRAIN_TOKEN, 'get_context', { project: 'pulse', max_tokens: 1500 });
  assert.ok(estimateTokens(small) < estimateTokens(full));
  assert.equal(small.trimmed_to_tokens, 1500);
  assert.deepEqual(small.skills, full.skills);
  assert.match(small.project_note, /trimmed to fit/);
  const untouched = fitContext({ a: 1 }, 5000);
  assert.deepEqual(untouched, { a: 1 });
});

test('MCP results carry structuredContent and isError; skills are resources', async () => {
  const { env } = await setup();
  const r = (await rpc(env, env.BRAIN_TOKEN, 'tools/call', { name: 'read_note', arguments: { path: 'vault/topics/cache.md' } })).result;
  assert.equal(r.structuredContent.path, 'vault/topics/cache.md');
  assert.equal(r.isError, false);
  const bad = (await rpc(env, env.BRAIN_TOKEN, 'tools/call', { name: 'read_note', arguments: { path: 'vault/nope.md' } })).result;
  assert.equal(bad.isError, true);
  const init = (await rpc(env, env.BRAIN_TOKEN, 'initialize', { protocolVersion: '2025-06-18' })).result;
  assert.ok(init.capabilities.resources);
  const list = (await rpc(env, env.BRAIN_TOKEN, 'resources/list')).result.resources;
  assert.ok(list.some((x) => x.uri === 'brain://skills/unslop'));
  const read = (await rpc(env, env.BRAIN_TOKEN, 'resources/read', { uri: 'brain://skills/unslop' })).result;
  assert.match(read.contents[0].text, /UNSLOP BODY/);
});

test('read-only keys never fall through to GitHub on a miss', async () => {
  const { env, gh } = await setup();
  gh.files.set('vault/topics/fresh.md', 'fresh, not yet indexed');
  const uid = env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
  const reader = await createKey(env, { name: 'reader', role: 'read', user_id: uid });
  net.calls.length = 0;
  const r = await call(env, reader.key, 'read_note', { path: 'vault/topics/fresh.md' });
  assert.match(r.error, /not found/);
  assert.ok(!net.calls.some((c) => c.url.includes('/contents/vault/topics/fresh.md')));
  const writer = await createKey(env, { name: 'writer', role: 'write', user_id: uid });
  assert.equal((await call(env, writer.key, 'read_note', { path: 'vault/topics/fresh.md' })).source, 'github (not yet indexed)');
});

test('session notes record the machine and agent that wrote them', async () => {
  const { env, gh } = await setup();
  const uid = env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
  env.DB.sqlite.prepare("INSERT INTO machines (id, user_id, name, tags, created) VALUES ('m1', ?, 'mbp', '[]', datetime('now'))").run(uid);
  const k = await createKey(env, { name: 'codex', role: 'write', user_id: uid, machine_id: 'm1', agent: 'codex' });
  const r = await call(env, k.key, 'save', { summary: 'did things', body: 'body' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const session = [...gh.files.entries()].find(([p]) => p.startsWith('vault/logs/sessions/'))[1];
  assert.match(session, /machine: "mbp"/);
  assert.match(session, /agent: "codex"/);
});

// ---------------------------------------------------------------- semantic search

function fakeAi() {
  const dims = 4096;
  const vec = (t) => {
    const v = new Array(dims).fill(0);
    for (const w of String(t).toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 2)) {
      const syn = { speed: 'latency', fast: 'latency', slow: 'latency', target: 'latency' }[w] || w;
      v[createHash('md5').update(syn).digest().readUInt16BE(0) % dims] += 1;
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

test('hybrid search: meaning finds notes keywords miss; vectors hold ids only', async () => {
  const AI = fakeAi();
  const VECTORS = fakeVectorize();
  const { env } = await setup({ AI, VECTORS });
  const spaces = env.DB.sqlite.prepare("SELECT * FROM spaces WHERE status = 'active'").all();
  const { spaceStore } = await import('../src/store.js');
  const r1 = await embedPending(env, spaces, (s) => spaceStore(env, s));
  assert.ok(r1.embedded >= 3);
  for (const v of VECTORS.rows.values()) assert.deepEqual(Object.keys(v).sort(), ['id', 'namespace', 'values']);
  const again = await embedPending(env, spaces, (s) => spaceStore(env, s));
  assert.equal(again.embedded, 0, 'unchanged notes are not re-embedded');

  const fts = await call(env, env.BRAIN_TOKEN, 'search', { q: 'speed', mode: 'fts' });
  assert.equal(fts.results.length, 0);
  const hybrid = await call(env, env.BRAIN_TOKEN, 'search', { q: 'speed' });
  assert.equal(hybrid.mode, 'hybrid');
  assert.equal(hybrid.results[0].path, 'vault/topics/latency.md');
  assert.deepEqual(rrfFuse([['a', 'b'], ['b', 'c']]), ['b', 'a', 'c']);
});

test('check_brain proposes merging near-duplicate topics', async () => {
  const { env } = await setup();
  await upsertLocal(env, 'vault/topics/edge-cache.md', '---\ntype: topic\ntitle: Edge caching\n---\nWe keep hot data near users with a write-through layer.');
  const r = await call(env, env.BRAIN_TOKEN, 'check_brain');
  assert.ok(r.consolidation.duplicate_topics.some((d) => d.notes.includes('vault/topics/cache.md') && d.notes.includes('vault/topics/edge-cache.md')));
});

// ---------------------------------------------------------------- OAuth server: CIMD + iss

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('OAuth: Client ID Metadata Documents, and iss on the authorization response', async () => {
  const CID = 'https://app.client.test/oauth/client.json';
  const doc = { client_id: CID, client_name: 'Client App', redirect_uris: ['https://app.client.test/cb'] };
  const env = fakeEnv();
  net.restore();
  net = stubFetch(async (req) => (req.url === CID ? Response.json(doc) : new Response('no', { status: 404 })));
  const meta = await (await handleOauth(new Request(`${O}/.well-known/oauth-authorization-server`), env, new URL(`${O}/.well-known/oauth-authorization-server`))).json();
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ client_id: CID, redirect_uri: 'https://app.client.test/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
  const page = await handleOauth(new Request(`${O}/authorize?${q}`), env, new URL(`${O}/authorize?${q}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /published at <b>app\.client\.test<\/b>/);
  const bad = new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://evil.test/cb' });
  assert.equal((await handleOauth(new Request(`${O}/authorize?${bad}`), env, new URL(`${O}/authorize?${bad}`))).status, 400);

  const key = await createKey(env, { name: 'k', role: 'read' });
  const form = new URLSearchParams({ ...Object.fromEntries(q), access_key: key.key });
  const res = await handleOauth(new Request(`${O}/authorize`, { method: 'POST', body: form }), env, new URL(`${O}/authorize`));
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.searchParams.get('iss'), O);
  const tok = await handleOauth(new Request(`${O}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: CID, redirect_uri: 'https://app.client.test/cb', code_verifier: verifier }) }), env, new URL(`${O}/token`));
  assert.ok((await tok.json()).access_token);

  doc.client_id = 'https://someone-else.test/x';
  const spoof = new URLSearchParams({ ...Object.fromEntries(q), client_id: 'https://app.client.test/oauth/other.json' });
  assert.equal((await handleOauth(new Request(`${O}/authorize?${spoof}`), env, new URL(`${O}/authorize?${spoof}`))).status, 400, 'a document must name itself');
});
