# Opportunités: API

Backend of the Opportunités module (a lead a technician flags for the sales technician; the backlog of what
was won, lost or canceled and what each one became). Code: `server/routes/opps.ts` (mounted at `/api/opps`),
tables `opps`, `opp_links`, `opp_notes` (migration `0193`), constants in `shared/opps.ts`, tests `tests/opps.test.ts`.

All routes need a staff session (`requireStaff`) and the right listed. Every body is JSON and validated (400
`Validation failed`, with field errors in `cause`). Errors are `{ "error": "<code>" }`. Closed opportunities are
**archived, never deleted**: there is no `DELETE /api/opps/:id`.

## Rights

| Right | Gives |
| --- | --- |
| `opps.view` | Lists, detail, report, badge, by-ticket (technicians and administrators by default) |
| `opps.create` | Flag an opportunity, add a note, notify candidates (technicians by default) |
| `opps.manage` | Take, assign, change, link, unlink, close, reopen (administrators only by default) |

Money in the report (values, margins) is only returned to a caller holding `accounting.view` or `quotes.view`.

## Enumerations (`shared/opps.ts`)

- `source`: `ticket | sales_call | tech_call | onsite | email | other`
- `handling`: `quote_only` (send a quote only) | `needs_call` (call the client to make the sale)
- `status`: `new` (flagged, nobody on it) | `working` (someone has it) | `won` | `lost` | `canceled` (closed)
- `lostReason`: `price | timing | incumbent | no_answer | other`
- link `kind`: `quote | contract | charge | project`

## Shapes

**Row** (in lists, and at the top of detail):

```json
{
  "id": "uuid", "number": "O-1001", "description": "text", "source": "ticket", "handling": "quote_only",
  "status": "new", "open": true,
  "client": { "id": "uuid", "name": "Garage Lavoie" },
  "contact": { "id": "uuid", "name": "Anne Roy", "email": "anne@x.ca", "phone": "450-555-0101" },
  "owner": { "id": "uuid", "name": "Alex Tremblay" } ,
  "createdBy": "Alex Tremblay",
  "ticket": { "id": 1000000012, "number": "T20261123.0001", "title": "Imprimante en panne" },
  "linkCount": 2, "lostReason": null, "closeNote": null,
  "createdAt": "ISO", "updatedAt": "ISO", "takenAt": "ISO|null", "closedAt": "ISO|null"
}
```
`owner` is `null` when nobody has it. `ticket` is `null` unless flagged from a ticket; its number and title are a
snapshot read from the ticket source when it was flagged (never from the browser).

**Detail** = Row + `links` + `notes`:

```json
{
  "...row": "...",
  "links": [{ "id": "uuid", "kind": "quote", "refId": "uuid", "label": "S-1004 - Serveurs", "createdBy": "Name", "createdAt": "ISO" }],
  "notes": [{ "id": "uuid", "kind": "note|system", "text": "…", "author": "Name|null", "createdAt": "ISO" }]
}
```
Notes are oldest first. System notes (`kind: "system"`, `author: null`) are written on: flagged, taken / assigned,
owner removed, link added / removed, closed, reopened. Their text names the person who did it.

## Endpoints

### GET /api/opps/badge  (`opps.view`)
Cheap count for the sidebar, every minute.
→ `{ "new": 2, "mine": 1 }` — `new`: opportunities with status `new`; `mine`: open ones (`new` or `working`) whose owner is the caller.

### GET /api/opps/notify-candidates  (`opps.create`)
The people a new opportunity can be sent to: active staff who hold `opps.view`.
→ `[{ "id": "uuid", "name": "Alex Tremblay", "sales": false }]` — `sales: true` for those who hold `opps.manage` (to preselect them).

### GET /api/opps/report?from=YYYY-MM-DD&to=YYYY-MM-DD  (`opps.view`)
Opportunities **created** in the range (Québec days). Default: the last 365 days up to today.
→
```json
{
  "from": "2025-11-23", "to": "2026-11-23", "money": true,
  "totals": {
    "total": 4,
    "byStatus": { "new": 2, "working": 1, "won": 1, "lost": 0, "canceled": 0 },
    "open": 3, "closed": 1,
    "conversionPct": 100,
    "avgDaysToClose": 3.5,
    "wonValueCents": 620000, "wonMarginCents": 320000
  },
  "bySource": { "ticket": 1, "sales_call": 1, "other": 2 },
  "byTechnician": [{ "name": "Alex Tremblay", "count": 3 }],
  "closed": [
    { "...row": "...", "valueCents": 620000, "marginCents": 320000,
      "links": [{ "kind": "quote", "refId": "uuid", "label": "S-1001 - Serveur", "valueCents": 620000, "marginCents": 320000 }] }
  ]
}
```
- `conversionPct` = won ÷ (won + lost + canceled), `null` when nothing closed. `avgDaysToClose` in days (one decimal), `null` when none closed.
- `money: false` (a technician) → every `valueCents` / `marginCents` / `wonValueCents` / `wonMarginCents` is `null`.
- Value per link: **quote** = the implementation before taxes + 12 × monthly lines + the first year of yearly lines;
  margin likewise (sold minus cost). **contract** = 12 × its monthly figure (`null` without one). **charge** = price ×
  quantity after rebate; margin = that less the cost × quantity. **project** = its fixed price (`null` otherwise); no margin.
  A target deleted since keeps its label, with `null` values. An opportunity's value is the sum of its links (`null` when none has a value).

### GET /api/opps/by-ticket/:ticketId  (`opps.view`)
The opportunities already made from a ticket (for the ticket window). The ticket must be visible to the caller (else 404).
→ `[{ "id": "uuid", "number": "O-1003", "status": "new" }]`

### GET /api/opps?status=&owner=&client=&ticket=&source=&q=&page=&size=  (`opps.view`)
- `status`: `open` (default: new + working) | `closed` (won, lost, canceled) | `all`
- `owner`: `me` | `none` (no owner) | a staff uuid
- `client`: a client uuid; `ticket`: a ticket number (exact); `source`: one of the sources
- `q`: words, any order, accents and case ignored, over the number, the client name, the contact name and the description
- `page` (1), `size` (50, max 100)

→
```json
{ "items": [Row], "total": 12, "page": 1, "size": 50,
  "counts": { "open": 3, "new": 2, "working": 1, "closed": 9 } }
```
`counts` is the whole backlog, whatever the filter. Newest first.

### POST /api/opps  (`opps.create`, 30 an hour per person)
Flag an opportunity from a client and one of its contacts.

Body:
```json
{
  "clientId": "uuid", "contactId": "uuid",
  "description": "1 to 4000 characters",
  "source": "sales_call",            // optional, default "other" (forced to "ticket" with ticketId)
  "handling": "needs_call",          // optional, default "quote_only"
  "ticketId": 1000000012,            // optional: the origin ticket (visible to the caller)
  "ownerId": "uuid",                 // optional, needs opps.manage: takes it at once (status working)
  "notifyUserIds": ["uuid"]          // optional, max 20: who is told (bell + email). Absent: every manager gets the bell.
}
```
→ `201` Detail + `"notified": n, "notifyFailed": n`.
- `notified`: people who got the bell. `notifyFailed`: chosen people whose email failed or has no address. A mail failure never fails the creation.
- With `ticketId`: the client is the ticket's company (`ticket_no_client` when none of ours matches it; a `clientId` sent must be that one, else `400 ticket_other_client`). The contact is the `contactId` sent, else the ticket's contact when it is one of that client's active contacts, else `400 contact_required`.
- Without `ticketId`: `clientId` (`400 client_required`) and `contactId` (`400 contact_required`) are needed.
- `notifyUserIds` present: each must be active staff holding `opps.view` (else `400 person_invalid`); the caller is left out silently. Each gets the bell (`opp.new`, link `/opps?opp=<id>`) and an email (subject `[O-1001] <client>`, the client, the contact, who flagged it, the handling, the first 500 characters of the description, and the link).
- Absent: the bell goes to every active manager (`opps.manage`) except the caller; no email.
- Audit: `opp.created`; `opp.notified` (recipient ids only).

Status is `working` (owner set) or `new`. The origin ticket's number and title come from the ticket source.

### GET /api/opps/clients?q=  (`opps.create`)
Clients to pick when flagging: active only, word by word (accents and case ignored), 20 at most.
→ `[{ "id": "uuid", "name": "Garage Lavoie", "autotaskId": 880001 }]`

### GET /api/opps/clients/:id/contacts  (`opps.create`)
The active contacts of an active client (`404` otherwise). → `[{ "id": "uuid", "name": "Anne Roy", "email": "…", "phone": "…", "title": "…" }]`

### GET /api/opps/clients/:id/linkables?kind=quote|contract|project  (`opps.manage`)
What of the client an opportunity can be linked to, with the labels the link route stores (100 at most):
- `quote`: every quote of the client, newest first → `[{ "id": "uuid", "label": "S-1004 - Serveurs" }]`
- `contract`: the client's active contracts; label = the contract's name
- `project`: the client's new-format projects not done or cancelled; label `P-1011 - name`

Any other `kind`: `400 invalid_kind`. Unknown or inactive client: `404`. No money in the answer.

### GET /api/opps/:id  (`opps.view`)
→ Detail. `404 not_found` for an unknown or non-uuid id.

### PATCH /api/opps/:id  (`opps.manage`)
Body (all optional): `{ "description", "handling", "source", "contactId", "ownerId" }` (`ownerId: null` removes the owner).
- Open opportunities only: `409 opp_closed`.
- `contactId` must be an active contact of the opportunity's client (`400 contact_invalid`).
- `ownerId` must be active staff (`400 owner_invalid`). A new owner gets the bell `opp.assigned` (unless it is the caller); an unowned `new` one becomes `working`.
- → Detail. Audit `opp.updated` (the changed field names).

### POST /api/opps/:id/take  (`opps.manage`)
The caller takes it: owner = caller, status `working`, `takenAt` now. Open only (`409 opp_closed`). → Detail.

### POST /api/opps/:id/notes  (`opps.create`)
Body: `{ "text": "1 to 4000 characters" }`. Allowed on closed opportunities too. → `201` Detail.

### POST /api/opps/:id/links  (`opps.manage`)
Body: `{ "kind": "quote|contract|charge|project", "refId": "uuid" }`. Allowed on open and closed opportunities.
The server checks the target and builds the label (any label sent is ignored):

| kind | target | label | refused |
| --- | --- | --- | --- |
| `quote` | `quotes.id` | `S-1004 - title` | another client's quote: `400 target_other_client` |
| `contract` | `client_contracts.id` | contract name | another client: `400 target_other_client` |
| `charge` | `ticket_charges.id` | `charge name (T20261123.0001)` or `(P-1001)` | the ticket's company, or the project's client, must be the opportunity's client |
| `project` | `proj_projects.id` | `P-1011 - name` | another client: `400 target_other_client` |

- Unknown target: `404 target_not_found`. A charge on a ticket is only found through the staff-scoped ticket source (hidden → not found).
- Same target twice: `409 link_exists`. Non-uuid `refId`: `400`.
- → `201` Detail. System note and audit `opp.link_added`.

### DELETE /api/opps/:id/links/:linkId  (`opps.manage`)
Takes a link off (open or closed). → Detail. `404 not_found` for a link of another opportunity. System note, audit `opp.link_removed`.

### POST /api/opps/:id/close  (`opps.manage`)
Body: `{ "status": "won|lost|canceled", "lostReason": "price|…" (required for lost), "closeNote": "0 to 1000 characters" }`
- Already closed: `409 opp_closed`. `won` needs at least one link: `409 link_required`. `lost` needs `lostReason`: `400 lost_reason_required`.
- Sets `closedAt`; an owner is set to the caller when there is none. `lostReason` is kept for lost (and canceled when given), cleared for won.
- → Detail. Audit `opp.closed`.

### POST /api/opps/:id/reopen  (`opps.manage`)
Open opportunities answer `409 opp_open`. Otherwise: status `working`, `closedAt` and `lostReason` cleared. → Detail. Audit `opp.reopened`.

## Notifications

| type | to | link | when |
| --- | --- | --- | --- |
| `opp.new` | managers (or the chosen people) | `/opps?opp=<id>` | a new opportunity |
| `opp.assigned` | the new owner | `/opps?opp=<id>` | assigned to someone else by a manager |

Push text for both is in `server/lib/pushNotify.ts`.

## Errors (codes)

`client_invalid`, `contact_invalid`, `owner_invalid`, `person_invalid`, `ticket_not_found` (404), `ticket_other_client`,
`opp_closed` (409), `opp_open` (409), `link_required` (409), `lost_reason_required`, `target_not_found` (404),
`target_other_client`, `ticket_no_client`, `client_required`, `contact_required`, `invalid_kind`, `link_exists` (409), `rate_limited` (429), `forbidden` (403, a right missing), `not_found` (404).
