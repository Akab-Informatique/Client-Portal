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
  # After a rollback (upgrade.sh vX.Y.Z) HEAD is detached — return to master
  # instead of resolving "origin/HEAD".
  if [[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]]; then
    BRANCH="master"
    git checkout "$BRANCH"
  fi
  if ! git pull --ff-only origin "$BRANCH"; then
    echo "ERROR: cannot fast-forward $BRANCH (local edits or rewritten history)." >&2
    echo "       Inspect with: git status && git log --oneline -5 origin/$BRANCH" >&2
    echo "       Nothing was changed; the running portal is untouched." >&2
    exit 1
  fi
fi
echo "    HEAD: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# The app container runs as uid/gid 1000 and re-reads the mounted .env
if [[ -f .env ]]; then
  if [[ "$(stat -c %g .env)" != "1000" ]] || [[ "$(stat -c %A .env | cut -c5)" != "r" ]]; then
    if chgrp 1000 .env 2>/dev/null && chmod 640 .env 2>/dev/null; then
      echo "==> .env: group 1000 read access set (app container runs unprivileged)"
    else
      echo "WARN: the app container (gid 1000) cannot read .env. Run once:"
      echo "      sudo chgrp 1000 $ROOT/.env && sudo chmod 640 $ROOT/.env"
    fi
  fi
fi

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

# Diagnostics run INSIDE the app container: status routes answer loopback
# callers without a session, but never requests coming through the proxy.
in_app() {
  docker compose exec -T app sh -c \
    "curl -sS -m ${2:-30} -H \"x-akab-probe: \$(cat /tmp/akab-probe-token 2>/dev/null)\" 'http://127.0.0.1:3000$1'" \
    2>/dev/null || true
}

echo "==> Run DB migrations (additive)"
migrate_json="$(in_app "/api/db/status?migrate=1" 45)"
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
at_json="$(in_app "/api/autotask/status?refresh=1" 30)"
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
  echo "         docker compose exec -T app curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'"
fi

echo "==> Security checks"
app_log="$(docker compose logs --no-color app 2>/dev/null | tail -n 400 || true)"
if echo "$app_log" | grep -q "SQL proxy isolation: role + row-level security ready"; then
  echo "    SQL proxy isolation: active"
else
  echo "WARN: SQL proxy row-level security is NOT active — see: docker compose logs app | grep -i isolation"
fi
if echo "$app_log" | grep -q "DEFAULT ADMIN PASSWORD"; then
  echo "WARN: an account still uses the default password admin123 — change it in the portal now."
fi
if echo "$app_log" | grep -q "cannot read /app/.env"; then
  echo "WARN: app cannot read .env — run: sudo chgrp 1000 $ROOT/.env && sudo chmod 640 $ROOT/.env"
fi
if grep -Eq '^[[:space:]]*COOKIE_SECURE=(false|0)' .env 2>/dev/null; then
  echo "WARN: COOKIE_SECURE=false in .env — remove it (portal is served over HTTPS)."
fi

echo
echo "OK — upgrade finished. Data volume was NOT deleted."
echo "Hard-refresh the browser (Ctrl+Shift+R)."
