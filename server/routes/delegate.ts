import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body } from "../lib/validate.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { ticketCompanyOf } from "../lib/clientTickets.ts";
import { isSelfManagedClient } from "../lib/selfManaged.ts";
import { defaultQueueKey } from "../lib/queues.ts";
import { ticketFile } from "../lib/localTickets.ts";
import { isSmsNote, MAX_TICKET_ATTACHMENT_BYTES, SourceError, ticketSource, type NTicket, type Note, type Options, type TicketPatch } from "../lib/ticketSource.ts";
import { isAlert, lookup } from "./tickets.ts";

/**
 * The delegated technicians of a self-managed company (clientTickets.delegate):
 * they work their company's tickets themselves. Never our staff's view: no
 * assignee, no time, no charges, no internal note of ours, no system note.
 * Alerts and other companies' tickets are never reachable (404). Writes need the
 * ticket to be with the client (not taken by AKAB, `akab_taken_at` null).
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

/** Whether the ticket is with the client (AKAB has not taken it) */
async function withClientOf(id: number): Promise<boolean> {
  const [r] = await db().select({ at: schema.tickets.akabTakenAt }).from(schema.tickets).where(eq(schema.tickets.id, id));
  return !r?.at;
}

/** One ticket of the delegate's company, not an alert, not a merged one. 404 otherwise. */
async function delegateTicket(a: AuthContext, rawId: string) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(404, { message: "not_found" });
  const ctx = await companyCtx(a);
  const t = await ctx.src.get(id);
  if (!t || t.company.id !== ctx.company.id || isAlert(ctx.L)(t) || HIDDEN_STATUS.has(t.status)) throw new HTTPException(404, { message: "not_found" });
  return { ctx, t, withClient: await withClientOf(id) };
}

function requireWithClient(withClient: boolean) {
  if (!withClient) throw new HTTPException(409, { message: "with_akab" });
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

/**
 * The activity the delegate may see: what was said to the client (public
 * replies, of anyone), and the notes written by delegates. Never our internal
 * notes, system notes, time entries, nor our staff's names.
 */
function activityOf(notes: Note[]) {
  return notes
    .filter((n) => n.kind !== "time" && !n.system && !isSmsNote(n.text) && n.text.trim())
    .filter((n) => !n.internal || n.byDelegate === true)
    .map((n) => ({
      id: n.id,
      at: n.at,
      text: n.text,
      internal: n.internal,
      byDelegate: n.byDelegate === true,
      // a delegate's own words, a client's message (the client's own name), otherwise AKAB
      author: n.byDelegate || n.by === "client" ? n.author : "AKAB",
    }));
}

/** The detail of a ticket for the delegate (no assignee, no hours, no billing) */
function detailOf(ctx: Ctx, t: NTicket, withClient: boolean) {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    status: statusOf(ctx, t.status),
    priority: priorityOf(ctx, t.priority),
    contact: t.contact || null,
    contactId: t.contactId,
    dueAt: t.dueAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    withClient,
    withAkab: !withClient,
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

  /** The company's tickets, newest activity first. status=open (default) | closed | all; withAkab=1 (AKAB has it) | 0 (with the client). */
  .get("/tickets", async (c) => {
    const a = auth(c);
    const ctx = await companyCtx(a);
    const st = c.req.query("status");
    const status = st === "closed" || st === "all" ? st : "open";
    const wa = c.req.query("withAkab");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
    const size = Math.min(SHOWN_LIMIT, Math.max(1, Math.floor(Number(c.req.query("size")) || 50)));
    const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));

    const [recent, history] = await Promise.all([ctx.src.list(), ctx.src.companyHistory(ctx.company.id)]);
    const seen = new Set<number>();
    const all = [...recent, ...history].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return t.company.id === ctx.company.id && !isAlert(ctx.L)(t) && !HIDDEN_STATUS.has(t.status);
    });
    const akab = new Map(
      all.length
        ? (await db().select({ id: schema.tickets.id, at: schema.tickets.akabTakenAt }).from(schema.tickets).where(inArray(schema.tickets.id, all.map((t) => t.id)))).map((r) => [r.id, Boolean(r.at)])
        : [],
    );
    const rows = all
      .filter((t) => {
        const complete = ctx.L.statusKind(t.status) === "complete";
        if (status === "open" && complete) return false;
        if (status === "closed" && !complete) return false;
        if (wa === "1" && !akab.get(t.id)) return false;
        if (wa === "0" && akab.get(t.id)) return false;
        if (q && !`${t.number} ${t.title} ${t.contact}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const items = rows.slice((page - 1) * size, page * size).map((t) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      status: statusOf(ctx, t.status),
      priority: priorityOf(ctx, t.priority),
      contact: t.contact || null,
      dueAt: t.dueAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      withClient: !akab.get(t.id),
    }));
    return c.json({ items, total: rows.length, page: Math.min(page, pages), pages, size });
  })

  .get("/tickets/:id", async (c) => {
    const { ctx, t, withClient } = await delegateTicket(auth(c), c.req.param("id"));
    return c.json(detailOf(ctx, t, withClient));
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

  /** A new ticket for the company: the portal's own ticket (no technician, the default queue, never an alert). */
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
    const made = await ctx.src.get(id);
    await audit(a.user.id, "delegate.ticket_created", String(id), { number: made?.number ?? null, company: ctx.company.id });
    return c.json({ id, number: made?.number ?? null }, 201);
  })

  /** A reply to the client (public) or an internal note: both written by the delegate, never emailed */
  .post("/tickets/:id/notes", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(4000), kind: z.enum(["reply", "note"]) }).strict());
    const { ctx, t, withClient } = await delegateTicket(a, c.req.param("id"));
    requireWithClient(withClient);
    limit(a, "note", 60);
    await run(() => ctx.src.addNote(t.id, { text: p.text, internal: p.kind === "note", byDelegate: true }, a));
    await audit(a.user.id, "delegate.note_added", String(t.id), { kind: p.kind });
    return c.json({ ok: true }, 201);
  })

  /** Status, priority, due day, title, description and contact: nothing else (no assignee, company, queue, contract, hours, tags) */
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
        })
        .strict(),
    );
    const { ctx, t, withClient } = await delegateTicket(a, c.req.param("id"));
    if (p.status !== undefined && !offeredStatuses(ctx.o).some((s) => s.value === p.status)) throw new HTTPException(400, { message: "invalid_value" });
    if (p.priority !== undefined && !ctx.o.priorities.some((s) => s.value === p.priority)) throw new HTTPException(400, { message: "invalid_value" });
    if (p.contactId && !(await ctx.src.contacts(ctx.company.id)).some((x) => x.id === p.contactId)) throw new HTTPException(400, { message: "invalid_contact" });
    requireWithClient(withClient);
    const patch = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length) await run(() => ctx.src.update(t.id, patch as TicketPatch, a));
    await audit(a.user.id, "delegate.ticket_updated", String(t.id), { fields: Object.keys(patch) });
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
    const { ctx, t, withClient } = await delegateTicket(a, c.req.param("id"));
    requireWithClient(withClient);
    limit(a, "file", 20);
    await run(() => ctx.src.addAttachment(t.id, p, a));
    await audit(a.user.id, "delegate.ticket_file", String(t.id), { name: p.name });
    return c.json({ ok: true }, 201);
  })

  /**
   * Ask AKAB for help: the ticket is taken by AKAB (unassigned, back to a "new"
   * status), with an internal note, and the staff who plan the tickets are told.
   */
  .post("/tickets/:id/help", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ message: z.string().trim().max(1000).optional() }).strict());
    const { ctx, t, withClient } = await delegateTicket(a, c.req.param("id"));
    requireWithClient(withClient);
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
  });
