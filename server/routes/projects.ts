import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { addDays, bankByDefault, editable, labourType, sheetOf, todayQc, weekStartOf } from "../lib/timesheets.ts";
import { billingSettings } from "../lib/billing.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Centre de commande › Projets: a project is a folder — milestones (jalons) with their tasks, the team, the time logged
 * on it (timesheet entries with a project) and a thread of notes. The list has the same tiles and filters as Tickets:
 * My projects, Needs attention, To watch.
 */
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zStatus = z.enum(["planning", "active", "on_hold", "done", "cancelled"]);
const zMsStatus = z.enum(["todo", "doing", "done"]);
const zName = z.string().trim().min(1).max(200);
const zText = z.string().trim().max(8000);
const zTaskStatus = z.enum(["todo", "doing", "blocked", "done"]);
const zPriority = z.enum(["low", "normal", "high", "urgent"]);
const zMoney = z.number().min(0).max(10_000_000);
const cents = (d: number | null | undefined) => (d == null ? null : Math.round(d * 100));
const zHours = z.number().min(0).max(100000);
/** Hours typed as a number (decimal): kept in hundredths, none = no budget */
const x100 = (h: number | null | undefined) => (h == null ? null : Math.round(h * 100));

type Project = typeof schema.projects.$inferSelect;

/** P-1001, P-1002… (the highest + 1) */
async function nextNumber(): Promise<string> {
  const rows = await db().select({ n: schema.projects.number }).from(schema.projects);
  const highest = rows.reduce((m, r) => Math.max(m, Number(r.n.replace(/\D/g, "")) || 0), 1000);
  return `P-${highest + 1}`;
}

async function loadProject(id: string): Promise<Project> {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [p] = await db().select().from(schema.projects).where(eq(schema.projects.id, r.data));
  if (!p) throw new HTTPException(404, { message: "not_found" });
  return p;
}

/** Active staff only: a lead, a member or an assignee is always someone who can sign in */
async function activeStaff(ids: string[]): Promise<void> {
  const want = [...new Set(ids)];
  if (!want.length) return;
  const rows = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.id, want), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (rows.length !== want.length) throw new HTTPException(400, { message: "person_invalid" });
}

async function clientExists(id: string): Promise<void> {
  const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, id));
  if (!c) throw new HTTPException(400, { message: "client_unknown" });
}

/** The cards: milestones with their task and time figures, the team, whether I follow it, what needs attention. */
async function cards(rows: Project[], me: string, withTasks = false) {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const today = todayQc();
  const [milestones, tasks, members, followers, hours, clients, users] = await Promise.all([
    d.select().from(schema.projectMilestones).where(inArray(schema.projectMilestones.projectId, ids)).orderBy(asc(schema.projectMilestones.position), asc(schema.projectMilestones.createdAt)),
    d.select().from(schema.projectTasks).where(inArray(schema.projectTasks.projectId, ids)).orderBy(asc(schema.projectTasks.position), asc(schema.projectTasks.createdAt)),
    d.select({ projectId: schema.projectMembers.projectId, userId: schema.projectMembers.userId }).from(schema.projectMembers).where(inArray(schema.projectMembers.projectId, ids)),
    d.select({ projectId: schema.projectFollowers.projectId }).from(schema.projectFollowers).where(and(inArray(schema.projectFollowers.projectId, ids), eq(schema.projectFollowers.userId, me))),
    d
      .select({ projectId: schema.timesheetEntries.projectId, milestoneId: schema.timesheetEntries.milestoneId, taskId: schema.timesheetEntries.taskId, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
      .from(schema.timesheetEntries)
      .where(inArray(schema.timesheetEntries.projectId, ids))
      .groupBy(schema.timesheetEntries.projectId, schema.timesheetEntries.milestoneId, schema.timesheetEntries.taskId),
    d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, rows.map((r) => r.clientId).filter((x): x is string => Boolean(x)).concat("00000000-0000-0000-0000-000000000000"))),
    d.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.kind, "staff")),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((p) => {
    const ms = milestones.filter((m) => m.projectId === p.id);
    const logged = hours.filter((h) => h.projectId === p.id);
    const totalHours = logged.reduce((n, h) => n + h.h, 0);
    const open = p.status !== "done" && p.status !== "cancelled";
    const milestoneViews = ms.map((m) => {
      const mine = tasks.filter((t) => t.milestoneId === m.id);
      return {
        id: m.id,
        name: m.name,
        notes: m.notes,
        status: m.status,
        dueDate: m.dueDate,
        late: m.status !== "done" && Boolean(m.dueDate && m.dueDate < today),
        budgetHours: m.budgetHoursX100 == null ? null : m.budgetHoursX100 / 100,
        hours: (logged.filter((h) => h.milestoneId === m.id).reduce((n, h) => n + h.h, 0)) / 100,
        tasksDone: mine.filter((t) => t.done).length,
        tasksTotal: mine.length,
        ...(withTasks
          ? {
              tasks: mine.map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                priority: t.priority,
                done: t.done,
                assigneeId: t.assigneeId,
                assigneeName: t.assigneeId ? (userName.get(t.assigneeId) ?? null) : null,
                dueDate: t.dueDate,
                late: !t.done && Boolean(t.dueDate && t.dueDate < today),
                estimateHours: t.estimateMinutes == null ? null : t.estimateMinutes / 60,
                hours: logged.filter((h) => h.taskId === t.id).reduce((n, h) => n + h.h, 0) / 100,
              })),
            }
          : {}),
      };
    });
    const attention: string[] = [];
    if (open) {
      if (p.dueDate && p.dueDate < today) attention.push("late");
      if (milestoneViews.some((m) => m.late)) attention.push("milestone_late");
      if (p.budgetHoursX100 != null && totalHours > p.budgetHoursX100) attention.push("over_budget");
    }
    const memberIds = [...new Set([...(p.leadId ? [p.leadId] : []), ...members.filter((m) => m.projectId === p.id).map((m) => m.userId)])];
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      description: p.description,
      status: p.status,
      client: p.clientId ? { id: p.clientId, name: clientName.get(p.clientId) ?? "" } : null,
      lead: p.leadId ? { id: p.leadId, name: userName.get(p.leadId) ?? "" } : null,
      members: memberIds.map((id) => ({ id, name: userName.get(id) ?? "" })),
      startDate: p.startDate,
      dueDate: p.dueDate,
      budgetHours: p.budgetHoursX100 == null ? null : p.budgetHoursX100 / 100,
      billingMode: p.billingMode,
      hourlyRate: p.hourlyRateCents == null ? null : p.hourlyRateCents / 100,
      fixedPrice: p.fixedPriceCents == null ? null : p.fixedPriceCents / 100,
      hours: totalHours / 100,
      following: followers.some((f) => f.projectId === p.id),
      mine: memberIds.includes(me),
      progress: { done: ms.filter((m) => m.status === "done").length, total: ms.length },
      attention,
      nextMilestone: milestoneViews.find((m) => m.status !== "done") ?? null,
      milestones: milestoneViews,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

/** A project's team, from the lead and the members given */
async function setMembers(projectId: string, leadId: string | null, memberIds: string[]) {
  const d = db();
  await d.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, projectId));
  const all = [...new Set([...(leadId ? [leadId] : []), ...memberIds])];
  if (all.length) await d.insert(schema.projectMembers).values(all.map((userId) => ({ projectId, userId })));
}

async function loadMilestone(projectId: string, id: string) {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [m] = await db().select().from(schema.projectMilestones).where(and(eq(schema.projectMilestones.id, r.data), eq(schema.projectMilestones.projectId, projectId)));
  if (!m) throw new HTTPException(404, { message: "not_found" });
  return m;
}

const zProject = z.object({
  name: zName,
  clientId: zUuid.nullable().optional(),
  description: zText.optional(),
  status: zStatus.optional(),
  leadId: zUuid.nullable().optional(),
  memberIds: z.array(zUuid).max(40).optional(),
  startDate: zDay.nullable().optional(),
  dueDate: zDay.nullable().optional(),
  budgetHours: zHours.nullable().optional(),
  billingMode: z.enum(["hourly", "fixed"]).optional(),
  /** Dollars */
  hourlyRate: zMoney.nullable().optional(),
  fixedPrice: zMoney.nullable().optional(),
  /** Milestones made with the project, in order */
  milestones: z.array(z.object({ name: zName, dueDate: zDay.nullable().optional() })).max(40).optional(),
});

/** A due day not before the start */
function checkDays(start: string | null | undefined, due: string | null | undefined) {
  if (start && due && due < start) throw new HTTPException(400, { message: "project_dates" });
}

export const projectsRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** Active staff, for the pickers (lead, team, assignee) */
  .get("/people", requirePermission("projects.view"), async (c) => {
    const rows = await db()
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
      .orderBy(asc(schema.users.name));
    return c.json(rows);
  })

  /** My running timers (they stay in the dock of the minimized tasks) */
  .get("/timers", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ taskId: schema.projectTaskTimers.taskId, startedAt: schema.projectTaskTimers.startedAt, title: schema.projectTasks.title, projectId: schema.projects.id, number: schema.projects.number, milestone: schema.projectMilestones.name })
      .from(schema.projectTaskTimers)
      .innerJoin(schema.projectTasks, eq(schema.projectTasks.id, schema.projectTaskTimers.taskId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTasks.projectId))
      .innerJoin(schema.projectMilestones, eq(schema.projectMilestones.id, schema.projectTasks.milestoneId))
      .where(eq(schema.projectTaskTimers.userId, a.user.id))
      .orderBy(asc(schema.projectTaskTimers.startedAt));
    return c.json(rows);
  })

  /** What a new project starts with: the usual hourly rate of Admin › Facturation (dollars) */
  .get("/defaults", requirePermission("projects.view"), async (c) => c.json({ hourlyRate: (await billingSettings()).rates.hourly }))

  /** The numbers on the tiles: my projects, what needs attention, what I follow (open ones) */
  .get("/summary", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const open = await db()
      .select()
      .from(schema.projects)
      .where(sql`${schema.projects.status} not in ('done','cancelled')`);
    const all = await cards(open, a.user.id);
    return c.json({ open: all.length, mine: all.filter((p) => p.mine).length, attention: all.filter((p) => p.attention.length).length, watch: all.filter((p) => p.following).length });
  })

  /** My week: milestones and projects due each day, and the hours I logged on projects (`scope=all` for everyone's work) */
  .get("/week", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const from = weekStartOf(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch(todayQc()).parse(c.req.query("from") ?? todayQc()));
    const to = addDays(from, 6);
    const everyone = c.req.query("scope") === "all";
    const d = db();
    const mineOnly = (pid: typeof schema.projects.id) =>
      everyone ? undefined : or(eq(schema.projects.leadId, a.user.id), sql`exists (select 1 from project_members m where m.project_id = ${pid} and m.user_id = ${a.user.id})`);
    const [ms, due, mine] = await Promise.all([
      d
        .select({ id: schema.projectMilestones.id, name: schema.projectMilestones.name, dueDate: schema.projectMilestones.dueDate, status: schema.projectMilestones.status, projectId: schema.projects.id, number: schema.projects.number, project: schema.projects.name })
        .from(schema.projectMilestones)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMilestones.projectId))
        .where(and(gte(schema.projectMilestones.dueDate, from), lte(schema.projectMilestones.dueDate, to), sql`${schema.projects.status} not in ('done','cancelled')`, mineOnly(schema.projects.id))),
      d
        .select({ id: schema.projects.id, number: schema.projects.number, name: schema.projects.name, dueDate: schema.projects.dueDate })
        .from(schema.projects)
        .where(and(gte(schema.projects.dueDate, from), lte(schema.projects.dueDate, to), sql`${schema.projects.status} not in ('done','cancelled')`, mineOnly(schema.projects.id))),
      d
        .select({ date: schema.timesheetEntries.date, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
        .from(schema.timesheetEntries)
        .where(and(eq(schema.timesheetEntries.userId, a.user.id), isNotNull(schema.timesheetEntries.projectId), gte(schema.timesheetEntries.date, from), lte(schema.timesheetEntries.date, to)))
        .groupBy(schema.timesheetEntries.date),
    ]);
    return c.json({
      from,
      to,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(from, i);
        return {
          date,
          milestones: ms.filter((m) => m.dueDate === date),
          projects: due.filter((p) => p.dueDate === date),
          hours: (mine.find((x) => x.date === date)?.h ?? 0) / 100,
        };
      }),
    });
  })

  /** The projects. `view`: mine | attention | watch | all; `status`: open (default) | done | all */
  .get("/", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const q = z
      .object({
        view: z.enum(["mine", "attention", "watch", "all"]).catch("mine"),
        status: z.enum(["open", "done", "all"]).catch("open"),
        q: z.string().trim().max(100).optional(),
        lead: zUuid.optional().catch(undefined),
        client: zUuid.optional().catch(undefined),
        state: zStatus.optional().catch(undefined),
      })
      .parse({ view: c.req.query("view"), status: c.req.query("status"), q: c.req.query("q") || undefined, lead: c.req.query("lead") || undefined, client: c.req.query("client") || undefined, state: c.req.query("state") || undefined });
    const p = schema.projects;
    const rows = await db()
      .select()
      .from(p)
      .where(
        and(
          q.status === "open" ? sql`${p.status} not in ('done','cancelled')` : q.status === "done" ? sql`${p.status} in ('done','cancelled')` : undefined,
          q.state ? eq(p.status, q.state) : undefined,
          q.lead ? eq(p.leadId, q.lead) : undefined,
          q.client ? eq(p.clientId, q.client) : undefined,
          q.q ? or(ilike(p.name, `%${q.q}%`), ilike(p.number, `%${q.q}%`)) : undefined,
        ),
      )
      .orderBy(asc(sql`coalesce(${p.dueDate}, '9999-12-31')`), desc(p.createdAt))
      .limit(500);
    let list = await cards(rows, a.user.id);
    if (q.view === "mine") list = list.filter((x) => x.mine);
    else if (q.view === "attention") list = list.filter((x) => x.attention.length);
    else if (q.view === "watch") list = list.filter((x) => x.following);
    return c.json(list);
  })

  .post("/", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, zProject);
    checkDays(p.startDate, p.dueDate);
    const leadId = p.leadId === undefined ? a.user.id : p.leadId;
    await activeStaff([...(leadId ? [leadId] : []), ...(p.memberIds ?? [])]);
    if (p.clientId) await clientExists(p.clientId);
    // the number and the usual rate are read before the transaction (one connection: nothing else may run inside it)
    const number = await nextNumber();
    const defaultRate = (await billingSettings()).rates.hourly;
    const row = await db().transaction(async (tx) => {
      const [made] = await tx
        .insert(schema.projects)
        .values({
          number,
          name: p.name,
          clientId: p.clientId ?? null,
          description: p.description ?? "",
          status: p.status ?? "planning",
          leadId,
          startDate: p.startDate ?? null,
          dueDate: p.dueDate ?? null,
          budgetHoursX100: x100(p.budgetHours),
          billingMode: p.billingMode ?? "hourly",
          hourlyRateCents: cents(p.hourlyRate === undefined ? defaultRate : p.hourlyRate),
          fixedPriceCents: cents(p.fixedPrice),
          createdBy: a.user.id,
        })
        .returning();
      if (p.milestones?.length) await tx.insert(schema.projectMilestones).values(p.milestones.map((m, i) => ({ projectId: made.id, name: m.name, dueDate: m.dueDate ?? null, position: i })));
      return made;
    });
    await setMembers(row.id, leadId, p.memberIds ?? []);
    await audit(a.user.id, "project.created", row.id, { number: row.number, name: row.name });
    return c.json((await cards([row], a.user.id, true))[0], 201);
  })

  /** One project, whole: milestones with their tasks, the team, the notes and the time */
  .get("/:id", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const d = db();
    const [card] = await cards([p], a.user.id, true);
    const [notes, entries, byPerson] = await Promise.all([
      d
        .select({ id: schema.projectNotes.id, text: schema.projectNotes.text, createdAt: schema.projectNotes.createdAt, authorId: schema.projectNotes.authorId, author: schema.users.name })
        .from(schema.projectNotes)
        .leftJoin(schema.users, eq(schema.users.id, schema.projectNotes.authorId))
        .where(eq(schema.projectNotes.projectId, p.id))
        .orderBy(desc(schema.projectNotes.createdAt))
        .limit(200),
      d
        .select({ id: schema.timesheetEntries.id, date: schema.timesheetEntries.date, hoursX100: schema.timesheetEntries.hoursX100, billableX100: schema.timesheetEntries.billableX100, note: schema.timesheetEntries.note, milestoneId: schema.timesheetEntries.milestoneId, userId: schema.timesheetEntries.userId, user: schema.users.name })
        .from(schema.timesheetEntries)
        .innerJoin(schema.users, eq(schema.users.id, schema.timesheetEntries.userId))
        .where(eq(schema.timesheetEntries.projectId, p.id))
        .orderBy(desc(schema.timesheetEntries.date), desc(schema.timesheetEntries.createdAt))
        .limit(300),
      d
        .select({ userId: schema.timesheetEntries.userId, user: schema.users.name, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
        .from(schema.timesheetEntries)
        .innerJoin(schema.users, eq(schema.users.id, schema.timesheetEntries.userId))
        .where(eq(schema.timesheetEntries.projectId, p.id))
        .groupBy(schema.timesheetEntries.userId, schema.users.name)
        .orderBy(desc(sql`sum(${schema.timesheetEntries.hoursX100})`)),
    ]);
    const msName = new Map(card.milestones.map((m) => [m.id, m.name]));
    return c.json({
      ...card,
      notes: notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, authorId: n.authorId, author: n.author ?? null })),
      time: {
        byPerson: byPerson.map((x) => ({ userId: x.userId, name: x.user, hours: x.h / 100 })),
        entries: entries.map((e) => ({ id: e.id, date: e.date, hours: e.hoursX100 / 100, billableHours: (e.billableX100 ?? e.hoursX100) / 100, note: e.note, milestoneId: e.milestoneId, milestone: e.milestoneId ? (msName.get(e.milestoneId) ?? null) : null, userId: e.userId, user: e.user })),
      },
    });
  })

  /** The client's contacts with an email address (who a reply to the client can go to) */
  .get("/:id/contacts", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p.clientId) return c.json([]);
    const rows = await db()
      .select({ id: schema.clientContacts.id, firstName: schema.clientContacts.firstName, lastName: schema.clientContacts.lastName, email: schema.clientContacts.email })
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, p.clientId), eq(schema.clientContacts.active, true), isNotNull(schema.clientContacts.email)))
      .orderBy(asc(schema.clientContacts.firstName));
    return c.json(rows.filter((r) => r.email?.trim()).map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email!.trim() })));
  })
  .patch("/:id", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const cur = await loadProject(c.req.param("id"));
    const p = await body(c, zProject.partial().extend({ milestones: z.undefined().optional() }));
    checkDays(p.startDate === undefined ? cur.startDate : p.startDate, p.dueDate === undefined ? cur.dueDate : p.dueDate);
    if (p.leadId) await activeStaff([p.leadId]);
    if (p.memberIds) await activeStaff(p.memberIds);
    if (p.clientId) await clientExists(p.clientId);
    // a project is finished once every milestone is
    if (p.status === "done" && cur.status !== "done") {
      const [open] = await db().select({ id: schema.projectMilestones.id }).from(schema.projectMilestones).where(and(eq(schema.projectMilestones.projectId, cur.id), sql`${schema.projectMilestones.status} <> 'done'`)).limit(1);
      if (open) throw new HTTPException(409, { message: "project_open_milestones" });
    }
    const [row] = await db()
      .update(schema.projects)
      .set({
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.clientId !== undefined ? { clientId: p.clientId } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.status !== undefined ? { status: p.status, closedAt: p.status === "done" || p.status === "cancelled" ? (cur.closedAt ?? new Date()) : null } : {}),
        ...(p.leadId !== undefined ? { leadId: p.leadId } : {}),
        ...(p.startDate !== undefined ? { startDate: p.startDate } : {}),
        ...(p.dueDate !== undefined ? { dueDate: p.dueDate } : {}),
        ...(p.budgetHours !== undefined ? { budgetHoursX100: x100(p.budgetHours) } : {}),
        ...(p.billingMode !== undefined ? { billingMode: p.billingMode } : {}),
        ...(p.hourlyRate !== undefined ? { hourlyRateCents: cents(p.hourlyRate) } : {}),
        ...(p.fixedPrice !== undefined ? { fixedPriceCents: cents(p.fixedPrice) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.projects.id, cur.id))
      .returning();
    if (p.leadId !== undefined || p.memberIds) {
      const current = (await db().select({ u: schema.projectMembers.userId }).from(schema.projectMembers).where(eq(schema.projectMembers.projectId, cur.id))).map((m) => m.u);
      await setMembers(cur.id, row.leadId, p.memberIds ?? current);
    }
    await audit(a.user.id, "project.updated", cur.id, { fields: Object.keys(p) });
    return c.json((await cards([row], a.user.id, true))[0]);
  })

  .delete("/:id", requirePermission("projects.manage"), async (c) => {
    const a = auth(c);
    const cur = await loadProject(c.req.param("id"));
    // the hours stay on the timesheets, no longer tied to a project
    await db().update(schema.timesheetEntries).set({ projectId: null, milestoneId: null }).where(eq(schema.timesheetEntries.projectId, cur.id));
    await db().delete(schema.projects).where(eq(schema.projects.id, cur.id));
    await audit(a.user.id, "project.deleted", cur.id, { number: cur.number, name: cur.name });
    return c.json({ ok: true });
  })

  .put("/:id/follow", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const { follow } = await body(c, z.object({ follow: z.boolean() }));
    if (follow) await db().insert(schema.projectFollowers).values({ projectId: p.id, userId: a.user.id }).onConflictDoNothing();
    else await db().delete(schema.projectFollowers).where(and(eq(schema.projectFollowers.projectId, p.id), eq(schema.projectFollowers.userId, a.user.id)));
    return c.json({ following: follow });
  })

  // ── milestones ──
  .post("/:id/milestones", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const m = await body(c, z.object({ name: zName, dueDate: zDay.nullable().optional(), notes: zText.optional(), budgetHours: zHours.nullable().optional() }));
    const [{ n }] = await db().select({ n: sql<number>`coalesce(max(${schema.projectMilestones.position}), -1)::int` }).from(schema.projectMilestones).where(eq(schema.projectMilestones.projectId, p.id));
    const [row] = await db()
      .insert(schema.projectMilestones)
      .values({ projectId: p.id, name: m.name, dueDate: m.dueDate ?? null, notes: m.notes ?? "", budgetHoursX100: x100(m.budgetHours), position: n + 1 })
      .returning();
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row, 201);
  })
  .patch("/:id/milestones/:mid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const cur = await loadMilestone(p.id, c.req.param("mid"));
    const m = await body(c, z.object({ name: zName.optional(), notes: zText.optional(), status: zMsStatus.optional(), dueDate: zDay.nullable().optional(), budgetHours: zHours.nullable().optional() }));
    // a milestone is reached when its tasks are done: its status follows them. Only one with no task is marked by hand.
    if (m.status !== undefined) {
      const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.projectTasks).where(eq(schema.projectTasks.milestoneId, cur.id));
      if (n > 0) throw new HTTPException(409, { message: "milestone_has_tasks" });
    }
    const [row] = await db()
      .update(schema.projectMilestones)
      .set({
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.notes !== undefined ? { notes: m.notes } : {}),
        ...(m.status !== undefined ? { status: m.status, doneAt: m.status === "done" ? (cur.doneAt ?? new Date()) : null } : {}),
        ...(m.dueDate !== undefined ? { dueDate: m.dueDate } : {}),
        ...(m.budgetHours !== undefined ? { budgetHoursX100: x100(m.budgetHours) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectMilestones.id, cur.id))
      .returning();
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row);
  })
  .delete("/:id/milestones/:mid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const cur = await loadMilestone(p.id, c.req.param("mid"));
    // the time stays on the project, no longer on a milestone
    await db().update(schema.timesheetEntries).set({ milestoneId: null }).where(eq(schema.timesheetEntries.milestoneId, cur.id));
    await db().delete(schema.projectMilestones).where(eq(schema.projectMilestones.id, cur.id));
    return c.json({ ok: true });
  })
  .post("/:id/milestones/reorder", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const { ids } = await body(c, z.object({ ids: z.array(zUuid).min(1).max(100) }));
    const mine = new Set((await db().select({ id: schema.projectMilestones.id }).from(schema.projectMilestones).where(eq(schema.projectMilestones.projectId, p.id))).map((m) => m.id));
    if (ids.length !== mine.size || ids.some((id) => !mine.has(id))) throw new HTTPException(400, { message: "Validation failed" });
    for (const [i, id] of ids.entries()) await db().update(schema.projectMilestones).set({ position: i }).where(eq(schema.projectMilestones.id, id));
    return c.json({ ok: true });
  })

  // ── tasks of a milestone: each one is a small ticket (description, status, priority, person, day, thread, time and a timer) ──
  .post("/:id/milestones/:mid/tasks", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const m = await loadMilestone(p.id, c.req.param("mid"));
    const t = await body(c, z.object({ title: zName, description: zText.optional(), priority: zPriority.optional(), assigneeId: zUuid.nullable().optional(), dueDate: zDay.nullable().optional(), estimateHours: zHours.nullable().optional() }));
    if (t.assigneeId) await activeStaff([t.assigneeId]);
    const [{ n }] = await db().select({ n: sql<number>`coalesce(max(${schema.projectTasks.position}), -1)::int` }).from(schema.projectTasks).where(eq(schema.projectTasks.milestoneId, m.id));
    const [row] = await db()
      .insert(schema.projectTasks)
      .values({ projectId: p.id, milestoneId: m.id, title: t.title, description: t.description ?? "", priority: t.priority ?? "normal", assigneeId: t.assigneeId ?? null, dueDate: t.dueDate ?? null, estimateMinutes: t.estimateHours == null ? null : Math.round(t.estimateHours * 60), position: n + 1 })
      .returning();
    await syncMilestone(m.id);
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row, 201);
  })
  /** One task, whole: its fields, the project and milestone it is in, its thread, its time, my running timer */
  .get("/:id/tasks/:tid", requirePermission("projects.view"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const task = await loadTask(p.id, c.req.param("tid"));
    const d = db();
    const [m] = await d.select().from(schema.projectMilestones).where(eq(schema.projectMilestones.id, task.milestoneId));
    const [notes, entries, timer, assignee] = await Promise.all([
      d
        .select({ id: schema.projectTaskNotes.id, text: schema.projectTaskNotes.text, kind: schema.projectTaskNotes.kind, emailedTo: schema.projectTaskNotes.emailedTo, createdAt: schema.projectTaskNotes.createdAt, authorId: schema.projectTaskNotes.authorId, author: schema.users.name })
        .from(schema.projectTaskNotes)
        .leftJoin(schema.users, eq(schema.users.id, schema.projectTaskNotes.authorId))
        .where(eq(schema.projectTaskNotes.taskId, task.id))
        .orderBy(desc(schema.projectTaskNotes.createdAt)),
      d
        .select({ id: schema.timesheetEntries.id, date: schema.timesheetEntries.date, hoursX100: schema.timesheetEntries.hoursX100, billableX100: schema.timesheetEntries.billableX100, note: schema.timesheetEntries.note, userId: schema.timesheetEntries.userId, user: schema.users.name, createdAt: schema.timesheetEntries.createdAt })
        .from(schema.timesheetEntries)
        .innerJoin(schema.users, eq(schema.users.id, schema.timesheetEntries.userId))
        .where(eq(schema.timesheetEntries.taskId, task.id))
        .orderBy(desc(schema.timesheetEntries.date), desc(schema.timesheetEntries.createdAt)),
      d.select().from(schema.projectTaskTimers).where(and(eq(schema.projectTaskTimers.taskId, task.id), eq(schema.projectTaskTimers.userId, a.user.id))),
      task.assigneeId ? d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, task.assigneeId)) : Promise.resolve([]),
    ]);
    return c.json({
      id: task.id,
      projectId: p.id,
      project: { id: p.id, number: p.number, name: p.name, clientId: p.clientId, status: p.status, billingMode: p.billingMode, hourlyRate: p.hourlyRateCents == null ? null : p.hourlyRateCents / 100 },
      milestone: { id: m.id, name: m.name },
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assigneeId,
      assigneeName: assignee[0]?.name ?? null,
      dueDate: task.dueDate,
      estimateHours: task.estimateMinutes == null ? null : task.estimateMinutes / 60,
      doneAt: task.doneAt,
      createdAt: task.createdAt,
      notes: notes.map((n) => ({ ...n, author: n.author ?? null })),
      time: entries.map((e) => ({ id: e.id, date: e.date, hours: e.hoursX100 / 100, billableHours: (e.billableX100 ?? e.hoursX100) / 100, note: e.note, userId: e.userId, user: e.user, createdAt: e.createdAt })),
      hours: entries.reduce((n, e) => n + e.hoursX100, 0) / 100,
      timer: timer[0] ? { startedAt: timer[0].startedAt } : null,
    });
  })
  .patch("/:id/tasks/:tid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const cur = await loadTask(p.id, c.req.param("tid"));
    const t = await body(
      c,
      z.object({
        title: zName.optional(),
        description: zText.optional(),
        status: zTaskStatus.optional(),
        priority: zPriority.optional(),
        done: z.boolean().optional(),
        assigneeId: zUuid.nullable().optional(),
        dueDate: zDay.nullable().optional(),
        estimateHours: zHours.nullable().optional(),
        /** Move the task to another milestone of the same project */
        milestoneId: zUuid.optional(),
      }),
    );
    if (t.assigneeId) await activeStaff([t.assigneeId]);
    const target = t.milestoneId && t.milestoneId !== cur.milestoneId ? await loadMilestone(p.id, t.milestoneId) : null;
    const status = t.status ?? (t.done === undefined ? undefined : t.done ? "done" : cur.status === "done" ? "todo" : cur.status);
    const [row] = await db()
      .update(schema.projectTasks)
      .set({
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(status !== undefined ? { status, done: status === "done", doneAt: status === "done" ? (cur.doneAt ?? new Date()) : null } : {}),
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        ...(t.assigneeId !== undefined ? { assigneeId: t.assigneeId } : {}),
        ...(t.dueDate !== undefined ? { dueDate: t.dueDate } : {}),
        ...(t.estimateHours !== undefined ? { estimateMinutes: t.estimateHours == null ? null : Math.round(t.estimateHours * 60) } : {}),
        ...(target ? { milestoneId: target.id } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectTasks.id, cur.id))
      .returning();
    if (target) await db().update(schema.timesheetEntries).set({ milestoneId: target.id }).where(eq(schema.timesheetEntries.taskId, cur.id));
    await syncMilestone(row.milestoneId);
    if (target) await syncMilestone(cur.milestoneId);
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row);
  })
  .delete("/:id/tasks/:tid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const cur = await loadTask(p.id, c.req.param("tid"));
    // the time stays on the project (and its milestone), no longer on a task
    await db().update(schema.timesheetEntries).set({ taskId: null }).where(eq(schema.timesheetEntries.taskId, cur.id));
    await db().delete(schema.projectTasks).where(eq(schema.projectTasks.id, cur.id));
    await syncMilestone(cur.milestoneId);
    return c.json({ ok: true });
  })
  /** An internal note, or a reply to the client: saved on the task and emailed to the contacts picked (one message each) */
  .post("/:id/tasks/:tid/notes", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const task = await loadTask(p.id, c.req.param("tid"));
    const n = await body(c, z.object({ text: z.string().trim().min(1).max(8000), kind: z.enum(["internal", "reply"]).optional(), to: z.array(z.string().trim().toLowerCase().email().max(200)).max(10).optional() }));
    const kind = n.kind ?? "internal";
    const to = [...new Set(n.to ?? [])];
    if (kind === "reply") {
      if (!p.clientId) throw new HTTPException(409, { message: "project_no_client" });
      if (!to.length) throw new HTTPException(400, { message: "reply_needs_recipient" });
    }
    const sent: string[] = [];
    const failed: string[] = [];
    if (kind === "reply") {
      const subject = `[${p.number}] ${task.title}`.slice(0, 250);
      const sign = `${a.realUser.name}\nAKAB Informatique`;
      const text = ["Bonjour,", "", n.text, "", "—", sign].join("\n");
      const html = `<p>Bonjour,</p><p style="white-space:pre-wrap">${escapeHtml(n.text)}</p><p>—<br>${escapeHtml(a.realUser.name)}<br>AKAB Informatique</p><p style="color:#777;font-size:12px">${escapeHtml(p.number)} · ${escapeHtml(p.name)}</p>`;
      for (const addr of to) (await sendMail({ to: addr, subject, text, html, replyTo: a.realUser.email })) ? sent.push(addr) : failed.push(addr);
      await audit(a.user.id, sent.length ? "project.task_reply_emailed" : "project.task_reply_email_failed", task.id, { to: sent.length ? sent : failed });
    }
    const [row] = await db().insert(schema.projectTaskNotes).values({ taskId: task.id, authorId: a.user.id, text: n.text, kind, emailedTo: sent }).returning();
    await db().update(schema.projectTasks).set({ updatedAt: new Date() }).where(eq(schema.projectTasks.id, task.id));
    return c.json({ ...row, emailed: kind === "reply" ? failed.length === 0 : null, failed }, 201);
  })
  .delete("/:id/tasks/:tid/notes/:nid", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const task = await loadTask(p.id, c.req.param("tid"));
    const [cur] = await db().select().from(schema.projectTaskNotes).where(and(eq(schema.projectTaskNotes.id, zUuid.parse(c.req.param("nid"))), eq(schema.projectTaskNotes.taskId, task.id)));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.authorId !== a.user.id && !a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
    await db().delete(schema.projectTaskNotes).where(eq(schema.projectTaskNotes.id, cur.id));
    return c.json({ ok: true });
  })
  // the timer of a task: started, then stopped into a time entry (hours, note and billable can be changed on the way)
  .post("/:id/tasks/:tid/timer/start", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    if (p.status === "done" || p.status === "cancelled") throw new HTTPException(409, { message: "project_closed" });
    const task = await loadTask(p.id, c.req.param("tid"));
    await db().insert(schema.projectTaskTimers).values({ taskId: task.id, userId: a.user.id }).onConflictDoNothing();
    // work has begun
    if (task.status === "todo") {
      await db().update(schema.projectTasks).set({ status: "doing", updatedAt: new Date() }).where(eq(schema.projectTasks.id, task.id));
      await syncMilestone(task.milestoneId);
    }
    const [t] = await db().select().from(schema.projectTaskTimers).where(and(eq(schema.projectTaskTimers.taskId, task.id), eq(schema.projectTaskTimers.userId, a.user.id)));
    return c.json({ startedAt: t.startedAt });
  })
  .post("/:id/tasks/:tid/timer/stop", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("timesheets.use")) throw new HTTPException(403, { message: "Forbidden" });
    const p = await loadProject(c.req.param("id"));
    const task = await loadTask(p.id, c.req.param("tid"));
    const [timer] = await db().select().from(schema.projectTaskTimers).where(and(eq(schema.projectTaskTimers.taskId, task.id), eq(schema.projectTaskTimers.userId, a.user.id)));
    if (!timer) throw new HTTPException(409, { message: "timer_not_running" });
    const o = await body(c, z.object({ discard: z.boolean().optional(), hours: z.number().min(0.05).max(24).optional(), note: z.string().trim().max(500).optional(), billable: z.boolean().optional(), date: zDay.optional() }));
    if (o.discard) {
      await db().delete(schema.projectTaskTimers).where(and(eq(schema.projectTaskTimers.taskId, task.id), eq(schema.projectTaskTimers.userId, a.user.id)));
      return c.json({ discarded: true });
    }
    const elapsed = Math.max(0.05, Math.round(((Date.now() - timer.startedAt.getTime()) / 3_600_000) * 100) / 100);
    const entry = await logTime(a.user.id, p, task, { date: o.date ?? todayQc(), hours: o.hours ?? Math.min(24, elapsed), note: o.note, billable: o.billable });
    await db().delete(schema.projectTaskTimers).where(and(eq(schema.projectTaskTimers.taskId, task.id), eq(schema.projectTaskTimers.userId, a.user.id)));
    return c.json(entry);
  })

  // ── notes ──
  .post("/:id/notes", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const n = await body(c, z.object({ text: z.string().trim().min(1).max(8000) }));
    const [row] = await db().insert(schema.projectNotes).values({ projectId: p.id, authorId: a.user.id, text: n.text }).returning();
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row, 201);
  })
  .delete("/:id/notes/:nid", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const nid = zUuid.parse(c.req.param("nid"));
    const [cur] = await db().select().from(schema.projectNotes).where(and(eq(schema.projectNotes.id, nid), eq(schema.projectNotes.projectId, p.id)));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.authorId !== a.user.id && !a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
    await db().delete(schema.projectNotes).where(eq(schema.projectNotes.id, cur.id));
    return c.json({ ok: true });
  })

  // ── time: an entry of the person's own timesheet, tied to the project (and a milestone, and a task) ──
  .post("/:id/time", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    if (!a.permissions.includes("timesheets.use")) throw new HTTPException(403, { message: "Forbidden" });
    const p = await loadProject(c.req.param("id"));
    if (p.status === "done" || p.status === "cancelled") throw new HTTPException(409, { message: "project_closed" });
    const t = await body(c, z.object({ date: zDay, hours: z.number().min(0.05).max(24), milestoneId: zUuid.nullable().optional(), taskId: zUuid.nullable().optional(), note: z.string().trim().max(500).optional(), billable: z.boolean().optional() }));
    const task = t.taskId ? await loadTask(p.id, t.taskId) : null;
    const ms = task ? await loadMilestone(p.id, task.milestoneId) : t.milestoneId ? await loadMilestone(p.id, t.milestoneId) : null;
    return c.json(await logTime(a.user.id, p, task, { date: t.date, hours: t.hours, note: t.note, billable: t.billable }, ms), 201);
  })
  /** Change one entry of time on this project: billable (or included), its note. Its owner, or a manager. */
  .patch("/:id/time/:eid", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const [e] = await db().select().from(schema.timesheetEntries).where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("eid"))), eq(schema.timesheetEntries.projectId, p.id)));
    if (!e) throw new HTTPException(404, { message: "not_found" });
    if (e.userId !== a.user.id && !a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
    const o = await body(c, z.object({ billable: z.boolean().optional(), note: z.string().trim().max(500).nullable().optional() }));
    // billed already: the work to bill is settled
    if (o.billable !== undefined) {
      const [billed] = await db().select({ id: schema.billingItems.id }).from(schema.billingItems).where(and(eq(schema.billingItems.sourceId, `prtime:${e.id}`), inArray(schema.billingItems.status, ["posted"]))).limit(1);
      if (billed) throw new HTTPException(409, { message: "time_billed" });
    }
    await db()
      .update(schema.timesheetEntries)
      .set({ ...(o.billable !== undefined ? { billableX100: o.billable ? e.hoursX100 : 0 } : {}), ...(o.note !== undefined ? { note: o.note || null } : {}) })
      .where(eq(schema.timesheetEntries.id, e.id));
    return c.json({ ok: true });
  });

async function loadTask(projectId: string, id: string) {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [t] = await db().select().from(schema.projectTasks).where(and(eq(schema.projectTasks.id, r.data), eq(schema.projectTasks.projectId, projectId)));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  return t;
}

/** A milestone is reached when all its tasks are done; under way once one is started or done; waiting otherwise. One with no task keeps what was set by hand. */
async function syncMilestone(milestoneId: string) {
  const d = db();
  const tasks = await d.select({ status: schema.projectTasks.status }).from(schema.projectTasks).where(eq(schema.projectTasks.milestoneId, milestoneId));
  if (!tasks.length) return;
  const status = tasks.every((t) => t.status === "done") ? "done" : tasks.some((t) => t.status !== "todo") ? "doing" : "todo";
  const [cur] = await d.select({ status: schema.projectMilestones.status, doneAt: schema.projectMilestones.doneAt }).from(schema.projectMilestones).where(eq(schema.projectMilestones.id, milestoneId));
  if (!cur || cur.status === status) return;
  await d.update(schema.projectMilestones).set({ status, doneAt: status === "done" ? new Date() : null, updatedAt: new Date() }).where(eq(schema.projectMilestones.id, milestoneId));
}

/**
 * An entry of the person's own timesheet on a project: billable by default when the project is billed by the hour, included
 * when it is a fixed price (the entry can be set either way). The week must still be open.
 */
async function logTime(
  userId: string,
  p: Project,
  task: { id: string; milestoneId: string; title: string } | null,
  t: { date: string; hours: number; note?: string; billable?: boolean },
  milestone?: { id: string; name: string } | null,
) {
  const ms = milestone ?? (task ? await loadMilestone(p.id, task.milestoneId) : null);
  const sheet = await sheetOf(userId, weekStartOf(t.date));
  if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
  const type = await labourType();
  const hoursX100 = Math.round(t.hours * 100);
  const billable = t.billable ?? p.billingMode === "hourly";
  const banked = await bankByDefault(userId);
  const [row] = await db()
    .insert(schema.timesheetEntries)
    .values({
      userId,
      date: t.date,
      typeId: type.id,
      hoursX100,
      note: t.note || null,
      ticketNumber: p.number,
      ticketTitle: `${p.name}${ms ? ` · ${ms.name}` : ""}${task ? ` · ${task.title}` : ""}`.slice(0, 250),
      projectId: p.id,
      milestoneId: ms?.id ?? null,
      taskId: task?.id ?? null,
      billableX100: billable ? hoursX100 : 0,
      banked,
      source: "project",
    })
    .returning();
  await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
  return { id: row.id, date: row.date, hours: row.hoursX100 / 100, billable };
}
