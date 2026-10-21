import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { aiSettings } from "../lib/ai.ts";
import { rateLimit } from "../lib/http.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { buildPipelineView, morningRun, pipelineSettings, planOf, buildPlan, savePipelineSettings, type PipelineSettings } from "../lib/pipeline.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { todayQc } from "../lib/timesheets.ts";
import { body, zUuid } from "../lib/validate.ts";

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zHm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zStatus = z.enum(["todo", "doing", "blocked", "done"]);
const zPriority = z.enum(["low", "normal", "high", "urgent"]);
const zTitle = z.string().trim().min(1).max(200);
const zNotes = z.string().trim().max(8000);
const zMinutes = z.number().int().min(5).max(24 * 60);

type Task = typeof schema.pipelineTasks.$inferSelect;

/** Tasks shaped for the screen: names, checklist progress, subtasks, and whether it is waiting on another task. */
async function cards(rows: Task[]) {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const [people, checks, kids, parents, waiting] = await Promise.all([
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
    d.select({ id: schema.pipelineTasks.id, title: schema.pipelineTasks.title }).from(schema.pipelineTasks).where(inArray(schema.pipelineTasks.id, rows.map((r) => r.parentId).filter((x): x is string => Boolean(x)))),
    d.select({ id: schema.pipelineTasks.id, title: schema.pipelineTasks.title, status: schema.pipelineTasks.status }).from(schema.pipelineTasks).where(inArray(schema.pipelineTasks.id, rows.map((r) => r.blockedById).filter((x): x is string => Boolean(x)))),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const parent = new Map(parents.map((p) => [p.id, p.title]));
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
      createdById: t.createdBy,
      createdBy: t.createdBy ? (name.get(t.createdBy) ?? null) : null,
      parentId: t.parentId,
      parentTitle: t.parentId ? (parent.get(t.parentId) ?? null) : null,
      blockedById: t.blockedById,
      blockedByTitle: blocker?.title ?? null,
      /** Cannot start or finish: the task it waits for is not done */
      waiting: Boolean(blocker && blocker.status !== "done"),
      dueDate: t.dueDate,
      estimateMinutes: t.estimateMinutes,
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

async function taskOr404(id: string): Promise<Task> {
  const [t] = await db().select().from(schema.pipelineTasks).where(eq(schema.pipelineTasks.id, id));
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

async function activeStaff(id: string) {
  const [u] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new HTTPException(400, { message: "invalid_assignee" });
}

async function ticketRef(id: number) {
  const t = await (await ticketSource()).get(id).catch(() => null);
  if (!t) throw new HTTPException(400, { message: "invalid_ticket" });
  return { ticketId: t.id, ticketNumber: t.number, ticketTitle: t.title };
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
    const [plan, view, s, ai] = await Promise.all([planOf(userId, date), buildPipelineView(userId, date), pipelineSettings(), aiSettings()]);
    // the AI's plan does not follow the list: tell when something to do is not in it
    const planned = new Set(plan.blocks.filter((b) => (b.kind === "task" || b.kind === "ticket") && b.refId).map((b) => `${b.kind}:${b.refId}`));
    const stale = plan.source === "ai" && view.items.some((i) => !i.blocked && !planned.has(i.key));
    return c.json({ date, userId, plan, stale, ...view, workHours: { start: s.workStart, end: s.workEnd, lunchStart: s.lunchStart, lunchEnd: s.lunchEnd }, ai: Boolean(ai.enabled && ai.apiKey) });
  })

  /** Plan the day again (the AI when it is set up, else the portal's own rules). */
  .post("/day/plan", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const p = await body(c, z.object({ date: zDate.optional(), userId: zUuid.optional() }));
    const userId = p.userId && p.userId !== a.user.id ? (a.permissions.includes("pipeline.manage") ? p.userId : (() => { throw new HTTPException(403, { message: "forbidden" }); })()) : a.user.id;
    const out = await buildPlan(userId, p.date ?? todayQc(), { ai: true });
    await audit(a.user.id, "pipeline.day_planned", userId, { source: out.plan.source, aiError: out.aiError });
    return c.json(out);
  })

  // ── The team's list ──
  .get("/people", async (c) => {
    const ids = await usersWith("staff", "pipeline.view");
    const rows = ids.length ? await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids)).orderBy(asc(schema.users.name)) : [];
    return c.json(rows);
  })

  .get("/tasks", async (c) => {
    const a = auth(c);
    const q = c.req.query();
    const status = q.status === "done" ? "done" : q.status === "all" ? "all" : "open";
    const conds = [];
    if (status === "open") conds.push(ne(schema.pipelineTasks.status, "done"));
    if (status === "done") conds.push(eq(schema.pipelineTasks.status, "done"), sql`${schema.pipelineTasks.completedAt} > now() - interval '30 days'`);
    if (q.scope === "mine") conds.push(eq(schema.pipelineTasks.assigneeId, a.user.id));
    else if (q.assignee === "none") conds.push(sql`${schema.pipelineTasks.assigneeId} is null`);
    else if (q.assignee && zUuid.safeParse(q.assignee).success) conds.push(eq(schema.pipelineTasks.assigneeId, q.assignee));
    const rows = await db()
      .select()
      .from(schema.pipelineTasks)
      .where(and(...conds))
      .orderBy(asc(schema.pipelineTasks.position), desc(schema.pipelineTasks.createdAt))
      .limit(1000);
    const text = (q.q ?? "").trim().toLowerCase();
    const shown = text ? rows.filter((r) => `${r.title} ${r.notes} ${r.ticketNumber ?? ""}`.toLowerCase().includes(text)) : rows;
    return c.json(await cards(shown));
  })

  .get("/tasks/:id", async (c) => {
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
    const [card] = await cards([t]);
    const [checklist, notes, subtasks] = await Promise.all([
      db().select().from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.taskId, t.id)).orderBy(asc(schema.pipelineChecklist.position), asc(schema.pipelineChecklist.createdAt)),
      db().select().from(schema.pipelineTaskNotes).where(eq(schema.pipelineTaskNotes.taskId, t.id)).orderBy(asc(schema.pipelineTaskNotes.createdAt)),
      db().select().from(schema.pipelineTasks).where(eq(schema.pipelineTasks.parentId, t.id)).orderBy(asc(schema.pipelineTasks.position), asc(schema.pipelineTasks.createdAt)),
    ]);
    return c.json({ ...card, notes: t.notes, checklistItems: checklist, comments: notes, subtaskList: await cards(subtasks) });
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
        parentId: zUuid.nullable().default(null),
        blockedById: zUuid.nullable().default(null),
        dueDate: zDate.nullable().default(null),
        estimateMinutes: zMinutes.nullable().default(null),
        ticketId: z.number().int().positive().nullable().default(null),
        checklist: z.array(z.string().trim().min(1).max(300)).max(60).default([]),
      }),
    );
    if (p.assigneeId) await activeStaff(p.assigneeId);
    if (p.parentId) await taskOr404(p.parentId);
    if (p.blockedById) await taskOr404(p.blockedById);
    const ticket = p.ticketId ? await ticketRef(p.ticketId) : { ticketId: null, ticketNumber: null, ticketTitle: null };
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineTasks.position}), 0)`.mapWith(Number) }).from(schema.pipelineTasks);
    const [row] = await db()
      .insert(schema.pipelineTasks)
      .values({ title: p.title, notes: p.notes, priority: p.priority, assigneeId: p.assigneeId, createdBy: a.user.id, parentId: p.parentId, blockedById: p.blockedById, dueDate: p.dueDate, estimateMinutes: p.estimateMinutes, ...ticket, position: max + 1 })
      .returning();
    if (p.checklist.length) await db().insert(schema.pipelineChecklist).values(p.checklist.map((text, i) => ({ taskId: row.id, text, position: i })));
    if (row.assigneeId && row.assigneeId !== a.user.id) await notify([row.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: row.title, taskId: row.id }, link: `/pipeline?task=${row.id}` });
    await audit(a.user.id, "pipeline.task_created", row.id, { title: row.title, assignee: row.assigneeId });
    return c.json((await cards([row]))[0], 201);
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
        parentId: zUuid.nullable().optional(),
        blockedById: zUuid.nullable().optional(),
        dueDate: zDate.nullable().optional(),
        estimateMinutes: zMinutes.nullable().optional(),
        ticketId: z.number().int().positive().nullable().optional(),
      }),
    );
    const cur = await taskOr404(id);
    const set: Partial<Task> = { updatedAt: new Date() };
    if (p.title !== undefined) set.title = p.title;
    if (p.notes !== undefined) set.notes = p.notes;
    if (p.priority !== undefined) set.priority = p.priority;
    if (p.dueDate !== undefined) set.dueDate = p.dueDate;
    if (p.estimateMinutes !== undefined) set.estimateMinutes = p.estimateMinutes;
    if (p.assigneeId !== undefined) {
      if (p.assigneeId) await activeStaff(p.assigneeId);
      set.assigneeId = p.assigneeId;
    }
    if (p.parentId !== undefined) {
      if (p.parentId) {
        await taskOr404(p.parentId);
        if (await reaches(p.parentId, id, "parentId")) throw new HTTPException(409, { message: "task_cycle" });
      }
      set.parentId = p.parentId;
    }
    if (p.blockedById !== undefined) {
      if (p.blockedById) {
        await taskOr404(p.blockedById);
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
        set.completedAt = new Date();
        set.completedBy = a.user.id;
      } else if (cur.status === "done") {
        set.completedAt = null;
        set.completedBy = null;
      }
      set.status = p.status;
    }
    await db().update(schema.pipelineTasks).set(set).where(eq(schema.pipelineTasks.id, id));
    if (p.assigneeId && p.assigneeId !== cur.assigneeId && p.assigneeId !== a.user.id) await notify([p.assigneeId], { type: "pipeline.assigned", data: { by: a.user.name, title: p.title ?? cur.title, taskId: id }, link: `/pipeline?task=${id}` });
    await audit(a.user.id, "pipeline.task_updated", id, { fields: Object.keys(p) });
    return c.json((await cards([await taskOr404(id)]))[0]);
  })

  .delete("/tasks/:id", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
    // the one who made it, or a manager
    if (t.createdBy !== a.user.id && !a.permissions.includes("pipeline.manage")) throw new HTTPException(403, { message: "forbidden" });
    await db().delete(schema.pipelineTasks).where(eq(schema.pipelineTasks.id, t.id));
    await audit(a.user.id, "pipeline.task_deleted", t.id, { title: t.title });
    return c.json({ ok: true });
  })

  // ── Checklist and notes ──
  .post("/tasks/:id/checklist", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300) }));
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.pipelineChecklist.position}), 0)`.mapWith(Number) }).from(schema.pipelineChecklist).where(eq(schema.pipelineChecklist.taskId, t.id));
    const [row] = await db().insert(schema.pipelineChecklist).values({ taskId: t.id, text: p.text, position: max + 1 }).returning();
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    return c.json(row, 201);
  })
  .patch("/tasks/:id/checklist/:cid", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
    const cid = zUuid.parse(c.req.param("cid"));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() }));
    const [row] = await db()
      .update(schema.pipelineChecklist)
      .set({ ...(p.text !== undefined ? { text: p.text } : {}), ...(p.done !== undefined ? { done: p.done } : {}) })
      .where(and(eq(schema.pipelineChecklist.id, cid), eq(schema.pipelineChecklist.taskId, t.id)))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await db().update(schema.pipelineTasks).set({ updatedAt: new Date() }).where(eq(schema.pipelineTasks.id, t.id));
    return c.json(row);
  })
  .delete("/tasks/:id/checklist/:cid", requirePermission("pipeline.edit"), async (c) => {
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
    await db().delete(schema.pipelineChecklist).where(and(eq(schema.pipelineChecklist.id, zUuid.parse(c.req.param("cid"))), eq(schema.pipelineChecklist.taskId, t.id)));
    return c.json({ ok: true });
  })
  .post("/tasks/:id/notes", requirePermission("pipeline.edit"), async (c) => {
    const a = auth(c);
    const t = await taskOr404(zUuid.parse(c.req.param("id")));
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
  /** Run the morning plan now, for everyone or one person (texts only when asked) */
  .post("/morning/run", requirePermission("pipeline.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ sms: z.boolean().default(false), userId: zUuid.optional() }));
    const r = await morningRun({ sms: p.sms, onlyUserId: p.userId });
    await audit(a.user.id, "pipeline.morning_run_manual", p.userId ?? null, { ...r, sms: p.sms });
    return c.json(r);
  });

