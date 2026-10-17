# AKAB Portal

Portal for the AKAB Informatique team and its clients: technician workspace,
admin settings (technicians, clients, client users, roles and granular rights),
customizable dashboard and a message board to clients. French / English.

Also: tickets (Autotask) with planning, store inventory, Outlook, text
messages, and a **weekly meeting** page (points to discuss, overdue tickets
and those due by Friday per technician, projects in progress with notes and
assignees, absence calendar shared with the ticket planning).

**Profile**: wide two-column window; technicians keep only their cell phone.
Its **Microsoft 365** section is where each technician signs in with their own
Microsoft account (their mailbox joins the Outlook module, which they turn on
there; it is off by default) and sees their calendar sync.

**Microsoft 365**: one Entra app, used two ways — each technician's own
sign-in (delegated), and the organisation access for master administrators.
A master administrator chooses the calendars shown in each technician's
planning (anyone's, a chosen calendar, "details" or "busy only") and which
one receives the portal's blocks. Setup: INSTALL.md › Microsoft 365.

**Roles**: Administrateur principal (every right, locked), Administrateur
global (people and work, not roles, integrations or others' calendars),
Technicien, Lecture seule.

## Stack

| Part | Tech |
|------|------|
| Web | React 19, Vite, TypeScript, Tailwind 4, shadcn/ui, Motion, TanStack Query, i18next |
| API | Hono on Node 22 (`server/`) — REST, server-side sessions, permission checks |
| Data | PostgreSQL 16 + Drizzle ORM (migrations in `drizzle/`); PGlite locally |
| Deploy | Docker Compose (`Dockerfile`, `docker-compose.yml`) — see [INSTALL.md](INSTALL.md) |

## Develop

```bash
npm install
npm run dev        # web http://localhost:5173 + API :3001 (embedded PGlite in .data/)
npm test           # API tests (in-memory database)
npm run build      # type-check + production bundle
```

Local demo accounts (development only): `admin@akab.local` and
`tech@akab.local`, password `akab-dev-password`. MFA is off in development
(always on in production); set `REQUIRE_MFA=true` in `.env` to test it locally.
Delete `.data/` to reset.

## Layout

```
shared/permissions.ts   modules, rights, predefined roles (used by API and UI)
server/                 API: routes/, lib/ (auth, crypto, mail), db/ (schema, seed)
drizzle/                SQL migrations (npm run db:generate after schema changes)
src/                    web app: layouts/, pages/, admin/, components/, i18n/
tests/                  API tests (vitest)
```
