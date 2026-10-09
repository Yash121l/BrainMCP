import { createKey, listKeys, revokeKey, isProjectSlug, safeRepoPath, sha256hex, randToken } from './auth.js';
import {
  SYSTEM_HANDLE, SHARE_ROLES, MEMBER_ROLES, loadAccess, accessibleSpaces, defaultSpace, spaceByHandle, spaceById, userByHandle,
  spacePrincipal, resolveProject, createUser, createTeamSpace, createInvite, deleteUser,
} from './tenancy.js';
import { spaceStore } from './store.js';
import { auditInBackground, queryAudit, verifyChain } from './audit.js';
import { encryptText, unwrapDataKey } from './crypto.js';
import { canWritePath } from './auth.js';
import { skillsConfigEntries, renderSkillsConfig, validateSkillEntries, parseSkillsConfig } from './skills.js';
import { machineFor, cleanTags } from './gateway.js';
import { cleanAgent } from './gateway-tools.js';

const str = { type: 'string' };
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

const USER_TOOLS = [
  { name: 'whoami', description: 'Who this key belongs to: user, its spaces and roles, projects shared with you, and the key\'s own role and limits.', inputSchema: obj({}) },
  { name: 'list_projects', description: 'Projects you can reach, as @space/slug, across your spaces and everything shared with you. Pass space to list one space.', inputSchema: obj({ space: str }) },
  { name: 'create_project', description: 'Create vault/projects/<slug>.md in your space (or the given space you can write).', inputSchema: obj({ slug: str, title: str, goal: str, space: str }, ['slug']) },
  { name: 'share', description: 'Offer one project to another user as viewer or editor; it takes effect once they accept. You must own or admin the project\'s space and use an admin key.', inputSchema: obj({ project: { type: 'string', description: '@space/slug or a slug in your space' }, with: { type: 'string', description: 'user handle' }, role: { type: 'string', enum: SHARE_ROLES }, expires_days: { type: 'number' } }, ['project', 'with', 'role']) },
  { name: 'unshare', description: 'Remove a project share.', inputSchema: obj({ project: str, with: str }, ['project', 'with']) },
  { name: 'list_shares', description: 'Shares on spaces you manage, and projects shared with you.', inputSchema: obj({}) },
  { name: 'accept', description: 'Accept a pending share or space membership (see whoami.pending). Nothing someone shares with you takes effect until you accept it.', inputSchema: obj({ space: str, project: { type: 'string', description: 'for a share: the project slug; omit for a membership' } }, ['space']) },
  { name: 'decline', description: 'Decline (or leave) a share or space membership.', inputSchema: obj({ space: str, project: str }, ['space']) },
  { name: 'create_space', description: 'Create a team space you own (up to 5). Add people with add_member.', inputSchema: obj({ handle: str }, ['handle']) },
  { name: 'add_member', description: 'Invite a user into a space you own or admin (they must accept), or change a member\'s role.', inputSchema: obj({ space: str, user: str, role: { type: 'string', enum: MEMBER_ROLES } }, ['space', 'user', 'role']) },
  { name: 'remove_member', description: 'Remove a user from a space you own or admin.', inputSchema: obj({ space: str, user: str }, ['space', 'user']) },
  { name: 'create_key', description: 'Mint a key for yourself, e.g. for another machine or agent. It can never exceed this key; spaces limits it further. machine and agent name the device and agent that will hold it (gateway rules match on them); a child key inherits both from this key unless given. Shown once.', inputSchema: obj({ name: str, role: { type: 'string', enum: ['read', 'write', 'admin', 'super'] }, spaces: { type: 'array', items: str }, expires_days: { type: ['number', 'string'], description: 'days, or "never"; a super key defaults to 365 and reaches every space' }, machine: { type: 'string', description: 'device name, e.g. "macbook-pro"' }, agent: { type: 'string', description: 'agent name, e.g. "codex"' }, agent_tags: { type: 'array', items: str } }, ['name', 'role']) },
  { name: 'list_keys', description: 'Your keys (never the secrets).', inputSchema: obj({ all: { type: 'boolean', description: 'super admin only: every user\'s keys' } }) },
  { name: 'revoke_key', description: 'Revoke one of your keys; its web sessions and connector tokens die with it.', inputSchema: obj({ id: str }, ['id']) },
  { name: 'audit_log', description: 'Audit events you may see: your own actions, actions on spaces you own or admin, and any access to your data, including by the super admin.', inputSchema: obj({ limit: { type: 'number' }, action: str, before: { type: 'number' } }) },
  { name: 'list_members', description: 'Members of a space you belong to, with their roles and whether they accepted.', inputSchema: obj({ space: str }, ['space']) },
  { name: 'export_space', description: 'A one-time download link (valid 1 hour) for everything in a hosted space you own or admin.', inputSchema: obj({ space: str }) },
  { name: 'set_skills', description: 'Set one row of a space\'s vault/skills.md, e.g. project "pulse", skills "default + tdd, !arena". Needs owner or admin of the space.', inputSchema: obj({ space: str, project: str, skills: str }, ['project', 'skills']) },
  { name: 'publish_skill', description: 'Write skills/<name>/SKILL.md (and optional supporting files) into a space. Needs owner or admin of the space.', inputSchema: obj({ space: str, name: str, content: str, files: { type: 'array', items: obj({ path: str, content: str }, ['path', 'content']) } }, ['name', 'content']) },
];

const INVITE_TOOL = { name: 'invite_user', description: 'Create an account for someone (with their own personal space) and get a one-time invite link, valid 72 hours.', inputSchema: obj({ handle: str, name: str }, ['handle']) };

const ADMIN_TOOLS = [
  { name: 'admin_create_user', description: 'Super admin: create a user with a personal space and a one-time invite link.', inputSchema: obj({ handle: str, name: str, email: str, can_invite: { type: 'boolean' } }, ['handle']) },
  { name: 'admin_list_users', description: 'Super admin: every user with status, spaces and key counts.', inputSchema: obj({}) },
  { name: 'admin_set_user', description: 'Super admin: suspend or restore a user, toggle can_invite, set the note quota, or issue a fresh invite.', inputSchema: obj({ handle: str, status: { type: 'string', enum: ['active', 'suspended'] }, can_invite: { type: 'boolean' }, quota_notes: { type: 'number' }, new_invite: { type: 'boolean' } }, ['handle']) },
  { name: 'admin_delete_user', description: 'Super admin: delete a user. Wipes their hosted spaces and destroys the data keys, so backups become unreadable. purge also removes the rows.', inputSchema: obj({ handle: str, confirm: { type: 'string', description: 'repeat the handle' }, purge: { type: 'boolean' } }, ['handle', 'confirm']) },
  { name: 'admin_list_spaces', description: 'Super admin: every active space with its owner, kind, members and shares.', inputSchema: obj({}) },
  { name: 'admin_audit', description: 'Super admin: the whole audit log, with filters. verify recomputes the hash chain.', inputSchema: obj({ limit: { type: 'number' }, user: str, action: str, before: { type: 'number' }, verify: { type: 'boolean' } }) },
];

const READS = new Set(['whoami', 'list_projects', 'list_shares', 'list_keys', 'audit_log', 'list_members', 'admin_list_users', 'admin_list_spaces', 'admin_audit']);
const DESTRUCTIVE = new Set(['unshare', 'remove_member', 'revoke_key', 'decline', 'admin_delete_user']);
for (const t of [...USER_TOOLS, INVITE_TOOL, ...ADMIN_TOOLS]) {
  t.annotations = READS.has(t.name)
    ? { readOnlyHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: DESTRUCTIVE.has(t.name), openWorldHint: false };
}

export function tenantToolDefs(p) {
  if (!p?.user) return [];
  return [...USER_TOOLS, ...(p.user.can_invite || p.super ? [INVITE_TOOL] : []), ...(p.super ? ADMIN_TOOLS : [])];
}

const TOOL_NAMES = new Set([...USER_TOOLS, INVITE_TOOL, ...ADMIN_TOOLS].map((t) => t.name));
export const isTenantTool = (name) => TOOL_NAMES.has(name);

const at = (h) => `@${h}`;
const keyIsAdmin = (p) => p.role === 'admin' || p.role === 'super';
const LIVE_KEYS_PER_USER = 20;
const SCOPED_KEY_TOOLS = new Set(['whoami', 'list_projects']);
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const inviteUrl = (R, code) => `${R.url.origin}/invite/${code}`;

function projectTemplate({ slug, title, goal, author, date }) {
  return `---
type: project
status: active
project: ${slug}
created: ${date}
updated: ${date}
next: ""
author: ${author}
tags:
  - project
---

# ${String(title || slug).replace(/[\r\n]+/g, ' ').slice(0, 120)}

## Goal
${String(goal || '').trim() || '(not set yet)'}

## Current state

## Next steps
`;
}

async function spaceArg(R, handle) {
  const space = handle ? await spaceByHandle(R.env, handle) : await defaultSpace(R.env, R.p);
  if (!space) return { error: handle ? `no space ${handle}` : 'this key reaches no space; pass space' };
  const pv = await spacePrincipal(R.env, R.p, space);
  if (!pv) return { error: `forbidden: no access to @${space.handle}` };
  return { space, pv, S: spaceStore(R.env, space, R.p.user.handle) };
}

const denied = (R, action, why, fields = {}) => {
  auditInBackground(R, action, { ...fields, outcome: 'denied', detail: why });
  return { error: `forbidden: ${why}` };
};

async function managedSpaceIds(env, userId) {
  return (await env.DB.prepare("SELECT space_id FROM members WHERE user_id = ? AND role IN ('owner', 'admin')").bind(userId).all()).results.map((r) => r.space_id);
}

export async function tenantTool(R, name, args) {
  const { env, p } = R;
  if (!p.user) return { error: 'this credential has no user; ask the super admin to finish setup' };
  if (p.scopes?.length && !SCOPED_KEY_TOOLS.has(name)) return denied(R, name, 'a key scoped to paths or projects cannot manage people, keys or spaces');
  const now = new Date().toISOString().slice(0, 10);

  switch (name) {
    case 'whoami': {
      const access = await loadAccess(env, p);
      const shares = [];
      for (const s of access.shares) shares.push({ project: `${at((await spaceById(env, s.space_id))?.handle)}/${s.project}`, role: s.role, expires: s.expires || null });
      return {
        user: at(p.user.handle),
        super_admin_key: !!p.super,
        can_invite: !!p.user.can_invite,
        key: { id: p.keyId, role: p.role, via: p.via, spaces: p.spaceLimit ? (await Promise.all(p.spaceLimit.map((id) => spaceById(env, id)))).filter(Boolean).map((s) => at(s.handle)) : 'all of yours' },
        spaces: [...access.members.values()].map((m) => ({ space: at(m.space.handle), role: m.role, kind: m.space.kind, backing: m.space.backing })),
        shared_with_me: shares,
        ...(access.pending.length ? { pending: access.pending, pending_hint: 'call accept (or decline) for each; nothing pending applies until you accept' } : {}),
      };
    }

    case 'list_projects': {
      const spaces = args.space ? [await spaceByHandle(env, args.space)].filter(Boolean) : await accessibleSpaces(env, p);
      const out = [];
      for (const space of spaces) {
        const pv = await spacePrincipal(env, p, space);
        if (!pv) continue;
        const rows = (await spaceStore(env, space).db.prepare(
          "SELECT path, status, updated FROM notes WHERE type = 'project' AND path >= 'vault/projects/' AND path < 'vault/projects0' ORDER BY updated DESC"
        ).all()).results;
        for (const r of rows) {
          const m = r.path.match(/^vault\/projects\/([^/]+)\.md$/);
          if (m && (!pv.prefixes.length || pv.prefixes.some((pre) => r.path === pre || (pre.endsWith('/') && r.path.startsWith(pre))))) {
            out.push({ project: `${at(space.handle)}/${m[1]}`, status: r.status || null, updated: r.updated || null, access: pv.via === 'share' ? `shared ${pv.role}` : pv.memberRole || pv.via });
          }
        }
      }
      return { projects: out };
    }

    case 'create_project': {
      const slug = String(args.slug || '').trim().toLowerCase();
      if (!isProjectSlug(slug)) return { error: 'slug must be lowercase letters, digits, dots, hyphens or underscores' };
      const t = await spaceArg(R, args.space);
      if (t.error) return t;
      const path = `vault/projects/${slug}.md`;
      if (!canWritePath(t.pv, path)) return denied(R, 'project.create', `no write access to @${t.space.handle}`, { space_id: t.space.id, target: path });
      if (await t.S.getFile(path)) return { error: `${at(t.space.handle)}/${slug} already exists` };
      await t.S.commit([{ path, content: projectTemplate({ slug, title: args.title, goal: args.goal, author: p.user.handle, date: now }) }], `project: create ${slug}`);
      auditInBackground(R, 'project.create', { space_id: t.space.id, target: path });
      return { ok: true, project: `${at(t.space.handle)}/${slug}`, path };
    }

    case 'share':
    case 'unshare': {
      const r = await resolveProject(env, p, args.project);
      if (r.error) return r;
      const pv = await spacePrincipal(env, p, r.space);
      if (!pv?.manage) return denied(R, `share.${name === 'share' ? 'create' : 'delete'}`, `you need to own or admin @${r.space.handle}, with an admin key`, { space_id: r.space.id, target: r.slug });
      const grantee = await userByHandle(env, args.with);
      if (!grantee || grantee.status !== 'active') return { error: `no active user ${args.with}` };
      if (name === 'unshare') {
        await env.DB.prepare('DELETE FROM shares WHERE space_id = ? AND project = ? AND grantee_id = ?').bind(r.space.id, r.slug, grantee.id).run();
        auditInBackground(R, 'share.delete', { space_id: r.space.id, target: r.slug, subject_user: grantee.id });
        return { ok: true, unshared: `${at(r.space.handle)}/${r.slug}`, with: at(grantee.handle) };
      }
      if (!SHARE_ROLES.includes(args.role)) return { error: 'role must be viewer or editor' };
      if (!(await spaceStore(env, r.space).db.prepare('SELECT 1 AS x FROM notes WHERE path = ?').bind(`vault/projects/${r.slug}.md`).first())) {
        return { error: `${at(r.space.handle)}/${r.slug} does not exist` };
      }
      if (grantee.id === r.space.owner_id) return { error: 'that user owns the space already' };
      const days = args.expires_days == null ? null : Math.max(1, Math.min(3650, Number(args.expires_days) | 0));
      await env.DB.prepare(
        `INSERT INTO shares (id, space_id, project, grantee_id, role, expires, granted_by, created, accepted) VALUES (?, ?, ?, ?, ?, ${days ? `datetime('now', '+${days} days')` : 'NULL'}, ?, datetime('now'), 0)
         ON CONFLICT (space_id, project, grantee_id) DO UPDATE SET role = excluded.role, expires = excluded.expires, granted_by = excluded.granted_by`
      ).bind(`sh_${randToken(6)}`, r.space.id, r.slug, grantee.id, args.role, p.user.id).run();
      auditInBackground(R, 'share.create', { space_id: r.space.id, target: r.slug, subject_user: grantee.id, detail: { role: args.role, expires_days: days } });
      const state = (await env.DB.prepare('SELECT accepted FROM shares WHERE space_id = ? AND project = ? AND grantee_id = ?').bind(r.space.id, r.slug, grantee.id).first())?.accepted;
      return { ok: true, shared: `${at(r.space.handle)}/${r.slug}`, with: at(grantee.handle), role: args.role, expires_days: days, status: state ? 'active' : 'waiting for them to accept' };
    }

    case 'list_shares': {
      const ids = await managedSpaceIds(env, p.user.id);
      const given = (await env.DB.prepare(
        `SELECT s.handle AS space, sh.project, u.handle AS grantee, sh.role, sh.expires, sh.accepted FROM shares sh
           JOIN spaces s ON s.id = sh.space_id JOIN users u ON u.id = sh.grantee_id
          WHERE sh.space_id IN (SELECT value FROM json_each(?)) ORDER BY s.handle, sh.project`
      ).bind(JSON.stringify(ids)).all()).results.map((r) => ({ project: `${at(r.space)}/${r.project}`, with: at(r.grantee), role: r.role, expires: r.expires || null, status: r.accepted ? 'active' : 'pending' }));
      const access = await loadAccess(env, p);
      const received = [];
      for (const s of access.shares) received.push({ project: `${at((await spaceById(env, s.space_id))?.handle)}/${s.project}`, role: s.role, expires: s.expires || null });
      return { shared_by_me: given, shared_with_me: received };
    }

    case 'create_space': {
      if (!keyIsAdmin(p)) return denied(R, 'space.create', 'creating a space needs an admin key');
      try {
        const space = await createTeamSpace(env, p, args.handle);
        auditInBackground(R, 'space.create', { space_id: space.id, target: at(space.handle) });
        return { ok: true, space: at(space.handle) };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'add_member':
    case 'remove_member': {
      const space = await spaceByHandle(env, args.space);
      if (!space) return { error: `no space ${args.space}` };
      const pv = await spacePrincipal(env, p, space);
      if (!pv?.manage || space.handle === SYSTEM_HANDLE) return denied(R, `member.${name === 'add_member' ? 'add' : 'remove'}`, `you need to own or admin @${space.handle}, with an admin key`, { space_id: space.id });
      const u = await userByHandle(env, args.user);
      if (!u || u.status !== 'active') return { error: `no active user ${args.user}` };
      if (u.id === space.owner_id) return { error: 'the owner\'s role cannot change' };
      if (name === 'remove_member') {
        await env.DB.prepare('DELETE FROM members WHERE space_id = ? AND user_id = ?').bind(space.id, u.id).run();
        auditInBackground(R, 'member.remove', { space_id: space.id, subject_user: u.id });
        return { ok: true, removed: at(u.handle), space: at(space.handle) };
      }
      if (!MEMBER_ROLES.includes(args.role)) return { error: 'role must be admin, editor or viewer' };
      if (args.role === 'admin' && pv.memberRole !== 'owner' && pv.via !== 'super') return { error: 'only the owner can add admins' };
      await env.DB.prepare(
        "INSERT INTO members (space_id, user_id, role, added_by, created, accepted) VALUES (?, ?, ?, ?, datetime('now'), 0) ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role"
      ).bind(space.id, u.id, args.role, p.user.id).run();
      auditInBackground(R, 'member.add', { space_id: space.id, subject_user: u.id, detail: { role: args.role } });
      const state = (await env.DB.prepare('SELECT accepted FROM members WHERE space_id = ? AND user_id = ?').bind(space.id, u.id).first())?.accepted;
      return { ok: true, space: at(space.handle), user: at(u.handle), role: args.role, status: state ? 'active' : 'waiting for them to accept' };
    }

    case 'accept':
    case 'decline': {
      const space = await spaceByHandle(env, args.space);
      if (!space) return { error: `no space ${args.space}` };
      const project = args.project ? String(args.project).trim() : null;
      if (project && space.owner_id === p.user.id) return { error: 'that is your own space' };
      if (!project && space.owner_id === p.user.id) return { error: 'you own this space' };
      const [table, where, binds] = project
        ? ['shares', 'space_id = ? AND project = ? AND grantee_id = ?', [space.id, project, p.user.id]]
        : ['members', "space_id = ? AND user_id = ? AND role != 'owner'", [space.id, p.user.id]];
      const r = name === 'accept'
        ? await env.DB.prepare(`UPDATE ${table} SET accepted = 1 WHERE ${where}`).bind(...binds).run()
        : await env.DB.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(...binds).run();
      if (!r.meta?.changes) return { error: `nothing pending for you in @${space.handle}${project ? `/${project}` : ''}` };
      auditInBackground(R, `${project ? 'share' : 'member'}.${name}`, { space_id: space.id, target: project, subject_user: space.owner_id });
      return { ok: true, [name === 'accept' ? 'accepted' : 'declined']: `@${space.handle}${project ? `/${project}` : ''}` };
    }

    case 'invite_user': {
      if (!p.user.can_invite && !p.super) return denied(R, 'user.invite', 'your account cannot invite people');
      if (!keyIsAdmin(p)) return denied(R, 'user.invite', 'inviting needs an admin key');
      try {
        const { user, invite } = await createUser(env, { handle: args.handle, name: args.name, createdBy: p.user.id });
        auditInBackground(R, 'user.invite', { subject_user: user.id, target: at(user.handle) });
        return { ok: true, user: at(user.handle), invite_url: inviteUrl(R, invite), expires: 'in 72 hours, single use' };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'create_key': {
      if (!keyIsAdmin(p)) return denied(R, 'key.create', 'minting keys needs an admin key');
      const role = String(args.role || '');
      if (!['read', 'write', 'admin', 'super'].includes(role)) return { error: 'role must be read, write, admin or super' };
      if (role === 'super' && !p.super) return denied(R, 'key.create', 'only a super key can mint a super key');
      if (role === 'super' && args.spaces?.length) return { error: 'a super key reaches every space; mint an admin key to limit spaces' };
      const live = await env.DB.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked = 0 AND (expires IS NULL OR expires = '' OR expires > datetime('now'))").bind(p.user.id).first();
      if (!p.super && live.c >= LIVE_KEYS_PER_USER) return { error: `you already have ${LIVE_KEYS_PER_USER} live keys; revoke one first` };
      const never = args.expires_days === 'never';
      const days = never || args.expires_days == null || args.expires_days === '' ? null : Math.max(1, Math.min(3650, Number(args.expires_days) | 0));
      const wanted = days ? Date.now() + days * 86400000 : role === 'super' && !never ? Date.now() + 365 * 86400000 : null;
      const parentEnds = p.expires ? Date.parse(`${String(p.expires).replace(' ', 'T')}Z`) : null;
      const ends = parentEnds && (!wanted || parentEnds < wanted) ? parentEnds : wanted;
      let limit = null;
      if (Array.isArray(args.spaces) && args.spaces.length) {
        limit = [];
        for (const h of args.spaces) {
          const s = await spaceByHandle(env, h);
          if (!s || !(await spacePrincipal(env, p, s))) return { error: `no access to space ${h}` };
          limit.push(s.id);
        }
      } else if (p.spaceLimit) {
        limit = p.spaceLimit;
      }
      try {
        const agent = args.agent ? cleanAgent(args.agent) : p.agent || null;
        const agentTags = args.agent_tags ? cleanTags(args.agent_tags) : p.agentTags || [];
        const machine = args.machine ? await machineFor(env, p.user.id, args.machine) : null;
        const created = await createKey(env, {
          name: args.name, role, expires_at: ends ? sqlTime(ends) : null, user_id: p.user.id, space_limit: limit, parent_key_id: p.keyId || null,
          machine_id: machine?.id || p.machineId || null, agent, agent_tags: agentTags,
        });
        auditInBackground(R, 'key.create', { target: created.id, detail: { role, spaces: limit, expires: ends ? sqlTime(ends) : null, machine: machine?.name, agent } });
        return { ok: true, id: created.id, key: created.key, expires: ends ? sqlTime(ends) : null, note: 'shown once; store it now. Revoking the key that minted it revokes this one too.' };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'list_keys': {
      const keys = await listKeys(env, args.all && p.super ? {} : { userId: p.user.id });
      const own = p.user.is_super && !(args.all && p.super)
        ? [...keys, ...(await listKeys(env)).filter((k) => !k.user_id)]
        : keys;
      return { keys: own.map(({ prefixes, ...k }) => ({ ...k, owner: k.owner || p.user.handle, scopes: prefixes })) };
    }

    case 'revoke_key': {
      if (!keyIsAdmin(p)) return denied(R, 'key.revoke', 'revoking keys needs an admin key');
      const k = await env.DB.prepare('SELECT id, user_id FROM api_keys WHERE id = ?').bind(String(args.id || '')).first();
      const mine = k && (k.user_id === p.user.id || (!k.user_id && p.user.is_super));
      if (!k || (!mine && !p.super)) return { error: `no key ${args.id} of yours` };
      await revokeKey(env, k.id);
      auditInBackground(R, 'key.revoke', { target: k.id, subject_user: k.user_id });
      return { ok: true, revoked: k.id };
    }

    case 'audit_log':
      return { events: await queryAudit(env, { userId: p.user.id, spaceIds: await managedSpaceIds(env, p.user.id), limit: args.limit, action: args.action, before: args.before }) };

    case 'list_members': {
      const space = await spaceByHandle(env, args.space);
      const pv = space && (await spacePrincipal(env, p, space));
      if (!pv || pv.via === 'share') return { error: `forbidden: you are not a member of ${args.space}` };
      const rows = (await env.DB.prepare(
        'SELECT u.handle, m.role, m.accepted, m.created FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.created'
      ).bind(space.id).all()).results;
      return { space: at(space.handle), members: rows.map((r) => ({ user: at(r.handle), role: r.role, status: r.accepted ? 'active' : 'pending', since: r.created })) };
    }

    case 'export_space': {
      const t = await spaceArg(R, args.space);
      if (t.error) return t;
      if (t.space.backing !== 'hosted') return { error: `@${t.space.handle} is a git repository; clone it instead` };
      if (!t.pv.manage) return denied(R, 'space.export', `exports need owner or admin of @${t.space.handle} and an admin key`, { space_id: t.space.id });
      if (!env.LOGS) return { error: 'exports need the R2 binding' };
      const notes = await t.S.call('dump', {});
      const token = randToken(32);
      const r2Key = `exports/${t.space.id}/${await sha256hex(token)}.enc`;
      await env.LOGS.put(r2Key, await encryptText(await unwrapDataKey(env, t.space.dek_wrapped), JSON.stringify({ space: at(t.space.handle), exported: new Date().toISOString(), notes })));
      await env.DB.prepare("INSERT INTO exports (token_hash, space_id, user_id, r2_key, exp) VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))")
        .bind(await sha256hex(token), t.space.id, p.user.id, r2Key).run();
      auditInBackground(R, 'space.export', { space_id: t.space.id, detail: { notes: notes.length } });
      return { ok: true, url: `${R.url.origin}/export/${token}`, notes: notes.length, expires: 'in 1 hour, single use' };
    }

    case 'set_skills': {
      const t = await spaceArg(R, args.space);
      if (t.error) return t;
      if (!canWritePath(t.pv, 'vault/skills.md')) return denied(R, 'skills.set', `publishing skills needs owner or admin of @${t.space.handle}`, { space_id: t.space.id });
      const text = await t.S.readConfig();
      const project = String(args.project || '').trim();
      const raw = String(args.skills || '').trim();
      const probe = skillsConfigEntries(`${project}: ${raw}`);
      if (!probe.entries.length) return { error: 'skills must be a list like "default + tdd, !arena"' };
      const { entries } = skillsConfigEntries(text);
      const row = probe.entries[0];
      const next = entries.some((e) => e.project === project) ? entries.map((e) => (e.project === project ? row : e)) : [...entries, row];
      if (!next.some((e) => e.project === 'default') && project !== 'default' && row.inherits_default) {
        return { error: 'this space has no default row to inherit; set project "default" first or list skills explicitly' };
      }
      const invalid = validateSkillEntries(next);
      if (invalid) return { error: invalid };
      const content = renderSkillsConfig(text, next);
      await t.S.commit([{ path: 'vault/skills.md', content }], `skills: ${project}`);
      auditInBackground(R, 'skills.set', { space_id: t.space.id, target: project, detail: raw.slice(0, 300) });
      return { ok: true, space: at(t.space.handle), row: parseSkillsConfig(content).entries.find((e) => e.project === project) };
    }

    case 'publish_skill': {
      const t = await spaceArg(R, args.space);
      if (t.error) return t;
      const skill = String(args.name || '');
      if (!/^[A-Za-z0-9._-]+$/.test(skill) || skill.startsWith('.')) return { error: 'name must be letters, digits, dots, hyphens or underscores' };
      const files = [{ path: `skills/${skill}/SKILL.md`, content: String(args.content || '') }];
      for (const f of Array.isArray(args.files) ? args.files : []) {
        const rel = String(f?.path || '');
        if (!rel || safeRepoPath(rel) === null || rel.split('/').some((seg) => seg.startsWith('.'))) return { error: `bad file path ${JSON.stringify(rel)}` };
        files.push({ path: `skills/${skill}/${rel}`, content: String(f.content ?? '') });
      }
      const blocked = files.find((f) => !canWritePath(t.pv, f.path));
      if (blocked) return denied(R, 'skill.publish', `publishing skills needs owner or admin of @${t.space.handle}`, { space_id: t.space.id, target: blocked.path });
      await t.S.commit(files, `skill: publish ${skill}`);
      const sha = await sha256hex(files[0].content);
      auditInBackground(R, 'skill.publish', { space_id: t.space.id, target: skill, detail: { sha256: sha, files: files.length } });
      return { ok: true, space: at(t.space.handle), skill, sha256: sha, files: files.map((f) => f.path) };
    }

    case 'admin_create_user':
    case 'admin_list_users':
    case 'admin_set_user':
    case 'admin_delete_user':
    case 'admin_list_spaces':
    case 'admin_audit':
      if (!p.super) return denied(R, name, 'super admin key required');
      return adminTool(R, name, args);

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function adminTool(R, name, args) {
  const { env, p } = R;
  switch (name) {
    case 'admin_create_user': {
      try {
        const { user, invite } = await createUser(env, { handle: args.handle, name: args.name, email: args.email, canInvite: !!args.can_invite, createdBy: p.user.id });
        auditInBackground(R, 'user.create', { subject_user: user.id, target: at(user.handle), detail: { can_invite: !!args.can_invite } });
        return { ok: true, user: at(user.handle), space: at(user.handle), invite_url: inviteUrl(R, invite), expires: 'in 72 hours, single use' };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'admin_list_users': {
      const users = (await env.DB.prepare(
        `SELECT u.handle, u.name, u.status, u.is_super, u.can_invite, u.quota_notes, u.created,
                (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked = 0) AS keys,
                (SELECT json_group_array('@' || s.handle) FROM members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = u.id AND s.status = 'active') AS spaces
           FROM users u ORDER BY u.created`
      ).all()).results;
      return { users: users.map((u) => ({ ...u, user: at(u.handle), spaces: JSON.parse(u.spaces || '[]'), is_super: !!u.is_super, can_invite: !!u.can_invite })) };
    }
    case 'admin_set_user': {
      const u = await userByHandle(env, args.handle);
      if (!u) return { error: `no user ${args.handle}` };
      if (u.is_super && args.status === 'suspended') return { error: 'the super admin cannot be suspended' };
      const sets = [];
      const binds = [];
      if (args.status) { sets.push('status = ?'); binds.push(args.status === 'suspended' ? 'suspended' : 'active'); }
      if (args.can_invite != null) { sets.push('can_invite = ?'); binds.push(args.can_invite ? 1 : 0); }
      if (args.quota_notes != null) { sets.push('quota_notes = ?'); binds.push(Math.max(10, Math.min(100000, Number(args.quota_notes) | 0))); }
      if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, u.id).run();
      if (args.status === 'suspended') await env.DB.prepare('DELETE FROM exports WHERE user_id = ?').bind(u.id).run();
      const out = { ok: true, user: at(u.handle) };
      if (args.new_invite) out.invite_url = inviteUrl(R, await createInvite(env, u.id, p.user.id));
      auditInBackground(R, 'user.update', { subject_user: u.id, detail: { status: args.status, can_invite: args.can_invite, quota_notes: args.quota_notes, new_invite: !!args.new_invite } });
      return out;
    }
    case 'admin_delete_user': {
      const u = await env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(String(args.handle || '').replace(/^@/, '').toLowerCase()).first();
      if (!u) return { error: `no user ${args.handle}` };
      if (u.is_super) return { error: 'the super admin cannot be deleted' };
      if (String(args.confirm || '').replace(/^@/, '').toLowerCase() !== u.handle) return { error: 'confirm must repeat the handle' };
      const r = await deleteUser(env, u.id, { purge: !!args.purge });
      auditInBackground(R, 'user.delete', { subject_user: args.purge ? null : u.id, target: at(u.handle), detail: r });
      return { ok: true, user: at(u.handle), ...r };
    }
    case 'admin_list_spaces': {
      const rows = (await env.DB.prepare(
        `SELECT s.handle, s.kind, s.backing, s.created, u.handle AS owner,
                (SELECT COUNT(*) FROM members m WHERE m.space_id = s.id) AS members,
                (SELECT COUNT(*) FROM shares sh WHERE sh.space_id = s.id) AS shares
           FROM spaces s JOIN users u ON u.id = s.owner_id WHERE s.status = 'active' ORDER BY s.created`
      ).all()).results;
      return { spaces: rows.map((r) => ({ ...r, space: at(r.handle), owner: at(r.owner) })) };
    }
    case 'admin_audit': {
      const user = args.user ? await userByHandle(env, args.user) : null;
      if (args.user && !user) return { error: `no user ${args.user}` };
      const events = user
        ? await queryAudit(env, { userId: user.id, spaceIds: await managedSpaceIds(env, user.id), limit: args.limit, action: args.action, before: args.before })
        : await queryAudit(env, { limit: args.limit, action: args.action, before: args.before });
      return { events, ...(args.verify ? { chain: await verifyChain(env) } : {}) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
