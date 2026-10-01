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
git clone -b master https://github.com/Akab-Informatique/Client-Portal.git /opt/akab-portal
cd /opt/akab-portal
cp .env.example .env     # fill the REQUIRED block (3 generated secrets + PUBLIC_URL)
sudo chgrp 1000 .env && chmod 640 .env
docker compose up -d --build
docker compose logs app | grep one-time     # first admin password
```

Step by step, the `.env` reference and troubleshooting: **[INSTALL.md](./INSTALL.md)**.

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

## Environment

All variables are described in **INSTALL.md → `.env` reference** and in
`.env.example` (REQUIRED / NETWORK / ADVANCED blocks, then integrations).

---

## Develop → publish loop

1. Build features locally on a branch (`npm run dev`, then `npm run build`)  
2. Merge to `master` and push to GitHub  
3. On server: `bash scripts/upgrade.sh`  
4. Confirm Settings → Database → PostgreSQL ready  

Portal rows stay in Postgres. Integration credentials stay in server `.env`.
