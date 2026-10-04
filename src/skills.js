// Always-on skills: which skills bind to which project, and how much of each
// gets injected into a session. Lives apart from index.js so app.js can serve
// the Skills tab without index.js -> app.js -> index.js becoming a cycle.

import { getFile } from './github.js';
import { allowed, sha256hex } from './auth.js';

// vault/skills.md maps a project slug to its session skills. One line per row:
//   default: !unslop, !no-comments, principle-prove-it-works
//   brainmcp: default + writing-for-agents
// A leading `!` means must-load: get_context returns the skill's full body. A
// bare name is catalogued only, and the agent pulls it with get_skill on demand.
// When a row inherits the default set and re-lists one of its skills, must-load
// wins: marking `!unslop` in a project row upgrades the inherited bare `unslop`.

const SKILLS_CONFIG_PATH = 'vault/skills.md';
const SKILLS_RESERVED_KEYS = new Set(['type', 'title', 'updated', 'tags', 'status']);
const PROJECT_SLUG = /^[a-z0-9][A-Za-z0-9._-]*$/;
const ROW = new RegExp(`^(${PROJECT_SLUG.source.slice(1, -1)}):[ \\t]*(\\S.*)$`);
const DEFAULT_REF = /^default(?=\s*(?:[+,]|$))/;

function frontmatterEnd(lines) {
  if (lines[0]?.trimEnd() !== '---') return 0;
  const close = lines.findIndex((l, n) => n > 0 && l.trimEnd() === '---');
  return close > 0 ? close + 1 : 0;
}

function scanRows(lines) {
  const rows = [];
  const seen = new Set();
  let fenced = false;
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = line.match(ROW);
    if (!m || SKILLS_RESERVED_KEYS.has(m[1])) continue;
    rows.push({ line: i, project: m[1], raw: m[2], duplicate: seen.has(m[1]) });
    seen.add(m[1]);
  }
  return rows;
}

/** Parse skills.md into { header, entries: [{ project, raw }] } preserving prose above the rows. */
export function parseSkillsConfig(text) {
  const lines = String(text || '').split('\n');
  const rows = scanRows(lines);
  const header = lines.slice(0, rows.length ? rows[0].line : lines.length).join('\n').replace(/\n+$/, '');
  return { header, entries: rows.filter((r) => !r.duplicate).map(({ project, raw }) => ({ project, raw })) };
}

/** Expand one row's raw value into [{ name, must }], resolving `default + extras`. */
function expandSkillRow(raw, defaultRaw) {
  let value = String(raw || '').trim();
  let inherits = false;
  if (DEFAULT_REF.test(value)) {
    inherits = true;
    const extras = value.replace(DEFAULT_REF, '');
    value = [defaultRaw || '', extras].filter(Boolean).join(', ');
  }
  const out = [];
  for (const part of value.split(/[,+]/)) {
    const token = part.trim();
    if (!token) continue;
    const must = token.startsWith('!');
    const name = (must ? token.slice(1) : token).trim();
    if (!name) continue;
    const seen = out.find((s) => s.name === name);
    if (seen) seen.must = seen.must || must;
    else out.push({ name, must });
  }
  return { skills: out, inherits };
}

/** Resolve the skills that apply to a project slug (falls back to the default row). */
export function resolveSkillsFor(text, slug) {
  const { entries } = parseSkillsConfig(text);
  const byProject = new Map(entries.map((e) => [e.project, e.raw]));
  const defaultRaw = byProject.get('default') || '';
  const raw = (slug && byProject.get(slug)) || defaultRaw;
  return expandSkillRow(raw, defaultRaw).skills;
}

/** Split skills.md into the UI's editable shape: catalogue-independent rows. */
export function skillsConfigEntries(text) {
  const { header, entries } = parseSkillsConfig(text);
  const byProject = new Map(entries.map((e) => [e.project, e.raw]));
  const defaultRaw = byProject.get('default') || '';
  return {
    header,
    entries: entries.map((e) => {
      const { skills, inherits } = expandSkillRow(e.raw, defaultRaw);
      if (e.project === 'default' || !inherits) return { project: e.project, inherits_default: false, skills };
      // A `default + extras` row shows only its own extras; the inherited set is implied.
      const own = expandSkillRow(e.raw.replace(DEFAULT_REF, ''), '').skills;
      return { project: e.project, inherits_default: true, skills: own };
    }),
  };
}

const SKILL_NAME = /^[A-Za-z0-9._-]+$/;

export function validateSkillEntries(entries) {
  for (const e of entries) {
    const project = String(e?.project ?? '');
    if (!PROJECT_SLUG.test(project) || SKILLS_RESERVED_KEYS.has(project)) return `invalid project slug: ${JSON.stringify(project.slice(0, 80))}`;
    for (const s of Array.isArray(e.skills) ? e.skills : []) {
      if (!SKILL_NAME.test(String(s?.name ?? ''))) return `invalid skill name in ${project}: ${JSON.stringify(String(s?.name ?? '').slice(0, 80))}`;
    }
  }
  if (new Set(entries.map((e) => e.project)).size !== entries.length) return 'each project may appear once';
  const empty = entries.find((e) => !e.inherits_default && !(Array.isArray(e.skills) && e.skills.length));
  if (empty) return `${empty.project} needs at least one skill or default`;
  return null;
}

function renderRow(e) {
  const names = (Array.isArray(e.skills) ? e.skills : []).map((s) => (s.must ? '!' : '') + s.name);
  if (e.project !== 'default' && e.inherits_default) return `${e.project}: default${names.length ? ` + ${names.join(', ')}` : ''}`;
  return `${e.project}: ${names.join(', ')}`;
}

export function renderSkillsConfig(text, entries) {
  const lines = String(text || '').replace(/\n+$/, '').split('\n');
  const want = new Map(entries.map((e) => [e.project, e]));
  const placed = new Set();
  const drop = new Set();
  let last = -1;
  for (const r of scanRows(lines)) {
    last = r.line;
    const e = want.get(r.project);
    if (!e || placed.has(r.project)) { drop.add(r.line); continue; }
    lines[r.line] = renderRow(e);
    placed.add(r.project);
  }
  const fresh = entries.filter((e) => !placed.has(e.project)).flatMap((e) => ['', renderRow(e)]);
  const at = last === -1 ? lines.length : last + 1;
  lines.splice(at, 0, ...fresh);
  const out = [];
  lines.forEach((l, i) => {
    if (i < at && drop.has(i)) {
      if (out.length && out[out.length - 1].trim() === '') out.pop();
      return;
    }
    out.push(l);
  });
  return `${out.join('\n')}\n`;
}

export async function skillCatalog(db, readable) {
  const res = await db.prepare(
    `SELECT path, json_extract(frontmatter, '$.description') AS description, LENGTH(CAST(body AS BLOB)) AS bytes
       FROM notes WHERE path >= 'skills/' AND path < 'skills0' AND path LIKE 'skills/%/SKILL.md' ORDER BY path`
  ).all();
  return res.results
    .filter((r) => r.path.split('/').length === 3 && readable(r.path.split('/')[1], r.path))
    .map((r) => ({ name: r.path.split('/')[1], description: r.description || '', bytes: r.bytes || 0 }));
}

/**
 * The config rows a principal may see: all of them with read access to skills.md,
 * otherwise the default row plus rows for projects whose note it can read.
 */
export function visibleEntries(p, entries) {
  if (allowed(p, SKILLS_CONFIG_PATH)) return entries;
  return entries.filter((e) => e.project === 'default' || allowed(p, `vault/projects/${e.project}.md`));
}

/** Read skills.md from the index, falling back to GitHub when it is not indexed yet. */
export async function readSkillsConfig(env) {
  const row = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(SKILLS_CONFIG_PATH).first();
  if (row?.body) return row.body;
  const f = await getFile(env, SKILLS_CONFIG_PATH);
  return f?.content || '';
}

export function skillLayer({ space, pv, db, config, rowSlug = null }) {
  const applies = resolveSkillsFor(config, rowSlug);
  const named = new Set(applies.map((s) => s.name));
  return { space, pv, db, applies, boundOrAllowed: (name) => named.has(name) || allowed(pv, `skills/${name}/SKILL.md`) };
}

const clipDescription = (d) => (d.length > 200 ? `${d.slice(0, 200)}…` : d);

export async function skillsPayload(layers) {
  const applies = [];
  for (const L of layers) {
    for (const s of L.applies) {
      const seen = applies.find((x) => x.name === s.name);
      if (seen) seen.must = seen.must || s.must;
      else applies.push({ ...s });
    }
  }
  const catalogs = await Promise.all(layers.map((L) => skillCatalog(L.db, (name) => L.boundOrAllowed(name))));
  const known = new Set(catalogs.flat().map((s) => s.name));
  const loaded = [];
  const missing = [];
  const forbidden = [];
  for (const s of applies.filter((x) => x.must)) {
    const path = `skills/${s.name}/SKILL.md`;
    let hit = null;
    let blocked = false;
    for (const L of layers) {
      if (!L.boundOrAllowed(s.name)) { blocked = true; continue; }
      const r = await L.db.prepare('SELECT body FROM notes WHERE path = ?').bind(path).first();
      if (r?.body) { hit = { name: s.name, source: `@${L.space.handle}`, sha256: await sha256hex(r.body), body: r.body }; break; }
    }
    if (hit) loaded.push(hit);
    else (blocked ? forbidden : missing).push(s.name);
  }
  const byName = [];
  for (const { name, must } of applies) {
    if (must) continue;
    if (known.has(name)) byName.push(name);
    else if (layers.some((L) => L.boundOrAllowed(name))) missing.push(name);
    else forbidden.push(name);
  }
  const inBody = new Set(loaded.map((s) => s.name));
  const catalog = [];
  for (const s of catalogs.flat()) {
    if (!inBody.has(s.name) && !catalog.some((c) => c.name === s.name)) catalog.push({ name: s.name, description: clipDescription(s.description) });
  }
  return {
    must_load: loaded,
    on_demand: byName,
    catalog,
    ...(missing.length ? { unresolved: missing } : {}),
    ...(forbidden.length ? { forbidden } : {}),
    hint:
      'Apply must_load skills for this whole session without being asked. Fetch each on_demand skill with '
      + 'get_skill before work it governs. catalog lists the rest of the library. forbidden names skills this '
      + 'session should use but your key cannot read.',
  };
}
