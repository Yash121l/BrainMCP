// JSON API + session login behind the browser UI. The UI itself is a React SPA
// (see ui/) served from Workers static assets at /, so everything here is data:
// POST /app/login mints the brain_session cookie.

import { resolvePrincipal, isHumanSession, allowed, isRootAdmin, canWrite, canWritePath, createKey, listKeys, updateKey, revokeKey, isProjectSlug, sha256hex, randToken, roleWithoutSuper } from './auth.js';
import { skillCatalog, skillsConfigEntries, renderSkillsConfig, validateSkillEntries, visibleEntries } from './skills.js';
import { PROJECT_NOTE_PATH } from './parse.js';
import { spacePrincipal, spaceByHandle, accessibleSpaces, allSpaces, defaultSpace } from './tenancy.js';
import { spaceStore } from './store.js';
import { auditInBackground } from './audit.js';
import { ensureSchema } from './schema.js';

const superSpace = (env) => env.DB.prepare(
  `SELECT s.*, u.handle AS owner_handle FROM spaces s JOIN users u ON u.id = s.owner_id
    WHERE u.is_super = 1 AND s.kind = 'personal' AND s.backing = 'git' AND s.status = 'active' ORDER BY s.created LIMIT 1`
).first();

export const sessionCookie = (req) => (req.headers.get('Cookie') || '').match(/(?:^|;\s*)brain_session=([^;]+)/)?.[1] || null;

/** Only a session minted by /app/login counts: a raw key pasted into the cookie is not a session. */
async function sessionPrincipal(req, env) {
  const tok = sessionCookie(req);
  const p = tok ? await resolvePrincipal(env, tok) : null;
  return isHumanSession(p) ? p : null;
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
const AREA_MIN_NOTES = 10;
const BROKEN_LINKS_CAP = 50;

/**
 * Vault hygiene snapshot, scoped to the principal's readable prefixes.
 * Pass { role: 'admin', prefixes: [] } for the unscoped/cron view.
 */
export async function computeHygiene(db, p) {
  // ---- sessions: unsaved (no summary, older than a day) + activity in the last 7 days
  const sessions = (
    await db.prepare(
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
    await db.prepare("SELECT path, project, updated FROM notes WHERE type = 'project' AND status = 'active'").all()
  ).results.filter((r) => PROJECT_NOTE_PATH.test(r.path) && allowed(p, r.path));
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
    const d = await db.prepare('SELECT body FROM notes WHERE path = ?').bind('vault/logs/decisions.md').first();
    if (d?.body) decisions_total = (d.body.match(/### \[/g) || []).length;
  }

  // ---- broken wikilinks (resolved the same way the graph endpoint resolves them).
  // Only readable notes resolve a link, so an out-of-scope target reads as missing.
  const allNotes = (await db.prepare('SELECT path FROM notes').all()).results.filter((n) => allowed(p, n.path));
  const byNoExt = new Map();
  const byBase = new Map();
  for (const n of allNotes) {
    const ne = n.path.replace(/\.md$/, '');
    byNoExt.set(ne, n.path);
    const b = ne.split('/').pop();
    if (!byBase.has(b)) byBase.set(b, n.path);
  }
  const links = (await db.prepare('SELECT src, dst FROM links').all()).results.filter((l) => allowed(p, l.src));
  const broken = [];
  for (const l of links) {
    const dst = String(l.dst || '');
    if (!dst || dst.includes('#')) continue; // heading-only / in-note anchors aren't notes
    const target = byNoExt.get(dst) || byNoExt.get(`vault/${dst}`) || byBase.get(dst.split('/').pop());
    if (!target) broken.push({ src: l.src, dst: dst.length > 120 ? `${dst.slice(0, 120)}…` : dst });
  }

  return {
    generated_at: new Date().toISOString(),
    counts: {
      notes: allNotes.length,
      links: links.length,
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

function rejectCrossOrigin(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const origin = req.headers.get('Origin');
  const site = req.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || site === 'cross-site') return Response.json({ error: 'cross-origin request refused' }, { status: 403 });
  return null;
}

const accessOf = (pv) => (pv.via === 'member' ? pv.memberRole : pv.via);

async function spaceList(env, principal) {
  const spaces = principal.super ? await allSpaces(env) : await accessibleSpaces(env, principal);
  const out = [];
  for (const s of spaces) {
    const pv = await spacePrincipal(env, principal, s);
    if (pv) out.push({ handle: `@${s.handle}`, kind: s.kind, backing: s.backing, owner: `@${s.owner_handle}`, access: accessOf(pv) });
  }
  return out;
}

export async function handleApp(req, env, url, ctx, callTool = null) {
  if (!url.pathname.startsWith('/app')) return null;
  await ensureSchema(env);

  if (url.pathname === '/app/login' && req.method === 'POST') {
    const crossSite = rejectCrossOrigin(req, url);
    if (crossSite) return crossSite;
    const form = await req.formData();
    const principal = await resolvePrincipal(env, form.get('access_key') || '');
    if (!principal) return new Response('invalid or revoked key', { status: 403 });
    if (!principal.keyId) return new Response('this credential cannot open a web session', { status: 403 });
    // The console approves agents' calls, so an agent's own credential must not open it:
    // not a key bound to a machine or agent, and not a connector token.
    if (principal.via === 'oauth' && principal.name !== 'webapp') return new Response('a connector token cannot open a web session; sign in with your access key', { status: 403 });
    if (principal.machineId || principal.agent) return new Response('this key belongs to an agent on a machine and cannot open the console; sign in with your own access key', { status: 403 });
    const tok = randToken(32);
    // A session never outlives the key it was minted from.
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'webapp',
         min(datetime('now', '+30 days'), coalesce(datetime(?), datetime('now', '+30 days'))), ?, ?, ?)`
    ).bind(await sha256hex(tok), principal.expires || null, principal.super ? 'super' : roleWithoutSuper(principal.role), JSON.stringify(principal.scopes ?? []), principal.keyId || null).run();
    auditInBackground({ env, ctx, p: principal }, 'session.login', { detail: principal.super ? 'web, super' : 'web' });
    const keyLeft = principal.expires ? Math.floor((Date.parse(principal.expires.replace(' ', 'T') + 'Z') - Date.now()) / 1000) : NaN;
    const maxAge = Number.isFinite(keyLeft) ? Math.max(0, Math.min(2592000, keyLeft)) : 2592000;
    // Secure is mandatory everywhere except loopback, where `wrangler dev` serves
    // plain http and a Secure cookie would be dropped, making the UI unusable locally.
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `brain_session=${tok}; HttpOnly;${loopback ? '' : ' Secure;'} SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      },
    });
  }

  if (url.pathname === '/app/logout' && req.method === 'POST') {
    const crossOrigin = rejectCrossOrigin(req, url);
    if (crossOrigin) return crossOrigin;
    const tok = sessionCookie(req);
    if (tok) await env.DB.prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = 'webapp'").bind(await sha256hex(tok)).run();
    return new Response(null, { status: 204, headers: { 'Set-Cookie': 'brain_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
  }

  // The UI moved to the SPA at the root; keep the old entrypoint as a redirect.
  if (url.pathname === '/app' || url.pathname === '/app/') {
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }

  const principal = await sessionPrincipal(req, env);

  if (url.pathname.startsWith('/app/api/')) {
    if (!principal) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const crossOrigin = rejectCrossOrigin(req, url);
    if (crossOrigin) return crossOrigin;
    const R = { env, ctx, p: principal, url, sessionToken: sessionCookie(req) };

    if (url.pathname === '/app/api/tool' && req.method === 'POST' && callTool) {
      if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: principal.keyId || 'root' })).success) {
        return Response.json({ error: 'rate limited: too many calls from this key' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      const body = await req.json().catch(() => ({}));
      try {
        const result = await callTool(R, String(body.name || ''), body.args && typeof body.args === 'object' ? body.args : {});
        const error = result?.error ? String(result.error) : null;
        return Response.json(result, { status: !error ? 200 : error.startsWith('forbidden') ? 403 : 400 });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }

    const wanted = url.searchParams.get('space');
    const space = wanted ? await spaceByHandle(env, wanted) : (await defaultSpace(env, principal)) || (await superSpace(env));
    if (wanted && !space) return Response.json({ error: `no space ${wanted}` }, { status: 404 });
    const p = space ? await spacePrincipal(env, principal, space) : null;
    const S = p ? spaceStore(env, space, principal.user?.handle || null) : null;
    const db = S?.db;
    const crossed = (target) => {
      if ((p.via === 'share' || p.via === 'super') && space.owner_id !== principal.user?.id) {
        auditInBackground(R, `${p.via}.web_read`, { space_id: space.id, subject_user: space.owner_id, target });
      }
    };

    if (url.pathname === '/app/api/me') {
      const home = await superSpace(env);
      const homePv = home ? await spacePrincipal(env, principal, home) : null;
      const key = principal.keyId ? await env.DB.prepare('SELECT name FROM api_keys WHERE id = ?').bind(principal.keyId).first() : null;
      return Response.json({
        role: p ? p.role : 'none', name: key?.name || principal.name, prefixes: p ? (p.scopes ?? p.prefixes) : [],
        user: principal.user ? `@${principal.user.handle}` : null,
        user_id: principal.user?.id ?? null,
        super: !!principal.super,
        super_user: !!principal.user?.is_super,
        can_invite: !!principal.user?.can_invite,
        expires: principal.expires || null,
        root_admin: !!homePv && isRootAdmin(homePv) && isRootAdmin(principal),
        space: space ? `@${space.handle}` : null,
        access: p ? accessOf(p) : null,
        writable: !!p && canWrite(p),
        spaces: await spaceList(env, principal),
      });
    }
    if (!p) return Response.json({ error: 'this key has no access to this space' }, { status: 403 });
    if (url.pathname === '/app/api/notes') {
      const r = await db.prepare('SELECT path, title, type FROM notes ORDER BY path').all();
      crossed('notes');
      return Response.json({ notes: r.results.filter((n) => allowed(p, n.path)) });
    }
    if (url.pathname === '/app/api/note') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ error: 'forbidden' }, { status: 403 });
      const r = await db.prepare('SELECT path, body, frontmatter FROM notes WHERE path = ?').bind(path).first();
      if (!r) return Response.json({ error: 'not found' }, { status: 404 });
      crossed(path);
      return Response.json({ path: r.path, content: r.body, frontmatter: JSON.parse(r.frontmatter || '{}') });
    }
    if (url.pathname === '/app/api/backlinks') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ backlinks: [] });
      const noExt = path.replace(/\.md$/, '');
      const noVault = noExt.replace(/^vault\//, '');
      const base = noExt.split('/').pop();
      const r = await db.prepare('SELECT DISTINCT src FROM links WHERE dst IN (?, ?, ?)').bind(noExt, noVault, base).all();
      return Response.json({ backlinks: r.results.map((x) => x.src).filter((s) => allowed(p, s)) });
    }
    if (url.pathname === '/app/api/search') {
      const q = (url.searchParams.get('q') || '').split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (!q) return Response.json({ results: [] });
      // Scope goes into SQL so out-of-scope matches cannot crowd readable ones out of the
      // LIMIT window; same rule as allowed(): exact path, or below the prefix's folder.
      let sql = "SELECT DISTINCT f.path, snippet(fts, 3, '<b>', '</b>', ' … ', 20) AS snippet FROM fts f WHERE fts MATCH ?";
      const binds = [q];
      if (p.prefixes?.length) {
        sql += " AND EXISTS (SELECT 1 FROM json_each(?) j WHERE f.path = j.value OR substr(f.path, 1, length(rtrim(j.value, '/')) + 1) = rtrim(j.value, '/') || '/')";
        binds.push(JSON.stringify(p.prefixes));
      }
      const r = await db.prepare(sql + ' ORDER BY rank LIMIT 60').bind(...binds).all().catch(() => ({ results: [] }));
      crossed(`search: ${url.searchParams.get('q')}`);
      return Response.json({ results: r.results.filter((x) => allowed(p, x.path)).slice(0, 20) });
    }
    if (url.pathname === '/app/api/graph') {
      const notes = (await db.prepare('SELECT path, title, type FROM notes').all()).results.filter((n) => allowed(p, n.path));
      const visible = new Set(notes.map((n) => n.path));
      const links = (await db.prepare('SELECT src, dst FROM links').all()).results;
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
      crossed('graph');
      return Response.json({ nodes: notes.map((n) => ({ id: n.path, title: n.title, type: n.type || 'note' })), links: edges });
    }
    if (url.pathname === '/app/api/check') {
      crossed('check');
      return Response.json(await computeHygiene(db, p));
    }

    // ---- always-on skills: which skills bind to which project (vault/skills.md)
    const SKILLS_PATH = 'vault/skills.md';

    if (url.pathname === '/app/api/skills' && req.method === 'GET') {
      const [catalog, configText] = await Promise.all([skillCatalog(db, (name) => allowed(p, `skills/${name}/SKILL.md`)), S.readConfig()]);
      const entries = visibleEntries(p, skillsConfigEntries(configText).entries);
      return Response.json({
        catalog,
        entries,
        inherits_default: entries.filter((e) => e.inherits_default).map((e) => e.project),
        editable: canWritePath(p, SKILLS_PATH),
      });
    }

    if (url.pathname === '/app/api/skills' && req.method === 'PUT') {
      if (!canWritePath(p, SKILLS_PATH)) {
        return Response.json({ error: `no write access to vault/skills.md in @${space.handle}` }, { status: 403 });
      }
      const body = await req.json().catch(() => ({}));
      if (!Array.isArray(body.entries)) return Response.json({ error: 'entries[] required' }, { status: 400 });
      if (!body.entries.some((e) => e?.project === 'default')) {
        return Response.json({ error: 'a "default" row is required — it is the fallback for every session' }, { status: 400 });
      }
      const invalid = validateSkillEntries(body.entries);
      if (invalid) return Response.json({ error: invalid }, { status: 400 });
      const existing = await S.getFile(SKILLS_PATH);
      const content = renderSkillsConfig(existing?.content || '', body.entries);
      const sha = await S.commit([{ path: SKILLS_PATH, content }], 'skills: update project mappings (web UI)');
      auditInBackground(R, 'skills.set', { space_id: space.id, target: 'all rows', detail: 'web' });
      return Response.json({ ok: true, commit: sha });
    }

    // ---- the scope vocabulary the key editor offers: real projects and real folders,
    // so granting access is picking from the brain instead of typing paths.
    if (url.pathname === '/app/api/scopes' && req.method === 'GET') {
      if (!isRootAdmin(p) || !isRootAdmin(principal)) return Response.json({ error: 'admin only' }, { status: 403 });
      const notes = (await db.prepare('SELECT path, title, type, project, status FROM notes').all()).results;

      const perProject = new Map();
      const perArea = new Map();
      for (const n of notes) {
        if (n.project) perProject.set(n.project, (perProject.get(n.project) || 0) + 1);
        const dirs = n.path.split('/');
        dirs.pop();
        let acc = '';
        for (const d of dirs.slice(0, 2)) {
          acc += `${d}/`;
          perArea.set(acc, (perArea.get(acc) || 0) + 1);
        }
      }

      const projects = notes
        .filter((n) => n.type === 'project' && !n.path.startsWith('vault/templates/'))
        .map((n) => {
          const slug = n.project || n.path.split('/').pop().replace(/\.md$/, '');
          return {
            slug,
            title: n.title || slug,
            path: n.path,
            status: n.status || null,
            notes: perProject.get(slug) || 1,
          };
        })
        .filter((x) => isProjectSlug(x.slug)) // only slugs a scope can name
        .sort((a, b) => (a.status === 'active') === (b.status === 'active')
          ? a.slug.localeCompare(b.slug)
          : a.status === 'active' ? -1 : 1);

      // every top-level folder, plus the sub-folders big enough to be worth granting
      // on their own (skills/<one-skill>/ is noise; vault/logs/ is not)
      const areas = [...perArea.entries()]
        .filter(([prefix, count]) => prefix.split('/').length === 2 || count >= AREA_MIN_NOTES)
        .map(([prefix, count]) => ({ prefix, notes: count }))
        .sort((a, b) => a.prefix.localeCompare(b.prefix));

      return Response.json({ projects, areas, total_notes: notes.length });
    }

    // ---- key management (admin only)
    if (url.pathname === '/app/api/keys' && req.method === 'GET') {
      if (!isRootAdmin(p) || !isRootAdmin(principal)) return Response.json({ error: 'admin only' }, { status: 403 });
      return Response.json({ keys: await listKeys(env) });
    }
    if (url.pathname === '/app/api/keys' && req.method === 'POST') {
      if (!isRootAdmin(p) || !isRootAdmin(principal)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      if (body.role === 'super') return Response.json({ error: 'super keys are minted over MCP with a super key' }, { status: 400 });
      try {
        // A key minted here belongs to the signed-in user, descends from the session's key and
        // never outlives it, so revoking the parent revokes it and the agent guard sees the lineage.
        const days = body.expires_days == null || body.expires_days === '' ? null : Math.max(1, Math.min(3650, Number(body.expires_days) | 0));
        const wanted = days ? Date.now() + days * 86400000 : null;
        const parentEnds = principal.expires ? Date.parse(`${String(principal.expires).replace(' ', 'T')}Z`) : null;
        const ends = parentEnds && (!wanted || parentEnds < wanted) ? parentEnds : wanted;
        const created = await createKey(env, {
          name: body.name, role: body.role, prefixes: body.prefixes, user_id: principal.user?.id || null,
          parent_key_id: principal.keyId || null, space_limit: principal.spaceLimit || null,
          expires_at: ends ? new Date(ends).toISOString().replace('T', ' ').slice(0, 19) : null,
        });
        auditInBackground({ env, ctx, p: principal }, 'key.create', { target: created.id, detail: { role: body.role, via: 'web' } });
        return Response.json(created, { status: 201 });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }
    if (url.pathname === '/app/api/keys' && req.method === 'PATCH') {
      if (!isRootAdmin(p) || !isRootAdmin(principal)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      if (!body.id) return Response.json({ error: 'id required' }, { status: 400 });
      const { id, ...patch } = body;
      try {
        return Response.json({ key: await updateKey(env, id, patch) });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }
    if (url.pathname === '/app/api/keys/revoke' && req.method === 'POST') {
      if (!isRootAdmin(p) || !isRootAdmin(principal)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      if (!body.id) return Response.json({ error: 'id required' }, { status: 400 });
      await revokeKey(env, body.id);
      auditInBackground({ env, ctx, p: principal }, 'key.revoke', { target: body.id, detail: 'web' });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'unknown api' }, { status: 404 });
  }

  return new Response('not found', { status: 404 });
}
