#!/usr/bin/env bash
# Apply seed shards to D1, in order. Defaults to the remote database; pass --local
# to fill the `wrangler dev` sqlite instead (schema included, since a fresh local
# database has no tables yet).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:---remote}"
if [ "$TARGET" = "--local" ]; then
  npx wrangler d1 execute brain-index --local --file schema.sql -y
fi
for f in .seed/seed-*.sql; do
  echo ">> $f"
  npx wrangler d1 execute brain-index "$TARGET" --file "$f" -y
done
echo "seed applied ($TARGET)."
