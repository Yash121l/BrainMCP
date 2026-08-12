# Deploying / migrating BrainMCP to a Cloudflare account

Everything is portable: D1 is rebuilt from the brain repo, keys are re-creatable,
secrets are re-generated. Nothing in the old account is precious.

## Prereqs on the machine doing the deploy
- `gh` logged in as **Yash121l** (webhook creation + the repo)
- `wrangler` logged into the **target** Cloudflare account (`npx wrangler login`)
- A **fine-grained GitHub PAT**: repo `Yash121l/brain` only, permission **Contents: Read & write**

## One command
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
- revoking a key also kills every web session and claude.ai connector token minted from it
- `BRAIN_TOKEN` (worker secret) is break-glass admin only — rotate freely:
  `openssl rand -hex 32 | npx wrangler secret put BRAIN_TOKEN` (update `~/.config/brain-mcp/credentials`)

## Old account teardown (after verifying the new URL)
```bash
npx wrangler delete --name brain-mcp     # while logged into the OLD account
npx wrangler d1 delete brain-index
```
Also delete the old webhook in github.com/Yash121l/brain → Settings → Webhooks.
