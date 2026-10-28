import { config } from "../config.ts";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { audit } from "./audit.ts";
import { unsyncBlock, unsyncPin } from "./planning.ts";
import { NATIVE_ID_START } from "./ids.ts";
import {
  approvedStatus,
  dueIso,
  isSmsNote,
  SMS_NOTE_TAG,
  SourceError,
  type ChargeOptions,
  type Billable,
  type Charge,
  type HistoryTicket,
  type Note,
  type NTicket,
  type Options,
  type Person,
  type TicketSource,
} from "./ticketSource.ts";
export { NATIVE_ID_START };

/**
 * The portal's own tickets: tickets, their notes, time, charges and files live in the portal database. In
 * production this is always the case; in development it is chosen in the `tickets` integration row (mode local),
 * otherwise sample data is shown. Clients, contacts, contracts, products and lists come from `base`
 * (`localBase`, the database too). New tickets get ids from `NATIVE_ID_START` up.
 */
const PROVIDER = "tickets";

export type TicketModeConfig = { mode: "sample" | "local"; options?: Options; chargeOptions?: ChargeOptions; workTypes?: { value: string; label: string }[] };

let cache: { at: number; value: TicketModeConfig } | null = null;
export async function ticketMode(): Promise<TicketModeConfig> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  const value = { mode: "sample", ...((row?.config ?? {}) as Partial<TicketModeConfig>) } as TicketModeConfig;
  cache = { at: Date.now(), value };
  return value;
}
/** The portal's own tickets: always in production, in development when chosen (never sample data in production) */
export const ticketsLocal = async () => config.production || (await ticketMode()).mode === "local";
/** For the tests: forget the mode kept in memory */
export const resetTicketMode = () => {
  cache = null;
};


const minutesOf = (h: number) => Math.round(h * 60);
const cents = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));


// ── The portal's tickets as a ticket source ──
type Row = typeof schema.tickets.$inferSelect;
async function staff(): Promise<Person[]> {
  return db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name));
}

async function hoursOf(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await db()
    .select({ id: schema.ticketTimeEntries.ticketId, minutes: sql<number>`sum(${schema.ticketTimeEntries.minutes})`.mapWith(Number) })
    .from(schema.ticketTimeEntries)
    .where(inArray(schema.ticketTimeEntries.ticketId, ids))
    .groupBy(schema.ticketTimeEntries.ticketId);
  return new Map(rows.map((r) => [r.id, Math.round((r.minutes / 60) * 100) / 100]));
}

function toTicket(r: Row, hours = 0): NTicket {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    company: { id: r.companyId, name: r.companyName },
    contact: r.contactName,
    contactId: r.contactId,
    status: r.status,
    priority: r.priority,
    queue: r.queue,
    source: r.source,
    assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? "" } : null,
    secondary: r.secondary ?? [],
    createdAt: r.createdAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    hours,
    notes: [],
    assetId: r.assetId,
    contractId: r.contractId,
  };
}

async function rows(where: SQL | undefined, limit?: number): Promise<NTicket[]> {
  const q = db().select().from(schema.tickets).where(where).orderBy(desc(schema.tickets.updatedAt));
  const list = limit ? await q.limit(limit) : await q;
  const hours = await hoursOf(list.map((r) => r.id));
  return list.map((r) => toTicket(r, hours.get(r.id) ?? 0));
}

async function one(id: number): Promise<Row> {
  const [r] = await db().select().from(schema.tickets).where(eq(schema.tickets.id, id));
  if (!r) throw new SourceError("not_found");
  return r;
}
const touch = (id: number) => db().update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.id, id));

/** The next ticket: id after the highest, number T<day>.<n> (Québec day) */
let numbering: Promise<unknown> = Promise.resolve();
async function nextIdentity(): Promise<{ id: number; number: string }> {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.tickets.id}), 0)`.mapWith(Number) }).from(schema.tickets);
  const same = await db()
    .select({ number: schema.tickets.number })
    .from(schema.tickets)
    .where(ilike(schema.tickets.number, `T${day}.%`));
  const n = Math.max(0, ...same.map((x) => Number(x.number.split(".")[1]) || 0)) + 1;
  return { id: Math.max(max + 1, NATIVE_ID_START), number: `T${day}.${String(n).padStart(4, "0")}` };
}

const cachedSources = new WeakMap<TicketSource, TicketSource>();
export function localTicketSource(base: TicketSource): TicketSource {
  const hit = cachedSources.get(base);
  if (hit) return hit;
  // the status "merged" (a closed one) is always there, also when the list was saved before merging existed
  const options = async (): Promise<Options> => {
    const o = (await ticketMode()).options ?? (await base.options());
    return o.statuses.some((x) => x.value === "merged") ? o : { ...o, statuses: [...o.statuses, { value: "merged", label: "Fusionné", kind: "complete", hidden: true }] };
  };
  const isComplete = async (status: string) => (await options()).statuses.find((s) => s.value === status)?.kind === "complete";

  const src: TicketSource = {
    demo: base.demo,
    options,
    technicians: staff,
    async meId(a) {
      return a.user.id;
    },
    async list() {
      return rows(undefined);
    },
    async get(id) {
      const [r] = await db().select().from(schema.tickets).where(eq(schema.tickets.id, id));
      if (!r) return null;
      const [notes, times, files] = await Promise.all([
        db().select().from(schema.ticketNotes).where(eq(schema.ticketNotes.ticketId, id)).orderBy(asc(schema.ticketNotes.createdAt)),
        db().select().from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.ticketId, id)).orderBy(asc(schema.ticketTimeEntries.startedAt)),
        db()
          .select({ id: schema.ticketAttachments.id, name: schema.ticketAttachments.name, size: schema.ticketAttachments.size, at: schema.ticketAttachments.createdAt, author: schema.ticketAttachments.author, internal: schema.ticketAttachments.internal, contentType: schema.ticketAttachments.contentType, source: schema.ticketAttachments.source })
          .from(schema.ticketAttachments)
          .where(eq(schema.ticketAttachments.ticketId, id))
          .orderBy(asc(schema.ticketAttachments.createdAt)),
      ]);
      const minutes = times.reduce((s, x) => s + x.minutes, 0);
      const t = toTicket(r, Math.round((minutes / 60) * 100) / 100);
      if (r.mergedIntoId) {
        const [m] = await db().select({ id: schema.tickets.id, number: schema.tickets.number }).from(schema.tickets).where(eq(schema.tickets.id, r.mergedIntoId));
        t.mergedInto = m ?? null;
      }
      const merged = await db().select().from(schema.tickets).where(eq(schema.tickets.mergedIntoId, id)).orderBy(asc(schema.tickets.createdAt));
      t.mergedTickets = merged.map((m) => ({ id: m.id, number: m.number, title: m.title, description: m.description, createdAt: m.createdAt.toISOString(), mergedAt: (m.completedAt ?? m.updatedAt).toISOString(), contact: m.contactName }));
      const items: Note[] = [
        ...notes
          .filter((n) => !isSmsNote(n.text))
          .map((n) => ({ id: `n-${n.id}`, author: n.author, at: n.createdAt.toISOString(), text: n.text, internal: n.internal, kind: "note" as const, ...(n.system ? { system: true } : {}), ...(n.mergedFrom ? { mergedFrom: n.mergedFrom } : {}) })),
        ...times.map((x) => ({
          id: `t-${x.id}`,
          author: x.author,
          at: x.startedAt.toISOString(),
          text: x.summary,
          internal: false,
          kind: "time" as const,
          hours: Math.round((x.minutes / 60) * 10_000) / 10_000,
          internalText: x.internalText || undefined,
          billable: x.billable,
          offsetHours: x.offsetMinutes ? Math.round((x.offsetMinutes / 60) * 10_000) / 10_000 : undefined,
          ...(x.mergedFrom ? { mergedFrom: x.mergedFrom } : {}),
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      t.notes = items;
      t.attachments = files.map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.at.toISOString(), author: f.author, internal: f.internal, contentType: f.contentType, source: f.source }));
      return t;
    },
    async update(id, p) {
      const cur = await one(id);
      const o = await options();
      const set: Partial<Row> = { updatedAt: new Date() };
      if (p.status !== undefined) {
        if (!o.statuses.some((s) => s.value === p.status)) throw new SourceError("invalid_value");
        set.status = p.status;
        const done = await isComplete(p.status);
        set.completedAt = done ? (cur.completedAt ?? new Date()) : null;
      }
      if (p.priority !== undefined) {
        if (!o.priorities.some((s) => s.value === p.priority)) throw new SourceError("invalid_value");
        set.priority = p.priority;
      }
      if (p.queue !== undefined) {
        if (p.queue && !o.queues.some((s) => s.value === p.queue)) throw new SourceError("invalid_value");
        set.queue = p.queue;
      }
      if (p.dueAt) set.dueAt = new Date(p.dueAt);
      else if (p.dueDate) set.dueAt = new Date(dueIso(p.dueDate));
      const companyId = p.companyId ?? cur.companyId;
      if (p.companyId !== undefined && p.companyId !== cur.companyId) {
        const company = (await base.companies()).find((c) => c.id === p.companyId);
        if (!company) throw new SourceError("invalid_company");
        set.companyId = company.id;
        set.companyName = company.name;
        if (p.contactId === undefined) {
          set.contactId = null;
          set.contactName = "";
        }
        if (p.assetId === undefined) set.assetId = null;
      }
      if (p.contactId !== undefined) {
        const contact = p.contactId ? (await base.contacts(companyId)).find((c) => c.id === p.contactId) : null;
        if (p.contactId && !contact) throw new SourceError("invalid_contact");
        set.contactId = contact?.id ?? null;
        set.contactName = contact?.name ?? "";
      }
      if (p.assigneeId !== undefined) {
        const person = p.assigneeId ? (await staff()).find((s) => s.id === p.assigneeId) : null;
        if (p.assigneeId && !person) throw new SourceError("invalid_assignee");
        set.assigneeId = person?.id ?? null;
        set.assigneeName = person?.name ?? null;
      }
      if (p.title !== undefined) set.title = p.title;
      if (p.description !== undefined) set.description = p.description;
      if (p.assetId !== undefined) {
        if (p.assetId && !(await base.assets(companyId)).some((x) => x.id === p.assetId)) throw new SourceError("invalid_value");
        set.assetId = p.assetId;
      }
      if (p.secondaryIds) {
        const people = await staff();
        const list = p.secondaryIds.map((sid) => people.find((s) => s.id === sid) ?? cur.secondary.find((s) => s.id === sid));
        if (list.some((x) => !x)) throw new SourceError("invalid_assignee");
        set.secondary = list as Person[];
      }
      await db().update(schema.tickets).set(set).where(eq(schema.tickets.id, id));
    },
    async addNote(id, p, a) {
      await one(id);
      await db()
        .insert(schema.ticketNotes)
        .values({ ticketId: id, author: a.realUser.name, userId: a.realUser.kind === "staff" ? a.realUser.id : null, text: p.text, internal: p.internal });
      await touch(id);
    },
    async create(p, a) {
      return (await createTicket(p, a)).id;
    },
    async createSystem(p) {
      return createTicket(p, null);
    },
    async addSmsNote(ticketId, title, text) {
      await db().insert(schema.ticketNotes).values({ ticketId, author: "Texto", text: `${SMS_NOTE_TAG} ${title}\n${text}`, internal: true });
      await touch(ticketId);
    },
    async addAttachment(ticketId, p, a) {
      await one(ticketId);
      const size = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
      const source = p.source === "email_out" ? "email_out" : a.user.kind === "client" ? "portal" : "upload";
      const [row] = await db()
        .insert(schema.ticketAttachments)
        .values({ ticketId, name: p.name.slice(0, 255), contentType: p.contentType || "application/octet-stream", size, data: p.data, author: a.realUser.name, source })
        .returning({ id: schema.ticketAttachments.id });
      await touch(ticketId);
      return { id: row!.id };
    },
    async charges(ticketId) {
      const list = await db().select().from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, ticketId)).orderBy(asc(schema.ticketCharges.createdAt));
      return list.map(
        (c): Charge => ({
          id: c.id,
          name: c.name,
          description: c.description,
          quantity: c.quantityX100 / 100,
          unitPrice: c.unitPriceCents == null ? null : c.unitPriceCents / 100,
          unitCost: c.unitCostCents == null ? null : c.unitCostCents / 100,
          billable: c.billable,
          type: c.type,
          status: c.status,
          materialCode: c.materialCode,
          date: c.date,
          author: c.author,
        }),
      );
    },
    chargeOptions: () => base.chargeOptions(),
    products: (q) => base.products(q),
    async addCharge(ticketId, p, a) {
      await one(ticketId);
      const o = await base.chargeOptions();
      const label = (list: { value: string; label: string }[], v: string | null) => (v ? (list.find((x) => x.value === v)?.label ?? null) : null);
      if (p.materialCodeId && !label(o.materialCodes, p.materialCodeId)) throw new SourceError("invalid_value");
      await db()
        .insert(schema.ticketCharges)
        .values({
          ticketId,
          name: p.name,
          description: p.description,
          quantityX100: Math.round(p.quantity * 100),
          unitPriceCents: cents(p.unitPrice),
          unitCostCents: cents(p.unitCost),
          billable: p.billable,
          type: label(o.types, p.typeId) ?? o.types[0]?.label ?? null,
          status: label(o.statuses, p.statusId) ?? (o.statuses.length ? approvedStatus(o.statuses).label : null),
          materialCode: label(o.materialCodes, p.materialCodeId),
          productId: p.productId,
          date: p.date ?? new Date().toISOString().slice(0, 10),
          author: a.realUser.name,
        });
      await touch(ticketId);
    },
    workTypes: () => base.workTypes(),
    async addTimeEntry(ticketId, p, a) {
      await one(ticketId);
      await db()
        .insert(schema.ticketTimeEntries)
        .values({
          ticketId,
          userId: a.realUser.id,
          author: a.realUser.name,
          startedAt: p.startedAt,
          minutes: minutesOf(p.hours),
          offsetMinutes: minutesOf(p.offsetHours),
          summary: p.summary,
          internalText: p.internal,
          billable: p.billable,
          workType: p.workTypeId,
          contractId: p.contractSourceId ?? null,
        });
      await touch(ticketId);
    },
    async addMailReply(ticketId, from, text) {
      await one(ticketId);
      await db()
        .insert(schema.ticketNotes)
        .values({ ticketId, author: from.name || from.address, text: `${text}\n\n— ${from.name || from.address} (client, par courriel)`.slice(0, 8000), internal: false });
      await touch(ticketId);
    },
    async markNeedsAttention(ticketId) {
      const cur = await one(ticketId);
      const o = await options();
      const attention = o.statuses.find((s) => s.kind === "needsAttention");
      if (!attention || cur.status === attention.value || (await isComplete(cur.status))) return false;
      await db().update(schema.tickets).set({ status: attention.value, updatedAt: new Date() }).where(eq(schema.tickets.id, ticketId));
      return true;
    },
    async history(since): Promise<HistoryTicket[]> {
      const d = new Date(since);
      const list = await db()
        .select({ id: schema.tickets.id, createdAt: schema.tickets.createdAt, completedAt: schema.tickets.completedAt, queue: schema.tickets.queue, source: schema.tickets.source, priority: schema.tickets.priority })
        .from(schema.tickets)
        .where(or(gte(schema.tickets.createdAt, d), gte(schema.tickets.completedAt, d)));
      return list.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null, queue: r.queue, source: r.source, priority: r.priority }));
    },
    async companyHistory() {
      // the list already holds every ticket
      return [];
    },
    async searchArchive() {
      return [];
    },
    async ticketsWithOtherContact() {
      return [];
    },
    // Billing: the work to bill on tickets is the portal's; the rest still comes from the source
    async billables(since) {
      const from = await base.billables(since);
      const items: Billable[] = from.items.filter((x) => x.kind !== "labour" && x.kind !== "charge");
      const d = new Date(`${since}T00:00:00`);
      const times = await db()
        .select({ e: schema.ticketTimeEntries, number: schema.tickets.number, companyId: schema.tickets.companyId, ticketContract: schema.tickets.contractId })
        .from(schema.ticketTimeEntries)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketTimeEntries.ticketId))
        .where(and(eq(schema.ticketTimeEntries.billable, true), eq(schema.ticketTimeEntries.billed, false), gte(schema.ticketTimeEntries.startedAt, d)));
      for (const { e, number, companyId, ticketContract } of times) {
        const billed = Math.max(0, e.minutes - e.offsetMinutes);
        if (!billed) continue;
        const contract = e.contractId ?? ticketContract;
        items.push({
          id: e.externalId ?? `ptime:${e.id}`,
          kind: "labour",
          companyId,
          date: e.startedAt.toISOString().slice(0, 10),
          description: e.summary.slice(0, 2000) || `Billet ${number}`,
          ticketNumber: number,
          contractSourceId: contract,
          resourceName: e.author || null,
          quantity: Math.round((billed / 60) * 100) / 100,
          unitPriceCents: null,
          taxable: true,
        });
      }
      const charges = await db()
        .select({ c: schema.ticketCharges, number: schema.tickets.number, companyId: schema.tickets.companyId })
        .from(schema.ticketCharges)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketCharges.ticketId))
        .where(and(eq(schema.ticketCharges.billable, true), eq(schema.ticketCharges.billed, false)));
      for (const { c, number, companyId } of charges) {
        const date = c.date ?? c.createdAt.toISOString().slice(0, 10);
        if (date < since) continue;
        items.push({
          id: c.externalId ?? `pcharge:${c.id}`,
          kind: "charge",
          companyId,
          date,
          description: [c.name, c.description].filter(Boolean).join(" — ").slice(0, 2000),
          ticketNumber: number,
          contractSourceId: c.contractId,
          quantity: c.quantityX100 / 100,
          unitPriceCents: c.unitPriceCents,
          taxable: true,
        });
      }
      // the billable time logged on projects (Projets › Temps): billed at the project's hourly rate; the entries left included are not work to bill
      const onProjects = await db()
        .select({ e: schema.timesheetEntries, number: schema.projects.number, rate: schema.projects.hourlyRateCents, companyId: schema.clients.autotaskId, who: schema.users.name })
        .from(schema.timesheetEntries)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.timesheetEntries.projectId))
        .innerJoin(schema.clients, eq(schema.clients.id, schema.projects.clientId))
        .innerJoin(schema.users, eq(schema.users.id, schema.timesheetEntries.userId))
        .where(and(sql`${schema.timesheetEntries.billableX100} > 0`, gte(schema.timesheetEntries.date, since)));
      for (const { e, number, rate, companyId, who } of onProjects) {
        if (companyId == null) continue;
        items.push({
          id: `prtime:${e.id}`,
          kind: "labour",
          companyId,
          date: e.date,
          description: [e.ticketTitle, e.note].filter(Boolean).join(" — ").slice(0, 2000),
          ticketNumber: number,
          resourceName: who,
          quantity: (e.billableX100 ?? e.hoursX100) / 100,
          unitPriceCents: rate,
          taxable: true,
        });
      }
      return { items, errors: Object.fromEntries(Object.entries(from.errors).filter(([k]) => k !== "labour" && k !== "charge")) };
    },
    // Everything else still comes from the source
    companies: () => base.companies(),
    contacts: (companyId) => base.contacts(companyId),
    addContact: (companyId, p, a) => base.addContact(companyId, p, a),
    crmExport: () => base.crmExport(),
    updateCompany: (id, p, a) => base.updateCompany(id, p, a),
    updateContact: (id, p, a) => base.updateContact(id, p, a),
    addCompany: (p, a) => base.addCompany(p, a),
    contracts: (companyId) => base.contracts(companyId),
    assets: (companyId) => base.assets(companyId),
    contactByPhone: (phone) => base.contactByPhone(phone),
    contactByEmail: (email) => base.contactByEmail(email),
  };

  async function createTicket(p: Parameters<TicketSource["create"]>[0], a: AuthContext | null): Promise<{ id: number; number: string }> {
    const company = (await base.companies()).find((c) => c.id === p.companyId);
    if (!company) throw new SourceError("invalid_company");
    const contact = p.contactId ? (await base.contacts(company.id)).find((c) => c.id === p.contactId) : null;
    if (p.contactId && !contact) throw new SourceError("invalid_contact");
    const o = await options();
    if (!o.priorities.some((x) => x.value === p.priority)) throw new SourceError("invalid_value");
    if (p.queue && !o.queues.some((x) => x.value === p.queue)) throw new SourceError("invalid_value");
    const assignee = p.assigneeId ? (await staff()).find((s) => s.id === p.assigneeId) : null;
    if (p.assigneeId && !assignee) throw new SourceError("invalid_assignee");
    const status = (o.statuses.find((s) => s.kind === (assignee ? "inProgress" : "new")) ?? o.statuses.find((s) => s.kind === "new") ?? o.statuses[0]).value;
    // one number at a time (one app instance)
    const run = numbering.catch(() => undefined).then(async () => {
      const { id, number } = await nextIdentity();
      await db()
        .insert(schema.tickets)
        .values({
          id,
          number,
          title: p.title,
          description: p.description,
          companyId: company.id,
          companyName: company.name,
          contactId: contact?.id ?? null,
          contactName: contact?.name ?? "",
          status,
          priority: p.priority,
          queue: p.queue,
          source: a ? "portal" : "sms",
          assigneeId: assignee?.id ?? null,
          assigneeName: assignee?.name ?? null,
          dueAt: new Date(p.dueAt ?? dueIso(p.dueDate)),
          contractId: p.contractId ?? null,
        });
      return { id, number };
    });
    numbering = run;
    return run;
  }

  cachedSources.set(base, src);
  return src;
}

/**
 * Delete a portal ticket for good: it leaves every list, count and statistic
 * (the weekly meeting, the trends, the gauges). Its notes, time, charges and
 * files go with it; work not billed yet is dropped from Accounting (what is on
 * an invoice stays there); its timers, priorities and planned time are removed;
 * the hours on a timesheet stay (time worked is time worked).
 */
export async function deleteTicket(id: number, a: AuthContext): Promise<{ number: string; title: string }> {
  const r = await one(id);
  const [times, charges, pins, blocks] = await Promise.all([
    db().select({ id: schema.ticketTimeEntries.id, externalId: schema.ticketTimeEntries.externalId }).from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.ticketId, id)),
    db().select({ id: schema.ticketCharges.id, externalId: schema.ticketCharges.externalId }).from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, id)),
    db().select().from(schema.ticketPins).where(eq(schema.ticketPins.ticketId, id)),
    db().select().from(schema.calendarBlocks).where(eq(schema.calendarBlocks.ticketId, id)),
  ]);
  // the Outlook events of its priorities and planned time (a failure there does not stop the deletion)
  for (const p of pins) await unsyncPin(p).catch(() => undefined);
  for (const b of blocks) await unsyncBlock(b).catch(() => undefined);
  const workIds = [...times.map((x) => x.externalId ?? `ptime:${x.id}`), ...charges.map((x) => x.externalId ?? `pcharge:${x.id}`)];
  await db().transaction(async (tx) => {
    // remembered
    await tx.insert(schema.deletedTickets).values({ ticketId: id, number: r.number, title: r.title, deletedBy: a.realUser.id }).onConflictDoNothing();
    if (workIds.length) await tx.delete(schema.billingItems).where(and(inArray(schema.billingItems.sourceId, workIds), inArray(schema.billingItems.status, ["pending", "approved", "excluded"])));
    await tx.delete(schema.ticketTimers).where(eq(schema.ticketTimers.ticketId, id));
    await tx.delete(schema.ticketPins).where(eq(schema.ticketPins.ticketId, id));
    await tx.delete(schema.calendarBlocks).where(eq(schema.calendarBlocks.ticketId, id));
    await tx.delete(schema.ticketAiNotes).where(eq(schema.ticketAiNotes.ticketId, id));
    await tx.delete(schema.autotaskAuthors).where(eq(schema.autotaskAuthors.ticketId, id));
    await tx.delete(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, id));
    await tx.delete(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, id));
    // the email that made it stays (so it is not read again and made a new ticket), without the link
    await tx.update(schema.mailIntake).set({ ticketId: null, ticketNumber: null, note: "Billet supprimé", updatedAt: new Date() }).where(eq(schema.mailIntake.ticketId, id));
    await tx.update(schema.meetingEvents).set({ ticketId: null, ticketNumber: null }).where(eq(schema.meetingEvents.ticketId, id));
    // the text conversation ends (the next text from the number starts a new one)
    await tx
      .update(schema.smsConversations)
      .set({ ticketId: null, ticketNumber: null, status: "closed", autoTicketAt: null, updatedAt: new Date() })
      .where(eq(schema.smsConversations.ticketId, id));
    await tx.delete(schema.tickets).where(eq(schema.tickets.id, id));
  });
  await audit(a.realUser.id, "ticket.deleted", String(id), { number: r.number, title: r.title, company: r.companyName, timeEntries: times.length, charges: charges.length });
  return { number: r.number, title: r.title };
}

/**
 * Merge a ticket into another of the same client: its notes, time, charges, files, timers and text / email
 * links move to the other ticket, which gets its description as an internal note. The merged ticket stays,
 * closed with the status "merged" (it leaves the open lists and counts like any closed ticket) and points at the other.
 */
export async function mergeTickets(id: number, intoId: number, a: AuthContext): Promise<{ number: string; into: { id: number; number: string } }> {
  if (id === intoId) throw new SourceError("merge_same");
  const [from, into] = await Promise.all([one(id), one(intoId)]);
  if (from.status === "merged" || from.mergedIntoId) throw new SourceError("merge_already");
  if (into.status === "merged" || into.mergedIntoId) throw new SourceError("merge_target_merged");
  if (from.companyId !== into.companyId) throw new SourceError("merge_other_client");
  const who = a.realUser.name;
  const [pins, blocks] = await Promise.all([db().select().from(schema.ticketPins).where(eq(schema.ticketPins.ticketId, id)), db().select().from(schema.calendarBlocks).where(eq(schema.calendarBlocks.ticketId, id))]);
  for (const p of pins) await unsyncPin(p).catch(() => undefined);
  for (const b of blocks) await unsyncBlock(b).catch(() => undefined);
  await db().transaction(async (tx) => {
    // what moves keeps the number of the ticket it was written on (what came from an earlier merge keeps its own)
    await tx.update(schema.ticketNotes).set({ ticketId: intoId, mergedFrom: sql`coalesce(${schema.ticketNotes.mergedFrom}, ${from.number})` }).where(eq(schema.ticketNotes.ticketId, id));
    await tx.update(schema.ticketTimeEntries).set({ ticketId: intoId, mergedFrom: sql`coalesce(${schema.ticketTimeEntries.mergedFrom}, ${from.number})` }).where(eq(schema.ticketTimeEntries.ticketId, id));
    for (const t of [schema.ticketCharges, schema.ticketAttachments]) await tx.update(t).set({ ticketId: intoId }).where(eq(t.ticketId, id));
    await tx.update(schema.ticketTimers).set({ ticketId: intoId, ticketNumber: into.number, ticketTitle: into.title }).where(eq(schema.ticketTimers.ticketId, id));
    // its priorities and planned time end with it (the other ticket keeps its own)
    await tx.delete(schema.ticketPins).where(eq(schema.ticketPins.ticketId, id));
    await tx.delete(schema.calendarBlocks).where(eq(schema.calendarBlocks.ticketId, id));
    await tx.update(schema.smsConversations).set({ ticketId: intoId, ticketNumber: into.number }).where(eq(schema.smsConversations.ticketId, id));
    await tx.update(schema.mailIntake).set({ ticketId: intoId, ticketNumber: into.number }).where(eq(schema.mailIntake.ticketId, id));
    await tx.insert(schema.ticketNotes).values({
      ticketId: intoId,
      author: who,
      userId: a.realUser.kind === "staff" ? a.realUser.id : null,
      internal: true,
      mergedFrom: from.number,
      text: `Billet ${from.number} fusionné ici — ${from.title}${from.description.trim() ? `

${from.description.trim()}` : ""}`,
    });
    await tx.insert(schema.ticketNotes).values({ ticketId: id, author: who, userId: a.realUser.kind === "staff" ? a.realUser.id : null, internal: true, system: true, text: `Fusionné dans ${into.number}` });
    await tx.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.id, intoId));
    await tx.update(schema.tickets).set({ status: "merged", mergedIntoId: intoId, completedAt: from.completedAt ?? new Date(), updatedAt: new Date() }).where(eq(schema.tickets.id, id));
  });
  await audit(a.realUser.id, "ticket.merged", String(id), { number: from.number, into: into.number });
  return { number: from.number, into: { id: into.id, number: into.number } };
}

/**
 * A file that came with an email from the client (the support mailbox): kept on the ticket, once (the same name and size is
 * not added again). Returns whether it was added.
 */
export async function addEmailAttachment(ticketId: number, f: { name: string; contentType: string; data: string; size: number; from: string }): Promise<boolean> {
  const [same] = await db()
    .select({ id: schema.ticketAttachments.id })
    .from(schema.ticketAttachments)
    .where(and(eq(schema.ticketAttachments.ticketId, ticketId), eq(schema.ticketAttachments.name, f.name.slice(0, 255)), eq(schema.ticketAttachments.size, f.size), eq(schema.ticketAttachments.source, "email_in")))
    .limit(1);
  if (same) return false;
  await db().insert(schema.ticketAttachments).values({ ticketId, name: f.name.slice(0, 255), contentType: f.contentType || "application/octet-stream", size: f.size, data: f.data, author: f.from.slice(0, 200), source: "email_in" });
  return true;
}

/** A portal ticket's file */
export async function ticketFile(ticketId: number, fileId: string) {
  const [f] = await db()
    .select()
    .from(schema.ticketAttachments)
    .where(and(eq(schema.ticketAttachments.ticketId, ticketId), eq(schema.ticketAttachments.id, fileId)));
  return f ?? null;
}
