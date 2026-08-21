// JSON API + session login behind the browser UI. The UI itself is a React SPA
// (see ui/) served from Workers static assets at /, so everything here is data:
// POST /app/login mints the brain_session cookie, /app/api/* serves notes,
// search, graph, backlinks and (admin only) key management. Notes are read-only
// here — writes go through git/MCP.

import { resolvePrincipal, allowed, isAdmin, canWrite, createKey, listKeys, revokeKey, sha256hex, randToken } from './auth.js';
import { getFile, putFile } from './github.js';
import { skillCatalog, readSkillsConfig, skillsConfigEntries, renderSkillsConfig } from './skills.js';
import { upsertLocal } from './indexer.js';

async function sessionPrincipal(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/brain_session=([^;]+)/);
  if (!m) return null;
  return resolvePrincipal(env, m[1]);
}

// ---------------------------------------------------------------- hygiene report
// Lives here (rather than in index.js) so index.js -> app.js stays a one-way import:
// it is shared by the `check_brain` MCP tool, GET /app/api/check and the cron job.

/** Whole days between a YYYY-MM-DD(THH:MM:SSZ) string and now. null when unparseable. */
function daysAgo(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(String(dateStr).trim().slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}

const UNSAVED_CAP = 25;
const BROKEN_LINKS_CAP = 50;

/**
 * Vault hygiene snapshot, scoped to the principal's readable prefixes.
 * Pass { role: 'admin', prefixes: [] } for the unscoped/cron view.
 */
export async function computeHygiene(env, p) {
  const [notesRow, linksRow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM notes').first(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM links').first(),
  ]);

  // ---- sessions: unsaved (no summary, older than a day) + activity in the last 7 days
  const sessions = (
    await env.DB.prepare(
      `SELECT path, project, json_extract(frontmatter, '$.summary') AS summary,
              COALESCE(json_extract(frontmatter, '$.date'), updated) AS date
         FROM notes WHERE type = 'session'`
    ).all()
  ).results.filter((r) => allowed(p, r.path));

  let sessions_7d = 0;
  const unsaved = [];
  for (const s of sessions) {
    const age = daysAgo(s.date);
    if (age !== null && age <= 7) sessions_7d++;
    const summary = (s.summary == null ? '' : String(s.summary)).trim();
    if (!summary && age !== null && age > 1) {
      unsaved.push({ path: s.path, date: s.date || null, project: s.project || null });
    }
  }
  unsaved.sort(
    (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.path).localeCompare(String(a.path))
  );

  // ---- active projects that have gone quiet
  const projects = (
    await env.DB.prepare("SELECT path, project, updated FROM notes WHERE type = 'project' AND status = 'active'").all()
  ).results.filter((r) => allowed(p, r.path));
  const stale_active_projects = projects
    .filter((r) => {
      const age = daysAgo(r.updated);
      return age === null || age > 14; // missing/unparseable `updated:` counts as stale
    })
    .map((r) => ({
      path: r.path,
      project: r.project || r.path.split('/').pop().replace(/\.md$/, ''),
      updated: r.updated || null,
    }))
    .sort((a, b) => String(a.updated || '').localeCompare(String(b.updated || '')));

  // ---- decisions
  let decisions_total = 0;
  if (allowed(p, 'vault/logs/decisions.md')) {
    const d = await env.DB.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first();
    if (d?.body) decisions_total = (d.body.match(/### \[/g) || []).length;
  }

  // ---- broken wikilinks (resolved the same way the graph endpoint resolves them)
  const allNotes = (await env.DB.prepare('SELECT path FROM notes').all()).results;
  const byNoExt = new Map();
  const byBase = new Map();
  for (const n of allNotes) {
    const ne = n.path.replace(/\.md$/, '');
    byNoExt.set(ne, n.path);
    const b = ne.split('/').pop();
    if (!byBase.has(b)) byBase.set(b, n.path);
  }
  const links = (await env.DB.prepare('SELECT src, dst FROM links').all()).results;
  const broken = [];
  for (const l of links) {
    const dst = String(l.dst || '');
    if (!dst || dst.includes('#')) continue; // heading-only / in-note anchors aren't notes
    if (!allowed(p, l.src)) continue;
    const target = byNoExt.get(dst) || byNoExt.get(`vault/${dst}`) || byBase.get(dst.split('/').pop());
    if (!target) broken.push({ src: l.src, dst });
  }

  return {
    generated_at: new Date().toISOString(),
    counts: {
      notes: notesRow?.c ?? 0,
      links: linksRow?.c ?? 0,
      sessions_7d,
      decisions_total,
    },
    unsaved_sessions: unsaved.slice(0, UNSAVED_CAP),
    unsaved_total: unsaved.length,
    stale_active_projects,
    broken_links: broken.slice(0, BROKEN_LINKS_CAP),
    broken_links_total: broken.length,
  };
}

export async function handleApp(req, env, url) {
  if (!url.pathname.startsWith('/app')) return null;

  if (url.pathname === '/app/login' && req.method === 'POST') {
    const form = await req.formData();
    const principal = await resolvePrincipal(env, form.get('access_key') || '');
    if (!principal) return new Response('invalid or revoked key', { status: 403 });
    const tok = randToken(32);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'webapp', datetime('now', '+30 days'), ?, ?, ?)"
    ).bind(await sha256hex(tok), principal.role, JSON.stringify(principal.prefixes), principal.keyId || null).run();
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `brain_session=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      },
    });
  }

  // The UI moved to the SPA at the root; keep the old entrypoint as a redirect.
  if (url.pathname === '/app' || url.pathname === '/app/') {
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }

  const p = await sessionPrincipal(req, env);

  if (url.pathname.startsWith('/app/api/')) {
    if (!p) return Response.json({ error: 'unauthorized' }, { status: 401 });

    if (url.pathname === '/app/api/me') {
      return Response.json({ role: p.role, name: p.name, prefixes: p.prefixes });
    }
    if (url.pathname === '/app/api/notes') {
      const r = await env.DB.prepare('SELECT path, title, type FROM notes ORDER BY path').all();
      return Response.json({ notes: r.results.filter((n) => allowed(p, n.path)) });
    }
    if (url.pathname === '/app/api/note') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ error: 'forbidden' }, { status: 403 });
      const r = await env.DB.prepare('SELECT path, body, frontmatter FROM notes WHERE path = ?').bind(path).first();
      if (!r) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ path: r.path, content: r.body, frontmatter: JSON.parse(r.frontmatter || '{}') });
    }
    if (url.pathname === '/app/api/backlinks') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ backlinks: [] });
      const noExt = path.replace(/\.md$/, '');
      const noVault = noExt.replace(/^vault\//, '');
      const base = noExt.split('/').pop();
      const r = await env.DB.prepare('SELECT DISTINCT src FROM links WHERE dst IN (?, ?, ?)').bind(noExt, noVault, base).all();
      return Response.json({ backlinks: r.results.map((x) => x.src).filter((s) => allowed(p, s)) });
    }
    if (url.pathname === '/app/api/search') {
      const q = (url.searchParams.get('q') || '').split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (!q) return Response.json({ results: [] });
      const r = await env.DB.prepare(
        "SELECT DISTINCT f.path, snippet(fts, 3, '<b>', '</b>', ' … ', 20) AS snippet FROM fts f WHERE fts MATCH ? ORDER BY rank LIMIT 60"
      ).bind(q).all().catch(() => ({ results: [] }));
      return Response.json({ results: r.results.filter((x) => allowed(p, x.path)).slice(0, 20) });
    }
    if (url.pathname === '/app/api/graph') {
      const notes = (await env.DB.prepare('SELECT path, title, type FROM notes').all()).results.filter((n) => allowed(p, n.path));
      const visible = new Set(notes.map((n) => n.path));
      const links = (await env.DB.prepare('SELECT src, dst FROM links').all()).results;
      const byNoExt = new Map(); const byBase = new Map();
      for (const n of notes) {
        const ne = n.path.replace(/\.md$/, '');
        byNoExt.set(ne, n.path);
        const b = ne.split('/').pop();
        if (!byBase.has(b)) byBase.set(b, n.path);
      }
      const edges = [];
      for (const l of links) {
        if (!visible.has(l.src)) continue;
        const t = byNoExt.get(l.dst) || byNoExt.get(`vault/${l.dst}`) || byBase.get(l.dst.split('/').pop());
        if (t && t !== l.src && visible.has(t)) edges.push({ source: l.src, target: t });
      }
      return Response.json({ nodes: notes.map((n) => ({ id: n.path, title: n.title, type: n.type || 'note' })), links: edges });
    }
    if (url.pathname === '/app/api/check') {
      return Response.json(await computeHygiene(env, p));
    }

    // ---- always-on skills: which skills bind to which project (vault/skills.md)
    const SKILLS_PATH = 'vault/skills.md';

    if (url.pathname === '/app/api/skills' && req.method === 'GET') {
      const [catalog, configText] = await Promise.all([skillCatalog(env, p), readSkillsConfig(env)]);
      const { entries } = skillsConfigEntries(configText);
      return Response.json({
        catalog,
        entries,
        inherits_default: entries.filter((e) => e.inherits_default).map((e) => e.project),
        editable: canWrite(p) && allowed(p, SKILLS_PATH),
      });
    }

    if (url.pathname === '/app/api/skills' && req.method === 'PUT') {
      if (!canWrite(p) || !allowed(p, SKILLS_PATH)) {
        return Response.json({ error: 'no write access to vault/skills.md' }, { status: 403 });
      }
      const body = await req.json().catch(() => ({}));
      if (!Array.isArray(body.entries)) return Response.json({ error: 'entries[] required' }, { status: 400 });
      if (!body.entries.some((e) => e?.project === 'default')) {
        return Response.json({ error: 'a "default" row is required — it is the fallback for every session' }, { status: 400 });
      }
      const existing = await getFile(env, SKILLS_PATH);
      const { header } = skillsConfigEntries(existing?.content || '');
      const content = renderSkillsConfig(header, body.entries);
      const sha = await putFile(env, SKILLS_PATH, content, 'skills: update project mappings (web UI)', existing?.sha);
      await upsertLocal(env, SKILLS_PATH, content);
      return Response.json({ ok: true, commit: sha });
    }

    // ---- key management (admin only)
    if (url.pathname === '/app/api/keys' && req.method === 'GET') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      return Response.json({ keys: await listKeys(env) });
    }
    if (url.pathname === '/app/api/keys' && req.method === 'POST') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      try {
        const created = await createKey(env, body);
        return Response.json(created, { status: 201 });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }
    if (url.pathname === '/app/api/keys/revoke' && req.method === 'POST') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      if (!body.id) return Response.json({ error: 'id required' }, { status: 400 });
      await revokeKey(env, body.id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'unknown api' }, { status: 404 });
  }

  return new Response('not found', { status: 404 });
}
