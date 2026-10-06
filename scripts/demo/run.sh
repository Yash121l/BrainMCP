#!/bin/sh
# Fresh local demo: wipe local state, start the fake apps and wrangler dev, seed.
#   sh scripts/demo/run.sh            (console at http://localhost:8787)
set -eu
cd "$(dirname "$0")/../.."
D=${DEMO_DIR:-/tmp/claude/brain-local}
mkdir -p "$D"
export npm_config_cache="$D/npmcache"
cat > "$D/dev.vars" <<VARS
BRAIN_TOKEN=local-dev-root-token-0000000000000000
BRAIN_KEK=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
VAULT_KEK=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=
GITHUB_TOKEN=x
WEBHOOK_SECRET=x
DEV_ALLOW_LOCAL_UPSTREAMS=true
VARS
pkill -f "port 8787" 2>/dev/null || true
pkill -f "scripts/demo/fake-apps.mjs" 2>/dev/null || true
rm -rf "$D/state"
npm --prefix ui run build >/dev/null
npx wrangler d1 execute brain-index --local --persist-to "$D/state" --file=schema.sql >/dev/null
node scripts/demo/fake-apps.mjs 8790 > "$D/fake-apps.log" 2>&1 &
npx wrangler dev --local --port 8787 --env-file "$D/dev.vars" --persist-to "$D/state" > "$D/wrangler.log" 2>&1 &
i=0; until curl -s localhost:8787/health >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "wrangler did not start; see $D/wrangler.log"; exit 1; }; sleep 1; done
PERSIST="$D/state" node scripts/demo/seed.mjs
