// Key management + principal resolution.
// Access = named API keys in D1 (role + scopes, revocable, expiring). A scope is
// either a repo path prefix (`vault/logs/`) or `project:<slug>`, which resolves on
// every request to wherever that project's notes live right now.
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

const SLUG = /^[A-Za-z0-9._-]+$/;
export const isProjectSlug = (slug) => SLUG.test(String(slug));

/** The slug a `project:<slug>` scope names, or null for a path prefix. */
export function projectScopeSlug(scope) {
  const s = String(scope);
  if (!s.startsWith('project:')) return null;
  const slug = s.slice('project:'.length);
  return isProjectSlug(slug) ? slug : null;
}

const ROLES = ['read', 'write', 'admin'];

/** Clean a scope list from the API: trimmed, de-duplicated, no empties. */
export function normalizeScopes(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('prefixes must be an array of scopes');
  const out = [];
  for (const raw of input) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s.length > 200) throw new Error('scope is too long');
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Turn scopes into the path prefixes `allowed()` matches against: `project:<slug>`
 * becomes the project note, a same-named folder, and every indexed note currently
 * filed under that project. Expanding per request (rather than at key creation)
 * means notes added to the project later are covered without re-issuing the key.
 */
export async function expandScopes(env, scopes) {
  const slugs = [...new Set(scopes.map(projectScopeSlug).filter(Boolean))];
  if (!slugs.length) return scopes;

  const prefixes = scopes.filter((s) => !projectScopeSlug(s));
  for (const slug of slugs) prefixes.push(`vault/projects/${slug}.md`, `vault/projects/${slug}/`);
  const marks = slugs.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT path FROM notes WHERE project IN (${marks})`)
    .bind(...slugs)
    .all()
    .catch(() => ({ results: [] }));
  for (const r of rows.results) prefixes.push(r.path);
  return prefixes;
}

/**
 * Resolve a bearer token to a principal:
 * { role: 'read'|'write'|'admin', scopes: string[], prefixes: string[], via, name }
 * `scopes` is what was granted (for display), `prefixes` the expanded paths used for
 * access checks. Both empty = the whole brain. Returns null if invalid.
 */
export async function resolvePrincipal(env, token) {
  if (!token) return null;
  if (timingSafeEq(token, env.BRAIN_TOKEN)) {
    return { role: 'admin', scopes: [], prefixes: [], via: 'root', name: 'root' };
  }

  const hash = await sha256hex(token);

  const key = await env.DB.prepare(
    "SELECT id, name, role, prefixes FROM api_keys WHERE key_hash = ? AND revoked = 0 AND (expires IS NULL OR expires = '' OR expires > datetime('now'))"
  ).bind(hash).first().catch(() => null);
  if (key) {
    await env.DB.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").bind(key.id).run().catch(() => {});
    const scopes = JSON.parse(key.prefixes || '[]');
    return { role: key.role, scopes, prefixes: await expandScopes(env, scopes), via: 'key', name: key.name, keyId: key.id };
  }

  const tok = await env.DB.prepare(
    "SELECT role, prefixes, client_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND exp > datetime('now')"
  ).bind(hash).first().catch(() => null);
  if (tok) {
    const scopes = JSON.parse(tok.prefixes || '[]');
    return { role: tok.role || 'admin', scopes, prefixes: await expandScopes(env, scopes), via: 'oauth', name: tok.client_id };
  }

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

const expiresSql = (days) =>
  days == null || days === '' ? 'NULL' : `datetime('now', '+${Math.max(1, Math.min(3650, Number(days) | 0))} days')`;

/** Create a key. Returns { id, key } — the plaintext key is shown exactly once. */
export async function createKey(env, { name, role = 'read', prefixes = [], expires_days = null }) {
  if (!ROLES.includes(role)) throw new Error('role must be read|write|admin');
  const scopes = normalizeScopes(prefixes);
  const id = 'k_' + randToken(6);
  const key = 'bk_' + randToken(24);
  await env.DB.prepare(
    `INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ${expiresSql(expires_days)}, 0)`
  ).bind(id, await sha256hex(key), String(name || id), role, JSON.stringify(scopes)).run();
  return { id, key };
}

/**
 * Re-scope an existing key in place (name / role / scopes / expiry) so granting or
 * narrowing someone's access does not mean handing them a new secret. Only the
 * fields present in `patch` change. Live web sessions and connector tokens minted
 * from the key are updated too, otherwise a narrowed key keeps its old reach until
 * those expire.
 */
export async function updateKey(env, id, patch = {}) {
  const current = await env.DB.prepare('SELECT id, role, prefixes FROM api_keys WHERE id = ?').bind(id).first();
  if (!current) throw new Error('no such key');

  const sets = [];
  const binds = [];
  let role = current.role;
  let scopes = JSON.parse(current.prefixes || '[]');

  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new Error('name cannot be empty');
    sets.push('name = ?');
    binds.push(name);
  }
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw new Error('role must be read|write|admin');
    role = patch.role;
    sets.push('role = ?');
    binds.push(role);
  }
  if (patch.prefixes !== undefined) {
    scopes = normalizeScopes(patch.prefixes);
    sets.push('prefixes = ?');
    binds.push(JSON.stringify(scopes));
  }
  if (patch.expires_days !== undefined) sets.push(`expires = ${expiresSql(patch.expires_days)}`);
  if (!sets.length) throw new Error('nothing to update');

  await env.DB.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  if (patch.role !== undefined || patch.prefixes !== undefined) {
    await env.DB.prepare('UPDATE oauth_tokens SET role = ?, prefixes = ? WHERE key_id = ?')
      .bind(role, JSON.stringify(scopes), id)
      .run()
      .catch(() => {});
  }
  return getKey(env, id);
}

const rowToKey = (k) => ({ ...k, prefixes: JSON.parse(k.prefixes || '[]') });
const KEY_COLUMNS = 'id, name, role, prefixes, created, expires, revoked, last_used';

export async function getKey(env, id) {
  const r = await env.DB.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).bind(id).first();
  return r ? rowToKey(r) : null;
}

export async function listKeys(env) {
  const r = await env.DB.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created DESC`).all();
  return r.results.map(rowToKey);
}

export async function revokeKey(env, id) {
  await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').bind(id).run();
  // also kill every web session / connector token minted from this key
  await env.DB.prepare('DELETE FROM oauth_tokens WHERE key_id = ?').bind(id).run().catch(() => {});
}
