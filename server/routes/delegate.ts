import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zUuid } from "../lib/validate.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { ticketCompanyOf } from "../lib/clientTickets.ts";
import { isSelfManagedClient } from "../lib/selfManaged.ts";
import { delegatesOfCompany } from "../lib/delegates.ts";
import { addItem, ChecklistError, checklistOf, deleteItem, updateItem } from "../lib/checklist.ts";
import { defaultQueueKey } from "../lib/queues.ts";
import { mergeTickets, ticketFile } from "../lib/localTickets.ts";
import { isSmsNote, MAX_TICKET_ATTACHMENT_BYTES, SourceError, ticketSource, type NTicket, type Note, type Options, type TicketPatch } from "../lib/ticketSource.ts";
import { isAlert, lookup } from "./tickets.ts";

/**
 * The delegated technicians of a self-managed company (clientTickets.delegate): they work the company's
 * tickets themselves. Never our staff's view: no assignee, no time, no charges, no internal note of ours,
 * no system note, no staff name or id. AKAB may take a ticket too (`akabWorking`); the delegate keeps writing.
 * Tickets hidden from delegates (`hidden_from_delegates`, set by staff) answer as missing. Alerts and other
 * companies' tickets are never reachable (404).
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Statuses the portal never offers (a merged or transformed ticket is closed and hidden) */
const HIDDEN_STATUS = new Set(["merged", "transformed"]);
const SHOWN_LIMIT = 100;
const PICTURE = /^image\/(png|jpe?g|gif|webp)$/i;

/** Only a client user working their own company as the delegate: not staff, not a technician viewing the portal, not an API key */
const delegateOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = auth(c);
  if (a.user.kind !== "client" || !a.user.clientId || a.viewAs || a.apiKey) throw new HTTPException(403, { message: "forbidden" });
  if (!a.permissions.includes("clientTickets.delegate")) throw new HTTPException(403, { message: "forbidden" });
  if (!(await isSelfManagedClient(a.user.clientId))) throw new HTTPException(403, { message: "not_self_managed" });
  await next();
};

/** The company in effect (a grant switches it), its ticket source and what its statuses and priorities say */
async function companyCtx(a: AuthContext) {
  const src = await ticketSource({ all: true });
  const company = await ticketCompanyOf(a.user.clientId!, src);
  if (!company) throw new HTTPException(409, { message: "not_linked" });
  const o = await src.options();
  return { src, company, o, L: lookup(o) };
}
type Ctx = Awaited<ReturnType<typeof companyCtx>>;

/** The statuses the portal offers (not the closed hidden ones) */
function offeredStatuses(o: Options) {
  return o.statuses.filter((s) => !s.hidden && !HIDDEN_STATUS.has(s.value));
}

const statusOf = (ctx: Ctx, value: string) => ({ key: value, label: ctx.L.statusLabel(value) ?? value, kind: ctx.L.statusKind(value) });
const priorityOf = (ctx: Ctx, value: string) => {
  const p = ctx.o.priorities.find((x) => x.value === value);
  return { key: value, label: p?.label ?? value, kind: p?.kind ?? "medium" };
};

/** What the database says of a ticket for the delegate: AKAB has it, hidden from delegates, the delegate */
type Flags = { akabTakenAt: Date | null; hidden: boolean; delegateUserId: string | null };
const NO_FLAGS: Flags = { akabTakenAt: null, hidden: false, delegateUserId: null };

async function flagsOf(ids: number[]): Promise<Map<number, Flags>> {
  if (!ids.length) return new Map();
  const rows = await db()
    .select({ id: schema.tickets.id, akabTakenAt: schema.tickets.akabTakenAt, hidden: schema.tickets.hiddenFromDelegates, delegateUserId: schema.tickets.delegateUserId })
    .from(schema.tickets)
    .where(inArray(schema.tickets.id, ids));
  return new Map(rows.map((r) => [r.id, { akabTakenAt: r.akabTakenAt, hidden: r.hidden, delegateUserId: r.delegateUserId }]));
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The company's delegates (the people who may be the ticket's delegate), with a picker for a delegate id */
async function peopleOf(ctx: Ctx) {
  const ids = await delegatesOfCompany(ctx.company.id);
  const names = await namesOf(ids);
  const delegates = ids.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
  const byId = new Map(delegates.map((d) => [d.id, d]));
  return { delegates, pick: (id: string | null) => (id ? (byId.get(id) ?? null) : null) };
}

async function tagsOf(ticketId: number): Promise<string[]> {
  const [m] = await db().select({ tags: schema.ticketMeta.tags }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, ticketId));
  return m?.tags ?? [];
}

/**
 * The company's tickets the delegate may see: not alerts, not merged or transformed, not hidden from delegates.
 */
async function visibleTickets(ctx: Ctx) {
  const [recent, history] = await Promise.all([ctx.src.list(), ctx.src.companyHistory(ctx.company.id)]);
  const seen = new Set<number>();
  const candidates = [...recent, ...history].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return t.company.id === ctx.company.id && !isAlert(ctx.L)(t) && !HIDDEN_STATUS.has(t.status);
  });
  const flags = await flagsOf(candidates.map((t) => t.id));
  return { tickets: candidates.filter((t) => !flags.get(t.id)?.hidden), flags };
}

/** One ticket of the delegate's company, not an alert, not merged, not hidden from delegates. 404 otherwise. */
async function delegateTicket(a: AuthContext, rawId: string) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || !/^\d+$/.test(rawId)) throw new HTTPException(404, { message: "not_found" });
  const ctx = await companyCtx(a);
  const t = await ctx.src.get(id);
  if (!t || t.company.id !== ctx.company.id || isAlert(ctx.L)(t) || HIDDEN_STATUS.has(t.status)) throw new HTTPException(404, { message: "not_found" });
  const flags = (await flagsOf([id])).get(id) ?? NO_FLAGS;
  if (flags.hidden) throw new HTTPException(404, { message: "not_found" });
  return { ctx, t, flags };
}

/** A checklist item id from the address; anything else is missing */
function itemIdOf(raw: string): string {
  const r = z.uuid().safeParse(raw);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  return r.data;
}

function limit(a: AuthContext, what: string, perHour: number) {
  if (!rateLimit(`delegate-${what}:${a.user.id}`, perHour, 3600_000).ok) throw new HTTPException(429, { message: "rate_limited" });
}

/** The source's refusals as answers (a checklist still open is 409, as the staff routes answer) */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SourceError) {
      const status = e.code === "checklist_open" ? 409 : e.code === "not_found" ? 404 : 400;
      throw new HTTPException(status, { message: e.code });
    }
    throw e;
  }
}

/** The checklist's refusals as answers (the same as the staff routes) */
async function checklistRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChecklistError) throw new HTTPException(e.code === "item_not_found" ? 404 : e.code === "item_blocked" || e.code === "item_has_done_dependents" ? 409 : 400, { message: e.code });
    throw e;
  }
}

const checklistView = async (ticketId: number) => (await checklistOf(ticketId)).map((i) => ({ id: i.id, text: i.text, done: i.done, dependsOnId: i.dependsOnId }));

/**
 * The activity the delegate may see: the public notes only (replies to the client, of anyone; the delegate's own
 * noted time). Never our internal notes (the help request and the delegates' internal notes included), system
 * notes, time entries, nor our staff's names: an AKAB reply is shown as "AKAB".
 */
function activityOf(notes: Note[]) {
  return notes
    .filter((n) => n.kind !== "time" && !n.system && !n.internal && !isSmsNote(n.text) && n.text.trim())
    .map((n) => ({
      id: n.id,
      at: n.at,
      text: n.text,
      internal: false,
      byDelegate: n.byDelegate === true,
      workedMinutes: n.workedMinutes ?? null,
      // a delegate's own words, a client's message (the client's own name), otherwise AKAB
      author: n.byDelegate || n.by === "client" ? n.author : "AKAB",
    }));
}

/** The detail of a ticket for the delegate (no assignee, no hours, no billing, no staff name) */
function detailOf(ctx: Ctx, t: NTicket, flags: Flags, team: { delegate: { id: string; name: string } | null; delegates: { id: string; name: string }[] }, checklist: unknown[], tags: string[]) {
  const akabWorking = Boolean(flags.akabTakenAt);
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    client: ctx.company.name,
    status: statusOf(ctx, t.status),
    priority: priorityOf(ctx, t.priority),
    contact: t.contact || null,
    contactId: t.contactId,
    dueAt: t.dueAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    /** AKAB has taken the ticket too (the delegate keeps working it); withAkab is the same, kept for older screens */
    akabWorking,
    withAkab: akabWorking,
    withClient: !akabWorking,
    team,
    checklist,
    tags,
    attachments: (t.attachments ?? []).filter((f) => !f.internal).map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.at })),
    activity: activityOf(t.notes),
  };
}

export const delegateRoutes = new Hono<AppEnv>()
  .use("*", requirePermission("clientTickets.delegate"), delegateOnly)

  /** The lists a delegate fills in: statuses the portal offers, priorities, the company's active contacts */
  .get("/options", async (c) => {
    const ctx = await companyCtx(auth(c));
    return c.json({
      statuses: offeredStatuses(ctx.o).map((s) => ({ key: s.value, label: s.label ?? s.value, kind: s.kind })),
      priorities: ctx.o.priorities.map((p) => ({ key: p.value, label: p.label ?? p.value, kind: p.kind })),
      contacts: (await ctx.src.contacts(ctx.company.id)).map((x) => ({ id: x.id, name: x.name, email: x.email })),
    });
  })

  /**
   * The company's tickets, newest activity first. status=open (default) | closed | all; withAkab=1 (AKAB has taken it) | 0 (not);
   * contactId=<contact> (only that contact's); exclude=<ticket> (leaves that one out, e.g. the ticket the list is shown beside).
   */
  .get("/tickets", async (c) => {
    const a = auth(c);
    const ctx = await companyCtx(a);
    const st = c.req.query("status");
    const status = st === "closed" || st === "all" ? st : "open";
    const wa = c.req.query("withAkab");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
    const contactId = (c.req.query("contactId") ?? "").trim().slice(0, 60);
    const exclude = Number(c.req.query("exclude"));
    const size = Math.min(SHOWN_LIMIT, Math.max(1, Math.floor(Number(c.req.query("size")) || 50)));
    const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));

    const [{ tickets: visible, flags }, people] = await Promise.all([visibleTickets(ctx), peopleOf(ctx)]);
    const rows = visible
      .filter((t) => {
        const complete = ctx.L.statusKind(t.status) === "complete";
        const akab = Boolean(flags.get(t.id)?.akabTakenAt);
        if (status === "open" && complete) return false;
        if (status === "closed" && !complete) return false;
        if (wa === "1" && !akab) return false;
        if (wa === "0" && akab) return false;
        if (contactId && t.contactId !== contactId) return false;
        if (Number.isInteger(exclude) && exclude === t.id) return false;
        if (q && !`${t.number} ${t.title} ${t.contact}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const items = rows.slice((page - 1) * size, page * size).map((t) => {
      const f = flags.get(t.id) ?? NO_FLAGS;
      const akab = Boolean(f.akabTakenAt);
      return {
        id: t.id,
        number: t.number,
        title: t.title,
        status: statusOf(ctx, t.status),
        priority: priorityOf(ctx, t.priority),
        contact: t.contact || null,
        dueAt: t.dueAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        akabWorking: akab,
        withClient: !akab,
        delegate: people.pick(f.delegateUserId),
      };
    });
    return c.json({ items, total: rows.length, page: Math.min(page, pages), pages, size });
  })

  .get("/tickets/:id", async (c) => {
    const { ctx, t, flags } = await delegateTicket(auth(c), c.req.param("id"));
    const [people, checklist, tags] = await Promise.all([peopleOf(ctx), checklistView(t.id), tagsOf(t.id)]);
    return c.json(detailOf(ctx, t, flags, { delegate: people.pick(flags.delegateUserId), delegates: people.delegates }, checklist, tags));
  })

  /** A file of the ticket, as a download (pictures inline on `?inline=1`); never an internal one */
  .get("/tickets/:id/files/:fileId", async (c) => {
    const { t } = await delegateTicket(auth(c), c.req.param("id"));
    const fileId = z.string().uuid().safeParse(c.req.param("fileId"));
    if (!fileId.success) throw new HTTPException(404, { message: "not_found" });
    const f = await ticketFile(t.id, fileId.data);
    if (!f?.data || f.internal) throw new HTTPException(404, { message: "not_found" });
    const picture = PICTURE.test(f.contentType) ? f.contentType.toLowerCase().replace("jpg", "jpeg") : null;
    const inline = c.req.query("inline") === "1" && picture;
    return new Response(Buffer.from(f.data, "base64"), {
      headers: {
        "content-type": inline ? picture! : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  })

  /** A new ticket for the company: the portal's own ticket (the delegate is its technician, no assignee, the default queue, never an alert). */
  .post("/tickets", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z
        .object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(8000).default(""),
          priority: z.string().trim().min(1).max(40).optional(),
          contactId: z.string().trim().min(1).max(60).nullable().optional(),
          dueDate: zDate.optional(),
        })
        .strict(),
    );
    limit(a, "create", 30);
    const ctx = await companyCtx(a);
    const o = ctx.o;
    const priority = p.priority ?? o.priorities.find((x) => x.kind === "medium")?.value ?? o.priorities[0]?.value;
    if (!priority || !o.priorities.some((x) => x.value === priority)) throw new HTTPException(400, { message: "invalid_value" });
    const contactId = p.contactId ?? null;
    if (contactId && !(await ctx.src.contacts(ctx.company.id)).some((x) => x.id === contactId)) throw new HTTPException(400, { message: "invalid_contact" });
    // due tomorrow (Québec) unless a day is given
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + 86_400_000));
    const queue = await defaultQueueKey();
    const id = await run(() => ctx.src.create({ title: p.title, description: p.description, companyId: ctx.company.id, contactId, priority, queue, assigneeId: null, dueDate: p.dueDate ?? tomorrow }, a));
    await run(() => ctx.src.addNote(id, { text: `Créé par ${a.user.name} (technicien délégué)`, internal: true, byDelegate: true }, a));
    // the delegate who made it is its technician
    await db().update(schema.tickets).set({ delegateUserId: a.user.id }).where(eq(schema.tickets.id, id));
    const made = await ctx.src.get(id);
    await audit(a.user.id, "delegate.ticket_created", String(id), { number: made?.number ?? null, company: ctx.company.id });
    return c.json({ id, number: made?.number ?? null }, 201);
  })

  /** A public note to the client (never emailed here), optionally with the time the delegate noted on it (a note only) */
  .post("/tickets/:id/notes", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(4000), workedMinutes: z.number().int().min(0).max(1440).optional() }).strict());
    const { ctx, t } = await delegateTicket(a, c.req.param("id"));
    limit(a, "note", 60);
    const worked = p.workedMinutes && p.workedMinutes > 0 ? p.workedMinutes : null;
    await run(() => ctx.src.addNote(t.id, { text: p.text, internal: false, byDelegate: true, workedMinutes: worked }, a));
    await audit(a.user.id, "delegate.note_added", String(t.id), { workedMinutes: worked });
    return c.json({ ok: true }, 201);
  })

  /**
   * Status, priority, due day, title, description, contact and the delegate of the ticket (one of the company's
   * delegates, or null): nothing else (no assignee, company, queue, contract, hours, tags).
   */
  .patch("/tickets/:id", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z
        .object({
          status: z.string().trim().min(1).max(60).optional(),
          priority: z.string().trim().min(1).max(40).optional(),
          dueDate: zDate.optional(),
          title: z.string().trim().min(1).max(200).optional(),
          description: z.string().trim().max(8000).optional(),
          contactId: z.string().trim().min(1).max(60).nullable().optional(),
          delegateId: zUuid.nullable().optional(),
        })
        .strict(),
    );
    const { ctx, t } = await delegateTicket(a, c.req.param("id"));
    if (p.status !== undefined && !offeredStatuses(ctx.o).some((s) => s.value === p.status)) throw new HTTPException(400, { message: "invalid_value" });
    if (p.priority !== undefined && !ctx.o.priorities.some((s) => s.value === p.priority)) throw new HTTPException(400, { message: "invalid_value" });
    if (p.contactId && !(await ctx.src.contacts(ctx.company.id)).some((x) => x.id === p.contactId)) throw new HTTPException(400, { message: "invalid_contact" });
    // the delegate must be one of this company's delegates (never a staff member, never another company's user)
    if (p.delegateId && !(await delegatesOfCompany(ctx.company.id)).includes(p.delegateId)) throw new HTTPException(400, { message: "invalid_delegate" });
    const { delegateId, ...rest } = p;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length) await run(() => ctx.src.update(t.id, patch as TicketPatch, a));
    if (delegateId !== undefined) {
      await db().update(schema.tickets).set({ delegateUserId: delegateId }).where(eq(schema.tickets.id, t.id));
      await audit(a.user.id, "delegate.delegate_set", String(t.id), { delegate: delegateId });
    }
    await audit(a.user.id, "delegate.ticket_updated", String(t.id), { fields: [...Object.keys(patch), ...(delegateId !== undefined ? ["delegateId"] : [])] });
    return c.json({ ok: true });
  })

  /** A file for the technician (one per request, base64): kept on the ticket, source "portal" */
  .post("/tickets/:id/attachments", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().max(120).default("application/octet-stream"),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).min(1).max(Math.ceil(MAX_TICKET_ATTACHMENT_BYTES / 3) * 4),
      }),
    );
    const { ctx, t } = await delegateTicket(a, c.req.param("id"));
    limit(a, "file", 20);
    await run(() => ctx.src.addAttachment(t.id, p, a));
    await audit(a.user.id, "delegate.ticket_file", String(t.id), { name: p.name });
    return c.json({ ok: true }, 201);
  })

  /**
   * Ask AKAB for help: AKAB takes the ticket (unassigned, back to a "new" status), with an internal note, and the
   * staff who plan the tickets are told. Only while AKAB has not taken it yet.
   */
  .post("/tickets/:id/help", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ message: z.string().trim().max(1000).optional() }).strict());
    const { ctx, t, flags } = await delegateTicket(a, c.req.param("id"));
    if (flags.akabTakenAt) throw new HTTPException(409, { message: "already_with_akab" });
    if (!rateLimit(`delegate-help:${a.user.id}`, 10, 3600_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const newStatus = offeredStatuses(ctx.o).find((s) => s.kind === "new")?.value;
    const who = a.user.name;
    const note = `Aide demandée par ${who} (technicien délégué — ${ctx.company.name})${p.message ? `\n${p.message}` : ""}`;
    await run(() => ctx.src.addNote(t.id, { text: note, internal: true, byDelegate: true }, a));
    await run(() => ctx.src.update(t.id, { ...(newStatus ? { status: newStatus } : {}), assigneeId: null, secondaryIds: [] }, a));
    await db().update(schema.tickets).set({ akabTakenAt: new Date(), helpRequestedBy: a.user.id }).where(eq(schema.tickets.id, t.id));
    const staff = await usersWith("staff", "tickets.plan");
    await notify(staff, {
      type: "ticket.help",
      data: { number: t.number, title: t.title, company: ctx.company.name, by: who, preview: p.message ?? "" },
      link: `/tickets?t=${t.id}`,
    });
    await audit(a.user.id, "delegate.help_requested", String(t.id));
    return c.json({ ok: true }, 201);
  })

  // ── The checklist (the steps to complete before the ticket can be; an item may wait for another) ──
  .post("/tickets/:id/checklist", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300) }).strict());
    const { t } = await delegateTicket(a, c.req.param("id"));
    limit(a, "structure", 120);
    await checklistRun(() => addItem(t.id, { text: p.text }, a.user.id));
    await audit(a.user.id, "delegate.checklist", String(t.id), { action: "add" });
    return c.json(await checklistView(t.id), 201);
  })

  .patch("/tickets/:id/checklist/:itemId", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() }).strict());
    const { t } = await delegateTicket(a, c.req.param("id"));
    const itemId = itemIdOf(c.req.param("itemId"));
    limit(a, "structure", 120);
    await checklistRun(() => updateItem(t.id, itemId, p, a.user.id));
    await audit(a.user.id, "delegate.checklist", String(t.id), { action: "update", done: p.done ?? null });
    return c.json(await checklistView(t.id));
  })

  .delete("/tickets/:id/checklist/:itemId", async (c) => {
    const a = auth(c);
    const { t } = await delegateTicket(a, c.req.param("id"));
    const itemId = itemIdOf(c.req.param("itemId"));
    limit(a, "structure", 120);
    await checklistRun(() => deleteItem(t.id, itemId));
    await audit(a.user.id, "delegate.checklist", String(t.id), { action: "delete" });
    return c.json(await checklistView(t.id));
  })

  // ── Tags (labels to find a ticket back by): at most 12, each short, no doubles ──
  .put("/tickets/:id/tags", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(12) }).strict());
    const { t } = await delegateTicket(a, c.req.param("id"));
    limit(a, "structure", 120);
    const seen = new Set<string>();
    const tags = p.tags.filter((x) => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)));
    await db()
      .insert(schema.ticketMeta)
      .values({ ticketId: t.id, tags, updatedBy: a.user.id })
      .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { tags, updatedBy: a.user.id, updatedAt: new Date() } });
    await audit(a.user.id, "delegate.tags", String(t.id), { count: tags.length });
    return c.json({ tags });
  })

  // ── Merge (within the delegate's own company only) ──
  /** The open tickets of the company this one can be merged into (not itself, not alerts, not hidden from delegates) */
  .get("/tickets/:id/merge-targets", async (c) => {
    const { ctx, t } = await delegateTicket(auth(c), c.req.param("id"));
    const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
    const { tickets: visible, flags } = await visibleTickets(ctx);
    const items = visible
      .filter((x) => x.id !== t.id && ctx.L.statusKind(x.status) !== "complete" && (!q || `${x.number} ${x.title}`.toLowerCase().includes(q)))
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
      .slice(0, 30)
      .map((x) => ({ id: x.id, number: x.number, title: x.title, status: statusOf(ctx, x.status), updatedAt: x.updatedAt, akabWorking: Boolean(flags.get(x.id)?.akabTakenAt) }));
    return c.json({ items });
  })

  /** Merge this ticket into another open ticket of the same company: both must be visible to the delegate */
  .post("/tickets/:id/merge", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ intoId: z.number().int().positive() }).strict());
    const { t } = await delegateTicket(a, c.req.param("id"));
    const { t: into } = await delegateTicket(a, String(p.intoId));
    limit(a, "structure", 120);
    const r = await run(() => mergeTickets(t.id, into.id, a));
    await audit(a.user.id, "delegate.merged", String(t.id), { into: into.id, number: r.number });
    return c.json({ ok: true, ...r });
  });
