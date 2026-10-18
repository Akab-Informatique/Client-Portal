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
  - **Points à discuter** (`meeting_points`, half width): a fast text field; checked off when settled; settled ones stay visible 7 days. Beside it, **La semaine** (`GET /week?from=YYYY-MM-DD`, `Week.tsx`): Monday–Sunday; a day shows the team planning blocks (as `asSeen`/`seesFull` allow), absences, open tickets due and projects due that day, and Québec holidays. Events (`meeting_events`, migration 0041: date, optional HH:MM start/end, title, note, optional person) and absences are added/edited from the selected day (`/events` POST/PUT/DELETE, `meetings.manage`).
  - **Billets en retard et à échéance cette semaine** (`GET /overdue`): open tickets from the ticket source (Autotask, or sample data locally) past due, or due by the end of Friday in Québec time (`fridayEnd` / `fridayDate`; on a weekend, the coming Friday). Shown as two gauges (overdue / due by Friday), green → red at 25, critical at 35; under each, every technician (and the unassigned tickets) as a chip in the same colors — picking one shows their count on the gauge. A third gauge (`stray` in `/overdue`): open tickets with no technician whose status is past "new" (any due date), red at 5, critical at 10, chips per status. Clicking a gauge opens a short list of its tickets (for the person picked, if any); clicking the list opens Tickets with the same filter: overdue `view=due&due=overdue`, this week `view=all&statusKind=<open kinds>&due=week` (portal filter: not overdue, due by `fridayEnd`), stray `view=unassigned&statusKind=<open kinds but new>`, plus `assignee=<id|none>`.
  - **Projets en cours** (`meeting_projects`, `meeting_project_members`, `meeting_project_notes`): client (free text), due date (YYYY-MM-DD), team members (active staff only), notes newest first. Done projects are hidden behind "Terminés".
  - Absences (`meeting_absences`): one row per person and date range (both days included), kind `vacation | sick | training | personal | other`. No month calendar any more: they show and are added in **La semaine** at the top (`AbsenceDialog` in `Absences.tsx`).
  - **Projets en cours** will be linked to the sidebar **Projets** section (upcoming module `projects`, own sidebar section) once it is built.
- Absences are shared with the Tickets planning calendar: `GET /api/planning/absences` (same access rules as `/planning/calendar`) hatches absent days in `WeekCalendar`, and creating or moving a block on an absent day returns the `absent` warning (still saved).
- Migrations `0023`–`0026`. Tests: `tests/api.test.ts` ("weekly meeting: …") and `tests/meetings.test.ts` (Friday cut-off).

## Roles and Microsoft 365

- Built-in roles (`shared/permissions.ts` SYSTEM_ROLES): **Administrateur principal** (`administrator`, MASTER_ROLE, every right, locked), **Administrateur global** (`global-admin`: everything except MASTER_ONLY — roles, integrations, mail server, `admin.o365`, `outlook.anyMailbox`), **Technicien**, **Lecture seule**. Only a master admin gives the master role or edits / resets / disables a master admin (`assertMasterGuard` in `server/routes/admin.ts`).
- One Entra app registration, two ways: the **organisation access** (application permissions, any mailbox — master admins only) and each technician's **own sign-in** (delegated, OAuth code + PKCE, `server/lib/msauth.ts`, routes `/api/microsoft`, refresh token sealed in `ms_connections`). Graph calls inside `asUser` / `asConnection` (`server/lib/o365.ts`) go out as that person; `user(email)` becomes `me` for their own mailbox.
- Outlook module: own mailbox through the technician's sign-in (`mail_accounts.via = "user"`, linked automatically on sign-in). A mailbox shared with them in Exchange (support@…) is also linked `via = "user"` (delegated `Mail.ReadWrite.Shared` / `Mail.Send.Shared`): Microsoft checks their access at link time and on every call, so a mailbox they cannot open (admin, accounting) is refused (`outlook_no_access`, audited `outlook.link_refused`). Only `outlook.anyMailbox` (master admins) links through the organisation access (`via = "app"`).
- Tickets planning calendars: `calendar_links` per technician, chosen by a master admin (`admin.o365`), each `details` or `busy` ("Occupé — name" to anyone but its owner; private events always masked); the one with `push` receives the portal's blocks and day priorities. No link: their own calendar, in detail.

## CRM and the portal's own data (goal: replace Autotask)

- The portal keeps its own copy of everything; Autotask is the reference only while it is linked. Clients (`clients`, + `autotask_id`, `parent_id`, `invoice` jsonb), `client_contacts`, `client_contracts` (Autotask ids as text), `client_invoices` (last 3 years, cents, `paid_on`, `voided`; never deleted), `sync_state`. Migrations `0032`–`0033`. Sample data keeps portal edits (`demoCompanyPatches` / `demoContactPatches`) so a sync does not undo them.
- `server/lib/crm.ts`: `syncCrm()` at startup and every 15 min (full copy via `TicketSource.crmExport()`; never overwrites portal-only fields: notes, code, email, invoice). Writes from the portal go to Autotask first (`updateCompany` / `updateContact` / `addContact` / `addCompany`), then into the copy (`rememberCompany` / `rememberContact`). The Autotask ticket source reads clients, contacts and contracts from the copy once it exists.
- API `/api/crm` (`server/routes/crm.ts`): rights `crm.view` (technicians), `crm.edit`, `crm.billing`; `/status` drives the top-bar `SyncBadge`. UI `src/pages/crm/` (list, client page with tabs Info / Tickets / Invoices (`accounting.view`) / Contacts / Contracts / Invoice settings). Accounting (`accounting.view`): `src/pages/accounting/`, empty for now.
- Invoicing set-up (Admin › Facturation, `src/admin/BillingSection.tsx`, API `/api/billing`, `server/lib/billing.ts`): numbering, taxes, company details, template (stored in `integrations` provider `billing`), chart of accounts (`ledger_accounts`, starter chart seeded on first open, default accounts in settings) — right `admin.billing`. QuickBooks Online (OAuth, callback `/api/billing/quickbooks/callback`, refresh token sealed) and Stripe (keys sealed, test/live never mixed) also need `admin.integrations`. No data exchange with QuickBooks / Stripe yet.
- QuickBooks data (`server/lib/quickbooks.ts`, migration `0035`): clients ↔ customers (`clients.quickbooks_id`, unique; matches by normalized name/email are proposed and applied only once reviewed and accepted — `POST /quickbooks/mapping/accept` — or the client is created in QuickBooks, refused when the name exists). Chart of accounts and items are always proposed first (`GET /quickbooks/plan/accounts|items`) and only the accepted keys applied (`POST` same path): accounts tied by id, then number, then name, and given the QuickBooks name/number/type; QuickBooks-only ones added; portal-only ones turned off (never deleted; default accounts blocked). Items/categories copied to `quickbooks_items` by QuickBooks id; inventory tied by SKU and given the QuickBooks category when accepted; invoices sent by hand (`POST /api/crm/invoices/:id/quickbooks`, one line with the default item and tax code; re-sent = sparse update, never doubled), payments pulled every 15 min when the sync is on (`invoice_payments.source = quickbooks`, `external_id` unique).
- Client portal access: on CRM contacts (`client_contacts.user_id`), right `admin.clients`; none by default; giving it creates/reactivates a client user (random password, must change) and sends the welcome email (a set-password link, never the password). Removing it turns the account off. The admin Clients section is gone (CRM replaces it).
- Payments: `invoice_payments` (migration `0034`), recorded on a client's Factures tab (`accounting.manage`); status `partial` when part of the total is paid; never more than the balance.
- Accounting › Approbation (`/accounting/approvals`, `server/lib/billables.ts`, API `/api/billables`, migration `0036`): work to bill copied from Autotask (`TicketSource.billables(since)`: unposted billable time, ticket charges, billable expenses, contract service units, milestones ready to bill) into `billing_items` (one per source id; pending + unedited ones refreshed or dropped when gone from Autotask). Approve / exclude / edit (`accounting.manage`), or automatically: per client (`clients.invoice.autoApprove`: kinds) or per contract (`client_contracts.auto_approve`, items carry `contract_id`) — applied at import and when a rule is turned on (`applyAutoApprove`). The page has three folders (`?folder=work|staff|invoice`): work to bill (labour, charges, recurring contracts, milestones, projects to come), expenses and timesheets, and invoice creation: per client, kinds or single lines, invoice date, terms or an exact due date, PO number, notes (`client_invoices.notes`, `po_number`, migration `0037`), live preview (`POST /api/billables/invoice/preview`), then `POST /api/billables/invoice`; "every client" uses each client's defaults. Invoices get `invoice_lines`, GST/QST from the settings (client exempt honored), next number after the highest used. Copied after each CRM sync and on demand.
- Timesheets and expenses (migration `0038`, `server/lib/timesheets.ts`, API `/api/time`, pages `src/pages/time/`): rights `timesheets.use` (technicians) and `timesheets.approve`. Types in Admin › Temps et dépenses (`timesheet_types`, built-in `labour` = ticket time; `expense_types` with ledger account, unit/rate, billable). Validating a ticket timer adds a `timesheet_entries` row (source `ticket`, with the ticket). Weeks (`timesheets`, Monday) are submitted, then approved seeing hours per type only (no ticket, no note). Expenses (`expenses`, receipt base64, 5 MB) submitted then approved; billable ones become an approved `billing_items` row (source `portal`). QuickBooks, automatic when the sync and the part are on: portal invoices on creation, approved weeks as TimeActivity (employee matched by email/name → `users.quickbooks_employee_id`), approved expenses as Purchase (type account, bank account); failures retried by `quickbooksTick` every 15 min.
- Autotask invoice copy limited by Admin › Facturation (`autotask.invoicesSince`, `invoiceMinNumber`; default 2026-09-01 and 10000); copies outside it are removed unless paid or sent to QuickBooks. Default numbering: no prefix, 10000.
- Still to bring local: tickets' notes, time entries, charges and attachments (tickets themselves are mirrored in `autotask_tickets`).

## Security rules

- Authorization is enforced in the API, never only in the UI. Use `auth(c)` / `requirePermission`; never trust ids or roles sent by the browser.
- Mutations: JSON only + same-origin check (`sameOriginJson`). Sessions are server-side (`sessions` table, cookie holds a random token; DB stores its SHA-256).
- Passwords: scrypt (`server/lib/crypto.ts`), policy ≥ 12 chars. MFA (TOTP) required in production (off by default in dev, `REQUIRE_MFA=true` to test); codes are single-use. MFA secrets sealed with `APP_SECRET`.
- Admin changes are written to `audit_log` via `audit()`. Never log secrets.
- "View as client" (`clientview.use`): the session stores `view_as_client_id`; `loadAuth` swaps `auth.user` to a read-only client identity (`auth.realUser` is the technician). `readOnlyViewAs` blocks every write except `/api/view-as` and logout. Client endpoints must scope by `auth.user.clientId`.
- No secrets in `VITE_*` variables or committed files; `.env` only.
- CSP lives in `server/app.ts` (`secureHeaders`) — fonts are self-hosted (`@fontsource`), no external scripts.
- Graph paths built from browser input go through `safeGraphPath` (in `graph()`): no `.`/`..` segment once decoded, no `%2f`/`%5c`/whitespace. Organisation-access mailboxes (`via = "app"`) need `outlook.anyMailbox` on every request.
- `assertMasterGuard` also protects MASTER_ONLY rights: a non-master cannot give a role carrying one, nor edit/reset/disable someone holding one.
- Password links: built from `PUBLIC_URL` only in production (never the Host header); cleared on password, email or status change (`forgetPasswordLinks`). Client users of an inactive client cannot sign in (`accountUsable`).
- Nobody approves their own timesheet or expense. Invoice creation is one transaction. QuickBooks creations carry a `requestid` (idempotent) and run one at a time. Full Autotask copies use `complete: true` (fail instead of truncating, so nothing looks deleted).
- One app instance only (in-process locks, numbering, background jobs).

## Production

Docker Compose on a Debian server; Nginx Proxy Manager on another server terminates HTTPS and forwards to port 3000. Owner runs deployments (see INSTALL.md). Never `docker compose down -v`.
