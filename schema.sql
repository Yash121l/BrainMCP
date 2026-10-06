-- BrainMCP D1 schema. The index is disposable: rebuild from git anytime
-- (POST /admin/reindex or scripts/build-seed.mjs).

CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,
  title       TEXT,
  type        TEXT,
  project     TEXT,
  status      TEXT,
  tags        TEXT,   -- JSON array
  frontmatter TEXT,   -- JSON object
  body        TEXT,   -- full raw file content
  updated     TEXT,   -- frontmatter updated:/date:
  indexed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_type    ON notes (type, status);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project);

CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,  -- wikilink target as written (alias/heading stripped)
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links (dst);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, heading, text);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- OAuth layer (claude.ai connectors). Hashes only; codes and tokens expire.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT,   -- JSON array, 1-10 https / loopback-http URIs, matched exactly
  created       TEXT,
  client_name   TEXT,   -- display-only, shown (escaped) on the consent page
  metadata_url  TEXT    -- set for Client ID Metadata Document clients (client_id is this URL)
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash    TEXT PRIMARY KEY,
  client_id    TEXT,
  redirect_uri TEXT,
  challenge    TEXT,
  exp          TEXT,
  role         TEXT,
  prefixes     TEXT,
  key_id       TEXT
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT,   -- access | refresh
  client_id  TEXT,
  exp        TEXT,
  role       TEXT DEFAULT 'admin',   -- inherited from the key used at consent
  prefixes   TEXT DEFAULT '[]',
  key_id     TEXT                     -- managed key (or 'root:<generation>') that minted this token; revocation link, required
);

-- Managed access keys: named, scoped (role + path prefixes), revocable.
-- The BRAIN_TOKEN env secret is break-glass admin only.
CREATE TABLE IF NOT EXISTS api_keys (
  id        TEXT PRIMARY KEY,
  key_hash  TEXT UNIQUE,
  name      TEXT,
  role      TEXT,               -- read | write | admin
  prefixes  TEXT,               -- JSON array of path prefixes; [] = everything
  created   TEXT,
  expires   TEXT,               -- NULL = never
  revoked   INTEGER DEFAULT 0,
  last_used TEXT,
  user_id   TEXT,
  space_limit TEXT,
  parent_key_id TEXT,
  machine_id TEXT,              -- machines.id: the device this key lives on
  agent      TEXT,              -- the agent on that device: claude-code, codex, mail, ...
  agent_tags TEXT NOT NULL DEFAULT '[]',
  pinned     TEXT NOT NULL DEFAULT '[]'  -- connection ids exposed as direct tools
);

-- Tool-call telemetry. Hooks POST redacted records to /ingest/tool-calls; the
-- nightly cron rolls every completed day into one R2 object per session and
-- deletes the rows. Hot in D1 for a day, cheap in R2 after.
CREATE TABLE IF NOT EXISTS tool_calls (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  day     TEXT NOT NULL,   -- YYYY-MM-DD, taken from the record's own ts
  ts      TEXT NOT NULL,
  surface TEXT,
  cwd     TEXT,
  project TEXT,
  tool    TEXT,
  payload TEXT,            -- the full redacted record as JSON
  user_id TEXT,
  key_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_day     ON tool_calls (day);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session, id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT, email_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active', is_super INTEGER NOT NULL DEFAULT 0,
  can_invite INTEGER NOT NULL DEFAULT 0, quota_notes INTEGER NOT NULL DEFAULT 5000,
  created_by TEXT, created TEXT, notify_url TEXT);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, backing TEXT NOT NULL, dek_wrapped TEXT, kek_version INTEGER,
  status TEXT NOT NULL DEFAULT 'active', created TEXT);
CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, added_by TEXT, created TEXT,
  accepted INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (space_id, user_id));
CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project TEXT NOT NULL, grantee_id TEXT NOT NULL,
  role TEXT NOT NULL, expires TEXT, granted_by TEXT, created TEXT,
  accepted INTEGER NOT NULL DEFAULT 1,
  UNIQUE (space_id, project, grantee_id));
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares (grantee_id);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_by TEXT, exp TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS exports (
  token_hash TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL, r2_key TEXT NOT NULL, exp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_user TEXT, actor_key TEXT, via TEXT,
  action TEXT NOT NULL, outcome TEXT NOT NULL, space_id TEXT, target TEXT, subject_user TEXT,
  detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_user, id);
CREATE INDEX IF NOT EXISTS idx_audit_space ON audit_events (space_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_events (subject_user, id);

-- Gateway (control schema 4). The Worker also creates these on first request
-- (src/schema.js); this copy keeps schema.sql a complete picture.
-- machines: one row per device; keys carry machine_id, agent, agent_tags, pinned.
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
  created TEXT, last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0, UNIQUE (user_id, name));
-- connections: one upstream account (figma_rtp, gmail_personal, ...).
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, space_id TEXT, service TEXT NOT NULL, label TEXT NOT NULL,
  transport TEXT NOT NULL, url TEXT NOT NULL, auth_kind TEXT NOT NULL, header_name TEXT,
  account TEXT, workspace TEXT, status TEXT NOT NULL, trust TEXT NOT NULL DEFAULT 'untrusted',
  sensitivity TEXT NOT NULL DEFAULT 'private', default_for TEXT NOT NULL DEFAULT '[]', oauth TEXT,
  last_sync TEXT, last_error TEXT, created TEXT, created_by_key TEXT);
CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_name ON connections (owner_id, service, label);
-- credentials: envelope-encrypted (VAULT_KEK wraps one DEK per connection).
CREATE TABLE IF NOT EXISTS credentials (
  connection_id TEXT PRIMARY KEY, kek_version INTEGER NOT NULL, wrapped_dek TEXT NOT NULL,
  sealed TEXT NOT NULL, updated TEXT);
-- connection_tools: the pinned upstream tool manifest.
CREATE TABLE IF NOT EXISTS connection_tools (
  connection_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT, description TEXT, input_schema TEXT,
  output_schema TEXT, annotations TEXT, manifest_hash TEXT NOT NULL, approved_hash TEXT,
  risk TEXT NOT NULL, risk_override TEXT, egress INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
  first_seen TEXT, changed TEXT, approved_description TEXT, egress_override INTEGER, PRIMARY KEY (connection_id, name));
CREATE VIRTUAL TABLE IF NOT EXISTS tool_fts USING fts5(connection_id UNINDEXED, name, text);
CREATE TABLE IF NOT EXISTS connection_grants (
  connection_id TEXT NOT NULL, grantee_id TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]', expires TEXT,
  accepted INTEGER NOT NULL DEFAULT 0, granted_by TEXT, created TEXT, PRIMARY KEY (connection_id, grantee_id));
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, effect TEXT NOT NULL, subject TEXT NOT NULL,
  resource TEXT NOT NULL, note TEXT, enabled INTEGER NOT NULL DEFAULT 1, global INTEGER NOT NULL DEFAULT 0,
  created TEXT, updated TEXT);
CREATE INDEX IF NOT EXISTS idx_rules_owner ON rules (owner_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_id TEXT, connection_id TEXT NOT NULL, tool TEXT NOT NULL,
  args_hash TEXT NOT NULL, args_sealed TEXT, reason TEXT, taint TEXT, status TEXT NOT NULL,
  scope TEXT, decided_by TEXT, created TEXT, decided TEXT, expires TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_pending ON approvals (user_id, key_id, connection_id, tool, args_hash) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS taint (
  key_id TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, exp TEXT NOT NULL,
  PRIMARY KEY (key_id, label, source));
CREATE TABLE IF NOT EXISTS connect_flows (
  state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
  verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, exp TEXT NOT NULL);
-- embeddings: which note version each Vectorize id holds (ids only leave D1).
CREATE TABLE IF NOT EXISTS embeddings (
  space_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, vector_id TEXT NOT NULL, updated TEXT,
  PRIMARY KEY (space_id, path));
CREATE TABLE IF NOT EXISTS device_codes (
  device_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, machine TEXT NOT NULL, agent TEXT,
  status TEXT NOT NULL, key_sealed TEXT, user_id TEXT, exp TEXT NOT NULL, created TEXT);
