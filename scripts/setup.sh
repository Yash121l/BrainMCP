#!/usr/bin/env bash
# One-shot setup/migration of BrainMCP onto the CURRENTLY LOGGED-IN Cloudflare account.
# Idempotent-ish: safe to re-run. Run from the repo root: bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/6 account check =="
npx wrangler whoami | head -5

echo "== 2/6 D1 database =="
if ! npx wrangler d1 list 2>/dev/null | grep -q brain-index; then
  npx wrangler d1 create brain-index
fi
DBID=$(npx wrangler d1 list --json | python3 -c "import json,sys; print([d['uuid'] for d in json.load(sys.stdin) if d['name']=='brain-index'][0])")
python3 - "$DBID" <<'PY'
import re, sys
p = 'wrangler.jsonc'
t = open(p).read()
t = re.sub(r'"database_id": "[^"]*"', f'"database_id": "{sys.argv[1]}"', t)
open(p, 'w').write(t)
print('wrangler.jsonc database_id ->', sys.argv[1])
PY
npx wrangler d1 execute brain-index --remote --file schema.sql -y >/dev/null && echo "schema applied"

echo "== 3/6 secrets =="
mkdir -p ~/.config/brain-mcp && chmod 700 ~/.config/brain-mcp
if [ ! -f ~/.config/brain-mcp/credentials ]; then
  BRAIN_TOKEN=$(openssl rand -hex 32)
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  printf 'BRAIN_TOKEN=%s\nWEBHOOK_SECRET=%s\n' "$BRAIN_TOKEN" "$WEBHOOK_SECRET" > ~/.config/brain-mcp/credentials
  chmod 600 ~/.config/brain-mcp/credentials
  echo "generated new ~/.config/brain-mcp/credentials"
fi
source ~/.config/brain-mcp/credentials
printf '%s' "$BRAIN_TOKEN"    | npx wrangler secret put BRAIN_TOKEN
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET
if [ -n "${GH_PAT:-}" ]; then printf '%s' "$GH_PAT" | npx wrangler secret put GITHUB_TOKEN
else echo ">> now paste the fine-grained PAT (Contents R/W on Yash121l/brain only):"; npx wrangler secret put GITHUB_TOKEN; fi

echo "== 4/6 deploy =="
# the browser UI is a React SPA uploaded as static assets — build it first
(cd ui && npm install --no-audit --no-fund && npm run build)
URL=$(npx wrangler deploy 2>&1 | grep -o 'https://[^ ]*workers.dev' | head -1)
echo "deployed: $URL"
grep -q "^MCP_URL=" ~/.config/brain-mcp/credentials && sed -i '' "s|^MCP_URL=.*|MCP_URL=$URL/mcp|" ~/.config/brain-mcp/credentials || echo "MCP_URL=$URL/mcp" >> ~/.config/brain-mcp/credentials

echo "== 5/6 webhook on Yash121l/brain =="
EXISTING=$(gh api repos/Yash121l/brain/hooks --jq "[.[] | select(.config.url == \"$URL/webhook\")] | length")
if [ "$EXISTING" = "0" ]; then
  gh api repos/Yash121l/brain/hooks -X POST -f name=web -F active=true -f 'events[]=push' \
    -f "config[url]=$URL/webhook" -f 'config[content_type]=json' -f "config[secret]=$WEBHOOK_SECRET" --jq '.id'
  echo "webhook created (delete any old-account webhook in the repo settings)"
else echo "webhook already present"; fi

echo "== 6/6 seed index =="
curl -s -m 120 -X POST -H "Authorization: Bearer $BRAIN_TOKEN" "$URL/admin/reindex"; echo
curl -s "$URL/health"; echo

cat <<EOF

DONE. Post-migration checklist (URL changed to $URL):
  - .mcp.json in the brain repo           -> update url
  - docs/CONNECT.md + CLAUDE.md/AGENTS.md -> update url
  - claude mcp add / codex config on each machine
  - claude.ai connector                    -> re-add with new URL
  - re-create access keys at $URL/app (Keys tab) — keys live in the old account's D1
EOF
