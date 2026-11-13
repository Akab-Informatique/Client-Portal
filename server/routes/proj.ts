import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notify } from "../lib/notify.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { config } from "../config.ts";
import { rateLimit } from "../lib/http.ts";
import { refreshAccrual } from "../lib/hr.ts";
import { addDays, editable, sheetOf, todayQc, weekStartOf } from "../lib/timesheets.ts";
import { listQuotes } from "../lib/quotes.ts";
import { archiveProjects, billProj, importArchiveProject, MAX_FILE_BYTES, pendingFiles, ProjBillError, projBilling, projectFromQuote, projectFromTicket, takeFiles } from "../lib/projBilling.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { ticketScopeOf } from "../lib/selfManaged.ts";
import { resetWatch, setWatchDays } from "../lib/watch.ts";
import { WATCH_MAX_DAYS } from "../../shared/watch.ts";
import { syncBillablesNow } from "../lib/billables.ts";
import { billingSettings } from "../lib/billing.ts";
import { hourlyRateOf } from "../lib/contracts.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import {
  activeStaff,
  addEntry,
  detailOf,
  entriesOf,
  hoursFromSeconds,
  insertProject,
  isClosed,
  loadEntry,
  loadNote,
  loadProj,
  loadTask,
  markDone,
  noteViews,
  projectViews,
  sendClientReply,
  snapshotOf,
  taskViews,
  tasksIn,
  timeViews,
  timerSeconds,
  timerView,
  x100Of,
  type ProjRow,
  type TaskRow,
} from "../lib/proj.ts";

/**
 * Centre de commande › Projets (new format, proj_*): a project has tasks given to the team, notes (some tagging tasks)
 * and the time entered on it (one timer per person). Staff only; the rights are proj.view / proj.edit / proj.manage.
 */

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, { message: "invalid_date" });
const zIds = (max: number) => z.array(zUuid).max(max);
const zPriority = z.enum(["low", "medium", "high", "urgent"]);
const zTaskStatus = z.enum(["todo", "doing", "done"]);
const zStatus = z.enum(["planning", "active", "done", "cancelled"]);

const zMoney = z.number().min(0).max(10_000_000);
const zBilling = {
  billingMode: z.enum(["hourly", "fixed", "bank", "contract", "special"]).optional(),
  /** billingMode contract: one of the client's active contracts */
  contractId: zUuid.nullable().optional(),
  /** special: the rate typed; bank: the price of an hour of the bank (dollars) */
  hourlyRate: zMoney.nullable().optional(),
  fixedPrice: zMoney.nullable().optional(),
  bankExpiresOn: zDay.nullable().optional(),
};

const zProjectCreate = z.object({
  ...zBilling,
  name: z.string().trim().min(1).max(200),
  clientId: zUuid.nullable().optional(),
  /** default: me */
  leadId: zUuid.nullable().optional(),
  memberIds: zIds(30).optional(),
  startDate: zDay.nullable().optional(),
  dueDate: zDay.nullable().optional(),
  soldHours: z.number().min(0).max(100000).nullable().optional(),
  description: z.string().max(8000).optional(),
  contactId: zUuid.nullable().optional(),
  quoteId: zUuid.nullable().optional(),
});

const zProjectPatch = z.object({
  ...zBilling,
  name: z.string().trim().min(1).max(200).optional(),
  clientId: zUuid.nullable().optional(),
  leadId: zUuid.nullable().optional(),
  contactId: zUuid.nullable().optional(),
  status: zStatus.optional(),
  startDate: zDay.nullable().optional(),
  dueDate: zDay.nullable().optional(),
  soldHours: z.number().min(0).max(100000).nullable().optional(),
  description: z.string().max(8000).optional(),
  salesNotes: z.string().max(8000).optional(),
  memberIds: zIds(30).optional(),
});

const zTaskCreate = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000).optional(),
  priority: zPriority.optional(),
  assigneeId: zUuid.nullable().optional(),
  dueDate: zDay.nullable().optional(),
});

const zTaskPatch = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(8000).optional(),
  priority: zPriority.optional(),
  assigneeId: zUuid.nullable().optional(),
  dueDate: zDay.nullable().optional(),
  status: zTaskStatus.optional(),
  /** the time entry (mine, on this project) that finished the task */
  entryId: zUuid.nullable().optional(),
});

const zNote = z.object({
  text: z.string().trim().min(1).max(8000),
  /** default true: a note for the team only */
  internal: z.boolean().optional(),
  taskIds: zIds(10).optional(),
  /** with internal false: a reply emailed to `to` */
  email: z.boolean().optional(),
  to: z.array(zEmail).max(10).optional(),
  /** files uploaded first (POST /:id/files), sent with this note */
  attachmentIds: zIds(10).optional(),
});

const zTimeFields = {
  date: zDay.optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  billable: z.boolean().optional(),
  taskIds: zIds(60).optional(),
  doneTaskIds: zIds(60).optional(),
};
const zTime = z.object({ ...zTimeFields, hours: z.number().gt(0).max(24) });
const zStop = z.object({ ...zTimeFields, hours: z.number().gt(0).max(24).optional() });

const zListQuery = z.object({
  status: z.enum(["open", "done", "all"]).optional(),
  q: z.string().max(200).optional(),
  lead: zUuid.optional(),
  member: zUuid.optional(),
  client: zUuid.optional(),
});

const isManager = (a: ReturnType<typeof auth>) => a.permissions.includes("proj.manage");

/** Logging time needs the timesheet right as well as the project's */
/** A project as the caller may see it: the quote's prices only with the right to see quotes */
async function viewFor(row: Parameters<typeof detailOf>[0], a: ReturnType<typeof auth>) {
  const d = await detailOf(row, a.user.id, isManager(a));
  return a.permissions.includes("quotes.view") ? d : { ...d, quote: null };
}

function needTimesheets(a: ReturnType<typeof auth>) {
  if (!a.permissions.includes("timesheets.use")) throw new HTTPException(403, { message: "forbidden" });
}

/** Whether a contact belongs to a client */
async function contactBelongs(contactId: string, clientId: string | null): Promise<boolean> {
  if (!clientId) return false;
  const [c] = await db()
    .select({ id: schema.clientContacts.id })
    .from(schema.clientContacts)
    .where(and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.clientId, clientId)));
  return Boolean(c);
}

async function clientExists(id: string): Promise<void> {
  const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, id));
  if (!c) throw new HTTPException(400, { message: "client_unknown" });
}

/** The project's timer of one person, if any */
async function timerOf(projectId: string, userId: string) {
  const [t] = await db()
    .select()
    .from(schema.projTimers)
    .where(and(eq(schema.projTimers.projectId, projectId), eq(schema.projTimers.userId, userId)));
  return t ?? null;
}

async function requireTimer(projectId: string, userId: string) {
  const t = await timerOf(projectId, userId);
  if (!t) throw new HTTPException(404, { message: "timer_not_found" });
  return t;
}

const cents = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100));

/**
 * The billing columns of a project from what was typed, checked: fixed needs its price, a bank of hours its hours, the price of an
 * hour and the day it expires (and a client), a contract an active contract of the client, special a rate.
 */
async function billingColumns(o: { mode: string; contractId: string | null | undefined; hourlyRate: number | null | undefined; fixedPrice: number | null | undefined; bankExpiresOn: string | null | undefined; soldHours: number | null | undefined; clientId: string | null; startDate: string | null }) {
  const none = { contractId: null as string | null, hourlyRateCents: null as number | null, fixedPriceCents: null as number | null, bankExpiresOn: null as string | null };
  if (o.mode === "hourly") return { billingMode: "hourly" as const, ...none };
  if (o.mode === "special") {
    if (!o.hourlyRate || o.hourlyRate <= 0) throw new HTTPException(400, { message: "rate_required" });
    return { billingMode: "special" as const, ...none, hourlyRateCents: cents(o.hourlyRate) };
  }
  if (o.mode === "fixed") {
    if (!o.fixedPrice || o.fixedPrice <= 0) throw new HTTPException(400, { message: "price_required" });
    return { billingMode: "fixed" as const, ...none, fixedPriceCents: cents(o.fixedPrice), hourlyRateCents: cents(o.hourlyRate) };
  }
  if (o.mode === "bank") {
    if (!o.clientId) throw new HTTPException(400, { message: "bank_needs_client" });
    if (!o.soldHours || o.soldHours <= 0) throw new HTTPException(400, { message: "bank_hours_required" });
    if (!o.hourlyRate || o.hourlyRate <= 0) throw new HTTPException(400, { message: "bank_rate_required" });
    if (!o.bankExpiresOn || o.bankExpiresOn < todayQc() || (o.startDate && o.bankExpiresOn < o.startDate)) throw new HTTPException(400, { message: "bank_expiry_required" });
    return { billingMode: "bank" as const, ...none, hourlyRateCents: cents(o.hourlyRate), fixedPriceCents: Math.round(o.soldHours * (cents(o.hourlyRate) ?? 0)), bankExpiresOn: o.bankExpiresOn };
  }
  // contract
  if (!o.clientId) throw new HTTPException(400, { message: "contract_needs_client" });
  if (!o.contractId) throw new HTTPException(400, { message: "contract_required" });
  const [k] = await db()
    .select({ id: schema.clientContracts.id })
    .from(schema.clientContracts)
    .where(and(eq(schema.clientContracts.id, o.contractId), eq(schema.clientContracts.clientId, o.clientId), eq(schema.clientContracts.active, true)));
  if (!k) throw new HTTPException(400, { message: "contract_invalid" });
  return { billingMode: "contract" as const, ...none, contractId: k.id as string | null };
}

/** Tells the person a task was given to them (never to oneself) */
async function tellAssignee(p: ProjRow, who: string | null | undefined, by: { id: string; name: string }, title: string) {
  if (!who || who === by.id) return;
  await notify([who], { type: "proj.assigned", data: { number: p.number, name: p.name, title: title.slice(0, 200), by: by.name }, link: `/tickets?pj=${p.id}` });
}

const NUM = (n: string) => Number(n.replace(/\D/g, "")) || 0;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const projRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** The projects, the ones still open by default; word search on number, name and client */
  .get("/", requirePermission("proj.view"), async (c) => {
    const q = zListQuery.safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: "Validation failed" });
    const status = q.data.status ?? "open";
    const conds = [];
    if (status === "open") conds.push(inArray(schema.projProjects.status, ["planning", "active"]));
    if (status === "done") conds.push(inArray(schema.projProjects.status, ["done", "cancelled"]));
    if (q.data.lead) conds.push(eq(schema.projProjects.leadId, q.data.lead));
    if (q.data.client) conds.push(eq(schema.projProjects.clientId, q.data.client));
    let rows = await db()
      .select()
      .from(schema.projProjects)
      .where(conds.length ? and(...conds) : undefined);
    if (q.data.member) {
      const memberOf = new Set(
        (await db().select({ projectId: schema.projMembers.projectId }).from(schema.projMembers).where(eq(schema.projMembers.userId, q.data.member))).map((m) => m.projectId),
      );
      rows = rows.filter((r) => r.leadId === q.data.member || memberOf.has(r.id));
    }
    let views = await projectViews(rows);
    const words = q.data.q?.trim() ? fold(q.data.q.trim()).split(/\s+/) : [];
    if (words.length) views = views.filter((v) => words.every((w) => fold(`${v.number} ${v.name} ${v.client?.name ?? ""}`).includes(w)));
    // due day first (none last), then the newest number
    views.sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return NUM(b.number) - NUM(a.number);
    });
    return c.json(views);
  })

  /** The quotes of a client a project can be made from (accepted and sent first) */
  .get("/quotes", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("quotes.view")) throw new HTTPException(403, { message: "quote_forbidden" });
    const clientId = zUuid.safeParse(c.req.query("clientId"));
    if (!clientId.success) throw new HTTPException(400, { message: "client_required" });
    const rank = (s: string) => (s === "accepted" ? 0 : s === "sent" ? 1 : 2);
    const rows = (await listQuotes({ clientId: clientId.data }))
      .map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, totalCents: r.totals.totalCents }))
      .sort((x, y) => rank(x.status) - rank(y.status))
      .slice(0, 50);
    return c.json(rows);
  })

  /** My running timers (all projects) */
  .get("/timers", requirePermission("proj.view"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ t: schema.projTimers, p: schema.projProjects })
      .from(schema.projTimers)
      .innerJoin(schema.projProjects, eq(schema.projProjects.id, schema.projTimers.projectId))
      .where(eq(schema.projTimers.userId, a.user.id));
    return c.json(rows.map((r) => ({ projectId: r.p.id, number: r.p.number, name: r.p.name, seconds: timerSeconds(r.t), paused: r.t.pausedAt !== null })));
  })

  /** The client's active contracts a project can be billed under, with what an hour costs under each */
  .get("/client-contracts/:clientId", requirePermission("proj.view"), async (c) => {
    const clientId = zUuid.safeParse(c.req.param("clientId"));
    if (!clientId.success) throw new HTTPException(404, { message: "not_found" });
    const usual = (await billingSettings()).rates.hourly;
    const rows = await db().select().from(schema.clientContracts).where(and(eq(schema.clientContracts.clientId, clientId.data), eq(schema.clientContracts.active, true))).orderBy(asc(schema.clientContracts.name));
    return c.json(rows.map((k) => ({ id: k.id, name: k.name, hourlyRate: ((r) => (r == null ? null : r / 100))(hourlyRateOf(k, usual)) })));
  })

  /** The archive projects and whether each is already brought into this format (administrators) */
  .get("/archive", requirePermission("proj.manage"), async (c) => c.json(await archiveProjects()))

  /** Brings one archive project over (once): see importArchiveProject */
  .post("/archive/:id/import", requirePermission("proj.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(404, { message: "not_found" });
    const row = await importArchiveProject(id.data, a.user.id);
    await audit(a.user.id, "proj.archive_imported", row.id, { number: row.number, name: row.name });
    return c.json({ id: row.id, number: row.number }, 201);
  })

  /** A project made from an accepted or sent quote: hours and price of its hour lines, billed the way it was sold */
  .post("/from-quote/:quoteId", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("quotes.view")) throw new HTTPException(403, { message: "quote_forbidden" });
    const id = zUuid.safeParse(c.req.param("quoteId"));
    if (!id.success) throw new HTTPException(404, { message: "not_found" });
    const r = await projectFromQuote(id.data, a.user.id);
    await audit(a.user.id, "proj.from_quote", r.project.id, { number: r.project.number, quote: id.data });
    let billed = false;
    // a bank of hours is paid when sold
    if (r.project.billingMode === "bank") {
      try {
        await billProj(r.project.id);
        billed = true;
        await syncBillablesNow();
      } catch {
        billed = false;
      }
    }
    return c.json({ id: r.project.id, number: r.project.number, sale: r.sale, billed }, 201);
  })

  /** A project made from a ticket: its notes, files and checklist come along; the ticket is closed as transformed */
  .post("/from-ticket/:ticketId", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("tickets.edit")) throw new HTTPException(403, { message: "forbidden" });
    const tid = Number(c.req.param("ticketId"));
    if (!Number.isSafeInteger(tid) || tid <= 0) throw new HTTPException(404, { message: "not_found" });
    // a ticket the caller cannot see answers like a missing one
    try {
      await (await ticketSource(ticketScopeOf(c))).get(tid);
    } catch {
      throw new HTTPException(404, { message: "not_found" });
    }
    const r = await projectFromTicket(tid, a.user.id);
    await audit(a.user.id, "proj.from_ticket", r.project.id, { number: r.project.number, ticket: r.ticketNumber });
    return c.json({ id: r.project.id, number: r.project.number }, 201);
  })

  /** A new project: the next number, the team (the lead always in it), the quote it is sold from (a snapshot) */
  .post("/", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, zProjectCreate);
    let clientId = p.clientId ?? null;
    if (clientId) await clientExists(clientId);
    let quote: Awaited<ReturnType<typeof snapshotOf>> | null = null;
    if (p.quoteId) {
      if (!a.permissions.includes("quotes.view")) throw new HTTPException(403, { message: "quote_forbidden" });
      quote = await snapshotOf(p.quoteId);
      if (clientId && quote.clientId !== clientId) throw new HTTPException(400, { message: "quote_invalid" });
      // a quote for a client makes the project for that client when none was picked
      if (!clientId) clientId = quote.clientId;
    }
    const contactId = p.contactId ?? null;
    if (contactId && !(await contactBelongs(contactId, clientId))) throw new HTTPException(400, { message: "contact_invalid" });
    const leadId = p.leadId === undefined ? a.user.id : p.leadId;
    const memberIds = [...new Set([...(p.memberIds ?? []), ...(leadId ? [leadId] : [])])];
    await activeStaff([...memberIds]);
    const startDate = p.startDate ?? null;
    const dueDate = p.dueDate ?? null;
    if (startDate && dueDate && dueDate < startDate) throw new HTTPException(400, { message: "dates" });
    const billing = await billingColumns({ mode: p.billingMode ?? "hourly", contractId: p.contractId, hourlyRate: p.hourlyRate, fixedPrice: p.fixedPrice, bankExpiresOn: p.bankExpiresOn, soldHours: p.soldHours, clientId, startDate });
    const row = await insertProject({
      ...billing,
      name: p.name,
      clientId,
      leadId,
      contactId,
      status: "planning",
      startDate,
      dueDate,
      soldHoursX100: x100Of(p.soldHours),
      description: p.description ?? "",
      salesNotes: quote?.internalNotes ?? "",
      quoteId: p.quoteId ?? null,
      quoteSnapshot: quote?.snapshot ?? null,
      createdBy: a.user.id,
    });
    if (memberIds.length) await db().insert(schema.projMembers).values(memberIds.map((userId) => ({ projectId: row.id, userId })));
    await audit(a.user.id, "proj.created", row.id, { number: row.number, name: row.name, quote: p.quoteId ?? null, billing: row.billingMode });
    // a bank of hours is paid when sold: its price goes to Approbation at once (never fails the creation)
    let billed = false;
    if (row.billingMode === "bank") {
      try {
        await billProj(row.id);
        billed = true;
        await syncBillablesNow();
      } catch {
        billed = false;
      }
    }
    return c.json({ ...(await viewFor(await loadProj(row.id), a)), billed }, 201);
  })

  /**
   * The start-up pop-up of a new project (made by hand, from a quote or from a ticket): sets the leader, the team and a short
   * description, and writes the notes as the project's first internal note. The leader (when it is not the person who
   * writes) gets the bell and an email.
   */
  .post("/:id/kickoff", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const cur = await loadProj(c.req.param("id"));
    const k = await body(c, z.object({ leadId: zUuid.nullable().optional(), memberIds: z.array(zUuid).max(30).optional(), description: z.string().trim().max(2000).optional(), notes: z.string().trim().max(8000).optional() }));
    const leadId = k.leadId !== undefined ? k.leadId : cur.leadId;
    if (leadId) await activeStaff([leadId]);
    const set: Partial<typeof schema.projProjects.$inferInsert> = { updatedAt: new Date(), leadId };
    if (k.description) set.description = k.description;
    await db().update(schema.projProjects).set(set).where(eq(schema.projProjects.id, cur.id));
    if (k.memberIds !== undefined || (leadId && leadId !== cur.leadId)) {
      const current = (await db().select({ userId: schema.projMembers.userId }).from(schema.projMembers).where(eq(schema.projMembers.projectId, cur.id))).map((m) => m.userId);
      const team = [...new Set([...(k.memberIds ?? current), ...(leadId ? [leadId] : [])])];
      await activeStaff(team);
      await db().delete(schema.projMembers).where(eq(schema.projMembers.projectId, cur.id));
      if (team.length) await db().insert(schema.projMembers).values(team.map((userId) => ({ projectId: cur.id, userId })));
    }
    // the description and the notes become one internal note
    const text = [k.description ? `Description\n${k.description}` : "", k.notes ? `Notes\n${k.notes}` : ""].filter(Boolean).join("\n\n");
    if (text) await db().insert(schema.projNotes).values({ projectId: cur.id, authorId: a.user.id, text, internal: true, emailedTo: [] });
    // the leader is told, by the bell and by email (never when they wrote it themselves)
    let told = false;
    if (leadId && leadId !== a.user.id) {
      const link = `/pipeline?section=tickets&pj=${cur.id}`;
      await notify([leadId], { type: "proj.kickoff", data: { number: cur.number, name: cur.name, by: a.realUser.name, message: (k.description || k.notes || "").slice(0, 300) }, link });
      const [lead] = await db().select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, leadId));
      if (lead?.email) {
        const url = config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}${link}` : null;
        const head = `${a.realUser.name} vous a confié la direction du projet ${cur.number} — ${cur.name}.`;
        const plain = [`Bonjour ${lead.name},`, "", head, ...(text ? ["", text] : []), ...(url ? ["", url] : []), "", "—", "AKAB Informatique"].join("\n");
        const html = `<p>Bonjour ${escapeHtml(lead.name)},</p><p>${escapeHtml(head)}</p>${text ? `<p style="white-space:pre-wrap;border-left:3px solid #8b5cf6;padding-left:10px">${escapeHtml(text)}</p>` : ""}${url ? `<p><a href="${escapeHtml(url)}">Ouvrir le projet</a></p>` : ""}<p>—<br>AKAB Informatique</p>`;
        told = await sendMail({ to: lead.email, subject: `[${cur.number}] Vous dirigez le projet ${cur.name}`.slice(0, 250), text: plain, html }).catch(() => false);
      }
    }
    await audit(a.user.id, "proj.kickoff", cur.id, { number: cur.number, lead: leadId, notified: told });
    return c.json({ ok: true, emailed: told });
  })

  /** Opening the project, or the reset button: the count of quiet days starts again */
  .post("/:id/watch/reset", requirePermission("proj.view"), async (c) => {
    const p = await loadProj(c.req.param("id"));
    await resetWatch("proj", p.id);
    return c.json({ ok: true });
  })

  /** The reminder delay of this project in working days (null: the default) */
  .put("/:id/watch", requirePermission("proj.edit"), async (c) => {
    const p = await loadProj(c.req.param("id"));
    const w = await body(c, z.object({ days: z.number().int().min(1).max(WATCH_MAX_DAYS).nullable() }));
    await setWatchDays("proj", p.id, w.days);
    return c.json({ ok: true, days: w.days });
  })

  /** The opened project */
  .get("/:id", requirePermission("proj.view"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    return c.json(await viewFor(p, a));
  })

  /** Details, status, team: a status of done sets the completion day (cleared when reopened) */
  .patch("/:id", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const cur = await loadProj(c.req.param("id"));
    const p = await body(c, zProjectPatch);
    const clientId = p.clientId !== undefined ? p.clientId : cur.clientId;
    if (p.clientId) await clientExists(p.clientId);
    let contactId = cur.contactId;
    if (p.contactId !== undefined) {
      if (p.contactId && !(await contactBelongs(p.contactId, clientId))) throw new HTTPException(400, { message: "contact_invalid" });
      contactId = p.contactId;
    } else if (contactId && clientId !== cur.clientId && !(await contactBelongs(contactId, clientId))) {
      // the client changed: its contact is no longer one of its people
      contactId = null;
    }
    const startDate = p.startDate !== undefined ? p.startDate : cur.startDate;
    const dueDate = p.dueDate !== undefined ? p.dueDate : cur.dueDate;
    if (startDate && dueDate && dueDate < startDate) throw new HTTPException(400, { message: "dates" });
    const leadId = p.leadId !== undefined ? p.leadId : cur.leadId;
    if (p.leadId) await activeStaff([p.leadId]);
    const now = new Date();
    const set: Partial<typeof schema.projProjects.$inferInsert> = { updatedAt: now, clientId, contactId, leadId, startDate, dueDate };
    if (p.name !== undefined) set.name = p.name;
    if (p.status !== undefined) {
      set.status = p.status;
      set.doneAt = p.status === "done" ? (cur.doneAt ?? now) : null;
    }
    if (p.soldHours !== undefined) set.soldHoursX100 = x100Of(p.soldHours);
    if (p.description !== undefined) set.description = p.description;
    if (p.salesNotes !== undefined) set.salesNotes = p.salesNotes;
    const touchesBilling = p.billingMode !== undefined || p.contractId !== undefined || p.hourlyRate !== undefined || p.fixedPrice !== undefined || p.bankExpiresOn !== undefined || p.soldHours !== undefined || clientId !== cur.clientId;
    if (touchesBilling) {
      // the price sold already in Approbation is not moved from here
      if (cur.invoicedAt && (p.billingMode !== undefined || p.fixedPrice !== undefined || p.soldHours !== undefined)) throw new HTTPException(409, { message: "project_billed" });
      const next = {
        mode: p.billingMode ?? cur.billingMode,
        contractId: p.contractId !== undefined ? p.contractId : cur.contractId,
        hourlyRate: p.hourlyRate !== undefined ? p.hourlyRate : cur.hourlyRateCents == null ? null : cur.hourlyRateCents / 100,
        fixedPrice: p.fixedPrice !== undefined ? p.fixedPrice : cur.fixedPriceCents == null ? null : cur.fixedPriceCents / 100,
        bankExpiresOn: p.bankExpiresOn !== undefined ? p.bankExpiresOn : cur.bankExpiresOn,
        soldHours: p.soldHours !== undefined ? p.soldHours : cur.soldHoursX100 == null ? null : cur.soldHoursX100 / 100,
        clientId,
        startDate,
      };
      Object.assign(set, await billingColumns(next));
    }
    await db().update(schema.projProjects).set(set).where(eq(schema.projProjects.id, cur.id));
    // the team: the lead is always in it
    if (p.memberIds !== undefined) {
      const team = [...new Set([...p.memberIds, ...(leadId ? [leadId] : [])])];
      await activeStaff(team);
      await db().delete(schema.projMembers).where(eq(schema.projMembers.projectId, cur.id));
      if (team.length) await db().insert(schema.projMembers).values(team.map((userId) => ({ projectId: cur.id, userId })));
    } else if (leadId && leadId !== cur.leadId) {
      await db().insert(schema.projMembers).values({ projectId: cur.id, userId: leadId }).onConflictDoNothing();
    }
    await audit(a.user.id, "proj.updated", cur.id, { fields: Object.keys(p) });
    const fresh = await loadProj(cur.id);
    return c.json(await viewFor(fresh, a));
  })

  /** Deleting a project (administrators): its tasks, notes and timers go; the time stays on the timesheets */
  .delete("/:id", requirePermission("proj.manage"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    await db().delete(schema.projProjects).where(eq(schema.projProjects.id, p.id));
    await audit(a.user.id, "proj.deleted", p.id, { number: p.number, name: p.name });
    return c.json({ ok: true });
  })

  // ── tasks ──────────────────────────────────────────────────────────────

  /** A task, given to someone (the bell tells them); a closed project takes no new task */
  .post("/:id/tasks", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const t = await body(c, zTaskCreate);
    if (t.assigneeId) await activeStaff([t.assigneeId]);
    const [last] = await db()
      .select({ position: schema.projTasks.position })
      .from(schema.projTasks)
      .where(eq(schema.projTasks.projectId, p.id))
      .orderBy(desc(schema.projTasks.position))
      .limit(1);
    const [row] = await db()
      .insert(schema.projTasks)
      .values({
        projectId: p.id,
        title: t.title,
        description: t.description ?? "",
        priority: t.priority ?? "medium",
        status: "todo",
        assigneeId: t.assigneeId ?? null,
        dueDate: t.dueDate ?? null,
        position: last ? last.position + 1 : 0,
        createdBy: a.user.id,
      })
      .returning();
    await tellAssignee(p, row.assigneeId, a.user, row.title);
    await db().update(schema.projProjects).set({ updatedAt: new Date() }).where(eq(schema.projProjects.id, p.id));
    await audit(a.user.id, "proj.task_created", row.id, { project: p.number, title: row.title });
    return c.json((await taskViews([row]))[0], 201);
  })

  /** The order of the tasks: exactly this project's tasks, in the order given */
  .post("/:id/tasks/reorder", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const b = await body(c, z.object({ ids: zIds(500) }));
    const all = await db().select({ id: schema.projTasks.id }).from(schema.projTasks).where(eq(schema.projTasks.projectId, p.id));
    const mine = new Set(all.map((t) => t.id));
    if (b.ids.length !== all.length || new Set(b.ids).size !== b.ids.length || b.ids.some((id) => !mine.has(id))) {
      throw new HTTPException(400, { message: "task_invalid" });
    }
    for (const [i, id] of b.ids.entries()) await db().update(schema.projTasks).set({ position: i }).where(eq(schema.projTasks.id, id));
    await audit(a.user.id, "proj.tasks_reordered", p.id, { count: b.ids.length });
    return c.json({ ok: true });
  })

  /** One task with the notes that tag it and the time entries that covered it */
  .get("/:id/tasks/:tid", requirePermission("proj.view"), async (c) => {
    const p = await loadProj(c.req.param("id"));
    const t = await loadTask(p.id, c.req.param("tid"));
    const [task] = await taskViews([t]);
    const noteRows = await db()
      .select({ n: schema.projNotes })
      .from(schema.projNoteTasks)
      .innerJoin(schema.projNotes, eq(schema.projNotes.id, schema.projNoteTasks.noteId))
      .where(eq(schema.projNoteTasks.taskId, t.id))
      .orderBy(desc(schema.projNotes.createdAt))
      .limit(300);
    const timeRows = await db()
      .select({ e: schema.timesheetEntries, done: schema.projTimeTasks.done })
      .from(schema.projTimeTasks)
      .innerJoin(schema.timesheetEntries, eq(schema.timesheetEntries.id, schema.projTimeTasks.entryId))
      .where(eq(schema.projTimeTasks.taskId, t.id))
      .orderBy(desc(schema.timesheetEntries.date), desc(schema.timesheetEntries.createdAt));
    const doneOf = new Map(timeRows.map((r) => [r.e.id, r.done]));
    const time = (await timeViews(timeRows.map((r) => r.e))).map((v) => ({
      id: v.id,
      userId: v.userId,
      name: v.name,
      date: v.date,
      hours: v.hours,
      note: v.note,
      done: doneOf.get(v.id) ?? false,
    }));
    return c.json({ task, notes: await noteViews(noteRows.map((r) => r.n)), time });
  })

  /** A task changed. Done with a time entry (mine, on this project): the entry is linked and finished the task. */
  .patch("/:id/tasks/:tid", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const cur = await loadTask(p.id, c.req.param("tid"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const b = await body(c, zTaskPatch);
    if (b.assigneeId) await activeStaff([b.assigneeId]);
    if (b.entryId) needTimesheets(a);
    const entry = b.entryId ? await loadEntry(p.id, b.entryId) : null;
    if (entry && entry.userId !== a.user.id) throw new HTTPException(404, { message: "not_found" });
    const now = new Date();
    const status: TaskRow["status"] = entry ? "done" : (b.status ?? cur.status);
    const set: Partial<typeof schema.projTasks.$inferInsert> = { updatedAt: now };
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = b.description;
    if (b.priority !== undefined) set.priority = b.priority;
    if (b.assigneeId !== undefined) set.assigneeId = b.assigneeId;
    if (b.dueDate !== undefined) set.dueDate = b.dueDate;
    if (b.status !== undefined || entry) {
      set.status = status;
      set.doneAt = status === "done" ? (cur.doneAt ?? now) : null;
    }
    const [row] = await db().update(schema.projTasks).set(set).where(eq(schema.projTasks.id, cur.id)).returning();
    if (entry) {
      await db()
        .insert(schema.projTimeTasks)
        .values({ entryId: entry.id, taskId: cur.id, done: true })
        .onConflictDoUpdate({ target: [schema.projTimeTasks.entryId, schema.projTimeTasks.taskId], set: { done: true } });
    }
    if (b.assigneeId && b.assigneeId !== cur.assigneeId) await tellAssignee(p, b.assigneeId, a.user, row.title);
    await audit(a.user.id, "proj.task_updated", cur.id, { project: p.number, fields: Object.keys(b) });
    return c.json((await taskViews([row]))[0]);
  })

  /** A task removed: the time stays on the project, the notes stay, only the tag goes */
  .delete("/:id/tasks/:tid", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const cur = await loadTask(p.id, c.req.param("tid"));
    await db().delete(schema.projTasks).where(eq(schema.projTasks.id, cur.id));
    await audit(a.user.id, "proj.task_deleted", cur.id, { project: p.number, title: cur.title });
    return c.json({ ok: true });
  })

  // ── files (kept like a ticket's: sent with a note or a reply) ──────────

  /** A file added to the project, base64, 5 MB at most; it waits to go with the next note */
  .post("/:id/files", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const f = await body(c, z.object({ name: z.string().trim().min(1).max(200), contentType: z.string().max(100).optional(), data: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8) }));
    const size = Buffer.from(f.data, "base64").length;
    if (size < 1 || size > MAX_FILE_BYTES) throw new HTTPException(413, { message: "file_too_large" });
    const [row] = await db()
      .insert(schema.projFiles)
      .values({ projectId: p.id, name: f.name.replace(/[\\/\r\n]/g, "_"), contentType: f.contentType || "application/octet-stream", size, data: f.data, author: a.realUser.name })
      .returning({ id: schema.projFiles.id, name: schema.projFiles.name, size: schema.projFiles.size, contentType: schema.projFiles.contentType });
    await audit(a.user.id, "proj.file_added", p.id, { name: row.name, size });
    return c.json(row, 201);
  })

  /** A file: always a download, except a picture shown in the page (?inline=1: png, jpeg, gif, webp only) */
  .get("/:id/files/:fid", requirePermission("proj.view"), async (c) => {
    const p = await loadProj(c.req.param("id"));
    const fid = zUuid.safeParse(c.req.param("fid"));
    if (!fid.success) throw new HTTPException(404, { message: "not_found" });
    const [f] = await db().select().from(schema.projFiles).where(and(eq(schema.projFiles.id, fid.data), eq(schema.projFiles.projectId, p.id)));
    if (!f) throw new HTTPException(404, { message: "not_found" });
    const inline = c.req.query("inline") === "1" && /^image\/(png|jpeg|gif|webp)$/.test(f.contentType);
    const type = inline ? f.contentType : "application/octet-stream";
    return new Response(Buffer.from(f.data, "base64"), {
      headers: {
        "content-type": type,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  })

  /** A file removed (one not sent yet: its person; one on a note: whoever manages projects) */
  .delete("/:id/files/:fid", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const fid = zUuid.safeParse(c.req.param("fid"));
    if (!fid.success) throw new HTTPException(404, { message: "not_found" });
    const [f] = await db().select().from(schema.projFiles).where(and(eq(schema.projFiles.id, fid.data), eq(schema.projFiles.projectId, p.id)));
    if (!f) throw new HTTPException(404, { message: "not_found" });
    if (f.noteId && !isManager(a)) throw new HTTPException(403, { message: "forbidden" });
    await db().delete(schema.projFiles).where(eq(schema.projFiles.id, f.id));
    await audit(a.user.id, "proj.file_deleted", p.id, { name: f.name });
    return c.json({ ok: true });
  })

  // ── billing ────────────────────────────────────────────────────────────

  /** The price sold (fixed price or bank of hours) goes to Approbation, once, as a pending line */
  .post("/:id/bill", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("accounting.manage")) throw new HTTPException(403, { message: "forbidden" });
    const p = await loadProj(c.req.param("id"));
    try {
      const r = await billProj(p.id);
      await syncBillablesNow();
      await audit(a.user.id, "proj.billed", p.id, { number: p.number, total: r.totalCents });
      return c.json({ ...r, billing: await projBilling(p.id) });
    } catch (e) {
      if (e instanceof ProjBillError) throw new HTTPException(409, { message: e.message });
      throw e;
    }
  })

  /** Where the project's sale stands in Approbation / on invoices */
  .get("/:id/billing", requirePermission("proj.view"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("accounting.view")) return c.json([]);
    const p = await loadProj(c.req.param("id"));
    return c.json(await projBilling(p.id));
  })

  // ── notes ──────────────────────────────────────────────────────────────

  /** A note on the project, optionally tagging tasks. Internal by default; internal false + email true = a reply emailed to `to`. */
  .post("/:id/notes", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const n = await body(c, zNote);
    const internal = n.internal ?? true;
    const taskIds = [...new Set(n.taskIds ?? [])];
    if (taskIds.length) await tasksIn(p.id, taskIds);
    const to = [...new Set(n.to ?? [])];
    const mail = !internal && Boolean(n.email);
    if (mail) {
      if (!p.clientId) throw new HTTPException(409, { message: "project_no_client" });
      if (!to.length) throw new HTTPException(400, { message: "reply_needs_recipient" });
      // 30 messages an hour per person: every recipient counts
      for (let i = 0; i < to.length; i++) if (!rateLimit(`proj-mail:${a.user.id}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    }
    let sent: string[] = [];
    let failed: string[] = [];
    const attachmentIds = [...new Set(n.attachmentIds ?? [])];
    const files = await pendingFiles(p.id, attachmentIds);
    if (mail) {
      const r = await sendClientReply(p, { name: a.realUser.name, email: a.realUser.email }, n.text, to, files.map((f) => ({ filename: f.name, content: Buffer.from(f.data, "base64"), contentType: f.contentType })));
      sent = r.sent;
      failed = r.failed;
      await audit(a.user.id, sent.length ? "proj.reply_emailed" : "proj.reply_email_failed", p.id, { to: sent.length ? sent : failed });
    }
    const [row] = await db()
      .insert(schema.projNotes)
      .values({ projectId: p.id, authorId: a.user.id, text: n.text, internal, emailedTo: sent })
      .returning();
    if (taskIds.length) await db().insert(schema.projNoteTasks).values(taskIds.map((taskId) => ({ noteId: row.id, taskId })));
    await takeFiles(p.id, attachmentIds, row.id);
    await db().update(schema.projProjects).set({ updatedAt: new Date() }).where(eq(schema.projProjects.id, p.id));
    await audit(a.user.id, "proj.note_added", row.id, { project: p.number, internal, tasks: taskIds.length });
    const [view] = await noteViews([row]);
    return c.json({ ...view, emailed: sent, failed }, 201);
  })

  /** A note removed: its author, or whoever manages projects */
  .delete("/:id/notes/:nid", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const cur = await loadNote(p.id, c.req.param("nid"));
    if (cur.authorId !== a.user.id && !isManager(a)) throw new HTTPException(403, { message: "forbidden" });
    await db().delete(schema.projNotes).where(eq(schema.projNotes.id, cur.id));
    await audit(a.user.id, "proj.note_deleted", cur.id, { project: p.number });
    return c.json({ ok: true });
  })

  // ── time ───────────────────────────────────────────────────────────────

  /** All the time on the project, newest first */
  .get("/:id/time", requirePermission("proj.view"), async (c) => {
    const p = await loadProj(c.req.param("id"));
    return c.json(await timeViews(await entriesOf(p.id, { limit: 200 })));
  })

  /** My time on the project, the last 45 days (for "which time entry?") */
  .get("/:id/time/mine", requirePermission("proj.view"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    return c.json(await timeViews(await entriesOf(p.id, { userId: a.user.id, from: addDays(todayQc(), -45), limit: 200 })));
  })

  /** Time logged on my timesheet for this project; the tasks it covered are linked, the ones it finished are done */
  .post("/:id/time", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    needTimesheets(a);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const t = await body(c, zTime);
    const taskIds = t.taskIds ?? [];
    const doneTaskIds = t.doneTaskIds ?? [];
    await tasksIn(p.id, [...taskIds, ...doneTaskIds]);
    const r = await addEntry(p, a.user.id, { date: t.date ?? todayQc(), hours: t.hours, note: t.note, billable: t.billable, taskIds, doneTaskIds });
    await audit(a.user.id, "proj.time_added", r.id, { project: p.number, hours: t.hours });
    return c.json(r, 201);
  })

  /** The tasks of one of my entries (or, with proj.manage, anyone's): the list given replaces the links */
  .put("/:id/time/:eid/tasks", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const e = await loadEntry(p.id, c.req.param("eid"));
    if (e.userId !== a.user.id && !isManager(a)) throw new HTTPException(403, { message: "forbidden" });
    if (!isManager(a)) {
      needTimesheets(a);
      // a week already sent is not changed
      if (!editable((await sheetOf(e.userId, weekStartOf(e.date))).status)) throw new HTTPException(409, { message: "timesheet_locked" });
    }
    const b = await body(c, z.object({ taskIds: zIds(60), doneTaskIds: zIds(60).optional() }));
    const doneIds = [...new Set(b.doneTaskIds ?? [])];
    const ids = [...new Set([...b.taskIds, ...doneIds])];
    await tasksIn(p.id, ids);
    const done = new Set(doneIds);
    await db().delete(schema.projTimeTasks).where(eq(schema.projTimeTasks.entryId, e.id));
    if (ids.length) await db().insert(schema.projTimeTasks).values(ids.map((taskId) => ({ entryId: e.id, taskId, done: done.has(taskId) })));
    await markDone(doneIds);
    await audit(a.user.id, "proj.time_tasks_set", e.id, { project: p.number, tasks: ids.length });
    return c.json({ ok: true, taskIds: ids, doneTaskIds: doneIds });
  })

  /** An entry removed: mine in an open week, or anyone's with proj.manage (the hours go off the timesheet) */
  .delete("/:id/time/:eid", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const e = await loadEntry(p.id, c.req.param("eid"));
    if (!isManager(a)) {
      needTimesheets(a);
      if (e.userId !== a.user.id) throw new HTTPException(403, { message: "forbidden" });
      const sheet = await sheetOf(e.userId, weekStartOf(e.date));
      if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    }
    await db().delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, e.id));
    await refreshAccrual(e.userId, weekStartOf(e.date));
    if (e.userId !== a.user.id) await audit(a.user.id, "proj.time_removed_for", e.userId, { project: p.number, date: e.date });
    else await audit(a.user.id, "proj.time_removed", e.id, { project: p.number, date: e.date });
    return c.json({ ok: true });
  })

  // ── timer (one per person per project) ─────────────────────────────────

  .get("/:id/timer", requirePermission("proj.view"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    const t = await timerOf(p.id, a.user.id);
    return c.json(t ? timerView(t) : null);
  })

  /** Starts my timer on the project (already running: the same timer) */
  .post("/:id/timer/start", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    needTimesheets(a);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const existing = await timerOf(p.id, a.user.id);
    if (existing) return c.json(timerView(existing));
    const [row] = await db()
      .insert(schema.projTimers)
      .values({ projectId: p.id, userId: a.user.id, startedAt: new Date(), baseSeconds: 0, pausedAt: null })
      .onConflictDoNothing()
      .returning();
    return c.json(timerView(row ?? (await requireTimer(p.id, a.user.id))));
  })

  .post("/:id/timer/pause", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const t = await requireTimer(p.id, a.user.id);
    if (t.pausedAt) return c.json(timerView(t));
    const [row] = await db()
      .update(schema.projTimers)
      .set({ baseSeconds: timerSeconds(t), pausedAt: new Date() })
      .where(and(eq(schema.projTimers.projectId, p.id), eq(schema.projTimers.userId, a.user.id)))
      .returning();
    return c.json(timerView(row));
  })

  .post("/:id/timer/resume", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const t = await requireTimer(p.id, a.user.id);
    if (!t.pausedAt) return c.json(timerView(t));
    const [row] = await db()
      .update(schema.projTimers)
      .set({ startedAt: new Date(), pausedAt: null })
      .where(and(eq(schema.projTimers.projectId, p.id), eq(schema.projTimers.userId, a.user.id)))
      .returning();
    return c.json(timerView(row));
  })

  /** Stops my timer and makes the time entry (hours: typed, else the time counted up to the quarter hour) */
  .post("/:id/timer/stop", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    needTimesheets(a);
    const p = await loadProj(c.req.param("id"));
    if (isClosed(p)) throw new HTTPException(409, { message: "project_closed" });
    const s = await body(c, zStop);
    const taskIds = s.taskIds ?? [];
    const doneTaskIds = s.doneTaskIds ?? [];
    await tasksIn(p.id, [...taskIds, ...doneTaskIds]);
    // the timer is claimed first (a second click finds none), and put back if the entry cannot be made
    const [t] = await db().delete(schema.projTimers).where(and(eq(schema.projTimers.projectId, p.id), eq(schema.projTimers.userId, a.user.id))).returning();
    if (!t) throw new HTTPException(404, { message: "timer_not_found" });
    const hours = s.hours ?? Math.min(24, hoursFromSeconds(timerSeconds(t)));
    let r: { id: string };
    try {
      r = await addEntry(p, a.user.id, { date: s.date ?? todayQc(), hours, note: s.note, billable: s.billable, taskIds, doneTaskIds });
    } catch (err) {
      await db().insert(schema.projTimers).values(t).onConflictDoNothing();
      throw err;
    }
    await audit(a.user.id, "proj.timer_stopped", r.id, { project: p.number, hours });
    return c.json(r, 201);
  })

  /** Throws my timer away (no time entry) */
  .post("/:id/timer/discard", requirePermission("proj.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProj(c.req.param("id"));
    await db().delete(schema.projTimers).where(and(eq(schema.projTimers.projectId, p.id), eq(schema.projTimers.userId, a.user.id)));
    return c.json({ ok: true });
  });

export type ProjRoutes = typeof projRoutes;
