# AKAB Portal — notes for Claude Code

Portal for AKAB Informatique (MSP, Lanaudière): internal team first, clients next.
Brand follows akab.ca: ink `#0a0a0b`, paper `#f4f4f1`, gold gradient
`#ffe24a → #ffce1a → #f59410`, Bricolage Grotesque (display) + Instrument Sans
(body). Logo: `src/assets/akab-logo.webp` through `src/components/brand/Logo.tsx`
(`Logo` full, `LogoMark` bars + cursor, `Wordmark` lettering). The word AKAB as a
brand mark is always the `Wordmark` image, never typed in a font. Dark theme by default.
Any UI or design work (new page, section, component, restyle): load the
`design-taste-frontend` skill first and follow it. French by default, every text in `src/i18n/fr.ts`
**and** `src/i18n/en.ts`.

## Branches

- `master` is production. Work on `feat/...` / `fix/...` branches, merge when `npm run build` and `npm test` pass.
- `master` is the only branch on GitHub; no other branches or tags are kept.

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

## Weekly meeting (Rencontre hebdomadaire)

Administration tab `/meetings`, used live during the Monday team meeting (lists refresh every 10–30 s).

- Rights: `meetings.view` (see the page) and `meetings.manage` (change anything on it). Administrators only by default.
- API: `server/routes/meetings.ts`, mounted at `/api/meetings`. UI: `src/pages/meetings/` (`MeetingsPage`, `Points`, `Projects`, `Absences`).
- Sections, top to bottom:
  - **Points à discuter** (`meeting_points`): checked off when settled; settled ones stay visible 7 days.
  - **Billets en retard et à échéance cette semaine** (`GET /overdue`): open tickets from the ticket source (Autotask, or sample data locally) past due, or due by the end of Friday in Québec time (`fridayEnd` / `fridayDate`; on a weekend, the coming Friday). Every technician gets a card, even with nothing due; unassigned tickets get their own card.
  - **Projets en cours** (`meeting_projects`, `meeting_project_members`, `meeting_project_notes`): client (free text), due date (YYYY-MM-DD), team members (active staff only), notes newest first. Done projects are hidden behind "Terminés".
  - **Calendrier des absences** (`meeting_absences`): one row per person and date range (both days included), kind `vacation | sick | training | personal | other`.
- Absences are shared with the Tickets planning calendar: `GET /api/planning/absences` (same access rules as `/planning/calendar`) hatches absent days in `WeekCalendar`, and creating or moving a block on an absent day returns the `absent` warning (still saved).
- Migrations `0023`–`0026`. Tests: `tests/api.test.ts` ("weekly meeting: …") and `tests/meetings.test.ts` (Friday cut-off).

## Security rules

- Authorization is enforced in the API, never only in the UI. Use `auth(c)` / `requirePermission`; never trust ids or roles sent by the browser.
- Mutations: JSON only + same-origin check (`sameOriginJson`). Sessions are server-side (`sessions` table, cookie holds a random token; DB stores its SHA-256).
- Passwords: scrypt (`server/lib/crypto.ts`), policy ≥ 12 chars. MFA (TOTP) required in production (off by default in dev, `REQUIRE_MFA=true` to test); codes are single-use. MFA secrets sealed with `APP_SECRET`.
- Admin changes are written to `audit_log` via `audit()`. Never log secrets.
- "View as client" (`clientview.use`): the session stores `view_as_client_id`; `loadAuth` swaps `auth.user` to a read-only client identity (`auth.realUser` is the technician). `readOnlyViewAs` blocks every write except `/api/view-as` and logout. Client endpoints must scope by `auth.user.clientId`.
- No secrets in `VITE_*` variables or committed files; `.env` only.
- CSP lives in `server/app.ts` (`secureHeaders`) — fonts are self-hosted (`@fontsource`), no external scripts.

## Production

Docker Compose on a Debian server; Nginx Proxy Manager on another server terminates HTTPS and forwards to port 3000. Owner runs deployments (see INSTALL.md). Never `docker compose down -v`.
