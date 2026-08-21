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
Keys live in D1 (`api_keys`), managed in the web UI (`<url>` → Keys tab, admin only).
They do NOT migrate across accounts — mint fresh ones after moving.
- role: `read` | `write` | `admin`; prefixes: path scopes (`[]` = everything)
- a collaborator key for one project: role `write`, prefixes
  `vault/projects/<slug>.md, vault/rules/<slug>.md, vault/topics/, vault/logs/`
- a machine key for telemetry needs `write` (the ingest endpoint rejects read-only keys)
- revoking a key also kills every web session and claude.ai connector token minted from it
- `BRAIN_TOKEN` (worker secret) is break-glass admin only — rotate freely:
  `openssl rand -hex 32 | npx wrangler secret put BRAIN_TOKEN` (update `~/.config/brain-mcp/credentials`)

## Old account teardown (after verifying the new URL)
```bash
npx wrangler delete --name brain-mcp     # while logged into the OLD account
npx wrangler d1 delete brain-index
```
Also delete the old webhook in github.com/Yash121l/brain → Settings → Webhooks.
