# Deploy & operate AKAB Portal

For a full first-time server install, use **[INSTALL.md](./INSTALL.md)**.

This file is the short operational reference.

---

## Architecture (production)

```
Browser  →  HTTPS proxy  →  App container (:3000)
                              ├─ static UI (dist/)
                              ├─ /api/* integrations
                              └─ /api/db/*  →  Postgres container
                                              └─ volume akab_pgdata  (durable)
```

| Mode | When | Data |
|------|------|------|
| **PostgreSQL** | `DATABASE_URL` or Compose `db` service | Shared, survives upgrades |
| **PGlite** | No server DB | Browser-only demo — not multi-user prod |

---

## First install (summary)

```bash
git clone <your-repo> /opt/akab-portal
cd /opt/akab-portal
cp .env.example .env    # POSTGRES_PASSWORD + integration secrets
docker compose up -d --build
curl -s http://127.0.0.1:3000/api/db/status?migrate=1
```

Details, HTTPS, and bootstrap logins: **INSTALL.md**.

---

## Upgrade without losing data

```bash
cd /opt/akab-portal
bash scripts/upgrade.sh          # backup + git pull + rebuild
# bash scripts/upgrade.sh v1.2.0
```

**Safe:** `docker compose up -d --build`, `docker compose down` (no `-v`)  
**Destructive:** `docker compose down -v`, `docker volume rm akab_pgdata`

Migrations are **additive only** (new tables/columns). They run on app boot and via `/api/db/status?migrate=1`.

---

## Backups

```bash
bash scripts/backup-db.sh /var/backups/akab
bash scripts/restore-db.sh /var/backups/akab/akab-pg-….sql.gz
```

---

## Environment (Postgres)

| Variable | Purpose |
|----------|---------|
| `POSTGRES_DB` / `USER` / `PASSWORD` | Compose database service |
| `DATABASE_URL` | Optional single URL (host installs) |
| `SESSION_SECRET` | Required server-side HMAC secret for HttpOnly session cookies (`openssl rand -hex 32`) |
| `COOKIE_SECURE=true` | Only behind HTTPS — default is off so `http://ip:3000` lab installs work |
| `VITE_DATABASE_MODE=pglite` | Force browser-local DB (dev) |

---

## Develop → publish loop

1. Build features in Devs.ai / laptop  
2. Commit & push GitHub  
3. On server: `bash scripts/upgrade.sh`  
4. Confirm Settings → Database → PostgreSQL ready  

Portal rows stay in Postgres. Integration credentials stay in server `.env`.
