// D1 index maintenance. The index is disposable: every row here can be rebuilt
// from the git repo, so this is a cache, never a source of truth. Extracted from
// index.js so app.js can refresh a note it just wrote without an import cycle.

import { parseNote, isIndexable } from './parse.js';

function noteStatements(env, n) {
  const stmts = [
    env.DB.prepare('DELETE FROM links WHERE src = ?').bind(n.path),
    env.DB.prepare('DELETE FROM fts WHERE path = ?').bind(n.path),
    env.DB.prepare(
      `INSERT OR REPLACE INTO notes (path, title, type, project, status, tags, frontmatter, body, updated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(n.path, n.title, n.type, n.project, n.status, n.tags, n.frontmatter, n.body, n.updated),
  ];
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
  return stmts;
}

/**
 * Index parsed notes. A note that cannot be bound or written is skipped, keeping
 * its previous index rows, so one bad file never blocks the rest.
 * Returns [{ path, error }] for the skipped notes.
 */
export async function upsertNotes(env, parsed) {
  const failed = [];
  const units = [];
  for (const n of parsed) {
    try {
      units.push({ path: n.path, stmts: noteStatements(env, n) });
    } catch (e) {
      failed.push({ path: n.path, error: e.message });
    }
  }
  // D1 batch caps: whole notes per ~90-statement batch. A failed batch rolls back
  // and is retried note by note to find the culprit.
  const flush = async (group) => {
    const stmts = group.flatMap((u) => u.stmts);
    try {
      for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    } catch (e) {
      if (group.length === 1) failed.push({ path: group[0].path, error: e.message });
      else for (const u of group) await flush([u]);
    }
  };
  let group = [];
  let size = 0;
  for (const u of units) {
    if (group.length && size + u.stmts.length > 90) {
      await flush(group);
      group = [];
      size = 0;
    }
    group.push(u);
    size += u.stmts.length;
  }
  if (group.length) await flush(group);
  return failed;
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
  if (!isIndexable(path)) return;
  const [failed] = await upsertNotes(env, [parseNote(path, content)]);
  if (failed) throw new Error(`indexing ${path} failed: ${failed.error}`);
}
