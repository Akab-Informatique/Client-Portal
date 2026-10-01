#!/usr/bin/env bash
# AKAB Portal — first install / repair on Ubuntu 22.04+ / 24.04 / 26.x or Debian 12/13
# Usage:
#   bash scripts/debian-install.sh
#   bash scripts/debian-install.sh /opt/akab-portal
set -euo pipefail

APP_DIR="${1:-/opt/akab-portal}"
REPO_URL="${REPO_URL:-https://github.com/Akab-Informatique/Client-Portal.git}"
BRANCH="${BRANCH:-master}"

echo "==> AKAB Portal install (Ubuntu/Debian + Docker) → $APP_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker…"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
  echo "Docker installed. If 'docker compose' fails, log out/in then re-run this script."
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin missing. Install Docker Engine from get.docker.com" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo mkdir -p "$(dirname "$APP_DIR")"
  sudo chown -R "$USER":"$USER" "$(dirname "$APP_DIR")"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  cd "$APP_DIR"
  git fetch origin
  git checkout "$BRANCH"
  if ! git pull --ff-only origin "$BRANCH"; then
    echo "ERROR: local changes or diverged history in $APP_DIR — fix manually (git status)." >&2
    echo "       Refusing to run git reset --hard automatically." >&2
    exit 1
  fi
fi

cd "$APP_DIR"

umask 077
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env   # tightened to 640 + gid 1000 below
  # Generate a simple strong password (no special URL-breaking chars)
  GEN_PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  if grep -q '^POSTGRES_PASSWORD=' .env; then
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${GEN_PW}/" .env
  else
    echo "POSTGRES_PASSWORD=${GEN_PW}" >> .env
  fi
  GEN_SESSION="$(openssl rand -hex 32)"
  if grep -q "^SESSION_SECRET=" .env; then
    sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${GEN_SESSION}/" .env
  else
    echo "SESSION_SECRET=${GEN_SESSION}" >> .env
  fi
  echo "==> Created .env with generated POSTGRES_PASSWORD and SESSION_SECRET"
  echo "    (saved in $APP_DIR/.env — keep a backup)"
else
  echo "==> Using existing .env"
fi

# Ensure required keys exist
grep -q '^POSTGRES_DB=' .env || echo 'POSTGRES_DB=akab' >> .env
grep -q '^POSTGRES_USER=' .env || echo 'POSTGRES_USER=akab' >> .env
grep -q '^POSTGRES_PASSWORD=' .env || {
  echo "ERROR: POSTGRES_PASSWORD missing in .env" >&2
  exit 1
}
if ! grep -Eq '^SESSION_SECRET=.{32,}' .env || grep -Eq '^SESSION_SECRET=["'"'"']?change-me' .env; then
  echo "ERROR: SESSION_SECRET in .env is missing or still the example value." >&2
  echo "       Generate one: openssl rand -hex 32" >&2
  exit 1
fi
# Secrets: owner rw, app container group (gid 1000) read, nobody else.
if chgrp 1000 .env 2>/dev/null || sudo chgrp 1000 .env; then
  chmod 640 .env
else
  echo "WARN: could not chgrp 1000 .env — app container may not read it" >&2
fi

echo "==> Building and starting stack…"
docker compose down --remove-orphans || true
docker compose up -d --build

echo "==> Waiting for health…"
for i in $(seq 1 40); do
  if curl -fsS -m 4 "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Container status"
docker compose ps

echo "==> Health"
curl -sS -m 5 "http://127.0.0.1:${PORT:-3000}/api/health" || true
echo
curl -sS -m 8 "http://127.0.0.1:${PORT:-3000}/api/health?db=1" || true
echo
curl -sS -m 12 "http://127.0.0.1:${PORT:-3000}/api/db/status" || true
echo
docker compose exec -T app curl -sS -m 30 "http://127.0.0.1:3000/api/db/status?migrate=1" || true
echo

echo "==> App logs (last 40 lines)"
docker compose logs --tail=40 app || true

echo
echo "Done."
echo "Open: http://SERVER_IP:3000"
echo "Login: admin@akab.local — one-time password is in: docker compose logs app | grep one-time"
echo "       (change it immediately after first sign-in)"
echo "Upgrade later: cd $APP_DIR && bash scripts/upgrade.sh"
