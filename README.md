# AKAB Portal v1.0.0

Client portal for **SOLU TI INC. / AKAB** — company zones, Autotask tickets, SharePoint documentation, messaging, and staff administration.

| Stack | |
|--------|--|
| UI | React 19 · Vite 6 · Tailwind 4 · shadcn/ui |
| API | Vercel-style serverless routes under `api/` |
| Data | **PostgreSQL** (production) · PGlite fallback (local demo) · Drizzle |
| Integrations | Autotask REST · Microsoft Graph / SharePoint · IT Glue · SMTP |

**Production install:** see **[INSTALL.md](./INSTALL.md)** (Docker + Postgres + safe upgrades).  
**Ops cheat sheet:** **[DEPLOY.md](./DEPLOY.md)**.

---

## Quick start (development)

```bash
# 1. Clone
git clone <your-repo-url> akab-portal
cd akab-portal

# 2. Install
npm install

# 3. Secrets
cp .env.example .env
# edit .env — Autotask + Microsoft Graph values

# 4. Run
npm run dev
# → http://localhost:5173
```

Demo logins are seeded on first load (see login screen / seed data).

---

## Production deploy

### Option A — Your own server (Node 20+)

```bash
git clone <your-repo-url> akab-portal
cd akab-portal
npm ci
cp .env.example .env   # fill secrets
npm run build
npm start              # serves dist/ + /api/* on PORT (default 3000)
```

Process manager example (systemd / PM2):

```bash
pm2 start npm --name akab-portal -- start
# or: node --import tsx server/prod-server.mjs
```

Put Nginx / Caddy / IIS in front for TLS:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Option B — Docker

```bash
cp .env.example .env   # fill secrets
docker compose up -d --build
# → http://localhost:3000
```

### Option C — Vercel

1. Import the GitHub repo in Vercel.
2. Framework preset: **Vite** (or leave auto).
3. Add environment variables from `.env.example` in Project → Settings → Environment Variables.
4. Deploy. `vercel.json` rewrites SPA routes and keeps `/api/*` as serverless functions.

---

## Environment variables

See **`.env.example`**. Required for live integrations:

| Variable | Purpose |
|----------|---------|
| `AUTOTASK_INTEGRATION_CODE` | Autotask API tracking identifier |
| `AUTOTASK_USERNAME` | API user |
| `AUTOTASK_SECRET` | API secret |
| `AUTOTASK_ZONE_URL` | Optional fixed zone base URL |
| `MICROSOFT_TENANT_ID` | Portal default Entra tenant |
| `MICROSOFT_CLIENT_ID` | Portal Graph app id |
| `MICROSOFT_CLIENT_SECRET` | Portal Graph app secret |

**Per-client Graph auth:** under **Admin → Clients → Edit**, each company can override Tenant ID + Application (client) ID + Client secret so Acme and Northstar never share credentials.

---

## Repository layout

```
api/                  Server routes (Autotask, SharePoint/Graph)
  _lib/               Shared server clients
server/
  prod-server.mjs     Self-host Node server (static + API)
src/
  components/         UI + layout
  db/                 PGlite schema + client
  pages/              Admin + client routes
  lib/                Auth, Autotask/SharePoint clients, permissions
vite-plugins/         Dev API middleware (mirrors production handlers)
public/               Static assets (logos, icons)
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server + `/api` middleware |
| `npm run build` | Typecheck + production bundle → `dist/` |
| `npm start` | Production server (requires build) |
| `npm run preview` | Vite preview of `dist/` (static only) |
| `npm run typecheck` | TypeScript only |

---

## v1 scope & production notes

**Included**
- Multi-role portal (admin / technician / client)
- Autotask tickets (list, detail, reply, close, elevate)
- SharePoint docs with per-client site + optional per-client Entra app
- Message boards, directory, profile, EN/FR, theme toggle

**Operator awareness**
1. **Data store** — v1 uses **browser PGlite**. Each browser has its own DB. For multi-user production on your servers, plan a shared Postgres (e.g. Supabase) and migrate `src/db/schema.ts`.
2. **Secrets** — keep `.env` on the server only; rotate Autotask + Graph secrets regularly.
3. **Graph permissions** — Application `Sites.Read.All` (or `Sites.Selected` + grants) + admin consent.
4. **Autotask** — API user must reach the correct zone; set `AUTOTASK_ZONE_URL` if auto-discovery fails (HTTP 410).
5. **HTTPS** — terminate TLS at your reverse proxy.

---

## GitHub

```bash
# create empty repo on GitHub, then:
git remote add origin git@github.com:<org>/<repo>.git
git branch -M main
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

---

## License

Proprietary — SOLU TI INC. All rights reserved.
