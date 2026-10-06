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

const SLUG = /^[a-z0-9][A-Za-z0-9._-]*$/;
export function isProjectSlug(slug) {
  return SLUG.test(String(slug));
}

/**
 * The path itself if it is a canonical repo path (relative, no backslash or control
 * characters, no empty / '.' / '..' segment), else null. allowed() authorizes this
 * exact string and github.js sends this exact string, so the two cannot diverge.
 */
export function safeRepoPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
  return path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') ? null : path;
}

/** The slug a `project:<slug>` scope names, or null for a path prefix. */
export function projectScopeSlug(scope) {
  const s = String(scope);
  if (!s.startsWith('project:')) return null;
  const slug = s.slice('project:'.length);
  return isProjectSlug(slug) ? slug : null;
}

const ROLES = ['read', 'write', 'admin', 'super'];

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
export async function expandScopes(db, scopes) {
  const slugs = [...new Set(scopes.map(projectScopeSlug).filter(Boolean))];
  if (!slugs.length) return scopes;

  const prefixes = scopes.filter((s) => !projectScopeSlug(s));
  for (const slug of slugs) prefixes.push(`vault/projects/${slug}.md`, `vault/projects/${slug}/`);
  const marks = slugs.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT path FROM notes WHERE project IN (${marks})`)
    .bind(...slugs)
    .all()
    .catch(() => ({ results: [] }));
  for (const r of rows.results) prefixes.push(r.path);
  return prefixes;
}

const LIVE_KEY = "k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now'))";

/**
 * key_id stamped on credentials minted from BRAIN_TOKEN: a short hash of the current
 * secret, so rotating BRAIN_TOKEN orphans every root-derived session and token.
 */
export async function rootKeyId(env) {
  return env.BRAIN_TOKEN ? 'root:' + (await sha256hex('brainmcp-root-generation:' + env.BRAIN_TOKEN)).slice(0, 16) : null;
}

/**
 * The live parent of a derived credential, or null if it is revoked, expired, missing
 * or a stale root generation: { role, scopes, expires } with the key's current grant.
 */
export async function parentKey(env, keyId) {
  if (!keyId) return null;
  if (keyId === (await rootKeyId(env))) return { role: 'admin', scopes: [], expires: null };
  const k = await env.DB.prepare(
    `SELECT k.role, k.prefixes, k.expires FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
     WHERE k.id = ? AND ${LIVE_KEY} AND (k.user_id IS NULL OR u.status = 'active')`
  ).bind(keyId).first().catch(() => null);
  return k ? { role: roleWithoutSuper(k.role), scopes: JSON.parse(k.prefixes || '[]'), expires: k.expires || null } : null;
}

export const roleWithoutSuper = (role) => (role === 'super' ? 'admin' : role);

const jsonList = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};

/** The machine / agent identity a key carries; empty for keys minted before machines existed. */
function agentOf(row) {
  return { machineId: row.machine_id || null, agent: row.agent || null, agentTags: jsonList(row.agent_tags), pinned: jsonList(row.pinned) };
}

/** A browser session on the web console, as opposed to an agent's key or connector token. */
export const isHumanSession = (p) => !!p && p.via === 'oauth' && p.name === 'webapp';

const superUser = (env) => env.DB.prepare('SELECT * FROM users WHERE is_super = 1 ORDER BY created LIMIT 1').first().catch(() => null);

async function withUser(env, p, userId, spaceLimit) {
  const user = userId
    ? await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first().catch(() => null)
    : await superUser(env);
  if ((userId && !user) || (user && user.status !== 'active')) return null;
  const isSuper = !!user?.is_super && (p.via === 'root' || p.role === 'super');
  return {
    ...p,
    role: p.role === 'super' && !isSuper ? 'admin' : p.role,
    user: user || null,
    legacy: !userId,
    spaceLimit: spaceLimit ? JSON.parse(spaceLimit) : null,
    super: isSuper,
  };
}

/**
 * Resolve a bearer token to a principal:
 * { role: 'read'|'write'|'admin', scopes: string[], prefixes: string[], via, name, keyId, expires }
 * `scopes` is what was granted (for display), `prefixes` the expanded paths used for
 * access checks. Both empty = the whole brain. `keyId` is the parent key (or root
 * generation) every credential minted from this principal must carry; `expires` is
 * that key's expiry, which derived credentials must not outlive. Returns null if invalid.
 */
export async function resolvePrincipal(env, token) {
  if (!token) return null;
  if (timingSafeEq(token, env.BRAIN_TOKEN)) {
    return withUser(env, { role: 'admin', scopes: [], prefixes: [], via: 'root', name: 'root', keyId: await rootKeyId(env), expires: null }, null, null);
  }

  const hash = await sha256hex(token);

  const key = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0 AND (expires IS NULL OR expires = '' OR expires > datetime('now'))"
  ).bind(hash).first().catch(() => null);
  if (key) {
    await env.DB.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").bind(key.id).run().catch(() => {});
    if (key.machine_id) await env.DB.prepare("UPDATE machines SET last_seen = datetime('now') WHERE id = ?").bind(key.machine_id).run().catch(() => {});
    const scopes = JSON.parse(key.prefixes || '[]');
    return withUser(env, { role: key.role, scopes, prefixes: await expandScopes(env.DB, scopes), via: 'key', name: key.name, keyId: key.id, expires: key.expires || null, ...agentOf(key) },
      key.user_id, key.space_limit);
  }

  // A session / connector token is only as alive as its parent: the current root
  // generation, or a managed key that still exists, is not revoked and has not expired.
  const tok = await env.DB.prepare(
    `SELECT t.role, t.prefixes, t.client_id, t.key_id, k.role AS key_role, k.expires AS key_expires, k.user_id, k.space_limit,
            k.machine_id, k.agent, k.agent_tags, k.pinned FROM oauth_tokens t LEFT JOIN api_keys k ON k.id = t.key_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.exp > datetime('now') AND (t.key_id = ? OR (${LIVE_KEY}))`
  ).bind(hash, await rootKeyId(env)).first().catch(() => null);
  if (tok) {
    const scopes = JSON.parse(tok.prefixes || '[]');
    const superSession = tok.client_id === 'webapp' && tok.role === 'super' && tok.key_role === 'super';
    return withUser(env, { role: superSession ? 'super' : roleWithoutSuper(tok.role || 'read'), scopes, prefixes: await expandScopes(env.DB, scopes), via: 'oauth', name: tok.client_id, keyId: tok.key_id, expires: tok.key_expires || null, ...agentOf(tok) },
      tok.user_id || null, tok.space_limit || null);
  }

  return null;
}

/**
 * Rebuild the principal behind a key id, for work that continues without the bearer
 * token (code-mode tool calls). The key must still be live, exactly as at login.
 */
export async function principalForKey(env, keyId) {
  if (!keyId) return null;
  if (keyId === (await rootKeyId(env))) {
    return withUser(env, { role: 'admin', scopes: [], prefixes: [], via: 'root', name: 'root', keyId, expires: null }, null, null);
  }
  const key = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE id = ? AND revoked = 0 AND (expires IS NULL OR expires = '' OR expires > datetime('now'))"
  ).bind(keyId).first().catch(() => null);
  if (!key) return null;
  const scopes = JSON.parse(key.prefixes || '[]');
  return withUser(env, { role: key.role, scopes, prefixes: await expandScopes(env.DB, scopes), via: 'key', name: key.name, keyId: key.id, expires: key.expires || null, ...agentOf(key) },
    key.user_id, key.space_limit);
}

/**
 * May this principal read the given repo path? Non-canonical paths never pass. A
 * prefix ending in '/' is a folder; any other prefix matches itself or below a '/'.
 */
export function allowed(p, path) {
  if (!p || safeRepoPath(path) === null) return false;
  if (!p.prefixes || p.prefixes.length === 0) return true;
  return p.prefixes.some((pre) => (pre.endsWith('/') ? path.startsWith(pre) : path === pre || path.startsWith(pre + '/')));
}
export const canWrite = (p) => !!p && (p.role === 'write' || p.role === 'admin' || p.role === 'super');

export const isBindingPath = (path) =>
  path === 'vault/skills.md' || path.startsWith('vault/rules/') || path.startsWith('skills/');

export function canWritePath(p, path) {
  if (!canWrite(p) || !allowed(p, path)) return false;
  if (isBindingPath(path) && p.publish === false) return false;
  if (p.writePrefixes && !(p.writePrefixes.length && allowed({ prefixes: p.writePrefixes }, path))) return false;
  if (!isBindingPath(path) || !p.scopes?.length) return true;
  const explicitPathScopes = p.scopes.filter((s) => !projectScopeSlug(s));
  return explicitPathScopes.length > 0 && allowed({ prefixes: explicitPathScopes }, path);
}
export const isAdmin = (p) => !!p && (p.role === 'admin' || p.role === 'super');
export const isRootAdmin = (p) => isAdmin(p) && (!p.scopes || p.scopes.length === 0) && (!p.user || !!p.user.is_super) && !p.spaceLimit;

// Admin is a whole-brain role; a scoped admin could otherwise mint itself out of its scope.
function checkGrant(role, scopes) {
  if ((role === 'admin' || role === 'super') && scopes.length) throw new Error('admin keys cannot be scoped; use write for a scoped key');
}

const expiresSql = (days) =>
  days == null || days === '' ? 'NULL' : `datetime('now', '+${Math.max(1, Math.min(3650, Number(days) | 0))} days')`;

/** Create a key. Returns { id, key } — the plaintext key is shown exactly once. */
/**
 * The INSERT for a new key, not yet run, plus the plaintext key (shown once). `guard`
 * turns it into INSERT ... SELECT ... WHERE <guard>, so a batch can make the key exist
 * only if another row in the same transaction says so.
 */
export async function prepareKey(env, { name, role = 'read', prefixes = [], expires_days = null, expires_at = null, user_id = null, space_limit = null, parent_key_id = null,
  machine_id = null, agent = null, agent_tags = [], pinned = [] }, guard = null) {
  if (!ROLES.includes(role)) throw new Error('role must be read|write|admin|super');
  if (role === 'super' && (expires_days == null || expires_days === '')) expires_days = 7;
  if (role === 'super' && Number(expires_days) > 7) throw new Error('super keys expire within 7 days');
  const scopes = normalizeScopes(prefixes);
  checkGrant(role, scopes);
  const id = 'k_' + randToken(6);
  const key = 'bk_' + randToken(24);
  const values = `?, ?, ?, ?, ?, datetime('now'), ${expires_at ? 'datetime(?)' : expiresSql(expires_days)}, 0, ?, ?, ?, ?, ?, ?, ?`;
  const binds = [id, await sha256hex(key), String(name || id).slice(0, 100), role, JSON.stringify(scopes), ...(expires_at ? [expires_at] : []),
    user_id, space_limit ? JSON.stringify(space_limit) : null, parent_key_id, machine_id, agent, JSON.stringify(agent_tags || []), JSON.stringify(pinned || [])];
  const cols = 'INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked, user_id, space_limit, parent_key_id, machine_id, agent, agent_tags, pinned)';
  const stmt = guard
    ? env.DB.prepare(`${cols} SELECT ${values} WHERE ${guard.sql}`).bind(...binds, ...guard.binds)
    : env.DB.prepare(`${cols} VALUES (${values})`).bind(...binds);
  return { id, key, stmt };
}

/** Create a key. Returns { id, key } — the plaintext key is shown exactly once. */
export async function createKey(env, opts) {
  const { id, key, stmt } = await prepareKey(env, opts);
  await stmt.run();
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
    if (!ROLES.includes(patch.role) || patch.role === 'super') throw new Error('role must be read|write|admin');
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
  checkGrant(role, scopes);

  await env.DB.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  if (patch.role !== undefined || patch.prefixes !== undefined) {
    for (const table of ['oauth_tokens', 'oauth_codes']) {
      await env.DB.prepare(`UPDATE ${table} SET role = ?, prefixes = ? WHERE key_id = ?`)
        .bind(roleWithoutSuper(role), JSON.stringify(scopes), id)
        .run()
        .catch(() => {});
    }
  }
  return getKey(env, id);
}

const rowToKey = (k) => ({ ...k, prefixes: JSON.parse(k.prefixes || '[]'), agent_tags: jsonList(k.agent_tags), pinned: jsonList(k.pinned) });
const KEY_COLUMNS = 'k.id, k.name, k.role, k.prefixes, k.created, k.expires, k.revoked, k.last_used, k.user_id, u.handle AS owner, k.machine_id, m.name AS machine, k.agent, k.agent_tags, k.pinned';
const KEY_FROM = 'api_keys k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN machines m ON m.id = k.machine_id';

export async function getKey(env, id) {
  const r = await env.DB.prepare(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} WHERE k.id = ?`).bind(id).first();
  return r ? rowToKey(r) : null;
}

export async function listKeys(env, { userId } = {}) {
  const r = userId
    ? await env.DB.prepare(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} WHERE k.user_id = ? ORDER BY k.created DESC`).bind(userId).all()
    : await env.DB.prepare(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} ORDER BY k.created DESC`).all();
  return r.results.map(rowToKey);
}

export async function revokeKey(env, id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').bind(id).run();
  const children = (await env.DB.prepare('SELECT id FROM api_keys WHERE parent_key_id = ? AND revoked = 0').bind(id).all().catch(() => ({ results: [] }))).results;
  for (const c of children) await revokeKey(env, c.id, seen);
  // the key's calls waiting for approval die with it, as does its taint record
  await env.DB.prepare("UPDATE approvals SET status = 'void', args_sealed = NULL WHERE key_id = ? AND status IN ('pending', 'approved')").bind(id).run().catch(() => {});
  await env.DB.prepare('DELETE FROM taint WHERE key_id = ?').bind(id).run().catch(() => {});
  // also kill every web session / connector token / pending consent code minted from this key
  await env.DB.prepare('DELETE FROM oauth_tokens WHERE key_id = ?').bind(id).run().catch(() => {});
  await env.DB.prepare('DELETE FROM oauth_codes WHERE key_id = ?').bind(id).run().catch(() => {});
}
