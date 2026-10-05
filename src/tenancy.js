import { expandScopes, randToken, sha256hex, revokeKey } from './auth.js';
import { newDataKey, hasKek, KEK_VERSION, encryptWithKek } from './crypto.js';
import { spaceStore } from './store.js';
import { normalizeProject } from './parse.js';
import { resolveSkillsFor, parseSkillsConfig } from './skills.js';

export const SYSTEM_HANDLE = 'system';
export const HANDLE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED = new Set([SYSTEM_HANDLE, 'admin', 'root', 'api', 'app', 'mcp', 'all', 'everyone', 'brain', 'super', 'invite', 'export']);
const TEAM_SPACES_PER_USER = 5;

const RANK = { read: 1, write: 2, admin: 3 };
const keyCap = (role) => (role === 'super' ? 'admin' : role);
const minRole = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const MEMBER_CAP = { owner: 'admin', admin: 'admin', editor: 'write', viewer: 'read' };
export const SHARE_ROLES = ['viewer', 'editor'];
export const MEMBER_ROLES = ['admin', 'editor', 'viewer'];

const SPACE_SELECT = 'SELECT s.*, u.handle AS owner_handle, u.quota_notes AS quota_notes FROM spaces s JOIN users u ON u.id = s.owner_id';
const cleanHandle = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();

export const spaceByHandle = (env, handle) =>
  env.DB.prepare(`${SPACE_SELECT} WHERE s.handle = ? AND s.status = 'active'`).bind(cleanHandle(handle)).first();
export const spaceById = (env, id) =>
  env.DB.prepare(`${SPACE_SELECT} WHERE s.id = ? AND s.status = 'active'`).bind(id).first();
export const userByHandle = (env, handle) =>
  env.DB.prepare("SELECT * FROM users WHERE handle = ? AND status != 'deleted'").bind(cleanHandle(handle)).first();
export const systemSpace = (env) => spaceByHandle(env, SYSTEM_HANDLE);
export const allSpaces = async (env) =>
  (await env.DB.prepare(`${SPACE_SELECT} WHERE s.status = 'active' ORDER BY s.created`).all()).results;

export async function loadAccess(env, p) {
  if (p.access) return p.access;
  const access = { members: new Map(), shares: [], pending: [] };
  if (p.user) {
    const members = (await env.DB.prepare(
      `SELECT m.role AS member_role, m.accepted AS member_accepted, s.*, u.handle AS owner_handle, u.quota_notes AS quota_notes
         FROM members m JOIN spaces s ON s.id = m.space_id JOIN users u ON u.id = s.owner_id
        WHERE m.user_id = ? AND s.status = 'active'`
    ).bind(p.user.id).all()).results;
    for (const m of members) {
      const { member_role, member_accepted, ...space } = m;
      if (member_accepted) access.members.set(space.id, { role: member_role, space });
      else access.pending.push({ type: 'member', space: `@${space.handle}`, role: member_role, from: `@${space.owner_handle}` });
    }
    const shares = (await env.DB.prepare(
      `SELECT sh.space_id, sh.project, sh.role, sh.expires, sh.accepted, s.handle AS space_handle FROM shares sh JOIN spaces s ON s.id = sh.space_id
        WHERE sh.grantee_id = ? AND s.status = 'active' AND (sh.expires IS NULL OR sh.expires > datetime('now'))`
    ).bind(p.user.id).all()).results;
    access.shares = shares.filter((s) => s.accepted);
    for (const s of shares.filter((x) => !x.accepted)) access.pending.push({ type: 'share', project: `@${s.space_handle}/${s.project}`, role: s.role });
  }
  p.access = access;
  return access;
}

const inLimit = (p, space) => !p.spaceLimit || p.spaceLimit.includes(space.id);

export async function accessibleSpaces(env, p) {
  const access = await loadAccess(env, p);
  const out = [...access.members.values()].map((m) => m.space)
    .sort((a, b) => (a.owner_id === p.user?.id && a.kind === 'personal' ? -1 : b.owner_id === p.user?.id && b.kind === 'personal' ? 1 : 0));
  for (const id of new Set(access.shares.map((s) => s.space_id))) {
    if (!out.some((s) => s.id === id)) {
      const s = await spaceById(env, id);
      if (s) out.push(s);
    }
  }
  return out.filter((s) => s.handle !== SYSTEM_HANDLE && inLimit(p, s));
}

export async function defaultSpace(env, p) {
  const spaces = await accessibleSpaces(env, p);
  return spaces.find((s) => s.owner_id === p.user?.id && s.kind === 'personal') || spaces[0] || null;
}

export async function spacePrincipal(env, p, space) {
  if (!p || !space || !inLimit(p, space)) return null;
  const access = await loadAccess(env, p);
  const keyRole = keyCap(p.role);
  const base = { user: p.user, keyId: p.keyId, space, legacy: p.legacy, spaceLimit: p.spaceLimit };
  if (space.handle === SYSTEM_HANDLE) {
    return { ...base, role: p.super ? 'admin' : 'read', scopes: [], prefixes: [], publish: !!p.super, manage: !!p.super, via: p.super ? 'super' : 'system' };
  }
  const m = access.members.get(space.id);
  if (p.legacy && p.scopes?.length) {
    if (!m || m.role !== 'owner' || space.backing !== 'git') return null;
    return { ...base, role: keyRole, scopes: p.scopes, prefixes: p.prefixes, via: 'member', memberRole: 'owner' };
  }
  if (m) {
    const role = minRole(keyRole, MEMBER_CAP[m.role]);
    const owns = m.role === 'owner' || m.role === 'admin';
    const scoped = !!p.scopes?.length;
    return {
      ...base, role, scopes: scoped ? p.scopes : [], prefixes: scoped ? await expandScopes(spaceStore(env, space).db, p.scopes) : [],
      publish: owns && role !== 'read', manage: owns && keyRole === 'admin' && !scoped, via: 'member', memberRole: m.role,
    };
  }
  const shares = access.shares.filter((s) => s.space_id === space.id);
  if (shares.length) {
    const role = minRole(keyRole, shares.some((s) => s.role === 'editor') ? 'write' : 'read');
    const scopes = shares.map((s) => `project:${s.project}`);
    const editorScopes = shares.filter((s) => s.role === 'editor').map((s) => `project:${s.project}`);
    const db = spaceStore(env, space).db;
    return {
      ...base, role, scopes, prefixes: await expandScopes(db, scopes), writePrefixes: editorScopes.length ? await expandScopes(db, editorScopes) : [],
      publish: false, manage: false, via: 'share',
      shareProjects: shares.map((s) => s.project),
      shareEdit: new Set(role === 'write' ? shares.filter((s) => s.role === 'editor').map((s) => s.project) : []),
    };
  }
  if (p.super) return { ...base, role: 'admin', scopes: [], prefixes: [], publish: true, manage: true, via: 'super' };
  return null;
}

const projectExists = async (env, space, slug) =>
  !!(await spaceStore(env, space).db.prepare('SELECT 1 AS x FROM notes WHERE path = ?').bind(`vault/projects/${slug}.md`).first());

export async function resolveProject(env, p, arg) {
  const a = String(arg || '').trim();
  const q = a.match(/^@([^/\s]+)\/(.+)$/);
  if (q) {
    const space = await spaceByHandle(env, q[1]);
    if (!space) return { error: `no space @${cleanHandle(q[1])}` };
    return { space, slug: normalizeProject(q[2]) };
  }
  const slug = normalizeProject(a);
  const spaces = await accessibleSpaces(env, p);
  const home = await defaultSpace(env, p);
  if (!slug) return home ? { space: home, slug: '' } : { error: 'this key reaches no space' };
  if (home && (await projectExists(env, home, slug))) return { space: home, slug };
  const access = await loadAccess(env, p);
  const hits = [];
  for (const s of spaces) {
    if (s.id === home?.id) continue;
    const shared = access.shares.some((sh) => sh.space_id === s.id && sh.project === slug);
    if (shared || (access.members.has(s.id) && (await projectExists(env, s, slug)))) hits.push(s);
  }
  if (hits.length > 1) return { error: `project ${slug} exists in several spaces; name one: ${hits.map((s) => `@${s.handle}/${slug}`).join(', ')}` };
  if (hits.length === 1) return { space: hits[0], slug };
  return home ? { space: home, slug } : { error: 'this key reaches no space' };
}

export function sharedSkillNames(configText, projects) {
  const names = new Set();
  const rows = new Set(parseSkillsConfig(configText).entries.map((e) => e.project));
  for (const slug of projects || []) {
    for (const s of resolveSkillsFor(configText, rows.has(slug) ? slug : null)) names.add(s.name);
  }
  return names;
}


const PERSONAL_SKILLS = `---
type: config
title: Always-on skills
---
# Always-on skills

Which skills bind to which of your projects. Each line is \`<project-slug>: <skills>\`.
The \`default\` line applies to every session you open; a project line replaces it,
or extends it with \`default + <extras>\`. A leading \`!\` loads the skill's full body
at session start; a bare name is fetched with get_skill when needed.

The @system space supplies a shared default set to everyone, so this file can stay
empty until you want more.
`;

const README = (handle) => `---
type: readme
title: ${handle}
---
# @${handle}

This space is a brain served by BrainMCP. Projects live in \`vault/projects/<slug>.md\`,
topics in \`vault/topics/\`, session logs in \`vault/logs/sessions/\` and decisions in
\`vault/logs/decisions.md\`. Use the MCP tools: get_context at the start of a session,
save at the end, create_project for new work, share to give someone else access.
`;

function checkHandle(handle) {
  if (!HANDLE.test(handle)) return 'handle must be 2-31 characters: lowercase letters, digits and hyphens';
  if (RESERVED.has(handle)) return `@${handle} is reserved`;
  return null;
}

export async function createSpace(env, { handle, ownerId, kind, author, seed = [] }) {
  const h = cleanHandle(handle);
  const bad = kind === 'system' ? null : checkHandle(h);
  if (bad) throw new Error(bad);
  if (!hasKek(env)) throw new Error('BRAIN_KEK is not configured, so hosted spaces cannot be created');
  if (await env.DB.prepare('SELECT 1 FROM spaces WHERE handle = ?').bind(h).first()) throw new Error(`@${h} is taken`);
  if (kind !== 'system' && (await env.DB.prepare('SELECT 1 FROM users WHERE handle = ? AND id != ?').bind(h, ownerId).first())) throw new Error(`@${h} is taken`);
  const { wrapped } = await newDataKey(env);
  const id = `s_${randToken(9)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO spaces (id, handle, owner_id, kind, backing, dek_wrapped, kek_version, status, created) VALUES (?, ?, ?, ?, 'hosted', ?, ?, 'active', datetime('now'))")
      .bind(id, h, ownerId, kind, wrapped, KEK_VERSION),
    env.DB.prepare("INSERT INTO members (space_id, user_id, role, created) VALUES (?, ?, 'owner', datetime('now'))").bind(id, ownerId),
  ]);
  const space = await spaceById(env, id);
  const files = [
    { path: 'vault/README.md', content: README(h) },
    { path: 'vault/skills.md', content: PERSONAL_SKILLS },
    { path: 'vault/logs/decisions.md', content: '# Decisions\n' },
    ...seed,
  ];
  await spaceStore(env, space, author).commit(files, `space @${h} created`);
  return space;
}

export async function createTeamSpace(env, p, handle) {
  const owned = await env.DB.prepare("SELECT COUNT(*) AS c FROM spaces WHERE owner_id = ? AND kind = 'team' AND status = 'active'").bind(p.user.id).first();
  if (!p.super && owned.c >= TEAM_SPACES_PER_USER) throw new Error(`you already own ${TEAM_SPACES_PER_USER} team spaces`);
  return createSpace(env, { handle, ownerId: p.user.id, kind: 'team', author: p.user.handle });
}

export async function createUser(env, { handle, name, email, canInvite = false, createdBy }) {
  const h = cleanHandle(handle);
  const bad = checkHandle(h);
  if (bad) throw new Error(bad);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE handle = ?').bind(h).first()) throw new Error(`@${h} is taken`);
  if (await env.DB.prepare('SELECT 1 FROM spaces WHERE handle = ?').bind(h).first()) throw new Error(`@${h} is taken`);
  if (!hasKek(env)) throw new Error('BRAIN_KEK is not configured, so users cannot be created');
  const id = `u_${randToken(9)}`;
  const emailEnc = email ? await encryptWithKek(env, String(email).slice(0, 200)) : null;
  await env.DB.prepare(
    "INSERT INTO users (id, handle, name, email_enc, status, is_super, can_invite, created_by, created) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, datetime('now'))"
  ).bind(id, h, String(name || h).slice(0, 100), emailEnc, canInvite ? 1 : 0, createdBy || null).run();
  try {
    await createSpace(env, { handle: h, ownerId: id, kind: 'personal', author: h });
  } catch (e) {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    throw e;
  }
  return { user: await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first(), invite: await createInvite(env, id, createdBy) };
}

export async function createInvite(env, userId, createdBy) {
  const code = randToken(24);
  await env.DB.prepare("INSERT INTO invites (code_hash, user_id, created_by, exp) VALUES (?, ?, ?, datetime('now', '+72 hours'))")
    .bind(await sha256hex(code), userId, createdBy || null).run();
  return code;
}

export async function deleteUser(env, userId, { purge = false } = {}) {
  const owned = (await env.DB.prepare('SELECT * FROM spaces WHERE owner_id = ?').bind(userId).all()).results;
  for (const space of owned) {
    if (space.backing === 'hosted' && space.status === 'active' && env.SPACES) {
      await spaceStore(env, space).call('destroy', {}).catch((e) => console.log('space destroy failed', space.id, e.message));
    }
    if (env.LOGS) {
      for (const prefix of [`snapshots/${space.id}/`, `exports/${space.id}/`]) {
        const listed = await env.LOGS.list({ prefix });
        if (listed.objects.length) await env.LOGS.delete(listed.objects.map((o) => o.key));
      }
    }
  }
  const keys = (await env.DB.prepare('SELECT id FROM api_keys WHERE user_id = ?').bind(userId).all()).results;
  for (const k of keys) await revokeKey(env, k.id);
  const ids = JSON.stringify(owned.map((s) => s.id));
  const stmts = [
    env.DB.prepare('DELETE FROM shares WHERE grantee_id = ? OR space_id IN (SELECT value FROM json_each(?))').bind(userId, ids),
    env.DB.prepare('DELETE FROM members WHERE user_id = ? OR space_id IN (SELECT value FROM json_each(?))').bind(userId, ids),
    env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM exports WHERE user_id = ? OR space_id IN (SELECT value FROM json_each(?))').bind(userId, ids),
  ];
  if (purge) {
    stmts.push(
      env.DB.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM spaces WHERE owner_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    );
  } else {
    stmts.push(
      env.DB.prepare("UPDATE spaces SET status = 'deleted', dek_wrapped = NULL WHERE owner_id = ?").bind(userId),
      env.DB.prepare("UPDATE users SET status = 'deleted', email_enc = NULL WHERE id = ?").bind(userId),
    );
  }
  await env.DB.batch(stmts);
  return { spaces_destroyed: owned.map((s) => `@${s.handle}`), keys_revoked: keys.length, purged: purge };
}


const systemChecked = new WeakSet();

export async function ensureSystemSpace(env) {
  if (systemChecked.has(env.DB) || !hasKek(env) || !env.SPACES) return;
  if (await systemSpace(env)) { systemChecked.add(env.DB); return; }
  const owner = await env.DB.prepare('SELECT * FROM users WHERE is_super = 1 ORDER BY created LIMIT 1').first();
  if (!owner) return;
  const config = (await env.DB.prepare("SELECT body FROM notes WHERE path = 'vault/skills.md'").first())?.body || '';
  const defaults = parseSkillsConfig(config).entries.find((e) => e.project === 'default');
  const names = resolveSkillsFor(config, null).map((s) => s.name).filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
  const seed = [];
  for (const n of names) {
    const rows = (await env.DB.prepare('SELECT path, body FROM notes WHERE substr(path, 1, length(?)) = ?').bind(`skills/${n}/`, `skills/${n}/`).all()).results;
    for (const r of rows) seed.push({ path: r.path, content: r.body });
  }
  const skillsMd = `${PERSONAL_SKILLS.replace('Which skills bind to which of your projects.', 'The skills every user starts with. Only the super admin can change this space.')}\n${defaults ? `default: ${defaults.raw}\n` : ''}`;
  try {
    await createSpace(env, { handle: SYSTEM_HANDLE, ownerId: owner.id, kind: 'system', author: owner.handle, seed: [...seed, { path: 'vault/skills.md', content: skillsMd }] });
  } catch (e) {
    if (!/taken/.test(e.message)) throw e;
  }
  systemChecked.add(env.DB);
}
