// The simple layer of the console: an app directory with one-click connect, access
// levels per app instead of hand-written rules, and the Home summary. Access levels
// are stored as ordinary rules whose note starts with "managed:", so the policy engine
// and the advanced rules editor see exactly what the simple screens set.

import { randToken } from './auth.js';
import { auditInBackground } from './audit.js';
import { FEATURED, featuredById, searchRegistry } from './catalog.js';
import { discoverOauth, mcpPost, safeUpstreamUrl } from './upstream.js';
import { connName, reachableConnections, getConnection, SERVICE, LABEL } from './gateway.js';

export const APP_TOOLS = ['gw_catalog', 'gw_connect_app', 'gw_app_access', 'gw_set_app_access', 'gw_home'];
export const APP_READS = ['gw_catalog', 'gw_app_access', 'gw_home'];

export const LEVELS = {
  off: [],
  read: ['read'],
  write: ['read', 'write'],
  full: ['read', 'write', 'destructive', 'critical'],
};
const ASK_RISKS = ['write', 'destructive', 'critical'];
const managedNote = (conn, who, kind) => `managed:app:${conn}:${who}:${kind}`;
const parseNote = (note) => {
  const m = /^managed:app:([^:]+):([^:]+):(permit|ask|block|cap)$/.exec(note || '');
  return m ? { conn: m[1], who: m[2], kind: m[3] } : null;
};
const jsonList = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** The service id an app gets: lowercase letters and digits, starting with a letter. */
function serviceId(raw) {
  let s = String(raw || '').toLowerCase().split('/').pop().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(s)) s = `app${s}`;
  return s.slice(0, 24) || 'app';
}

async function freeLabel(env, userId, service, wanted) {
  if (wanted) return String(wanted).trim().toLowerCase();
  const taken = new Set((await env.DB.prepare('SELECT label FROM connections WHERE owner_id = ? AND service = ?').bind(userId, service).all()).results.map((r) => r.label));
  if (!taken.has('main')) return 'main';
  for (let i = 2; i < 100; i++) if (!taken.has(`main${i}`)) return `main${i}`;
  return randToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x');
}

/** For a server from the registry: does it want OAuth, a token, or nothing? The URL policy runs first: no probe ever reaches a refused address. */
async function detectAuth(url) {
  safeUpstreamUrl(url);
  try {
    const d = await discoverOauth(url);
    return d.as.registration_endpoint ? 'oauth' : 'app';
  } catch { /* no OAuth metadata */ }
  try {
    await mcpPost(url, { message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'brainmcp-probe', version: '1' } } } });
    return 'none';
  } catch {
    return 'token';
  }
}

async function managedRules(env, userId, connNameValue) {
  const prefix = `managed:app:${connNameValue}:`;
  const rows = (await env.DB.prepare('SELECT * FROM rules WHERE owner_id = ? AND substr(note, 1, length(?)) = ?').bind(userId, prefix, prefix).all()).results;
  return rows.map((r) => ({ ...r, meta: parseNote(r.note), resource: JSON.parse(r.resource || '{}'), subject: JSON.parse(r.subject || '{}') })).filter((r) => r.meta);
}

const levelOf = (risks = []) => {
  for (const name of ['full', 'write', 'read']) if (LEVELS[name].every((r) => risks.includes(r))) return name;
  return 'off';
};

async function accessView(env, userId, conn) {
  const name = connName(conn);
  const rules = await managedRules(env, userId, name);
  const all = rules.filter((r) => r.meta.who === 'all');
  const permit = all.find((r) => r.meta.kind === 'permit');
  const keys = (await env.DB.prepare(
    `SELECT k.id, k.name, k.agent, m.name AS machine FROM api_keys k LEFT JOIN machines m ON m.id = k.machine_id
      WHERE k.user_id = ? AND k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now')) ORDER BY k.created`
  ).bind(userId).all()).results;
  const agents = keys.map((k) => {
    const mine = rules.filter((r) => r.meta.who === k.id);
    const block = mine.find((r) => r.meta.kind === 'block');
    const own = mine.find((r) => r.meta.kind === 'permit');
    return {
      key_id: k.id, name: k.name, agent: k.agent, machine: k.machine ? k.machine.split('~')[0] : null,
      level: block ? 'off' : own ? levelOf(own.resource.risks) : 'inherit',
      ask: mine.some((r) => r.meta.kind === 'ask'),
    };
  });
  const custom = (await env.DB.prepare("SELECT COUNT(*) AS n FROM rules WHERE owner_id = ? AND (note IS NULL OR substr(note, 1, 8) != 'managed:') AND instr(resource, ?) > 0").bind(userId, `"${name}"`).first()).n;
  return { connection: name, level: permit ? levelOf(permit.resource.risks) : 'off', ask: all.some((r) => r.meta.kind === 'ask'), agents, custom_rules: custom };
}

async function writeAccess(env, userId, conn, { who, level, ask }) {
  const name = connName(conn);
  // Delete and insert in one batch (a D1 transaction), keyed by the exact managed notes,
  // so two saves at once leave exactly one of them, never both.
  const notes = ['permit', 'ask', 'block', 'cap'].map((k) => managedNote(name, who, k));
  const stmts = [env.DB.prepare('DELETE FROM rules WHERE owner_id = ? AND note IN (SELECT value FROM json_each(?))').bind(userId, JSON.stringify(notes))];
  const subject = who === 'all' ? {} : { keys: [who] };
  const add = (effect, resource, kind) => stmts.push(env.DB.prepare(
    "INSERT INTO rules (id, owner_id, effect, subject, resource, note, created, updated) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).bind(`r_${randToken(9)}`, userId, effect, JSON.stringify(subject), JSON.stringify(resource), managedNote(name, who, kind)));
  if (level === 'off' && who !== 'all') add('forbid', { connections: [name] }, 'block');
  else if (level !== 'inherit' && LEVELS[level]?.length) {
    add('permit', { connections: [name], risks: LEVELS[level] }, 'permit');
    // an agent's own level is a ceiling too: permits add up, so cap it with a forbid
    const above = LEVELS.full.filter((r) => !LEVELS[level].includes(r));
    if (who !== 'all' && above.length) add('forbid', { connections: [name], risks: above }, 'cap');
  }
  if (ask && level !== 'off') add('approve', { connections: [name], risks: ASK_RISKS }, 'ask');
  await env.DB.batch(stmts);
}

export async function appTool(R, name, args, consoleTool) {
  const { env, p } = R;
  const me = p.user.id;

  switch (name) {
    case 'gw_catalog': {
      const own = (await reachableConnections(env, p)).filter((c) => !c.grant);
      const usedBy = (url) => own.filter((c) => c.url === url).map((c) => ({ id: c.id, connection: c.name, account: c.account, status: c.status }));
      const featured = FEATURED.map((a) => ({ ...a, verified: true, connected: usedBy(a.url) }));
      const registry = args.query ? (await searchRegistry(args.query)).filter((r) => !FEATURED.some((f) => f.url === r.url)).map((r) => ({ ...r, connected: usedBy(r.url) })) : [];
      return { featured, registry, redirect_uri: `${R.url.origin}/connect/callback` };
    }

    case 'gw_connect_app': {
      let entry = featuredById(String(args.app_id || ''));
      if (!entry && args.url) {
        entry = { id: args.app_id || args.name || 'custom', name: args.name || 'Custom app', url: String(args.url), auth: args.auth || 'detect', header_name: args.header_name || null };
      }
      if (!entry) return { error: 'pick an app from the directory, or give a URL' };
      let auth = entry.auth;
      if (auth === 'detect') {
        try {
          auth = await detectAuth(entry.url);
        } catch (e) {
          return { error: e.message };
        }
      }
      const service = SERVICE.test(args.service || '') ? args.service : serviceId(entry.id === 'custom' ? entry.name : entry.id);
      const label = await freeLabel(env, me, service, args.label);
      if (!LABEL.test(label)) return { error: 'label must be 1-12 lowercase letters or digits (e.g. work, personal)' };
      const create = {
        service, label, url: entry.url, account: args.account, workspace: args.workspace, grant_read: true,
        trust: entry.category === 'Knowledge' ? 'trusted' : 'untrusted', sensitivity: entry.category === 'Knowledge' ? 'public' : 'private',
      };
      if (auth === 'none') create.auth = 'none';
      else if (auth === 'oauth') create.auth = 'oauth';
      else if (auth === 'app') {
        if (!args.client_id) return { error: `${entry.name} needs an OAuth app: paste its client id and secret`, needs: 'app', token_help: entry.token_help, token_url: entry.token_url, redirect_uri: `${R.url.origin}/connect/callback` };
        Object.assign(create, { auth: 'oauth', client_id: args.client_id, client_secret: args.client_secret });
      } else {
        if (!args.secret) return { error: `${entry.name} needs an API token`, needs: 'token', token_help: entry.token_help, token_url: entry.token_url };
        Object.assign(create, entry.header_name ? { auth: 'header', header_name: entry.header_name } : { auth: 'bearer' }, { secret: args.secret });
      }
      const out = await consoleTool('gw_connection_create', create);
      if (out?.error && !out.id) return out;
      if (out.id) {
        await env.DB.prepare("UPDATE rules SET note = ? WHERE owner_id = ? AND note = ?")
          .bind(managedNote(`${service}_${label}`, 'all', 'permit'), me, `all my agents may use read tools on ${service}_${label}`).run();
      }
      return { ...out, app: entry.name, auth };
    }

    case 'gw_app_access': {
      const conn = await getConnection(env, String(args.id || ''));
      if (!conn || conn.owner_id !== me) return { error: 'no such connection' };
      return accessView(env, me, conn);
    }

    case 'gw_set_app_access': {
      const conn = await getConnection(env, String(args.id || ''));
      if (!conn || conn.owner_id !== me) return { error: 'no such connection' };
      const level = String(args.level || '');
      const who = args.key_id ? String(args.key_id) : 'all';
      const allowed = who === 'all' ? ['off', 'read', 'write', 'full'] : ['inherit', 'off', 'read', 'write', 'full'];
      if (!allowed.includes(level)) return { error: `level must be one of ${allowed.join(', ')}` };
      if (who !== 'all' && !(await env.DB.prepare('SELECT 1 AS x FROM api_keys WHERE id = ? AND user_id = ? AND revoked = 0').bind(who, me).first())) return { error: 'no such key' };
      await writeAccess(env, me, conn, { who, level, ask: !!args.ask });
      auditInBackground(R, 'gw.access.set', { target: connName(conn), detail: { who: who === 'all' ? 'all agents' : who, level, ask: !!args.ask } });
      return { ok: true, access: await accessView(env, me, conn) };
    }

    case 'gw_home': {
      const conns = (await reachableConnections(env, p));
      const attention = conns.filter((c) => !c.grant && c.status !== 'active').map((c) => ({ id: c.id, connection: c.name, status: c.status, last_error: c.last_error }));
      const review = (await env.DB.prepare(
        `SELECT c.id, c.service, c.label, COUNT(*) AS n FROM connection_tools t JOIN connections c ON c.id = t.connection_id
          WHERE c.owner_id = ? AND t.state IN ('pending', 'changed') GROUP BY c.id`
      ).bind(me).all()).results.map((r) => ({ id: r.id, connection: `${r.service}_${r.label}`, tools_to_review: r.n }));
      const pending = (await env.DB.prepare(
        `SELECT a.id, a.tool, a.reason, a.created, c.service, c.label, k.agent, m.name AS machine FROM approvals a
           LEFT JOIN connections c ON c.id = a.connection_id LEFT JOIN api_keys k ON k.id = a.key_id LEFT JOIN machines m ON m.id = k.machine_id
          WHERE a.user_id = ? AND a.status = 'pending' AND a.expires > datetime('now') ORDER BY a.created DESC LIMIT 5`
      ).bind(me).all()).results.map((a) => ({ id: a.id, connection: a.service ? `${a.service}_${a.label}` : null, tool: a.tool, reason: a.reason, agent: a.agent, machine: a.machine ? a.machine.split('~')[0] : null, created: a.created }));
      const agents = (await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked = 0 AND machine_id IS NOT NULL AND (expires IS NULL OR expires = '' OR expires > datetime('now'))").bind(me).first()).n;
      const machines = (await env.DB.prepare('SELECT COUNT(*) AS n FROM machines WHERE user_id = ? AND revoked = 0').bind(me).first()).n;
      const calls = (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE actor_user = ? AND action = 'gw.call' AND ts > ?").bind(me, new Date(Date.now() - 7 * 86400000).toISOString()).first()).n;
      const anyCall = (await env.DB.prepare("SELECT 1 AS x FROM audit_events WHERE actor_user = ? AND action = 'gw.call' LIMIT 1").bind(me).first());
      const recent = (await env.DB.prepare(
        `SELECT e.id, e.ts, e.action, e.outcome, e.target, k.agent, m.name AS machine FROM audit_events e
           LEFT JOIN api_keys k ON k.id = e.actor_key LEFT JOIN machines m ON m.id = k.machine_id
          WHERE e.actor_user = ? AND e.action IN ('gw.call', 'gw.approval', 'gw.connection.create', 'gw.connection.connect') ORDER BY e.id DESC LIMIT 8`
      ).bind(me).all()).results.map((e) => ({ ...e, machine: e.machine ? e.machine.split('~')[0] : null }));
      const notify = await env.DB.prepare('SELECT notify_url FROM users WHERE id = ?').bind(me).first();
      return {
        user: `@${p.user.handle}`,
        counts: { apps: conns.length, agents, machines, calls_7d: calls, pending: pending.length },
        pending, attention, review, recent,
        checklist: { connect_app: conns.length > 0, add_agent: agents > 0, first_call: !!anyCall, notifications: !!notify?.notify_url },
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export { jsonList };
