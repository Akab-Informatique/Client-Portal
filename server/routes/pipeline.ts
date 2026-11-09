import { Hono } from "hono";
import { cleanDirection } from "../lib/aiDirection.ts";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { aiSettings } from "../lib/ai.ts";
import { rateLimit } from "../lib/http.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { calendarOfDay, buildPipelineView, maskPhone, morningRun, phoneOf, PipelineError, pipelineSettings, planOf, buildPlan, savePipelineSettings, sendTestSms, type PipelineSettings, resetDailyTasks, resetDayAdds, allocOf, dayItems } from "../lib/pipeline.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { todayQc } from "../lib/timesheets.ts";
import { notifyTechs } from "../lib/techNotify.ts";

/** An item of this task, or 400 */
async function itemOf(taskId: string, itemId: string) {
  const [it] = await db().select().from(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.id, itemId), eq(schema.pipelineChecklist.taskId, taskId)));
  if (!it) throw new HTTPException(400, { message: "item_invalid" });
  return it;
}
import { body, zUuid } from "../lib/validate.ts";
import { nextAfter, type Recurrence } from "../../shared/recurrence.ts";
import { assignedTo, coAssignees, isAssigned, setAssignees } from "../lib/pipelineAssign.ts";

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zHm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zStatus = z.enum(["todo", "doing", "blocked", "done"]);
const zPriority = z.enum(["low", "normal", "high", "urgent"]);
const zTitle = z.string().trim().min(1).max(200);
const zNotes = z.string().trim().max(8000);
const zMinutes = z.number().int().min(5).max(24 * 60);
const zKind = z.enum(["normal", "continuous", "daily"]);
const zRemind = z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]);
const zVisibility = z.enum(["team", "private", "selected"]);
const zTags = z.array(z.string().trim().min(1).max(30)).max(8);
const zRecurrence = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(365).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  until: zDate.nullable().optional(),
});
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;

type Task = typeof schema.pipelineTasks.$inferSelect;

/**
 * Who sees a task: everyone when it is a team task; otherwise the one who made it, the one it is assigned to,
 * and (when "selected") the people chosen. Not even a manager sees a private one.
 */
const seenBy = (userId: string) =>
  sql<boolean>`(${schema.pipelineTasks.visibility} = 'team' or ${schema.pipelineTasks.createdBy} = ${userId} or ${assignedTo(userId)} or (${schema.pipelineTasks.visibility} = 'selected' and exists (select 1 from pipeline_task_viewers v where v.task_id = ${schema.pipelineTasks.id} and v.user_id = ${userId})))`;

/** Whose day it is about: one's own, or (pipeline.manage) another active staff member's. */
async function dayTarget(a: ReturnType<typeof auth>, asked?: string | null): Promise<string> {
  if (!asked || asked === a.user.id) return a.user.id;
  if (!a.permissions.includes("pipeline.manage")) throw new HTTPException(403, { message: "forbidden" });
  const id = zUuid.parse(asked);
  const [u] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new HTTPException(400, { message: "person_invalid" });
  return id;
}

/** Tasks shaped for the screen: names, checklist progress, subtasks, and whether it is waiting on another task. */
async function cards(rows: Task[], viewerId: string) {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const co = await coAssignees(ids);
  const [people, checks, kids, parents, waiting, fileRows] = await Promise.all([
    d.select({ id: schema.users.id, name: schema.users.name }).from(schema.users),
    d
      .select({ taskId: schema.pipelineChecklist.taskId, done: schema.pipelineChecklist.done, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.pipelineChecklist)
      .where(inArray(schema.pipelineChecklist.taskId, ids))
      .groupBy(schema.pipelineChecklist.taskId, schema.pipelineChecklist.done),
    d
      .select({ parentId: schema.pipelineTasks.parentId, status: schema.pipelineTasks.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.pipelineTasks)
      .where(inArray(schema.pipelineTasks.parentId, ids))
      .groupBy(schema.pipelineTasks.parentId, schema.pipelineTasks.status),
    // a parent or a task waited for that this viewer may not see shows no title
    d.select({ id: schema.pipelineTasks.id, title: schema.pipelineTasks.title, seen: seenBy(viewerId) }).from(schema.pipelineTasks).where(inArray(schema.pipelineTasks.id, rows.map((r) => r.parentId).filter((x): x is string => Boolean(x)))),
    d.select({ id: schema.pipelineTasks.id, title: schema.pipelineTasks.title, status: schema.pipelineTasks.status, seen: seenBy(viewerId) }).from(schema.pipelineTasks).where(inArray(schema.pipelineTasks.id, rows.map((r) => r.blockedById).filter((x): x is string => Boolean(x)))),
    d
      .select({ taskId: schema.pipelineTaskFiles.taskId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.pipelineTaskFiles)
      .where(inArray(schema.pipelineTaskFiles.taskId, ids))
      .groupBy(schema.pipelineTaskFiles.taskId),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const parent = new Map(parents.map((p) => [p.id, p.seen ? p.title : null]));
  const wait = new Map(waiting.map((p) => [p.id, p]));
  return rows.map((t) => {
    const c = checks.filter((x) => x.taskId === t.id);
    const k = kids.filter((x) => x.parentId === t.id);
    const blocker = t.blockedById ? wait.get(t.blockedById) : null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId,
      assignee: t.assigneeId ? (name.get(t.assigneeId) ?? null) : null,
      /** Everyone it is assigned to, the main one first */
      assignees: [...(t.assigneeId ? [t.assigneeId] : []), ...(co.get(t.id) ?? [])].map((id) => ({ id, name: name.get(id) ?? "—" })),
      createdById: t.createdBy,
      createdBy: t.createdBy ? (name.get(t.createdBy) ?? null) : null,
      parentId: t.parentId,
      parentTitle: t.parentId ? (parent.get(t.parentId) ?? null) : null,
      blockedById: t.blockedById,
      blockedByTitle: blocker?.seen ? blocker.title : null,
      /** Cannot start or finish: the task it waits for is not done */
      waiting: Boolean(blocker && blocker.status !== "done"),
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      startDate: t.startDate,
      startTime: t.startTime,
      checkpointDate: t.checkpointDate,
      checkpointTime: t.checkpointTime,
      kind: t.kind,
      continuous: t.kind === "continuous",
      remindEveryDays: t.remindEveryDays,
      lastCheckedOn: t.lastCheckedOn,
      estimateMinutes: t.estimateMinutes,
      tags: t.tags,
      visibility: t.visibility,
      recurrence: t.recurrence,
      seriesId: t.seriesId,
      files: fileRows.find((x) => x.taskId === t.id)?.n ?? 0,
      ticketId: t.ticketId,
      ticketNumber: t.ticketNumber,
      ticketTitle: t.ticketTitle,
      hasNotes: t.notes.trim().length > 0,
      checklist: { done: c.filter((x) => x.done).reduce((n, x) => n + x.n, 0), total: c.reduce((n, x) => n + x.n, 0) },
      subtasks: { done: k.filter((x) => x.status === "done").reduce((n, x) => n + x.n, 0), total: k.reduce((n, x) => n + x.n, 0) },
      completedAt: t.completedAt,
      updatedAt: t.updatedAt,
    };
  });
}

async function taskOr404(c: Context<AppEnv>, id: string): Promise<Task> {
  const [t] = await db()
    .select()
    .from(schema.pipelineTasks)
    .where(and(eq(schema.pipelineTasks.id, id), seenBy(auth(c).user.id)));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  return t;
}

/** Following the links up from `start` must never come back to `id` (a task cannot be its own parent, or wait for itself). */
async function reaches(start: string | null, id: string, column: "parentId" | "blockedById"): Promise<boolean> {
  let cur = start;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === id) return true;
    const [r] = await db().select({ next: schema.pipelineTasks[column] }).from(schema.pipelineTasks).where(eq(schema.pipelineTasks.id, cur));
    cur = r?.next ?? null;
  }
  return false;
}

async function activeStaff(id: string | string[]) {
  const ids = [...new Set(Array.isArray(id) ? id : [id])];
  if (!ids.length) return;
  const rows = await db().select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (rows.length !== ids.length) throw new HTTPException(400, { message: "invalid_assignee" });
}

async function ticketRef(id: number) {
  const t = await (await ticketSource()).get(id).catch(() => null);
  if (!t) throw new HTTPException(400, { message: "invalid_ticket" });
  return { ticketId: t.id, ticketNumber: t.number, ticketTitle: t.title };
}

/** The people a "selected" task is shared with (replaced as a whole; active staff only) */
async function setViewers(taskId: string, ids: string[]) {
  await db().delete(schema.pipelineTaskViewers).where(eq(schema.pipelineTaskViewers.taskId, taskId));
  const keep = ids.length ? await db().select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.kind, "staff"), eq(schema.users.active, true))) : [];
  if (keep.length) await db().insert(schema.pipelineTaskViewers).values(keep.map((u) => ({ taskId, userId: u.id }))).onConflictDoNothing();
}

const dayDiff = (a: string, b: string) => Math.round((new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime()) / 86_400_000);
const plusDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The next occurrence of a recurring task that was just completed: the same task (title, instructions, who has it,
 * times, who can see it, a fresh checklist) due on the next day of its rule that is after today. Returns its id,
 * or null when the series is over.
 */
async function spawnNext(done: Task, by: string): Promise<string | null> {
  const rec = done.recurrence as Recurrence | null;
  if (!rec) return null;
  const today = todayQc();
  const due = nextAfter(done.dueDate ?? today, today, rec);
  if (!due) return null;
  const startDate = done.startDate && done.dueDate ? plusDays(due, -dayDiff(done.dueDate, done.startDate)) : null;
  const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineTasks.position}), 0)`.mapWith(Number) }).from(schema.pipelineTasks);
  const [row] = await db()
    .insert(schema.pipelineTasks)
    .values({
      title: done.title,
      notes: done.notes,
      priority: done.priority,
      assigneeId: done.assigneeId,
      createdBy: done.createdBy,
      parentId: done.parentId,
      dueDate: done.kind !== "normal" ? null : due,
      kind: done.kind,
      lastResetOn: done.kind === "daily" ? todayQc() : null,
      remindEveryDays: done.remindEveryDays,
      lastCheckedOn: done.remindEveryDays ? todayQc() : null,
      dueTime: done.dueTime,
      startDate,
      startTime: startDate ? done.startTime : null,
      checkpointDate: done.checkpointDate && done.dueDate ? plusDays(due, -dayDiff(done.dueDate, done.checkpointDate)) : null,
      checkpointTime: done.checkpointDate && done.dueDate ? done.checkpointTime : null,
      estimateMinutes: done.estimateMinutes,
      tags: done.tags,
      visibility: done.visibility,
      recurrence: rec,
      seriesId: done.seriesId ?? done.id,
      position: max + 1,
    })
    .returning();
  const others = (await coAssignees([done.id])).get(done.id) ?? [];
  if (others.length) await db().insert(schema.pipelineTaskAssignees).values(others.map((userId) => ({ taskId: row.id, userId }))).onConflictDoNothing();
  const items = await db().select().from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.taskId, done.id)).orderBy(asc(schema.pipelineChecklist.position));
  if (items.length) {
    // the steps come back fresh, with their person, and their days moved by as much as the task's due day
    const shift = done.dueDate ? dayDiff(due, done.dueDate) : 0;
    const move = (d: string | null) => (d && shift ? plusDays(d, shift) : d);
    const made = await db()
      .insert(schema.pipelineChecklist)
      .values(items.map((i, n) => ({ taskId: row.id, text: i.text, priority: i.priority, assigneeId: i.assigneeId, startDate: move(i.startDate), dueDate: move(i.dueDate), dueTime: i.dueDate ? i.dueTime : null, position: n })))
      .returning({ id: schema.pipelineChecklist.id });
    for (const [n, i] of items.entries()) {
      const at = i.dependsOnId ? items.findIndex((x) => x.id === i.dependsOnId) : -1;
      if (at >= 0) await db().update(schema.pipelineChecklist).set({ dependsOnId: made[at].id }).where(eq(schema.pipelineChecklist.id, made[n].id));
    }
  }
  const viewers = await db().select({ id: schema.pipelineTaskViewers.userId }).from(schema.pipelineTaskViewers).where(eq(schema.pipelineTaskViewers.taskId, done.id));
  if (viewers.length) await db().insert(schema.pipelineTaskViewers).values(viewers.map((v) => ({ taskId: row.id, userId: v.id })));
  await audit(by, "pipeline.task_recurred", row.id, { from: done.id, due });
  return row.id;
}

const aiLimit = (userId: string) => {
  if (!rateLimit(`pipeline-ai:${userId}`, 20, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
};

/** Pipeline: the team's shared to-do list and each technician's day (pipeline.view to see, pipeline.edit to change). */
export const pipelineRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("pipeline.view"))

  // ── Ma journée ──
  .get("/day", async (c) => {
    const a = auth(c);
    const q = c.req.query();
    const date = q.date && zDate.safeParse(q.date).success ? q.date : todayQc();
    // a manager can look at someone else's day
    let userId = a.user.id;
    if (q.userId && q.userId !== a.user.id) {
      if (!a.permissions.includes("pipeline.manage")) throw new HTTPException(403, { message: "forbidden" });
      userId = zUuid.parse(q.userId);
    }
    const [stored, view, s, ai] = await Promise.all([planOf(userId, date), buildPipelineView(userId, date, a.user.id), pipelineSettings(), aiSettings()]);
    // someone else's day: their private tasks and the details of their calendar are not shown
    const viewing = userId !== a.user.id;
    const hidden = new Set(view.items.filter((i) => i.masked).map((i) => i.refId));
    // a planned block whose work is no longer on the day's list was done (or taken off): shown struck out
    const live = new Set(view.items.map((i) => i.key));
    const withDone = (bl: typeof stored.blocks) => bl.map((b) => ((b.kind === "task" || b.kind === "ptask" || b.kind === "ticket") && b.refId && !live.has(`${b.kind}:${b.refId}`) ? { ...b, done: true } : b));
    const plan = viewing
      ? {
          ...stored,
          summary: hidden.size ? "" : stored.summary,
          blocks: withDone(stored.blocks).map((b) => (b.kind === "task" && b.refId && hidden.has(b.refId) ? { ...b, title: "", ticketNumber: null, note: null, masked: true } : b.kind === "event" && b.o365 ? { ...b, title: "Occupé", masked: true } : b)),
        }
      : { ...stored, blocks: withDone(stored.blocks) };
    // the AI's plan does not follow the list: tell when something to do is not in it
    const planned = new Set(plan.blocks.filter((b) => (b.kind === "task" || b.kind === "ptask" || b.kind === "ticket") && b.refId).map((b) => `${b.kind}:${b.refId}`));
    // also when the Outlook calendar changed (a meeting added or moved)
    const cal = plan.source === "ai" ? await calendarOfDay(userId, date).catch(() => null) : null;
    const stale = plan.source === "ai" && (view.items.some((i) => !i.blocked && !planned.has(i.key)) || (cal !== null && cal.events.filter((e) => !e.free).length !== plan.calendarEvents));
    // the time given to each item today (by the person, else by the AI): the sliders of the day
    const al = await allocOf(userId, date);
    const allocations: Record<string, { minutes: number; source: "manual" | "ai" }> = {};
    for (const [k, r] of al.ai) allocations[k] = { minutes: r.minutes, source: "ai" };
    for (const [k, m] of al.manual) allocations[k] = { minutes: m, source: "manual" };
    return c.json({ date, userId, plan, stale, allocations, ...view, workHours: { start: s.workStart, end: s.workEnd, lunchStart: s.lunchStart, lunchEnd: s.lunchEnd }, ai: Boolean(ai.enabled && ai.apiKey) });
  })

  // ── Tickets and tasks put on a day by hand (today only, an optional time to do it before; the ticket or task itself does not change) ──
  // an administrator (pipeline.manage) can do it for someone else: ?userId= / { userId }
  .get("/day/tickets/:ticketId", async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("ticketId"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const who = await dayTarget(a, c.req.query("userId"));
    await resetDayAdds();
    const [row] = await db().select().from(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.ticketId, id), eq(schema.ticketDayAdds.userId, who), eq(schema.ticketDayAdds.forDate, todayQc())));
    return c.json({ added: Boolean(row), dueTime: row?.dueTime ?? null });
  })

  .put("/day/tickets/:ticketId", requirePermission("pipeline.edit"), requirePermission("tickets.view"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("ticketId"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ time: zHm.nullable().default(null), userId: zUuid.optional() }));
    const who = await dayTarget(a, p.userId);
    const src = await ticketSource();
    const [t, o] = await Promise.all([src.get(id).catch(() => null), src.options()]);
    if (!t) throw new HTTPException(404, { message: "not_found" });
    if (o.statuses.find((s) => s.value === t.status)?.kind === "complete") throw new HTTPException(409, { message: "ticket_complete" });
    const forDate = todayQc();
    await db()
      .insert(schema.ticketDayAdds)
      .values({ ticketId: id, userId: who, forDate, dueTime: p.time, addedBy: a.user.id })
      .onConflictDoUpdate({ target: [schema.ticketDayAdds.ticketId, schema.ticketDayAdds.userId, schema.ticketDayAdds.forDate], set: { dueTime: p.time, addedBy: a.user.id } });
    await audit(a.user.id, "pipeline.ticket_day_added", String(id), { time: p.time, userId: who });
    if (who !== a.user.id) await notify([who], { type: "pipeline.day_added", data: { title: `${t.number} ${t.title}`.slice(0, 200), by: a.user.name, time: p.time }, link: `/tickets?t=${id}` });
    return c.json({ added: true, dueTime: p.time });
  })

  .delete("/day/tickets/:ticketId", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("ticketId"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const who = await dayTarget(a, c.req.query("userId"));
    await db().delete(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.ticketId, id), eq(schema.ticketDayAdds.userId, who)));
    await audit(a.user.id, "pipeline.ticket_day_removed", String(id), { userId: who });
    return c.json({ added: false, dueTime: null });
  })

  .get("/day/tasks/:taskId", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const who = await dayTarget(a, c.req.query("userId"));
    await resetDayAdds();
    const [row] = await db().select().from(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.taskId, id), eq(schema.ticketDayAdds.userId, who), eq(schema.ticketDayAdds.forDate, todayQc())));
    return c.json({ added: Boolean(row), dueTime: row?.dueTime ?? null });
  })

  .put("/day/tasks/:taskId", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const p = await body(c, z.object({ time: zHm.nullable().default(null), userId: zUuid.optional() }));
    const who = await dayTarget(a, p.userId);
    // a task the caller may not see (private) is not there for them
    const [t] = await db().select().from(schema.pipelineTasks).where(and(eq(schema.pipelineTasks.id, id), seenBy(a.user.id)));
    if (!t) throw new HTTPException(404, { message: "not_found" });
    if (t.status === "done") throw new HTTPException(409, { message: "task_done" });
    const forDate = todayQc();
    await db()
      .insert(schema.ticketDayAdds)
      .values({ taskId: id, userId: who, forDate, dueTime: p.time, addedBy: a.user.id })
      .onConflictDoUpdate({ target: [schema.ticketDayAdds.taskId, schema.ticketDayAdds.userId, schema.ticketDayAdds.forDate], set: { dueTime: p.time, addedBy: a.user.id } });
    await audit(a.user.id, "pipeline.task_day_added", id, { time: p.time, userId: who });
    if (who !== a.user.id) await notify([who], { type: "pipeline.day_added", data: { title: t.title.slice(0, 200), by: a.user.name, time: p.time }, link: `/pipeline?task=${id}` });
    return c.json({ added: true, dueTime: p.time });
  })

  .delete("/day/tasks/:taskId", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const who = await dayTarget(a, c.req.query("userId"));
    await db().delete(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.taskId, id), eq(schema.ticketDayAdds.userId, who)));
    await audit(a.user.id, "pipeline.task_day_removed", id, { userId: who });
    return c.json({ added: false, dueTime: null });
  })

  // a task of a project put on the day (the task itself does not change)
  .get("/day/ptasks/:taskId", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const who = await dayTarget(a, c.req.query("userId"));
    await resetDayAdds();
    const [row] = await db().select().from(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.projectTaskId, id), eq(schema.ticketDayAdds.userId, who), eq(schema.ticketDayAdds.forDate, todayQc())));
    return c.json({ added: Boolean(row), dueTime: row?.dueTime ?? null });
  })

  .put("/day/ptasks/:taskId", requirePermission("pipeline.edit"), requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const p = await body(c, z.object({ time: zHm.nullable().default(null), userId: zUuid.optional() }));
    const who = await dayTarget(a, p.userId);
    const [t] = await db().select({ title: schema.projectTasks.title, status: schema.projectTasks.status, project: schema.projects.status }).from(schema.projectTasks).innerJoin(schema.projects, eq(schema.projects.id, schema.projectTasks.projectId)).where(eq(schema.projectTasks.id, id));
    if (!t) throw new HTTPException(404, { message: "not_found" });
    if (t.status === "done") throw new HTTPException(409, { message: "task_done" });
    if (t.project !== "planning" && t.project !== "active") throw new HTTPException(409, { message: "project_closed" });
    const forDate = todayQc();
    await db()
      .insert(schema.ticketDayAdds)
      .values({ projectTaskId: id, userId: who, forDate, dueTime: p.time, addedBy: a.user.id })
      .onConflictDoUpdate({ target: [schema.ticketDayAdds.projectTaskId, schema.ticketDayAdds.userId, schema.ticketDayAdds.forDate], set: { dueTime: p.time, addedBy: a.user.id } });
    await audit(a.user.id, "pipeline.ptask_day_added", id, { time: p.time, userId: who });
    if (who !== a.user.id) await notify([who], { type: "pipeline.day_added", data: { title: t.title.slice(0, 200), by: a.user.name, time: p.time }, link: "/projects" });
    return c.json({ added: true, dueTime: p.time });
  })

  .delete("/day/ptasks/:taskId", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("taskId"));
    const who = await dayTarget(a, c.req.query("userId"));
    await db().delete(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.projectTaskId, id), eq(schema.ticketDayAdds.userId, who)));
    await audit(a.user.id, "pipeline.ptask_day_removed", id, { userId: who });
    return c.json({ added: false, dueTime: null });
  })


  /** Plan the day again (the AI when it is set up, else the portal's own rules). */
  .post("/day/plan", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const p = await body(c, z.object({ date: zDate.optional(), userId: zUuid.optional(), direction: z.string().max(2000).optional() }));
    const userId = p.userId && p.userId !== a.user.id ? (a.permissions.includes("pipeline.manage") ? p.userId : (() => { throw new HTTPException(403, { message: "forbidden" }); })()) : a.user.id;
    const out = await buildPlan(userId, p.date ?? todayQc(), { ai: true, fromNow: true, direction: cleanDirection(p.direction) });
    await audit(a.user.id, "pipeline.day_planned", userId, { source: out.plan.source, aiError: out.aiError });
    return c.json(out);
  })

  /**
   * The time to give an item today, in quarter hours (null = back to automatic). The day is laid out again at once;
   * an AI plan keeps its order, notes and summary. Less than the item needs is fine: some time goes in, the checkpoint moves later.
   */
  .put("/day/alloc", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ date: zDate.optional(), userId: zUuid.optional(), key: z.string().regex(/^(ticket:\d+|task:[0-9a-f-]{36}|ptask:[0-9a-f-]{36})$/), minutes: z.number().int().min(15).max(480).nullable() }));
    const who = await dayTarget(a, p.userId);
    const date = p.date ?? todayQc();
    const view = await dayItems(who, date, a.user.id);
    const it = view.items.find((i) => i.key === p.key && !i.masked);
    if (!it) throw new HTTPException(404, { message: "not_found" });
    const d = db();
    const where = and(eq(schema.pipelineDayAlloc.userId, who), eq(schema.pipelineDayAlloc.date, date), eq(schema.pipelineDayAlloc.key, p.key), eq(schema.pipelineDayAlloc.source, "manual"));
    if (p.minutes === null) await d.delete(schema.pipelineDayAlloc).where(where);
    else {
      const minutes = Math.round(p.minutes / 15) * 15;
      await d
        .insert(schema.pipelineDayAlloc)
        .values({ userId: who, date, key: p.key, minutes, source: "manual" })
        .onConflictDoUpdate({ target: [schema.pipelineDayAlloc.userId, schema.pipelineDayAlloc.date, schema.pipelineDayAlloc.key, schema.pipelineDayAlloc.source], set: { minutes, updatedAt: new Date() } });
    }
    const out = await buildPlan(who, date, { ai: false, reuse: true, fromNow: true });
    return c.json({ ok: true, plan: out.plan });
  })

  // a slot of time blocked by hand in the day (own color; it takes its hours off what can be planned)
  .post("/day/blocks", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ date: zDate.optional(), userId: zUuid.optional(), start: zHm, end: zHm, title: z.string().trim().min(1).max(120), note: z.string().trim().max(500).optional() }));
    const who = await dayTarget(a, p.userId);
    const date = p.date ?? todayQc();
    if (p.end <= p.start) throw new HTTPException(400, { message: "block_times" });
    const [row] = await db().insert(schema.pipelineDayBlocks).values({ userId: who, date, startTime: p.start, endTime: p.end, title: p.title, note: p.note || null, createdBy: a.user.id }).returning();
    const out = await buildPlan(who, date, { ai: false, reuse: true, fromNow: true });
    return c.json({ id: row.id, plan: out.plan }, 201);
  })
  .patch("/day/blocks/:id", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ start: zHm.optional(), end: zHm.optional(), title: z.string().trim().min(1).max(120).optional(), note: z.string().trim().max(500).nullable().optional() }));
    const [row] = await db().select().from(schema.pipelineDayBlocks).where(eq(schema.pipelineDayBlocks.id, id));
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await dayTarget(a, row.userId);
    const start = p.start ?? row.startTime;
    const end = p.end ?? row.endTime;
    if (end <= start) throw new HTTPException(400, { message: "block_times" });
    await db().update(schema.pipelineDayBlocks).set({ startTime: start, endTime: end, ...(p.title ? { title: p.title } : {}), ...(p.note !== undefined ? { note: p.note || null } : {}), updatedAt: new Date() }).where(eq(schema.pipelineDayBlocks.id, id));
    const out = await buildPlan(row.userId, row.date, { ai: false, reuse: true, fromNow: true });
    return c.json({ ok: true, plan: out.plan });
  })
  .delete("/day/blocks/:id", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().select().from(schema.pipelineDayBlocks).where(eq(schema.pipelineDayBlocks.id, id));
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await dayTarget(a, row.userId);
    await db().delete(schema.pipelineDayBlocks).where(eq(schema.pipelineDayBlocks.id, id));
    const out = await buildPlan(row.userId, row.date, { ai: false, reuse: true, fromNow: true });
    return c.json({ ok: true, plan: out.plan });
  })

  // the order of the day, given by dragging the blocks: the keys, first to last (kept for that day)
  .put("/day/order", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ date: zDate.optional(), userId: zUuid.optional(), keys: z.array(z.string().regex(/^(ticket:\d+|task:[0-9a-f-]{36}|ptask:[0-9a-f-]{36})$/)).max(200) }));
    const who = await dayTarget(a, p.userId);
    const date = p.date ?? todayQc();
    const view = await dayItems(who, date, a.user.id);
    const known = new Set(view.items.filter((i) => !i.masked).map((i) => i.key));
    const keys = [...new Set(p.keys)].filter((k) => known.has(k));
    const d = db();
    await d.delete(schema.pipelineDayAlloc).where(and(eq(schema.pipelineDayAlloc.userId, who), eq(schema.pipelineDayAlloc.date, date), eq(schema.pipelineDayAlloc.source, "order")));
    if (keys.length) await d.insert(schema.pipelineDayAlloc).values(keys.map((key, position) => ({ userId: who, date, key, minutes: 15, source: "order" as const, position })));
    const out = await buildPlan(who, date, { ai: false, reuse: true, fromNow: true });
    return c.json({ ok: true, plan: out.plan });
  })

  // ── The team's list ──
  .get("/people", async (c) => {
    const ids = await usersWith("staff", "pipeline.view");
    const rows = ids.length ? await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids)).orderBy(asc(schema.users.name)) : [];
    return c.json(rows);
  })

  .get("/tasks", async (c) => {
    await resetDailyTasks();
    const a = auth(c);
    const q = c.req.query();
    const status = q.status === "done" ? "done" : q.status === "all" ? "all" : "open";
    const conds: SQL[] = [seenBy(a.user.id)];
    if (status === "open") conds.push(ne(schema.pipelineTasks.status, "done"));
    if (status === "done") conds.push(eq(schema.pipelineTasks.status, "done"), sql`${schema.pipelineTasks.completedAt} > now() - interval '30 days'`);
    if (q.scope === "mine") conds.push(assignedTo(a.user.id));
    else if (q.assignee === "none") conds.push(sql`${schema.pipelineTasks.assigneeId} is null`);
    else if (q.assignee && zUuid.safeParse(q.assignee).success) conds.push(assignedTo(q.assignee));
    const rows = await db()
      .select()
      .from(schema.pipelineTasks)
      .where(and(...conds))
      .orderBy(asc(schema.pipelineTasks.position), desc(schema.pipelineTasks.createdAt))
      .limit(1000);
    const text = (q.q ?? "").trim().toLowerCase();
    const shown = text ? rows.filter((r) => `${r.title} ${r.notes} ${r.ticketNumber ?? ""}`.toLowerCase().includes(text)) : rows;
    return c.json(await cards(shown, a.user.id));
  })

  .get("/tasks/:id", async (c) => {
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const me = auth(c).user.id;
    const [card] = await cards([t], me);
    const [checklist, notes, subtasks, files, viewers] = await Promise.all([
      db().select().from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.taskId, t.id)).orderBy(asc(schema.pipelineChecklist.position), asc(schema.pipelineChecklist.createdAt)),
      db().select().from(schema.pipelineTaskNotes).where(eq(schema.pipelineTaskNotes.taskId, t.id)).orderBy(asc(schema.pipelineTaskNotes.createdAt)),
      // the subtasks this viewer may see
      db()
        .select()
        .from(schema.pipelineTasks)
        .where(and(eq(schema.pipelineTasks.parentId, t.id), seenBy(me)))
        .orderBy(asc(schema.pipelineTasks.position), asc(schema.pipelineTasks.createdAt)),
      db()
        .select({ id: schema.pipelineTaskFiles.id, name: schema.pipelineTaskFiles.name, size: schema.pipelineTaskFiles.size, contentType: schema.pipelineTaskFiles.contentType, createdAt: schema.pipelineTaskFiles.createdAt, by: schema.users.name })
        .from(schema.pipelineTaskFiles)
        .leftJoin(schema.users, eq(schema.users.id, schema.pipelineTaskFiles.uploadedBy))
        .where(eq(schema.pipelineTaskFiles.taskId, t.id))
        .orderBy(asc(schema.pipelineTaskFiles.createdAt)),
      db().select({ id: schema.pipelineTaskViewers.userId }).from(schema.pipelineTaskViewers).where(eq(schema.pipelineTaskViewers.taskId, t.id)),
    ]);
    return c.json({ ...card, notes: t.notes, checklistItems: checklist, comments: notes, subtaskList: await cards(subtasks, me), fileList: files, viewerIds: viewers.map((v) => v.id) });
  })

  .post("/tasks", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        title: zTitle,
        notes: zNotes.default(""),
        priority: zPriority.default("normal"),
        assigneeId: zUuid.nullable().default(null),
        /** several people: the first is the main one (replaces assigneeId) */
        assigneeIds: z.array(zUuid).max(10).optional(),
        parentId: zUuid.nullable().default(null),
        blockedById: zUuid.nullable().default(null),
        dueDate: zDate.nullable().default(null),
        dueTime: zHm.nullable().default(null),
        startDate: zDate.nullable().default(null),
        startTime: zHm.nullable().default(null),
        checkpointDate: zDate.nullable().default(null),
        checkpointTime: zHm.nullable().default(null),
        kind: zKind.default("normal"),
        remindEveryDays: zRemind.nullable().default(null),
        estimateMinutes: zMinutes.nullable().default(null),
        tags: zTags.default([]),
        visibility: zVisibility.default("team"),
        viewerIds: z.array(zUuid).max(30).default([]),
        recurrence: zRecurrence.nullable().default(null),
        ticketId: z.number().int().positive().nullable().default(null),
        checklist: z.array(z.union([z.string().trim().min(1).max(300), z.object({ text: z.string().trim().min(1).max(300), priority: zPriority.default("normal"), dueDate: zDate.nullable().default(null), dueTime: zHm.nullable().default(null), assigneeId: zUuid.nullable().default(null), startDate: zDate.nullable().default(null), dependsOn: z.number().int().min(0).nullable().default(null) })])).max(60).default([]),
      }),
    );
    const wanted = p.assigneeIds ?? (p.assigneeId ? [p.assigneeId] : []);
    await activeStaff(wanted);
    for (const it of p.checklist) if (typeof it !== "string" && it.assigneeId) await activeStaff(it.assigneeId);
    if (p.parentId) await taskOr404(c, p.parentId);
    if (p.blockedById) await taskOr404(c, p.blockedById);
    const ticket = p.ticketId ? await ticketRef(p.ticketId) : { ticketId: null, ticketNumber: null, ticketTitle: null };
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineTasks.position}), 0)`.mapWith(Number) }).from(schema.pipelineTasks);
    const [row] = await db()
      .insert(schema.pipelineTasks)
      .values({ title: p.title, notes: p.notes, priority: p.priority, assigneeId: wanted[0] ?? null, createdBy: a.user.id, parentId: p.parentId, blockedById: p.blockedById, dueDate: p.kind === "normal" ? p.dueDate : null, dueTime: p.dueDate && p.kind === "normal" ? p.dueTime : null, kind: p.kind, lastResetOn: p.kind === "daily" ? todayQc() : null, remindEveryDays: p.kind === "continuous" ? p.remindEveryDays : null, lastCheckedOn: p.kind === "continuous" && p.remindEveryDays ? todayQc() : null, startDate: p.startDate, startTime: p.startDate ? p.startTime : null, checkpointDate: p.checkpointDate, checkpointTime: p.checkpointDate ? (p.checkpointTime ?? "17:00") : null, estimateMinutes: p.kind === "continuous" ? null : p.estimateMinutes, tags: [...new Set(p.tags)], visibility: p.visibility, recurrence: p.kind === "normal" ? p.recurrence : null, ...ticket, position: max + 1 })
      .returning();
    if (wanted.length > 1) await setAssignees(row.id, wanted);
    if (p.visibility === "selected") await setViewers(row.id, p.viewerIds);
    if (row.recurrence) await db().update(schema.pipelineTasks).set({ seriesId: row.id }).where(eq(schema.pipelineTasks.id, row.id));
    if (p.checklist.length) {
      const made = await db()
        .insert(schema.pipelineChecklist)
        .values(p.checklist.map((it, i) => (typeof it === "string" ? { taskId: row.id, text: it, position: i } : { taskId: row.id, text: it.text, priority: it.priority, dueDate: it.dueDate, dueTime: it.dueDate ? (it.dueTime ?? "17:00") : null, startDate: it.startDate, assigneeId: it.assigneeId, position: i })))
        .returning({ id: schema.pipelineChecklist.id });
      // an item can wait for an EARLIER one of the same list
      for (const [i, it] of p.checklist.entries()) if (typeof it !== "string" && it.dependsOn !== null && it.dependsOn < i) await db().update(schema.pipelineChecklist).set({ dependsOnId: made[it.dependsOn].id }).where(eq(schema.pipelineChecklist.id, made[i].id));
    }
    for (const it of p.checklist) if (typeof it !== "string" && it.assigneeId && it.assigneeId !== a.user.id && it.assigneeId !== row.assigneeId) await notify([it.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: it.text, taskId: row.id }, link: `/pipeline?task=${row.id}` });
    const told = wanted.filter((id) => id !== a.user.id);
    if (told.length) await notify(told, { type: "pipeline.assigned", data: { by: a.user.name, title: row.title, taskId: row.id }, link: `/pipeline?task=${row.id}` });
    await audit(a.user.id, "pipeline.task_created", row.id, { title: row.title, assignees: wanted });
    return c.json((await cards([row], a.user.id))[0], 201);
  })

  .patch("/tasks/:id", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        title: zTitle.optional(),
        notes: zNotes.optional(),
        status: zStatus.optional(),
        priority: zPriority.optional(),
        assigneeId: zUuid.nullable().optional(),
        /** several people, the first the main one; replaces the whole list (and assigneeId) */
        assigneeIds: z.array(zUuid).max(10).optional(),
        parentId: zUuid.nullable().optional(),
        blockedById: zUuid.nullable().optional(),
        dueDate: zDate.nullable().optional(),
        dueTime: zHm.nullable().optional(),
        startDate: zDate.nullable().optional(),
        startTime: zHm.nullable().optional(),
        checkpointDate: zDate.nullable().optional(),
        checkpointTime: zHm.nullable().optional(),
        kind: zKind.optional(),
        remindEveryDays: zRemind.nullable().optional(),
        estimateMinutes: zMinutes.nullable().optional(),
        tags: zTags.optional(),
        visibility: zVisibility.optional(),
        viewerIds: z.array(zUuid).max(30).optional(),
        recurrence: zRecurrence.nullable().optional(),
        ticketId: z.number().int().positive().nullable().optional(),
      }),
    );
    const cur = await taskOr404(c, id);
    // who sees the task is for the one who made it and the one who has it to change
    if ((p.visibility !== undefined || p.viewerIds !== undefined) && cur.createdBy !== a.user.id && !(await isAssigned(cur.id, a.user.id))) throw new HTTPException(403, { message: "forbidden" });
    const set: Partial<Task> = { updatedAt: new Date() };
    if (p.title !== undefined) set.title = p.title;
    if (p.notes !== undefined) set.notes = p.notes;
    if (p.priority !== undefined) set.priority = p.priority;
    // a continuous or daily task has no due day (a continuous one has a checkpoint, a daily one starts again each day)
    const kindNow = p.kind ?? cur.kind;
    if (p.kind !== undefined) {
      set.kind = p.kind;
      if (p.kind !== "normal") {
        set.dueDate = null;
        set.dueTime = null;
        set.recurrence = null;
      }
      if (p.kind === "daily") set.lastResetOn = todayQc();
      if (p.kind === "continuous") set.estimateMinutes = null;
    }
    // the reminder belongs to a continuous task; a new value starts counting today
    if (kindNow !== "continuous") {
      if (p.remindEveryDays) throw new HTTPException(400, { message: "reminder_needs_continuous" });
      if (cur.remindEveryDays) {
        set.remindEveryDays = null;
        set.lastCheckedOn = null;
      }
    } else if (p.remindEveryDays !== undefined) {
      set.remindEveryDays = p.remindEveryDays;
      set.lastCheckedOn = p.remindEveryDays ? todayQc() : null;
    }
    if (kindNow !== "normal" && (p.dueDate || p.dueTime)) throw new HTTPException(400, { message: "task_no_due" });
    if (kindNow !== "normal" && p.recurrence) throw new HTTPException(400, { message: "task_no_recurrence" });
    if (p.dueDate !== undefined) {
      set.dueDate = p.dueDate;
      // no day: no time either
      if (p.dueDate === null) set.dueTime = null;
    }
    if (p.dueTime !== undefined) set.dueTime = (set.dueDate !== undefined ? set.dueDate : cur.dueDate) ? p.dueTime : null;
    if (p.startDate !== undefined) {
      set.startDate = p.startDate;
      if (p.startDate === null) set.startTime = null;
    }
    if (p.startTime !== undefined) set.startTime = (set.startDate !== undefined ? set.startDate : cur.startDate) ? p.startTime : null;
    // the checkpoint: a day and a time (17:00 when none is given); no day, no time
    if (p.checkpointDate !== undefined) {
      set.checkpointDate = p.checkpointDate;
      set.checkpointTime = p.checkpointDate ? (p.checkpointTime ?? cur.checkpointTime ?? "17:00") : null;
    } else if (p.checkpointTime !== undefined) set.checkpointTime = cur.checkpointDate ? (p.checkpointTime ?? "17:00") : null;
    if (p.tags !== undefined) set.tags = [...new Set(p.tags)];
    if (p.visibility !== undefined) set.visibility = p.visibility;
    if (p.recurrence !== undefined) {
      set.recurrence = p.recurrence;
      if (p.recurrence && !cur.seriesId) set.seriesId = cur.id;
    }
    if (p.estimateMinutes !== undefined) set.estimateMinutes = kindNow === "continuous" ? null : p.estimateMinutes;
    // the people: one (assigneeId) or several (assigneeIds, which wins), the first being the main one
    const people = p.assigneeIds ?? (p.assigneeId !== undefined ? (p.assigneeId ? [p.assigneeId] : []) : undefined);
    const before = people ? [...(cur.assigneeId ? [cur.assigneeId] : []), ...((await coAssignees([cur.id])).get(cur.id) ?? [])] : [];
    if (people) await activeStaff(people);
    if (p.parentId !== undefined) {
      if (p.parentId) {
        await taskOr404(c, p.parentId);
        if (await reaches(p.parentId, id, "parentId")) throw new HTTPException(409, { message: "task_cycle" });
      }
      set.parentId = p.parentId;
    }
    if (p.blockedById !== undefined) {
      if (p.blockedById) {
        await taskOr404(c, p.blockedById);
        if (await reaches(p.blockedById, id, "blockedById")) throw new HTTPException(409, { message: "task_cycle" });
      }
      set.blockedById = p.blockedById;
    }
    if (p.ticketId !== undefined) Object.assign(set, p.ticketId ? await ticketRef(p.ticketId) : { ticketId: null, ticketNumber: null, ticketTitle: null });
    if (p.status !== undefined && p.status !== cur.status) {
      const waitsOn = (set.blockedById !== undefined ? set.blockedById : cur.blockedById) ?? null;
      if (p.status === "doing" || p.status === "done") {
        if (waitsOn) {
          const [b] = await db().select({ status: schema.pipelineTasks.status }).from(schema.pipelineTasks).where(eq(schema.pipelineTasks.id, waitsOn));
          if (b && b.status !== "done") throw new HTTPException(409, { message: "task_blocked" });
        }
      }
      if (p.status === "done") {
        const [open] = await db()
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(schema.pipelineTasks)
          .where(and(eq(schema.pipelineTasks.parentId, id), ne(schema.pipelineTasks.status, "done")));
        if (open.n > 0) throw new HTTPException(409, { message: "task_open_children" });
        // the steps are the work: the task is done when every one is
        const [steps] = await db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.taskId, id), eq(schema.pipelineChecklist.done, false)));
        if (steps.n > 0) throw new HTTPException(409, { message: "checklist_open" });
        set.completedAt = new Date();
        set.completedBy = a.user.id;
      } else if (cur.status === "done") {
        set.completedAt = null;
        set.completedBy = null;
      }
      set.status = p.status;
    }
    await db().update(schema.pipelineTasks).set(set).where(eq(schema.pipelineTasks.id, id));
    if (people) await setAssignees(id, people);
    if (p.viewerIds !== undefined) await setViewers(id, p.viewerIds);
    // a recurring task completed: the next one is made
    const next = p.status === "done" && cur.status !== "done" && cur.recurrence ? await spawnNext(await taskOr404(c, id), a.user.id) : null;
    // the people who just got the task are told (not oneself, not the ones who already had it)
    const added = (people ?? []).filter((x) => x !== a.user.id && !before.includes(x));
    if (added.length) await notify(added, { type: "pipeline.assigned", data: { by: a.user.name, title: p.title ?? cur.title, taskId: id }, link: `/pipeline?task=${id}` });
    await audit(a.user.id, "pipeline.task_updated", id, { fields: Object.keys(p) });
    return c.json({ ...(await cards([await taskOr404(c, id)], a.user.id))[0], next });
  })

  .delete("/tasks/:id", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    // the one who made it, or a manager
    if (t.createdBy !== a.user.id && !a.permissions.includes("pipeline.manage")) throw new HTTPException(403, { message: "forbidden" });
    await db().delete(schema.pipelineTasks).where(eq(schema.pipelineTasks.id, t.id));
    await audit(a.user.id, "pipeline.task_deleted", t.id, { title: t.title });
    return c.json({ ok: true });
  })

  /** Checked off for now: a continuous task with a reminder stays open and comes back after its number of days */
  .post("/tasks/:id/check", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    if (t.kind !== "continuous" || !t.remindEveryDays) throw new HTTPException(409, { message: "no_reminder" });
    const [row] = await db().update(schema.pipelineTasks).set({ lastCheckedOn: todayQc(), updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id)).returning();
    return c.json((await cards([row], auth(c).user.id))[0]);
  })

  // ── Checklist and notes ──
  .post("/tasks/:id/checklist", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300), priority: zPriority.default("normal"), dueDate: zDate.nullable().default(null), dueTime: zHm.nullable().default(null), assigneeId: zUuid.nullable().default(null), startDate: zDate.nullable().default(null), dependsOnId: zUuid.nullable().default(null) }));
    if (p.assigneeId) await activeStaff(p.assigneeId);
    if (p.dependsOnId) await itemOf(t.id, p.dependsOnId);
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineChecklist.position}), 0)`.mapWith(Number) }).from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.taskId, t.id));
    const [row] = await db().insert(schema.pipelineChecklist).values({ taskId: t.id, text: p.text, priority: p.priority, dueDate: p.dueDate, dueTime: p.dueDate ? (p.dueTime ?? "17:00") : null, assigneeId: p.assigneeId, startDate: p.startDate, dependsOnId: p.dependsOnId, position: max + 1 }).returning();
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    if (p.assigneeId && p.assigneeId !== a.user.id) await notify([p.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: p.text, taskId: t.id }, link: `/pipeline?task=${t.id}` });
    return c.json(row, 201);
  })
  .patch("/tasks/:id/checklist/:cid", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const cid = zUuid.parse(c.req.param("cid"));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional(), priority: zPriority.optional(), dueDate: zDate.nullable().optional(), dueTime: zHm.nullable().optional(), assigneeId: zUuid.nullable().optional(), startDate: zDate.nullable().optional(), dependsOnId: zUuid.nullable().optional() }));
    if (p.assigneeId) await activeStaff(p.assigneeId);
    const [before] = await db().select().from(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.id, cid), eq(schema.pipelineChecklist.taskId, t.id)));
    if (before && p.dependsOnId) {
      await itemOf(t.id, p.dependsOnId);
      // an item cannot wait for itself or, through others, for something that waits for it
      let walk: string | null = p.dependsOnId;
      for (let i = 0; walk && i < 100; i++) {
        if (walk === cid) throw new HTTPException(409, { message: "item_cycle" });
        const [n] = await db().select({ d: schema.pipelineChecklist.dependsOnId }).from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.id, walk));
        walk = n?.d ?? null;
      }
    }
    if (before && p.done === true && !before.done) {
      const waits = p.dependsOnId !== undefined ? p.dependsOnId : before.dependsOnId;
      if (waits) {
        const [d] = await db().select({ done: schema.pipelineChecklist.done }).from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.id, waits));
        if (d && !d.done) throw new HTTPException(409, { message: "item_blocked" });
      }
      const from = p.startDate !== undefined ? p.startDate : before.startDate;
      if (from && from > todayQc()) throw new HTTPException(409, { message: "item_not_started" });
    }
    if (before && p.done === false && before.done) {
      const [later] = await db().select({ id: schema.pipelineChecklist.id }).from(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.dependsOnId, cid), eq(schema.pipelineChecklist.done, true)));
      if (later) throw new HTTPException(409, { message: "item_has_done_dependents" });
    }
    // a time only goes with a day (17:00 when none is given)
    const dayNow = p.dueDate !== undefined ? p.dueDate : (before?.dueDate ?? null);
    const timeSet = p.dueDate === null || (p.dueDate === undefined && p.dueTime === undefined && !dayNow) ? { dueTime: null } : p.dueTime !== undefined || p.dueDate ? { dueTime: dayNow ? (p.dueTime ?? before?.dueTime ?? "17:00") : null } : {};
    const [row] = await db()
      .update(schema.pipelineChecklist)
      .set({ ...(p.text !== undefined ? { text: p.text } : {}), ...(p.done !== undefined ? { done: p.done } : {}), ...(p.priority !== undefined ? { priority: p.priority } : {}), ...(p.dueDate !== undefined ? { dueDate: p.dueDate } : {}), ...(p.assigneeId !== undefined ? { assigneeId: p.assigneeId } : {}), ...(p.startDate !== undefined ? { startDate: p.startDate } : {}), ...(p.dependsOnId !== undefined ? { dependsOnId: p.dependsOnId } : {}), ...timeSet })
      .where(and(eq(schema.pipelineChecklist.id, cid), eq(schema.pipelineChecklist.taskId, t.id)))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    if (p.assigneeId && p.assigneeId !== before?.assigneeId && p.assigneeId !== a.user.id) await notify([p.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: row.text, taskId: t.id }, link: `/pipeline?task=${t.id}` });
    return c.json(row);
  })
  // tell colleagues about the task: the bell always, and an email, a text and a Teams message as ticked
  .post("/tasks/:id/notify", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`pipeline-notify:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ userIds: z.array(zUuid).min(1).max(20), message: z.string().trim().max(1000).default(""), channels: z.object({ email: z.boolean(), sms: z.boolean(), teams: z.boolean() }) }));
    // only people who can see the task are told about it (a private task is not leaked by a notification)
    const viewers = t.visibility === "selected" ? (await db().select({ id: schema.pipelineTaskViewers.userId }).from(schema.pipelineTaskViewers).where(eq(schema.pipelineTaskViewers.taskId, t.id))).map((v) => v.id) : [];
    const together = (await coAssignees([t.id])).get(t.id) ?? [];
    const seen = p.userIds.filter((uid) => t.visibility === "team" || uid === t.createdBy || uid === t.assigneeId || together.includes(uid) || viewers.includes(uid));
    if (!seen.length) throw new HTTPException(400, { message: "no_recipient" });
    const link = `/pipeline?task=${t.id}`;
    const people = await notifyTechs({ id: 0, number: "Tâche", title: t.title, company: { name: "" }, link, head: `vous signale la tâche « ${t.title} »` }, { id: a.user.id, name: a.realUser.name }, seen, p.message, { ...p.channels, bell: false });
    if (!people.length) throw new HTTPException(400, { message: "no_recipient" });
    await notify(people.map((x) => x.id), { type: "pipeline.assigned", data: { by: a.user.name, title: t.title, message: p.message.slice(0, 300), notice: true }, link });
    await audit(a.user.id, "pipeline.task_notified", t.id, { to: people.map((x) => x.id), channels: p.channels });
    return c.json({ people });
  })
  // an item becomes a subtask of its own (same words, person, day and priority), linked to the item
  .post("/tasks/:id/checklist/:cid/task", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const [it] = await db().select().from(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.id, zUuid.parse(c.req.param("cid"))), eq(schema.pipelineChecklist.taskId, t.id)));
    if (!it) throw new HTTPException(404, { message: "not_found" });
    if (it.childTaskId) throw new HTTPException(409, { message: "item_has_task" });
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineTasks.position}), 0)`.mapWith(Number) }).from(schema.pipelineTasks);
    const [child] = await db()
      .insert(schema.pipelineTasks)
      .values({ title: it.text, priority: it.priority, assigneeId: it.assigneeId ?? t.assigneeId, createdBy: a.user.id, parentId: t.id, dueDate: it.dueDate, dueTime: it.dueDate ? it.dueTime : null, visibility: t.visibility === "team" ? "team" : "private", position: max + 1 })
      .returning();
    await db().update(schema.pipelineChecklist).set({ childTaskId: child.id }).where(eq(schema.pipelineChecklist.id, it.id));
    if (child.assigneeId && child.assigneeId !== a.user.id) await notify([child.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: child.title, taskId: child.id }, link: `/pipeline?task=${child.id}` });
    await audit(a.user.id, "pipeline.checklist_task", child.id, { parent: t.id });
    return c.json((await cards([child], a.user.id))[0], 201);
  })
  .delete("/tasks/:id/checklist/:cid", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    await db().delete(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.id, zUuid.parse(c.req.param("cid"))), eq(schema.pipelineChecklist.taskId, t.id)));
    return c.json({ ok: true });
  })
  .post("/tasks/:id/files", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().max(120).default("application/octet-stream"),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
      }),
    );
    if (!p.data) throw new HTTPException(400, { message: "Validation failed" });
    const [{ n }] = await db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.pipelineTaskFiles).where(eq(schema.pipelineTaskFiles.taskId, t.id));
    if (n >= MAX_FILES) throw new HTTPException(409, { message: "too_many_files" });
    const size = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
    const [row] = await db().insert(schema.pipelineTaskFiles).values({ taskId: t.id, name: p.name, contentType: p.contentType, size, data: p.data, uploadedBy: a.user.id }).returning({ id: schema.pipelineTaskFiles.id, name: schema.pipelineTaskFiles.name, size: schema.pipelineTaskFiles.size });
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    await audit(a.user.id, "pipeline.file_added", t.id, { name: p.name, bytes: size });
    return c.json(row, 201);
  })
  /** A file of a task (always a download, never shown in the page) */
  .get("/tasks/:id/files/:fid", async (c) => {
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const [f] = await db().select().from(schema.pipelineTaskFiles).where(and(eq(schema.pipelineTaskFiles.id, zUuid.parse(c.req.param("fid"))), eq(schema.pipelineTaskFiles.taskId, t.id)));
    if (!f) throw new HTTPException(404, { message: "not_found" });
    return new Response(Buffer.from(f.data, "base64"), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  })
  .delete("/tasks/:id/files/:fid", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    await db().delete(schema.pipelineTaskFiles).where(and(eq(schema.pipelineTaskFiles.id, zUuid.parse(c.req.param("fid"))), eq(schema.pipelineTaskFiles.taskId, t.id)));
    return c.json({ ok: true });
  })
  .post("/tasks/:id/notes", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    const [row] = await db().insert(schema.pipelineTaskNotes).values({ taskId: t.id, userId: a.user.id, author: a.user.name, text: p.text }).returning();
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    // the one it is assigned to hears about a comment from someone else
    if (t.assigneeId && t.assigneeId !== a.user.id) await notify([t.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: t.title, taskId: t.id, comment: true }, link: `/pipeline?task=${t.id}` });
    return c.json(row, 201);
  })

  // ── Morning plan and text (managers) ──
  .get("/settings", requirePermission("pipeline.manage"), async (c) => c.json(await pipelineSettings()))
  .put("/settings", requirePermission("pipeline.manage"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({ auto: z.boolean(), time: zHm, sms: z.boolean(), workStart: zHm, workEnd: zHm, lunchStart: zHm, lunchEnd: zHm }).refine((v) => v.workStart < v.lunchStart && v.lunchStart <= v.lunchEnd && v.lunchEnd < v.workEnd, { message: "invalid_hours" }),
    );
    const next = await savePipelineSettings(p as Partial<PipelineSettings>);
    await audit(a.user.id, "pipeline.settings", null, { auto: p.auto, time: p.time, sms: p.sms });
    return c.json(next);
  })
  /** Who can be sent a test text: the technicians, whether they have a mobile number (masked) and the text line is ready */
  .get("/test-targets", requirePermission("pipeline.manage"), async (c) => {
    const ids = await usersWith("staff", "pipeline.view");
    const rows = ids.length ? await db().select().from(schema.users).where(inArray(schema.users.id, ids)).orderBy(asc(schema.users.name)) : [];
    return c.json(rows.map((u) => ({ id: u.id, name: u.name, phone: maskPhone(phoneOf(u)) })));
  })
  /** One test text to one person: their real morning text, or a short line */
  .post("/morning/test-sms", requirePermission("pipeline.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ userId: zUuid, mode: z.enum(["plan", "short"]).default("short") }));
    try {
      const r = await sendTestSms(p.userId, p.mode);
      await audit(a.user.id, "pipeline.test_sms_sent", p.userId, { mode: p.mode });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof PipelineError) throw new HTTPException(e.code === "not_found" ? 404 : e.code === "sms_failed" ? 502 : 409, { message: e.code });
      throw e;
    }
  })
  /** Run the morning plan now, for everyone or one person (texts only when asked) */
  .post("/morning/run", requirePermission("pipeline.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ sms: z.boolean().default(false), userId: zUuid.optional() }));
    const r = await morningRun({ sms: p.sms, onlyUserId: p.userId });
    await audit(a.user.id, "pipeline.morning_run_manual", p.userId ?? null, { ...r, sms: p.sms });
    return c.json(r);
  });

