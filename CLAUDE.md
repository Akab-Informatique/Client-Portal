# AKAB Portal — notes for Claude Code

Portal for AKAB Informatique (MSP, Lanaudière): internal team first, clients next.
Brand follows akab.ca: ink `#0a0a0b`, paper `#f4f4f1`, gold gradient
`#ffe24a → #ffce1a → #f59410`, Bricolage Grotesque (display) + Instrument Sans
(body). Dark theme by default. French by default, every text in `src/i18n/fr.ts`
**and** `src/i18n/en.ts`.

## Branches

- `master` is production. Work on `feat/...` / `fix/...` branches, merge when `npm run build` and `npm test` pass.
- Old portal: `backup/v1-original` (do not merge it back).

## Commands

- `npm run dev` — web :5173 + API :3001 (PGlite in `.data/`, delete it to reset)
- `npm test` — API tests (vitest, in-memory PGlite). Add a test for every new route/permission.
- `npm run build` — type-check (web + server) and bundle. Must pass before committing.
- `npm run db:generate` — after changing `server/db/schema.ts`, generates a migration in `drizzle/` (commit it). Migrations run at startup.

## Adding a module

1. `shared/permissions.ts`: add the module and its rights (labels FR/EN). The Administrator role gets every staff right automatically.
2. API: new file in `server/routes/`, mount it in `server/app.ts`, guard every route with `requirePermission("<key>")` (and `requireStaff` for staff-only areas).
3. UI: page in `src/pages/`, entry in `src/modules/registry.ts` (remove `upcoming`), route in `src/App.tsx`.
4. Tests in `tests/`.

## Security rules

- Authorization is enforced in the API, never only in the UI. Use `auth(c)` / `requirePermission`; never trust ids or roles sent by the browser.
- Mutations: JSON only + same-origin check (`sameOriginJson`). Sessions are server-side (`sessions` table, cookie holds a random token; DB stores its SHA-256).
- Passwords: scrypt (`server/lib/crypto.ts`), policy ≥ 12 chars. MFA (TOTP) required; codes are single-use. MFA secrets sealed with `APP_SECRET`.
- Admin changes are written to `audit_log` via `audit()`. Never log secrets.
- No secrets in `VITE_*` variables or committed files; `.env` only.
- CSP lives in `server/app.ts` (`secureHeaders`) — fonts are self-hosted (`@fontsource`), no external scripts.

## Production

Docker Compose on a Debian server; Nginx Proxy Manager on another server terminates HTTPS and forwards to port 3000. Owner runs deployments (see INSTALL.md). Never `docker compose down -v`.
