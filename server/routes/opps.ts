import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { notifyTechs } from "../lib/techNotify.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { todayQc } from "../lib/quotes.ts";
import { body, zUuid } from "../lib/validate.ts";
import { quoteTotals } from "../../shared/quotes.ts";
import { netCents } from "../../shared/rebate.ts";
import { OPP_HANDLINGS, OPP_LINK_KINDS, OPP_LOST_REASONS, OPP_SOURCES, OPP_STATUSES, isOpenOpp, type OppLinkKind } from "../../shared/opps.ts";

/**
 * Opportunités (shared/opps.ts): a lead a technician flags for the sales technician. Routes need opps.view
 * (read), opps.create (flag, notes) or opps.manage (take, assign, link, close, reopen). Closed opportunities are
 * archived: there is NO delete route for an opportunity, by design.
 */

/** Lower case, no accents, punctuation as spaces; every word typed is somewhere in the text, in any order */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The labels of what an opportunity can be linked to: the same ones the link route stores, and the lookup shows */
const quoteLabel = (q: { number: string; title: string }) => `${q.number} - ${q.title || "Sans titre"}`;
const projectLabel = (p: { number: string; name: string }) => `${p.number} - ${p.name}`;

const pgCode = (e: unknown): string | undefined => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const isUuid = (s: string) => zUuid.safeParse(s).success;
const validDate = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const zText = (max: number) => z.string().trim().min(1).max(max);
const zCreate = z.object({
  /** Required, except with a ticketId: then the client is the ticket's */
  clientId: zUuid.optional(),
  /** Required, except with a ticketId: then the ticket's contact (when it maps to one of the client's contacts) */
  contactId: zUuid.optional(),
  description: zText(4000),
  source: z.enum(OPP_SOURCES).optional(),
  handling: z.enum(OPP_HANDLINGS).optional(),
  ticketId: z.number().int().positive().nullable().optional(),
  ownerId: zUuid.nullable().optional(),
  /** The technicians the person chose to tell (bell and email). Absent: every manager gets the bell. */
  notifyUserIds: z.array(zUuid).max(20).optional(),
});
const zPatch = z.object({
  description: zText(4000).optional(),
  handling: z.enum(OPP_HANDLINGS).optional(),
  source: z.enum(OPP_SOURCES).optional(),
  contactId: zUuid.optional(),
  ownerId: zUuid.nullable().optional(),
});
const zClose = z.object({
  status: z.enum(["won", "lost", "canceled"]),
  lostReason: z.enum(OPP_LOST_REASONS).nullable().optional(),
  closeNote: z.string().trim().max(1000).transform((s) => s || null).nullable().optional(),
});
const zLink = z.object({ kind: z.enum(OPP_LINK_KINDS), refId: zUuid });
const zNote = z.object({ text: zText(4000) });

const HANDLING_FR: Record<string, string> = { quote_only: "Soumission seulement", needs_call: "Appeler le client pour faire la vente" };
const KIND_FR: Record<OppLinkKind, string> = { quote: "soumission", contract: "contrat", charge: "frais", project: "projet" };
const STATUS_FR: Record<string, string> = { won: "gagnée", lost: "perdue", canceled: "annulée" };
const CLOSED = ["won", "lost", "canceled"];

const opps = schema.opps;
const creator = alias(schema.users, "opp_creator");
const owner = alias(schema.users, "opp_owner");

/** An opportunity with its client, contact, owner and creator names, and its link count */
function joined() {
  return db()
    .select({
      opp: opps,
      clientName: schema.clients.name,
      contactFirst: schema.clientContacts.firstName,
      contactLast: schema.clientContacts.lastName,
      contactEmail: schema.clientContacts.email,
      contactPhone: schema.clientContacts.phone,
      ownerName: owner.name,
      creatorName: creator.name,
      linkCount: sql<number>`(select count(*)::int from ${schema.oppLinks} where ${schema.oppLinks.oppId} = ${opps.id})`,
    })
    .from(opps)
    .innerJoin(schema.clients, eq(schema.clients.id, opps.clientId))
    .innerJoin(schema.clientContacts, eq(schema.clientContacts.id, opps.contactId))
    .leftJoin(owner, eq(owner.id, opps.ownerId))
    .innerJoin(creator, eq(creator.id, opps.createdBy));
}
type Joined = {
  opp: typeof opps.$inferSelect;
  clientName: string;
  contactFirst: string;
  contactLast: string;
  contactEmail: string | null;
  contactPhone: string | null;
  ownerName: string | null;
  creatorName: string;
  linkCount: number;
};

function shape(r: Joined) {
  const o = r.opp;
  return {
    id: o.id,
    number: o.number,
    description: o.description,
    source: o.source,
    handling: o.handling,
    status: o.status,
    open: isOpenOpp(o.status),
    client: { id: o.clientId, name: r.clientName },
    contact: { id: o.contactId, name: `${r.contactFirst} ${r.contactLast}`.trim(), email: r.contactEmail, phone: r.contactPhone },
    owner: o.ownerId ? { id: o.ownerId, name: r.ownerName ?? "" } : null,
    createdBy: r.creatorName,
    ticket: o.ticketId ? { id: o.ticketId, number: o.ticketNumber, title: o.ticketTitle } : null,
    linkCount: r.linkCount,
    lostReason: o.lostReason,
    closeNote: o.closeNote,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    takenAt: o.takenAt?.toISOString() ?? null,
    closedAt: o.closedAt?.toISOString() ?? null,
  };
}

/** One opportunity in full: its row, links and notes (oldest first) */
async function detail(id: string) {
  const [r] = await joined().where(eq(opps.id, id));
  if (!r) throw new HTTPException(404, { message: "not_found" });
  const links = await db()
    .select({ l: schema.oppLinks, by: schema.users.name })
    .from(schema.oppLinks)
    .leftJoin(schema.users, eq(schema.users.id, schema.oppLinks.createdBy))
    .where(eq(schema.oppLinks.oppId, id))
    .orderBy(asc(schema.oppLinks.createdAt));
  const notes = await db()
    .select({ n: schema.oppNotes, by: schema.users.name })
    .from(schema.oppNotes)
    .leftJoin(schema.users, eq(schema.users.id, schema.oppNotes.authorId))
    .where(eq(schema.oppNotes.oppId, id))
    .orderBy(asc(schema.oppNotes.createdAt));
  return {
    ...shape(r),
    links: links.map((x) => ({ id: x.l.id, kind: x.l.kind, refId: x.l.refId, label: x.l.label, createdBy: x.by ?? null, createdAt: x.l.createdAt.toISOString() })),
    notes: notes.map((x) => ({ id: x.n.id, kind: x.n.kind, text: x.n.text, author: x.by ?? null, createdAt: x.n.createdAt.toISOString() })),
  };
}

async function current(id: string) {
  const [o] = await db().select().from(opps).where(eq(opps.id, id));
  if (!o) throw new HTTPException(404, { message: "not_found" });
  return o;
}

const oppIdOf = (c: Context<AppEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!isUuid(id)) throw new HTTPException(404, { message: "not_found" });
  return id;
};

/** The contact of a client that a ticket names (the ticket's contact id is the contact's autotask id), active only */
async function contactOfTicket(clientId: string, contactRef: string | null | undefined): Promise<string | null> {
  if (!contactRef) return null;
  const [k] = await db()
    .select({ id: schema.clientContacts.id })
    .from(schema.clientContacts)
    .where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.autotaskId, contactRef), eq(schema.clientContacts.active, true)));
  return k?.id ?? null;
}

async function activeStaff(id: string): Promise<{ id: string; name: string } | null> {
  const [u] = await db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  return u ?? null;
}

/** A system note: what happened and who did it (authorId null) */
async function sysNote(oppId: string, text: string) {
  await db().insert(schema.oppNotes).values({ oppId, authorId: null, kind: "system", text });
}

/** OPP-1001 style numbers: the highest + 1, from 1001 (the same approach as quote numbers) */
async function nextOppNumber(): Promise<string> {
  const rows = await db().select({ number: opps.number }).from(opps).where(sql`${opps.number} like 'O-%'`);
  const max = rows.reduce((n, r) => Math.max(n, Number(r.number.slice(2)) || 0), 1000);
  return `O-${max + 1}`;
}

/** Inserts an opportunity with the next number; a clash with a concurrent insert takes the next one */
async function insertOpp(values: Omit<typeof opps.$inferInsert, "number">) {
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db()
        .insert(opps)
        .values({ ...values, number: await nextOppNumber() })
        .returning();
      return row;
    } catch (e) {
      if (attempt < 2 && pgCode(e) === "23505") continue;
      throw e;
    }
  }
}

/**
 * The target of a link, checked here: it exists and belongs to the opportunity's client. The label is built here
 * too (never taken from the browser). A ticket charge is only seen through the staff-scoped ticket source.
 */
async function targetOf(kind: OppLinkKind, refId: string, client: { id: string; autotaskId: number | null }): Promise<string> {
  const notFound = () => new HTTPException(404, { message: "target_not_found" });
  const other = () => new HTTPException(400, { message: "target_other_client" });
  const d = db();
  if (kind === "quote") {
    const [q] = await d.select({ number: schema.quotes.number, title: schema.quotes.title, clientId: schema.quotes.clientId }).from(schema.quotes).where(eq(schema.quotes.id, refId));
    if (!q) throw notFound();
    if (q.clientId !== client.id) throw other();
    return quoteLabel(q);
  }
  if (kind === "contract") {
    const [k] = await d.select({ name: schema.clientContracts.name, clientId: schema.clientContracts.clientId }).from(schema.clientContracts).where(eq(schema.clientContracts.id, refId));
    if (!k) throw notFound();
    if (k.clientId !== client.id) throw other();
    return k.name;
  }
  if (kind === "project") {
    const [p] = await d.select({ number: schema.projProjects.number, name: schema.projProjects.name, clientId: schema.projProjects.clientId }).from(schema.projProjects).where(eq(schema.projProjects.id, refId));
    if (!p) throw notFound();
    if (p.clientId !== client.id) throw other();
    return projectLabel(p);
  }
  // a charge: on a ticket (the company of the ticket), an archive project or a new-format project
  const [ch] = await d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.id, refId));
  if (!ch) throw notFound();
  if (ch.ticketId !== null) {
    const tk = await (await ticketSource()).get(ch.ticketId).catch(() => null);
    if (!tk) throw notFound();
    if (client.autotaskId === null || tk.company.id !== client.autotaskId) throw other();
    return `${ch.name} (${tk.number})`;
  }
  if (ch.projectId) {
    const [p] = await d.select({ number: schema.projects.number, clientId: schema.projects.clientId }).from(schema.projects).where(eq(schema.projects.id, ch.projectId));
    if (!p) throw notFound();
    if (p.clientId !== client.id) throw other();
    return `${ch.name} (${p.number})`;
  }
  if (ch.projId) {
    const [p] = await d.select({ number: schema.projProjects.number, clientId: schema.projProjects.clientId }).from(schema.projProjects).where(eq(schema.projProjects.id, ch.projId));
    if (!p) throw notFound();
    if (p.clientId !== client.id) throw other();
    return `${ch.name} (${p.number})`;
  }
  throw notFound();
}

/**
 * Money of the links, for the report: value and margin per link target, only for a caller who may see money.
 * A quote: the implementation before taxes, plus 12 × monthly and the first year of yearly lines; margin likewise.
 * A contract: 12 × its monthly figure. A charge: price × quantity after rebate, margin less its cost. A project: its fixed price.
 * A target that was deleted has no value (its label stays).
 */
async function valuesOf(links: { kind: string; refId: string }[]) {
  const out = new Map<string, { valueCents: number | null; marginCents: number | null }>();
  const ids = (kind: string) => [...new Set(links.filter((l) => l.kind === kind && isUuid(l.refId)).map((l) => l.refId))];
  const d = db();

  const qIds = ids("quote");
  if (qIds.length) {
    const quotes = await d.select({ id: schema.quotes.id }).from(schema.quotes).where(inArray(schema.quotes.id, qIds));
    const lines = await d.select().from(schema.quoteLines).where(inArray(schema.quoteLines.quoteId, qIds));
    for (const q of quotes) {
      const mine = lines.filter((l) => l.quoteId === q.id);
      const t = quoteTotals(mine, true, { gstRate: 0, qstRate: 0 });
      out.set(`quote:${q.id}`, {
        valueCents: t.subtotalCents + 12 * t.monthly.subtotalCents + t.yearly.subtotalCents,
        marginCents: t.marginCents + 12 * t.monthly.marginCents + t.yearly.marginCents,
      });
    }
  }

  const kIds = ids("contract");
  if (kIds.length) {
    const rows = await d.select({ id: schema.clientContracts.id, monthly: schema.clientContracts.monthlyRateCents }).from(schema.clientContracts).where(inArray(schema.clientContracts.id, kIds));
    for (const k of rows) out.set(`contract:${k.id}`, { valueCents: k.monthly === null ? null : 12 * k.monthly, marginCents: null });
  }

  const cIds = ids("charge");
  if (cIds.length) {
    const rows = await d.select().from(schema.ticketCharges).where(inArray(schema.ticketCharges.id, cIds));
    for (const ch of rows) {
      const value = ch.unitPriceCents === null ? null : Math.round((ch.quantityX100 * netCents(ch.unitPriceCents, ch.rebateBps)) / 100);
      const cost = Math.round((ch.quantityX100 * (ch.unitCostCents ?? 0)) / 100);
      out.set(`charge:${ch.id}`, { valueCents: value, marginCents: value === null ? null : value - cost });
    }
  }

  const pIds = ids("project");
  if (pIds.length) {
    const rows = await d.select({ id: schema.projProjects.id, fixed: schema.projProjects.fixedPriceCents }).from(schema.projProjects).where(inArray(schema.projProjects.id, pIds));
    for (const p of rows) out.set(`project:${p.id}`, { valueCents: p.fixed ?? null, marginCents: null });
  }
  return out;
}

type Announced = { notified: number; notifyFailed: number; recipients: string[] };

/**
 * Tells colleagues about a new opportunity: the bell (`opp.new`) and, for the people the flagger chose, an email too.
 * `pick` null = every manager (bell only, the earlier behaviour). Never throws: a mail failure is only counted.
 */
async function announce(
  o: { id: string; number: string; description: string; handling: string },
  clientName: string,
  contactName: string,
  from: { id: string; name: string },
  pick: string[] | null,
): Promise<Announced> {
  const link = `/opps?opp=${o.id}`;
  const ids = pick === null ? await usersWith("staff", "opps.manage") : [...new Set(pick)];
  const recipients = ids.filter((id) => id !== from.id);
  if (!recipients.length) return { notified: 0, notifyFailed: 0, recipients: [] };
  await notify(recipients, { type: "opp.new", data: { number: o.number, client: clientName }, link });
  if (pick === null) return { notified: recipients.length, notifyFailed: 0, recipients };
  const message = [
    `Client : ${clientName}`,
    `Contact : ${contactName}`,
    `Signalée par : ${from.name}`,
    `Traitement : ${HANDLING_FR[o.handling] ?? o.handling}`,
    "",
    o.description.slice(0, 500),
  ].join("\n");
  let notifyFailed = recipients.length;
  try {
    const res = await notifyTechs(
      { id: 0, number: o.number, title: clientName, company: { name: clientName }, link, head: `vous signale l'opportunité ${o.number} pour ${clientName}` },
      from,
      recipients,
      message,
      { email: true, sms: false, teams: false, bell: false },
    );
    notifyFailed = res.filter((r) => r.email === "failed" || r.email === "no_address").length;
  } catch (e) {
    console.warn("[opps] notify by email failed", e);
  }
  return { notified: recipients.length, notifyFailed, recipients };
}

/** Opportunités (opps.view to see, opps.create to flag and add notes, opps.manage to take, link, close). */
export const oppsRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** The sidebar's count, every minute: new ones, and open ones I own. */
  .get("/badge", requirePermission("opps.view"), async (c) => {
    const a = auth(c);
    const [r] = await db()
      .select({
        fresh: sql<number>`count(*) filter (where ${opps.status} = 'new')::int`,
        mine: sql<number>`count(*) filter (where ${opps.ownerId} = ${a.user.id} and ${opps.status} in ('new', 'working'))::int`,
      })
      .from(opps);
    return c.json({ new: r?.fresh ?? 0, mine: r?.mine ?? 0 });
  })

  /** Who can be told about a new opportunity: active staff who see opportunities; `sales` = those who manage them (preselected) */
  .get("/notify-candidates", requirePermission("opps.create"), async (c) => {
    const viewers = new Set(await usersWith("staff", "opps.view"));
    const managers = new Set(await usersWith("staff", "opps.manage"));
    const people = await db()
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
      .orderBy(asc(schema.users.name));
    return c.json(people.filter((p) => viewers.has(p.id)).map((p) => ({ id: p.id, name: p.name, sales: managers.has(p.id) })));
  })

  /** The report: totals by status, source and technician, conversion, average time to close, and the closed ones with their links */
  .get("/report", requirePermission("opps.view"), async (c) => {
    const a = auth(c);
    const today = todayQc();
    const qs = c.req.query();
    const to = validDate(qs.to) ?? today;
    const from = validDate(qs.from) ?? addDays(today, -365);
    // the days in Québec time, created in [from, to]
    const start = new Date(`${from}T00:00:00-05:00`);
    const end = new Date(new Date(`${to}T00:00:00-05:00`).getTime() + 86_400_000);
    const rows = await joined().where(and(gte(opps.createdAt, start), lt(opps.createdAt, end))).orderBy(desc(opps.createdAt));
    const ids = rows.map((r) => r.opp.id);
    const links = ids.length ? await db().select().from(schema.oppLinks).where(inArray(schema.oppLinks.oppId, ids)) : [];
    const money = a.permissions.includes("accounting.view") || a.permissions.includes("quotes.view");
    const values = money ? await valuesOf(links) : new Map<string, { valueCents: number | null; marginCents: number | null }>();
    const valueOf = (kind: string, refId: string) => (money ? (values.get(`${kind}:${refId}`) ?? { valueCents: null, marginCents: null }) : { valueCents: null, marginCents: null });
    const sumOf = (xs: (number | null)[]) => {
      const known = xs.filter((x): x is number => x !== null);
      return known.length ? known.reduce((n, x) => n + x, 0) : null;
    };

    const byStatus = Object.fromEntries(OPP_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    const bySource: Record<string, number> = {};
    const byTech = new Map<string, number>();
    for (const r of rows) {
      byStatus[r.opp.status] = (byStatus[r.opp.status] ?? 0) + 1;
      bySource[r.opp.source] = (bySource[r.opp.source] ?? 0) + 1;
      byTech.set(r.creatorName, (byTech.get(r.creatorName) ?? 0) + 1);
    }
    const won = rows.filter((r) => r.opp.status === "won");
    const closedRows = rows.filter((r) => CLOSED.includes(r.opp.status));
    const closedMs = rows.filter((r) => r.opp.closedAt).map((r) => r.opp.closedAt!.getTime() - r.opp.createdAt.getTime());
    const oppValue = (r: Joined) => {
      const ls = links.filter((l) => l.oppId === r.opp.id);
      return { valueCents: sumOf(ls.map((l) => valueOf(l.kind, l.refId).valueCents)), marginCents: sumOf(ls.map((l) => valueOf(l.kind, l.refId).marginCents)) };
    };

    return c.json({
      from,
      to,
      money,
      totals: {
        total: rows.length,
        byStatus,
        open: byStatus.new + byStatus.working,
        closed: closedRows.length,
        conversionPct: closedRows.length ? Math.round((won.length / closedRows.length) * 1000) / 10 : null,
        avgDaysToClose: closedMs.length ? Math.round((closedMs.reduce((n, ms) => n + ms, 0) / closedMs.length / 86_400_000) * 10) / 10 : null,
        wonValueCents: money ? sumOf(won.map((r) => oppValue(r).valueCents)) : null,
        wonMarginCents: money ? sumOf(won.map((r) => oppValue(r).marginCents)) : null,
      },
      bySource,
      byTechnician: [...byTech.entries()].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count),
      closed: closedRows.map((r) => ({
        ...shape(r),
        ...oppValue(r),
        links: links
          .filter((l) => l.oppId === r.opp.id)
          .map((l) => ({ kind: l.kind, refId: l.refId, label: l.label, ...valueOf(l.kind, l.refId) })),
      })),
    });
  })

  /** The opportunities already made from a ticket (for the ticket window); the ticket must be visible to the caller */
  .get("/by-ticket/:ticketId", requirePermission("opps.view"), async (c) => {
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId) || ticketId <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const t = await (await ticketSource()).get(ticketId).catch(() => null);
    if (!t) throw new HTTPException(404, { message: "not_found" });
    const rows = await db()
      .select({ id: opps.id, number: opps.number, status: opps.status })
      .from(opps)
      .where(eq(opps.ticketId, ticketId))
      .orderBy(asc(opps.createdAt));
    return c.json(rows);
  })

  /** The list: open by default; filters owner (me | none | id), client, ticket number, source; search word by word; 50 a page */
  .get("/", requirePermission("opps.view"), async (c) => {
    const a = auth(c);
    const qs = c.req.query();
    const status = qs.status === "closed" || qs.status === "all" ? qs.status : "open";
    const conds: SQL[] = [];
    if (status === "open") conds.push(inArray(opps.status, ["new", "working"]));
    if (status === "closed") conds.push(inArray(opps.status, CLOSED));
    if (qs.owner === "me") conds.push(eq(opps.ownerId, a.user.id));
    else if (qs.owner === "none") conds.push(isNull(opps.ownerId));
    else if (qs.owner) {
      if (!isUuid(qs.owner)) throw new HTTPException(400, { message: "invalid_owner" });
      conds.push(eq(opps.ownerId, qs.owner));
    }
    if (qs.client) {
      if (!isUuid(qs.client)) throw new HTTPException(400, { message: "invalid_client" });
      conds.push(eq(opps.clientId, qs.client));
    }
    if (qs.ticket) conds.push(eq(opps.ticketNumber, qs.ticket.trim()));
    if (qs.source && (OPP_SOURCES as readonly string[]).includes(qs.source)) conds.push(eq(opps.source, qs.source));

    const rows = await joined()
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(opps.createdAt));
    const words = fold(qs.q ?? "").split(" ").filter(Boolean);
    const matched = words.length
      ? rows.filter((r) => {
          const hay = ` ${fold(`${r.opp.number} ${r.clientName} ${r.contactFirst} ${r.contactLast} ${r.opp.description}`)} `;
          return words.every((w) => hay.includes(w));
        })
      : rows;

    // the tiles count the whole backlog, whatever the filter
    const grouped = await db().select({ status: opps.status, n: sql<number>`count(*)::int` }).from(opps).groupBy(opps.status);
    const n = (s: string) => grouped.find((g) => g.status === s)?.n ?? 0;
    const counts = { open: n("new") + n("working"), new: n("new"), working: n("working"), closed: n("won") + n("lost") + n("canceled") };

    const page = Math.max(1, Number(qs.page) || 1);
    const size = Math.min(100, Math.max(1, Number(qs.size) || 50));
    return c.json({ items: matched.slice((page - 1) * size, page * size).map(shape), total: matched.length, page, size, counts });
  })

  /** Flag an opportunity from a client and one of its contacts (opps.create) */
  .post("/", requirePermission("opps.create"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`opps:create:${a.user.id}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, zCreate);
    if (p.ownerId && !a.permissions.includes("opps.manage")) throw new HTTPException(403, { message: "forbidden" });

    // the origin ticket: read through the staff-scoped source (a hidden one is not found)
    let ticket: NTicket | null = null;
    if (p.ticketId) {
      ticket = await (await ticketSource()).get(p.ticketId).catch(() => null);
      if (!ticket) throw new HTTPException(404, { message: "ticket_not_found" });
    }

    // the client: the ticket's company (any client sent must be that one), else the one sent
    let client: typeof schema.clients.$inferSelect;
    if (ticket) {
      const [derived] = ticket.company.id
        ? await db().select().from(schema.clients).where(eq(schema.clients.autotaskId, ticket.company.id))
        : [];
      if (!derived) throw new HTTPException(400, { message: "ticket_no_client" });
      if (p.clientId && p.clientId !== derived.id) throw new HTTPException(400, { message: "ticket_other_client" });
      client = derived;
    } else {
      if (!p.clientId) throw new HTTPException(400, { message: "client_required" });
      const [found] = await db().select().from(schema.clients).where(eq(schema.clients.id, p.clientId));
      if (!found) throw new HTTPException(400, { message: "client_invalid" });
      client = found;
    }
    if (!client.active) throw new HTTPException(400, { message: "client_invalid" });

    // the contact: sent, else (from a ticket) the ticket's contact when it is one of the client's contacts
    const contactId = p.contactId ?? (ticket ? await contactOfTicket(client.id, ticket.contactId) : null);
    if (!contactId) throw new HTTPException(400, { message: "contact_required" });
    const [contact] = await db()
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.clientId, client.id), eq(schema.clientContacts.active, true)));
    if (!contact) throw new HTTPException(400, { message: "contact_invalid" });

    let owner: { id: string; name: string } | null = null;
    if (p.ownerId) {
      owner = await activeStaff(p.ownerId);
      if (!owner) throw new HTTPException(400, { message: "owner_invalid" });
    }
    // the technicians chosen to be told must see opportunities (the creator is left out silently)
    if (p.notifyUserIds) {
      const viewers = new Set(await usersWith("staff", "opps.view"));
      if (p.notifyUserIds.some((id) => !viewers.has(id))) throw new HTTPException(400, { message: "person_invalid" });
    }

    const row = await insertOpp({
      clientId: client.id,
      contactId: contact.id,
      description: p.description,
      source: ticket ? "ticket" : (p.source ?? "other"),
      handling: p.handling ?? "quote_only",
      status: owner ? "working" : "new",
      ownerId: owner?.id ?? null,
      takenAt: owner ? new Date() : null,
      ticketId: ticket?.id ?? null,
      ticketNumber: ticket?.number ?? null,
      ticketTitle: ticket?.title ?? null,
      createdBy: a.user.id,
    });
    await sysNote(row.id, `Signalée par ${a.user.name}${ticket ? ` depuis le billet ${ticket.number}` : ""}`);
    if (owner) await sysNote(row.id, `Prise en charge par ${owner.name}`);
    await audit(a.user.id, "opp.created", row.id, { number: row.number, client: client.name, ticket: ticket?.number ?? null, handling: row.handling, source: row.source });

    const told = await announce(
      { id: row.id, number: row.number, description: row.description, handling: row.handling },
      client.name,
      `${contact.firstName} ${contact.lastName}`.trim(),
      { id: a.user.id, name: a.user.name },
      p.notifyUserIds ?? null,
    );
    if (told.recipients.length) await audit(a.user.id, "opp.notified", row.id, { to: told.recipients });
    return c.json({ ...(await detail(row.id)), notified: told.notified, notifyFailed: told.notifyFailed }, 201);
  })

  /** Clients to pick when flagging: active ones, word by word, 20 at most (display fields only) */
  .get("/clients", requirePermission("opps.create"), async (c) => {
    const words = fold(c.req.query("q") ?? "").split(" ").filter(Boolean);
    const rows = await db()
      .select({ id: schema.clients.id, name: schema.clients.name, autotaskId: schema.clients.autotaskId })
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(asc(schema.clients.name));
    const hits = words.length ? rows.filter((r) => words.every((w) => ` ${fold(r.name)} `.includes(w))) : rows;
    return c.json(hits.slice(0, 20));
  })

  /** The active contacts of an active client, for the picker */
  .get("/clients/:id/contacts", requirePermission("opps.create"), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!isUuid(id)) throw new HTTPException(404, { message: "not_found" });
    const [client] = await db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.id, id), eq(schema.clients.active, true)));
    if (!client) throw new HTTPException(404, { message: "not_found" });
    const rows = await db()
      .select({ id: schema.clientContacts.id, firstName: schema.clientContacts.firstName, lastName: schema.clientContacts.lastName, email: schema.clientContacts.email, phone: schema.clientContacts.phone, title: schema.clientContacts.title })
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, id), eq(schema.clientContacts.active, true)))
      .orderBy(asc(schema.clientContacts.lastName), asc(schema.clientContacts.firstName));
    return c.json(rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email, phone: r.phone, title: r.title })));
  })

  /**
   * What of a client an opportunity can be linked to, with the labels the link route stores:
   * quote (any of the client's), contract (active), project (not done or cancelled). 100 at most.
   */
  .get("/clients/:id/linkables", requirePermission("opps.manage"), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!isUuid(id)) throw new HTTPException(404, { message: "not_found" });
    const kind = c.req.query("kind");
    if (kind !== "quote" && kind !== "contract" && kind !== "project") throw new HTTPException(400, { message: "invalid_kind" });
    const [client] = await db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.id, id), eq(schema.clients.active, true)));
    if (!client) throw new HTTPException(404, { message: "not_found" });
    if (kind === "quote") {
      const rows = await db().select({ id: schema.quotes.id, number: schema.quotes.number, title: schema.quotes.title }).from(schema.quotes).where(eq(schema.quotes.clientId, id)).orderBy(desc(schema.quotes.createdAt)).limit(100);
      return c.json(rows.map((q) => ({ id: q.id, label: quoteLabel(q) })));
    }
    if (kind === "contract") {
      const rows = await db().select({ id: schema.clientContracts.id, name: schema.clientContracts.name }).from(schema.clientContracts).where(and(eq(schema.clientContracts.clientId, id), eq(schema.clientContracts.active, true))).orderBy(asc(schema.clientContracts.name)).limit(100);
      return c.json(rows.map((k) => ({ id: k.id, label: k.name })));
    }
    const rows = await db()
      .select({ id: schema.projProjects.id, number: schema.projProjects.number, name: schema.projProjects.name })
      .from(schema.projProjects)
      .where(and(eq(schema.projProjects.clientId, id), sql`${schema.projProjects.status} not in ('done', 'cancelled')`))
      .orderBy(desc(schema.projProjects.createdAt))
      .limit(100);
    return c.json(rows.map((p) => ({ id: p.id, label: projectLabel(p) })));
  })

  .get("/:id", requirePermission("opps.view"), async (c) => c.json(await detail(oppIdOf(c))))

  /** Change an open opportunity (opps.manage). A new owner is told; an unowned "new" one becomes working. */
  .patch("/:id", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    if (!isOpenOpp(cur.status)) throw new HTTPException(409, { message: "opp_closed" });
    const p = await body(c, zPatch);

    const changes: Partial<typeof opps.$inferInsert> = {};
    const fields: string[] = [];
    if (p.description !== undefined) {
      changes.description = p.description;
      fields.push("description");
    }
    if (p.handling !== undefined) {
      changes.handling = p.handling;
      fields.push("handling");
    }
    if (p.source !== undefined) {
      changes.source = p.source;
      fields.push("source");
    }
    if (p.contactId !== undefined && p.contactId !== cur.contactId) {
      const [ct] = await db()
        .select({ id: schema.clientContacts.id })
        .from(schema.clientContacts)
        .where(and(eq(schema.clientContacts.id, p.contactId), eq(schema.clientContacts.clientId, cur.clientId), eq(schema.clientContacts.active, true)));
      if (!ct) throw new HTTPException(400, { message: "contact_invalid" });
      changes.contactId = ct.id;
      fields.push("contact");
    }
    let newOwner: { id: string; name: string } | null = null;
    if (p.ownerId !== undefined && p.ownerId !== cur.ownerId) {
      if (p.ownerId === null) changes.ownerId = null;
      else {
        newOwner = await activeStaff(p.ownerId);
        if (!newOwner) throw new HTTPException(400, { message: "owner_invalid" });
        changes.ownerId = newOwner.id;
        changes.takenAt = cur.takenAt ?? new Date();
        if (cur.status === "new") changes.status = "working";
      }
      fields.push("owner");
    }
    if (fields.length) await db().update(opps).set({ ...changes, updatedAt: new Date() }).where(eq(opps.id, id));

    if (newOwner) await sysNote(id, `Assignée à ${newOwner.name} par ${a.user.name}`);
    if (p.ownerId === null && cur.ownerId) await sysNote(id, `Plus de responsable (par ${a.user.name})`);
    if (newOwner && newOwner.id !== a.user.id) {
      const [client] = await db().select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, cur.clientId));
      await notify([newOwner.id], { type: "opp.assigned", data: { number: cur.number, client: client?.name ?? "" }, link: `/opps?opp=${id}` });
    }
    await audit(a.user.id, "opp.updated", id, { fields });
    return c.json(await detail(id));
  })

  /** Take an open opportunity: I am its owner, it is being worked on (opps.manage) */
  .post("/:id/take", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    if (!isOpenOpp(cur.status)) throw new HTTPException(409, { message: "opp_closed" });
    const now = new Date();
    await db().update(opps).set({ ownerId: a.user.id, status: "working", takenAt: now, updatedAt: now }).where(eq(opps.id, id));
    await sysNote(id, `Prise en charge par ${a.user.name}`);
    await audit(a.user.id, "opp.taken", id, { previousOwner: cur.ownerId });
    return c.json(await detail(id));
  })

  /** A note (opps.create). Allowed on closed ones too: a note is not an edit. */
  .post("/:id/notes", requirePermission("opps.create"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    await current(id);
    const p = await body(c, zNote);
    await db().insert(schema.oppNotes).values({ oppId: id, authorId: a.user.id, kind: "note", text: p.text });
    await audit(a.user.id, "opp.note_added", id);
    return c.json(await detail(id), 201);
  })

  /** Link what the opportunity became (opps.manage), open or closed. The target and its client are checked here. */
  .post("/:id/links", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    const p = await body(c, zLink);
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, cur.clientId));
    if (!client) throw new HTTPException(404, { message: "not_found" });
    const label = await targetOf(p.kind, p.refId, client);
    try {
      await db().insert(schema.oppLinks).values({ oppId: id, kind: p.kind, refId: p.refId, label, createdBy: a.user.id });
    } catch (e) {
      if (pgCode(e) === "23505") throw new HTTPException(409, { message: "link_exists" });
      throw e;
    }
    await sysNote(id, `Lien ajouté (${KIND_FR[p.kind]}) : ${label}`);
    await audit(a.user.id, "opp.link_added", id, { kind: p.kind, refId: p.refId });
    return c.json(await detail(id), 201);
  })

  /** Take a link off (opps.manage) */
  .delete("/:id/links/:linkId", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    const linkId = c.req.param("linkId") ?? "";
    if (!isUuid(linkId)) throw new HTTPException(404, { message: "not_found" });
    // a won opportunity keeps at least one link: that is what makes it won
    if (cur.status === "won") {
      const [n] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.oppLinks).where(eq(schema.oppLinks.oppId, id));
      if ((n?.n ?? 0) <= 1) throw new HTTPException(409, { message: "link_required" });
    }
    const [l] = await db()
      .delete(schema.oppLinks)
      .where(and(eq(schema.oppLinks.id, linkId), eq(schema.oppLinks.oppId, id)))
      .returning();
    if (!l) throw new HTTPException(404, { message: "not_found" });
    await sysNote(id, `Lien retiré : ${l.label}`);
    await audit(a.user.id, "opp.link_removed", id, { kind: l.kind, refId: l.refId });
    return c.json(await detail(id));
  })

  /** Close: won (needs a link), lost (needs a reason), or canceled (opps.manage). Archived, not deleted. */
  .post("/:id/close", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    if (!isOpenOpp(cur.status)) throw new HTTPException(409, { message: "opp_closed" });
    const p = await body(c, zClose);
    if (p.status === "lost" && !p.lostReason) throw new HTTPException(400, { message: "lost_reason_required" });
    if (p.status === "won") {
      const [n] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.oppLinks).where(eq(schema.oppLinks.oppId, id));
      if (!n || n.n === 0) throw new HTTPException(409, { message: "link_required" });
    }
    const now = new Date();
    const lostReason = p.status === "won" ? null : (p.lostReason ?? null);
    await db()
      .update(opps)
      .set({
        status: p.status,
        closedAt: now,
        lostReason,
        closeNote: p.closeNote ?? null,
        ownerId: cur.ownerId ?? a.user.id,
        updatedAt: now,
      })
      .where(eq(opps.id, id));
    await sysNote(id, `Fermée (${STATUS_FR[p.status]}) par ${a.user.name}${lostReason ? ` : ${lostReason}` : ""}`);
    await audit(a.user.id, "opp.closed", id, { status: p.status, lostReason });
    return c.json(await detail(id));
  })

  /** Reopen a closed opportunity: back to working, closing cleared (opps.manage) */
  .post("/:id/reopen", requirePermission("opps.manage"), async (c) => {
    const a = auth(c);
    const id = oppIdOf(c);
    const cur = await current(id);
    if (isOpenOpp(cur.status)) throw new HTTPException(409, { message: "opp_open" });
    await db().update(opps).set({ status: "working", closedAt: null, lostReason: null, updatedAt: new Date() }).where(eq(opps.id, id));
    await sysNote(id, `Réouverte par ${a.user.name}`);
    await audit(a.user.id, "opp.reopened", id, { from: cur.status });
    return c.json(await detail(id));
  });
