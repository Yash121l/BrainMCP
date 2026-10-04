import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeEnv, stubFetch, sha256hex } from './helpers/fake-env.mjs';
import { seedNotes, appLogin, appGet, appSend, legacyScopedAdmin } from './helpers/app-seed.mjs';
import { createKey } from '../src/auth.js';
import { computeHygiene } from '../src/app.js';
import { parseSkillsConfig, skillsConfigEntries, visibleEntries } from '../src/skills.js';
import { hookInstaller, HOOK_VERSION } from '../src/hook.js';

stubFetch(); // nothing here may touch the network

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const json = async (r) => ({ status: r.status, body: await r.json() });

// ---------------------------------------------------------------- key management

test('src/auth.js:isAdmin/scope-agnostic-key-management: scoped admin sessions get 403 on /app/api/keys* and /app/api/scopes', async () => {
  const env = fakeEnv();
  seedNotes(env, {
    'vault/projects/alpha/a.md': '# a\n',
    'vault/projects/beta.md': '---\ntype: project\ntitle: Beta Secret Project\n---\n# beta\n',
  });
  const legacy = legacyScopedAdmin(env, ['vault/projects/alpha/']);
  const { cookie } = await appLogin(env, legacy.key);
  assert.ok(cookie);
  assert.equal((await appGet(env, cookie, '/app/api/me')).status, 200);

  const denied = [
    await appGet(env, cookie, '/app/api/keys'),
    await appGet(env, cookie, '/app/api/scopes'),
    await appSend(env, cookie, 'POST', '/app/api/keys', { name: 'minted', role: 'admin', prefixes: [] }),
    await appSend(env, cookie, 'PATCH', '/app/api/keys', { id: legacy.id, prefixes: [] }),
    await appSend(env, cookie, 'POST', '/app/api/keys/revoke', { id: legacy.id }),
  ];
  assert.deepEqual(denied.map((r) => r.status), [403, 403, 403, 403, 403]);
  const row = env.DB.sqlite.prepare('SELECT prefixes, revoked FROM api_keys WHERE id = ?').get(legacy.id);
  assert.deepEqual([row.prefixes, row.revoked], ['["vault/projects/alpha/"]', 0]);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS c FROM api_keys').get().c, 1);

  // whole-brain admins keep key management: the root token and an unscoped admin key
  for (const key of [env.BRAIN_TOKEN, (await createKey(env, { name: 'ops', role: 'admin' })).key]) {
    const { cookie: c } = await appLogin(env, key);
    assert.equal((await appGet(env, c, '/app/api/keys')).status, 200);
    const scopes = await json(await appGet(env, c, '/app/api/scopes'));
    assert.equal(scopes.status, 200);
    assert.ok(scopes.body.projects.some((p) => p.slug === 'beta'));
    assert.equal((await appSend(env, c, 'POST', '/app/api/keys', { name: 'w', role: 'write', prefixes: ['vault/'] })).status, 201);
  }
});

// ---------------------------------------------------------------- hygiene

test('src/app.js:computeHygiene:broken-link-resolution-against-unscoped-notes: out-of-scope targets read as missing', async () => {
  const env = fakeEnv();
  seedNotes(env, {
    'vault/projects/alpha.md': '---\ntype: project\n---\n# Alpha\nSee [[topics/known-plan]] and [[topics/ghost-plan]] and [[hidden-deal]] and [[beta]].\n',
    'vault/projects/beta.md': '# beta\n',
    'vault/topics/known-plan.md': '# known\n',
    'vault/private/hidden-deal.md': '# hidden\n',
  });
  const { key } = await createKey(env, { name: 'ro', role: 'read', prefixes: ['vault/projects/'] });
  const { cookie } = await appLogin(env, key);
  const chk = await json(await appGet(env, cookie, '/app/api/check'));
  assert.equal(chk.status, 200);
  assert.deepEqual(chk.body.broken_links.map((b) => b.dst).sort(), ['hidden-deal', 'topics/ghost-plan', 'topics/known-plan']);
  assert.equal(chk.body.counts.notes, 2); // visible notes only, not the vault-wide total
  assert.equal(chk.body.counts.links, 4);

  // the unscoped view still resolves everything that exists
  const root = await computeHygiene(env.DB, { role: 'admin', scopes: [], prefixes: [] });
  assert.deepEqual(root.broken_links.map((b) => b.dst), ['topics/ghost-plan']);
  assert.equal(root.counts.notes, 4);
});

// ---------------------------------------------------------------- skills mappings

const SKILLS_MD = `---
type: config
---
# Skills

default: !unslop

alpha: default + a-skill

dummy-secret-deal: dummy-deal-skill
`;

test('src/skills.js:readSkillsConfig:mappings-returned-without-scope-check: rows are filtered by what the principal can read', async () => {
  const env = fakeEnv();
  seedNotes(env, {
    'vault/skills.md': SKILLS_MD,
    'vault/projects/alpha.md': '---\ntype: project\n---\n# alpha\n',
    'vault/projects/dummy-secret-deal.md': '---\ntype: project\n---\n# secret\n',
    'skills/unslop/SKILL.md': '---\nname: unslop\n---\n# unslop\n',
  });
  const { key: alphaKey } = await createKey(env, { name: 'alpha', role: 'read', prefixes: ['project:alpha'] });
  const { key: vaultKey } = await createKey(env, { name: 'vault', role: 'read', prefixes: ['vault/'] });

  const a = await json(await appGet(env, (await appLogin(env, alphaKey)).cookie, '/app/api/skills'));
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.entries.map((e) => e.project), ['default', 'alpha']);
  assert.deepEqual(a.body.inherits_default, ['alpha']);
  assert.equal(a.body.editable, false);

  const v = await json(await appGet(env, (await appLogin(env, vaultKey)).cookie, '/app/api/skills'));
  assert.deepEqual(v.body.entries.map((e) => e.project), ['default', 'alpha', 'dummy-secret-deal']);

  // the helper index.js list_skills uses
  const { entries } = skillsConfigEntries(SKILLS_MD);
  assert.deepEqual(visibleEntries({ prefixes: ['vault/projects/alpha.md'] }, entries).map((e) => e.project), ['default', 'alpha']);
  assert.deepEqual(visibleEntries({ prefixes: ['vault/logs/'] }, entries).map((e) => e.project), ['default']);
  assert.equal(visibleEntries({ prefixes: [] }, entries).length, 3);
});

test('src/skills.js:parseSkillsConfig:quadratic-lazy-trailing-whitespace-regex: row parsing is linear', () => {
  const poison = 'default: !unslop\n' + 'a:x' + ' '.repeat(1_000_000) + 'y\n' + 'b:x' + '\t '.repeat(200_000) + '\n';
  const t0 = performance.now();
  const { entries } = parseSkillsConfig(poison);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `parse took ${ms.toFixed(1)} ms`);
  assert.equal(entries[0].raw, '!unslop');
  assert.equal(entries[1].raw.length, 1_000_002);
  assert.deepEqual(entries[2], { project: 'b', raw: 'x' });
  // ordinary rows parse as before; trailing blanks (and now a CRLF '\r') are dropped
  assert.deepEqual(parseSkillsConfig('title: x\ndefault:  a, !b  \t\nproj: default + c\r\n').entries, [
    { project: 'default', raw: 'a, !b' },
    { project: 'proj', raw: 'default + c' },
  ]);
});

// ---------------------------------------------------------------- web search

test('src/index.js:search:sql-limit-before-scope-filter: /app/api/search ranks only readable notes', async () => {
  const env = fakeEnv();
  const notes = { 'vault/projects/alpha.md': '# alpha\nzebra marmot ' + 'filler '.repeat(300) + '\n' };
  // out of scope for a 'vault/projects' prefix: same leading characters, different folder
  for (let i = 0; i < 70; i++) notes[`vault/projectsX/h${i}.md`] = '# h\nmarmot marmot\n';
  for (let i = 0; i < 70; i++) notes[`vault/private/p${i}.md`] = '# p\nmarmot marmot\n';
  seedNotes(env, notes);
  const { key } = await createKey(env, { name: 'ro', role: 'read', prefixes: ['vault/projects'] });
  const { cookie } = await appLogin(env, key);
  const r = await json(await appGet(env, cookie, '/app/api/search?q=marmot'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.path), ['vault/projects/alpha.md']);

  const { key: projKey } = await createKey(env, { name: 'proj', role: 'read', prefixes: ['project:alpha'] });
  const p = await json(await appGet(env, (await appLogin(env, projKey)).cookie, '/app/api/search?q=marmot'));
  assert.deepEqual(p.body.results.map((x) => x.path), ['vault/projects/alpha.md']);

  const root = await json(await appGet(env, (await appLogin(env, env.BRAIN_TOKEN)).cookie, '/app/api/search?q=marmot'));
  assert.equal(root.body.results.length, 20);
});

// ---------------------------------------------------------------- sessions

test('src/auth.js:resolvePrincipal/derived-token-ignores-parent-key-expiry: web session exp and Max-Age are capped at the key expiry', async () => {
  const env = fakeEnv();
  const { key } = await createKey(env, { name: 'short', role: 'read', expires_days: 2 });
  const { token, res } = await appLogin(env, key);
  const row = env.DB.sqlite.prepare('SELECT t.exp, k.expires FROM oauth_tokens t JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ?').get(sha256hex(token));
  assert.equal(row.exp, row.expires);
  const maxAge = Number(/Max-Age=(\d+)/.exec(res.headers.get('set-cookie'))[1]);
  assert.ok(maxAge > 2 * 86400 - 60 && maxAge <= 2 * 86400, String(maxAge));

  const { token: rootTok, res: rootRes } = await appLogin(env, env.BRAIN_TOKEN);
  const rootRow = env.DB.sqlite.prepare("SELECT abs(strftime('%s', exp) - strftime('%s', 'now', '+30 days')) <= 2 AS full FROM oauth_tokens WHERE token_hash = ?").get(sha256hex(rootTok));
  assert.equal(rootRow.full, 1);
  assert.match(rootRes.headers.get('set-cookie'), /Max-Age=2592000/);
});

test('hardening: the brain_session cookie must be its own cookie, not a suffix of another name', async () => {
  const env = fakeEnv();
  const { token } = await appLogin(env, env.BRAIN_TOKEN);
  assert.equal((await appGet(env, `xbrain_session=${token}`, '/app/api/me')).status, 401);
  assert.equal((await appGet(env, `other=1; xbrain_session=${token}`, '/app/api/me')).status, 401);
  assert.equal((await appGet(env, `other=1; brain_session=${token}`, '/app/api/me')).status, 200);
  assert.equal((await appGet(env, `brain_session=${token}`, '/app/api/me')).status, 200);
});

test('scoped session smoke: /app/api/graph and /app/api/check stay scoped and working', async () => {
  const env = fakeEnv();
  seedNotes(env, {
    'vault/projects/alpha.md': '---\ntitle: Alpha\ntype: project\n---\nsee [[beta]] [[secret]]\n',
    'vault/projects/beta.md': '# beta\n',
    'vault/secret.md': '# s\n',
  });
  const { key } = await createKey(env, { name: 'ro', role: 'read', prefixes: ['vault/projects/'] });
  const { cookie } = await appLogin(env, key);
  const g = await json(await appGet(env, cookie, '/app/api/graph'));
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.nodes.map((n) => n.id).sort(), ['vault/projects/alpha.md', 'vault/projects/beta.md']);
  assert.deepEqual(g.body.links, [{ source: 'vault/projects/alpha.md', target: 'vault/projects/beta.md' }]);
  const c = await json(await appGet(env, cookie, '/app/api/check'));
  assert.deepEqual(c.body.broken_links, [{ src: 'vault/projects/alpha.md', dst: 'secret' }]);
});

// ---------------------------------------------------------------- hook script

test('src/hook.js:hook-runtime:shared-tmp-spool-dir: the shipped hook keeps a private per-user spool', () => {
  const inst = hookInstaller('https://brain.example.invalid');
  const m = inst.match(/<<'B64_EOF'\n([\s\S]*?)\nB64_EOF/);
  const script = Buffer.from(m[1].replace(/\n/g, ''), 'base64').toString('utf8');
  assert.equal(HOOK_VERSION, '2');
  assert.match(script, /version 2\n/);
  assert.doesNotMatch(script, /\/tmp|TMPDIR|brain-spool/);
  assert.match(script, /\numask 077\nSPOOL="\$\{BRAIN_SPOOL:-\$\{XDG_CACHE_HOME:-\$HOME\/\.cache\}\/brain-mcp\/spool\}"\nmkdir -p -m 700 "\$SPOOL" 2>\/dev\/null \|\| exit 0\n/);
  assert.match(script, /\[ -d "\$SPOOL" \] && \[ ! -L "\$SPOOL" \] && \[ -O "\$SPOOL" \] \|\| exit 0\nchmod 700 "\$SPOOL"/);
  // both Python halves refuse a spool that is not a private directory and open files without following links
  const append = script.slice(script.indexOf("<<'PYAPPEND'"), script.indexOf('\nPYAPPEND\n'));
  const flush = script.slice(script.indexOf("<<'PYFLUSH'"), script.indexOf('\nPYFLUSH\n'));
  for (const py of [append, flush]) {
    assert.match(py, /NOFOLLOW = getattr\(os, "O_NOFOLLOW", 0\)/);
    assert.match(py, /st\.st_uid == UID and not st\.st_mode & 0o077/);
    assert.match(py, /if not private_dir\(spool\):\n    sys\.exit\(0\)/);
    assert.match(py, /import [^\n]*\bstat\b[^\n]*\bsys\b/);
    assert.doesNotMatch(py, /\$\{|open\(path, "a"|open\(batch, encoding/);
  }
  assert.match(append, /open_own\(path, os\.O_RDWR \| os\.O_APPEND \| os\.O_CREAT\)/);
  assert.match(flush, /open_own\(batch, os\.O_RDONLY\)/);
});

// ---------------------------------------------------------------- UI + config (static checks)

test('ui/src/views/GraphView.tsx:nodeLabel:frontmatter-title-html: the hover label is HTML-escaped text', () => {
  const tsx = src('ui/src/views/GraphView.tsx');
  assert.match(tsx, /\.nodeLabel\(\(n\) => escapeHtml\(`\$\{n\.title \|\| n\.id\}  ·  \$\{n\.type\}`\)\)/);
  const fn = /const escapeHtml = \(s: string\) => (.+)\n/.exec(tsx)[1];
  const escapeHtml = new Function('s', `return ${fn}`);
  const payload = `<img src=x onerror="alert('x')">&`;
  assert.equal(escapeHtml(payload), '&#60;img src=x onerror=&#34;alert(&#39;x&#39;)&#34;&#62;&#38;');
  assert.doesNotMatch(escapeHtml(payload), /[<>"']/);
});

test("hardening: NoteView keeps react-markdown's URL filter and only lets the wikilink schemes through", () => {
  const tsx = src('ui/src/views/NoteView.tsx');
  assert.doesNotMatch(tsx, /urlTransform=\{\(url\) => url\}/);
  assert.match(tsx, /import ReactMarkdown, \{ defaultUrlTransform, type Components \} from 'react-markdown'/);
  assert.match(tsx, /url\.startsWith\(WIKI_SCHEME\) \|\| url\.startsWith\(WIKI_DEAD\) \? url : defaultUrlTransform\(url\)/);
  assert.match(tsx, /urlTransform=\{urlTransform\}/);
});

test('wrangler.jsonc:workers_dev-preview_urls-unset: Preview URLs are off and workers.dev is left on for the webhook', () => {
  const cfg = src('wrangler.jsonc');
  assert.match(cfg, /\n  "preview_urls": false,\n/);
  assert.doesNotMatch(cfg, /"workers_dev"/);
});
