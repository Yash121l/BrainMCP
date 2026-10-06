#!/usr/bin/env node
// Re-check every one-click app in the directory the way a real connect does it: register
// BrainMCP as a client, then load the sign-in page and look for a refusal. Registers a
// client at each provider, so run it on purpose, not in CI.
//   node scripts/check-catalog.mjs [app ids...]

import { FEATURED } from '../src/catalog.js';
import { discoverOauth, registerClient, authorizeUrl, pkceChallenge, randomToken } from '../src/upstream.js';
const REDIRECT = process.env.REDIRECT || 'https://brain.yashlunawat.com/connect/callback';
const only = process.argv.slice(2);
const apps = FEATURED.filter((a) => a.auth === 'oauth' && (!only.length || only.includes(a.id)));
const out = [];
for (const a of apps) {
  let verdict;
  try {
    const d = await discoverOauth(a.url);
    let client;
    try { client = await registerClient(d.as, REDIRECT); } catch (e) { out.push(`${a.id.padEnd(24)} REGISTER-FAIL ${e.message.slice(0, 90)}`); continue; }
    const url = authorizeUrl({ as: d.as, client, redirectUri: REDIRECT, state: randomToken(16), challenge: await pkceChallenge(randomToken(32)), resource: d.resource });
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36', Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
    const loc = res.headers.get('location') || '';
    const body = res.status >= 300 && res.status < 400 ? '' : (await res.text()).slice(0, 3000);
    const bad = /invalid[_ ]redirect|redirect[_ ]uri.{0,40}(invalid|not (allowed|registered|match))|unauthorized[_ ]client|invalid[_ ]client|access[_ ]denied|error=/i;
    if (bad.test(loc) || (res.status >= 400) || bad.test(body.replace(/<script[\s\S]*?<\/script>/g, ''))) verdict = `BAD ${res.status} ${(loc || body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).slice(0, 110)}`;
    else verdict = `OK  ${res.status} ${loc ? 'redirect -> ' + new URL(loc, url).host + new URL(loc, url).pathname.slice(0, 40) : 'login page'}`;
  } catch (e) { verdict = `ERR ${e.message.slice(0, 100)}`; }
  out.push(`${a.id.padEnd(24)} ${verdict}`);
}
console.log(out.join('\n'));
