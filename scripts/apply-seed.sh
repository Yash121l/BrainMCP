#!/usr/bin/env bash
# Apply seed shards to the remote D1 database, in order.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in .seed/seed-*.sql; do
  echo ">> $f"
  npx wrangler d1 execute brain-index --remote --file "$f" -y
done
echo "seed applied."
