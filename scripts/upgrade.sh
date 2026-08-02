#!/usr/bin/env bash
# Safe production upgrade — pull code, rebuild app, keep Postgres volume.
# Usage:
#   bash scripts/upgrade.sh
#   bash scripts/upgrade.sh v1.1.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REF="${1:-}"

echo "==> Pre-upgrade backup (best effort)"
if [[ -f ./scripts/backup-db.sh ]]; then
  bash ./scripts/backup-db.sh ./backups || echo "WARN: backup skipped"
fi

echo "==> Fetch code"
git fetch --tags --prune origin || true
if [[ -n "$REF" ]]; then
  git checkout "$REF"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  git pull --ff-only origin "$BRANCH" || git reset --hard "origin/$BRANCH"
fi

echo "==> Rebuild (volume akab_pgdata is preserved)"
docker compose up -d --build

echo "==> Wait"
sleep 5
docker compose ps

PORT_VAL="${PORT:-3000}"
echo "==> Health"
curl -sS -m 5 "http://127.0.0.1:${PORT_VAL}/api/health" || true
echo
curl -sS -m 10 "http://127.0.0.1:${PORT_VAL}/api/db/status" || true
echo
curl -sS -m 30 "http://127.0.0.1:${PORT_VAL}/api/db/status?migrate=1" || true
echo
echo "OK — upgrade finished. Data volume was NOT deleted."
