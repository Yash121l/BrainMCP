import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fakeEnv, stubFetch, advanceClock, sha256hex } from './helpers/fake-env.mjs';
import {
  safeRepoPath, allowed, isAdmin, isRootAdmin, isProjectSlug, projectScopeSlug,
  createKey, updateKey, revokeKey, resolvePrincipal,
} from '../src/auth.js';
import { getFile, putFile, multiCommit } from '../src/github.js';
import { handleOauth } from '../src/oauth.js';
import { handleApp } from '../src/app.js';

stubFetch(); // nothing here may touch the network

const O = 'https://brain.test';
const REDIRECT = 'https://client.test/cb';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const post = (handler, env, path, fields) => {
  const u = new URL(O + path);
  return handler(new Request(u, { method: 'POST', body: new URLSearchParams(fields) }), env, u);
};
const login = async (env, access_key) => {
  const r = await post(handleApp, env, '/app/login', { access_key });
  return /brain_session=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1] ?? null;
};
async function register(env) {
  const u = new URL(O + '/register');
  const r = await handleOauth(new Request(u, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) }), env, u);
  return (await r.json()).client_id;
}
async function authorize(env, client_id, access_key) {
  const verifier = b64url(randomBytes(32));
  const r = await post(handleOauth, env, '/authorize', {
    client_id, redirect_uri: REDIRECT, code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256', access_key,
  });
  assert.equal(r.status, 302);
  return { code: new URL(r.headers.get('location')).searchParams.get('code'), verifier };
}
const exchange = (env, client_id, { code, verifier }) =>
  post(handleOauth, env, '/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT });
const refresh = (env, refresh_token) => post(handleOauth, env, '/token', { grant_type: 'refresh_token', refresh_token });
const tokenRow = (env, tok) => env.DB.sqlite.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(sha256hex(tok));

// ---------------------------------------------------------------- path scopes

test('brainmcp:auth.allowed:unnormalized-path-prefix-scope-bypass: safeRepoPath accepts only canonical paths', () => {
  for (const ok of ['vault/projects/alpha.md', 'skills/x/SKILL.md', 'a', 'vault/a b/c%2e.md'])
    assert.equal(safeRepoPath(ok), ok);
  for (const bad of ['', '/vault/a.md', 'vault//a.md', 'vault/a/', 'vault/./a.md', './a', 'vault/logs/../projects/b.md', '..',
    'vault\\a.md', 'vault/a\u0000.md', 'vault/a\n.md', 'vault/\u007f', null, undefined, 42, ['vault/a.md']])
    assert.equal(safeRepoPath(bad), null, JSON.stringify(bad));
});

test('brainmcp:auth.allowed:unnormalized-path-prefix-scope-bypass: allowed() rejects dot segments and matches on boundaries', () => {
  const logs = { prefixes: ['vault/logs/'] };
  assert.equal(allowed(logs, 'vault/logs/decisions.md'), true);
  assert.equal(allowed(logs, 'vault/logs/../projects/beta-secret.md'), false);
  assert.equal(allowed(logs, 'vault/logs/../../skills/evil/run.sh'), false);
  assert.equal(allowed(logs, 'vault/logsX/a.md'), false);

  const alpha = { prefixes: ['vault/projects/alpha.md', 'vault/projects/alpha/', 'vault/logs'] };
  assert.equal(allowed(alpha, 'vault/projects/alpha.md'), true);
  assert.equal(allowed(alpha, 'vault/projects/alpha.md/../beta-secret.md'), false);
  assert.equal(allowed(alpha, 'vault/projects/alpha.mdx'), false);
  assert.equal(allowed(alpha, 'vault/projects/alpha/notes.md'), true);
  assert.equal(allowed(alpha, 'vault/logs/x.md'), true); // non-slash prefix on a '/' boundary
  assert.equal(allowed(alpha, 'vault/logsbook.md'), false);

  const root = { prefixes: [] };
  assert.equal(allowed(root, 'vault/a.md'), true);
  assert.equal(allowed(root, 'vault/../a.md'), false);
  assert.equal(allowed(null, 'vault/a.md'), false);
});

test('brainmcp:auth.allowed:unnormalized-path-prefix-scope-bypass: github helpers refuse non-canonical paths and encode segments', async () => {
  const env = fakeEnv();
  const net = stubFetch((req) => (req.method === 'PUT'
    ? Response.json({ content: { sha: 'new' } }, { status: 201 })
    : Response.json({ content: btoa('hi'), sha: 's1' })));
  try {
    for (const bad of ['vault/logs/../rules/beta.md', 'vault/logs/../../skills/evil/run.sh', '/etc/x', 'a//b']) {
      await assert.rejects(getFile(env, bad), /invalid repo path/);
      await assert.rejects(putFile(env, bad, 'x', 'm'), /invalid repo path/);
      await assert.rejects(multiCommit(env, [{ path: 'vault/ok.md', content: '' }, { path: bad, content: 'x' }], 'm'), /invalid repo path/);
    }
    assert.equal(net.calls.length, 0, 'no request may leave for a rejected path');

    assert.deepEqual(await getFile(env, 'vault/a #?.md'), { content: 'hi', sha: 's1' });
    await putFile(env, 'vault/b%2e.md', 'x', 'm');
    assert.equal(new URL(net.calls[0].url).pathname, '/repos/test-owner/test-brain/contents/vault/a%20%23%3F.md');
    assert.equal(new URL(net.calls[1].url).pathname, '/repos/test-owner/test-brain/contents/vault/b%252e.md');
  } finally {
    net.restore();
    stubFetch();
  }
});

test('isProjectSlug rejects slugs that do not start with [a-z0-9]', () => {
  for (const ok of ['alpha', 'pulse-2', '0day', 'a.b_c-D']) assert.equal(isProjectSlug(ok), true, ok);
  for (const bad of ['', '.', '..', '.hidden', '-x', '_x', 'Alpha', 'a/b', 'a b', '../x']) assert.equal(isProjectSlug(bad), false, bad);
  assert.equal(projectScopeSlug('project:..'), null);
});

// ---------------------------------------------------------------- admin scope

test('src/auth.js:isAdmin/scope-agnostic-key-management: scoped admin keys cannot be created or made, and are not root admins', async () => {
  const env = fakeEnv();
  await assert.rejects(createKey(env, { name: 'a', role: 'admin', prefixes: ['vault/projects/alpha/'] }), /admin keys cannot be scoped/);
  await assert.rejects(createKey(env, { name: 'a', role: 'admin', prefixes: ['project:alpha'] }), /admin keys cannot be scoped/);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS c FROM api_keys').get().c, 0);

  const admin = await createKey(env, { name: 'admin', role: 'admin', prefixes: [] });
  await assert.rejects(updateKey(env, admin.id, { prefixes: ['vault/logs/'] }), /admin keys cannot be scoped/);
  const writer = await createKey(env, { name: 'w', role: 'write', prefixes: ['vault/logs/'] });
  await assert.rejects(updateKey(env, writer.id, { role: 'admin' }), /admin keys cannot be scoped/);
  assert.equal((await updateKey(env, writer.id, { role: 'admin', prefixes: [] })).role, 'admin');

  assert.equal(isRootAdmin(await resolvePrincipal(env, env.BRAIN_TOKEN)), true);
  assert.equal(isRootAdmin(await resolvePrincipal(env, admin.key)), true);
  // a scoped admin row that predates this check still resolves, but is not a root admin
  env.DB.sqlite.prepare("INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, revoked) VALUES ('k_legacy', ?, 'legacy', 'admin', '[\"vault/projects/alpha/\"]', datetime('now'), 0)")
    .run(sha256hex('bk_legacy'));
  const legacy = await resolvePrincipal(env, 'bk_legacy');
  assert.equal(isAdmin(legacy), true);
  assert.equal(isRootAdmin(legacy), false);
  assert.equal(isRootAdmin({ role: 'write', scopes: [] }), false);
  assert.equal(isRootAdmin(null), false);
});

// ---------------------------------------------------------------- derived credential lineage

test('src/auth.js:resolvePrincipal/oauth-branch-drops-key_id: credentials minted from a session stay bound to the key', async () => {
  const env = fakeEnv();
  const K = await createKey(env, { name: 'contractor', role: 'write', prefixes: ['vault/projects/alpha/'] });
  const S1 = await login(env, K.key);
  const S2 = await login(env, S1); // laundering attempt: log in with the session itself
  assert.equal(tokenRow(env, S2).key_id, K.id);
  assert.equal((await resolvePrincipal(env, S2)).keyId, K.id);

  const client = await register(env);
  const tok = await (await exchange(env, client, await authorize(env, client, S1))).json();
  assert.equal(tokenRow(env, tok.access_token).key_id, K.id);
  assert.equal(tokenRow(env, tok.refresh_token).key_id, K.id);

  await updateKey(env, K.id, { role: 'read' });
  assert.equal((await resolvePrincipal(env, S2)).role, 'read');
  assert.equal((await resolvePrincipal(env, tok.access_token)).role, 'read');

  await revokeKey(env, K.id);
  for (const t of [S1, S2, tok.access_token]) assert.equal(await resolvePrincipal(env, t), null);
  assert.equal((await refresh(env, tok.refresh_token)).status, 400);
});

test('src/auth.js:resolvePrincipal/oauth-branch-drops-key_id: unlinked tokens are rejected and root-derived ones die on BRAIN_TOKEN rotation', async () => {
  const env = fakeEnv();
  env.DB.sqlite.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'webapp', datetime('now', '+30 days'), 'admin', '[]', NULL)")
    .run(sha256hex('orphan'));
  assert.equal(await resolvePrincipal(env, 'orphan'), null);

  const R1 = await login(env, env.BRAIN_TOKEN);
  const R2 = await login(env, R1);
  const client = await register(env);
  const tok = await (await exchange(env, client, await authorize(env, client, env.BRAIN_TOKEN))).json();
  for (const t of [R1, R2, tok.access_token]) {
    assert.match(tokenRow(env, t).key_id, /^root:[0-9a-f]{16}$/);
    assert.equal((await resolvePrincipal(env, t)).role, 'admin');
  }
  assert.ok(!tokenRow(env, R1).key_id.includes(env.BRAIN_TOKEN));

  env.BRAIN_TOKEN = 'rotated-root-token-111111111111111';
  for (const t of [R1, R2, tok.access_token]) assert.equal(await resolvePrincipal(env, t), null);
  assert.equal((await refresh(env, tok.refresh_token)).status, 400);
  assert.equal((await resolvePrincipal(env, await login(env, env.BRAIN_TOKEN))).role, 'admin');
});

test('src/auth.js:resolvePrincipal/derived-token-ignores-parent-key-expiry: sessions and OAuth tokens die with the key and refresh cannot extend them', async () => {
  const env = fakeEnv();
  const K = await createKey(env, { name: 'guest', role: 'read', prefixes: ['vault/projects/alpha/'], expires_days: 1 });
  const keyExp = env.DB.sqlite.prepare('SELECT expires FROM api_keys WHERE id = ?').get(K.id).expires;
  const sess = await login(env, K.key);
  const client = await register(env);
  const res = await exchange(env, client, await authorize(env, client, K.key));
  const tok = await res.json();
  assert.ok(tok.expires_in <= 86400, `expires_in ${tok.expires_in} capped at the key's expiry`);
  assert.equal(tokenRow(env, tok.access_token).exp, keyExp);
  assert.equal(tokenRow(env, tok.refresh_token).exp, keyExp);

  const r = await refresh(env, tok.refresh_token);
  assert.equal(r.status, 200);
  const tok2 = await r.json();
  assert.equal(tokenRow(env, tok2.refresh_token).exp, keyExp);

  advanceClock(env, 2);
  assert.equal(await resolvePrincipal(env, K.key), null);
  assert.equal(await resolvePrincipal(env, sess), null);
  assert.equal(await resolvePrincipal(env, tok2.access_token), null);
  // even if a refresh row outlived the key (e.g. minted before this fix), the grant re-checks the parent
  env.DB.sqlite.prepare("UPDATE oauth_tokens SET exp = datetime('now', '+80 days')").run();
  assert.equal((await refresh(env, tok2.refresh_token)).status, 400);
  assert.equal(await resolvePrincipal(env, tok2.access_token), null);

  // shortening a key's expiry cuts off sessions already minted from it
  const K2 = await createKey(env, { name: 'k2', role: 'read', prefixes: [], expires_days: 30 });
  const s2 = await login(env, K2.key);
  env.DB.sqlite.prepare("UPDATE api_keys SET expires = datetime('now', '-1 minute') WHERE id = ?").run(K2.id);
  assert.equal(await resolvePrincipal(env, s2), null);
});

test('src/auth.js:revokeKey/oauth_codes-not-revoked: pending codes are revoked and re-scoped with their key', async () => {
  const env = fakeEnv();
  const client = await register(env);
  const D = await createKey(env, { name: 'd', role: 'read', prefixes: ['project:alpha'] });
  const codeD = await authorize(env, client, D.key);
  await revokeKey(env, D.id);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS c FROM oauth_codes WHERE key_id = ?').get(D.id).c, 0);
  const r = await exchange(env, client, codeD);
  assert.equal(r.status, 400);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS c FROM oauth_tokens').get().c, 0);

  const E = await createKey(env, { name: 'e', role: 'write', prefixes: [] });
  const codeE = await authorize(env, client, E.key);
  await updateKey(env, E.id, { role: 'read', prefixes: ['project:alpha'] });
  const row = env.DB.sqlite.prepare('SELECT role, prefixes FROM oauth_codes WHERE key_id = ?').get(E.id);
  assert.deepEqual({ ...row }, { role: 'read', prefixes: '["project:alpha"]' });
  const tok = await (await exchange(env, client, codeE)).json();
  const p = await resolvePrincipal(env, tok.access_token);
  assert.equal(p.role, 'read');
  assert.deepEqual(p.scopes, ['project:alpha']);

  // a code whose key expired (or was removed) before exchange is refused even if the row survived
  const F = await createKey(env, { name: 'f', role: 'read', prefixes: [] });
  const codeF = await authorize(env, client, F.key);
  env.DB.sqlite.prepare("UPDATE api_keys SET expires = datetime('now', '-1 minute') WHERE id = ?").run(F.id);
  assert.equal((await exchange(env, client, codeF)).status, 400);
  const G = await createKey(env, { name: 'g', role: 'read', prefixes: [] });
  const codeG = await authorize(env, client, G.key);
  env.DB.sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(G.id);
  assert.equal((await exchange(env, client, codeG)).status, 400);
});
