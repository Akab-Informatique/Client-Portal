import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notify } from "../lib/notify.ts";
import { notifyTechs } from "../lib/techNotify.ts";
import { splitBillable } from "../lib/hr.ts";
import { addDays, editable, labourType, sheetOf, todayQc, weekStartOf } from "../lib/timesheets.ts";
import { billingSettings } from "../lib/billing.ts";
import { syncBillablesNow } from "../lib/billables.ts";
import { chargesOfProject, moveCharge } from "../lib/chargeMove.ts";
import { hourlyRateOf } from "../lib/contracts.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { body, zUuid } from "../lib/validate.ts";
import { billProject, depositOfProject, linkTicket, ProjectBillError, projectBilling, projectOfTicket, ticketsOfProject } from "../lib/projectLinks.ts";

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
const PROJECT_FILE_BYTES = 5 * 1024 * 1024;

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

/** The contract a project is billed under: one of the client's own, active (null with none picked) */
async function contractOf(clientId: string | null, contractId: string | null | undefined) {
  if (!contractId) return null;
  if (!clientId) throw new HTTPException(400, { message: "contract_needs_client" });
  const [k] = await db().select().from(schema.clientContracts).where(and(eq(schema.clientContracts.id, contractId), eq(schema.clientContracts.clientId, clientId)));
  if (!k) throw new HTTPException(400, { message: "contract_invalid" });
  return k;
}

/** The day of the next follow-up: N days after the later of today and the start */
const nextCheckpoint = (every: number, start: string | null) => addDays(start && start > todayQc() ? start : todayQc(), every);

/** The cards: milestones with their task and time figures, the team, whether I follow it, what needs attention. */
async function cards(rows: Project[], me: string, withTasks = false) {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const today = todayQc();
  const [milestones, tasks, members, followers, hours, clients, users, contracts] = await Promise.all([
    // (the contracts of the projects billed under one are read last)
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
    d.select().from(schema.clientContracts).where(inArray(schema.clientContracts.id, rows.map((r) => r.contractId).filter((x): x is string => Boolean(x)).concat("00000000-0000-0000-0000-000000000000"))),
  ]);
  const usual = (await billingSettings()).rates.hourly;
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
        startDate: m.startDate,
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
      if (p.checkpointEveryDays && p.checkpointDate && p.checkpointDate <= today) attention.push("followup_due");
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
      contract: (() => {
        const k = contracts.find((x) => x.id === p.contractId);
        if (!k) return null;
        const r = hourlyRateOf(k, usual);
        return { id: k.id, name: k.name, hourlyRate: r == null ? null : r / 100 };
      })(),
      checkpointEveryDays: p.checkpointEveryDays,
      checkpointDate: p.checkpointDate,
      lastFollowupOn: p.lastFollowupOn,
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

/** The reminders of a project, open ones first by day, then the done ones */
async function remindersOf(projectId: string) {
  const rows = await db()
    .select({ id: schema.projectReminders.id, remindOn: schema.projectReminders.remindOn, text: schema.projectReminders.text, doneAt: schema.projectReminders.doneAt, userId: schema.projectReminders.userId, user: schema.users.name })
    .from(schema.projectReminders)
    .leftJoin(schema.users, eq(schema.users.id, schema.projectReminders.userId))
    .where(eq(schema.projectReminders.projectId, projectId))
    .orderBy(asc(schema.projectReminders.remindOn));
  return [...rows.filter((r) => !r.doneAt), ...rows.filter((r) => r.doneAt)].map((r) => ({ id: r.id, remindOn: r.remindOn, text: r.text, done: Boolean(r.doneAt), userId: r.userId, user: r.user ?? null }));
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
  billingMode: z.enum(["hourly", "fixed", "contract", "special"]).optional(),
  /** The client contract the time is billed under (billingMode contract) */
  contractId: zUuid.nullable().optional(),
  /** Follow up every N days, from this day (none: N days from now) */
  checkpointEveryDays: z.number().int().min(1).max(365).nullable().optional(),
  checkpointDate: zDay.nullable().optional(),
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
    // sorted by the checkpoint of the next open task (day, then time); a project with none follows, by its due day
    const next = rows.length
      ? await db()
          .select({ projectId: schema.projectTasks.projectId, at: sql<string>`min(${schema.projectTasks.checkpointDate} || ' ' || coalesce(${schema.projectTasks.checkpointTime}, '17:00'))` })
          .from(schema.projectTasks)
          .where(and(inArray(schema.projectTasks.projectId, rows.map((r) => r.id)), ne(schema.projectTasks.status, "done"), sql`${schema.projectTasks.checkpointDate} is not null`))
          .groupBy(schema.projectTasks.projectId)
      : [];
    const nextAt = new Map(next.map((n) => [n.projectId, n.at]));
    list = list
      .map((x) => ({ ...x, nextCheckpoint: nextAt.get(x.id) ?? null }))
      .sort((x, y) => (x.nextCheckpoint ?? "9999-99-99").localeCompare(y.nextCheckpoint ?? "9999-99-99") || (x.dueDate ?? "9999-99-99").localeCompare(y.dueDate ?? "9999-99-99"));
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
    const mode = p.billingMode ?? "hourly";
    if (mode === "contract") {
      if (!p.contractId) throw new HTTPException(400, { message: "contract_required" });
      await contractOf(p.clientId ?? null, p.contractId);
    }
    if (mode === "special" && (p.hourlyRate == null || p.hourlyRate <= 0)) throw new HTTPException(400, { message: "rate_required" });
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
          billingMode: mode,
          contractId: mode === "contract" ? p.contractId! : null,
          checkpointEveryDays: p.checkpointEveryDays ?? null,
          checkpointDate: p.checkpointEveryDays ? (p.checkpointDate ?? nextCheckpoint(p.checkpointEveryDays, p.startDate ?? null)) : (p.checkpointDate ?? null),
          hourlyRateCents: mode === "contract" ? null : cents(p.hourlyRate === undefined ? defaultRate : p.hourlyRate),
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
    const reminders = await remindersOf(p.id);
    const [notes, entries, byPerson] = await Promise.all([
      d
        .select({ id: schema.projectNotes.id, text: schema.projectNotes.text, internal: schema.projectNotes.internal, createdAt: schema.projectNotes.createdAt, authorId: schema.projectNotes.authorId, author: schema.users.name, authorKind: schema.users.kind })
        .from(schema.projectNotes)
        .leftJoin(schema.users, eq(schema.users.id, schema.projectNotes.authorId))
        .where(eq(schema.projectNotes.projectId, p.id))
        .orderBy(desc(schema.projectNotes.createdAt))
        .limit(200),
      d
        .select({ id: schema.timesheetEntries.id, date: schema.timesheetEntries.date, hoursX100: schema.timesheetEntries.hoursX100, billableX100: schema.timesheetEntries.billableX100, note: schema.timesheetEntries.note, milestoneId: schema.timesheetEntries.milestoneId, taskId: schema.timesheetEntries.taskId, userId: schema.timesheetEntries.userId, user: schema.users.name, ticketTimeId: schema.timesheetEntries.ticketTimeId, ticketNumber: schema.timesheetEntries.ticketNumber, ticketTitle: schema.timesheetEntries.ticketTitle })
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
    const taskName = new Map(card.milestones.flatMap((m) => (m.tasks ?? []).map((t) => [t.id, t.title] as const)));
    const [tickets, billing, deposit, quote] = await Promise.all([
      ticketsOfProject(p.id),
      projectBilling(p.id),
      depositOfProject(p),
      p.quoteId ? d.select({ id: schema.quotes.id, number: schema.quotes.number }).from(schema.quotes).where(eq(schema.quotes.id, p.quoteId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    ]);
    // sold against worked: hours sold (the budget) and the price sold, against every hour logged (tasks and tickets)
    const soldHours = card.budgetHours;
    const soldCents = p.fixedPriceCents;
    const rateCents = soldHours && soldCents ? Math.round(soldCents / soldHours) : null;
    const sold = {
      hours: soldHours,
      priceCents: soldCents,
      rateCents,
      workedHours: card.hours,
      ticketHours: Math.round(tickets.reduce((n, x) => n + x.hours, 0) * 100) / 100,
      // positive: hours left (under what was sold); negative: worked over it
      diffHours: soldHours == null ? null : Math.round((soldHours - card.hours) * 100) / 100,
      workedValueCents: rateCents == null ? null : Math.round(card.hours * rateCents),
      diffCents: rateCents == null || soldCents == null ? null : soldCents - Math.round(card.hours * rateCents),
    };
    return c.json({
      ...card,
      quote,
      sold,
      tickets,
      billing: { invoicedAt: p.invoicedAt, lines: billing, deposit: deposit ? { number: deposit.number, invoiceId: deposit.invoiceId, subtotalCents: deposit.subtotalCents } : null },
      reminders,
      notes: notes.map((n) => ({ id: n.id, text: n.text, internal: n.internal, fromClient: n.authorKind === "client", createdAt: n.createdAt, authorId: n.authorId, author: n.author ?? null })),
      time: {
        byPerson: byPerson.map((x) => ({ userId: x.userId, name: x.user, hours: x.h / 100 })),
        entries: entries.map((e) => ({ id: e.id, date: e.date, hours: e.hoursX100 / 100, billableHours: (e.billableX100 ?? e.hoursX100) / 100, note: e.note, milestoneId: e.milestoneId, milestone: e.milestoneId ? (msName.get(e.milestoneId) ?? null) : null, task: e.taskId ? (taskName.get(e.taskId) ?? null) : null, ticket: e.ticketTimeId ? { number: e.ticketNumber, title: e.ticketTitle } : null, userId: e.userId, user: e.user })),
      },
    });
  })

  /** The reminders of a project: mine and the team's, open ones first */
  .get("/:id/reminders", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    return c.json(await remindersOf(p.id));
  })
  .post("/:id/reminders", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const r = await body(c, z.object({ remindOn: zDay, text: z.string().trim().min(1).max(500), userId: zUuid.nullable().optional() }));
    const who = r.userId === undefined ? a.user.id : r.userId;
    if (who) await activeStaff([who]);
    await db().insert(schema.projectReminders).values({ projectId: p.id, userId: who, remindOn: r.remindOn, text: r.text, createdBy: a.user.id });
    await audit(a.user.id, "project.reminder_added", p.id, { remindOn: r.remindOn });
    return c.json(await remindersOf(p.id), 201);
  })
  .patch("/:id/reminders/:rid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const r = await body(c, z.object({ done: z.boolean().optional(), remindOn: zDay.optional(), text: z.string().trim().min(1).max(500).optional() }));
    const [row] = await db()
      .update(schema.projectReminders)
      .set({ ...(r.done !== undefined ? { doneAt: r.done ? new Date() : null } : {}), ...(r.remindOn !== undefined ? { remindOn: r.remindOn, notifiedAt: null } : {}), ...(r.text !== undefined ? { text: r.text } : {}) })
      .where(and(eq(schema.projectReminders.id, zUuid.parse(c.req.param("rid"))), eq(schema.projectReminders.projectId, p.id)))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    return c.json(await remindersOf(p.id));
  })
  .delete("/:id/reminders/:rid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    await db().delete(schema.projectReminders).where(and(eq(schema.projectReminders.id, zUuid.parse(c.req.param("rid"))), eq(schema.projectReminders.projectId, p.id)));
    return c.json(await remindersOf(p.id));
  })

  /** The follow-up was done: the next one is N days from today; a few words go to the project's notes */
  .post("/:id/followup", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const r = await body(c, z.object({ note: z.string().trim().max(4000).optional() }));
    if (!p.checkpointEveryDays) throw new HTTPException(409, { message: "no_followup" });
    const [row] = await db()
      .update(schema.projects)
      .set({ lastFollowupOn: todayQc(), checkpointDate: addDays(todayQc(), p.checkpointEveryDays), updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id))
      .returning();
    if (r.note) await db().insert(schema.projectNotes).values({ projectId: p.id, authorId: a.user.id, text: `${r.note}` });
    await audit(a.user.id, "project.followup_done", p.id, {});
    return c.json((await cards([row], a.user.id, true))[0]);
  })

  /** The client's contracts a project can be billed under, with what an hour costs under each */
  .get("/client-contracts/:clientId", requirePermission("projects.view"), async (c) => {
    const clientId = zUuid.parse(c.req.param("clientId"));
    const usual = (await billingSettings()).rates.hourly;
    const rows = await db().select().from(schema.clientContracts).where(and(eq(schema.clientContracts.clientId, clientId), eq(schema.clientContracts.active, true))).orderBy(asc(schema.clientContracts.name));
    return c.json(rows.map((k) => ({ id: k.id, name: k.name, hourlyRate: ((r) => (r == null ? null : r / 100))(hourlyRateOf(k, usual)) })));
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
    const modeNow = p.billingMode ?? cur.billingMode;
    const clientNow = p.clientId !== undefined ? p.clientId : cur.clientId;
    const contractNow = p.contractId !== undefined ? p.contractId : cur.contractId;
    if (modeNow === "contract") {
      if (!contractNow) throw new HTTPException(400, { message: "contract_required" });
      await contractOf(clientNow, contractNow);
    }
    if (modeNow === "special" && (p.hourlyRate !== undefined ? p.hourlyRate : cur.hourlyRateCents == null ? null : cur.hourlyRateCents / 100) == null) throw new HTTPException(400, { message: "rate_required" });
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
        ...(p.contractId !== undefined || p.billingMode !== undefined ? { contractId: modeNow === "contract" ? contractNow : null } : {}),
        ...(p.checkpointEveryDays !== undefined ? { checkpointEveryDays: p.checkpointEveryDays, ...(p.checkpointEveryDays === null ? { checkpointDate: null } : p.checkpointDate === undefined && !cur.checkpointDate ? { checkpointDate: nextCheckpoint(p.checkpointEveryDays, cur.startDate) } : {}) } : {}),
        ...(p.checkpointDate !== undefined ? { checkpointDate: p.checkpointDate } : {}),
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
    await db().update(schema.ticketMeta).set({ projectId: null }).where(eq(schema.ticketMeta.projectId, cur.id));
    await db().delete(schema.projects).where(eq(schema.projects.id, cur.id));
    await audit(a.user.id, "project.deleted", cur.id, { number: cur.number, name: cur.name });
    return c.json({ ok: true });
  })

  // ── tickets of the project (their time counts in it) ──
  /** Open tickets of the project's client (to pick one), searched by number or title */
  .get("/:id/ticket-candidates", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const [client] = p.clientId ? await db().select({ at: schema.clients.autotaskId }).from(schema.clients).where(eq(schema.clients.id, p.clientId)) : [];
    const rows = await db()
      .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, company: schema.tickets.companyName, projectId: schema.ticketMeta.projectId })
      .from(schema.tickets)
      .leftJoin(schema.ticketMeta, eq(schema.ticketMeta.ticketId, schema.tickets.id))
      .where(and(isNull(schema.tickets.completedAt), client?.at != null ? eq(schema.tickets.companyId, client.at) : undefined))
      .orderBy(desc(schema.tickets.createdAt))
      .limit(500);
    return c.json(
      rows
        .filter((r) => r.projectId !== p.id && (!q || `${r.number} ${r.title}`.toLowerCase().includes(q)))
        .slice(0, 30)
        .map((r) => ({ id: r.id, number: r.number, title: r.title, company: r.company, otherProject: Boolean(r.projectId) })),
    );
  })
  /** Tie a ticket to the project (by its id or its number): its time, before and after, counts in the project */
  .post("/:id/tickets", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const r = await body(c, z.object({ ticket: z.union([z.number().int().positive(), z.string().trim().min(1).max(40)]) }));
    const [t] = await db()
      .select({ id: schema.tickets.id, number: schema.tickets.number, companyId: schema.tickets.companyId })
      .from(schema.tickets)
      .where(typeof r.ticket === "number" ? eq(schema.tickets.id, r.ticket) : sql`upper(${schema.tickets.number}) = ${r.ticket.toUpperCase()}`);
    if (!t) throw new HTTPException(404, { message: "ticket_not_found" });
    if (p.clientId) {
      const [client] = await db().select({ at: schema.clients.autotaskId }).from(schema.clients).where(eq(schema.clients.id, p.clientId));
      if (client?.at != null && client.at !== t.companyId) throw new HTTPException(409, { message: "ticket_other_client" });
    }
    const was = await projectOfTicket(t.id);
    await linkTicket(t.id, p.id);
    await audit(a.user.id, "project.ticket_linked", p.id, { number: p.number, ticket: t.number, ...(was && was !== p.id ? { from: was } : {}) });
    return c.json(await ticketsOfProject(p.id), 201);
  })
  .delete("/:id/tickets/:ticketId", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId) || (await projectOfTicket(ticketId)) !== p.id) throw new HTTPException(404, { message: "not_found" });
    await linkTicket(ticketId, null);
    await audit(a.user.id, "project.ticket_unlinked", p.id, { number: p.number, ticketId });
    return c.json(await ticketsOfProject(p.id));
  })

  /** The price sold goes to Approbation (one line as the client sees it, less the deposit): accounting.manage */
  .post("/:id/bill", requirePermission("projects.edit"), requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    try {
      const r = await billProject(a.user.id, p.id);
      await audit(a.user.id, "project.billed", p.id, { number: p.number, totalCents: r.totalCents, deposit: r.deposit?.number ?? null });
      return c.json({ lines: r.lines, totalCents: r.totalCents, deposit: r.deposit }, 201);
    } catch (e) {
      if (e instanceof ProjectBillError) throw new HTTPException(e.message === "not_found" ? 404 : 409, { message: e.message });
      throw e;
    }
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
    const m = await body(c, z.object({ name: zName, startDate: zDay.nullable().optional(), dueDate: zDay.nullable().optional(), notes: zText.optional(), budgetHours: zHours.nullable().optional() }));
    checkDays(m.startDate, m.dueDate);
    const [{ n }] = await db().select({ n: sql<number>`coalesce(max(${schema.projectMilestones.position}), -1)::int` }).from(schema.projectMilestones).where(eq(schema.projectMilestones.projectId, p.id));
    const [row] = await db()
      .insert(schema.projectMilestones)
      .values({ projectId: p.id, name: m.name, startDate: m.startDate ?? null, dueDate: m.dueDate ?? null, notes: m.notes ?? "", budgetHoursX100: x100(m.budgetHours), position: n + 1 })
      .returning();
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return c.json(row, 201);
  })
  .patch("/:id/milestones/:mid", requirePermission("projects.edit"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const cur = await loadMilestone(p.id, c.req.param("mid"));
    const m = await body(c, z.object({ name: zName.optional(), notes: zText.optional(), status: zMsStatus.optional(), startDate: zDay.nullable().optional(), dueDate: zDay.nullable().optional(), budgetHours: zHours.nullable().optional() }));
    checkDays(m.startDate === undefined ? cur.startDate : m.startDate, m.dueDate === undefined ? cur.dueDate : m.dueDate);
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
        ...(m.startDate !== undefined ? { startDate: m.startDate } : {}),
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
    const t = await body(c, z.object({ title: zName, description: zText.optional(), priority: zPriority.optional(), assigneeId: zUuid.nullable().optional(), dueDate: zDay.nullable().optional(), checkpointDate: zDay.nullable().optional(), checkpointTime: z.string().regex(/^d{2}:d{2}$/).nullable().optional(), estimateHours: zHours.nullable().optional() }));
    if (t.assigneeId) await activeStaff([t.assigneeId]);
    const [{ n }] = await db().select({ n: sql<number>`coalesce(max(${schema.projectTasks.position}), -1)::int` }).from(schema.projectTasks).where(eq(schema.projectTasks.milestoneId, m.id));
    const [row] = await db()
      .insert(schema.projectTasks)
      .values({ projectId: p.id, milestoneId: m.id, title: t.title, description: t.description ?? "", priority: t.priority ?? "normal", assigneeId: t.assigneeId ?? null, dueDate: t.dueDate ?? null, checkpointDate: t.checkpointDate ?? null, checkpointTime: t.checkpointDate ? (t.checkpointTime ?? "17:00") : null, estimateMinutes: t.estimateHours == null ? null : Math.round(t.estimateHours * 60), position: n + 1 })
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
      checkpointDate: task.checkpointDate,
      checkpointTime: task.checkpointTime,
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
        /** Goal day and time (17:00 when a day has no time; no day = no time) */
        checkpointDate: zDay.nullable().optional(),
        checkpointTime: z.string().regex(/^d{2}:d{2}$/).nullable().optional(),
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
        ...(t.checkpointDate !== undefined || t.checkpointTime !== undefined ? (() => { const day = t.checkpointDate === undefined ? cur.checkpointDate : t.checkpointDate; return { checkpointDate: day, checkpointTime: day ? (t.checkpointTime ?? cur.checkpointTime ?? "17:00") : null }; })() : {}),
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
    const n = await body(
      c,
      z.object({
        text: z.string().trim().min(1).max(8000),
        /** internal: staff only (the default); public: also the project's client, in the client portal */
        internal: z.boolean().default(true),
        /** colleagues told about the note: the bell, an email with the note, a Teams chat message (bell and email by default) */
        notifyUserIds: z.array(zUuid).max(20).default([]),
        notifyChannels: z.object({ bell: z.boolean().default(true), email: z.boolean().default(true), chat: z.boolean().default(false) }).default({ bell: true, email: true, chat: false }),
      }),
    );
    const [row] = await db().insert(schema.projectNotes).values({ projectId: p.id, authorId: a.user.id, text: n.text, internal: n.internal }).returning();
    await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    // tell colleagues (active staff only, never oneself): the bell, and as ticked an email and a Teams chat message
    let told: Awaited<ReturnType<typeof notifyTechs>> = [];
    if (n.notifyUserIds.length) {
      const link = `/projects?project=${p.id}&tab=notes`;
      told = await notifyTechs(
        { id: 0, number: p.number, title: p.name, company: { name: "" }, link, head: `vous signale une note du projet ${p.number} (${p.name})` },
        { id: a.user.id, name: a.realUser.name },
        n.notifyUserIds,
        n.text,
        { email: n.notifyChannels.email, sms: false, teams: false, bell: false, chat: n.notifyChannels.chat },
      );
      if (n.notifyChannels.bell && told.length) await notify(told.map((x) => x.id), { type: "project.note", data: { by: a.realUser.name, number: p.number, name: p.name, message: n.text.slice(0, 300) }, link });
      await audit(a.user.id, "project.note_notified", p.id, { to: told.map((x) => x.id), channels: n.notifyChannels });
    }
    return c.json({ ...row, notified: told.length, chatNotReady: told.some((x) => x.chat === "not_ready"), notifyFailed: told.filter((x) => x.email === "failed" || x.email === "no_address" || x.chat === "failed").length }, 201);
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

  // ── files of the project (a ticket turned into a project brings its files; the team adds more) ──
  .get("/:id/files", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const f = schema.projectFiles;
    return c.json(await db().select({ id: f.id, name: f.name, size: f.size, author: f.author, createdAt: f.createdAt }).from(f).where(eq(f.projectId, p.id)).orderBy(asc(f.createdAt)));
  })
  .post("/:id/files", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const t = await body(c, z.object({ name: z.string().trim().min(1).max(200), contentType: z.string().max(120).default("application/octet-stream"), data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(PROJECT_FILE_BYTES / 3) * 4) }));
    if (!t.data) throw new HTTPException(400, { message: "Validation failed" });
    const size = Math.floor((t.data.length * 3) / 4) - (t.data.endsWith("==") ? 2 : t.data.endsWith("=") ? 1 : 0);
    const [row] = await db().insert(schema.projectFiles).values({ projectId: p.id, name: t.name, contentType: t.contentType, size, data: t.data, author: a.user.name }).returning({ id: schema.projectFiles.id, name: schema.projectFiles.name, size: schema.projectFiles.size });
    await audit(a.user.id, "project.file_added", p.id, { name: t.name, bytes: size });
    return c.json(row, 201);
  })
  /** A file of a project (always a download, never shown in the page) */
  .get("/:id/files/:fid", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    const [f] = await db().select().from(schema.projectFiles).where(and(eq(schema.projectFiles.id, zUuid.parse(c.req.param("fid"))), eq(schema.projectFiles.projectId, p.id)));
    if (!f) throw new HTTPException(404, { message: "not_found" });
    return new Response(Buffer.from(f.data, "base64"), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
  })
  .delete("/:id/files/:fid", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    await db().delete(schema.projectFiles).where(and(eq(schema.projectFiles.id, zUuid.parse(c.req.param("fid"))), eq(schema.projectFiles.projectId, p.id)));
    await audit(a.user.id, "project.file_removed", p.id, { file: c.req.param("fid") });
    return c.json({ ok: true });
  })

  // ── charges put on the project (moved from a ticket, or onto another ticket / project while not approved) ──
  .get("/:id/charges", requirePermission("projects.view"), async (c) => {
    const p = await loadProject(c.req.param("id"));
    return c.json(await chargesOfProject(p.id));
  })
  .post("/:id/charges/:chargeId/move", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const to = await body(c, z.object({ ticketId: z.number().int().positive().optional(), projectId: zUuid.optional() }).refine((v) => (v.ticketId == null) !== (v.projectId == null)));
    if (to.ticketId && !a.permissions.includes("tickets.edit")) throw new HTTPException(403, { message: "Forbidden" });
    const chargeId = c.req.param("chargeId");
    const moved = await moveCharge(chargeId, { projectId: p.id }, to.projectId ? { projectId: to.projectId } : { ticketId: to.ticketId! });
    await audit(a.user.id, "project.charge_moved", p.id, { chargeId, to: to.projectId ? `project:${to.projectId}` : `ticket:${to.ticketId}`, number: moved.number });
    await syncBillablesNow();
    return c.json({ moved: true, to: moved.number, kind: moved.kind, charges: await chargesOfProject(p.id) });
  })

  // ── time: an entry of the person's own timesheet, tied to the project (and a milestone, and a task) ──
  .post("/:id/time", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    if (p.status === "done" || p.status === "cancelled") throw new HTTPException(409, { message: "project_closed" });
    const t = await body(c, z.object({ date: zDay, hours: z.number().min(0.05).max(24), milestoneId: zUuid.nullable().optional(), taskId: zUuid.nullable().optional(), note: z.string().trim().max(500).optional(), billable: z.boolean().optional(), userId: zUuid.optional() }));
    // time for someone else: a manager only (it goes on that person's timesheet)
    const forOther = t.userId && t.userId !== a.user.id;
    if (forOther) {
      if (!a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
      await activeStaff([t.userId!]);
    } else if (!a.permissions.includes("timesheets.use")) throw new HTTPException(403, { message: "Forbidden" });
    const task = t.taskId ? await loadTask(p.id, t.taskId) : null;
    const ms = task ? await loadMilestone(p.id, task.milestoneId) : t.milestoneId ? await loadMilestone(p.id, t.milestoneId) : null;
    const made = await logTime(forOther ? t.userId! : a.user.id, p, task, { date: t.date, hours: t.hours, note: t.note, billable: t.billable }, ms);
    if (forOther) await audit(a.user.id, "project.time_added_for", p.id, { entry: made.id, userId: t.userId });
    return c.json(made, 201);
  })
  /** Change one entry of time on this project: billable (or included), its note. Its owner, or a manager. */
  .patch("/:id/time/:eid", requirePermission("projects.edit"), async (c) => {
    const a = auth(c);
    const p = await loadProject(c.req.param("id"));
    const [e] = await db().select().from(schema.timesheetEntries).where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("eid"))), eq(schema.timesheetEntries.projectId, p.id)));
    if (!e) throw new HTTPException(404, { message: "not_found" });
    if (e.userId !== a.user.id && !a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
    const o = await body(c, z.object({ billable: z.boolean().optional(), note: z.string().trim().max(500).nullable().optional(), userId: zUuid.optional() }));
    // whose time it is: a manager changes it (it moves to that person's timesheet)
    const moveTo = o.userId && o.userId !== e.userId ? o.userId : null;
    if (moveTo) {
      if (!a.permissions.includes("projects.manage")) throw new HTTPException(403, { message: "Forbidden" });
      await activeStaff([moveTo]);
      // ticket time counted in a project belongs to its ticket
      if (e.ticketTimeId) throw new HTTPException(409, { message: "time_from_ticket" });
      // both weeks must still be open (the old person's total changes too)
      for (const [uid, day] of [[e.userId, e.date], [moveTo, e.date]] as const) {
        if (!editable((await sheetOf(uid, weekStartOf(day))).status)) throw new HTTPException(409, { message: "timesheet_locked" });
      }
      const [billed] = await db().select({ id: schema.billingItems.id }).from(schema.billingItems).where(and(eq(schema.billingItems.sourceId, `prtime:${e.id}`), eq(schema.billingItems.status, "posted"))).limit(1);
      if (billed) throw new HTTPException(409, { message: "time_billed" });
    }
    // billed already: the work to bill is settled
    if (o.billable !== undefined) {
      const [billed] = await db().select({ id: schema.billingItems.id }).from(schema.billingItems).where(and(eq(schema.billingItems.sourceId, `prtime:${e.id}`), inArray(schema.billingItems.status, ["posted"]))).limit(1);
      if (billed) throw new HTTPException(409, { message: "time_billed" });
    }
    await db()
      .update(schema.timesheetEntries)
      .set({ ...(o.billable !== undefined ? splitBillable(e.hoursX100, o.billable ? e.hoursX100 : 0) : {}), ...(o.note !== undefined ? { note: o.note || null } : {}), ...(moveTo ? { userId: moveTo } : {}) })
      .where(eq(schema.timesheetEntries.id, e.id));
    if (moveTo) {
      await audit(a.user.id, "project.time_person_changed", p.id, { entry: e.id, from: e.userId, to: moveTo });
      // the line to bill carries the person's name: refreshed (a pending one, not edited by hand)
      await syncBillablesNow();
    }
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
  const contract = p.billingMode === "contract" ? await contractOf(p.clientId, p.contractId) : null;
  // billed unless the project is a fixed price, or its contract includes the hours (no hourly rate)
  const billable = t.billable ?? (p.billingMode === "fixed" ? false : contract ? hourlyRateOf(contract, (await billingSettings()).rates.hourly) != null : true);
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
      ...splitBillable(hoursX100, billable ? hoursX100 : 0),
      clientId: p.clientId,
      source: "project",
    })
    .returning();
  await db().update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
  return { id: row.id, date: row.date, hours: row.hoursX100 / 100, billable };
}
