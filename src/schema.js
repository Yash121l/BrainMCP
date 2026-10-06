import { randToken } from './auth.js';

const CONTROL_SCHEMA_VERSION = '7';

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
  `CREATE TABLE IF NOT EXISTS machines (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
     created TEXT, last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0, UNIQUE (user_id, name))`,
  `CREATE TABLE IF NOT EXISTS connections (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, space_id TEXT, service TEXT NOT NULL, label TEXT NOT NULL,
     transport TEXT NOT NULL, url TEXT NOT NULL, auth_kind TEXT NOT NULL, header_name TEXT,
     account TEXT, workspace TEXT, status TEXT NOT NULL, trust TEXT NOT NULL DEFAULT 'untrusted',
     sensitivity TEXT NOT NULL DEFAULT 'private', default_for TEXT NOT NULL DEFAULT '[]', oauth TEXT,
     last_sync TEXT, last_error TEXT, created TEXT, created_by_key TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections (owner_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_name ON connections (owner_id, service, label)',
  `CREATE TABLE IF NOT EXISTS credentials (
     connection_id TEXT PRIMARY KEY, kek_version INTEGER NOT NULL, wrapped_dek TEXT NOT NULL,
     sealed TEXT NOT NULL, updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS connection_tools (
     connection_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT, description TEXT, input_schema TEXT,
     output_schema TEXT, annotations TEXT, manifest_hash TEXT NOT NULL, approved_hash TEXT,
     risk TEXT NOT NULL, risk_override TEXT, egress INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
     first_seen TEXT, changed TEXT, approved_description TEXT, egress_override INTEGER, PRIMARY KEY (connection_id, name))`,
  'CREATE VIRTUAL TABLE IF NOT EXISTS tool_fts USING fts5(connection_id UNINDEXED, name, text)',
  `CREATE TABLE IF NOT EXISTS connection_grants (
     connection_id TEXT NOT NULL, grantee_id TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]', expires TEXT,
     accepted INTEGER NOT NULL DEFAULT 0, granted_by TEXT, created TEXT, PRIMARY KEY (connection_id, grantee_id))`,
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, effect TEXT NOT NULL, subject TEXT NOT NULL,
     resource TEXT NOT NULL, note TEXT, enabled INTEGER NOT NULL DEFAULT 1, global INTEGER NOT NULL DEFAULT 0,
     created TEXT, updated TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_rules_owner ON rules (owner_id)',
  `CREATE TABLE IF NOT EXISTS approvals (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_id TEXT, connection_id TEXT NOT NULL, tool TEXT NOT NULL,
     args_hash TEXT NOT NULL, args_sealed TEXT, reason TEXT, taint TEXT, status TEXT NOT NULL,
     scope TEXT, decided_by TEXT, created TEXT, decided TEXT, expires TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals (user_id, status)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_pending ON approvals (user_id, key_id, connection_id, tool, args_hash) WHERE status = 'pending'",
  `CREATE TABLE IF NOT EXISTS taint (
     key_id TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, exp TEXT NOT NULL,
     PRIMARY KEY (key_id, label, source))`,
  `CREATE TABLE IF NOT EXISTS connect_flows (
     state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
     verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, exp TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS embeddings (
     space_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, vector_id TEXT NOT NULL, updated TEXT,
     PRIMARY KEY (space_id, path))`,
  `CREATE TABLE IF NOT EXISTS device_codes (
     device_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, machine TEXT NOT NULL, agent TEXT,
     status TEXT NOT NULL, key_sealed TEXT, user_id TEXT, exp TEXT NOT NULL, created TEXT)`,
];

const COLUMNS = [
  ['api_keys', 'user_id', 'TEXT'],
  ['api_keys', 'space_limit', 'TEXT'],
  ['tool_calls', 'user_id', 'TEXT'],
  ['tool_calls', 'key_id', 'TEXT'],
  ['api_keys', 'parent_key_id', 'TEXT'],
  ['members', 'accepted', 'INTEGER NOT NULL DEFAULT 1'],
  ['shares', 'accepted', 'INTEGER NOT NULL DEFAULT 1'],
  ['api_keys', 'machine_id', 'TEXT'],
  ['api_keys', 'agent', 'TEXT'],
  ['api_keys', 'agent_tags', "TEXT NOT NULL DEFAULT '[]'"],
  ['api_keys', 'pinned', "TEXT NOT NULL DEFAULT '[]'"],
  ['users', 'notify_url', 'TEXT'],
  ['oauth_clients', 'metadata_url', 'TEXT'],
  ['connection_tools', 'approved_description', 'TEXT'],
  ['connection_tools', 'egress_override', 'INTEGER'],
  ['device_codes', 'claimed', 'TEXT'],
  ['device_codes', 'claim_id', 'TEXT'],
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
    if (cols.includes(column)) continue;
    // another isolate may be running the same migration right now
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run().catch((e) => {
      if (!/duplicate column/i.test(e.message)) throw e;
    });
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
