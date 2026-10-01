# AKAB Portal — notes for Claude Code

Client portal for SOLU TI INC. / AKAB. Live at https://portail.akab.ca.
Stack: React 19 · Vite 6 · Tailwind 4 · shadcn/ui · serverless-style routes in `api/` · PostgreSQL 16 in production, PGlite in the browser for local dev.
Integrations: Autotask, Microsoft Graph/SharePoint, IT Glue, SMTP, Datto RMM, Splashtop SOS.

## Branch & release rules (important)

- **`master` is the only branch.** It is GitHub's default and what production runs. Do not recreate `main`.
- Every push to `master` can reach production the next time `scripts/upgrade.sh` runs on the server. Only push code that builds.
- Risky or multi-day work goes on a feature branch (`feat/...`, `fix/...`) and is merged into `master` when ready.
- **Never force-push `master`.** `upgrade.sh` falls back to `git reset --hard origin/master`, so rewritten history lands on the server.
- Tag releases before deploying them: `git tag -a v1.x.y -m "..." && git push origin v1.x.y`. Rollback on the server: `bash scripts/upgrade.sh v1.x.y`.
- Development happens only in this local repo (Devs.ai is no longer used). Still `git pull` before starting work.

## Session routine

1. Start: `git pull` (on `master`), then `npm install` if `package-lock.json` changed.
2. Run: `npm run dev` → http://localhost:5173. Sign-in always goes through `/api/auth/*`, which needs a Postgres reachable via `POSTGRES_*` (plus a real `SESSION_SECRET`) in a local `.env`; without it the UI loads but login returns 503. On an empty database the server seeds demo accounts (dev only) — then run `curl "http://127.0.0.1:5173/api/db/status?migrate=1"` once.
3. Before committing: `npm run build` (typecheck + bundle) must pass.
4. End: commit with a conventional message (`feat:`, `fix:`, `chore:` …) and `git push`.

## Production (Debian server, Docker Compose) — owner runs this, not Claude

- Update: `cd /opt/akab-portal && bash scripts/upgrade.sh` (backup → pull → rebuild app → health check → additive migrations).
- Data lives in Docker volume `akab_pgdata`. **Never** `docker compose down -v` or `docker volume rm akab_pgdata`.
- Server `.env` holds the real secrets and is never in Git. Never overwrite it from a dev copy.
- Details: `INSTALL.md`, `DEPLOY.md`.

## Database changes

Schema lives in three places that must stay in sync:
- `src/db/schema.ts` — Drizzle schema used by the UI
- `api/_lib/pg.ts` — production Postgres bootstrap/migrations (run on app start and via `/api/db/status?migrate=1`)
- `src/db/pglite-dev.ts` — local dev PGlite schema

Migrations must be **additive only**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, new nullable columns or columns with defaults. No drops, renames or type changes to existing columns without a planned manual migration.

## Security conventions

- Secrets only in `.env` (see `.env.example`). Never in `VITE_*` variables — those ship to the browser.
- UI role checks are UX only; authorization must be enforced server-side in `api/`.
- Autotask/Datto secrets in `.env` must be single-quoted (`$` and `#` break Docker Compose).
- **Every `/api/*` route goes through `api/_lib/api-gate.ts`** (wired in `server/prod-server.mjs` and the Vite dev plugin): session + MFA required, identity params (`role`, `email`, `userId`, `companyId`, `autotaskCompanyId`, `organizationId`, `siteUid`, `siteUrl` …) are overwritten from the session user, clients are pinned to their companies and checked against their client-role permissions. New routes get this automatically — never read identity from the request in a handler; use `requestAuth(req)` instead. Public routes are listed in `isPublicRoute`.
- Records fetched by id (tickets, invoices, contracts, SOS) must be ownership-checked (`clientOwnsAutotaskRecord`, `row.user_id`).
- Browser SQL proxy (`/api/db/query`): runs as Postgres role `akab_proxy` with row-level security (`PROXY_POLICIES` in `api/_lib/pg.ts`), secret columns are nulled in SQL and stripped from results. When adding a table the browser queries, add it to `PROXY_TABLES` + a policy, or the proxy role cannot read it.
- Security headers / CSP live in `server/prod-server.mjs` (`setSecurityHeaders`, `CONTENT_SECURITY_POLICY`). Loading a new external script/font/API from the browser requires updating the CSP.

## Layout

- `src/` UI — `pages/`, `components/`, `lib/` (auth, permissions, API clients), `db/`, `i18n/locales/{en,fr}.ts` (add both languages for any new text)
- `api/` server routes; `api/_lib/` shared server clients
- `server/prod-server.mjs` production Node server (static `dist/` + `/api/*`)
- `vite-plugins/` dev middleware mirroring the production API
- `scripts/` server scripts: `upgrade.sh`, `backup-db.sh`, `restore-db.sh`, `debian-install.sh`
- `dist/` is build output and is git-ignored; Docker runs `npm run build`
