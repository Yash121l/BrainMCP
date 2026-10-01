import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fakeEnv, fakeCtx, stubFetch, sha256hex } from './helpers/fake-env.mjs';
import { fakeGitHub } from './helpers/index-repo.mjs';
import worker from '../src/index.js';
import { upsertLocal } from '../src/indexer.js';
import { parseFrontmatter } from '../src/parse.js';

const O = 'https://brain.test';
let net = stubFetch(); // nothing here may touch the network

/** Fresh env + in-memory GitHub holding `files`; `indexed` are also written to D1. */
async function setup({ files = {}, indexed = {}, env: overrides } = {}) {
  const env = fakeEnv(overrides);
  const gh = fakeGitHub(env, { ...files, ...indexed });
  net.restore();
  net = stubFetch(gh.handler);
  for (const [p, t] of Object.entries(indexed)) await upsertLocal(env, p, t);
  return { env, gh };
}

let keyNo = 0;
/** Insert a key row directly (also legacy shapes createKey now refuses). Returns the plaintext key. */
function addKey(env, role, prefixes) {
  const key = `bk_test_${role}_${++keyNo}`;
  env.DB.sqlite.prepare("INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked) VALUES (?, ?, ?, ?, ?, datetime('now'), NULL, 0)")
    .run(`k_t${keyNo}`, sha256hex(key), `key${keyNo}`, role, JSON.stringify(prefixes));
  return key;
}

const http = (env, method, path, token, init = {}) => worker.fetch(
  new Request(O + path, { method, ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } }),
  env, fakeCtx());
const rpc = (env, token, body) => http(env, 'POST', '/mcp', token, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
async function tool(env, token, name, args = {}) {
  const j = await (await rpc(env, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json();
  const t = j.result.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
}
const root = (env) => env.BRAIN_TOKEN;
const count = (env, sql, ...a) => env.DB.sqlite.prepare(sql).get(...a).c;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- installer

test('src/index.js:skills-install.sh:unquoted-repo-path-shell-injection: unsafe skill file names are skipped and every path is single-quoted', async () => {
  const { env } = await setup({ files: {
    'skills/team/SKILL.md': '---\nname: team\n---\nbody',
    'skills/team/run.sh': 'echo hi',
    'skills/team/$(touch INJECTED)/notes.md': 'x',
    'skills/team/a"b`id`.md': 'x',
    "skills/team/it's.md": 'x',
    'skills/te am/SKILL.md': 'x',
  } });
  const r = await http(env, 'GET', '/skills/install.sh', root(env));
  assert.equal(r.status, 200);
  const sh = await r.text();
  for (const bad of ['INJECTED', 'a"b', '`id`', "it's", 'te am']) assert.ok(!sh.includes(bad), bad);
  const dest = sh.split('\n').filter((l) => l.includes('$SKILLS_DEST') && !l.startsWith(':') && !l.startsWith('echo'));
  assert.ok(dest.length >= 4);
  for (const l of dest) assert.match(l, /^(mkdir -p|base64 \$B64D >|chmod \+x) "\$SKILLS_DEST"\/'[A-Za-z0-9._\/-]+'( <<'B64_EOF')?$/, l);
  assert.ok(sh.includes(`base64 $B64D > "$SKILLS_DEST"/'team/SKILL.md' <<'B64_EOF'`));
  assert.ok(sh.includes(`chmod +x "$SKILLS_DEST"/'team/run.sh'`));
  assert.ok(sh.includes(`echo 'Skipped 4 file(s) with unsafe names' >&2`));
  assert.ok(sh.includes(`echo 'Done: team'`));
});

test('src/index.js:skills-install.sh:unquoted-repo-path-shell-injection: a scoped writer cannot get a shell name into the installer', async () => {
  const { env, gh } = await setup();
  const w = addKey(env, 'write', ['skills/team-skill/']);
  const res = await tool(env, w, 'update_note', { path: 'skills/team-skill/$(touch M)/notes.md', content: 'hello' });
  assert.equal(res.ok, true); // git allows the name; the installer must not run it
  assert.ok(gh.files.has('skills/team-skill/$(touch M)/notes.md'));
  const sh = await (await http(env, 'GET', '/skills/install.sh', root(env))).text();
  assert.ok(!sh.includes('touch M'));
});

// ---------------------------------------------------------------- admin routes

test('src/auth.js:isAdmin/scope-agnostic-key-management: /admin/reindex and /admin/rollup need an unscoped admin', async () => {
  const { env } = await setup({ indexed: { 'vault/projects/alpha/a.md': '# a', 'vault/secret/s.md': '# s' } });
  env.DB.sqlite.prepare("INSERT INTO tool_calls (session, day, ts, payload) VALUES ('s', '2020-01-01', 't', '{}')").run();
  const scopedAdmin = addKey(env, 'admin', ['vault/projects/alpha/']); // legacy row
  const writer = addKey(env, 'write', ['vault/projects/alpha/']);
  const wholeAdmin = addKey(env, 'admin', []);
  for (const k of [scopedAdmin, writer]) {
    assert.equal((await http(env, 'POST', '/admin/reindex', k)).status, 401);
    assert.equal((await http(env, 'POST', '/admin/rollup', k)).status, 401);
  }
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 1);
  assert.equal(env.LOGS.objects.size, 0);
  assert.equal((await http(env, 'POST', '/admin/rollup', wholeAdmin)).status, 200);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 0);
  assert.equal((await http(env, 'POST', '/admin/reindex', wholeAdmin)).status, 200);
  assert.equal((await http(env, 'POST', '/admin/reindex', root(env))).status, 200);
});

// ---------------------------------------------------------------- get_context

test('src/index.js:get_context:binding-rules-read-without-scope-check: rules need their own grant and slugs must be project slugs', async () => {
  const { env } = await setup({ indexed: {
    'vault/projects/victim.md': '---\ntype: project\n---\n# victim',
    'vault/rules/victim.md': '---\ntype: rules\n---\nVICTIM-RULES-SECRET',
    'vault/projects/foo.md': '---\ntype: project\n---\n# foo',
    'vault/rules/foo/x.md': '---\ntype: rules\n---\nFOO-X-RULES-SECRET',
    'vault/projects/gamma.md': '---\ntype: project\n---\n# gamma',
    'vault/rules/gamma.md': '---\ntype: rules\nproject: gamma\n---\nGAMMA-RULES',
  } });
  const projects = addKey(env, 'read', ['vault/projects/']);
  const ctx = await tool(env, projects, 'get_context', { project: 'victim' });
  assert.ok(!JSON.stringify(ctx).includes('VICTIM-RULES-SECRET'));
  assert.match(ctx.binding_rules, /not in this key's scope/);
  assert.match(ctx.project_note, /# victim/);
  assert.match((await tool(env, projects, 'read_note', { path: 'vault/rules/victim.md' })).error, /^forbidden/);

  const foo = addKey(env, 'read', ['project:foo']);
  for (const slug of ['foo/x', '-x', '.hidden', 'foo/../victim']) {
    const r = await tool(env, foo, 'get_context', { project: slug });
    assert.match(r.error, /invalid project slug/, slug);
    assert.ok(!JSON.stringify(r).includes('RULES-SECRET'));
  }

  const gamma = addKey(env, 'read', ['project:gamma']); // rules filed under the project: both routes agree
  assert.equal((await tool(env, gamma, 'get_context', { project: 'gamma' })).binding_rules.trim().endsWith('GAMMA-RULES'), true);
  const both = addKey(env, 'read', ['vault/projects/', 'vault/rules/']);
  assert.match((await tool(env, both, 'get_context', { project: 'victim' })).binding_rules, /VICTIM-RULES-SECRET/);
  assert.match((await tool(env, root(env), 'get_context', { project: 'victim' })).binding_rules, /VICTIM-RULES-SECRET/);
});

// ---------------------------------------------------------------- telemetry

const ingest = (env, key, records) => http(env, 'POST', '/ingest/tool-calls', key, { body: JSON.stringify({ records }) });

test('src/index.js:ingestToolCalls:client-ts-day-unbounded-retention: client days are clamped and the buffer is capped', async () => {
  const { env } = await setup();
  const w = addKey(env, 'write', ['project:demo']);
  const r = await ingest(env, w, [
    { session: 'fut', ts: '9999-12-31T00:00:00Z', tool: 'Bash' },
    { session: 'old', ts: '1970-01-01T00:00:00Z', tool: 'Bash' },
    { session: 'now', tool: 'Bash' },
  ]);
  assert.equal(r.status, 200);
  const days = Object.fromEntries(env.DB.sqlite.prepare('SELECT session, day FROM tool_calls').all().map((x) => [x.session, x.day]));
  assert.deepEqual(days, { fut: today(), old: daysAgo(8), now: today() });
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls WHERE day > ?', today()), 0);

  // the global cap holds across requests and keys
  const ins = env.DB.sqlite.prepare("INSERT INTO tool_calls (session, day, ts, payload) VALUES ('fill', ?, 't', '{}')");
  env.DB.sqlite.exec('BEGIN');
  for (let i = count(env, 'SELECT COUNT(*) AS c FROM tool_calls'); i < 19998; i++) ins.run(today());
  env.DB.sqlite.exec('COMMIT');
  const near = await (await ingest(env, w, Array.from({ length: 5 }, () => ({ session: 'x', ts: '9999-12-31' })))).json();
  assert.deepEqual([near.ingested, near.dropped], [2, 3]);
  const full = await (await ingest(env, addKey(env, 'write', []), [{ session: 'y' }])).json();
  assert.deepEqual([full.ingested, full.dropped], [0, 1]);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 20000);
});

function seedCalls(env, groups, day = '2020-01-01') {
  const ins = env.DB.sqlite.prepare('INSERT INTO tool_calls (session, day, ts, payload) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < groups; i++) ins.run(`s${i}`, day, `${day}T00:00:00Z`, JSON.stringify({ session: `s${i}`, n: i }));
}

test('src/index.js:rollUpToolCalls:unbounded-single-pass-nonidempotent-drain: the drain is bounded per run and keeps progress', async () => {
  const { env } = await setup();
  seedCalls(env, 150);
  const a = await (await http(env, 'POST', '/admin/rollup', root(env))).json();
  assert.deepEqual([a.ok, a.objects, a.rolled, a.more], [true, 100, 100, true]);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 50);
  const b = await (await http(env, 'POST', '/admin/rollup', root(env))).json();
  assert.deepEqual([b.objects, b.more], [50, undefined]);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 0);
  assert.equal(env.LOGS.objects.size, 150);
});

test('src/index.js:rollUpToolCalls:unbounded-single-pass-nonidempotent-drain: a failure part-way keeps written groups out of the buffer and is reported', async () => {
  const { env } = await setup();
  seedCalls(env, 10);
  const put = env.LOGS.put.bind(env.LOGS);
  let puts = 0;
  env.LOGS.put = async (...a) => { if (++puts === 4) throw new Error('simulated subrequest ceiling'); return put(...a); };
  const r = await http(env, 'POST', '/admin/rollup', root(env));
  assert.equal(r.status, 500);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 7);
  const health = await (await http(env, 'GET', '/health')).json();
  assert.equal(health.telemetry.last_rollup.ok, false);
  assert.match(health.telemetry.last_rollup.error, /simulated/);
  env.LOGS.put = put;
  assert.equal((await http(env, 'POST', '/admin/rollup', root(env))).status, 200);
  assert.equal(env.LOGS.objects.size, 10);
  for (const [k, v] of env.LOGS.objects) assert.equal(v.body.trim().split('\n').length, 1, k); // nothing appended twice
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM tool_calls'), 0);
});

// ---------------------------------------------------------------- save

const OWNER_SESS = 'vault/logs/sessions/2026-09-29_090000_vfySess7.md';

test('src/index.js:save:session-key-lookup-unbound-target-path: re-save only targets the canonical session log path', async () => {
  const { env, gh } = await setup({ indexed: {
    'vault/projects/alpha.md': '---\ntype: project\nstatus: active\n---\n# alpha',
    'vault/projects/beta.md': '---\ntype: project\nstatus: active\n---\n# beta',
    [OWNER_SESS]: '---\ntype: session\nproject: "[[projects/alpha]]"\nsummary: "alpha work"\nsession_key: vfySess7\n---\nalpha work\n',
  } });
  const att = addKey(env, 'write', ['project:alpha']);
  // the attacker retags the owner's note and plants a decoy carrying its session_key
  assert.equal((await tool(env, att, 'update_note', { path: OWNER_SESS, content: '---\ntype: session\nproject: "[[projects/alpha]]"\nsession_key: moved\n---\nx\n' })).ok, true);
  const DECOY = 'vault/projects/alpha/scratch.md';
  assert.equal((await tool(env, att, 'update_note', { path: DECOY, content: '---\ntype: session\nsession_key: vfySess7\n---\ndecoy\n' })).ok, true);

  const s = await tool(env, root(env), 'save', { session_id: 'vfySess7', project: 'beta', summary: 'beta work', body: 'BETA-SECRET-91' });
  assert.equal(s.ok, true);
  assert.deepEqual(s.files, [OWNER_SESS]);
  assert.equal(gh.files.get(DECOY), '---\ntype: session\nsession_key: vfySess7\n---\ndecoy\n');
  assert.ok(!JSON.stringify(await tool(env, att, 'read_note', { path: DECOY })).includes('BETA-SECRET'));
  assert.match((await tool(env, att, 'read_note', { path: OWNER_SESS })).error, /^forbidden/); // now filed under beta

  // decoy only, no canonical note: a fresh canonical path, and saving again reuses it
  const t = await tool(env, root(env), 'save', { session_id: 'vfySess9', project: 'beta', summary: 'b', body: 'b' });
  assert.match(t.files[0], /^vault\/logs\/sessions\/\d{4}-\d{2}-\d{2}_\d{6}_vfySess9\.md$/);
  await tool(env, att, 'update_note', { path: 'vault/projects/alpha/decoy2.md', content: '---\ntype: session\nsession_key: vfySess9\n---\nd\n' });
  assert.deepEqual((await tool(env, root(env), 'save', { session_id: 'vfySess9', summary: 'b2', body: 'b2' })).files, t.files);
});

// ---------------------------------------------------------------- search / list_notes

test('src/index.js:search:sql-limit-before-scope-filter: ranking and LIMIT only see readable notes', async () => {
  const filler = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const indexed = { 'vault/projects/alpha.md': `---\ntype: project\nupdated: 2020-01-01\n---\nzebra marmot ${filler}` };
  for (let i = 0; i < 60; i++) indexed[`vault/private/h${i}.md`] = `---\nupdated: 2026-01-01\n---\nmarmot marmot`;
  const { env } = await setup({ indexed });
  const k = addKey(env, 'read', ['vault/projects/']);
  for (const limit of [1, 2]) {
    assert.deepEqual((await tool(env, k, 'search', { q: 'marmot', limit })).results.map((r) => r.path), ['vault/projects/alpha.md']);
  }
  assert.deepEqual((await tool(env, k, 'list_notes', { limit: 1 })).notes.map((r) => r.path), ['vault/projects/alpha.md']);
  assert.equal((await tool(env, root(env), 'search', { q: 'marmot', limit: 50 })).results.length, 50);
});

test('src/index.js:search:sql-limit-before-scope-filter: the SQL scope mirrors allowed() and binds one parameter for any scope size', async () => {
  const indexed = {
    'vault/pro/x.md': 'needle', 'vault/projects/alpha.md': 'needle', 'vault/exact.md': 'needle', 'vault/exact.md.bak/y.md': 'needle',
    'vault/exact.mdz.md': 'needle',
  };
  for (let i = 0; i < 150; i++) indexed[`vault/elsewhere/a${i}.md`] = `---\nproject: alpha\n---\nneedle ${i}`;
  const { env } = await setup({ indexed });
  const binds = [];
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { const st = prepare(sql); const bind = st.bind; return { ...st, bind: (...a) => { binds.push(a.length); return bind(...a); } }; };
  const paths = async (k, name) => (await tool(env, k, name, name === 'search' ? { q: 'needle', limit: 50, include_logs: true } : { limit: 200 }))[name === 'search' ? 'results' : 'notes'].map((r) => r.path).sort();
  const pro = addKey(env, 'read', ['vault/pro', 'vault/exact.md']);
  for (const name of ['search', 'list_notes']) assert.deepEqual(await paths(pro, name), ['vault/exact.md', 'vault/pro/x.md']);
  const proj = addKey(env, 'read', ['project:alpha']); // expands to 150+ exact paths
  binds.length = 0;
  assert.equal((await paths(proj, 'list_notes')).length, 151); // + vault/projects/alpha.md
  assert.equal((await paths(proj, 'search')).length, 50);
  assert.ok(Math.max(...binds) <= 10, `max binds ${Math.max(...binds)}`);
});

// ---------------------------------------------------------------- /mcp batches

test('src/index.js:mcp:jsonrpc-batch-unbounded-x-unscoped-full-table-scans: batches are capped and bad members get -32600', async () => {
  const { env } = await setup({ indexed: { 'vault/a.md': '# a' } });
  let statements = 0;
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { statements++; return prepare(sql); };
  const check = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_brain', arguments: {} } });
  const big = await rpc(env, root(env), Array.from({ length: 21 }, (_, i) => check(i)));
  assert.equal(big.status, 400);
  assert.equal((await big.json()).error.code, -32600);
  assert.equal(statements, 0); // root auth needs no D1, and no message ran
  const empty = await rpc(env, root(env), []);
  assert.equal((await empty.json()).error.code, -32600);
  const ok = await (await rpc(env, root(env), Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))).json();
  assert.equal(ok.length, 20);
  const mixed = await rpc(env, root(env), [null, 7, [], { jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(mixed.status, 200);
  assert.deepEqual((await mixed.json()).map((r) => r.error?.code ?? 'ok'), [-32600, -32600, -32600, 'ok']);
  const nul = await rpc(env, root(env), null);
  assert.equal(nul.status, 200);
  assert.equal((await nul.json()).error.code, -32600);
});

// ---------------------------------------------------------------- full reindex

/** D1 whose bind() throws for values containing bindMarker (D1_TYPE_ERROR) and whose batch fails on execMarker (SQLITE_TOOBIG). */
function poisonDB(db, bindMarker, execMarker) {
  const has = (a, m) => a.some((v) => typeof v === 'string' && v.includes(m));
  const wrap = (st) => ({
    ...st,
    bind: (...a) => {
      if (has(a, bindMarker)) throw new TypeError('D1_TYPE_ERROR: Type \'object\' not supported');
      const b = wrap(st.bind(...a));
      return has(a, execMarker) ? { ...b, _exec: () => { throw new Error('SQLITE_TOOBIG'); } } : b;
    },
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql)) };
}

test('src/index.js:fullReindex:delete-all-before-unguarded-upsertNotes: a bad note is skipped and recorded, and the index is never emptied', async () => {
  const { env, gh } = await setup({ indexed: {
    'vault/topics/a.md': '# a\nold a', 'vault/topics/p1.md': '# p1\np1 old', 'vault/topics/gone.md': '# gone\nsee [[a]] gonetext',
  } });
  env.DB.sqlite.exec("UPDATE notes SET indexed_at = '2000-01-01 00:00:00'");
  gh.files.delete('vault/topics/gone.md');
  gh.files.set('vault/topics/a.md', '# a\nnew a [[b]]');
  gh.files.set('vault/topics/b.md', '# b');
  gh.files.set('vault/topics/p1.md', '# p1\nPOISON-BIND');
  gh.files.set('vault/topics/p2.md', '# p2\nPOISON-EXEC');
  gh.files.set('vault/projects/alpha.md', '---\ntype: project\n---\n# alpha');
  env.DB = poisonDB(env.DB, 'POISON-BIND', 'POISON-EXEC');

  const r = await http(env, 'POST', '/admin/reindex', root(env));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.indexed, 3);
  assert.deepEqual(j.skipped.map((s) => s.path).sort(), ['vault/topics/p1.md', 'vault/topics/p2.md']);
  const notes = Object.fromEntries(env.DB.sqlite.prepare('SELECT path, body FROM notes').all().map((n) => [n.path, n.body]));
  assert.deepEqual(Object.keys(notes).sort(), ['vault/projects/alpha.md', 'vault/topics/a.md', 'vault/topics/b.md', 'vault/topics/p1.md']);
  assert.match(notes['vault/topics/a.md'], /new a/);
  assert.match(notes['vault/topics/p1.md'], /p1 old/); // the skipped note keeps its previous rows
  assert.equal(count(env, "SELECT COUNT(*) AS c FROM links WHERE src = 'vault/topics/gone.md'"), 0);
  assert.equal(count(env, "SELECT COUNT(*) AS c FROM fts WHERE path = 'vault/topics/gone.md'"), 0);
  assert.equal(count(env, "SELECT COUNT(*) AS c FROM fts WHERE path = 'vault/topics/p1.md'"), 1);
  assert.equal(JSON.parse(env.DB.sqlite.prepare("SELECT v FROM meta WHERE k = 'index_skipped'").get().v).total, 2);
  assert.ok(env.DB.sqlite.prepare("SELECT v FROM meta WHERE k = 'last_full_reindex'").get());

  // a tarball with no notes, or none at all, leaves the index as it was
  for (const p of [...gh.files.keys()]) gh.files.delete(p);
  assert.equal((await http(env, 'POST', '/admin/reindex', root(env))).status, 500);
  gh.failTarball = 502;
  assert.equal((await http(env, 'POST', '/admin/reindex', root(env))).status, 500);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM notes'), 4);

  // the cron still takes the hygiene snapshot when the rebuild fails
  const ctx = fakeCtx();
  await worker.scheduled({}, env, ctx);
  await Promise.all(ctx.pending);
  assert.ok(env.DB.sqlite.prepare("SELECT v FROM meta WHERE k = 'hygiene'").get());
});

test('src/index.js:fullReindex:delete-all-before-unguarded-upsertNotes: a webhook push skips non-canonical paths instead of aborting', async () => {
  const { env } = await setup({ files: { 'vault/topics/new.md': '# new', 'vault/topics/also.md': '# also' } });
  const raw = JSON.stringify({ ref: 'refs/heads/main', commits: [{ added: ['vault/topics/back\\slash.md', 'vault/topics/new.md', 'vault/topics/also.md'] }] });
  const sig = 'sha256=' + createHmac('sha256', env.WEBHOOK_SECRET).update(raw).digest('hex');
  const ctx = fakeCtx();
  const r = await worker.fetch(new Request(O + '/webhook', { method: 'POST', body: raw, headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sig } }), env, ctx);
  assert.equal(r.status, 200);
  await Promise.all(ctx.pending);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT path FROM notes ORDER BY path').all().map((n) => n.path), ['vault/topics/also.md', 'vault/topics/new.md']);
  const skipped = JSON.parse(env.DB.sqlite.prepare("SELECT v FROM meta WHERE k = 'index_skipped'").get().v);
  assert.equal(skipped.source, 'webhook');
  assert.deepEqual(skipped.skipped.map((s) => s.path), ['vault/topics/back\\slash.md']);
  assert.ok(!net.calls.some((c) => c.url.includes('slash')));
});

// ---------------------------------------------------------------- tarball size

test('github.js:fetchRepoTar:unbounded-decompressed-tar-buffer: index.js refuses a tree over the configured cap', async () => {
  const { env, gh } = await setup({ indexed: { 'vault/topics/a.md': '# a' }, env: { TAR_MAX_BYTES: '8192' } });
  gh.files.set('vault/projects/alpha/blob.bin', 'A'.repeat(20000));
  const r = await http(env, 'POST', '/admin/reindex', root(env));
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /over the 8192-byte cap/);
  assert.equal(count(env, 'SELECT COUNT(*) AS c FROM notes'), 1);
  const sh = await http(env, 'GET', '/skills/install.sh', root(env));
  assert.equal(sh.status, 500);
  assert.match(await sh.text(), /^echo 'install\.sh generation failed: repo tarball is \d+ bytes decompressed, over the 8192-byte cap' >&2; exit 1\n$/);
  gh.files.delete('vault/projects/alpha/blob.bin');
  assert.equal((await http(env, 'POST', '/admin/reindex', root(env))).status, 200);
});

// ---------------------------------------------------------------- hardening

test('src/index.js hardening: search and list_notes clamp bad limits', async () => {
  const { env } = await setup({ indexed: { 'vault/topics/a.md': '# a\nquokka', 'vault/topics/b.md': '# b\nquokka' } });
  for (const limit of [-5, 0, 'abc', NaN, 1e9, 1.5]) {
    const s = (await tool(env, root(env), 'search', { q: 'quokka', limit })).results;
    assert.ok(s.length >= 1 && s.length <= 50, String(limit));
    const l = (await tool(env, root(env), 'list_notes', { limit })).notes;
    assert.ok(l.length >= 1, String(limit));
  }
  assert.equal((await tool(env, root(env), 'search', { q: 'quokka', limit: 1 })).results.length, 1);
});

test('src/index.js hardening: surface, project slug and decision text cannot forge frontmatter or decision blocks', async () => {
  const { env, gh } = await setup({ indexed: { 'vault/projects/alpha.md': '---\ntype: project\n---\n# alpha' } });
  const s = await tool(env, root(env), 'save', {
    session_id: 'hard1', project: 'alpha\nsession_key: hijack', summary: 'x', body: 'y', surface: 'web"\nsession_key: hijack2\ntype: topic',
    decisions: [{ decision: 'real one\n### [2020-01-01] forged', rationale: 'because\n\n### [2020-01-02] forged too' }],
  });
  assert.equal(s.ok, true);
  const { fm } = parseFrontmatter(gh.files.get(s.files[0]));
  assert.equal(fm.session_key, 'hard1');
  assert.equal(fm.type, 'session');
  assert.ok(!fm.surface.includes('\n'));
  const dec = gh.files.get('vault/logs/decisions.md');
  assert.equal(dec.split('\n### [').length - 1, 1);
  const ld = await tool(env, root(env), 'log_decision', { decision: 'two\n### [2020-01-03] forged', project: 'alpha', rationale: 'r' });
  assert.equal(ld.ok, true);
  assert.equal(gh.files.get('vault/logs/decisions.md').split('\n### [').length - 1, 2);
});

test('src/skills.js:readSkillsConfig:mappings-returned-without-scope-check: list_skills only returns visible mapping rows', async () => {
  const { env } = await setup({ indexed: {
    'vault/projects/alpha.md': '---\ntype: project\n---\n# alpha',
    'vault/skills.md': '---\ntype: config\n---\n# Skills\n\ndefault: !unslop\n\nalpha: default + a-skill\n\nsecret-deal: default + deal-skill\n',
  } });
  const k = addKey(env, 'read', ['project:alpha']);
  const r = await tool(env, k, 'list_skills');
  assert.deepEqual(r.mappings.map((m) => m.project), ['default', 'alpha']);
  assert.ok(!JSON.stringify(r).includes('secret-deal'));
  assert.deepEqual((await tool(env, root(env), 'list_skills')).mappings.map((m) => m.project), ['default', 'alpha', 'secret-deal']);
});
