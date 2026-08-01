# Install AKAB Portal on your server (production)

This guide installs a **production-ready** stack:

| Component | Role |
|-----------|------|
| **App** (Docker) | React UI + `/api/*` (Autotask, Graph, IT Glue, SMTP, DB proxy) |
| **PostgreSQL 16** (Docker) | Durable portal data (users, companies, boards, roles…) |
| **Volume `akab_pgdata`** | Survives every upgrade — **never delete it** |

Tickets / docs / vault secrets stay in Autotask, SharePoint, IT Glue.

---

## Requirements

- Linux server (Ubuntu 22.04+ recommended) with public IP or internal DNS
- Docker Engine + Docker Compose plugin
- Git
- Ports: **80/443** (HTTPS reverse proxy) and optionally **3000** (app, localhost-only is fine)
- 1+ GB RAM free

```bash
# Ubuntu quick install of Docker (if needed)
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out/in, then:
docker compose version
```

---

## 1) First install

### A. Get the code

```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
cd /opt
git clone https://github.com/YOUR_ORG/akab-portal.git
cd akab-portal
```

### B. Configure secrets

```bash
cp .env.example .env
nano .env   # or vim
```

**Minimum for production:**

```env
# Strong password — app + Postgres share this via compose
POSTGRES_DB=akab
POSTGRES_USER=akab
POSTGRES_PASSWORD=use-a-long-random-password-here

# Integrations (as needed)
AUTOTASK_INTEGRATION_CODE=...
AUTOTASK_USERNAME=...
AUTOTASK_SECRET=...
MICROSOFT_TENANT_ID=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
ITGLUE_API_KEY=...
ITGLUE_REGION=us

# Board email (optional)
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM_EMAIL=portal@yourdomain.com
SMTP_FROM_NAME=AKAB Portal

PORT=3000
```

Docker Compose **automatically** sets `DATABASE_URL` inside the app container to the `db` service. You do **not** need to hand-write `DATABASE_URL` when using Compose.

### C. Start

```bash
# scripts/ is in the repo — no chmod needed; always use: bash scripts/...
docker compose up -d --build
```

Check:

```bash
docker compose ps
curl -s http://127.0.0.1:3000/api/db/status?migrate=1
# → "mode":"postgres","ok":true
```

Open `http://YOUR_SERVER:3000` (or your HTTPS domain).

### D. First login

On an **empty** database the app creates bootstrap accounts once:

| Email | Password | Role |
|-------|----------|------|
| `admin@akab.local` | `admin123` | Admin |
| `tech@akab.local` | `tech123` | Technician |
| `client@acme.example` | `client123` | Client |

**Change these passwords immediately** (Profile → Change password), or create real staff and disable demos.

Settings → **Database** should show **PostgreSQL ready**.

---

## 2) HTTPS (recommended)

Example **Caddy** (`/etc/caddy/Caddyfile`):

```caddy
portal.yourdomain.com {
  reverse_proxy 127.0.0.1:3000
}
```

Or Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name portal.yourdomain.com;
  # ssl_certificate ...;
  # ssl_certificate_key ...;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Bind app to localhost only if the proxy is on the same host (optional hardening in compose `ports`: `"127.0.0.1:3000:3000"`).

---

## 3) Easy upgrades (no data loss)

From `/opt/akab-portal`:

```bash
bash scripts/upgrade.sh
# or pin a release:
# bash scripts/upgrade.sh v1.1.0
```

What it does:

1. **`pg_dump` backup** → `./backups/`
2. `git pull` (or checkout tag)
3. `docker compose up -d --build` — rebuilds **app** image only  
4. **Keeps volume `akab_pgdata`** (all portal rows stay)
5. Runs **additive** SQL migrations on boot (`CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` only)

### Manual upgrade (same safety)

```bash
bash scripts/backup-db.sh
git pull origin master
docker compose up -d --build
curl -s http://127.0.0.1:3000/api/db/status?migrate=1
```

### Never do this in production

```bash
docker compose down -v     # -v DELETES the database volume
docker volume rm akab_pgdata
```

Stopping/restarting without `-v` is fine:

```bash
docker compose down        # stops containers, keeps volume
docker compose up -d
```

---

## 4) Backups

```bash
# Manual
bash scripts/backup-db.sh /var/backups/akab

# Cron example (nightly 02:15)
# 15 2 * * * cd /opt/akab-portal && bash scripts/backup-db.sh /var/backups/akab >> /var/log/akab-backup.log 2>&1
```

Restore (replaces DB contents; volume stays):

```bash
bash scripts/restore-db.sh /var/backups/akab/akab-pg-YYYYMMDD-HHMMSS.sql.gz
docker compose restart app
```

Also keep off-server copies (S3, NAS, another site).

---

## 5) How data survives upgrades

```
┌─────────────┐     rebuild OK      ┌──────────────────┐
│  app image  │ ──────────────────► │  new app code    │
└─────────────┘                     └────────┬─────────┘
                                             │ SQL (additive migrate)
┌─────────────────────┐                      ▼
│ volume akab_pgdata  │ ◄──── never removed ─┤ PostgreSQL
│ users, companies,   │                      │
│ messages, roles …   │                      │
└─────────────────────┘
```

- **Code** → Git  
- **Secrets** → server `.env` (not in Git)  
- **Portal rows** → Postgres volume  
- **External systems** → Autotask / Graph / IT Glue  

---

## 6) Install without Docker (optional)

```bash
# Install Postgres 16 on the host, create role/db, then:
cd /opt/akab-portal
cp .env.example .env
# set DATABASE_URL=postgres://akab:PASSWORD@127.0.0.1:5432/akab
npm ci
npm run build
npm start
# put under systemd/pm2 + reverse proxy
```

Migrations still run automatically on API boot / first query.

---

## 7) Develop here, publish there

| Where | What |
|-------|------|
| **This sandbox / laptop** | Feature work (`npm run dev`). Can use PGlite or a dev Postgres. |
| **GitHub** | Source of truth for code + tags (`v1.0.1`, …) |
| **Your server** | `git pull` + `bash scripts/upgrade.sh` |

Never point the production `DATABASE_URL` at a disposable database.  
Never commit `.env`.

---

## 8) Verify production health

| Check | Command / UI |
|-------|----------------|
| Containers | `docker compose ps` |
| DB API | `curl -s localhost:3000/api/db/status?migrate=1` |
| UI | Settings → Database → **PostgreSQL ready** |
| Login | Admin account works after reboot |
| Upgrade dry-run | `bash scripts/backup-db.sh && docker compose up -d --build` |

---

## 9) Troubleshooting

| Symptom | Fix |
|---------|-----|
| Settings shows “Local browser only” | `DATABASE_URL` / Compose DB not reachable — `docker compose logs db app` |
| `password authentication failed` | `POSTGRES_PASSWORD` mismatch; if you change it after first boot you must recreate volume (**destroys data**) or `ALTER USER` inside Postgres |
| Empty site after upgrade | You used `down -v` — restore from `./backups` |
| Port 3000 in use | Change `PORT=8080` in `.env` and proxy target |
| Migrations error | `docker compose logs app` — usually DB not healthy yet; restart app after db is healthy |

---

## Quick reference card

```bash
# Install once
git clone <repo> /opt/akab-portal && cd /opt/akab-portal
cp .env.example .env   # set POSTGRES_PASSWORD + integrations
docker compose up -d --build

# Every update
cd /opt/akab-portal && bash scripts/upgrade.sh

# Backup
bash scripts/backup-db.sh

# Logs
docker compose logs -f app
```

You’re done: **develop → push Git → upgrade script on server → data stays in Postgres.**
