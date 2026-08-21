// BrainMCP — the ClaudeBrain vault as an MCP server on Cloudflare Workers.
// git (GitHub repo) is the source of truth; D1 is a disposable accelerator index.
// Streamable-HTTP MCP (JSON-RPC over POST /mcp), bearer-token auth, webhook ingest.

import { parseNote, isIndexable, normalizeProject } from './parse.js';
import { upsertNotes, deleteNotes, upsertLocal } from './indexer.js';
import { getFile, putFile, appendFile, multiCommit, fetchRepoTar, tarEntries, encodeBase64 } from './github.js';
import { handleOauth } from './oauth.js';
import { resolvePrincipal, allowed, canWrite, isAdmin, createKey, listKeys, revokeKey } from './auth.js';
import { handleApp, computeHygiene } from './app.js';
import { skillCatalog, readSkillsConfig, skillsConfigEntries, skillsPayload } from './skills.js';
import { hookInstaller, HOOK_VERSION } from './hook.js';

// ---------------------------------------------------------------- indexing

async function indexFromGitHub(env, paths) {
  const parsed = [];
  for (const p of paths) {
    const f = await getFile(env, p);
    if (f) parsed.push(parseNote(p, f.content));
  }
  await upsertNotes(env, parsed);
  return parsed.length;
}

async function fullReindex(env) {
  const tar = await fetchRepoTar(env);
  const parsed = [];
  for (const e of tarEntries(tar)) {
    if (isIndexable(e.path)) parsed.push(parseNote(e.path, e.text()));
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notes'),
    env.DB.prepare('DELETE FROM links'),
    env.DB.prepare('DELETE FROM fts'),
  ]);
  await upsertNotes(env, parsed);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_full_reindex', datetime('now'))").run();
  return parsed.length;
}

// ---------------------------------------------------------------- helpers

const nowDate = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toISOString().slice(11, 19).replace(/:/g, '');
const randId = (n = 4) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

/** Sanitize a client-supplied session id down to something safe in a filename. */
const sessionKey = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

function ftsQuery(q) {
  // sanitize to phrase-per-token to avoid FTS5 syntax errors on user input
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

// ------------------------------------------------- vault file composers (shared)

const yamlStr = (s) => String(s ?? '').replace(/"/g, "'").replace(/\r?\n/g, ' ');

/** Standard cloud session note. Same shape for append_session_log and save. */
function sessionNote({ slug, summary, body, next_steps, surface, date, id }) {
  return `---
type: session
project: ${slug ? `"[[projects/${slug}]]"` : '""'}
date: ${date}
started: ${new Date().toISOString()}
summary: "${yamlStr(summary)}"
duration:
surface: ${surface}
session_key: ${id}
tags: [session, cloud]
---

# Cloud session ${date}

## What happened
${body}

## Next steps
${next_steps || '- (none)'}

## Links
- Project: ${slug ? `[[projects/${slug}]]` : '(none)'}
`;
}

/** One append-only rich block for vault/logs/decisions.md. */
function decisionBlock(decision, rationale, slug, date) {
  const d = String(decision).trim();
  const title = d.length > 90 ? d.slice(0, 90) + '…' : d;
  const project = slug ? `[[projects/${slug}]]` : '(none)';
  return `\n### [${date}] ${title}\n- **Chosen:** ${d}\n- **Why:** ${String(rationale || '').trim()}\n- **Project:** ${project}\n`;
}

/** A topic note (full file — replaces any existing one). */
function topicNote({ slug, title, content, date }) {
  return `---
type: topic
title: "${yamlStr(title || slug)}"
updated: ${date}
tags: [topic]
---

${String(content || '').replace(/\n*$/, '\n')}`;
}

/**
 * Patch a project note's frontmatter in place: status / next / updated.
 * Returns the new text, or null if the note has no parseable frontmatter.
 */
function patchProjectNote(text, { status, next, date }) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  let fm = text.slice(0, end + 1); // "---\n<keys>\n"
  const rest = text.slice(end + 1); // "---\n<body>"

  // function replacements throughout: values are user text and may contain "$&"
  const setLine = (block, key, line, valueRe) => {
    if (valueRe && valueRe.test(block)) return block.replace(valueRe, () => line);
    const plain = new RegExp(`^${key}:.*$`, 'm');
    if (plain.test(block)) return block.replace(plain, () => line);
    return block.replace(/\n$/, () => `\n${line}\n`);
  };

  if (status != null && String(status).trim()) {
    fm = setLine(fm, 'status', `status: ${yamlStr(status).trim()}`, null);
  }
  if (next != null) {
    // `next:` is a double-quoted scalar that may be huge and may wrap across lines.
    // The value pattern allows \-escapes but never a bare " — so it cannot run past
    // its own closing quote and swallow the keys below it.
    fm = setLine(fm, 'next', `next: "${yamlStr(next)}"`, /^next:[ \t]*"(?:[^"\\]|\\[\s\S])*"[ \t]*$/m);
  }
  fm = setLine(fm, 'updated', `updated: ${date}`, null);
  return fm + rest;
}

// ---------------------------------------------------------------- MCP tools

// Returned from `initialize`, so every client (Claude Code, claude.ai connectors,
// Codex) injects it into system context. This is the device-independent
// replacement for the old machine-local SessionStart hook.
const INSTRUCTIONS = `ClaudeBrain: the user's persistent second brain (projects, topics, decisions, sessions, and a skills library), backed by a git repo and served through these tools.

At the START of every session, call get_context once. Pass the project slug if you can infer one from the working directory or the user's request; pass client_session_id when your client exposes a session id. Its response is authoritative for this session: binding_rules are mandatory, skills.must_load bodies apply without being asked, and skills.on_demand names must be fetched with get_skill before you do work they govern.

At the END of a session, or whenever the user says "save", call save once with the session_id get_context returned. It commits the session log, decisions, topic notes, and the project's status/next patch atomically. Then call check_brain and fix anything it flags that your session caused.

Rules: read the brain before answering questions about past work; never invent a project note for throwaway tasks; prefer [[wikilinks]] over copying content between notes; keep credentials and CRM/PII data out of notes.`;

const TOOLS = [
  {
    name: 'get_context',
    description:
      'Session bootstrap. Returns a session_id to pass to save, the always-on skills for this project (must-load bodies in full, the rest by name), the active projects table, and — when a project slug is given — that project\'s BINDING rules file in full, its project note, recent decisions and sessions. Call this ONCE at the start of every session, on every surface.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'project slug, e.g. "pulse"' },
        client_session_id: {
          type: 'string',
          description:
            "your client's own session id, when it exposes one. Adopted as the session_id so tool-call telemetry from this machine links to the session note.",
        },
      },
    },
  },
  {
    name: 'search',
    description: 'Full-text search over the whole vault (FTS5). Filters: type (project/topic/session/rules/...), project slug, folder prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        type: { type: 'string' },
        project: { type: 'string' },
        folder: { type: 'string', description: 'path prefix, e.g. "vault/topics/"' },
        limit: { type: 'number', default: 10 },
        include_logs: {
          type: 'boolean',
          description:
            'include session logs and activity mirrors. Off by default: they are the bulk of the vault and drown out knowledge notes.',
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'read_note',
    description: 'Read one note: full raw content plus parsed frontmatter.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. "vault/projects/pulse.md"' } }, required: ['path'] },
  },
  {
    name: 'list_notes',
    description: 'List notes by frontmatter filters (type, status, project) and/or folder prefix. Returns path, title, status, updated.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' }, status: { type: 'string' }, project: { type: 'string' },
        folder: { type: 'string' }, limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'backlinks',
    description: 'Notes that link TO the given note (the graph, incoming edges).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'links',
    description: 'Outgoing [[wikilinks]] FROM the given note.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'append_session_log',
    description:
      'Write-back for cloud sessions: creates vault/logs/sessions/<date>_<time>_cloud<id>.md in the vault (git commit) using the standard session format. Use at the end of a session ("save").',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'project slug' },
        summary: { type: 'string', description: 'one-line summary (frontmatter)' },
        body: { type: 'string', description: 'markdown: what happened, decisions, links' },
        next_steps: { type: 'string', description: 'markdown list of next steps' },
        surface: { type: 'string', description: 'where this ran: cowork / claude-web / codex-cloud / ...' },
      },
      required: ['summary', 'body'],
    },
  },
  {
    name: 'log_decision',
    description: 'Append a decision to vault/logs/decisions.md as a rich block (### [date] title, Chosen/Why/Project). Use for real decisions only.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string' },
        project: { type: 'string', description: 'project slug' },
        rationale: { type: 'string' },
      },
      required: ['decision', 'project', 'rationale'],
    },
  },
  {
    name: 'update_note',
    description:
      'Replace the full content of a note (guarded write; git commit). Use for curated updates: project status/next, topic notes. Read the note first; pass expected_sha from read to avoid clobbering.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'full new file content incl. frontmatter' },
        message: { type: 'string', description: 'commit message' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'save_session',
    description:
      'Atomic "save" ritual: one git commit containing the session log + updated project note (+ optionally vault/_activity/NOW.md, topic notes). files = [{path, content}].',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        message: { type: 'string' },
      },
      required: ['files', 'message'],
    },
  },
  {
    name: 'save',
    description:
      'THE end-of-session ritual, in ONE atomic git commit: session log + decisions + topic notes + project note status/next patch. Prefer this over calling append_session_log / log_decision / update_note separately.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'the session_id get_context returned. Makes save idempotent: calling it again updates the same session note instead of creating a second one.',
        },
        project: {
          type: 'string',
          description: 'project slug, e.g. "pulse". Omit for work that belongs to no project; it lands under "general".',
        },
        summary: { type: 'string', description: 'one-line summary (session frontmatter)' },
        body: { type: 'string', description: 'markdown: what happened this session' },
        next_steps: { type: 'string', description: 'markdown list of next steps' },
        surface: { type: 'string', description: 'where this ran: cowork / claude-web / codex-cloud / ...' },
        decisions: {
          type: 'array',
          description: 'real decisions made this session; each is appended to vault/logs/decisions.md',
          items: {
            type: 'object',
            properties: { decision: { type: 'string' }, rationale: { type: 'string' } },
            required: ['decision', 'rationale'],
          },
        },
        topics: {
          type: 'array',
          description: 'durable knowledge worth recalling later; writes vault/topics/<slug>.md (replaces the file if it exists)',
          items: {
            type: 'object',
            properties: { slug: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } },
            required: ['slug', 'content'],
          },
        },
        project_update: {
          type: 'object',
          description: "patch the project note's frontmatter in place (updated: is always bumped)",
          properties: { status: { type: 'string' }, next: { type: 'string' } },
        },
      },
      required: ['summary', 'body'],
    },
  },
  {
    name: 'check_brain',
    description:
      'Vault hygiene report: index counts, sessions never saved (no summary), active projects gone stale (>14d), and broken [[wikilinks]]. Use to spot rot before/after a save.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_skills',
    description: 'List the skills library (skills/<name>/SKILL.md): name + description + which projects each is mapped to.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_skill',
    description: 'Fetch one skill\'s full SKILL.md body by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

async function callTool(env, name, args = {}, p) {
  const deny = (why) => ({ error: `forbidden: ${why}` });
  switch (name) {
    case 'get_context': {
      const slug = normalizeProject(args.project || '');
      const out = {};
      out.session_id = sessionKey(args.client_session_id) || `srv${randId(6)}`;
      out.skills = await skillsPayload(env, p, slug);
      const active = await env.DB.prepare(
        "SELECT path, project, status, updated, json_extract(frontmatter, '$.next') AS next FROM notes WHERE type = 'project' AND status = 'active' ORDER BY updated DESC"
      ).all();
      out.active_projects = active.results.filter((r) => allowed(p, r.path)).map((r) => ({
        ...r, next: r.next ? String(r.next).slice(0, 400) + (String(r.next).length > 400 ? ' …[truncated — read_note for full]' : '') : null,
      }));
      if (slug) {
        if (!allowed(p, `vault/projects/${slug}.md`)) return deny(`your key has no access to project ${slug}`);
        const rules = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`vault/rules/${slug}.md`).first();
        out.binding_rules = rules ? rules.body : `(no rules/${slug}.md)`;
        const proj = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`vault/projects/${slug}.md`).first();
        out.project_note = proj ? proj.body : `(no projects/${slug}.md)`;
        const dec = allowed(p, 'vault/logs/decisions.md')
          ? await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first() : null;
        if (dec) {
          out.recent_decisions = dec.body.split(/\n(?=### \[)/)
            .filter((b) => b.startsWith('### [') && (b.includes(`[[projects/${slug}]]`) || b.includes(`**Project:** ${slug}`)))
            .slice(-10).map((b) => b.trim().slice(0, 500));
        }
        const sess = await env.DB.prepare(
          "SELECT path, json_extract(frontmatter, '$.summary') AS summary, json_extract(frontmatter, '$.date') AS date FROM notes WHERE type = 'session' AND project = ? ORDER BY path DESC LIMIT 5"
        ).bind(slug).all();
        out.recent_sessions = sess.results.filter((r) => allowed(p, r.path));
      } else {
        const dec = allowed(p, 'vault/logs/decisions.md')
          ? await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first() : null;
        if (dec) out.recent_decisions = dec.body.split(/\n(?=### \[)/)
          .filter((b) => b.startsWith('### [')).slice(-10).map((b) => b.trim().slice(0, 500));
      }
      out.hint =
        'Binding rules above are MANDATORY for this project. At session end call save with this session_id — '
        + 'calling it twice updates one note rather than creating two.';
      return out;
    }

    case 'search': {
      const limit = Math.min(args.limit || 10, 50);
      let sql =
        "SELECT f.path, n.title, n.type, n.project, n.updated, snippet(fts, 3, '«', '»', ' … ', 24) AS snippet FROM fts f JOIN notes n ON n.path = f.path WHERE fts MATCH ?";
      const binds = [ftsQuery(args.q)];
      if (args.type) { sql += ' AND n.type = ?'; binds.push(args.type); }
      if (args.project) { sql += ' AND n.project = ?'; binds.push(normalizeProject(args.project)); }
      if (args.folder) { sql += ' AND f.path LIKE ?'; binds.push(args.folder.replace(/\/?$/, '/') + '%'); }
      // Session logs and activity mirrors are ~80% of the vault. They swamp
      // knowledge notes in FTS ranking, so they are opt-in.
      if (!args.include_logs && !args.type && !args.folder) {
        sql += " AND n.type != 'session' AND f.path NOT LIKE 'vault/logs/activity/%'";
      }
      sql += ' ORDER BY rank LIMIT ?';
      binds.push(limit * 3); // over-fetch; scope filter may drop rows
      const res = await env.DB.prepare(sql).bind(...binds).all();
      // dedupe by path keeping best-ranked snippet; enforce key scopes
      const seen = new Map();
      for (const r of res.results) if (allowed(p, r.path) && !seen.has(r.path)) seen.set(r.path, r);
      return { results: [...seen.values()].slice(0, limit) };
    }

    case 'read_note': {
      if (!allowed(p, args.path)) return deny(`no access to ${args.path}`);
      const r = await env.DB.prepare('SELECT path, body, frontmatter, updated FROM notes WHERE path = ?').bind(args.path).first();
      if (!r) {
        // fall through to GitHub for very fresh files not yet indexed
        const f = await getFile(env, args.path);
        if (!f) return { error: `not found: ${args.path}` };
        return { path: args.path, content: f.content, sha: f.sha, source: 'github (not yet indexed)' };
      }
      return { path: r.path, frontmatter: JSON.parse(r.frontmatter), updated: r.updated, content: r.body };
    }

    case 'list_notes': {
      const limit = Math.min(args.limit || 50, 200);
      let sql = "SELECT path, title, type, project, status, updated FROM notes WHERE 1=1";
      const binds = [];
      if (args.type) { sql += ' AND type = ?'; binds.push(args.type); }
      if (args.status) { sql += ' AND status = ?'; binds.push(args.status); }
      if (args.project) { sql += ' AND project = ?'; binds.push(normalizeProject(args.project)); }
      if (args.folder) { sql += ' AND path LIKE ?'; binds.push(args.folder.replace(/\/?$/, '/') + '%'); }
      sql += ' ORDER BY updated DESC, path DESC LIMIT ?';
      binds.push(limit * 3);
      const res = await env.DB.prepare(sql).bind(...binds).all();
      return { notes: res.results.filter((r) => allowed(p, r.path)).slice(0, limit) };
    }

    case 'backlinks': {
      const noExt = args.path.replace(/\.md$/, '');
      const noVault = noExt.replace(/^vault\//, '');
      const base = noExt.split('/').pop();
      if (!allowed(p, args.path)) return deny(`no access to ${args.path}`);
      const res = await env.DB.prepare('SELECT DISTINCT src FROM links WHERE dst IN (?, ?, ?)').bind(noExt, noVault, base).all();
      return { backlinks: res.results.map((r) => r.src).filter((s) => allowed(p, s)) };
    }

    case 'links': {
      if (!allowed(p, args.path)) return deny(`no access to ${args.path}`);
      const res = await env.DB.prepare('SELECT dst FROM links WHERE src = ?').bind(args.path).all();
      return { links: res.results.map((r) => r.dst) };
    }

    case 'append_session_log': {
      if (!canWrite(p)) return deny('key is read-only');
      const slug = normalizeProject(args.project || '');
      const d = nowDate(); const t = nowTime(); const id = `cloud${randId(4)}`;
      const path = `vault/logs/sessions/${d}_${t}_${id}.md`;
      const content = sessionNote({
        slug, summary: args.summary || '', body: args.body, next_steps: args.next_steps,
        surface: args.surface || 'cloud', date: d, id,
      });
      if (!allowed(p, path)) return deny(`no write access to ${path} (key needs the vault/logs/ prefix)`);
      await putFile(env, path, content, `session(${args.surface || 'cloud'}): ${slug || 'general'} — ${(args.summary || '').slice(0, 60)}`);
      await upsertLocal(env, path, content);
      return { ok: true, path, committed: true };
    }

    case 'log_decision': {
      if (!canWrite(p)) return deny('key is read-only');
      if (!allowed(p, 'vault/logs/decisions.md')) return deny('no write access to vault/logs/decisions.md');
      const slug = normalizeProject(args.project);
      const d = args.decision.trim();
      const block = decisionBlock(d, args.rationale, slug, nowDate());
      const full = await appendFile(env, 'vault/logs/decisions.md', block, `decision(${slug}): ${d.slice(0, 60)}`);
      await upsertLocal(env, 'vault/logs/decisions.md', full);
      return { ok: true, appended: block.trim() };
    }

    case 'update_note': {
      if (!canWrite(p)) return deny('key is read-only');
      if (!allowed(p, args.path)) return deny(`no write access to ${args.path}`);
      const existing = await getFile(env, args.path);
      await putFile(env, args.path, args.content, args.message || `update: ${args.path}`, existing?.sha);
      await upsertLocal(env, args.path, args.content);
      return { ok: true, path: args.path, created: !existing };
    }

    case 'save_session': {
      if (!canWrite(p)) return deny('key is read-only');
      if (!Array.isArray(args.files) || !args.files.length) return { error: 'files[] required' };
      const blockedPath = args.files.find((f) => !allowed(p, f.path));
      if (blockedPath) return deny(`no write access to ${blockedPath.path}`);
      const sha = await multiCommit(env, args.files, args.message);
      for (const f of args.files) await upsertLocal(env, f.path, f.content);
      return { ok: true, commit: sha, files: args.files.map((f) => f.path) };
    }

    case 'save': {
      if (!canWrite(p)) return deny('key is read-only');
      const slug = normalizeProject(args.project || '') || 'general';
      if (!args.summary || !args.body) return { error: 'summary and body are required' };

      const date = nowDate();
      const surface = args.surface || 'cloud';
      const files = [];
      const skipped = [];

      // 1. session log — always written. When the caller passes back the
      // session_id from get_context we update that note in place, so saving
      // twice in one session yields one note, not two.
      const sessId = sessionKey(args.session_id) || `cloud${randId(4)}`;
      const prior = await env.DB.prepare(
        "SELECT path FROM notes WHERE type = 'session' AND json_extract(frontmatter, '$.session_key') = ? ORDER BY path LIMIT 1"
      ).bind(sessId).first();
      const sessPath = prior?.path || `vault/logs/sessions/${date}_${nowTime()}_${sessId}.md`;
      if (!allowed(p, sessPath)) return deny(`no write access to ${sessPath}`);
      files.push({
        path: sessPath,
        content: sessionNote({
          slug: args.project ? slug : '', summary: args.summary, body: args.body, next_steps: args.next_steps,
          surface, date, id: sessId,
        }),
      });

      // 2. decisions — append rich blocks to the single append-only log
      const decs = (Array.isArray(args.decisions) ? args.decisions : []).filter((x) => x && x.decision);
      if (decs.length) {
        const decPath = 'vault/logs/decisions.md';
        if (!allowed(p, decPath)) return deny(`no write access to ${decPath}`);
        const cur = await getFile(env, decPath);
        let content = cur ? cur.content.replace(/\n*$/, '\n') : '';
        for (const dec of decs) content += decisionBlock(dec.decision, dec.rationale, args.project ? slug : '', date);
        files.push({ path: decPath, content });
      }

      // 3. topic notes — full replace
      const seenTopics = new Set();
      for (const t of Array.isArray(args.topics) ? args.topics : []) {
        const tslug = String(t?.slug || '').trim().replace(/^vault\//, '').replace(/^topics\//, '').replace(/\.md$/, '');
        if (!tslug || seenTopics.has(tslug)) continue;
        seenTopics.add(tslug);
        const tPath = `vault/topics/${tslug}.md`;
        if (!allowed(p, tPath)) return deny(`no write access to ${tPath}`);
        files.push({ path: tPath, content: topicNote({ slug: tslug, title: t.title, content: t.content, date }) });
      }

      // 4. project note frontmatter patch
      const pu = args.project_update;
      if (pu && !args.project) {
        skipped.push('project_update ignored — no project given, so there is no project note to patch');
      } else if (pu && (pu.status != null || pu.next != null)) {
        const projPath = `vault/projects/${slug}.md`;
        if (!allowed(p, projPath)) return deny(`no write access to ${projPath}`);
        const cur = await getFile(env, projPath);
        if (!cur) {
          skipped.push(`${projPath} — project note does not exist, not created`);
        } else {
          const patched = patchProjectNote(cur.content, { status: pu.status, next: pu.next, date });
          if (!patched) skipped.push(`${projPath} — no YAML frontmatter to patch`);
          else files.push({ path: projPath, content: patched });
        }
      }

      const message = `save(${surface}): ${slug} — ${yamlStr(args.summary).slice(0, 72)}`;
      const commit = await multiCommit(env, files, message);
      for (const f of files) await upsertLocal(env, f.path, f.content);
      return { ok: true, commit, files: files.map((f) => f.path), ...(skipped.length ? { skipped } : {}) };
    }

    case 'check_brain':
      return computeHygiene(env, p);

    case 'list_skills': {
      const [skills, configText] = await Promise.all([skillCatalog(env, p), readSkillsConfig(env)]);
      return { skills, mappings: skillsConfigEntries(configText).entries };
    }

    case 'get_skill': {
      if (!allowed(p, `skills/${args.name}/SKILL.md`)) return deny(`no access to skill ${args.name}`);
      const r = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`skills/${args.name}/SKILL.md`).first();
      if (!r) return { error: `no skill named ${args.name}` };
      return { name: args.name, skill: r.body };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- MCP JSON-RPC

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(env, msg, principal) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'brain-mcp', title: 'ClaudeBrain Vault', version: '2.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await callTool(env, params.name, params.arguments || {}, principal);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      if (method?.startsWith('notifications/')) return null; // acknowledged, no response
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- auth + webhook

async function getPrincipal(req, env) {
  const h = req.headers.get('Authorization') || '';
  return resolvePrincipal(env, h.replace(/^Bearer\s+/i, ''));
}

// ---------------------------------------------------------------- telemetry

const INGEST_BATCH_CAP = 500;
const INGEST_PAYLOAD_CAP = 8000;

/** Buffer a batch of redacted tool-call records into D1. */
async function ingestToolCalls(env, records) {
  const capped = records.slice(0, INGEST_BATCH_CAP);
  const stmts = capped.map((r) => {
    const ts = String(r?.ts || new Date().toISOString());
    const day = /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : nowDate();
    return env.DB.prepare(
      'INSERT INTO tool_calls (session, day, ts, surface, cwd, project, tool, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      sessionKey(r?.session) || 'unknown',
      day,
      ts.slice(0, 40),
      String(r?.surface || '').slice(0, 40),
      String(r?.cwd || '').slice(0, 300),
      normalizeProject(String(r?.project || '')).slice(0, 64),
      String(r?.tool || '').slice(0, 64),
      JSON.stringify(r).slice(0, INGEST_PAYLOAD_CAP)
    );
  });
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return { ingested: capped.length, dropped: records.length - capped.length };
}

/**
 * Drain every completed day out of the D1 buffer into R2, one object per
 * session per day. Runs on the nightly cron; safe to run by hand.
 */
async function rollUpToolCalls(env) {
  if (!env.LOGS) return { skipped: 'no R2 binding' };
  const today = nowDate();
  const rows = (
    await env.DB.prepare('SELECT session, day, payload FROM tool_calls WHERE day < ? ORDER BY day, session, id')
      .bind(today).all()
  ).results;
  if (!rows.length) return { rolled: 0, objects: 0 };

  const groups = new Map();
  for (const r of rows) {
    const k = `${r.day}/${r.session}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.payload);
  }
  for (const [k, lines] of groups) {
    const key = `tool-calls/${k}.jsonl`;
    // R2 has no append; a session that spanned a roll-up boundary already has
    // an object, so read it back and rewrite. These are tens of KB.
    const prev = await env.LOGS.get(key);
    const head = prev ? (await prev.text()).replace(/\n*$/, '\n') : '';
    await env.LOGS.put(key, `${head}${lines.join('\n')}\n`, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
  }
  await env.DB.prepare('DELETE FROM tool_calls WHERE day < ?').bind(today).run();
  return { rolled: rows.length, objects: groups.size };
}

async function verifyWebhook(req, env, rawBody) {
  const sig = req.headers.get('X-Hub-Signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- entrypoints

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // OAuth 2.1 layer for claude.ai connectors (discovery, DCR, PKCE, consent)
    const oauthRes = await handleOauth(req, env, url);
    if (oauthRes) return oauthRes;

    // Browser UI: login + note browser + link graph
    const appRes = await handleApp(req, env, url);
    if (appRes) return appRes;

    if (url.pathname === '/health') {
      const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM notes').first().catch(() => ({ c: -1 }));
      const meta = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_full_reindex'").first().catch(() => null);
      const hyg = await env.DB.prepare("SELECT v FROM meta WHERE k = 'hygiene'").first().catch(() => null);
      let unsaved_sessions = null;
      try {
        const h = hyg?.v ? JSON.parse(hyg.v) : null;
        if (h) unsaved_sessions = h.unsaved_total ?? h.unsaved_sessions?.length ?? null;
      } catch { /* stale/corrupt snapshot — report null */ }
      const rollup = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_rollup'").first().catch(() => null);
      const buffered = await env.DB.prepare('SELECT COUNT(*) AS c FROM tool_calls').first().catch(() => ({ c: -1 }));
      return Response.json({
        ok: true,
        notes: n.c,
        last_full_reindex: meta?.v || null,
        unsaved_sessions,
        hook_version: HOOK_VERSION,
        telemetry: { buffered: buffered.c, last_rollup: rollup?.v ? JSON.parse(rollup.v) : null },
      });
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await req.text();
      if (!(await verifyWebhook(req, env, raw))) return new Response('bad signature', { status: 401 });
      const event = req.headers.get('X-GitHub-Event');
      if (event !== 'push') return Response.json({ ok: true, ignored: event });
      const payload = JSON.parse(raw);
      if (payload.ref !== `refs/heads/${env.BRANCH}`) return Response.json({ ok: true, ignored: payload.ref });
      const changed = new Set(); const removed = new Set();
      for (const c of payload.commits || []) {
        for (const p of [...(c.added || []), ...(c.modified || [])]) if (isIndexable(p)) { changed.add(p); removed.delete(p); }
        for (const p of c.removed || []) if (isIndexable(p)) { removed.add(p); changed.delete(p); }
      }
      const work = async () => {
        await deleteNotes(env, [...removed]);
        const list = [...changed];
        if (list.length > 40) {
          await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('needs_reindex', datetime('now'))").run();
          await indexFromGitHub(env, list.slice(0, 40));
        } else {
          await indexFromGitHub(env, list);
        }
      };
      ctx.waitUntil(work());
      return Response.json({ ok: true, queued: changed.size, removed: removed.size });
    }

    // Self-extracting installer for the skills library:
    //   curl -fsSL -H "Authorization: Bearer $KEY" https://brain.yashlunawat.com/skills/install.sh | sh
    // Installs every skill the key can read into $SKILLS_DEST (default ~/.claude/skills).
    if (url.pathname === '/skills/install.sh' && req.method === 'GET') {
      const p = await getPrincipal(req, env);
      if (!p) return new Response('unauthorized', { status: 401 });
      try {
        const tar = await fetchRepoTar(env);
        const files = [];
        const skillNames = new Set();
        for (const e of tarEntries(tar)) {
          if (!e.path.startsWith('skills/') || e.path.endsWith('/.skillsync')) continue;
          if (!allowed(p, e.path)) continue;
          const rel = e.path.slice('skills/'.length);
          if (!rel || rel === 'mappings.yaml') continue;
          files.push({ rel, body: e.text() });
          skillNames.add(rel.split('/')[0]);
        }
        const lines = [
          '#!/bin/sh',
          '# generated by BrainMCP — installs the brain skills library onto this machine',
          'set -eu',
          ': "${SKILLS_DEST:=$HOME/.claude/skills}"',
          'if printf QQ== | base64 -d >/dev/null 2>&1; then B64D=-d; else B64D=-D; fi',
          `echo "Installing ${skillNames.size} skills (${files.length} files) into $SKILLS_DEST"`,
        ];
        for (const f of files) {
          const dir = f.rel.slice(0, f.rel.lastIndexOf('/'));
          if (dir) lines.push(`mkdir -p "$SKILLS_DEST/${dir}"`);
          lines.push(`base64 $B64D > "$SKILLS_DEST/${f.rel}" <<'B64_EOF'`, encodeBase64(f.body), 'B64_EOF');
          if (f.rel.endsWith('.sh')) lines.push(`chmod +x "$SKILLS_DEST/${f.rel}"`);
        }
        lines.push(`echo "Done: ${[...skillNames].sort().join(' ')}"`, '');
        return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8' } });
      } catch (e) {
        return new Response(`echo "install.sh generation failed: ${e.message}" >&2; exit 1\n`, { status: 500, headers: { 'Content-Type': 'text/x-shellscript' } });
      }
    }

    // Tool-call telemetry from the PostToolUse hook. Records arrive already
    // redacted by the hook; this is a buffer, not a scrubber.
    if (url.pathname === '/ingest/tool-calls' && req.method === 'POST') {
      const p = await getPrincipal(req, env);
      if (!p) return new Response('unauthorized', { status: 401 });
      if (!canWrite(p)) return Response.json({ error: 'key is read-only' }, { status: 403 });
      const body = await req.json().catch(() => null);
      const records = Array.isArray(body?.records) ? body.records : null;
      if (!records) return Response.json({ error: 'records[] required' }, { status: 400 });
      try {
        return Response.json({ ok: true, ...(await ingestToolCalls(env, records)) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === '/admin/rollup' && req.method === 'POST') {
      const p = await getPrincipal(req, env);
      if (!isAdmin(p)) return new Response('unauthorized', { status: 401 });
      try {
        return Response.json({ ok: true, ...(await rollUpToolCalls(env)) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // The one hook a machine still needs: PostToolUse telemetry.
    //   curl -fsSL -H "Authorization: Bearer $KEY" https://<host>/hooks/install.sh | BRAIN_KEY=$KEY sh
    if (url.pathname === '/hooks/install.sh' && req.method === 'GET') {
      const p = await getPrincipal(req, env);
      if (!p) return new Response('unauthorized', { status: 401 });
      return new Response(hookInstaller(url.origin), {
        headers: {
          'Content-Type': 'text/x-shellscript; charset=utf-8',
          'X-Brain-Hook-Version': HOOK_VERSION,
        },
      });
    }

    if (url.pathname === '/admin/reindex' && req.method === 'POST') {
      const p = await getPrincipal(req, env);
      if (!isAdmin(p)) return new Response('unauthorized', { status: 401 });
      try {
        const n = await fullReindex(env);
        return Response.json({ ok: true, indexed: n });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'GET') return new Response('SSE not offered; POST JSON-RPC here', { status: 405 });
      if (req.method === 'DELETE') return new Response(null, { status: 200 });
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const principal = await getPrincipal(req, env);
      if (!principal) {
        return Response.json(rpcError(null, -32000, 'unauthorized'), {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` },
        });
      }
      let body;
      try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, 'parse error'), { status: 400 }); }
      const msgs = Array.isArray(body) ? body : [body];
      const replies = [];
      for (const m of msgs) {
        const r = await handleRpc(env, m, principal);
        if (r !== null && m.id !== undefined) replies.push(r);
      }
      if (!replies.length) return new Response(null, { status: 202 });
      return Response.json(Array.isArray(body) ? replies : replies[0]);
    }

    return new Response('BrainMCP. Endpoints: POST /mcp, POST /webhook, POST /ingest/tool-calls, POST /admin/reindex, POST /admin/rollup, GET /health, GET /skills/install.sh, GET /hooks/install.sh', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const work = async () => {
      await fullReindex(env);
      // hygiene snapshot over the whole brain (unscoped), surfaced by /health
      const hygiene = await computeHygiene(env, { role: 'admin', prefixes: [] });
      await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('hygiene', ?)")
        .bind(JSON.stringify(hygiene)).run();
      // telemetry: drain completed days out of D1 into R2. Isolated so a
      // failure here never costs us the reindex above.
      try {
        const r = await rollUpToolCalls(env);
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_rollup', ?)")
          .bind(JSON.stringify({ at: new Date().toISOString(), ...r })).run();
      } catch (e) {
        console.log('tool-call rollup failed:', e.message);
      }
    };
    ctx.waitUntil(work().catch((e) => console.log('nightly reindex failed:', e.message)));
  },
};
