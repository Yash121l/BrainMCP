// Minimal single-user OAuth 2.1 authorization server for claude.ai connectors.
// claude.ai's custom-connector dialog only supports OAuth (no static headers), so:
// discovery -> dynamic client registration -> PKCE code flow -> consent page where
// the user pastes the BRAIN_TOKEN once. Issued tokens live in D1 (hashes only).
// Any managed key (see auth.js) works on the consent page; issued tokens inherit
// that key's role + path-prefix scopes. BRAIN_TOKEN stays as break-glass admin.

import { resolvePrincipal, parentKey, roleWithoutSuper } from './auth.js';
import { auditInBackground } from './audit.js';

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const REGISTER_MAX_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_CLIENT_NAME = 100;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url SHA-256, unpadded

/** Read a request body as text, or null once it passes max bytes. */
async function readCapped(req, max) {
  if (Number(req.headers.get('content-length') || 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** A redirect URI a client may register: https anywhere, http only on loopback, no fragment. */
function validRedirectUri(u) {
  if (typeof u !== 'string' || !u || u.length > MAX_URI_LENGTH) return false;
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * Look up client_id and check the request against it: the redirect_uri must exactly
 * match one the client registered (clients that registered none get nothing) and PKCE
 * S256 is mandatory. Returns { client } or { error }.
 */
async function checkAuthorizeRequest(env, get) {
  const client = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(get('client_id') || '').first();
  if (!client) return { error: 'unknown client_id' };
  let uris;
  try { uris = JSON.parse(client.redirect_uris || '[]'); } catch { uris = []; }
  const redirect_uri = get('redirect_uri') || '';
  if (!Array.isArray(uris) || !uris.includes(redirect_uri) || !validRedirectUri(redirect_uri)) return { error: 'redirect_uri not registered' };
  if (get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(get('code_challenge') || '')) {
    return { error: 'PKCE with code_challenge_method=S256 is required' };
  }
  return { client, redirect_uri };
}

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
  return (await resolvePrincipal(env, token))?.via === 'oauth';
}

export async function handleOauth(req, env, url, ctx) {
  const origin = url.origin;

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return Response.json(oauthMetadata(origin));
  }
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return Response.json(resourceMetadata(origin));
  }

  if (url.pathname === '/register' && req.method === 'POST') {
    const bad = (error_description, status = 400) => Response.json({ error: 'invalid_client_metadata', error_description }, { status });
    const raw = await readCapped(req, REGISTER_MAX_BYTES);
    if (raw === null) return bad('registration body too large', 413);
    let body;
    try { body = JSON.parse(raw); } catch { return bad('body must be JSON'); }
    if (!body || typeof body !== 'object') return bad('body must be a JSON object');
    const { redirect_uris } = body;
    if (!Array.isArray(redirect_uris) || redirect_uris.length < 1 || redirect_uris.length > MAX_REDIRECT_URIS || !redirect_uris.every(validRedirectUri)) {
      return bad(`redirect_uris must be 1-${MAX_REDIRECT_URIS} https (or loopback http) URLs`);
    }
    if (body.client_name != null && typeof body.client_name !== 'string') return bad('client_name must be a string');
    const client_name = (body.client_name || 'client').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_CLIENT_NAME) || 'client';
    const client_id = rand(16);
    // client_name is display-only; tolerate a D1 that predates the column.
    await env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created) VALUES (?, ?, ?, datetime('now'))")
      .bind(client_id, JSON.stringify(redirect_uris), client_name).run()
      .catch(() => env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, created) VALUES (?, ?, datetime('now'))")
        .bind(client_id, JSON.stringify(redirect_uris)).run());
    return Response.json({
      client_id,
      redirect_uris,
      client_name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, { status: 201 });
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    const checked = await checkAuthorizeRequest(env, (k) => q.get(k));
    if (checked.error) return new Response(checked.error, { status: 400 });
    const clientName = checked.client.client_name || 'An unnamed client';
    const host = new URL(checked.redirect_uri).host;
    const params = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) || '')}">`)
      .join('\n');
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>BrainMCP — authorize</title>
<style>body{font-family:-apple-system,sans-serif;max-width:26rem;margin:15vh auto;padding:0 1rem;color:#eee;background:#111}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{margin-top:.8rem;padding:.6rem 1.4rem;font-size:1rem;border-radius:6px;border:0;background:#c96442;color:#fff;cursor:pointer}</style></head>
<body><h2>🧠 BrainMCP</h2><p><b>${esc(clientName)}</b> (name chosen by the client, unverified) is requesting access to the brain.</p>
<p>Access will be sent to <b>${esc(host)}</b>. Only continue if you started this connection and recognise that host.</p>
<p>Paste your access key. The connection inherits that key's scopes.</p>
<form method="POST" action="/authorize">${params}
<input type="password" name="access_key" placeholder="access key" autofocus required>
<button type="submit">Authorize</button></form></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (url.pathname === '/authorize' && req.method === 'POST') {
    const form = await req.formData();
    const get = (k) => { const v = form.get(k); return typeof v === 'string' ? v : null; };
    const checked = await checkAuthorizeRequest(env, get);
    if (checked.error) return new Response(checked.error, { status: 400 });
    const principal = await resolvePrincipal(env, get('access_key') || '');
    if (!principal) return new Response('invalid or revoked access key', { status: 403 });
    if (!principal.keyId) return new Response('this credential cannot authorize a connection', { status: 403 });
    let dest;
    try { dest = new URL(checked.redirect_uri); } catch { return new Response('bad redirect_uri', { status: 400 }); }
    const code = rand(32);
    await env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, exp, role, prefixes, key_id) VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'), ?, ?, ?)"
    ).bind(await sha256hex(code), checked.client.client_id, checked.redirect_uri, get('code_challenge'),
           roleWithoutSuper(principal.role), JSON.stringify(principal.scopes ?? []), principal.keyId).run();
    auditInBackground({ env, ctx, p: principal }, 'oauth.consent', { detail: { client: checked.client.client_id, host: dest.host } });
    dest.searchParams.set('code', code);
    if (get('state')) dest.searchParams.set('state', get('state'));
    return Response.redirect(dest.toString(), 302);
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const form = await req.formData();
    const grant = form.get('grant_type');
    const invalid = (error_description) => Response.json({ error: 'invalid_grant', ...(error_description && { error_description }) }, { status: 400 });
    // Tokens carry the parent key's current grant and never outlive the key.
    const issue = async (client_id, parent, key_id) => {
      const access = rand(32); const refresh = rand(32);
      const prefixes = JSON.stringify(parent.scopes);
      const exp = (offset) => `min(datetime('now', '${offset}'), coalesce(?, datetime('now', '${offset}')))`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', ?, ${exp('+30 days')}, ?, ?, ?)`)
          .bind(await sha256hex(access), client_id, parent.expires, parent.role, prefixes, key_id),
        env.DB.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'refresh', ?, ${exp('+90 days')}, ?, ?, ?)`)
          .bind(await sha256hex(refresh), client_id, parent.expires, parent.role, prefixes, key_id),
      ]);
      const keyLeft = parent.expires ? Math.floor((Date.parse(parent.expires.replace(' ', 'T') + 'Z') - Date.now()) / 1000) : Infinity;
      const expires_in = Math.max(0, Math.min(2592000, keyLeft || 0));
      return Response.json({ access_token: access, token_type: 'Bearer', expires_in, refresh_token: refresh, scope: 'brain' });
    };

    if (grant === 'authorization_code') {
      const codeHash = await sha256hex(form.get('code') || '');
      const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ? AND exp > datetime('now')").bind(codeHash).first();
      if (!row) return invalid();
      await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(codeHash).run(); // single-use
      if (!row.client_id || form.get('client_id') !== row.client_id) return invalid('client_id mismatch');
      if (!row.redirect_uri || form.get('redirect_uri') !== row.redirect_uri) return invalid('redirect_uri mismatch');
      const verifier = form.get('code_verifier') || '';
      if (!row.challenge || (await sha256b64url(verifier)) !== row.challenge) return invalid('PKCE mismatch');
      const parent = await parentKey(env, row.key_id);
      if (!parent) return invalid('the key behind this code is revoked or expired');
      return issue(row.client_id, parent, row.key_id);
    }

    if (grant === 'refresh_token') {
      const hash = await sha256hex(form.get('refresh_token') || '');
      const row = await env.DB.prepare("SELECT client_id, key_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND exp > datetime('now')").bind(hash).first();
      if (!row) return invalid();
      await env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').bind(hash).run(); // rotate
      const parent = await parentKey(env, row.key_id);
      if (!parent) return invalid('the key behind this token is revoked or expired');
      return issue(row.client_id, parent, row.key_id);
    }

    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  return null; // not an oauth route
}
