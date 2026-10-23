import { sha256hex } from './auth.js';

const clipText = (v, n) => (v == null ? null : String(v).slice(0, n));

export async function appendEvent(env, ev) {
  const prev = (await env.DB.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').first())?.hash || 'genesis';
  const row = {
    ts: new Date().toISOString(),
    actor_user: ev.actor_user ?? null,
    actor_key: ev.actor_key ?? null,
    via: ev.via ?? null,
    action: String(ev.action),
    outcome: ev.outcome || 'ok',
    space_id: ev.space_id ?? null,
    target: clipText(ev.target, 300),
    subject_user: ev.subject_user ?? null,
    detail: clipText(ev.detail, 1000),
  };
  const hash = await chainHash(prev, row);
  await env.DB.prepare(
    `INSERT INTO audit_events (ts, actor_user, actor_key, via, action, outcome, space_id, target, subject_user, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.ts, row.actor_user, row.actor_key, row.via, row.action, row.outcome, row.space_id, row.target, row.subject_user, row.detail, prev, hash).run();
  return { hash };
}

const CHAIN_FIELDS = ['ts', 'actor_user', 'actor_key', 'via', 'action', 'outcome', 'space_id', 'target', 'subject_user', 'detail'];
const chainHash = (prev, row) => sha256hex(`${prev}\n${JSON.stringify(CHAIN_FIELDS.map((k) => row[k] ?? null))}`);

export class AuditDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const ev = await req.json();
    try {
      const out = await this.state.blockConcurrencyWhile(() => appendEvent(this.env, ev));
      return Response.json({ ok: true, ...out });
    } catch (e) {
      return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
  }
}

export function auditInBackground(R, action, fields = {}) {
  const ev = {
    actor_user: R.p?.user?.id ?? null,
    actor_key: R.p?.keyId ?? null,
    via: R.p?.via ?? 'anonymous',
    action,
    outcome: fields.outcome,
    space_id: fields.space_id,
    target: fields.target,
    subject_user: fields.subject_user,
    detail: fields.detail == null ? null : typeof fields.detail === 'string' ? fields.detail : JSON.stringify(fields.detail),
  };
  const send = R.env.AUDIT
    ? R.env.AUDIT.get(R.env.AUDIT.idFromName('chain')).fetch('https://audit/append', { method: 'POST', body: JSON.stringify(ev) })
    : appendEvent(R.env, ev);
  const done = Promise.resolve(send).catch((e) => console.log('audit append failed:', e.message));
  R.ctx?.waitUntil?.(done);
  return done;
}

export async function queryAudit(env, { userId = null, spaceIds = [], limit = 50, action = null, before = null } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  let sql = `SELECT e.id, e.ts, au.handle AS actor, e.actor_key, e.via, e.action, e.outcome, s.handle AS space, e.target,
                    su.handle AS subject, e.detail
               FROM audit_events e
               LEFT JOIN users au ON au.id = e.actor_user
               LEFT JOIN users su ON su.id = e.subject_user
               LEFT JOIN spaces s ON s.id = e.space_id WHERE 1=1`;
  const binds = [];
  if (userId) {
    sql += ' AND (e.actor_user = ? OR e.subject_user = ? OR e.space_id IN (SELECT value FROM json_each(?)))';
    binds.push(userId, userId, JSON.stringify(spaceIds));
  }
  if (action) { sql += ' AND e.action = ?'; binds.push(String(action)); }
  if (before) { sql += ' AND e.id < ?'; binds.push(Number(before)); }
  sql += ' ORDER BY e.id DESC LIMIT ?';
  binds.push(n);
  return (await env.DB.prepare(sql).bind(...binds).all()).results;
}

export async function verifyChain(env) {
  let prev = 'genesis';
  let lastId = 0;
  let events = 0;
  for (;;) {
    const rows = (await env.DB.prepare('SELECT * FROM audit_events WHERE id > ? ORDER BY id LIMIT 500').bind(lastId).all()).results;
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prev_hash !== prev || (await chainHash(prev, r)) !== r.hash) return { ok: false, events, broken_at: r.id };
      prev = r.hash;
      lastId = r.id;
      events++;
    }
  }
  return { ok: true, events, head: prev };
}
