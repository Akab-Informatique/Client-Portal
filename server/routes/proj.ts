import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notify } from "../lib/notify.ts";
import { rateLimit } from "../lib/http.ts";
import { refreshAccrual } from "../lib/hr.ts";
import { addDays, editable, sheetOf, todayQc, weekStartOf } from "../lib/timesheets.ts";
import { listQuotes } from "../lib/quotes.ts";
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

const zProjectCreate = z.object({
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
    const row = await insertProject({
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
    await audit(a.user.id, "proj.created", row.id, { number: row.number, name: row.name, quote: p.quoteId ?? null });
    return c.json(await viewFor(row, a), 201);
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
    if (mail) {
      const r = await sendClientReply(p, { name: a.realUser.name, email: a.realUser.email }, n.text, to);
      sent = r.sent;
      failed = r.failed;
      await audit(a.user.id, sent.length ? "proj.reply_emailed" : "proj.reply_email_failed", p.id, { to: sent.length ? sent : failed });
    }
    const [row] = await db()
      .insert(schema.projNotes)
      .values({ projectId: p.id, authorId: a.user.id, text: n.text, internal, emailedTo: sent })
      .returning();
    if (taskIds.length) await db().insert(schema.projNoteTasks).values(taskIds.map((taskId) => ({ noteId: row.id, taskId })));
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
