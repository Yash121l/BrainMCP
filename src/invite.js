// GET shows a button and POST spends the code, so link-preview bots cannot burn an invite.

import { createKey, sha256hex } from './auth.js';
import { decryptText, unwrapDataKey } from './crypto.js';
import { spaceById } from './tenancy.js';
import { auditInBackground } from './audit.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title, body, status = 200) => new Response(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:40rem;margin:10vh auto;padding:0 1rem;color:#e7e5e4;background:#0c0a09;line-height:1.55}
code,pre{background:#1c1917;border:1px solid #44403c;border-radius:6px;font:13px ui-monospace,Menlo,monospace}code{padding:1px 5px}
pre{padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}button{padding:.6rem 1.4rem;font-size:1rem;border-radius:6px;border:0;background:#c96442;color:#fff;cursor:pointer}
.warn{border-left:3px solid #fbbf24;padding-left:12px}</style></head><body>${body}</body></html>`,
{ status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });

export async function handleInvite(req, env, url, ctx) {
  const m = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{20,64})$/);
  if (!m) return null;
  const hash = await sha256hex(m[1]);
  const inv = await env.DB.prepare(
    "SELECT i.user_id, u.handle, u.status FROM invites i JOIN users u ON u.id = i.user_id WHERE i.code_hash = ? AND i.used_at IS NULL AND i.exp > datetime('now')"
  ).bind(hash).first();
  if (!inv || inv.status !== 'active') return page('Invite', '<h2>This invite link is used, expired or invalid.</h2><p>Ask whoever invited you for a fresh one.</p>', 410);

  if (req.method === 'GET') {
    return page('Join BrainMCP', `<h2>Welcome, @${esc(inv.handle)}</h2>
<p>This sets up your access to BrainMCP, a second brain your AI agents reach over MCP. You already have a personal space, <code>@${esc(inv.handle)}</code>.</p>
<p class="warn">Continuing shows your first key exactly once. Have somewhere safe to store it.</p>
<form method="POST"><button type="submit">Create my key</button></form>`);
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const spent = await env.DB.prepare("UPDATE invites SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL").bind(hash).run();
  if (!spent.meta?.changes) return page('Invite', '<h2>This invite link was just used.</h2>', 410);
  const { id, key } = await createKey(env, { name: 'first key (invite)', role: 'admin', user_id: inv.user_id });
  auditInBackground({ env, ctx, p: { user: { id: inv.user_id }, keyId: id, via: 'invite' } }, 'invite.redeem', { subject_user: inv.user_id, target: id });
  const mcp = `${url.origin}/mcp`;
  return page('Your BrainMCP key', `<h2>You're in, @${esc(inv.handle)}</h2>
<p>Your key, shown only this once:</p><pre>${esc(key)}</pre>
<h3>Claude Code</h3><pre>claude mcp add --transport http brain ${esc(mcp)} --header "Authorization: Bearer ${esc(key)}"</pre>
<h3>claude.ai</h3><p>Settings → Connectors → Add custom connector, URL <code>${esc(mcp)}</code>, leave the OAuth fields empty, and paste this key on the consent page.</p>
<h3>Then</h3><p>Ask your agent to call <code>whoami</code>, then <code>get_context</code>. Use <code>create_key</code> to mint narrower keys for other machines, and <code>revoke_key</code> if one leaks.</p>`);
}

export async function handleExport(req, env, url, ctx) {
  const m = url.pathname.match(/^\/export\/([A-Za-z0-9_-]{20,64})$/);
  if (!m || req.method !== 'GET') return null;
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT e.* FROM exports e JOIN users u ON u.id = e.user_id
      WHERE e.token_hash = ? AND e.exp > datetime('now') AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM members m WHERE m.space_id = e.space_id AND m.user_id = e.user_id AND m.role IN ('owner', 'admin') AND m.accepted = 1)`
  ).bind(hash).first();
  if (!row) return new Response('export link used, expired or invalid', { status: 410 });
  await env.DB.prepare('DELETE FROM exports WHERE token_hash = ?').bind(hash).run();
  const space = await spaceById(env, row.space_id);
  const obj = await env.LOGS.get(row.r2_key);
  if (!space || !obj) return new Response('export no longer available', { status: 410 });
  const json = await decryptText(await unwrapDataKey(env, space.dek_wrapped), await obj.text());
  await env.LOGS.delete(row.r2_key);
  auditInBackground({ env, ctx, p: { user: { id: row.user_id }, via: 'export-link' } }, 'space.export.download', { space_id: space.id });
  return new Response(json, {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${space.handle}-export.json"`, 'Cache-Control': 'no-store' },
  });
}
