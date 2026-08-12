// JSON API + session login behind the browser UI. The UI itself is a React SPA
// (see ui/) served from Workers static assets at /, so everything here is data:
// POST /app/login mints the brain_session cookie, /app/api/* serves notes,
// search, graph, backlinks and (admin only) key management. Notes are read-only
// here — writes go through git/MCP.

import { resolvePrincipal, allowed, isAdmin, createKey, listKeys, revokeKey, sha256hex, randToken } from './auth.js';

async function sessionPrincipal(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/brain_session=([^;]+)/);
  if (!m) return null;
  return resolvePrincipal(env, m[1]);
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
