#!/usr/bin/env bash
# AKAB Portal — first install / repair on Debian 12 or 13
# Usage:
#   bash scripts/debian-install.sh
#   bash scripts/debian-install.sh /opt/akab-portal
set -euo pipefail

APP_DIR="${1:-/opt/akab-portal}"
REPO_URL="${REPO_URL:-https://github.com/solutidev/Client-Portal.git}"
BRANCH="${BRANCH:-master}"

echo "==> AKAB Portal install (Debian) → $APP_DIR"

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
  git pull --ff-only origin "$BRANCH" || git reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  # Generate a simple strong password (no special URL-breaking chars)
  GEN_PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  if grep -q '^POSTGRES_PASSWORD=' .env; then
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${GEN_PW}/" .env
  else
    echo "POSTGRES_PASSWORD=${GEN_PW}" >> .env
  fi
  echo "==> Created .env with generated POSTGRES_PASSWORD"
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
curl -sS -m 30 "http://127.0.0.1:${PORT:-3000}/api/db/status?migrate=1" || true
echo

echo "==> App logs (last 40 lines)"
docker compose logs --tail=40 app || true

echo
echo "Done."
echo "Open: http://SERVER_IP:3000"
echo "Login: admin@akab.local / admin123   (change immediately)"
echo "Upgrade later: cd $APP_DIR && bash scripts/upgrade.sh"
