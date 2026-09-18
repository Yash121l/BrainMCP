// Minimal single-user OAuth 2.1 authorization server for claude.ai connectors.
// claude.ai's custom-connector dialog only supports OAuth (no static headers), so:
// discovery -> dynamic client registration -> PKCE code flow -> consent page where
// the user pastes the BRAIN_TOKEN once. Issued tokens live in D1 (hashes only).
// Any managed key (see auth.js) works on the consent page; issued tokens inherit
// that key's role + path-prefix scopes. BRAIN_TOKEN stays as break-glass admin.

import { resolvePrincipal } from './auth.js';

const enc = new TextEncoder();

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256b64url(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return b64url(new Uint8Array(d));
}
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['brain'],
  };
}

export function resourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

/** Is this bearer an issued (non-static) OAuth access token that's still valid? */
export async function validOauthToken(env, token) {
  if (!token) return false;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    "SELECT 1 FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND exp > datetime('now')"
  ).bind(hash).first().catch(() => null);
  return !!row;
}

export async function handleOauth(req, env, url) {
  const origin = url.origin;

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return Response.json(oauthMetadata(origin));
  }
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return Response.json(resourceMetadata(origin));
  }

  if (url.pathname === '/register' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const client_id = rand(16);
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    await env.DB.prepare('INSERT INTO oauth_clients (client_id, redirect_uris, created) VALUES (?, ?, datetime(\'now\'))')
      .bind(client_id, JSON.stringify(redirect_uris)).run();
    return Response.json({
      client_id,
      redirect_uris,
      client_name: body.client_name || 'client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, { status: 201 });
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    const client_id = q.get('client_id') || '';
    const redirect_uri = q.get('redirect_uri') || '';
    const client = await env.DB.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').bind(client_id).first();
    if (!client) return new Response('unknown client_id', { status: 400 });
    const uris = JSON.parse(client.redirect_uris || '[]');
    if (uris.length && !uris.includes(redirect_uri)) return new Response('redirect_uri not registered', { status: 400 });
    const params = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope']
      .map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) || '').replace(/"/g, '&quot;')}">`)
      .join('\n');
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>BrainMCP — authorize</title>
<style>body{font-family:-apple-system,sans-serif;max-width:26rem;margin:15vh auto;padding:0 1rem;color:#eee;background:#111}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{margin-top:.8rem;padding:.6rem 1.4rem;font-size:1rem;border-radius:6px;border:0;background:#c96442;color:#fff;cursor:pointer}</style></head>
<body><h2>🧠 BrainMCP</h2><p>A client is requesting access to the brain. Paste your access key — the connection inherits that key's scopes.</p>
<form method="POST" action="/authorize">${params}
<input type="password" name="access_key" placeholder="access key" autofocus required>
<button type="submit">Authorize</button></form></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (url.pathname === '/authorize' && req.method === 'POST') {
    const form = await req.formData();
    const principal = await resolvePrincipal(env, form.get('access_key') || '');
    if (!principal) return new Response('invalid or revoked access key', { status: 403 });
    const redirect_uri = form.get('redirect_uri') || '';
    const code = rand(32);
    await env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, exp, role, prefixes, key_id) VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'), ?, ?, ?)"
    ).bind(await sha256hex(code), form.get('client_id') || '', redirect_uri, form.get('code_challenge') || '',
           principal.role, JSON.stringify(principal.scopes ?? []), principal.keyId || null).run();
    const dest = new URL(redirect_uri);
    dest.searchParams.set('code', code);
    if (form.get('state')) dest.searchParams.set('state', form.get('state'));
    return Response.redirect(dest.toString(), 302);
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const form = await req.formData();
    const grant = form.get('grant_type');
    const issue = async (client_id, role, prefixes, key_id) => {
      const access = rand(32); const refresh = rand(32);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', ?, datetime('now', '+30 days'), ?, ?, ?)")
          .bind(await sha256hex(access), client_id, role || 'admin', prefixes || '[]', key_id || null),
        env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'refresh', ?, datetime('now', '+90 days'), ?, ?, ?)")
          .bind(await sha256hex(refresh), client_id, role || 'admin', prefixes || '[]', key_id || null),
      ]);
      return Response.json({ access_token: access, token_type: 'Bearer', expires_in: 2592000, refresh_token: refresh, scope: 'brain' });
    };

    if (grant === 'authorization_code') {
      const codeHash = await sha256hex(form.get('code') || '');
      const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ? AND exp > datetime('now')").bind(codeHash).first();
      if (!row) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(codeHash).run(); // single-use
      if (row.challenge) {
        const verifier = form.get('code_verifier') || '';
        if ((await sha256b64url(verifier)) !== row.challenge) return Response.json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, { status: 400 });
      }
      if (form.get('redirect_uri') && form.get('redirect_uri') !== row.redirect_uri) {
        return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
      }
      return issue(row.client_id, row.role, row.prefixes, row.key_id);
    }

    if (grant === 'refresh_token') {
      const hash = await sha256hex(form.get('refresh_token') || '');
      const row = await env.DB.prepare("SELECT client_id, role, prefixes, key_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND exp > datetime('now')").bind(hash).first();
      if (!row) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      await env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').bind(hash).run(); // rotate
      return issue(row.client_id, row.role, row.prefixes, row.key_id);
    }

    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  return null; // not an oauth route
}
