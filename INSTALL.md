# Install AKAB Portal (Docker)

One server running Docker. The portal listens on **port 3000** (plain HTTP).
Put your own HTTPS reverse proxy (e.g. Nginx Proxy Manager) in front of it and
forward `https://portail.akab.ca` → `http://<this server's IP>:3000`.

| Container | Role |
|-----------|------|
| `app` | Web UI + `/api/*` (Node 22) |
| `db` | PostgreSQL 16 — data in Docker volume `akab_pgdata` (**never delete it**) |

Works on Debian 12/13 and Ubuntu 22.04+.

---

## 1. Install Docker

Official Docker Engine from Docker's signed apt repository
(on Ubuntu, replace `debian` with `ubuntu` in both URLs):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

**Log out and back in**, then check: `docker compose version`

## 2. Get the code

```bash
sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt
cd /opt
git clone -b master https://github.com/Akab-Informatique/Client-Portal.git akab-portal
cd akab-portal
```

## 3. Create `.env`

```bash
cp .env.example .env
```

Generate the three secrets (copy each output into `.env`):

```bash
openssl rand -hex 16   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → CREDENTIALS_ENCRYPTION_KEY
```

```bash
nano .env
```

Fill in the **REQUIRED** block at the top of the file (see the table below),
save, then restrict the file (the app container runs as uid/gid 1000):

```bash
sudo chgrp 1000 .env && chmod 640 .env
```

### `.env` reference

**Required**

| Variable | Value |
|----------|-------|
| `POSTGRES_DB` | `akab` |
| `POSTGRES_USER` | `akab` |
| `POSTGRES_PASSWORD` | output of `openssl rand -hex 16` — **never change it after the first start** |
| `SESSION_SECRET` | output of `openssl rand -hex 32` (the example value is refused) |
| `CREDENTIALS_ENCRYPTION_KEY` | output of `openssl rand -hex 32` — encrypts stored integration secrets; losing it makes them unreadable |
| `PUBLIC_URL` | `https://portail.akab.ca` — the public HTTPS address (email links, origin check) |
| `SQL_PROXY_ENABLED` | `1` — required, the web app loads its data through it |

**Network**

| Variable | Default | Meaning |
|----------|---------|---------|
| `APP_PUBLISH` | `3000` | Host port (or `IP:port`) Docker publishes. `3000` = all interfaces |
| `TRUSTED_PROXY_IPS` | *(empty)* | Optional, recommended: your reverse proxy's IP. When set, **only** that IP (and the server itself) may connect, and only its `X-Forwarded-For` is trusted |
| `COOKIE_SECURE` | on | Keep on behind HTTPS. Only for plain-HTTP tests: `false` |

**Integrations (optional — leave empty to disable)**

| Integration | Variables |
|-------------|-----------|
| Autotask | `AUTOTASK_INTEGRATION_CODE`, `AUTOTASK_USERNAME`, `AUTOTASK_SECRET` (single-quote it) |
| Microsoft 365 / SharePoint | `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| IT Glue / MyGlue | `ITGLUE_API_KEY`, `ITGLUE_REGION` (`us` / `eu` / `au`) |
| Email (SMTP) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` |
| Datto RMM | `DATTO_RMM_API_URL`, `DATTO_RMM_API_KEY`, `DATTO_RMM_API_SECRET` |
| Splashtop SOS | `SPLASHTOP_API_TOKEN` |

Each one is documented in `.env.example`.
`.env` rules: no spaces around `=`; a value containing `$` or `#` goes in single quotes.

## 4. Start

```bash
docker compose up -d --build
docker compose ps          # db and app should become "healthy" (≈1 min)
```

Check from the server itself:

```bash
docker compose exec -T app curl -sS "http://127.0.0.1:3000/api/health?db=1"
```

Healthy output contains `"ok":true`.

## 5. Reverse proxy

Point your proxy at `http://<this server's IP>:3000` (scheme **http**,
websockets on, HTTPS certificate on the proxy). If you set `TRUSTED_PROXY_IPS`,
use the proxy's IP exactly as this server sees it.

## 6. First sign-in

```bash
docker compose logs app | grep one-time
```

Open `https://portail.akab.ca`, sign in as `admin@akab.local` with that
password, set up MFA with your authenticator app, then change the password
(Profile → Change password). Create your own admin account afterwards if you
want and deactivate `admin@akab.local`.

**Back up `.env`** somewhere safe — it is the only copy of the database
password and the encryption key.

---

## Upgrade (keeps all data)

```bash
cd /opt/akab-portal
bash scripts/upgrade.sh          # backup → git pull → rebuild → health check → migrations
```

Roll back to a release: `bash scripts/upgrade.sh v1.3.0`

**Never** run `docker compose down -v` or `docker volume rm …akab_pgdata` — that deletes the database.

## Backups

```bash
bash scripts/backup-db.sh /var/backups/akab
# restore: bash scripts/restore-db.sh /var/backups/akab/akab-pg-<date>.sql.gz
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `required variable POSTGRES_PASSWORD is missing` | No `.env` in this folder, or the line is empty — see step 3 |
| Proxy shows **502 Bad Gateway** | App not running (`docker compose ps`), wrong IP/port in the proxy, or scheme set to https |
| Page says **Forbidden — use the portal address** | `TRUSTED_PROXY_IPS` doesn't match the proxy's IP — the app log shows the refused IP |
| `password authentication failed` | `POSTGRES_PASSWORD` changed after the first start — put the original back |
| App unhealthy | `docker compose logs --tail=100 app` |
| `cannot read /app/.env` | `sudo chgrp 1000 .env && chmod 640 .env` |
| Login refused / "placeholder" in log | `SESSION_SECRET` still the example value |

### Rebuild without losing data

```bash
docker compose build --no-cache && docker compose up -d
```

---

## Develop → production

1. Work locally on a branch (`npm run dev`, then `npm run build`)
2. Merge to `master`, push to GitHub, tag the release (`git tag -a v1.x.y`)
3. On the server: `bash scripts/upgrade.sh`
