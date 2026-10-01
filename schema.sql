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
  client_name   TEXT    -- display-only, shown (escaped) on the consent page
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
  last_used TEXT
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
  payload TEXT             -- the full redacted record as JSON
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_day     ON tool_calls (day);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session, id);
