# Deploying / migrating BrainMCP to a Cloudflare account

Everything is portable: D1 is rebuilt from the brain repo, keys are re-creatable,
secrets are re-generated. Nothing in the old account is precious.

## Prereqs on the machine doing the deploy
- `gh` logged in as **Yash121l** (webhook creation + the repo)
- `wrangler` logged into the **target** Cloudflare account (`npx wrangler login`)
- A **fine-grained GitHub PAT**: repo `Yash121l/brain` only, permission **Contents: Read & write**

## CI (normal path)
Every push to `main` auto-deploys via GitHub Actions (`.github/workflows/deploy.yml`).
It needs two repo secrets (Settings → Secrets and variables → Actions), or via CLI:
```bash
gh secret set CLOUDFLARE_API_TOKEN   # dash.cloudflare.com → My Profile → API Tokens → "Edit Cloudflare Workers" template
gh secret set CLOUDFLARE_ACCOUNT_ID  # `npx wrangler whoami` on the target account
```

## R2 bucket (telemetry cold storage)
The `LOGS` binding in `wrangler.jsonc` needs the bucket to exist before the first
deploy on a new account:
```bash
npx wrangler r2 bucket create brain-logs
```
Nothing precious lives there. Losing it costs you historical tool-call logs and
nothing else; the brain itself is in git.

## Gateway rollout (control schema 4)
The Worker creates the new tables on its first request, and `wrangler deploy` adds the
`ConnectionDO` and `BridgeDO` classes (migration `v2`). One secret is new:
```bash
openssl rand -base64 32 | tee ~/.config/brain-mcp/vault-kek-backup | npx wrangler secret put VAULT_KEK
chmod 600 ~/.config/brain-mcp/vault-kek-backup
```
Without it, only connections with `auth: none` work; the console says so.

Optional, off by default in `wrangler.jsonc`:
- **Semantic memory.** `npx wrangler vectorize create brain-notes --dimensions=1024 --metric=cosine`,
  uncomment the `ai` and `vectorize` bindings, deploy, then `POST /admin/embed` (the nightly cron keeps it current).
- **Code mode** (`run_code`). Needs the Workers Paid plan. Uncomment
  `compatibility_flags: ["enable_ctx_exports"]` and `worker_loaders`. Each distinct
  snippet is a new Dynamic Worker (1,000 a month included, then $0.002 each per day).

## Setting up a machine (Mac, VPS, anything with Claude Code)
No checkout, no clone, no sync daemon. Two commands and a scoped key:
```bash
claude mcp add --scope user --transport http brain https://brain.yashlunawat.com/mcp \
  --header "Authorization: Bearer $BRAIN_KEY"
curl -fsSL -H "Authorization: Bearer $BRAIN_KEY" \
  https://brain.yashlunawat.com/hooks/install.sh | BRAIN_KEY=$BRAIN_KEY sh
```
The first makes the brain reachable from every directory. The second installs the
telemetry hook and is optional: skip it on a machine you don't want tool-call logs
from, and everything else still works. Mint a per-machine key in the Keys tab
rather than reusing one, so a lost VPS is one revocation.

## One command (first-time account setup)
```bash
git clone https://github.com/Yash121l/BrainMCP.git && cd BrainMCP && npm install
npx wrangler login          # into the TARGET account
bash scripts/setup.sh       # d1 + schema + secrets + deploy + webhook + reindex
```
The script prints the new URL and a checklist of the places that reference it
(.mcp.json, docs/CONNECT.md, CLAUDE.md/AGENTS.md in the brain repo; `claude mcp add`
and `~/.codex/config.toml` on each machine; the claude.ai connector).

## Access keys
Keys live in D1 (`api_keys`), managed in the web UI (`<url>` → Keys tab, admin only):
one key per person or machine, a role, and a scope. They do NOT migrate across
accounts — mint fresh ones after moving.
- role: `read` | `write` | `admin`
- scope: empty = the whole brain, otherwise any mix of path prefixes (`vault/logs/`)
  and project scopes (`project:<slug>`). A project scope resolves on every request to
  the project note plus every note filed under that project, so notes written later
  are covered without re-issuing the key.
- **Grant access** mints the key and hands back the three things the person needs:
  the key for web sign-in, the `claude mcp add` line, and the skills installer.
- **Edit** re-scopes a key in place (role, scope, expiry) and takes effect on that
  person's live web session and connector tokens immediately — narrowing access no
  longer means handing out a new secret.
- a writer also needs the folder new files land in (`vault/logs/` for sessions and
  decisions); a project scope alone only covers notes that already exist
- a machine key for telemetry needs `write` (the ingest endpoint rejects read-only keys)
- revoking a key also kills every web session and claude.ai connector token minted from it
- `BRAIN_TOKEN` (worker secret) is break-glass admin only — rotate freely:
  `openssl rand -hex 32 | npx wrangler secret put BRAIN_TOKEN` (update `~/.config/brain-mcp/credentials`)

## Running it locally
```bash
npm install && npm run ui:build
printf 'BRAIN_TOKEN=local-dev-only\n' > .dev.vars
BRAIN_DIR=~/obsidian/brain npm run seed:local   # schema + the whole vault into the dev sqlite
npm run dev                                     # http://localhost:8788
```
Sign in with the `BRAIN_TOKEN` value from `.dev.vars`. The session cookie drops its
`Secure` flag on loopback only, so plain http works locally while production stays
https-only. The local D1 lives in `.wrangler/` and is disposable.

## Old account teardown (after verifying the new URL)
```bash
npx wrangler delete --name brain-mcp     # while logged into the OLD account
npx wrangler d1 delete brain-index
```
Also delete the old webhook in github.com/Yash121l/brain → Settings → Webhooks.
