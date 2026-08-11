// Key management + principal resolution.
// Access = named API keys in D1 (role + path-prefix scopes, revocable, expiring).
// The BRAIN_TOKEN env secret is only break-glass bootstrap (full admin) so you can
// never lock yourself out; day-to-day access should use managed keys.

const enc = new TextEncoder();

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const randToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function timingSafeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve a bearer token to a principal: { role: 'read'|'write'|'admin', prefixes: string[], via, name }
 * prefixes [] = whole brain. Returns null if invalid.
 */
export async function resolvePrincipal(env, token) {
  if (!token) return null;
  if (timingSafeEq(token, env.BRAIN_TOKEN)) return { role: 'admin', prefixes: [], via: 'root', name: 'root' };

  const hash = await sha256hex(token);

  const key = await env.DB.prepare(
    "SELECT id, name, role, prefixes FROM api_keys WHERE key_hash = ? AND revoked = 0 AND (expires IS NULL OR expires = '' OR expires > datetime('now'))"
  ).bind(hash).first().catch(() => null);
  if (key) {
    await env.DB.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").bind(key.id).run().catch(() => {});
    return { role: key.role, prefixes: JSON.parse(key.prefixes || '[]'), via: 'key', name: key.name, keyId: key.id };
  }

  const tok = await env.DB.prepare(
    "SELECT role, prefixes, client_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND exp > datetime('now')"
  ).bind(hash).first().catch(() => null);
  if (tok) return { role: tok.role || 'admin', prefixes: JSON.parse(tok.prefixes || '[]'), via: 'oauth', name: tok.client_id };

  return null;
}

/** May this principal read the given repo path? */
export function allowed(p, path) {
  if (!p) return false;
  if (!p.prefixes || p.prefixes.length === 0) return true;
  return p.prefixes.some((pre) => path.startsWith(pre));
}
export const canWrite = (p) => !!p && (p.role === 'write' || p.role === 'admin');
export const isAdmin = (p) => !!p && p.role === 'admin';

/** Create a key. Returns { id, key } — the plaintext key is shown exactly once. */
export async function createKey(env, { name, role = 'read', prefixes = [], expires_days = null }) {
  if (!['read', 'write', 'admin'].includes(role)) throw new Error('role must be read|write|admin');
  const id = 'k_' + randToken(6);
  const key = 'bk_' + randToken(24);
  const expires = expires_days ? `datetime('now', '+${Math.max(1, Math.min(3650, Number(expires_days) | 0))} days')` : 'NULL';
  await env.DB.prepare(
    `INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ${expires}, 0)`
  ).bind(id, await sha256hex(key), String(name || id), role, JSON.stringify(prefixes)).run();
  return { id, key };
}

export async function listKeys(env) {
  const r = await env.DB.prepare(
    'SELECT id, name, role, prefixes, created, expires, revoked, last_used FROM api_keys ORDER BY created DESC'
  ).all();
  return r.results.map((k) => ({ ...k, prefixes: JSON.parse(k.prefixes || '[]') }));
}

export async function revokeKey(env, id) {
  await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').bind(id).run();
  // also kill every web session / connector token minted from this key
  await env.DB.prepare('DELETE FROM oauth_tokens WHERE key_id = ?').bind(id).run().catch(() => {});
}
