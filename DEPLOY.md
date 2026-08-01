# AKAB Portal — develop here, ship to your server

This guide is the recommended way to:

1. Keep building the app in **Devs.ai / this sandbox**
2. Publish a **v1** on **your production server**
3. Push updates later **without losing production data**
4. Use **real shared persistence** (your server database)

---

## Critical: how data works today

| Environment | Where data lives | Shared across users? | Survives app update? |
|-------------|------------------|----------------------|----------------------|
| **This sandbox / browser demo** | PGlite in the **browser** (`IndexedDB`) | No — each browser has its own copy | Yes for that browser only |
| **Production (required)** | **PostgreSQL on your server** (or Supabase) | Yes | Yes — independent of deploys |

**PGlite in the browser is fine for building and demos. It is not production persistence.**

If you only deploy the current app as-is:

- Each user keeps data in **their own browser**
- Clearing cache / new PC / another browser = empty or different data
- Staff and clients do **not** share one company database
- Redeploying code does not wipe browser data, but you still have **no real multi-user server DB**

**For production you need a server database.** Best fit for “our server”: **PostgreSQL on the same machine (or your existing DB host)**. Alternative: **Supabase** (managed Postgres in the cloud).

> The app is not fully wired to server Postgres yet. After you publish v1 packaging, the next engineering step is: **move portal data (users, companies, messages, settings links) behind `/api/*` + Postgres**. Tickets / SharePoint / IT Glue / SMTP already live outside the browser DB.

---

## Recommended model (keep forever)

```
┌─────────────────────────────┐     git push      ┌──────────────────────────┐
│  Devs.ai / local sandbox    │ ───────────────►  │  GitHub (source of truth)│
│  - build features           │                   │  - main = stable         │
│  - demo / PGlite ok         │                   │  - tags: v1.0.0, v1.1.0  │
└─────────────────────────────┘                   └────────────┬─────────────┘
                                                               │ git pull
                                                               ▼
                                                  ┌──────────────────────────┐
                                                  │  Your production server  │
                                                  │  - app container / Node  │
                                                  │  - .env secrets          │
                                                  │  - PostgreSQL (data)     │
                                                  │  - backups               │
                                                  └──────────────────────────┘
```

**Rule:** code travels via **Git**. Production data lives only on the **server database** (and backups). Never store production secrets or production DB dumps inside the app repo.

---

## One-time setup

### 1) Put the project on GitHub

On a machine that has this project (export/download from Devs.ai if needed):

```bash
cd akab-portal
git status
git remote add origin git@github.com:YOUR_ORG/akab-portal.git   # once
git push -u origin main
git tag -a v1.0.0 -m "AKAB Portal v1.0.0"
git push origin v1.0.0
```

Use **private** repo if the company prefers.

### 2) Production server prerequisites

- Linux VM or host you control
- Docker + Docker Compose **or** Node.js 20+
- Reverse proxy with HTTPS (Caddy / Nginx / IIS)
- **PostgreSQL 15+** (same host or managed instance)
- Firewall: only 80/443 public; Postgres not public

### 3) Secrets on the server only

```bash
# on the server
mkdir -p /opt/akab-portal
cd /opt/akab-portal
git clone git@github.com:YOUR_ORG/akab-portal.git .
cp .env.example .env
nano .env   # fill real values — never commit this file
```

Minimum production `.env` groups:

| Group | Variables |
|-------|-----------|
| Autotask | `AUTOTASK_*` |
| Microsoft Graph | `MICROSOFT_*` |
| IT Glue | `ITGLUE_API_KEY`, `ITGLUE_REGION` |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, … |
| Runtime | `PORT=3000`, `HOST=0.0.0.0`, `NODE_ENV=production` |
| Database *(after server-DB migration)* | `DATABASE_URL=postgres://…` |

### 4) First production start (app process)

**Docker (already in repo):**

```bash
cd /opt/akab-portal
docker compose up -d --build
# app → http://127.0.0.1:3000  (put HTTPS proxy in front)
```

**Or bare Node:**

```bash
npm ci
npm run build
npm start
# pm2 start npm --name akab-portal -- start
```

Point your domain (`portal.yourdomain.com`) at the proxy → `127.0.0.1:3000`.

### 5) Production database (persistence)

**On your server (recommended if you want data “at home”):**

```bash
# example — adjust names/passwords
sudo apt install postgresql   # or use your existing Postgres
sudo -u postgres createuser akab
sudo -u postgres createdb akab_portal -O akab
# set password + put in DATABASE_URL
```

**Or Supabase:** managed Postgres + backups; connect with a server-only connection string.

Until the app is migrated off browser PGlite, the portal UI data (users/companies/messages) is **not** yet written to that Postgres. Plan that migration before real clients rely on the portal (see “Phase 2” below).

---

## Day-to-day workflow

### Develop (here or on a laptop)

1. Build features in Devs.ai / local `npm run dev`
2. Use demo accounts / PGlite freely
3. Commit logical chunks:
   ```bash
   git add -A
   git commit -m "feat: board email + SMTP settings"
   git push origin main
   ```
4. Optionally open a `develop` branch and only merge stable work to `main`

### Release to production (update without losing data)

```bash
# on the server
cd /opt/akab-portal
git fetch --tags
git checkout main
git pull origin main

# optional: deploy a specific release
# git checkout v1.1.0

# rebuild app ONLY — do not drop the database
docker compose up -d --build
# or: npm ci && npm run build && pm2 restart akab-portal
```

**Safe update rules**

| Do | Don’t |
|----|--------|
| `git pull` + rebuild app | `docker compose down -v` (wipes volumes) |
| Keep the same `.env` | Overwrite `.env` from a laptop copy blindly |
| Run **additive** DB migrations only | Drop/recreate production DB |
| Backup DB **before** each release | Store production DB inside the Git repo |
| Tag releases (`v1.1.0`) | Deploy untested `main` with no tag if you need rollback |

### Rollback app code (data stays)

```bash
cd /opt/akab-portal
git checkout v1.0.0
docker compose up -d --build
```

Database is separate → rolling back code does not erase client/user rows (once on Postgres).

---

## Backups (non‑negotiable for production)

Once on Postgres:

```bash
# daily dump example
pg_dump "$DATABASE_URL" -Fc -f "/var/backups/akab/akab-$(date +%F).dump"
```

Keep at least:

- Daily dumps (7–14 days)
- One weekly dump off-site
- Test a restore once before go-live

Restore example:

```bash
pg_restore -d akab_portal --clean --if-exists /var/backups/akab/akab-2026-04-08.dump
```

Also back up `.env` securely (password manager / sealed vault) — not in Git.

---

## What survives a production update?

| Asset | Survives `git pull` + rebuild? |
|-------|--------------------------------|
| Source code | Replaced by new version (expected) |
| `.env` secrets | Yes (file on server, not in Git) |
| Postgres data | Yes (outside the app container) |
| Autotask / IT Glue / SharePoint data | Yes (vendor systems) |
| Browser PGlite demo data | Irrelevant in real prod; do not rely on it |
| Uploaded files (if you add any later) | Only if on a **mounted volume** or object storage |

---

## Phase plan (practical)

### Phase 1 — Ship packaging now (you can do this today)

1. Push repo + tag `v1.0.0`
2. Deploy Node/Docker on your server with HTTPS
3. Configure Autotask, Graph, IT Glue, SMTP secrets
4. Treat browser DB as **staging only** (or single-admin trial)

### Phase 2 — Real production persistence (do before multi-user go-live)

1. Stand up **Postgres on your server** (or Supabase)
2. Move portal tables (`companies`, `users`, `staff_roles`, `board_messages`, …) to server DB
3. All reads/writes go through `/api/*` (never expose DB to the browser)
4. Additive migrations only when you change schema
5. Import any needed seed/admin user once
6. Enable automated backups

### Phase 3 — Steady operations

- Develop here → push Git → pull on server → rebuild
- Tag each production release
- Backup before migrate
- Monitor SMTP / Autotask / Graph errors in logs

---

## Can you use “our server” for persistence?

**Yes — that is the best option if you want data under your control.**

Use:

- **App** on your server (this repo’s Docker/Node setup)
- **PostgreSQL** on the same server (or your internal DB host)
- **HTTPS** reverse proxy on your server
- **Secrets** only in server `.env`

You do **not** need Vercel for production if you self-host. Vercel is optional.

Supabase is only an alternative if you prefer managed cloud Postgres instead of installing Postgres yourself.

---

## Checklist before calling it “production v1”

- [ ] Private GitHub repo + `v1.0.0` tag  
- [ ] Server deploy (Docker or Node) behind HTTPS  
- [ ] Production `.env` filled (Autotask, Graph, IT Glue, SMTP)  
- [ ] **Server Postgres** planned/live (not browser-only)  
- [ ] Backup + restore tested  
- [ ] Admin account created (change default demo passwords)  
- [ ] One client company smoke-tested (tickets / docs / passwords / board)  
- [ ] Documented update command for your team (`git pull` + rebuild)  

---

## Short answers

**Best way to continue developing here and publish v1?**  
→ GitHub as source of truth; build here; deploy from Git on your server.

**Update production without losing data?**  
→ Rebuild the app only; keep Postgres + `.env` outside the deploy; never wipe DB volumes; backup before releases.

**Can production persistence use our server?**  
→ Yes. Put PostgreSQL on your server and (next step) migrate the portal off browser PGlite onto that database.

When you want Phase 2 implemented in this project, say whether you prefer:

1. **Postgres on your server** (`DATABASE_URL`), or  
2. **Supabase** (cloud Postgres),

and we can wire the app for durable multi-user production data.
