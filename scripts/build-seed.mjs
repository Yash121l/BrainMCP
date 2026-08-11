#!/usr/bin/env node
// Walk the vault, parse every indexable .md, and emit chunked SQL seed files
// (mcp/.seed/seed-NNN.sql). Apply with scripts/apply-seed.sh.
// Mirrors exactly what the Worker's webhook/reindex ingest does.

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNote, isIndexable } from '../src/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.BRAIN_DIR || join(process.env.HOME, 'obsidian', 'brain');
const OUT = join(here, '..', '.seed');

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e === '.obsidian' || e === '.trash' || e === '.seed' || e === '.wrangler') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const esc = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''").replace(/\0/g, '')}'`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let statements = [
  'DELETE FROM notes;',
  'DELETE FROM links;',
  'DELETE FROM fts;',
];
let count = 0;

for (const file of walk(VAULT)) {
  const path = relative(VAULT, file);
  if (!isIndexable(path)) continue;
  const n = parseNote(path, readFileSync(file, 'utf8'));
  // D1 rejects statements >100KB (SQLITE_TOOBIG): insert big bodies in appended slices.
  const SLICE = 40_000;
  if (n.body.length + n.frontmatter.length <= SLICE) {
    statements.push(
      `INSERT OR REPLACE INTO notes (path,title,type,project,status,tags,frontmatter,body,updated,indexed_at) VALUES (${esc(n.path)},${esc(n.title)},${esc(n.type)},${esc(n.project)},${esc(n.status)},${esc(n.tags)},${esc(n.frontmatter)},${esc(n.body)},${esc(n.updated)},datetime('now'));`
    );
  } else {
    statements.push(
      `INSERT OR REPLACE INTO notes (path,title,type,project,status,tags,frontmatter,body,updated,indexed_at) VALUES (${esc(n.path)},${esc(n.title)},${esc(n.type)},${esc(n.project)},${esc(n.status)},${esc(n.tags)},'','',${esc(n.updated)},datetime('now'));`
    );
    for (let i = 0; i < n.frontmatter.length; i += SLICE) {
      statements.push(`UPDATE notes SET frontmatter = frontmatter || ${esc(n.frontmatter.slice(i, i + SLICE))} WHERE path = ${esc(n.path)};`);
    }
    for (let i = 0; i < n.body.length; i += SLICE) {
      statements.push(`UPDATE notes SET body = body || ${esc(n.body.slice(i, i + SLICE))} WHERE path = ${esc(n.path)};`);
    }
  }
  for (const dst of n.links) statements.push(`INSERT OR REPLACE INTO links (src,dst) VALUES (${esc(n.path)},${esc(dst)});`);
  for (const c of n.chunks) statements.push(`INSERT INTO fts (path,title,heading,text) VALUES (${esc(n.path)},${esc(n.title)},${esc(c.heading)},${esc(c.text)});`);
  count++;
}

statements.push(`INSERT OR REPLACE INTO meta (k,v) VALUES ('last_full_reindex', datetime('now'));`);

// write ~1.5MB shards
let shard = 0, buf = '';
const flush = () => {
  if (!buf) return;
  writeFileSync(join(OUT, `seed-${String(shard).padStart(3, '0')}.sql`), buf);
  shard++; buf = '';
};
for (const s of statements) {
  buf += s + '\n';
  if (buf.length > 1_500_000) flush();
}
flush();

console.log(`parsed ${count} notes -> ${shard} seed shard(s) in mcp/.seed/`);
