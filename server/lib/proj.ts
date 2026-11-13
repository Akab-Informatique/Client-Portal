import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";
import { getQuote } from "./quotes.ts";
import { escapeHtml, sendMail } from "./mail.ts";
import { labourType, editable, sheetOf, weekStartOf } from "./timesheets.ts";
import { splitBillable } from "./hr.ts";
import { zUuid } from "./validate.ts";
import { watchOf } from "./watch.ts";
import type { ProjQuoteSnapshot } from "../db/schema.ts";

/**
 * New-format projects (Centre de commande › Projets, proj_*): the shapes the screens read, numbering, the timers and the
 * time entries of a project, and the reply emailed to the client. The routes (server/routes/proj.ts) do the checks.
 */

export type ProjRow = typeof schema.projProjects.$inferSelect;
export type TaskRow = typeof schema.projTasks.$inferSelect;
export type NoteRow = typeof schema.projNotes.$inferSelect;
export type EntryRow = typeof schema.timesheetEntries.$inferSelect;

export type Ref = { id: string; name: string };

export type ProjectView = {
  id: string;
  number: string;
  name: string;
  status: string;
  client: Ref | null;
  lead: Ref | null;
  startDate: string | null;
  dueDate: string | null;
  soldHours: number | null;
  billingMode: string;
  workedHours: number;
  taskTotal: number;
  taskDone: number;
  memberIds: string[];
  updatedAt: string;
  stale?: boolean;
  watchDays?: number;
  watchOwn?: number | null;
};

export type TaskView = {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assignee: Ref | null;
  dueDate: string | null;
  position: number;
  doneAt: string | null;
};

export type NoteView = {
  id: string;
  text: string;
  internal: boolean;
  author: Ref | null;
  createdAt: string;
  emailedTo: string[];
  tasks: { id: string; title: string }[];
  files: { id: string; name: string; size: number; contentType: string }[];
};

export type TimeView = {
  id: string;
  userId: string;
  name: string;
  date: string;
  hours: number;
  note: string | null;
  billable: boolean;
  taskIds: string[];
};

export type TimerRow = typeof schema.projTimers.$inferSelect;
export type TimerView = { startedAt: string; baseSeconds: number; paused: boolean; seconds: number };

/** A project that is over: no more tasks, time or timers on it */
export const isClosed = (p: { status: string }) => p.status === "done" || p.status === "cancelled";

/** Hours kept in hundredths → hours (2 decimals) */
export const hoursOf = (x100: number) => Math.round(x100) / 100;

/** Hours typed (decimal) kept in hundredths; none = none */
export const x100Of = (h: number | null | undefined): number | null => (h == null ? null : Math.round(h * 100));

/** The day a project is listed under when it is closed (done or cancelled) */
export const CLOSED_STATUSES = ["done", "cancelled"] as const;

export async function loadProj(id: string | undefined): Promise<ProjRow> {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [p] = await db().select().from(schema.projProjects).where(eq(schema.projProjects.id, r.data));
  if (!p) throw new HTTPException(404, { message: "not_found" });
  return p;
}

/** A task of THIS project, or 404 (a task of another project is not found) */
export async function loadTask(projectId: string, tid: string | undefined): Promise<TaskRow> {
  const r = zUuid.safeParse(tid);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [t] = await db()
    .select()
    .from(schema.projTasks)
    .where(and(eq(schema.projTasks.id, r.data), eq(schema.projTasks.projectId, projectId)));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  return t;
}

/** A note of THIS project, or 404 */
export async function loadNote(projectId: string, nid: string | undefined): Promise<NoteRow> {
  const r = zUuid.safeParse(nid);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [n] = await db()
    .select()
    .from(schema.projNotes)
    .where(and(eq(schema.projNotes.id, r.data), eq(schema.projNotes.projectId, projectId)));
  if (!n) throw new HTTPException(404, { message: "not_found" });
  return n;
}

/** A time entry of THIS project, or 404 */
export async function loadEntry(projectId: string, eid: string | undefined): Promise<EntryRow> {
  const r = zUuid.safeParse(eid);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [e] = await db()
    .select()
    .from(schema.timesheetEntries)
    .where(and(eq(schema.timesheetEntries.id, r.data), eq(schema.timesheetEntries.projId, projectId)));
  if (!e) throw new HTTPException(404, { message: "not_found" });
  return e;
}

/** Several tasks of THIS project; any id that is not one of them answers 400 */
export async function tasksIn(projectId: string, ids: string[]): Promise<TaskRow[]> {
  const want = [...new Set(ids)];
  if (!want.length) return [];
  const rows = await db()
    .select()
    .from(schema.projTasks)
    .where(and(inArray(schema.projTasks.id, want), eq(schema.projTasks.projectId, projectId)));
  if (rows.length !== want.length) throw new HTTPException(400, { message: "task_invalid" });
  return rows;
}

/** Names of users by id (a missing one has no entry) */
export async function namesOf(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map();
  const rows = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Active staff only: a lead, a member or an assignee is someone who can sign in (400 otherwise) */
export async function activeStaff(ids: string[]): Promise<void> {
  const want = [...new Set(ids)];
  if (!want.length) return;
  const rows = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.id, want), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (rows.length !== want.length) throw new HTTPException(400, { message: "person_invalid" });
}

/** The highest number used by the archive (projects) or the new format (proj_projects), never below 1001 */
export async function highestNumber(): Promise<number> {
  const [old, now] = await Promise.all([
    db().select({ n: schema.projects.number }).from(schema.projects),
    db().select({ n: schema.projProjects.number }).from(schema.projProjects),
  ]);
  return [...old, ...now].reduce((m, r) => Math.max(m, Number(r.n.replace(/\D/g, "")) || 0), 1000);
}

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = (e as { message?: unknown } | null)?.message;
  return code === "23505" || (typeof msg === "string" && /unique|duplicate/i.test(msg));
}

/** Inserts a project with the next number (P-1011…); a number taken meanwhile is tried again */
export async function insertProject(values: Omit<typeof schema.projProjects.$inferInsert, "number">): Promise<ProjRow> {
  for (let i = 0; i < 5; i++) {
    const number = `P-${(await highestNumber()) + 1}`;
    try {
      const [row] = await db().insert(schema.projProjects).values({ ...values, number }).returning();
      return row;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new HTTPException(409, { message: "number_taken" });
}

/** Seconds counted by a timer: the base, plus the run since the last start unless it is paused */
export function timerSeconds(t: { startedAt: Date; baseSeconds: number; pausedAt: Date | null }, now = Date.now()): number {
  return t.baseSeconds + (t.pausedAt ? 0 : Math.max(0, Math.floor((now - t.startedAt.getTime()) / 1000)));
}

export function timerView(t: { startedAt: Date; baseSeconds: number; pausedAt: Date | null }): TimerView {
  return { startedAt: t.startedAt.toISOString(), baseSeconds: t.baseSeconds, paused: t.pausedAt !== null, seconds: timerSeconds(t) };
}

/** Hours for a timer that is stopped without hours typed: the seconds counted, up to the quarter hour, at least a quarter */
export function hoursFromSeconds(seconds: number): number {
  return Math.max(0.25, Math.ceil(seconds / 900) * 0.25);
}

/** The figures of each project: client, lead, team, hours worked, tasks done */
export async function projectViews(rows: ProjRow[]): Promise<ProjectView[]> {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const clientIds = rows.map((r) => r.clientId).filter((x): x is string => Boolean(x));
  const [clients, names, members, tasks, hours] = await Promise.all([
    clientIds.length ? d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, clientIds)) : Promise.resolve([]),
    namesOf(rows.map((r) => r.leadId)),
    d.select({ projectId: schema.projMembers.projectId, userId: schema.projMembers.userId }).from(schema.projMembers).where(inArray(schema.projMembers.projectId, ids)),
    d.select({ projectId: schema.projTasks.projectId, status: schema.projTasks.status, updatedAt: schema.projTasks.updatedAt }).from(schema.projTasks).where(inArray(schema.projTasks.projectId, ids)),
    d
      .select({ projectId: schema.timesheetEntries.projId, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
      .from(schema.timesheetEntries)
      .where(inArray(schema.timesheetEntries.projId, ids))
      .groupBy(schema.timesheetEntries.projId),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  // the last activity: the project's own (notes, time, edits) or a task's
  const quiet = await watchOf(
    "proj",
    rows.map((p) => {
      const lastTask = tasks.filter((t) => t.projectId === p.id).reduce<Date>((m, t) => (t.updatedAt > m ? t.updatedAt : m), p.updatedAt);
      return { id: p.id, due: p.dueDate, activityAt: lastTask, open: p.status === "planning" || p.status === "active" };
    }),
  );
  return rows.map((p) => {
    const worked = hours.find((h) => h.projectId === p.id)?.h ?? 0;
    const mine = tasks.filter((t) => t.projectId === p.id);
    const lead = p.leadId ? { id: p.leadId, name: names.get(p.leadId) ?? "" } : null;
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      status: p.status,
      client: p.clientId && clientName.has(p.clientId) ? { id: p.clientId, name: clientName.get(p.clientId)! } : null,
      lead,
      startDate: p.startDate,
      dueDate: p.dueDate,
      soldHours: p.soldHoursX100 == null ? null : hoursOf(p.soldHoursX100),
      billingMode: p.billingMode,
      workedHours: hoursOf(Number(worked)),
      taskTotal: mine.length,
      taskDone: mine.filter((t) => t.status === "done").length,
      memberIds: members.filter((m) => m.projectId === p.id).map((m) => m.userId),
      updatedAt: p.updatedAt.toISOString(),
      ...quiet.get(p.id),
    };
  });
}

export async function taskViews(rows: TaskRow[]): Promise<TaskView[]> {
  const names = await namesOf(rows.map((t) => t.assigneeId));
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    assignee: t.assigneeId ? { id: t.assigneeId, name: names.get(t.assigneeId) ?? "" } : null,
    dueDate: t.dueDate,
    position: t.position,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
  }));
}

/** Notes with their author and the tasks each one tags (the order of the rows is kept) */
export async function noteViews(rows: NoteRow[]): Promise<NoteView[]> {
  if (!rows.length) return [];
  const [names, files, tags] = await Promise.all([
    namesOf(rows.map((n) => n.authorId)),
    db()
      .select({ id: schema.projFiles.id, noteId: schema.projFiles.noteId, name: schema.projFiles.name, size: schema.projFiles.size, contentType: schema.projFiles.contentType })
      .from(schema.projFiles)
      .where(inArray(schema.projFiles.noteId, rows.map((n) => n.id))),
    db()
      .select({ noteId: schema.projNoteTasks.noteId, id: schema.projTasks.id, title: schema.projTasks.title })
      .from(schema.projNoteTasks)
      .innerJoin(schema.projTasks, eq(schema.projTasks.id, schema.projNoteTasks.taskId))
      .where(inArray(schema.projNoteTasks.noteId, rows.map((n) => n.id))),
  ]);
  return rows.map((n) => ({
    id: n.id,
    text: n.text,
    internal: n.internal,
    author: n.authorId ? { id: n.authorId, name: names.get(n.authorId) ?? "" } : null,
    createdAt: n.createdAt.toISOString(),
    emailedTo: n.emailedTo ?? [],
    tasks: tags.filter((t) => t.noteId === n.id).map((t) => ({ id: t.id, title: t.title })),
    files: files.filter((f) => f.noteId === n.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })),
  }));
}

/** Time entries with the tasks each one covered */
export async function timeViews(rows: EntryRow[]): Promise<TimeView[]> {
  if (!rows.length) return [];
  const [names, links] = await Promise.all([
    namesOf(rows.map((e) => e.userId)),
    db().select().from(schema.projTimeTasks).where(inArray(schema.projTimeTasks.entryId, rows.map((e) => e.id))),
  ]);
  return rows.map((e) => ({
    id: e.id,
    userId: e.userId,
    name: names.get(e.userId) ?? "",
    date: e.date,
    hours: hoursOf(e.hoursX100),
    note: e.note,
    billable: (e.billableX100 ?? e.hoursX100) > 0,
    taskIds: links.filter((l) => l.entryId === e.id).map((l) => l.taskId),
  }));
}

/** Time entries of a project, newest first (`from`: only the days from then on) */
export async function entriesOf(projectId: string, opts: { userId?: string; from?: string; limit: number }): Promise<EntryRow[]> {
  const conds = [eq(schema.timesheetEntries.projId, projectId)];
  if (opts.userId) conds.push(eq(schema.timesheetEntries.userId, opts.userId));
  if (opts.from) conds.push(sql`${schema.timesheetEntries.date} >= ${opts.from}`);
  return db()
    .select()
    .from(schema.timesheetEntries)
    .where(and(...conds))
    .orderBy(desc(schema.timesheetEntries.date), desc(schema.timesheetEntries.createdAt))
    .limit(opts.limit);
}

/** The full opened project (the Detail shape), as seen by `me` */
export async function detailOf(p: ProjRow, me: string, canManage: boolean) {
  const d = db();
  const [view] = await projectViews([p]);
  const [contact, members, taskRows, noteRows, byPerson, timer] = await Promise.all([
    p.contactId
      ? d.select({ id: schema.clientContacts.id, firstName: schema.clientContacts.firstName, lastName: schema.clientContacts.lastName }).from(schema.clientContacts).where(eq(schema.clientContacts.id, p.contactId))
      : Promise.resolve([]),
    d.select({ userId: schema.projMembers.userId }).from(schema.projMembers).where(eq(schema.projMembers.projectId, p.id)),
    d.select().from(schema.projTasks).where(eq(schema.projTasks.projectId, p.id)).orderBy(asc(schema.projTasks.position), asc(schema.projTasks.createdAt)),
    d.select().from(schema.projNotes).where(eq(schema.projNotes.projectId, p.id)).orderBy(desc(schema.projNotes.createdAt)).limit(300),
    d
      .select({ userId: schema.timesheetEntries.userId, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
      .from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.projId, p.id))
      .groupBy(schema.timesheetEntries.userId),
    d.select().from(schema.projTimers).where(and(eq(schema.projTimers.projectId, p.id), eq(schema.projTimers.userId, me))),
  ]);
  const memberIds = members.map((m) => m.userId);
  const names = await namesOf([...memberIds, ...byPerson.map((b) => b.userId)]);
  const c = contact[0];
  return {
    ...view,
    description: p.description,
    salesNotes: p.salesNotes,
    contact: c ? { id: c.id, name: `${c.firstName} ${c.lastName}`.trim() } : null,
    members: memberIds.map((id) => ({ id, name: names.get(id) ?? "" })),
    quote: p.quoteSnapshot ?? null,
    quoteId: p.quoteId,
    billing: {
      mode: p.billingMode,
      contractId: p.contractId,
      hourlyRate: p.hourlyRateCents == null ? null : p.hourlyRateCents / 100,
      fixedPrice: p.fixedPriceCents == null ? null : p.fixedPriceCents / 100,
      bankExpiresOn: p.bankExpiresOn,
      billedAt: p.invoicedAt ? p.invoicedAt.toISOString() : null,
    },
    tasks: await taskViews(taskRows),
    notes: await noteViews(noteRows),
    worked: {
      hours: view.workedHours,
      byPerson: byPerson
        .map((b) => ({ userId: b.userId, name: names.get(b.userId) ?? "", hours: hoursOf(Number(b.h)) }))
        .sort((a, b) => b.hours - a.hours),
    },
    timer: timer[0] ? timerView(timer[0]) : null,
    canManage,
  };
}

/** The quote a project is made from, as plain data (no costs or margins) */
export async function snapshotOf(quoteId: string) {
  const q = await getQuote(quoteId);
  if (!q) throw new HTTPException(400, { message: "quote_invalid" });
  const snapshot: ProjQuoteSnapshot = {
    number: q.number,
    title: q.title,
    status: q.status,
    totalCents: q.totals.totalCents,
    lines: (q.lines ?? []).slice(0, 200).map((l) => ({
      description: l.description,
      details: l.details ?? null,
      quantityX100: l.quantityX100,
      unitPriceCents: Number(l.unitPriceCents),
      recurrence: l.recurrence,
      optional: l.optional,
    })),
    notes: q.notes ?? null,
  };
  return { snapshot, clientId: q.clientId ?? null, internalNotes: q.internalNotes ?? null };
}

/**
 * A time entry on MY timesheet for a project (labour, source project): the week must be open (409 timesheet_locked).
 * Billable unless asked otherwise; the tasks it covered are linked, and the ones it finished are set done.
 */
export async function addEntry(
  p: ProjRow,
  userId: string,
  o: { date: string; hours: number; note?: string | null; billable?: boolean; taskIds: string[]; doneTaskIds: string[] },
): Promise<{ id: string }> {
  const d = db();
  const sheet = await sheetOf(userId, weekStartOf(o.date));
  if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
  const type = await labourType();
  const hoursX100 = Math.round(o.hours * 100);
  // at least a hundredth of an hour, and never more than 24 h a day in all
  if (hoursX100 < 1) throw new HTTPException(400, { message: "hours_invalid" });
  const [{ total }] = await d
    .select({ total: sql<number>`coalesce(sum(${schema.timesheetEntries.hoursX100}), 0)::int` })
    .from(schema.timesheetEntries)
    .where(and(eq(schema.timesheetEntries.userId, userId), eq(schema.timesheetEntries.date, o.date)));
  if (total + hoursX100 > 2400) throw new HTTPException(409, { message: "day_over_24" });
  // a project sold as a package (fixed price, bank of hours) starts its entries included; each entry can be switched
  const billable = o.billable ?? !(p.billingMode === "fixed" || p.billingMode === "bank");
  const [row] = await d
    .insert(schema.timesheetEntries)
    .values({
      userId,
      date: o.date,
      typeId: type.id,
      hoursX100,
      note: o.note || null,
      ticketNumber: p.number,
      ticketTitle: p.name.slice(0, 250),
      projId: p.id,
      ...splitBillable(hoursX100, billable ? hoursX100 : 0),
      clientId: p.clientId,
      source: "project",
    })
    .returning();
  const all = [...new Set([...o.taskIds, ...o.doneTaskIds])];
  const done = new Set(o.doneTaskIds);
  if (all.length) {
    await d
      .insert(schema.projTimeTasks)
      .values(all.map((taskId) => ({ entryId: row.id, taskId, done: done.has(taskId) })))
      .onConflictDoNothing();
    await markDone(o.doneTaskIds);
  }
  await d.update(schema.projProjects).set({ updatedAt: new Date() }).where(eq(schema.projProjects.id, p.id));
  return { id: row.id };
}

/** Sets tasks done (the ones not done yet get their completion day) */
export async function markDone(taskIds: string[]): Promise<void> {
  if (!taskIds.length) return;
  const now = new Date();
  await db()
    .update(schema.projTasks)
    .set({ status: "done", doneAt: now, updatedAt: now })
    .where(and(inArray(schema.projTasks.id, taskIds), sql`${schema.projTasks.status} <> 'done'`));
}

/** Writes the reply to the client: one message each, from the technician's address as Reply-To. Never throws. */
export async function sendClientReply(
  p: ProjRow,
  sender: { name: string; email: string },
  text: string,
  to: string[],
  attachments: { filename: string; content: Buffer; contentType?: string }[] = [],
): Promise<{ sent: string[]; failed: string[] }> {
  const subject = `[${p.number}] ${p.name}`.slice(0, 250);
  const plain = ["Bonjour,", "", text, "", "—", `${sender.name}`, "AKAB Informatique"].join("\n");
  const html = `<p>Bonjour,</p><p style="white-space:pre-wrap">${escapeHtml(text)}</p><p>—<br>${escapeHtml(sender.name)}<br>AKAB Informatique</p><p style="color:#777;font-size:12px">${escapeHtml(p.number)} · ${escapeHtml(p.name)}</p>`;
  const sent: string[] = [];
  const failed: string[] = [];
  for (const addr of to) {
    let ok = false;
    try {
      ok = await sendMail({ to: addr, subject, text: plain, html, replyTo: sender.email, ...(attachments.length ? { attachments } : {}) });
    } catch {
      ok = false;
    }
    (ok ? sent : failed).push(addr);
  }
  return { sent, failed };
}
