// Memory beyond full-text search: token budgets, superseded decisions, semantic
// search (Workers AI embeddings in Vectorize, fused with FTS5 by reciprocal rank),
// and consolidation proposals. Semantic search turns on only when both the AI and
// VECTORS bindings exist; without them every path falls back to FTS5 alone.

import { sha256hex } from './auth.js';

export const EMBED_MODEL = '@cf/baai/bge-m3';
const EMBED_CHARS = 6000;
const EMBED_BATCH = 20;
const EMBED_PER_RUN = 400;
const RRF_K = 60;

export const estimateTokens = (v) => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 4);

/**
 * Trim a get_context payload to a token budget. Drops the least essential parts
 * first: older sessions and decisions, the active-projects table, then the project
 * note's tail. Instructions (binding_rules, skills) are never cut.
 */
export function fitContext(out, maxTokens) {
  const budget = Math.max(500, Number(maxTokens) || 0);
  if (!maxTokens || estimateTokens(out) <= budget) return out;
  const steps = [
    () => out.recent_sessions?.length > 1 && out.recent_sessions.pop(),
    () => out.recent_decisions?.length > 2 && out.recent_decisions.shift(),
    () => out.active_projects?.length > 5 && out.active_projects.splice(5),
    () => out.connections?.length > 10 && out.connections.splice(10),
    () => typeof out.project_note === 'string' && out.project_note.length > 1500 && (out.project_note = `${out.project_note.slice(0, Math.floor(out.project_note.length * 0.7))} …[trimmed to fit max_tokens; read_note for the rest]`),
  ];
  for (let guard = 0; guard < 200 && estimateTokens(out) > budget; guard++) {
    if (!steps.some((s) => s())) break;
  }
  out.trimmed_to_tokens = budget;
  return out;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/…$/, '').replace(/\s+/g, ' ').trim();

/**
 * Drop decision blocks that a later block supersedes. A block supersedes another with
 * a "- **Supersedes:** <title or [date] title>" line. It hides only earlier blocks of
 * the same project whose title matches: exactly, or as the two sides of a title
 * truncated with "…".
 */
export function liveDecisions(blocks) {
  const info = blocks.map((b) => ({
    title: normTitle(/^### \[[^\]]*\] (.*)$/m.exec(b)?.[1]),
    rawTitle: /^### \[[^\]]*\] (.*)$/m.exec(b)?.[1] || '',
    chosen: normTitle(/^- \*\*Chosen:\*\* (.*)$/m.exec(b)?.[1]),
    project: (/^- \*\*Project:\*\* (.*)$/m.exec(b)?.[1] || '').trim(),
    ref: normTitle((/^- \*\*Supersedes:\*\* (.+)$/m.exec(b)?.[1] || '').replace(/^\[[^\]]*\]\s*/, '')),
  }));
  const hidden = new Set();
  const same = (ref, title, rawTitle) => {
    if (!ref || ref.length < 4 || !title) return false;
    if (ref === title) return true;
    if (title.length >= 8 && ref.startsWith(`${title} `)) return true;
    if (rawTitle.trim().endsWith('…') && ref.startsWith(title) && title.length >= 20) return true;
    return false;
  };
  info.forEach((sup, i) => {
    if (!sup.ref) return;
    for (let j = 0; j < i; j++) {
      const old = info[j];
      if (old.project !== sup.project) continue;
      if (same(sup.ref, old.title, old.rawTitle) || sup.ref === old.chosen) hidden.add(j);
    }
  });
  return blocks.filter((_, i) => !hidden.has(i));
}

/** Reciprocal-rank fusion of ranked path lists. */
export function rrfFuse(lists) {
  const score = new Map();
  for (const list of lists) {
    list.forEach((path, i) => score.set(path, (score.get(path) || 0) + 1 / (RRF_K + i + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

export const semanticReady = (env) => !!(env.AI && env.VECTORS);

async function embed(env, texts) {
  const r = await env.AI.run(EMBED_MODEL, { text: texts.map((t) => String(t).slice(0, EMBED_CHARS)) });
  return r?.data || [];
}

const vectorId = async (spaceId, path) => (await sha256hex(`${spaceId}\n${path}`)).slice(0, 48);

/** Paths in one space ranked by meaning. IDs only live in Vectorize; the path map stays in D1. */
export async function semanticPaths(env, spaceId, query, topK = 30) {
  if (!semanticReady(env) || !query) return [];
  const [vector] = await embed(env, [query]);
  if (!vector) return [];
  const res = await env.VECTORS.query(vector, { topK: Math.min(50, topK), namespace: spaceId });
  const matches = res?.matches || [];
  const top = Math.max(0, ...matches.map((m) => (typeof m.score === 'number' ? m.score : 0)));
  const floor = Math.max(Number(env.MEMORY_MIN_SCORE ?? 0.1), top * 0.3);
  const ids = matches.filter((m) => typeof m.score !== 'number' || m.score >= floor).map((m) => m.id);
  if (!ids.length) return [];
  const rows = (await env.DB.prepare('SELECT vector_id, path FROM embeddings WHERE space_id = ? AND vector_id IN (SELECT value FROM json_each(?))')
    .bind(spaceId, JSON.stringify(ids)).all()).results;
  const byId = new Map(rows.map((r) => [r.vector_id, r.path]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Embed notes that changed since their last embedding, for every active space. Runs
 * from the nightly cron and from POST /admin/embed; bounded per run.
 */
export async function embedPending(env, spaces, storeFor) {
  if (!semanticReady(env)) return { skipped: 'no AI or VECTORS binding' };
  let embedded = 0;
  let removed = 0;
  const live = new Set(spaces.map((s) => s.id));
  const stale = (await env.DB.prepare('SELECT DISTINCT space_id FROM embeddings').all()).results.map((r) => r.space_id).filter((id) => !live.has(id));
  for (const id of stale) await dropSpaceVectors(env, id);
  for (const space of spaces) {
    if (embedded >= EMBED_PER_RUN) break;
    const db = storeFor(space).db;
    const notes = (await db.prepare("SELECT path, title, body FROM notes WHERE path NOT LIKE 'vault/logs/activity/%' AND type != 'file'").all()).results;
    const known = new Map((await env.DB.prepare('SELECT path, hash, vector_id FROM embeddings WHERE space_id = ?').bind(space.id).all()).results.map((r) => [r.path, r]));
    const todo = [];
    for (const n of notes) {
      const text = `${n.title || ''}\n${n.body || ''}`.slice(0, EMBED_CHARS);
      const hash = (await sha256hex(text)).slice(0, 32);
      if (known.get(n.path)?.hash !== hash) todo.push({ path: n.path, text, hash });
      known.delete(n.path);
    }
    const gone = [...known.values()];
    if (gone.length) {
      await env.VECTORS.deleteByIds(gone.map((g) => g.vector_id));
      await env.DB.batch(gone.map((g) => env.DB.prepare('DELETE FROM embeddings WHERE space_id = ? AND path = ?').bind(space.id, g.path)));
      removed += gone.length;
    }
    for (let i = 0; i < todo.length && embedded < EMBED_PER_RUN; i += EMBED_BATCH) {
      const batch = todo.slice(i, i + EMBED_BATCH);
      const vectors = await embed(env, batch.map((b) => b.text));
      const rows = [];
      for (let j = 0; j < batch.length; j++) {
        if (!vectors[j]) continue;
        rows.push({ ...batch[j], id: await vectorId(space.id, batch[j].path), values: vectors[j] });
      }
      if (!rows.length) continue;
      await env.VECTORS.upsert(rows.map((r) => ({ id: r.id, values: r.values, namespace: space.id })));
      await env.DB.batch(rows.map((r) => env.DB.prepare(
        "INSERT OR REPLACE INTO embeddings (space_id, path, hash, vector_id, updated) VALUES (?, ?, ?, ?, datetime('now'))"
      ).bind(space.id, r.path, r.hash, r.id)));
      embedded += rows.length;
    }
  }
  return { embedded, removed };
}

/** Forget every vector of a space (share revoked, space deleted). */
export async function dropSpaceVectors(env, spaceId) {
  if (!semanticReady(env)) return;
  const ids = (await env.DB.prepare('SELECT vector_id FROM embeddings WHERE space_id = ?').bind(spaceId).all()).results.map((r) => r.vector_id);
  for (let i = 0; i < ids.length; i += 500) await env.VECTORS.deleteByIds(ids.slice(i, i + 500));
  await env.DB.prepare('DELETE FROM embeddings WHERE space_id = ?').bind(spaceId).run();
}

const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/**
 * Proposals for the weekly consolidation, never applied automatically: topic notes
 * that look like duplicates, and decisions a later decision superseded.
 */
export async function consolidationProposals(db, allowed) {
  const topics = (await db.prepare("SELECT path, title, substr(body, 1, 600) AS head FROM notes WHERE type = 'topic' ORDER BY path").all()).results
    .filter((t) => allowed(t.path));
  const sets = topics.map((t) => ({ ...t, w: words(`${t.title} ${t.path.split('/').pop()} ${t.head}`) }));
  const duplicates = [];
  for (let i = 0; i < sets.length && duplicates.length < 20; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const s = jaccard(sets[i].w, sets[j].w);
      if (s >= 0.55) duplicates.push({ notes: [sets[i].path, sets[j].path], similarity: Math.round(s * 100) / 100, proposal: 'merge into one topic note' });
    }
  }
  return { duplicate_topics: duplicates };
}
