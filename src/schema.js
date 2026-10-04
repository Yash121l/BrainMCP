import { randToken } from './auth.js';

const CONTROL_SCHEMA_VERSION = '3';

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT, email_enc TEXT,
     status TEXT NOT NULL DEFAULT 'active', is_super INTEGER NOT NULL DEFAULT 0,
     can_invite INTEGER NOT NULL DEFAULT 0, quota_notes INTEGER NOT NULL DEFAULT 5000,
     created_by TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS spaces (
     id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL,
     kind TEXT NOT NULL, backing TEXT NOT NULL, dek_wrapped TEXT, kek_version INTEGER,
     status TEXT NOT NULL DEFAULT 'active', created TEXT)`,
  `CREATE TABLE IF NOT EXISTS members (
     space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, added_by TEXT, created TEXT,
     PRIMARY KEY (space_id, user_id))`,
  'CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id)',
  `CREATE TABLE IF NOT EXISTS shares (
     id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project TEXT NOT NULL, grantee_id TEXT NOT NULL,
     role TEXT NOT NULL, expires TEXT, granted_by TEXT, created TEXT,
     UNIQUE (space_id, project, grantee_id))`,
  'CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares (grantee_id)',
  `CREATE TABLE IF NOT EXISTS invites (
     code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_by TEXT, exp TEXT NOT NULL, used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS exports (
     token_hash TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL, r2_key TEXT NOT NULL, exp TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_user TEXT, actor_key TEXT, via TEXT,
     action TEXT NOT NULL, outcome TEXT NOT NULL, space_id TEXT, target TEXT, subject_user TEXT,
     detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_user, id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_space ON audit_events (space_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_events (subject_user, id)',
];

const COLUMNS = [
  ['api_keys', 'user_id', 'TEXT'],
  ['api_keys', 'space_limit', 'TEXT'],
  ['tool_calls', 'user_id', 'TEXT'],
  ['tool_calls', 'key_id', 'TEXT'],
  ['api_keys', 'parent_key_id', 'TEXT'],
  ['members', 'accepted', 'INTEGER NOT NULL DEFAULT 1'],
  ['shares', 'accepted', 'INTEGER NOT NULL DEFAULT 1'],
];

const ready = new WeakMap();

export function ensureSchema(env) {
  if (!ready.has(env.DB)) ready.set(env.DB, migrate(env).catch((e) => { ready.delete(env.DB); throw e; }));
  return ready.get(env.DB);
}

async function migrate(env) {
  const done = await env.DB.prepare("SELECT v FROM meta WHERE k = 'control_schema'").first().catch(() => null);
  if (done?.v === CONTROL_SCHEMA_VERSION) return;
  await env.DB.batch(DDL.map((sql) => env.DB.prepare(sql)));
  for (const [table, column, type] of COLUMNS) {
    const cols = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
    if (!cols.includes(column)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
  await bootstrapSuper(env);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('control_schema', ?)").bind(CONTROL_SCHEMA_VERSION).run();
}

async function bootstrapSuper(env) {
  if (await env.DB.prepare('SELECT 1 FROM users WHERE is_super = 1').first()) return;
  const handle = env.SUPER_HANDLE || 'yash';
  const userId = `u_${randToken(9)}`;
  const spaceId = `s_${randToken(9)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, handle, name, status, is_super, can_invite, created) VALUES (?, ?, ?, 'active', 1, 1, datetime('now'))")
      .bind(userId, handle, handle),
    env.DB.prepare("INSERT INTO spaces (id, handle, owner_id, kind, backing, status, created) VALUES (?, ?, ?, 'personal', 'git', 'active', datetime('now'))")
      .bind(spaceId, handle, userId),
    env.DB.prepare("INSERT INTO members (space_id, user_id, role, created) VALUES (?, ?, 'owner', datetime('now'))").bind(spaceId, userId),
  ]);
}
