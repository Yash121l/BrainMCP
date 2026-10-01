# Findings detail

Complete source paths and bounded local reproductions for every confirmed medium, high or critical record. Every reproduction ran in the audit sandbox with dummy principals and stubbed GitHub/D1. None of it should be run against the deployment.

## '..' segments in MCP path arguments bypass key scopes: any scoped key can read any repo file, and a scoped write key can overwrite any file, including skills that /skills/install.sh ships to client machines

`brainmcp:auth.allowed:unnormalized-path-prefix-scope-bypass` · **high**

### Trace
1. **entrypoint** `src/index.js:871` (fetch POST /mcp): Any bearer token that resolves to a principal (managed key, OAuth token) is accepted, and the JSON-RPC body is dispatched to handleRpc.
2. **propagation** `src/index.js:615` (handleRpc tools/call): Caller-controlled params.arguments (including path and content) is passed to callTool with the resolved principal.
3. **propagation** `src/auth.js:94` (resolvePrincipal): Key scopes are expanded through expandScopes. project:<slug> adds vault/projects/<slug>.md, vault/projects/<slug>/ and exact note paths (auth.js:64,70), and all of them are later used as raw prefixes.
4. **propagation** `src/index.js:413` (callTool read_note): allowed(p, args.path) passes for 'vault/logs/../projects/beta-secret.md' because the string starts with 'vault/logs/'.
5. **propagation** `src/auth.js:112` (allowed): Plain path.startsWith(pre) with no normalization or segment-boundary check.
6. **propagation** `src/index.js:417` (callTool read_note): The D1 exact-path lookup misses, so the code falls back to getFile(env, args.path) with the raw path.
7. **propagation** `src/github.js:25` (getFile): Intermediate sink: The URL keeps '..'. fetch's WHATWG parse resolves the dot segments and requests /contents/vault/projects/beta-secret.md, and the content is returned to the caller.
8. **propagation** `src/index.js:481` (callTool update_note): canWrite plus allowed(p, args.path) on the raw path. getFile at line 482 then fetches the real sha of the normalized out-of-scope file.
9. **propagation** `src/github.js:41` (putFile): Intermediate sink: The PUT goes to the dot-normalized URL with the Worker's GITHUB_TOKEN, committing attacker content at vault/rules/beta.md, skills/evil/run.sh or skills/trusted/SKILL.md.
10. **sink** `src/index.js:811` (GET /skills/install.sh): The installer is regenerated from the repo tarball (line 788). It writes each skills/ file into $SKILLS_DEST and adds chmod +x for *.sh, so planted files ship to whoever pipes the installer into sh.

### Evidence
- `src/auth.js:112`: return p.prefixes.some((pre) => path.startsWith(pre)); does no canonicalization and has no boundary check.
- `src/auth.js:70`: Exact note paths filed under the project are pushed as prefixes. Line 64 adds vault/projects/<slug>.md and vault/projects/<slug>/ the same way.
- `src/github.js:25`: encodeURIComponent(path).replace(/%2F/g, '/') keeps '.' and '..' segments in the Contents API GET URL.
- `src/github.js:41`: The PUT URL uses the same construction, so writes land at the normalized path.
- `src/index.js:417`: The read_note GitHub fallback runs on any D1 miss, which always happens for a '..' path.
- `src/index.js:481`: update_note authorizes the raw path, then passes the same string to getFile and putFile.
- `src/index.js:811`: The installer marks shipped *.sh files executable. It has no per-skill provenance or author check.
- `wrangler.jsonc:5`: compatibility_date 2026-08-01 is well past the date when standard WHATWG URL parsing (url_standard) became the default, and that parser removes dot segments.

### Principals
Holder of a dummy managed key scoped to ['vault/logs/'] (read role for reads, write role for writes), or to ['project:alpha'], calling MCP tools/call on POST /mcp.

### Native input
```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"vault/logs/../projects/beta-secret.md"}}}
```
```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"vault/projects/alpha.md/../beta-secret.md"}}}
```
```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_note","arguments":{"path":"vault/logs/../rules/beta.md","content":"V01-DUMMY-INJECTED-RULES\n"}}}
```
```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_note","arguments":{"path":"vault/logs/../../skills/evil/run.sh","content":"#!/bin/sh\necho V01-DUMMY-MARKER\n"}}}
```
```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_note","arguments":{"path":"vault/logs/../../skills/trusted/SKILL.md","content":"---\nname: trusted\ndescription: replaced\n---\nV01-DUMMY replaced\n"}}}
```

### Bounded instructions
1. Run agents/verify-01/artifacts/verify-dotseg.mjs in the no-network sandbox. It imports the real Worker default export from /target/src/index.js with a fake env.DB. The fake resolves three dummy keys: read role ['vault/logs/'], write role ['vault/logs/'], and read role ['project:alpha']. Its notes table holds only vault/projects/alpha.md under project alpha, and every exact-path notes lookup misses.
2. Global fetch is stubbed with an in-memory GitHub Contents/tarball fake. The stub builds new Request(input) (the URL parse real fetch performs) and records both the raw URL the code built and the path actually sent.
3. Each payload is POSTed to /mcp with Authorization: Bearer <dummy key>, alongside controls: the direct out-of-scope path for each key, and the dot-segment write with the read-role key. GET /skills/install.sh is then called with the dummy root token, and the generated script is printed, never executed.

### Observed output
Controls: read_note 'vault/projects/beta-secret.md' returned 'forbidden: no access' for both the vault/logs/ key and the project:alpha key, update_note 'vault/rules/beta.md' and 'skills/evil/run.sh' returned 'forbidden: no write access', and a read-role key's dot-segment update_note returned 'key is read-only'. Bypass: the read-role vault/logs/ key's read of 'vault/logs/../projects/beta-secret.md' returned 'V01-DUMMY-BETA-SECRET' with source 'github (not yet indexed)'. The wire showed raw '/contents/vault/logs/../projects/beta-secret.md?ref=main' and sent '/contents/vault/projects/beta-secret.md?ref=main'. The project:alpha key read the same secret through 'vault/projects/alpha.md/../beta-secret.md'. With the write-role vault/logs/ key: update_note 'vault/logs/../rules/beta.md' returned ok, created:false, sent GET and PUT /contents/vault/rules/beta.md, and the fake repo file became 'V01-DUMMY-INJECTED-RULES'. update_note 'vault/logs/../../skills/evil/run.sh' created skills/evil/run.sh, and 'vault/logs/../../skills/trusted/SKILL.md' replaced the existing skill (created:false). install.sh returned 200, contained the base64 of both attacker bodies, and included 'chmod +x "$SKILLS_DEST/evil/run.sh"'.

### Conditions and containment
- **authentication level**: The attacker holds any managed key with a non-empty scope list, or an OAuth or web-session token derived from one. Scoped keys are the lower-trust credential the operator hands to other people, machines and AI clients.
- **authorization role**: Read role is enough for the out-of-scope read through read_note. Write or admin role is needed for out-of-scope writes through update_note. No skills/ scope is needed to write under skills/.
- **user interaction**: For impact on a client machine, the owner or another key holder whose scope covers skills/ later runs /skills/install.sh | sh, and then an agent loads the replaced skill or the planted helper is invoked.
- **environmental dependency**: The Workers fetch URL parser resolves '.' and '..' path segments, as the WHATWG URL standard requires (the default at the configured compatibility date). In Node 26 in the harness, new Request()/new URL() did resolve them.
- **third party dependency**: Write reach is bounded by what the Worker's GITHUB_TOKEN can write. For example, .github/workflows/* would also need workflow permission.

### Remediation
Use one shared canonical-path validator. Reject empty, '.' and '..' segments, a leading '/', backslashes and control characters. Call it inside allowed() so every caller fails closed, and make allowed() match file prefixes exactly and directory prefixes on a '/' boundary. As defense in depth, call the same validator in every github.js path sink (getFile, putFile and multiCommit tree paths), so the authorized string is exactly the one sent to GitHub. Optionally require an explicit skills/ write scope, or admin, for writes under skills/. Regression cases: read_note, update_note, save topics and save_session with 'vault/logs/../x.md', 'vault/projects/alpha.md/../x.md', 'vault/projects/alpha/../x.md' and 'vault/logs/./x.md' must return forbidden for scoped keys, while canonical in-scope paths keep working.

`src/auth.js`

```js
export function safeRepoPath(path) {
  const s = typeof path === 'string' ? path : '';
  if (!s || s.startsWith('/') || s.includes('\\') || /[\u0000-\u001f]/.test(s)) return null;
  if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return s;
}

/** May this principal read the given repo path? */
export function allowed(p, path) {
  if (!p || safeRepoPath(path) === null) return false;
  if (!p.prefixes || p.prefixes.length === 0) return true;
  return p.prefixes.some((pre) =>
    pre.endsWith('/') ? path.startsWith(pre) : path === pre || path.startsWith(pre + '/'));
}
```

`src/github.js`

```js
import { safeRepoPath } from './auth.js';
const repoUrlPath = (path) => {
  if (safeRepoPath(path) === null) throw new Error(`unsafe repo path: ${path}`);
  return path.split('/').map(encodeURIComponent).join('/');
};
// getFile:  gh(env, `/repos/${env.REPO}/contents/${repoUrlPath(path)}?ref=${env.BRANCH}`)
// putFile:  fetch(`${API}/repos/${env.REPO}/contents/${repoUrlPath(path)}`, ...)
// multiCommit: files.forEach((f) => repoUrlPath(f.path)); before building the tree
```

## Skill file names from a scoped write key execute as shell on every machine that runs /skills/install.sh

`src/index.js:skills-install.sh:unquoted-repo-path-shell-injection` · **high**

### Trace
1. **entrypoint** `src/index.js:479` (callTool update_note): A write-role principal scoped to skills/team-skill/ supplies path 'skills/team-skill/$(touch <marker>)/notes.md' to update_note.
2. **propagation** `src/index.js:481` (callTool update_note): allowed(p, args.path) checks only startsWith on the prefix 'skills/team-skill/', so the path with the command substitution is accepted.
3. **propagation** `src/github.js:41` (putFile): The path is URL-encoded with encodeURIComponent(...).replace(/%2F/g,'/') and committed to the repo unchanged (slashes preserved; $, (, ), space retained).
4. **propagation** `src/github.js:148` (tarEntries): On reindex/install the repo tarball is read and yields the raw committed file name as the entry path (only the top-level owner-repo-sha/ component is stripped).
5. **propagation** `src/index.js:794` (GET /skills/install.sh): rel = e.path minus 'skills/' is retained for every skills/ path the fetching principal is allowed() to read.
6. **sink** `src/index.js:809` (GET /skills/install.sh): `mkdir -p "$SKILLS_DEST/${dir}"` (and the base64 redirect on line 810) place rel into double-quoted shell that the client pipes into sh, where $(...) in the name executes.

### Evidence
- `src/index.js:809`: lines.push(`mkdir -p "$SKILLS_DEST/${dir}"`) interpolates dir into double quotes with no escaping.
- `src/index.js:810`: lines.push(`base64 $B64D > "$SKILLS_DEST/${f.rel}" <<'B64_EOF'`, encodeBase64(f.body), 'B64_EOF'): only the body is base64/heredoc-protected; the file name f.rel is not.
- `src/index.js:813`: echo "Done: ${[...skillNames].sort().join(' ')}" also interpolates skill directory names into double-quoted shell.
- `src/auth.js:112`: allowed() is p.prefixes.some(pre => path.startsWith(pre)) and places no character restriction on the remainder of the path.
- `src/index.js:488`: save_session commits arbitrary files[].path through multiCommit after the same prefix-only check, a second writer route to the same installer sink.

### Principals
Holder of a write key scoped to skills/team-skill/ seeking command execution on the owner's machine beyond their authority to edit skill text.

### Native input
```
tools/call update_note {"path":"skills/team-skill/$(touch /work/run/INJECTED_marker)/notes.md","content":"hello"}
```

### Bounded instructions
1. Harness agents/verify-16c/artifacts/v16c-install-name-injection.mjs: import /target/src/index.js default worker with a stubbed env (in-memory DB resolving bk_scopedwritekey -> role write, prefixes ['skills/team-skill/']; BRAIN_TOKEN root; LOGS stub) and a fetch stub that stores Contents API PUTs into an in-memory repo and serves them back as a gzip tarball.
2. POST the update_note JSON-RPC call to /mcp with the scoped key; the path is accepted and committed to the in-memory repo by putFile (the subsequent D1 indexing step is unrelated to the committed file).
3. GET /skills/install.sh with the root token and write the response to /work/run/install.sh.
4. Run /bin/sh /work/run/install.sh with cwd /work/run and SKILLS_DEST=/work/run/skills inside the no-network sbx container, then check for /work/run/INJECTED_marker.
5. Execute via: python3 tools/sbx.py run /Users/admin/security-audit-skill/BrainMCP/run-1 verify-16c v16c-install-name-injection.mjs --timeout 90

### Observed output
The scoped write key's path 'skills/team-skill/$(touch /work/run/INJECTED_marker)/notes.md' was accepted by allowed() and committed to the repo (repo keys listed it). The root-token /skills/install.sh returned status 200 and contained `mkdir -p "$SKILLS_DEST/team-skill/$(touch /work/run/INJECTED_marker)"` and the matching base64 redirect line. Running the script with /bin/sh printed 'Installing 1 skills (2 files)' and 'Done: team-skill'; marker before: false, marker after: true — the command embedded in the file name executed at install time. (update_note's JSON reply surfaced a D1-stub error from the indexing step after the commit; in production with a real D1 it returns ok:true, but the committed file and the resulting code execution do not depend on that step.)

### Conditions and containment
- **authorization role**: The attacker holds a write- or admin-role managed key (or an OAuth token derived from one) whose scope includes some skills/ prefix (e.g. a delegated skill-author key). The KeysView UI supports path scopes, so such a key is a normal thing to issue.
- **user interaction**: A victim whose key can read that path (typically the owner's root/admin key, which has empty prefixes and thus reads everything) runs the documented `curl -H 'Authorization: Bearer $KEY' .../skills/install.sh | sh`.
- **third party dependency**: GitHub's Contents/Git Data API accepts file names containing $, ( ), and spaces; git permits any byte except NUL and '/'. The local reproduction used a fetch stub for GitHub, so this one acceptance fact is the only step not exercised against the real service.

### Remediation
Reject unsafe skill paths when generating the installer and emit every path as a single-quoted shell literal so no name can expand; optionally also reject such names in the write tools.

`src/index.js`

```js
const SAFE_REL = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// in the tar loop, skip unsafe names:
if (!SAFE_REL.test(rel) || rel.split('/').some((c) => c === '..' || c === '.')) continue;
// when emitting:
if (dir) lines.push(`mkdir -p "$SKILLS_DEST"/${shq(dir)}`);
lines.push(`base64 $B64D > "$SKILLS_DEST"/${shq(f.rel)} <<'B64_EOF'`, encodeBase64(f.body), 'B64_EOF');
if (f.rel.endsWith('.sh')) lines.push(`chmod +x "$SKILLS_DEST"/${shq(f.rel)}`);
lines.push(`echo ${shq('Done: ' + [...skillNames].sort().join(' '))}`, '');
// Regression: a repo entry skills/x/$(touch M)/a.md must not create M when the installer runs.
```

## Scoped admin key can mint or self-grant whole-brain admin through /app/api/keys and can run global /admin routes, because isAdmin ignores scope

`src/auth.js:isAdmin/scope-agnostic-key-management` · **medium**

### Trace
1. **entrypoint** `src/app.js:295` (handleApp POST /app/api/keys): Cookie-authenticated request (brain_session = a managed admin key scoped to vault/projects/alpha/). sessionPrincipal resolves it to {role:'admin', prefixes:['vault/projects/alpha/']}.
2. **propagation** `src/auth.js:94` (resolvePrincipal): A managed key row with role 'admin' and a non-empty scope resolves to a principal whose scopes and prefixes are limited, so this is a real scope-limited admin principal.
3. **propagation** `src/app.js:296` (handleApp POST /app/api/keys): The only gate is isAdmin(p). The caller's scopes are never checked against the request body.
4. **propagation** `src/auth.js:115` (isAdmin): Returns true for role 'admin' whatever the prefixes are.
5. **propagation** `src/auth.js:129` (createKey): Intermediate sink: After normalizeScopes(prefixes) at line 123 accepts [], an api_keys row with role admin and prefixes '[]' (whole brain) is inserted, and the plaintext key is returned to the caller.
6. **propagation** `src/auth.js:169` (updateKey (via PATCH /app/api/keys, src/app.js:305-311)): Intermediate sink: The body id, which can be the caller's own key id, and prefixes [] are written straight into api_keys, so the scoped key widens itself to the whole brain.
7. **propagation** `src/index.js:836` (default.fetch POST /admin/rollup): Parallel entrypoint: A bearer request with the same scoped admin key reaches the rollup handler.
8. **propagation** `src/index.js:838` (default.fetch POST /admin/rollup): The gate is isAdmin(p) only, with no scope check.
9. **propagation** `src/index.js:697` (rollUpToolCalls): Intermediate sink: Selects every session's tool_calls for every project (line 676), writes them to R2 and runs DELETE FROM tool_calls WHERE day < today. Nothing filters by scope.
10. **propagation** `src/index.js:860` (default.fetch POST /admin/reindex): Parallel entrypoint: A bearer request with the scoped admin key reaches the reindex handler.
11. **propagation** `src/index.js:862` (default.fetch POST /admin/reindex): The gate is isAdmin(p) only, with no scope check.
12. **sink** `src/index.js:32` (fullReindex): Runs DELETE FROM notes, links and fts in one batch, then rebuilds the whole index from the repo tarball. Global, with no scope argument.

### Evidence
- `src/auth.js:115`: `export const isAdmin = (p) => !!p && p.role === 'admin';`: role only, scopes never checked.
- `src/auth.js:111`: In allowed(), an empty prefix list means the whole brain, so prefixes [] grants every path.
- `src/auth.js:114`: canWrite is role-only too, so a widened admin key can use every MCP write tool against any path.
- `src/auth.js:121`: createKey accepts role 'admin' together with any prefixes. It never compares them with the caller's scopes.
- `src/auth.js:161`: updateKey sets prefixes to any normalized list, including [], for any id, including the caller's own key.
- `src/app.js:247`: /app/api/scopes is gated only by isAdmin and returns every project slug, title and path plus every folder from the whole notes table, not filtered by allowed().
- `src/app.js:292`: GET /app/api/keys returns every key record to any admin, scoped or not. /app/api/keys/revoke (line 317) has the same gate.
- `src/app.js:305`: PATCH /app/api/keys passes body.id and the rest of the body straight to updateKey after isAdmin.
- `src/index.js:838`: The /admin/rollup gate is only `if (!isAdmin(p)) return 401`.
- `src/index.js:862`: The /admin/reindex gate is only `if (!isAdmin(p)) return 401`.
- `ui/src/views/KeysView.tsx:326`: The key editor pairs any role, admin included, with ScopePicker, so a scoped admin is a configuration the UI offers. The admin role hint at line 57 reads 'everything, including these keys'.
- `ui/src/components/scope-picker.tsx:247`: For a scoped key of any role, the picker says it 'Sees about N notes across K scopes', which tells the operator the key is bounded.

### Principals
Holder of a managed admin key that the operator restricted to vault/projects/alpha/.

### Native input
```
POST /app/api/keys {"name":"escalated","role":"admin","prefixes":[]} with Cookie: brain_session=<scoped admin key>
```
```
PATCH /app/api/keys {"id":"<own key id>","prefixes":[]} with Cookie: brain_session=<scoped admin key>
```
```
GET /app/api/keys and GET /app/api/scopes with Cookie: brain_session=<scoped admin key>
```
```
POST /admin/rollup with Authorization: Bearer <scoped admin key>
```
```
POST /admin/reindex with Authorization: Bearer <scoped admin key>
```

### Bounded instructions
1. Run agents/verify-04/artifacts/verify04.mjs in the approved sandbox. It imports the real worker (default export of /target/src/index.js) with an in-memory fake D1 holding dummy notes vault/projects/alpha/a.md, vault/projects/beta.md (a project titled 'Beta Secret Project') and vault/secret/s.md, one dummy tool_calls row for project beta, an in-memory R2, and a stubbed fetch that serves a one-file dummy tarball and blocks all other network access.
2. As the operator, it calls createKey for an admin key and, as a control, a write key, both with prefixes ['vault/projects/alpha/'].
3. With the scoped admin key as the brain_session cookie, it requests the out-of-scope note, lists keys and scopes, POSTs a new admin key with prefixes [], reads the secret note with the minted key, PATCHes its own id to prefixes [], and reads the secret note again with the original key.
4. With a second scoped admin key as a bearer token, it POSTs /admin/rollup and /admin/reindex and checks D1 and R2 state before and after. The scoped write key is the negative control on both route families.

### Observed output
Sandbox exit 0, wall 0.16s. Scoped admin principal: role admin, prefixes ['vault/projects/alpha/']. Scope enforcement before escalation: out-of-scope note 403, /app/api/notes returns 1 note. GET /app/api/keys 200 (lists all keys); GET /app/api/scopes 200 (lists out-of-scope project ['beta','Beta Secret Project']). Control: the scoped write key gets 403 on POST /app/api/keys. Escalation: POST /app/api/keys with role admin and prefixes [] returns 201; the minted key reads vault/secret/s.md with 200 'secret dummy'. PATCH of its own id to prefixes [] returns 200 with []; the original key then reads vault/secret/s.md with 200 'secret dummy'. Control: the scoped write key gets 401 on /admin/rollup. The scoped admin's POST /admin/rollup returns 200 {rolled:1, objects:1}: the beta tool_calls buffer went from 1 row to 0 and was moved to R2 at tool-calls/2000-01-01/sess-beta.jsonl. The scoped admin's POST /admin/reindex returns 200 {indexed:1}: all three existing notes, including the out-of-scope ones, were deleted, and the index was rebuilt from the dummy tarball.

### Conditions and containment
- **authorization role**: The attacker holds a managed key with role 'admin' and a non-empty scope (a path prefix or project:<slug>).
- **data state**: The operator has issued such a scoped admin key. createKey and the key editor both allow it. For the /admin variant, there are notes or buffered tool_calls outside the key's scope, which is the normal multi-project state.

### Remediation
Treat key management and the /admin routes as whole-brain authority. Add isRootAdmin(p) = isAdmin(p) && the principal has no scopes (an empty p.scopes list), and use it for /app/api/scopes, every /app/api/keys* route, /admin/rollup and /admin/reindex. As a further guard, make createKey and updateKey reject role 'admin' with a non-empty scope, or, if delegated administration is wanted, require the new or edited role to be no higher than the caller's, the scopes to be a subset of the caller's, and the target id to differ from p.keyId. Add regression tests: a scoped admin gets 403 on POST, PATCH and revoke of /app/api/keys and on /app/api/scopes, and 401 on both /admin routes.

`src/auth.js`

```js
export const isAdmin = (p) => !!p && p.role === 'admin';
// Whole-brain admin: role admin AND no scope restriction.
export const isRootAdmin = (p) => isAdmin(p) && (!p.scopes || p.scopes.length === 0);
// in createKey and updateKey, after computing role/scopes:
// if (role === 'admin' && scopes.length) throw new Error('admin keys cannot be scoped');
```

`src/app.js`

```js
// in /app/api/scopes and every /app/api/keys* branch
if (!isRootAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
```

`src/index.js`

```js
// POST /admin/rollup and POST /admin/reindex
if (!isRootAdmin(p)) return new Response('unauthorized', { status: 401 });
```

## Key expiry is not enforced on web sessions or OAuth tokens derived from the key, and refresh rotation extends access indefinitely

`src/auth.js:resolvePrincipal/derived-token-ignores-parent-key-expiry` · **medium**

### Trace
1. **entrypoint** `src/app.js:129` (handleApp POST /app/login): The holder of a managed key with an expiry exchanges it for a web session while the key is still valid.
2. **propagation** `src/auth.js:89` (resolvePrincipal api_keys branch): The key's expires is checked here, only at the moment the raw key is presented (login or consent).
3. **propagation** `src/app.js:135` (handleApp POST /app/login): The session row gets exp = datetime('now', '+30 days'), independent of the key's expires.
4. **propagation** `src/oauth.js:106` (handleOauth POST /authorize): OAuth consent validates the key, including expiry, through resolvePrincipal, but only at this moment. The code row stores role, scopes and key_id but no expiry (line 113).
5. **propagation** `src/oauth.js:126` (handleOauth POST /token issue()): The access token gets exp now+30 days and the refresh token now+90 days (line 128), regardless of the key's expires.
6. **propagation** `src/oauth.js:151` (handleOauth refresh_token grant): The refresh lookup reads only oauth_tokens and checks only the row's own exp. It never consults api_keys.
7. **propagation** `src/oauth.js:154` (handleOauth refresh_token grant): Rotation re-issues a new access/refresh pair with the same role, prefixes and key_id and a fresh +90-day refresh window.
8. **sink** `src/auth.js:98` (resolvePrincipal oauth_tokens branch): Session cookies and OAuth access tokens are accepted on their own exp alone, with no join to api_keys.expires, and return the expired key's role and scopes.

### Evidence
- `src/auth.js:89`: expires > datetime('now') is enforced only in the api_keys query.
- `src/auth.js:98`: The oauth_tokens query filters on token_hash, kind and exp only.
- `src/app.js:135`: The session lifetime is a hard-coded +30 days.
- `src/oauth.js:128`: The refresh token lifetime is a hard-coded +90 days, reset on every rotation.
- `src/oauth.js:151`: The refresh SELECT never reads api_keys.
- `src/auth.js:166`: updateKey changes expires on the api_keys row only. The cascade to oauth_tokens at 170-175 runs only for role or prefixes changes.
- `src/auth.js:195`: Only explicit revokeKey removes derived tokens (by key_id). No code path handles expiry, and the scheduled handler (src/index.js:897-912) does no token cleanup.
- `ui/src/views/KeysView.tsx:238`: New keys default to a 90-day expiry in the UI, so expiring keys are the normal case.

### Principals
Holder of a time-limited read key scoped to vault/projects/alpha/ (for example a guest or contractor) who keeps access after the key's expiry.

### Native input
```
createKey {name:'guest-dummy', role:'read', prefixes:['vault/projects/alpha/'], expires_days:1}
```
```
POST /app/login access_key=<key>
```
```
POST /register {}; POST /authorize client_id=<id>&redirect_uri=https://cb.test/&access_key=<key>; POST /token grant_type=authorization_code&code=<code>
```
```
advance clock 2 days; GET /app/api/me Cookie: brain_session=<session>; resolve the access token
```
```
updateKey(id,{expires_days:1}); advance 2 days
```
```
4 x (advance 80 days; POST /token grant_type=refresh_token&refresh_token=<latest>)
```

### Bounded instructions
1. Run agents/verify-05/artifacts/expiry-check.mjs in the approved sandbox. It imports the real src/oauth.js, src/app.js and src/auth.js against an in-memory node:sqlite D1 shim built from schema.sql, with fetch stubbed to throw. It uses dummy principals only.
2. The clock is advanced by shifting every stored api_keys.expires, oauth_tokens.exp and oauth_codes.exp back by N days. This is equivalent for the datetime('now') comparisons the code uses.
3. Observe how the key, the web session, the OAuth access token and the refresh chain resolve after the key's expiry.

### Observed output
The key's expires was now+1 day. The webapp session and the OAuth access token got exp now+30 days and the refresh token exp now+90 days, all with key_id set. At +2 days the raw key resolved to null and consent with it returned 403. The session still returned 200 on /app/api/me as role read with prefixes [vault/projects/alpha/], and the OAuth access token still resolved as role read with the same scope. After updateKey(expires_days:1) and a further 2 days, the key was again null and the access token still worked. Refreshes at +84, +164, +244 and +324 days each returned 200. At +324 days the latest refreshed access token resolved as role read, scope vault/projects/alpha/, and the current refresh row expired 90 days in the future. The web session had lapsed by then at its own fixed 30-day exp.

### Conditions and containment
- **data state**: The operator issued the key with an expiry (expires_days set) and relies on expiry, not explicit revocation, to end access.
- **authentication level**: The key holder logs in to the web app or completes the OAuth consent and code exchange at least once before the key expires.

### Remediation
Cap every derived exp (web session, authorization code, access and refresh tokens) at the parent key's expires when inserting. In resolvePrincipal's oauth_tokens branch and in the refresh grant, LEFT JOIN api_keys on key_id and reject the token when the parent key is revoked or expired. When updateKey changes expires_days, cascade it to derived tokens, or rely on the join. Regression test: after the key's expiry passes, the session cookie, the access token and the refresh grant are all rejected.

`src/auth.js`

```js
const tok = await env.DB.prepare("SELECT t.role, t.prefixes, t.client_id, t.key_id FROM oauth_tokens t LEFT JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ? AND t.kind = 'access' AND t.exp > datetime('now') AND (t.key_id IS NULL OR (k.id IS NOT NULL AND k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now'))))").bind(hash).first().catch(() => null);
```

`src/oauth.js`

```js
const row = await env.DB.prepare("SELECT t.client_id, t.role, t.prefixes, t.key_id FROM oauth_tokens t LEFT JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ? AND t.kind = 'refresh' AND t.exp > datetime('now') AND (t.key_id IS NULL OR (k.id IS NOT NULL AND k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now'))))").bind(hash).first();
// and in issue()/app login: exp = CASE WHEN key.expires IS NOT NULL AND key.expires <> '' THEN MIN(datetime('now','+30 days'), key.expires) ELSE datetime('now','+30 days') END
```

## Sessions and OAuth tokens minted from another token have no key_id, so they survive key revocation, key narrowing and root-token rotation

`src/auth.js:resolvePrincipal/oauth-branch-drops-key_id` · **medium**

### Trace
1. **entrypoint** `src/app.js:129` (handleApp POST /app/login): Unauthenticated form POST. access_key can be the caller's own brain_session value S1, minted from managed key K, or an OAuth access token. POST /authorize (src/oauth.js:104-106) is an equivalent entrypoint.
2. **propagation** `src/app.js:131` (handleApp POST /app/login): resolvePrincipal is called on access_key. The value misses api_keys and matches an unexpired oauth_tokens access row.
3. **propagation** `src/auth.js:98` (resolvePrincipal oauth branch): The query is SELECT role, prefixes, client_id FROM oauth_tokens. key_id is not read, and the parent key's revoked or expires state is not checked.
4. **propagation** `src/auth.js:102` (resolvePrincipal oauth branch): The principal is returned with the source token's role and scopes but no keyId.
5. **propagation** `src/app.js:136` (handleApp POST /app/login): The new 30-day session row is bound with principal.keyId || null, so key_id is NULL. POST /authorize does the same for the code at src/oauth.js:113, and /token copies it into the access and refresh rows (src/oauth.js:127-129, 151-154).
6. **propagation** `src/auth.js:171` (updateKey): Narrowing updates only oauth_tokens WHERE key_id = id, so NULL-linked rows keep the old role and scopes.
7. **sink** `src/auth.js:195` (revokeKey): DELETE FROM oauth_tokens WHERE key_id = ? skips the NULL-linked rows. They keep authorizing /app/api/*, /mcp and refresh.

### Evidence
- `src/auth.js:94`: Only the managed-key branch sets keyId.
- `src/auth.js:83`: The root principal has no keyId and no generation marker, so root-derived rows cannot be tied to BRAIN_TOKEN rotation.
- `src/auth.js:98`: The oauth token lookup leaves out key_id and does not check the parent key.
- `src/oauth.js:113`: The consent code stores principal.keyId || null.
- `src/oauth.js:151`: Refresh copies key_id (NULL) into each rotated pair, so the laundered chain never ends.
- `schema.sql:53`: key_id is documented as the revocation link for oauth_tokens.
- `src/auth.js:136`: The updateKey comment says sessions and tokens minted from the key are narrowed too.

### Principals
A contractor holds a managed write key scoped to vault/projects/alpha/ and expects to be downgraded and then offboarded.

### Native input
```
POST /app/login access_key=<bk_ key K> -> brain_session S1 (key_id=K)
```
```
POST /app/login access_key=<S1> -> brain_session S2 (key_id NULL)
```
```
POST /authorize access_key=<S1>&client_id=<registered>&redirect_uri=https://client.test/cb, then POST /token grant_type=authorization_code
```
```
operator: PATCH /app/api/keys {id:K, role:'read'}; POST /app/api/keys/revoke {id:K}
```
```
GET /app/api/me and GET /app/api/note?path=vault/projects/alpha/plan.md with Cookie brain_session=S2; POST /mcp with the laundered bearer token; POST /token grant_type=refresh_token
```

### Bounded instructions
1. Run agents/verify-06/artifacts/v06_lineage.mjs in the approved sandbox. It loads the repo's schema.sql into an in-memory node:sqlite database wrapped as D1, stubs fetch to fail, uses dummy secrets, and sends every request through the real Worker router in src/index.js.
2. As root, create key K (write, vault/projects/alpha/). Log in with K to get S1, then log in with S1 to get S2. Register a client, run /authorize with S1, and exchange the code.
3. As root, PATCH K to role read, then revoke K. Query S1, S2 and the laundered tokens, read the alpha note with S2, call /mcp, and refresh the laundered token.
4. Log in with BRAIN_TOKEN, change env.BRAIN_TOKEN, and query the root-minted session.

### Observed output
S1 had key_id set to K. S2, the consent code, and the laundered access and refresh tokens all had key_id null. After PATCH role=read, S1 showed role read, but S2 and the laundered access token still showed role write with prefixes [vault/projects/alpha/]. After revoke, logging in with K returned 403 and S1 returned 401, and S1's row was deleted. S2 still returned 200 with role write, and S2 read the alpha note (200). The laundered access token returned 200 on /app/api/me and on POST /mcp tools/list. Refreshing the laundered refresh token returned 200, and the new access token had role write and key_id null. After BRAIN_TOKEN rotation, the old root token returned 401, but the root-minted session returned 200 with role admin and prefixes [].

### Conditions and containment
- **authentication level**: The attacker holds a valid managed key, or a session or OAuth token derived from one, such as their own browser cookie. For the root case, they hold a root-derived session.
- **timing dependency**: Laundering must happen before the operator revokes or narrows the key, or rotates BRAIN_TOKEN. Sessions can be laundered again before their 30-day expiry, and refresh tokens rotate with no end.

### Remediation
Carry key lineage through the oauth branch. Select t.key_id, return keyId, and have resolvePrincipal reject a derived token whose parent key is revoked, expired or deleted, so any row that escapes the cascade still fails closed. This also closes the gap where an expired key's derived tokens live on. Optionally re-read the parent key's current role and scopes there. Give root-derived rows a root-generation marker, such as a short hash of BRAIN_TOKEN checked on resolve, so rotation invalidates them. Consider making /app/login and consent accept only primary credentials, and add a logout endpoint that deletes the current session row. Regression tests: session-from-session, OAuth-from-session and refresh-after-revoke all fail after revokeKey, and all narrow after updateKey.

`src/auth.js`

```js
const tok = await env.DB.prepare(
  "SELECT t.role, t.prefixes, t.client_id, t.key_id FROM oauth_tokens t LEFT JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ? AND t.kind = 'access' AND t.exp > datetime('now') AND (t.key_id IS NULL OR (k.id IS NOT NULL AND k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now'))))"
).bind(hash).first().catch(() => null);
if (tok) {
  const scopes = JSON.parse(tok.prefixes || '[]');
  return { role: tok.role || 'read', scopes, prefixes: await expandScopes(env, scopes), via: 'oauth', name: tok.client_id, keyId: tok.key_id || undefined };
}
```

`src/oauth.js`

```js
// refresh_token grant: apply the same parent-key check before rotating
const row = await env.DB.prepare("SELECT t.client_id, t.role, t.prefixes, t.key_id FROM oauth_tokens t LEFT JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ? AND t.kind = 'refresh' AND t.exp > datetime('now') AND (t.key_id IS NULL OR (k.id IS NOT NULL AND k.revoked = 0 AND (k.expires IS NULL OR k.expires = '' OR k.expires > datetime('now'))))").bind(hash).first();
```

## Authorization codes go to any redirect_uri, and the consent page never shows the client or destination

`src/oauth.js:authorize-redirect-uri-not-bound-to-client` · **medium**

### Trace
1. **entrypoint** `src/oauth.js:67` (POST /register): Anonymous dynamic client registration. Any caller can create a client, and redirect_uris defaults to [] (line 70).
2. **propagation** `src/oauth.js:90` (GET /authorize): The redirect_uri check is skipped when uris.length is 0, so the consent page renders for any redirect_uri.
3. **propagation** `src/oauth.js:98` (GET /authorize consent HTML): The visible text names neither the client nor the redirect destination. The destination appears only in a hidden input.
4. **propagation** `src/oauth.js:108` (POST /authorize): redirect_uri is read from the form. The client is not looked up and registered URIs are not compared.
5. **propagation** `src/oauth.js:110` (POST /authorize): The code row stores the victim principal's role, scopes and key_id, bound to the attacker-chosen client_id, redirect_uri and optional challenge.
6. **propagation** `src/oauth.js:114` (POST /authorize): 302 redirect to the attacker-supplied redirect_uri with code and state.
7. **sink** `src/oauth.js:146` (POST /token authorization_code): The code is redeemed without client authentication or a client_id comparison. PKCE is skipped because no challenge was stored, and redirect_uri is optional. Access and refresh tokens are issued with the victim's role and scopes.

### Evidence
- `src/oauth.js:90`: if (uris.length && !uris.includes(redirect_uri)) is the only redirect check, and it runs only on GET.
- `src/oauth.js:112`: The INSERT binds form.get('client_id') and redirect_uri without any oauth_clients lookup.
- `src/oauth.js:139`: PKCE is enforced only when a challenge was stored, so it is optional.
- `src/oauth.js:143`: /token compares redirect_uri only if the request includes it, and never compares client_id.
- `src/auth.js:102`: An OAuth access token resolves to the stored role and scopes (role defaults to admin).
- `src/oauth.js:113`: principal.keyId is undefined for the root token, so the code and the tokens derived from it store key_id null and no key revocation can cascade to them.

### Principals
Anonymous internet user who can send a link to someone holding a BrainMCP access key.

### Native input
```
POST /register {} -> client_id C (no redirect_uris)
```
```
GET /authorize?client_id=C&redirect_uri=https://evil.test/c&state=sc
```
```
POST /authorize client_id=<client registered with https://claude.test/cb>&redirect_uri=https://evil.test/a&state=sA&access_key=<dummy victim key>
```
```
POST /authorize client_id=nope-never-registered&redirect_uri=https://evil.test/b&access_key=<dummy victim key>
```
```
POST /token grant_type=authorization_code&code=<code delivered to evil.test>
```
```
POST /token grant_type=authorization_code&code=<code issued to client A>&client_id=some-other-client
```

### Bounded instructions
1. Run agents/verify-17/artifacts/verify-oauth-binding.mjs in the approved sandbox (python3 tools/sbx.py run <run-dir> verify-17 verify-oauth-binding.mjs). It loads /target/src/oauth.js and /target/src/auth.js against an in-memory node:sqlite D1 shim built from schema.sql, with fetch stubbed to throw.
2. The harness creates a dummy write key scoped to vault/projects/alpha/ with createKey.
3. It registers a client with redirect_uris ['https://claude.test/cb'], confirms GET /authorize rejects https://evil.test/a, then POSTs /authorize with that client and URI, and again with a never-registered client_id.
4. It registers a client with no redirect_uris, GETs /authorize with an evil.test redirect, and extracts the page's visible text.
5. It redeems the evil.test code at /token with only grant_type and code and runs resolvePrincipal on the returned access token. It also redeems a second code while claiming a different client_id, and repeats the flow with the dummy root token to inspect key_id.

### Observed output
GET with an unregistered URI on the registered client returned 400. POST returned 302 to evil.test for the registered client and for the never-registered client_id. GET for the empty-registration client returned 200, and the visible text was 'A client is requesting access to the brain. Paste your access key — the connection inherits that key's scopes. Authorize', with no client_id or destination host. POST /token with only grant_type and code returned 200 with a refresh token, and the access token resolved to {role:'write', scopes:['vault/projects/alpha/'], via:'oauth'}. A code redeemed while claiming a different client_id also returned 200. With the dummy root token, the token resolved to {role:'admin', scopes:[]} and its row had key_id null. A bogus key at POST /authorize returned 403 (control).

### Conditions and containment
- **user interaction**: A key holder follows the attacker's link to the real BrainMCP /authorize page and pastes their access key.
- **authentication level**: The attacker needs no credentials. /register, GET /authorize and /token are anonymous.
- **authorization role**: The token inherits whatever role and scopes the victim's key has, up to whole-brain admin if the root token is pasted.

### Remediation
In POST /authorize, look up the client and require redirect_uri to exactly match a registered URI, and reject clients that registered none (share the check with GET). Require S256 PKCE. Render the escaped client name and the redirect host on the consent page. At /token, require client_id and redirect_uri to match the code row.

`src/oauth.js`

```js
// shared helper used by GET and POST /authorize
async function checkClient(env, client_id, redirect_uri) {
  const c = await env.DB.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').bind(client_id).first();
  if (!c) return 'unknown client_id';
  const uris = JSON.parse(c.redirect_uris || '[]');
  if (!uris.length || !uris.includes(redirect_uri)) return 'redirect_uri not registered';
  return null;
}
// POST /authorize, before resolvePrincipal:
const bad = await checkClient(env, form.get('client_id') || '', form.get('redirect_uri') || '');
if (bad) return new Response(bad, { status: 400 });
if (!form.get('code_challenge') || form.get('code_challenge_method') !== 'S256') return new Response('PKCE S256 required', { status: 400 });
// GET /authorize consent text: show escaped client_name and new URL(redirect_uri).host
// POST /token authorization_code: require form client_id === row.client_id and form redirect_uri === row.redirect_uri
```
