#!/usr/bin/env bash
# AKAB Portal — first install / repair on Ubuntu 22.04+ or Debian 12/13
#
# Usage (reverse proxy such as Nginx Proxy Manager on ANOTHER server):
#   PUBLIC_URL=https://portail.akab.ca NPM_PROXY_IP=192.168.1.10 \
#     bash scripts/debian-install.sh
#
# Optional:
#   APP_DIR=/opt/akab-portal   LAN_IP=192.168.1.20 (auto-detected)
#   BRANCH=master              REPO_URL=https://github.com/Akab-Informatique/Client-Portal.git
#
# Without NPM_PROXY_IP the app listens on 127.0.0.1:3000 only (proxy on this host).
set -euo pipefail

APP_DIR="${APP_DIR:-${1:-/opt/akab-portal}}"
REPO_URL="${REPO_URL:-https://github.com/Akab-Informatique/Client-Portal.git}"
BRANCH="${BRANCH:-master}"
PUBLIC_URL="${PUBLIC_URL:-https://portail.akab.ca}"
NPM_PROXY_IP="${NPM_PROXY_IP:-}"
LAN_IP="${LAN_IP:-}"

echo "==> AKAB Portal install (Ubuntu/Debian + Docker) → $APP_DIR"

# ── Docker from Docker's signed apt repository (no curl | sh) ───────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine from download.docker.com (signed apt repo)…"
  . /etc/os-release
  case "$ID" in
    debian|ubuntu) DISTRO="$ID" ;;
    *) echo "ERROR: unsupported distribution '$ID' (Debian or Ubuntu only)" >&2; exit 1 ;;
  esac
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL "https://download.docker.com/linux/${DISTRO}/gpg" -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DISTRO} ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  echo "Docker installed. Log out and back in (docker group), then re-run this script."
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin missing (apt-get install docker-compose-plugin)" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || sudo apt-get install -y openssl

# ── Code ────────────────────────────────────────────────────────────────────
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo mkdir -p "$(dirname "$APP_DIR")"
  sudo chown "$USER":"$USER" "$(dirname "$APP_DIR")"
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

# Set KEY=VALUE in .env (replace the line or append). Values must not contain newlines.
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*#?[[:space:]]*" k "=" && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//"; }
is_placeholder() { [[ -z "$1" || "$1" == change-me* ]]; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "==> Created .env from .env.example"
fi

# Generate every secret that is missing or still a placeholder (never overwrite real ones)
if is_placeholder "$(env_value POSTGRES_PASSWORD)"; then
  set_env POSTGRES_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  echo "    generated POSTGRES_PASSWORD"
fi
if is_placeholder "$(env_value SESSION_SECRET)"; then
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  echo "    generated SESSION_SECRET"
fi
if is_placeholder "$(env_value CREDENTIALS_ENCRYPTION_KEY)"; then
  set_env CREDENTIALS_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  echo "    generated CREDENTIALS_ENCRYPTION_KEY (back up .env — it decrypts stored secrets)"
fi
grep -q '^POSTGRES_DB=' .env || set_env POSTGRES_DB akab
grep -q '^POSTGRES_USER=' .env || set_env POSTGRES_USER akab
set_env PUBLIC_URL "$PUBLIC_URL"
set_env SQL_PROXY_ENABLED 1

# ── Reverse proxy on another server (Nginx Proxy Manager) ───────────────────
if [[ -n "$NPM_PROXY_IP" ]]; then
  if [[ -z "$LAN_IP" ]]; then
    LAN_IP="$(ip -4 route get "$NPM_PROXY_IP" 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -n1)"
  fi
  if [[ -z "$LAN_IP" ]]; then
    echo "ERROR: could not detect this server's LAN IP — re-run with LAN_IP=…" >&2
    exit 1
  fi
  set_env APP_PUBLISH "${LAN_IP}:3000"
  set_env TRUSTED_PROXY_IPS "$NPM_PROXY_IP"
  echo "==> App published on ${LAN_IP}:3000; only ${NPM_PROXY_IP} may connect (enforced by the app)"
  if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
    # Note: Docker-published ports bypass ufw; the app-level allowlist is the real guard.
    sudo ufw allow from "$NPM_PROXY_IP" to any port 3000 proto tcp comment "AKAB portal via NPM" >/dev/null || true
  fi
else
  echo "==> No NPM_PROXY_IP — app listens on 127.0.0.1:3000 (reverse proxy must run on this host)"
fi

# Secrets: owner rw, app container group (gid 1000) read, nobody else.
if chgrp 1000 .env 2>/dev/null || sudo chgrp 1000 .env; then
  chmod 640 .env
else
  echo "WARN: could not chgrp 1000 .env — app container may not read it" >&2
fi

# ── Build + start ───────────────────────────────────────────────────────────
echo "==> Building and starting stack…"
docker compose up -d --build --remove-orphans

# Health checks run INSIDE the container (loopback is always allowed there)
in_app() { docker compose exec -T app curl -sS -m "${2:-8}" "http://127.0.0.1:3000$1"; }

echo "==> Waiting for health…"
for i in $(seq 1 60); do
  if in_app /api/health 4 >/dev/null 2>&1; then break; fi
  sleep 2
done

docker compose ps
echo "==> Health";       in_app /api/health 5 || true; echo
echo "==> Database";     in_app "/api/health?db=1" 8 || true; echo
echo "==> Migrations";   in_app "/api/db/status?migrate=1" 45 | head -c 600 || true; echo

echo
echo "==> App log (secrets are never printed except the one-time admin password)"
docker compose logs --tail=40 app | grep -v "one-time password" || true

echo
echo "Done."
echo "  Portal URL : $PUBLIC_URL  (point Nginx Proxy Manager at http://${LAN_IP:-127.0.0.1}:3000)"
echo "  First login: admin@akab.local"
echo "  Password   : docker compose logs app | grep one-time   ← change it at first sign-in"
echo "  Upgrade    : cd $APP_DIR && bash scripts/upgrade.sh"
echo "  Back up    : $APP_DIR/.env (holds the database password and encryption key)"
