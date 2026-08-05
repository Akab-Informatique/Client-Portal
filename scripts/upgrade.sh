#!/usr/bin/env bash
# Safe production upgrade — pull code, rebuild app, keep Postgres volume.
# Usage:
#   bash scripts/upgrade.sh
#   bash scripts/upgrade.sh v1.1.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REF="${1:-}"
PORT_VAL="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT_VAL}"

echo "==> Pre-upgrade backup (best effort)"
if [[ -f ./scripts/backup-db.sh ]]; then
  bash ./scripts/backup-db.sh ./backups || echo "WARN: backup skipped"
fi

echo "==> Fetch code"
git fetch --tags --prune origin || true
if [[ -n "$REF" ]]; then
  git checkout "$REF"
  git reset --hard "$REF" 2>/dev/null || true
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"
  git pull --ff-only origin "$BRANCH" 2>/dev/null || git reset --hard "origin/$BRANCH"
fi
echo "    HEAD: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Soft-check Autotask secret quoting before rebuild (does not print secret)
if [[ -f .env ]]; then
  if grep -Eq '^[[:space:]]*AUTOTASK_SECRET=' .env; then
    if grep -Eq "^[[:space:]]*AUTOTASK_SECRET='[^']+'" .env; then
      echo "==> Autotask secret: single-quoted (good)"
    elif grep -Eq '^[[:space:]]*AUTOTASK_SECRET="[^"]+"' .env; then
      echo "WARN: AUTOTASK_SECRET uses double quotes — \$ inside may still expand."
      echo "      Prefer: AUTOTASK_SECRET='your-full-secret'"
    else
      echo "WARN: AUTOTASK_SECRET is unquoted. If it contains \$ or # Autotask will 401."
      echo "      Fix: AUTOTASK_SECRET='your-full-secret'"
    fi
  else
    echo "WARN: AUTOTASK_SECRET not set in .env — Autotask will stay disconnected"
  fi
else
  echo "WARN: .env missing at $ROOT/.env"
fi

echo "==> Rebuild + recreate app (volume akab_pgdata is preserved)"
# --force-recreate ensures new env mount + image are picked up
docker compose up -d --build --force-recreate app
# Make sure db is up too (no recreate — keeps volume)
docker compose up -d db

echo "==> Wait for app health (up to ~90s)"
ok=0
for i in $(seq 1 45); do
  if curl -fsS -m 3 "${BASE}/api/health" >/dev/null 2>&1; then
    ok=1
    echo "    health OK (attempt $i)"
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: /api/health never became ready"
  docker compose ps
  docker compose logs --tail=80 app
  exit 1
fi

docker compose ps

echo "==> Run DB migrations (additive)"
migrate_json="$(curl -sS -m 45 "${BASE}/api/db/status?migrate=1" || true)"
echo "$migrate_json" | head -c 2000
echo
if echo "$migrate_json" | grep -q '"ok":true\|"ok": true'; then
  echo "    migrate OK"
else
  echo "WARN: migrate did not report ok — check logs: docker compose logs --tail=100 app"
fi
# Highlight company_id schema flag when present
if echo "$migrate_json" | grep -q 'client_roles_company_id'; then
  echo "$migrate_json" | grep -o '"client_roles_company_id":[^,}]*' || true
fi

echo "==> Autotask status"
at_json="$(curl -sS -m 30 "${BASE}/api/autotask/status?refresh=1" || true)"
echo "$at_json" | head -c 2500
echo
if echo "$at_json" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "    Autotask CONNECTED"
else
  echo "WARN: Autotask not connected"
  echo "    1) Edit $ROOT/.env — single-quote the secret:"
  echo "         AUTOTASK_SECRET='paste-full-secret-here'"
  echo "       Username must be the API Username (Key), not login email."
  echo "    2) Recreate app only (no rebuild needed for env):"
  echo "         docker compose up -d --force-recreate app"
  echo "    3) Retest:"
  echo "         curl -sS '${BASE}/api/autotask/status?refresh=1'"
fi

echo
echo "OK — upgrade finished. Data volume was NOT deleted."
echo "Hard-refresh the browser (Ctrl+Shift+R)."
