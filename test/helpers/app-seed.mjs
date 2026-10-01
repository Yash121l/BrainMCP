// Helpers for app.js tests: index notes straight into the fake D1 (no indexer.js,
// no GitHub) and drive handleApp with a brain_session cookie.
//
//   seedNotes(env, { path: text, ... })  -> parses with the real parseNote and writes notes/links/fts rows
//   appLogin(env, key)                   -> { cookie, res } from POST /app/login
//   appGet(env, cookie, path)            -> Response from handleApp
//   appSend(env, cookie, method, path, body) -> Response from handleApp with a JSON body
//   legacyScopedAdmin(env, prefixes)     -> plaintext key of an api_keys row createKey now refuses

import { parseNote } from '../../src/parse.js';
import { handleApp } from '../../src/app.js';
import { sha256hex } from './fake-env.mjs';

export const ORIGIN = 'https://brain.test';

export function seedNotes(env, notes) {
  const db = env.DB.sqlite;
  for (const [path, text] of Object.entries(notes)) {
    const n = parseNote(path, text);
    db.prepare(
      `INSERT OR REPLACE INTO notes (path, title, type, project, status, tags, frontmatter, body, updated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(n.path, n.title, n.type, n.project, n.status, n.tags, n.frontmatter, n.body, n.updated);
    db.prepare('DELETE FROM links WHERE src = ?').run(n.path);
    db.prepare('DELETE FROM fts WHERE path = ?').run(n.path);
    for (const dst of n.links) db.prepare('INSERT OR REPLACE INTO links (src, dst) VALUES (?, ?)').run(n.path, dst);
    for (const c of n.chunks) db.prepare('INSERT INTO fts (path, title, heading, text) VALUES (?, ?, ?, ?)').run(n.path, n.title, c.heading, c.text);
  }
}

export async function appLogin(env, key) {
  const u = new URL(ORIGIN + '/app/login');
  const res = await handleApp(new Request(u, { method: 'POST', body: new URLSearchParams({ access_key: key }) }), env, u);
  const m = /brain_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  return { cookie: m ? `brain_session=${m[1]}` : null, token: m?.[1] ?? null, res };
}

export function appGet(env, cookie, path) {
  const u = new URL(ORIGIN + path);
  return handleApp(new Request(u, { headers: cookie ? { Cookie: cookie } : {} }), env, u);
}

export function appSend(env, cookie, method, path, body) {
  const u = new URL(ORIGIN + path);
  return handleApp(new Request(u, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }), env, u);
}

export function legacyScopedAdmin(env, prefixes, id = 'k_legacyadm') {
  const key = 'bk_legacy_scoped_admin_' + id;
  env.DB.sqlite.prepare(
    `INSERT INTO api_keys (id, key_hash, name, role, prefixes, created, expires, revoked)
     VALUES (?, ?, ?, 'admin', ?, datetime('now'), NULL, 0)`
  ).run(id, sha256hex(key), 'legacy scoped admin', JSON.stringify(prefixes));
  return { id, key };
}
