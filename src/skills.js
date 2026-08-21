// Always-on skills: which skills bind to which project, and how much of each
// gets injected into a session. Lives apart from index.js so app.js can serve
// the Skills tab without index.js -> app.js -> index.js becoming a cycle.

import { getFile } from './github.js';
import { allowed } from './auth.js';

// vault/skills.md maps a project slug to its session skills. One line per row:
//   default: !unslop, !no-comments, principle-prove-it-works
//   brainmcp: default + writing-for-agents
// A leading `!` means must-load: get_context returns the skill's full body. A
// bare name is catalogued only, and the agent pulls it with get_skill on demand.
// When a row inherits the default set and re-lists one of its skills, must-load
// wins: marking `!unslop` in a project row upgrades the inherited bare `unslop`.

const SKILLS_CONFIG_PATH = 'vault/skills.md';
const SKILLS_RESERVED_KEYS = new Set(['type', 'title', 'updated', 'tags', 'status']);

/** Parse skills.md into { header, entries: [{ project, raw }] } preserving prose above the rows. */
export function parseSkillsConfig(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  const headerLines = [];
  let seenRow = false;
  for (const line of lines) {
    const m = line.match(/^([a-z0-9-]+):[ \t]*(\S.*?)[ \t]*$/);
    if (m && !SKILLS_RESERVED_KEYS.has(m[1])) {
      entries.push({ project: m[1], raw: m[2] });
      seenRow = true;
      continue;
    }
    if (!seenRow) headerLines.push(line);
  }
  return { header: headerLines.join('\n').replace(/\n+$/, ''), entries };
}

/** Expand one row's raw value into [{ name, must }], resolving `default + extras`. */
function expandSkillRow(raw, defaultRaw) {
  let value = String(raw || '').trim();
  let inherits = false;
  if (/^default\b/.test(value)) {
    inherits = true;
    const extras = value.slice('default'.length).replace(/^[\s+,]+/, '');
    value = [defaultRaw || '', extras].filter(Boolean).join(', ');
  }
  const out = [];
  for (const part of value.split(',')) {
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
      const own = expandSkillRow(e.raw.replace(/^default\b[\s+,]*/, ''), '').skills;
      return { project: e.project, inherits_default: true, skills: own };
    }),
  };
}

/** Render entries back to skills.md, keeping the original header prose. */
export function renderSkillsConfig(header, entries) {
  const rows = entries
    .filter((e) => /^[a-z0-9-]+$/.test(String(e.project || '')))
    // `default` first regardless of the order the caller sent, so a PUT
    // round-trip never reshuffles the file.
    .slice()
    .sort((a, b) => (a.project === 'default' ? -1 : b.project === 'default' ? 1 : 0))
    .map((e) => {
      const names = (Array.isArray(e.skills) ? e.skills : [])
        .filter((s) => s && /^[A-Za-z0-9._-]+$/.test(String(s.name || '')))
        .map((s) => (s.must ? '!' : '') + s.name);
      if (e.project !== 'default' && e.inherits_default) {
        return `${e.project}: default${names.length ? ` + ${names.join(', ')}` : ''}`;
      }
      return `${e.project}: ${names.join(', ')}`;
    });
  return `${String(header || '').replace(/\n+$/, '')}\n\n${rows.join('\n\n')}\n`;
}

/** The skills library as { name, description } rows, scoped to the principal. */
export async function skillCatalog(env, p) {
  const res = await env.DB.prepare(
    `SELECT path, json_extract(frontmatter, '$.name') AS name, json_extract(frontmatter, '$.description') AS description,
            LENGTH(CAST(body AS BLOB)) AS bytes
       FROM notes WHERE path LIKE 'skills/%/SKILL.md' ORDER BY path`
  ).all();
  return res.results
    .filter((r) => allowed(p, r.path))
    .map((r) => ({ name: r.name || r.path.split('/')[1], description: r.description || '', bytes: r.bytes || 0 }));
}

/** Read skills.md from the index, falling back to GitHub when it is not indexed yet. */
export async function readSkillsConfig(env) {
  const row = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(SKILLS_CONFIG_PATH).first();
  if (row?.body) return row.body;
  const f = await getFile(env, SKILLS_CONFIG_PATH);
  return f?.content || '';
}

/**
 * The session skills payload for get_context: must-load bodies in full, the rest
 * by name, plus the whole catalogue so the agent can pull anything on demand.
 */
export async function skillsPayload(env, p, slug) {
  const [configText, catalog] = await Promise.all([readSkillsConfig(env), skillCatalog(env, p)]);
  const applies = resolveSkillsFor(configText, slug);
  const known = new Set(catalog.map((s) => s.name));
  const loaded = [];
  const missing = [];
  for (const s of applies.filter((x) => x.must)) {
    if (!allowed(p, `skills/${s.name}/SKILL.md`)) continue;
    const r = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`skills/${s.name}/SKILL.md`).first();
    if (r?.body) loaded.push({ name: s.name, body: r.body });
    else missing.push(s.name);
  }
  const byName = applies.filter((x) => !x.must).map((x) => x.name);
  for (const n of byName) if (!known.has(n)) missing.push(n);
  return {
    must_load: loaded,
    on_demand: byName,
    catalog,
    ...(missing.length ? { unresolved: missing } : {}),
    hint:
      'must_load skills are BINDING for this session — apply them without being asked. on_demand skills are '
      + 'binding too, but their bodies are not included: fetch each with get_skill before you start work that '
      + 'it governs. catalog lists everything else available via get_skill.',
  };
}

