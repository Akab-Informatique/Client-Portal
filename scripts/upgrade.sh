#!/usr/bin/env bash
# Safe production upgrade — pulls code, rebuilds app, keeps Postgres volume.
#
# Usage (on the server, inside the app directory):
#   bash scripts/upgrade.sh
#   bash scripts/upgrade.sh v1.1.0     # checkout a tag
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF="${1:-}"

echo "==> Pre-upgrade backup"
if [[ -f ./scripts/backup-db.sh ]]; then
  bash ./scripts/backup-db.sh ./backups || echo "WARN: backup skipped (db not running yet?)"
else
  echo "WARN: backup script missing (scripts/backup-db.sh) — pull latest git"
fi

echo "==> Fetch latest code"
git fetch --tags --prune origin || true

if [[ -n "$REF" ]]; then
  echo "==> Checkout $REF"
  git checkout "$REF"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  echo "==> Pull $BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

echo "==> Rebuild & restart (volume akab_pgdata is preserved)"
docker compose up -d --build

echo "==> Wait for health"
sleep 3
docker compose ps

echo "==> DB status"
curl -sf "http://127.0.0.1:${PORT:-3000}/api/db/status?migrate=1" | head -c 500 || true
echo
echo "OK — upgrade finished. Portal data volume was NOT deleted."
