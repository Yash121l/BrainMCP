// BrainMCP — the ClaudeBrain vault as an MCP server on Cloudflare Workers.
// git (GitHub repo) is the source of truth; D1 is a disposable accelerator index.
// Streamable-HTTP MCP (JSON-RPC over POST /mcp), bearer-token auth, webhook ingest.

import { parseNote, isIndexable, normalizeProject } from './parse.js';
import { getFile, putFile, appendFile, multiCommit, fetchRepoTar, tarEntries } from './github.js';

// ---------------------------------------------------------------- indexing

async function upsertNotes(env, parsed) {
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

async function deleteNotes(env, paths) {
  const stmts = [];
  for (const p of paths) {
    stmts.push(env.DB.prepare('DELETE FROM notes WHERE path = ?').bind(p));
    stmts.push(env.DB.prepare('DELETE FROM links WHERE src = ?').bind(p));
    stmts.push(env.DB.prepare('DELETE FROM fts WHERE path = ?').bind(p));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

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

function ftsQuery(q) {
  // sanitize to phrase-per-token to avoid FTS5 syntax errors on user input
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

async function upsertLocal(env, path, content) {
  if (isIndexable(path)) await upsertNotes(env, [parseNote(path, content)]);
}

// ---------------------------------------------------------------- MCP tools

const TOOLS = [
  {
    name: 'get_context',
    description:
      'Session bootstrap: NOW.md, active projects table, and — when a project slug is given — that project\'s BINDING rules file in full, its project note, recent decisions and sessions. Call this first in any cloud session.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'project slug, e.g. "pulse"' } },
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
    description: 'Append a decision to vault/logs/decisions.md in the exact vault format (date, decision, project link, rationale). Use for real decisions only.',
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

async function callTool(env, name, args = {}) {
  switch (name) {
    case 'get_context': {
      const slug = normalizeProject(args.project || '');
      const out = {};
      const now = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/_activity/NOW.md').first();
      out.now = now?.body || null;
      const active = await env.DB.prepare(
        "SELECT path, project, status, updated, json_extract(frontmatter, '$.next') AS next FROM notes WHERE type = 'project' AND status = 'active' ORDER BY updated DESC"
      ).all();
      out.active_projects = active.results.map((r) => ({
        ...r, next: r.next ? String(r.next).slice(0, 400) + (String(r.next).length > 400 ? ' …[truncated — read_note for full]' : '') : null,
      }));
      if (slug) {
        const rules = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`vault/rules/${slug}.md`).first();
        out.binding_rules = rules ? rules.body : `(no rules/${slug}.md)`;
        const proj = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind(`vault/projects/${slug}.md`).first();
        out.project_note = proj ? proj.body : `(no projects/${slug}.md)`;
        const dec = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first();
        if (dec) {
          out.recent_decisions = dec.body.split('\n').filter((l) => l.startsWith('- **') && l.includes(`[[projects/${slug}]]`)).slice(-10);
        }
        const sess = await env.DB.prepare(
          "SELECT path, json_extract(frontmatter, '$.summary') AS summary, json_extract(frontmatter, '$.date') AS date FROM notes WHERE type = 'session' AND project = ? ORDER BY path DESC LIMIT 5"
        ).bind(slug).all();
        out.recent_sessions = sess.results;
      } else {
        const dec = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first();
        if (dec) out.recent_decisions = dec.body.split('\n').filter((l) => l.startsWith('- **')).slice(-10);
      }
      out.hint = 'Binding rules above are MANDATORY for this project. Write back at session end via append_session_log or save_session.';
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
      sql += ' ORDER BY rank LIMIT ?';
      binds.push(limit);
      const res = await env.DB.prepare(sql).bind(...binds).all();
      // dedupe by path keeping best-ranked snippet
      const seen = new Map();
      for (const r of res.results) if (!seen.has(r.path)) seen.set(r.path, r);
      return { results: [...seen.values()] };
    }

    case 'read_note': {
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
      binds.push(limit);
      const res = await env.DB.prepare(sql).bind(...binds).all();
      return { notes: res.results };
    }

    case 'backlinks': {
      const noExt = args.path.replace(/\.md$/, '');
      const noVault = noExt.replace(/^vault\//, '');
      const base = noExt.split('/').pop();
      const res = await env.DB.prepare('SELECT DISTINCT src FROM links WHERE dst IN (?, ?, ?)').bind(noExt, noVault, base).all();
      return { backlinks: res.results.map((r) => r.src) };
    }

    case 'links': {
      const res = await env.DB.prepare('SELECT dst FROM links WHERE src = ?').bind(args.path).all();
      return { links: res.results.map((r) => r.dst) };
    }

    case 'append_session_log': {
      const slug = normalizeProject(args.project || '');
      const d = nowDate(); const t = nowTime(); const id = `cloud${randId(4)}`;
      const path = `vault/logs/sessions/${d}_${t}_${id}.md`;
      const projLine = slug ? `"[[projects/${slug}]]"` : '""';
      const content = `---
type: session
project: ${projLine}
date: ${d}
started: ${new Date().toISOString()}
summary: "${(args.summary || '').replace(/"/g, "'")}"
duration:
surface: ${args.surface || 'cloud'}
session_key: ${id}
tags: [session, cloud]
---

# Cloud session ${d}

## What happened
${args.body}

## Next steps
${args.next_steps || '- (none)'}

## Links
- Project: ${slug ? `[[projects/${slug}]]` : '(none)'}
`;
      await putFile(env, path, content, `session(${args.surface || 'cloud'}): ${slug || 'general'} — ${(args.summary || '').slice(0, 60)}`);
      await upsertLocal(env, path, content);
      return { ok: true, path, committed: true };
    }

    case 'log_decision': {
      const slug = normalizeProject(args.project);
      const line = `- **${nowDate()}** — ${args.decision.trim()} (project:: [[projects/${slug}]]) — _${args.rationale.trim()}_\n`;
      const full = await appendFile(env, 'vault/logs/decisions.md', line, `decision(${slug}): ${args.decision.slice(0, 60)}`);
      await upsertLocal(env, 'vault/logs/decisions.md', full);
      return { ok: true, appended: line.trim() };
    }

    case 'update_note': {
      const existing = await getFile(env, args.path);
      await putFile(env, args.path, args.content, args.message || `update: ${args.path}`, existing?.sha);
      await upsertLocal(env, args.path, args.content);
      return { ok: true, path: args.path, created: !existing };
    }

    case 'save_session': {
      if (!Array.isArray(args.files) || !args.files.length) return { error: 'files[] required' };
      const sha = await multiCommit(env, args.files, args.message);
      for (const f of args.files) await upsertLocal(env, f.path, f.content);
      return { ok: true, commit: sha, files: args.files.map((f) => f.path) };
    }

    case 'list_skills': {
      const res = await env.DB.prepare(
        "SELECT path, json_extract(frontmatter, '$.name') AS name, json_extract(frontmatter, '$.description') AS description FROM notes WHERE path LIKE 'skills/%/SKILL.md' ORDER BY path"
      ).all();
      const mappings = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('skills/mappings.md').first();
      return { skills: res.results, mappings: 'skills/mappings.yaml in repo Yash121l/brain' };
    }

    case 'get_skill': {
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

async function handleRpc(env, msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'brain-mcp', title: 'ClaudeBrain Vault', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await callTool(env, params.name, params.arguments || {});
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

function authorized(req, env) {
  const h = req.headers.get('Authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token || !env.BRAIN_TOKEN || token.length !== env.BRAIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.BRAIN_TOKEN.charCodeAt(i);
  return diff === 0;
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

    if (url.pathname === '/health') {
      const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM notes').first().catch(() => ({ c: -1 }));
      const meta = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_full_reindex'").first().catch(() => null);
      return Response.json({ ok: true, notes: n.c, last_full_reindex: meta?.v || null });
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

    if (url.pathname === '/admin/reindex' && req.method === 'POST') {
      if (!authorized(req, env)) return new Response('unauthorized', { status: 401 });
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
      if (!authorized(req, env)) {
        return Response.json(rpcError(null, -32000, 'unauthorized'), { status: 401 });
      }
      let body;
      try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, 'parse error'), { status: 400 }); }
      const msgs = Array.isArray(body) ? body : [body];
      const replies = [];
      for (const m of msgs) {
        const r = await handleRpc(env, m);
        if (r !== null && m.id !== undefined) replies.push(r);
      }
      if (!replies.length) return new Response(null, { status: 202 });
      return Response.json(Array.isArray(body) ? replies : replies[0]);
    }

    return new Response('BrainMCP. Endpoints: POST /mcp, POST /webhook, POST /admin/reindex, GET /health', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fullReindex(env).catch((e) => console.log('nightly reindex failed:', e.message)));
  },
};
