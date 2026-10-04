import { parseNote } from './parse.js';
import { getFile, putFile, appendFile, multiCommit } from './github.js';
import { upsertLocal } from './indexer.js';
import { readSkillsConfig } from './skills.js';
import { encryptText, unwrapDataKey } from './crypto.js';
import { sha256hex } from './auth.js';

const SPACE_DDL = [
  `CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, title TEXT, type TEXT, project TEXT, status TEXT, tags TEXT,
     frontmatter TEXT, body TEXT, updated TEXT, indexed_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_notes_type ON notes (type, status)',
  'CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project)',
  'CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst))',
  'CREATE INDEX IF NOT EXISTS idx_links_dst ON links (dst)',
  'CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, heading, text)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  `CREATE TABLE IF NOT EXISTS note_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, ts TEXT NOT NULL,
     author TEXT, message TEXT, sha256 TEXT NOT NULL, sealed TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_versions_path ON note_versions (path, id)',
];

export const HOSTED_FILE_MAX_BYTES = 512 * 1024;
export const HOSTED_SPACE_MAX_BYTES = 25 * 1024 * 1024;
const VERSIONS_KEPT = 5;
const READ_OPS = new Set(['query', 'dump']);

function rowFor(path, content) {
  if (path.endsWith('.md')) return parseNote(path, content);
  return { path, title: path.split('/').pop(), type: 'file', project: '', status: '', tags: '[]', frontmatter: '{}',
    body: content, updated: '', links: [], chunks: [] };
}

export class SpaceDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.migrated = false;
  }

  migrate() {
    if (this.migrated) return;
    for (const q of SPACE_DDL) this.sql.exec(q);
    this.migrated = true;
  }

  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1);
    const handler = { query: this.query, batch: this.batch, write: this.write, append: this.append, destroy: this.destroy, dump: this.dump }[op];
    if (!handler) return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 404 });
    try {
      this.migrate();
      const body = await req.json();
      const run = () => handler.call(this, body);
      const result = READ_OPS.has(op) ? await run() : await this.state.blockConcurrencyWhile(run);
      return Response.json({ ok: true, result });
    } catch (e) {
      return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  exec(sql, binds = []) {
    const cursor = this.sql.exec(sql, ...binds);
    const rows = cursor.toArray();
    return { rows, changes: cursor.rowsWritten ?? 0 };
  }

  query({ sql, binds, mode }) {
    const { rows, changes } = this.exec(sql, binds);
    return mode === 'run' ? { success: true, meta: { changes } } : rows;
  }

  batch({ stmts }) {
    return this.state.storage.transactionSync(() => stmts.map((s) => ({ success: true, meta: { changes: this.exec(s.sql, s.binds).changes } })));
  }

  indexFile(path, content) {
    const n = rowFor(path, content);
    this.exec('DELETE FROM links WHERE src = ?', [path]);
    this.exec('DELETE FROM fts WHERE path = ?', [path]);
    this.exec(`INSERT OR REPLACE INTO notes (path, title, type, project, status, tags, frontmatter, body, updated, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [n.path, n.title, n.type, n.project, n.status, n.tags, n.frontmatter, n.body, n.updated]);
    for (const dst of n.links) this.exec('INSERT OR REPLACE INTO links (src, dst) VALUES (?, ?)', [path, dst]);
    for (const c of n.chunks) this.exec('INSERT INTO fts (path, title, heading, text) VALUES (?, ?, ?, ?)', [path, n.title, c.heading, c.text]);
  }

  async write({ files, author, message, dek, quota }) {
    for (const f of files) {
      if (new TextEncoder().encode(f.content).length > HOSTED_FILE_MAX_BYTES) throw new Error(`${f.path} is over ${HOSTED_FILE_MAX_BYTES} bytes`);
    }
    if (quota) {
      const have = this.exec('SELECT COUNT(*) AS c FROM notes').rows[0].c;
      const fresh = files.filter((f) => !this.exec('SELECT 1 FROM notes WHERE path = ?', [f.path]).rows.length).length;
      if (have + fresh > quota) throw new Error(`note quota reached (${quota} notes)`);
    }
    const bytes = this.exec('SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS b FROM notes WHERE path NOT IN (SELECT value FROM json_each(?))', [JSON.stringify(files.map((f) => f.path))]).rows[0].b;
    const incoming = files.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);
    if (bytes + incoming > HOSTED_SPACE_MAX_BYTES) throw new Error(`space storage limit reached (${HOSTED_SPACE_MAX_BYTES} bytes)`);
    const sealed = await Promise.all(files.map(async (f) => ({ ...f, sha: await sha256hex(f.content), sealed: await encryptText(dek, f.content) })));
    const ts = new Date().toISOString();
    return this.state.storage.transactionSync(() => {
      for (const f of sealed) {
        this.indexFile(f.path, f.content);
        this.exec('INSERT INTO note_versions (path, ts, author, message, sha256, sealed) VALUES (?, ?, ?, ?, ?, ?)',
          [f.path, ts, author || null, String(message || '').slice(0, 300), f.sha, f.sealed]);
        this.exec('DELETE FROM note_versions WHERE path = ? AND id NOT IN (SELECT id FROM note_versions WHERE path = ? ORDER BY id DESC LIMIT ?)',
          [f.path, f.path, VERSIONS_KEPT]);
      }
      const id = this.exec('SELECT MAX(id) AS id FROM note_versions').rows[0].id;
      return { commit: `v${id}`, files: sealed.map((f) => ({ path: f.path, sha: f.sha })) };
    });
  }

  async append({ path, text, author, message, dek, quota }) {
    const cur = this.exec('SELECT body FROM notes WHERE path = ?', [path]).rows[0]?.body;
    const next = cur ? `${cur.replace(/\n*$/, '\n')}${text}` : text;
    await this.write({ files: [{ path, content: next }], author, message, dek, quota });
    return next;
  }

  async destroy() {
    await this.state.storage.deleteAll();
    this.migrated = false;
    return { destroyed: true };
  }

  dump() {
    return this.exec('SELECT path, body FROM notes ORDER BY path').rows;
  }
}

function remoteDb(call) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => {
      if (b.some((v) => v === undefined)) throw new TypeError('D1_TYPE_ERROR: undefined bind');
      return stmt(sql, b.map((v) => (typeof v === 'boolean' ? Number(v) : v)));
    },
    async first(col) {
      const r = (await call('query', { sql, binds, mode: 'all' }))[0] ?? null;
      return col ? (r ? r[col] ?? null : null) : r;
    },
    all: async () => ({ success: true, results: await call('query', { sql, binds, mode: 'all' }) }),
    run: () => call('query', { sql, binds, mode: 'run' }),
    spec: { sql, binds },
  });
  return { prepare: (sql) => stmt(sql), batch: (stmts) => call('batch', { stmts: stmts.map((s) => s.spec) }) };
}

const withAuthor = (message, author) => (author ? `${message}\n\nBrain-Author: @${author}` : message);

function gitStore(env, space, author) {
  return {
    space,
    db: env.DB,
    getFile: (path) => getFile(env, path),
    async put(path, content, message) {
      const existing = await getFile(env, path);
      await putFile(env, path, content, withAuthor(message, author), existing?.sha);
      await upsertLocal(env, path, content);
      return { created: !existing };
    },
    async append(path, text, message) {
      const full = await appendFile(env, path, text, withAuthor(message, author));
      await upsertLocal(env, path, full);
      return full;
    },
    async commit(files, message) {
      const sha = await multiCommit(env, files, withAuthor(message, author));
      for (const f of files) await upsertLocal(env, f.path, f.content);
      return sha;
    },
    readConfig: () => readSkillsConfig(env),
  };
}

function hostedStore(env, space, author) {
  if (!env.SPACES) throw new Error('hosted spaces need the SPACES Durable Object binding');
  const stub = env.SPACES.get(env.SPACES.idFromName(space.id));
  const call = async (op, body) => {
    const res = await stub.fetch(`https://space/${op}`, { method: 'POST', body: JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || `space ${op} failed`);
    return j.result;
  };
  let dek = null;
  const key = async () => (dek ??= await unwrapDataKey(env, space.dek_wrapped));
  const db = remoteDb(call);
  const store = {
    space,
    db,
    call,
    async getFile(path) {
      const r = await db.prepare('SELECT body FROM notes WHERE path = ?').bind(path).first();
      return r ? { content: r.body, sha: await sha256hex(r.body) } : null;
    },
    async put(path, content, message) {
      const existed = !!(await db.prepare('SELECT 1 AS x FROM notes WHERE path = ?').bind(path).first());
      await store.commit([{ path, content }], message);
      return { created: !existed };
    },
    append: async (path, text, message) => call('append', { path, text, author, message, dek: await key(), quota: space.quota_notes || null }),
    async commit(files, message) {
      const r = await call('write', { files, author, message, dek: await key(), quota: space.quota_notes || null });
      return r.commit;
    },
    readConfig: async () => (await db.prepare("SELECT body FROM notes WHERE path = 'vault/skills.md'").first())?.body || '',
  };
  return store;
}

export function spaceStore(env, space, author = null) {
  return space.backing === 'git' ? gitStore(env, space, author) : hostedStore(env, space, author);
}
