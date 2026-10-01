import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fakeEnv, stubFetch } from './helpers/fake-env.mjs';
import { createKey, resolvePrincipal } from '../src/auth.js';
import { handleOauth } from '../src/oauth.js';

stubFetch(); // nothing here may touch the network

const O = 'https://brain.test';
const REDIRECT = 'https://client.test/cb';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};

const call = (path, init) => { const u = new URL(O + path); return handleOauth(new Request(u, init), env(), u); };
let current;
const env = () => current;
const register = (body) => call('/register', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const form = (path, fields) => call(path, { method: 'POST', body: new URLSearchParams(fields) });
const count = (table) => current.DB.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;

async function setup() {
  current = fakeEnv();
  const key = await createKey(current, { name: 'victim', role: 'write', prefixes: ['vault/projects/alpha/'] });
  const client = await (await register({ redirect_uris: [REDIRECT], client_name: 'Claude' })).json();
  return { key: key.key, client_id: client.client_id };
}
const authorizeFields = (client_id, access_key, p, extra = {}) => ({
  client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 's1', access_key, ...extra,
});

// ---------------------------------------------------------------- redirect binding + PKCE

test('src/oauth.js:authorize-redirect-uri-not-bound-to-client: codes only go to an exact registered redirect_uri', async () => {
  const { key, client_id } = await setup();
  const p = pkce();
  const q = (o) => '/authorize?' + new URLSearchParams(o);

  // GET: unknown client, unregistered URI, missing/plain PKCE
  assert.equal((await call(q({ client_id: 'nope', redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256' }))).status, 400);
  assert.equal((await call(q({ client_id, redirect_uri: 'https://attacker.example/cb', code_challenge: p.challenge, code_challenge_method: 'S256' }))).status, 400);
  assert.equal((await call(q({ client_id, redirect_uri: REDIRECT + '/x', code_challenge: p.challenge, code_challenge_method: 'S256' }))).status, 400);
  assert.equal((await call(q({ client_id, redirect_uri: REDIRECT }))).status, 400);
  assert.equal((await call(q({ client_id, redirect_uri: REDIRECT, code_challenge: p.verifier, code_challenge_method: 'plain' }))).status, 400);

  // a client row with no registered URIs (legacy) gets nothing
  current.DB.sqlite.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, created) VALUES ('legacy', '[]', datetime('now'))").run();
  assert.equal((await call(q({ client_id: 'legacy', redirect_uri: 'https://attacker.example/cb', code_challenge: p.challenge, code_challenge_method: 'S256' }))).status, 400);

  // POST re-checks everything before it looks at the key, and stores no code
  for (const bad of [
    { redirect_uri: 'https://attacker.example/cb' },
    { client_id: 'legacy', redirect_uri: 'https://attacker.example/cb' },
    { client_id: 'never-registered' },
    { code_challenge: '' },
    { code_challenge_method: 'plain' },
  ]) {
    const r = await form('/authorize', authorizeFields(client_id, key, p, bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(count('oauth_codes'), 0);

  // happy path
  const ok = await form('/authorize', authorizeFields(client_id, key, p));
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 's1');
  const code = loc.searchParams.get('code');

  // /token requires matching client_id, redirect_uri and PKCE verifier; each failure burns the code
  const tokenFields = { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id, redirect_uri: REDIRECT };
  for (const drop of ['client_id', 'redirect_uri', 'code_verifier']) {
    const fields = { ...tokenFields };
    delete fields[drop];
    const r2 = await form('/authorize', authorizeFields(client_id, key, p));
    const c2 = new URL(r2.headers.get('location')).searchParams.get('code');
    const res = await form('/token', { ...fields, code: c2 });
    assert.equal(res.status, 400, `missing ${drop}`);
  }
  const other = await (await register({ redirect_uris: [REDIRECT] })).json();
  const r3 = await form('/authorize', authorizeFields(client_id, key, p));
  const c3 = new URL(r3.headers.get('location')).searchParams.get('code');
  assert.equal((await form('/token', { ...tokenFields, code: c3, client_id: other.client_id })).status, 400);

  const res = await form('/token', tokenFields);
  assert.equal(res.status, 200);
  const tok = await res.json();
  const principal = await resolvePrincipal(current, tok.access_token);
  assert.equal(principal.role, 'write');
  assert.deepEqual(principal.scopes, ['vault/projects/alpha/']);
  assert.equal((await form('/token', tokenFields)).status, 400, 'codes are single-use');
});

test('src/oauth.js:authorize-redirect-uri-not-bound-to-client: consent page names the client and redirect host, fully escaped', async () => {
  current = fakeEnv();
  const { client_id } = await (await register({ redirect_uris: ['https://dest.example:8443/cb'], client_name: '<img src=x onerror=alert(1)>"Evil\'' })).json();
  const p = pkce();
  const state = `"><script>alert(1)</script>'&`;
  const r = await call('/authorize?' + new URLSearchParams({ client_id, redirect_uri: 'https://dest.example:8443/cb', code_challenge: p.challenge, code_challenge_method: 'S256', state }));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('dest.example:8443'));
  assert.ok(html.includes('&#60;img src=x onerror=alert(1)&#62;&#34;Evil&#39;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('value="&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;&#39;&#38;"'));
});

// ---------------------------------------------------------------- dynamic client registration

test('src/oauth.js:register-anonymous-unbounded-persistent-clients: registration is bounded and validated', async () => {
  current = fakeEnv();
  const bad = [
    '{}',
    'not json',
    'null',
    JSON.stringify({ redirect_uris: [] }),
    JSON.stringify({ redirect_uris: [{ a: 1 }] }),
    JSON.stringify({ redirect_uris: [42] }),
    JSON.stringify({ redirect_uris: ['http://attacker.example/cb'] }),
    JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    JSON.stringify({ redirect_uris: ['https://a.example/cb#frag'] }),
    JSON.stringify({ redirect_uris: ['https://' + 'a'.repeat(2048) + '.example/'] }),
    JSON.stringify({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }),
    JSON.stringify({ redirect_uris: [REDIRECT], client_name: { x: 1 } }),
  ];
  for (const body of bad) assert.equal((await register(body)).status, 400, body.slice(0, 60));
  const big = await register(JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(400_000) }));
  assert.equal(big.status, 413);
  assert.equal(count('oauth_clients'), 0);

  const ok = await register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/cb', 'http://127.0.0.1/cb'], client_name: 'n'.repeat(500) });
  assert.equal(ok.status, 201);
  const j = await ok.json();
  assert.equal(j.client_name.length, 100);
  const row = current.DB.sqlite.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(j.client_id);
  assert.equal(row.client_name.length, 100);
  assert.equal(JSON.parse(row.redirect_uris).length, 3);
});

test('src/oauth.js:register-anonymous-unbounded-persistent-clients: registration still works on a D1 without the client_name column', async () => {
  current = fakeEnv();
  current.DB.sqlite.exec('ALTER TABLE oauth_clients DROP COLUMN client_name');
  const r = await register({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  assert.equal(r.status, 201);
  const { client_id } = await r.json();
  const p = pkce();
  const page = await call('/authorize?' + new URLSearchParams({ client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256' }));
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('client.test'));
});

test('hardening: POST /authorize with a wrong key issues nothing', async () => {
  const { client_id } = await setup();
  const r = await form('/authorize', authorizeFields(client_id, 'bk_wrong', pkce()));
  assert.equal(r.status, 403);
  assert.equal(count('oauth_codes'), 0);
});
