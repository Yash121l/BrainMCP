// D1 index maintenance. The index is disposable: every row here can be rebuilt
// from the git repo, so this is a cache, never a source of truth. Extracted from
// index.js so app.js can refresh a note it just wrote without an import cycle.

import { parseNote, isIndexable } from './parse.js';

export async function upsertNotes(env, parsed) {
  const stmts = [];
  for (const n of parsed) {
    stmts.push(env.DB.prepare('DELETE FROM links WHERE src = ?').bind(n.path));
    stmts.push(env.DB.prepare('DELETE FROM fts WHERE path = ?').bind(n.path));
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO notes (path, title, type, project, status, tags, frontmatter, body, updated, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(n.path, n.title, n.type, n.project, n.status, n.tags, n.frontmatter, n.body, n.updated)
    );
    for (const dst of n.links) {
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO links (src, dst) VALUES (?, ?)').bind(n.path, dst));
    }
    for (const c of n.chunks) {
      stmts.push(
        env.DB.prepare('INSERT INTO fts (path, title, heading, text) VALUES (?, ?, ?, ?)').bind(
          n.path, n.title, c.heading, c.text
        )
      );
    }
  }
  // D1 batch caps: send in slices to stay well under statement limits
  for (let i = 0; i < stmts.length; i += 90) {
    await env.DB.batch(stmts.slice(i, i + 90));
  }
}

export async function deleteNotes(env, paths) {
  const stmts = [];
  for (const p of paths) {
    stmts.push(env.DB.prepare('DELETE FROM notes WHERE path = ?').bind(p));
    stmts.push(env.DB.prepare('DELETE FROM links WHERE src = ?').bind(p));
    stmts.push(env.DB.prepare('DELETE FROM fts WHERE path = ?').bind(p));
  }
  if (stmts.length) await env.DB.batch(stmts);
}


/** Refresh one path in the index right after we commit it, ahead of the webhook. */
export async function upsertLocal(env, path, content) {
  if (isIndexable(path)) await upsertNotes(env, [parseNote(path, content)]);
}
