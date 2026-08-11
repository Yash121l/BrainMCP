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
