# Install AKAB Portal on Debian 13 (production + PostgreSQL)

Tested target: **Debian 13 (Trixie)** with Docker Engine.  
Also works on Debian 12 / Ubuntu 22.04+.

| Component | Role |
|-----------|------|
| **App** (Docker, Debian slim image) | UI + `/api/*` + DB proxy |
| **PostgreSQL 16** (Docker) | Durable portal data |
| **Volume `akab_pgdata`** | Survives every upgrade — **never delete it** |

---

## One-command install (Ubuntu or Debian)

```bash
# As a sudo-capable user
sudo apt-get update
sudo apt-get install -y git curl ca-certificates

# Clone
sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt
cd /opt
git clone -b master https://github.com/solutidev/Client-Portal.git akab-portal
cd akab-portal

# Install Docker (if needed) + build + start Postgres + app
# (script name is historical — works on Ubuntu too)
bash scripts/debian-install.sh
```

Then open: `http://YOUR_SERVER_IP:3000`  
Login: `admin@akab.local` / `admin123` → **change password immediately**.

---

## Manual install (step by step)

### 1) Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out and back in
docker compose version
```

### 2) Code

```bash
sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt
cd /opt
git clone -b master https://github.com/solutidev/Client-Portal.git akab-portal
cd akab-portal
```

### 3) `.env`

```bash
cp .env.example .env
nano .env
```

**Required:**

```env
POSTGRES_DB=akab
POSTGRES_USER=akab
POSTGRES_PASSWORD=UseLongPasswordWithoutSpecialChars123
PORT=3000
```

Tips:
- Prefer letters + numbers (no `@ # : / ? $` if possible)
- If password contains `$`, write `$$` in `.env` (Docker Compose rule)
- Do **not** set `DATABASE_URL` when using Compose — the app uses `POSTGRES_HOST=db`

Optional integrations: `AUTOTASK_*`, `MICROSOFT_*`, `ITGLUE_*`, `SMTP_*` (see `.env.example`).

### 4) Start

```bash
docker compose up -d --build
docker compose ps
```

### 5) Verify (always quote URLs + use timeouts)

```bash
curl -sS -m 5  "http://127.0.0.1:3000/api/health"
curl -sS -m 8  "http://127.0.0.1:3000/api/health?db=1"
curl -sS -m 10 "http://127.0.0.1:3000/api/db/status"
curl -sS -m 30 "http://127.0.0.1:3000/api/db/status?migrate=1"
docker compose logs --tail=60 app
```

Healthy DB status:

```json
{"mode":"postgres","ok":true,"userCount":3,...}
```

App log line:

```text
db: PostgreSQL ok — akab @ db — users=3
```

---

## Upgrades (no data loss)

```bash
cd /opt/akab-portal
bash scripts/upgrade.sh
```

Or:

```bash
cd /opt/akab-portal
bash scripts/backup-db.sh
git pull origin master
docker compose up -d --build
```

**Never:**

```bash
docker compose down -v
docker volume rm akab_pgdata
```

---

## HTTPS (Caddy on Debian)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
portal.yourdomain.com {
  reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `curl` hangs | Use quotes + `-m`: `curl -sS -m 8 "http://127.0.0.1:3000/api/health"` |
| `password authentication failed` | `POSTGRES_PASSWORD` changed after first boot. Restore original password **or** wipe volume (data loss): `docker compose down && docker volume rm akab_pgdata && docker compose up -d --build` |
| `POSTGRES_* not set` | Create `.env` with `POSTGRES_PASSWORD=...` |
| Port 3000 closed | `sudo ss -lntp \| grep 3000` · open firewall if needed |
| App unhealthy | `docker compose logs --tail=100 app` |
| Still broken after pull | `docker compose build --no-cache app && docker compose up -d` |

### Nuclear rebuild (keeps DB volume)

```bash
cd /opt/akab-portal
git fetch origin && git checkout master && git pull origin master
docker compose build --no-cache
docker compose up -d
```

### Nuclear rebuild (WIPES portal DB — demo only)

```bash
docker compose down
docker volume rm akab_pgdata
docker compose up -d --build
```

---

## Backups

```bash
bash scripts/backup-db.sh /var/backups/akab
# restore:
# bash scripts/restore-db.sh /var/backups/akab/akab-pg-….sql.gz
```

---

## Develop → production

1. Build features in Devs.ai / laptop  
2. Push to GitHub `master`  
3. On server: `bash scripts/upgrade.sh`  
4. Data stays in Postgres volume `akab_pgdata`
