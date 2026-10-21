import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { unpaidLunch } from "../../shared/workday.ts";
import { body, zUuid } from "../lib/validate.ts";
import { addDays, bankBalanceX100, bankByDefault, billableX100, editable, ensureTypes, sheetOf, todayQc, weekEntries, weekStartOf, weekTotals } from "../lib/timesheets.ts";

/**
 * Timesheets and expenses: my week and my expense claims (timesheets.use),
 * their approval (timesheets.approve: hours per type only, not the details;
 * expenses with their receipt), and the types (Admin, admin.billing).
 */
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RECEIPT = 5 * 1024 * 1024;
const zReceipt = z
  .object({
    name: z.string().trim().min(1).max(200),
    contentType: z.string().max(120),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(Math.ceil(MAX_RECEIPT / 3) * 4),
  })
  .nullable()
  .optional();

type Expense = typeof schema.expenses.$inferSelect;
const expenseView = (x: Omit<Expense, "receiptData"> & { receiptData?: string | null; hasReceipt?: boolean }, extra: Record<string, unknown> = {}) => {
  const { receiptData, hasReceipt, ...rest } = x;
  return { ...rest, hasReceipt: hasReceipt ?? Boolean(receiptData), ...extra };
};
/** The expense columns, without the receipt file (lists stay small). */
const { receiptData: _receipt, ...EXPENSE_COLUMNS } = getTableColumns(schema.expenses);
const listColumns = { ...EXPENSE_COLUMNS, hasReceipt: sql<boolean>`(${schema.expenses.receiptData} is not null)` };

/**
 * Whose timesheet: one's own (timesheets.use), or a team member's with
 * timesheets.manage (an active staff account; never a client).
 */
async function timesheetOwner(a: AuthContext, asked: string | undefined): Promise<string> {
  if (!asked || asked === a.user.id) {
    if (!a.permissions.includes("timesheets.use") && !a.permissions.includes("timesheets.manage")) throw new HTTPException(403, { message: "Forbidden" });
    return a.user.id;
  }
  if (!a.permissions.includes("timesheets.manage")) throw new HTTPException(403, { message: "Forbidden" });
  const id = zUuid.parse(asked);
  const [u] = await db().select({ kind: schema.users.kind, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, id));
  if (!u || u.kind !== "staff" || !u.active) throw new HTTPException(404, { message: "not_found" });
  return id;
}

async function ownExpense(id: string, userId: string) {
  const [x] = await db()
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, zUuid.parse(id)), eq(schema.expenses.userId, userId)));
  if (!x) throw new HTTPException(404, { message: "not_found" });
  return x;
}

/** One of my expense reports; `open`: refused once it was submitted (items are locked then). */
async function ownReport(id: string, userId: string, opts: { open?: boolean } = {}) {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [rep] = await db()
    .select()
    .from(schema.expenseReports)
    .where(and(eq(schema.expenseReports.id, r.data), eq(schema.expenseReports.userId, userId)));
  if (!rep) throw new HTTPException(404, { message: "not_found" });
  if (opts.open && rep.submittedAt) throw new HTTPException(409, { message: "report_submitted" });
  return rep;
}

/**
 * Send a report: its items not sent yet (draft, or refused and fixed) go to
 * approval together. Nothing to send: report_empty.
 */
async function submitReport(reportId: string, userId: string) {
  const x = schema.expenses;
  return db().transaction(async (tx) => {
    const sent = await tx
      .update(x)
      .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(x.reportId, reportId), eq(x.userId, userId), inArray(x.status, ["draft", "rejected"])))
      .returning({ id: x.id, amountCents: x.amountCents });
    if (!sent.length) throw new HTTPException(409, { message: "report_empty" });
    await tx.update(schema.expenseReports).set({ submittedAt: new Date(), updatedAt: new Date() }).where(eq(schema.expenseReports.id, reportId));
    return sent;
  });
}

/** The days a report covers: both given, the end not before the start, a year at most */
const zPeriod = z
  .object({ periodStart: zDay, periodEnd: zDay })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "end_before_start", path: ["periodEnd"] })
  .refine((v) => Date.parse(v.periodEnd) - Date.parse(v.periodStart) <= 366 * 86_400_000, { message: "too_long", path: ["periodEnd"] });

/** An item's date must be within its report's period (reports made before periods have none). */
function inPeriod(rep: { periodStart: string | null; periodEnd: string | null }, date: string) {
  if (rep.periodStart && date < rep.periodStart) throw new HTTPException(400, { message: "expense_out_of_period" });
  if (rep.periodEnd && date > rep.periodEnd) throw new HTTPException(400, { message: "expense_out_of_period" });
}

/** Where a report stands, from its items: open (not sent), submitted, approved (all), paid (all). */
function reportStatus(submittedAt: Date | null, items: { status: string }[]) {
  if (!submittedAt || !items.length) return "open";
  if (items.every((i) => i.status === "paid")) return "paid";
  if (items.every((i) => i.status === "approved" || i.status === "paid")) return "approved";
  return "submitted";
}

/** ?from=&to= (YYYY-MM-DD): the time frame asked for, or everything */
function periodOf(q: (k: string) => string | undefined) {
  const v = z.object({ from: zDay.optional(), to: zDay.optional() }).safeParse({ from: q("from") || undefined, to: q("to") || undefined });
  if (!v.success || (v.data.from && v.data.to && v.data.to < v.data.from)) throw new HTTPException(400, { message: "invalid_period" });
  return v.data;
}

async function activeClient(id: string) {
  const [cl] = await db().select({ active: schema.clients.active }).from(schema.clients).where(eq(schema.clients.id, id));
  if (!cl?.active) throw new HTTPException(400, { message: "client_unknown" });
}

/** Amount from quantity × the type's rate (km…), or the amount typed. */
async function priced(typeId: string, p: { quantity?: number; amountCents?: number }) {
  const [type] = await db().select().from(schema.expenseTypes).where(eq(schema.expenseTypes.id, typeId));
  if (!type || !type.active) throw new HTTPException(400, { message: "expense_type_unknown" });
  if (type.unit && type.unitPriceCents != null) {
    const q = Math.round((p.quantity ?? 0) * 100);
    if (q <= 0) throw new HTTPException(400, { message: "Validation failed" });
    return { type, quantityX100: q, unitPriceCents: type.unitPriceCents, amountCents: Math.round((q * type.unitPriceCents) / 100) };
  }
  if (!p.amountCents || p.amountCents <= 0) throw new HTTPException(400, { message: "Validation failed" });
  return { type, quantityX100: 100, unitPriceCents: p.amountCents, amountCents: p.amountCents };
}

export const timeRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** The active types, for the forms. */
  .get("/types", async (c) => {
    await ensureTypes();
    const d = db();
    const [time, expense] = await Promise.all([
      d
        .select()
        .from(schema.timesheetTypes)
        .where(eq(schema.timesheetTypes.active, true))
        .orderBy(asc(schema.timesheetTypes.position), asc(schema.timesheetTypes.name)),
      d
        .select()
        .from(schema.expenseTypes)
        .where(eq(schema.expenseTypes.active, true))
        .orderBy(asc(schema.expenseTypes.position), asc(schema.expenseTypes.name)),
    ]);
    return c.json({ time, expense });
  })

  // ── Admin › Temps et dépenses ──
  .get("/admin/types", requirePermission("admin.billing"), async (c) => {
    await ensureTypes();
    const d = db();
    return c.json({
      time: await d.select().from(schema.timesheetTypes).orderBy(asc(schema.timesheetTypes.position), asc(schema.timesheetTypes.name)),
      expense: await d.select().from(schema.expenseTypes).orderBy(asc(schema.expenseTypes.position), asc(schema.expenseTypes.name)),
    });
  })
  .post("/admin/timesheet-types", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const [row] = await db().insert(schema.timesheetTypes).values({ name: p.name, kind: "other", position: 100 }).returning();
    await audit(a.user.id, "time.type_created", row.id, { name: p.name });
    return c.json(row, 201);
  })
  .patch("/admin/timesheet-types/:id", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(80), active: z.boolean(), billable: z.boolean(), quickbooksItemId: z.string().max(40).nullable() }).partial(),
    );
    const [cur] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, id));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    // the ticket time type is always there
    if (cur.kind !== "other" && p.active === false) throw new HTTPException(409, { message: "time_type_builtin" });
    // ticket time is billable entry by entry; the work day is never billable time
    if (cur.kind !== "other" && p.billable !== undefined) throw new HTTPException(409, { message: "time_type_builtin" });
    const [row] = await db()
      .update(schema.timesheetTypes)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.timesheetTypes.id, id))
      .returning();
    await audit(a.user.id, "time.type_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })
  .post("/admin/expense-types", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        ledgerAccountId: zUuid.nullable().optional(),
        unit: z.string().trim().max(20).nullable().optional(),
        unitPriceCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
        billable: z.boolean().optional(),
      }),
    );
    const [row] = await db()
      .insert(schema.expenseTypes)
      .values({
        name: p.name,
        ledgerAccountId: p.ledgerAccountId ?? null,
        unit: p.unit || null,
        unitPriceCents: p.unit ? (p.unitPriceCents ?? null) : null,
        billable: p.billable ?? false,
        position: 100,
      })
      .returning();
    await audit(a.user.id, "expense.type_created", row.id, { name: p.name });
    return c.json(row, 201);
  })
  .patch("/admin/expense-types/:id", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(80),
          ledgerAccountId: zUuid.nullable(),
          unit: z.string().trim().max(20).nullable(),
          unitPriceCents: z.number().int().min(0).max(1_000_000).nullable(),
          billable: z.boolean(),
          active: z.boolean(),
        })
        .partial(),
    );
    const [row] = await db()
      .update(schema.expenseTypes)
      .set({ ...p, ...(p.unit === "" ? { unit: null } : {}), updatedAt: new Date() })
      .where(eq(schema.expenseTypes.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "expense.type_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  // ── a timesheet: one's own, or anyone's with timesheets.manage ──
  /** The team members whose timesheet can be managed */
  .get("/people", requirePermission("timesheets.manage"), async (c) => {
    const rows = await db()
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, timesheetRequired: schema.users.timesheetRequired })
      .from(schema.users)
      .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
      .orderBy(asc(schema.users.name));
    return c.json(rows);
  })
  .get("/week", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const owner = await timesheetOwner(a, c.req.query("userId"));
    const weekStart = weekStartOf(c.req.query("start") ? zDay.parse(c.req.query("start")) : todayQc());
    const sheet = await sheetOf(owner, weekStart);
    const rows = await weekEntries(owner, weekStart);
    const [me] = await db().select({ required: schema.users.timesheetRequired }).from(schema.users).where(eq(schema.users.id, owner));
    return c.json({
      userId: owner,
      weekStart,
      /** This person submits weekly timesheets for approval (set by an admin) */
      required: me?.required ?? true,
      weekEnd: addDays(weekStart, 6),
      status: sheet.status,
      comment: sheet.comment,
      entries: rows.map((r) => ({ ...r.e, hours: r.e.hoursX100 / 100, type: r.type, kind: r.kind, billableHours: billableX100(r.e, r.kind, r.typeBillable) / 100 })),
      ...(await weekTotals(owner, weekStart)),
      /** What the hours bank holds (every hour banked, less the ones paid out of it) */
      bankBalanceHours: (await bankBalanceX100(owner)) / 100,
    });
  })
  /**
   * A person's hours over a period (own, or anyone's with timesheets.manage): the work day apart, the hours worked,
   * the billable ones and the ratio, the hours banked instead of paid, per type and per week, and the bank so far.
   */
  .get("/report", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const owner = await timesheetOwner(a, c.req.query("userId"));
    const from = c.req.query("from") ? zDay.parse(c.req.query("from")) : weekStartOf(todayQc());
    const to = c.req.query("to") ? zDay.parse(c.req.query("to")) : addDays(from, 6);
    if (to < from || (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > 800) throw new HTTPException(400, { message: "Validation failed" });
    const d = db();
    const rows = await d
      .select({ e: schema.timesheetEntries, type: schema.timesheetTypes.name, kind: schema.timesheetTypes.kind, typeBillable: schema.timesheetTypes.billable })
      .from(schema.timesheetEntries)
      .innerJoin(schema.timesheetTypes, eq(schema.timesheetTypes.id, schema.timesheetEntries.typeId))
      .where(and(eq(schema.timesheetEntries.userId, owner), gte(schema.timesheetEntries.date, from), lte(schema.timesheetEntries.date, to)));
    const byType = new Map<string, { type: string; kind: string; hours: number; billable: number; banked: number }>();
    const byWeek = new Map<string, { weekStart: string; worked: number; billable: number; banked: number; workday: number }>();
    let workday = 0;
    let worked = 0;
    let billable = 0;
    let banked = 0;
    let bankPaid = 0;
    for (const r of rows) {
      const h = r.e.hoursX100;
      const w = weekStartOf(r.e.date);
      const wk = byWeek.get(w) ?? { weekStart: w, worked: 0, billable: 0, banked: 0, workday: 0 };
      byWeek.set(w, wk);
      if (r.kind === "workday") {
        workday += h;
        wk.workday += h;
        continue;
      }
      if (r.kind === "bankpay") {
        bankPaid += h;
        continue;
      }
      const b = billableX100(r.e, r.kind, r.typeBillable);
      worked += h;
      billable += b;
      wk.worked += h;
      wk.billable += b;
      if (r.e.banked) {
        banked += h;
        wk.banked += h;
      }
      const t = byType.get(r.e.typeId) ?? { type: r.type, kind: r.kind, hours: 0, billable: 0, banked: 0 };
      t.hours += h;
      t.billable += b;
      if (r.e.banked) t.banked += h;
      byType.set(r.e.typeId, t);
    }
    const [u] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, owner));
    const h = (n: number) => n / 100;
    return c.json({
      userId: owner,
      name: u?.name ?? "",
      from,
      to,
      workdayHours: h(workday),
      workedHours: h(worked),
      billableHours: h(billable),
      nonBillableHours: h(worked - billable),
      billableRatio: worked ? Math.round((billable / worked) * 1000) / 10 : null,
      bankedHours: h(banked),
      paidHours: h(worked - banked),
      /** Paid out of the bank in the period */
      bankPaidHours: h(bankPaid),
      /** The bank now: every hour banked, less the ones paid out of it */
      bankBalanceHours: h(await bankBalanceX100(owner)),
      types: [...byType.values()].sort((x, y) => y.hours - x.hours).map((t) => ({ type: t.type, kind: t.kind, hours: h(t.hours), billableHours: h(t.billable), bankedHours: h(t.banked) })),
      weeks: [...byWeek.values()].sort((x, y) => x.weekStart.localeCompare(y.weekStart)).map((w) => ({ weekStart: w.weekStart, workedHours: h(w.worked), billableHours: h(w.billable), bankedHours: h(w.banked), workdayHours: h(w.workday) })),
    });
  })
  .post("/entries", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const p = await body(
      c,
      z.object({
        date: zDay,
        typeId: zUuid,
        hours: z.number().positive().max(24).optional(),
        note: z.string().trim().max(500).optional(),
        userId: zUuid.optional(),
        // a work day: from and to (the lunch rule is in shared/workday.ts)
        start: zTime.optional(),
        end: zTime.optional(),
        // banked instead of paid (none: the person's profile says)
        banked: z.boolean().optional(),
      }),
    );
    const owner = await timesheetOwner(a, p.userId);
    const [type] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, p.typeId));
    // ticket time comes from the tickets only
    if (!type || !type.active || type.kind === "labour") throw new HTTPException(400, { message: "time_type_unknown" });
    const sheet = await sheetOf(owner, weekStartOf(p.date));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    let hours = p.hours ?? 0;
    let workday: { startTime: string; endTime: string; lunchMinutes: number } | null = null;
    if (type.kind === "workday") {
      if (!p.start || !p.end) throw new HTTPException(400, { message: "workday_times" });
      const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const lunch = unpaidLunch(minutes(p.start), minutes(p.end));
      const span = minutes(p.end) - minutes(p.start) - lunch;
      if (span <= 0) throw new HTTPException(400, { message: "workday_times" });
      hours = Math.round((span / 60) * 100) / 100;
      // one work day a day: change it by removing it first
      const [again] = await db()
        .select({ id: schema.timesheetEntries.id })
        .from(schema.timesheetEntries)
        .where(and(eq(schema.timesheetEntries.userId, owner), eq(schema.timesheetEntries.date, p.date), eq(schema.timesheetEntries.typeId, type.id)))
        .limit(1);
      if (again) throw new HTTPException(409, { message: "workday_exists" });
      workday = { startTime: p.start, endTime: p.end, lunchMinutes: lunch };
    } else if (!p.hours) throw new HTTPException(400, { message: "Validation failed" });
    // hours paid out of the bank: no more than the bank holds
    if (type.kind === "bankpay" && Math.round(hours * 100) > (await bankBalanceX100(owner))) throw new HTTPException(409, { message: "bank_insufficient" });
    const [row] = await db()
      .insert(schema.timesheetEntries)
      .values({ userId: owner, date: p.date, typeId: type.id, hoursX100: Math.round(hours * 100), note: p.note || null, source: "manual", banked: type.kind === "workday" || type.kind === "bankpay" ? false : (p.banked ?? (await bankByDefault(owner))), ...(workday ?? {}) })
      .returning();
    if (owner !== a.user.id) await audit(a.user.id, "timesheet.entry_added_for", owner, { date: p.date, hours });
    return c.json(row, 201);
  })
  .delete("/entries/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const manager = a.permissions.includes("timesheets.manage");
    const [e] = await db()
      .select()
      .from(schema.timesheetEntries)
      .where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("id"))), manager ? undefined : eq(schema.timesheetEntries.userId, a.user.id)));
    if (!e || e.source !== "manual") throw new HTTPException(404, { message: "not_found" });
    const sheet = await sheetOf(e.userId, weekStartOf(e.date));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    // banked hours already paid out cannot be taken back
    if (e.banked && (await bankBalanceX100(e.userId, e.id)) < 0) throw new HTTPException(409, { message: "bank_in_use" });
    await db().delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, e.id));
    if (e.userId !== a.user.id) await audit(a.user.id, "timesheet.entry_removed_for", e.userId, { date: e.date });
    return c.json({ ok: true });
  })
  .post("/week/submit", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ weekStart: zDay, userId: zUuid.optional() }));
    const owner = await timesheetOwner(a, p.userId);
    const sheet = await sheetOf(owner, weekStartOf(p.weekStart));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    const [me] = await db().select({ required: schema.users.timesheetRequired }).from(schema.users).where(eq(schema.users.id, owner));
    if (me && !me.required) throw new HTTPException(409, { message: "timesheet_not_required" });
    const [row] = await db()
      .update(schema.timesheets)
      .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.timesheets.id, sheet.id))
      .returning();
    await audit(a.user.id, "timesheet.submitted", row.id, { weekStart: row.weekStart, ...(owner !== a.user.id ? { for: owner } : {}) });
    return c.json(row);
  })

  // ── my expense reports: items added while open, then sent together ──
  .get("/expense-reports", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const [reports, rows] = await Promise.all([
      db().select().from(schema.expenseReports).where(eq(schema.expenseReports.userId, a.user.id)).orderBy(desc(schema.expenseReports.createdAt)),
      db()
        .select({ x: listColumns, type: schema.expenseTypes.name, client: schema.clients.name })
        .from(schema.expenses)
        .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
        .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
        .where(eq(schema.expenses.userId, a.user.id))
        .orderBy(asc(schema.expenses.date), asc(schema.expenses.createdAt)),
    ]);
    const out = reports.map((r) => {
      const items = rows.filter((x) => x.x.reportId === r.id).map((x) => expenseView(x.x, { type: x.type, clientName: x.client }));
      const dates = items.map((i) => i.date).sort();
      return {
        id: r.id,
        title: r.title,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        submittedAt: r.submittedAt,
        createdAt: r.createdAt,
        status: reportStatus(r.submittedAt, items),
        // refused items to fix (the report is open again)
        rejected: items.filter((i) => i.status === "rejected").length,
        totalCents: items.reduce((s, i) => s + i.amountCents, 0),
        from: dates[0] ?? null,
        to: dates.at(-1) ?? null,
        items,
      };
    });
    // open ones first, then the latest
    out.sort((p, q) => Number(q.status === "open") - Number(p.status === "open"));
    return c.json(out);
  })
  .post("/expense-reports", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ title: z.string().trim().min(1).max(120) }).and(zPeriod));
    const [row] = await db()
      .insert(schema.expenseReports)
      .values({ userId: a.user.id, title: p.title, periodStart: p.periodStart, periodEnd: p.periodEnd })
      .returning();
    return c.json(row, 201);
  })
  /** Rename, or change the days covered (its items must stay within). */
  .patch("/expense-reports/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a.user.id, { open: true });
    const p = await body(
      c,
      z
        .object({ title: z.string().trim().min(1).max(120).optional(), periodStart: zDay.optional(), periodEnd: zDay.optional() })
        .refine((v) => !v.periodStart === !v.periodEnd, { message: "period_incomplete" })
        .refine((v) => !v.periodStart || zPeriod.safeParse(v).success, { message: "invalid_period", path: ["periodEnd"] }),
    );
    if (p.periodStart && p.periodEnd) {
      const dates = await db().select({ date: schema.expenses.date }).from(schema.expenses).where(eq(schema.expenses.reportId, rep.id));
      if (dates.some((d) => d.date < p.periodStart! || d.date > p.periodEnd!)) throw new HTTPException(409, { message: "report_period_items" });
    }
    await db()
      .update(schema.expenseReports)
      .set({
        ...(p.title ? { title: p.title } : {}),
        ...(p.periodStart && p.periodEnd ? { periodStart: p.periodStart, periodEnd: p.periodEnd } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.expenseReports.id, rep.id));
    return c.json({ ok: true });
  })
  /** An open report goes with its items, unless one of them was already approved or paid. */
  .delete("/expense-reports/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a.user.id, { open: true });
    const [locked] = await db()
      .select({ id: schema.expenses.id })
      .from(schema.expenses)
      .where(and(eq(schema.expenses.reportId, rep.id), inArray(schema.expenses.status, ["submitted", "approved", "paid"])))
      .limit(1);
    if (locked) throw new HTTPException(409, { message: "expense_locked" });
    await db().delete(schema.expenseReports).where(eq(schema.expenseReports.id, rep.id));
    return c.json({ ok: true });
  })
  .post("/expense-reports/:id/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a.user.id, { open: true });
    const sent = await submitReport(rep.id, a.user.id);
    await audit(a.user.id, "expense.submitted", rep.id, { count: sent.length, amountCents: sent.reduce((s, x) => s + x.amountCents, 0) });
    return c.json({ submitted: sent.length });
  })

  // ── my favourite expenses (the same trip, parking…) ──
  .get("/expense-favorites", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ f: schema.expenseFavorites, type: schema.expenseTypes.name, client: schema.clients.name })
      .from(schema.expenseFavorites)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenseFavorites.typeId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenseFavorites.clientId))
      .where(and(eq(schema.expenseFavorites.userId, a.user.id), eq(schema.expenseTypes.active, true)))
      .orderBy(asc(schema.expenseFavorites.name));
    return c.json(rows.map((r) => ({ ...r.f, type: r.type, clientName: r.client })));
  })
  .post("/expense-favorites", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        typeId: zUuid,
        description: z.string().trim().max(500).default(""),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
      }),
    );
    const pr = await priced(p.typeId, p);
    if (p.clientId) await activeClient(p.clientId);
    const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.expenseFavorites).where(eq(schema.expenseFavorites.userId, a.user.id));
    if (n >= 30) throw new HTTPException(409, { message: "too_many_favorites" });
    const byUnit = Boolean(pr.type.unit && pr.type.unitPriceCents != null);
    const [row] = await db()
      .insert(schema.expenseFavorites)
      .values({
        userId: a.user.id,
        name: p.name,
        typeId: pr.type.id,
        description: p.description,
        quantityX100: byUnit ? pr.quantityX100 : null,
        amountCents: byUnit ? null : pr.amountCents,
        clientId: p.clientId ?? null,
        billable: Boolean(p.clientId) && (p.billable ?? pr.type.billable),
      })
      .returning();
    return c.json(row, 201);
  })
  .delete("/expense-favorites/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const [row] = await db()
      .delete(schema.expenseFavorites)
      .where(and(eq(schema.expenseFavorites.id, zUuid.parse(c.req.param("id"))), eq(schema.expenseFavorites.userId, a.user.id)))
      .returning({ id: schema.expenseFavorites.id });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  // ── my expenses (the items) ──
  .get("/expenses", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ x: listColumns, type: schema.expenseTypes.name, client: schema.clients.name })
      .from(schema.expenses)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
      .where(eq(schema.expenses.userId, a.user.id))
      .orderBy(desc(schema.expenses.date), desc(schema.expenses.createdAt));
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, clientName: r.client })));
  })
  .post("/expenses", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        date: zDay,
        typeId: zUuid,
        description: z.string().trim().min(1).max(500),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
        // the open report it goes in; none: a report of its own
        reportId: zUuid.optional(),
      }),
    );
    const pr = await priced(p.typeId, p);
    if (p.clientId) await activeClient(p.clientId);
    let reportId: string;
    if (p.reportId) {
      const rep = await ownReport(p.reportId, a.user.id, { open: true });
      inPeriod(rep, p.date);
      reportId = rep.id;
    } else {
      const [rep] = await db()
        .insert(schema.expenseReports)
        .values({ userId: a.user.id, title: p.description.slice(0, 120), periodStart: p.date, periodEnd: p.date })
        .returning();
      reportId = rep.id;
    }
    const [row] = await db()
      .insert(schema.expenses)
      .values({
        userId: a.user.id,
        reportId,
        date: p.date,
        typeId: pr.type.id,
        description: p.description,
        quantityX100: pr.quantityX100,
        unitPriceCents: pr.unitPriceCents,
        amountCents: pr.amountCents,
        clientId: p.clientId ?? null,
        billable: Boolean(p.clientId) && (p.billable ?? pr.type.billable),
        receiptName: p.receipt?.name ?? null,
        receiptType: p.receipt?.contentType ?? null,
        receiptData: p.receipt?.data ?? null,
      })
      .returning();
    return c.json(expenseView(row), 201);
  })
  .patch("/expenses/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    const p = await body(
      c,
      z.object({
        date: zDay.optional(),
        typeId: zUuid.optional(),
        description: z.string().trim().min(1).max(500).optional(),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
      }),
    );
    if (p.date && cur.reportId) inPeriod(await ownReport(cur.reportId, a.user.id), p.date);
    const pr =
      p.typeId || p.quantity !== undefined || p.amountCents !== undefined
        ? await priced(p.typeId ?? cur.typeId, { quantity: p.quantity ?? cur.quantityX100 / 100, amountCents: p.amountCents ?? cur.amountCents })
        : null;
    const clientId = p.clientId !== undefined ? p.clientId : cur.clientId;
    if (p.clientId) await activeClient(p.clientId);
    const [row] = await db()
      .update(schema.expenses)
      .set({
        date: p.date ?? cur.date,
        description: p.description ?? cur.description,
        ...(pr ? { typeId: pr.type.id, quantityX100: pr.quantityX100, unitPriceCents: pr.unitPriceCents, amountCents: pr.amountCents } : {}),
        clientId,
        billable: Boolean(clientId) && (p.billable ?? cur.billable),
        ...(p.receipt !== undefined
          ? { receiptName: p.receipt?.name ?? null, receiptType: p.receipt?.contentType ?? null, receiptData: p.receipt?.data ?? null }
          : {}),
        status: "draft",
        updatedAt: new Date(),
      })
      .where(eq(schema.expenses.id, cur.id))
      .returning();
    return c.json(expenseView(row));
  })
  .delete("/expenses/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    await db().delete(schema.expenses).where(eq(schema.expenses.id, cur.id));
    return c.json({ ok: true });
  })
  /** Sends the item's whole report (items go to approval together). */
  .post("/expenses/:id/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status) || !cur.reportId) throw new HTTPException(409, { message: "expense_locked" });
    const sent = await submitReport(cur.reportId, a.user.id);
    await audit(a.user.id, "expense.submitted", cur.reportId, { count: sent.length, amountCents: sent.reduce((s, x) => s + x.amountCents, 0) });
    const [row] = await db().select().from(schema.expenses).where(eq(schema.expenses.id, cur.id));
    return c.json(expenseView(row));
  })
  /** The receipt: its owner, or whoever approves. */
  .get("/expenses/:id/receipt", async (c) => {
    const a = auth(c);
    const [x] = await db()
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, zUuid.parse(c.req.param("id"))));
    if (!x || !x.receiptData || (x.userId !== a.user.id && !a.permissions.includes("timesheets.approve")))
      throw new HTTPException(404, { message: "not_found" });
    const name = x.receiptName ?? "recu";
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(Buffer.from(x.receiptData, "base64"), {
      headers: {
        "content-type": /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(x.receiptType ?? "") ? x.receiptType! : "application/octet-stream",
        "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  })

  // ── approval (timesheets.approve) ──
  /** Weeks to approve: per person, the hours per type only. */
  .get("/approvals/timesheets", requirePermission("timesheets.approve", "accounting.manage"), async (c) => {
    const status = z.enum(["submitted", "approved", "rejected", "paid"]).parse(c.req.query("status") ?? "submitted");
    const { from, to } = periodOf((k) => c.req.query(k));
    const rows = await db()
      .select({ s: schema.timesheets, name: schema.users.name })
      .from(schema.timesheets)
      .innerJoin(schema.users, eq(schema.users.id, schema.timesheets.userId))
      // weeks that touch the time frame (a week starts at most 6 days before it)
      .where(
        and(
          eq(schema.timesheets.status, status),
          from ? gte(schema.timesheets.weekStart, addDays(from, -6)) : undefined,
          to ? lte(schema.timesheets.weekStart, to) : undefined,
        ),
      )
      .orderBy(desc(schema.timesheets.weekStart), asc(schema.users.name))
      .limit(200);
    const out = [];
    for (const r of rows) {
      out.push({
        id: r.s.id,
        userName: r.name,
        weekStart: r.s.weekStart,
        weekEnd: addDays(r.s.weekStart, 6),
        status: r.s.status,
        submittedAt: r.s.submittedAt,
        comment: r.s.comment,
        paidAt: r.s.paidAt,
        quickbooks: r.s.quickbooksSyncedAt || r.s.quickbooksError ? { syncedAt: r.s.quickbooksSyncedAt, error: r.s.quickbooksError } : null,
        ...(await weekTotals(r.s.userId, r.s.weekStart)),
      });
    }
    return c.json(out);
  })
  /** Accounting: approved weeks / expenses marked paid once paid (or back to approved, a mistake). */
  .post("/approvals/timesheets/paid", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ ids: z.array(zUuid).min(1).max(500), paid: z.boolean() }));
    const t = schema.timesheets;
    const rows = await db()
      .update(t)
      .set(
        p.paid
          ? { status: "paid", paidAt: new Date(), paidBy: a.user.id, updatedAt: new Date() }
          : { status: "approved", paidAt: null, paidBy: null, updatedAt: new Date() },
      )
      .where(and(inArray(t.id, p.ids), eq(t.status, p.paid ? "approved" : "paid")))
      .returning({ id: t.id });
    await audit(a.user.id, p.paid ? "timesheet.paid" : "timesheet.unpaid", null, { count: rows.length });
    return c.json({ changed: rows.length });
  })
  .post("/approvals/timesheets/:id", requirePermission("timesheets.approve"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(500).optional() }));
    const [cur] = await db()
      .select()
      .from(schema.timesheets)
      .where(eq(schema.timesheets.id, zUuid.parse(c.req.param("id"))));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.status !== "submitted") throw new HTTPException(409, { message: "timesheet_not_submitted" });
    if (cur.userId === a.realUser.id) throw new HTTPException(403, { message: "approve_own" });
    const [row] = await db()
      .update(schema.timesheets)
      .set({
        status: p.decision === "approve" ? "approved" : "rejected",
        decidedBy: a.user.id,
        decidedAt: new Date(),
        comment: p.comment || null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.timesheets.id, cur.id), eq(schema.timesheets.status, "submitted")))
      .returning();
    if (!row) throw new HTTPException(409, { message: "timesheet_not_submitted" });
    await audit(a.user.id, `timesheet.${p.decision === "approve" ? "approved" : "rejected"}`, row.id, { weekStart: row.weekStart });
    return c.json({ id: row.id, status: row.status });
  })
  .get("/approvals/expenses", requirePermission("timesheets.approve", "accounting.manage"), async (c) => {
    const status = z.enum(["submitted", "approved", "rejected", "paid"]).parse(c.req.query("status") ?? "submitted");
    const { from, to } = periodOf((k) => c.req.query(k));
    const rows = await db()
      .select({
        x: listColumns,
        type: schema.expenseTypes.name,
        unit: schema.expenseTypes.unit,
        user: schema.users.name,
        client: schema.clients.name,
        report: schema.expenseReports.title,
      })
      .from(schema.expenses)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
      .innerJoin(schema.users, eq(schema.users.id, schema.expenses.userId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
      .leftJoin(schema.expenseReports, eq(schema.expenseReports.id, schema.expenses.reportId))
      .where(and(eq(schema.expenses.status, status), from ? gte(schema.expenses.date, from) : undefined, to ? lte(schema.expenses.date, to) : undefined))
      .orderBy(asc(schema.users.name), desc(schema.expenses.date))
      .limit(500);
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, unit: r.unit, userName: r.user, clientName: r.client, reportTitle: r.report })));
  })
  .post("/approvals/expenses/paid", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ ids: z.array(zUuid).min(1).max(500), paid: z.boolean() }));
    const x = schema.expenses;
    const rows = await db()
      .update(x)
      .set(
        p.paid
          ? { status: "paid", paidAt: new Date(), paidBy: a.user.id, updatedAt: new Date() }
          : { status: "approved", paidAt: null, paidBy: null, updatedAt: new Date() },
      )
      .where(and(inArray(x.id, p.ids), eq(x.status, p.paid ? "approved" : "paid")))
      .returning({ id: x.id });
    await audit(a.user.id, p.paid ? "expense.paid" : "expense.unpaid", null, { count: rows.length });
    return c.json({ changed: rows.length });
  })
  .post("/approvals/expenses", requirePermission("timesheets.approve"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({ ids: z.array(zUuid).min(1).max(500), decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(500).optional() }),
    );
    const d = db();
    // never one's own expenses
    const rows = await d
      .select()
      .from(schema.expenses)
      .where(and(inArray(schema.expenses.id, p.ids), eq(schema.expenses.status, "submitted"), ne(schema.expenses.userId, a.realUser.id)));
    const decided: typeof rows = [];
    for (const x of rows) {
      await d.transaction(async (tx) => {
        // decided once: a concurrent decision wins, this one does nothing
        const [won] = await tx
          .update(schema.expenses)
          .set({
            status: p.decision === "approve" ? "approved" : "rejected",
            decidedBy: a.user.id,
            decidedAt: new Date(),
            comment: p.comment || null,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.expenses.id, x.id), eq(schema.expenses.status, "submitted")))
          .returning({ id: schema.expenses.id });
        if (!won) return;
        decided.push(x);
        let billingItemId: string | null = null;
        // billable to a client: it becomes work to invoice, already approved
        if (p.decision === "approve" && x.billable && x.clientId) {
          const [type] = await tx.select({ name: schema.expenseTypes.name }).from(schema.expenseTypes).where(eq(schema.expenseTypes.id, x.typeId));
          const [u] = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, x.userId));
          const [item] = await tx
            .insert(schema.billingItems)
            .values({
              clientId: x.clientId,
              kind: "expense",
              source: "portal",
              sourceId: `expense:${x.id}`,
              date: x.date,
              description: `${type?.name ?? ""} — ${x.description}`,
              resourceName: u?.name ?? null,
              quantityX100: x.quantityX100,
              unitPriceCents: x.unitPriceCents,
              amountCents: x.amountCents,
              status: "approved",
              approvedBy: a.user.id,
              approvedAt: new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: schema.billingItems.id });
          billingItemId = item?.id ?? null;
        }
        if (billingItemId) await tx.update(schema.expenses).set({ billingItemId }).where(eq(schema.expenses.id, x.id));
      });
    }
    // a refused item opens its report again: fixed (or removed), then sent anew
    const reopen = [...new Set(decided.map((x) => x.reportId).filter((id): id is string => Boolean(id)))];
    if (p.decision === "reject" && reopen.length)
      await d.update(schema.expenseReports).set({ submittedAt: null, updatedAt: new Date() }).where(and(inArray(schema.expenseReports.id, reopen)));
    await audit(a.user.id, `expense.${p.decision === "approve" ? "approved" : "rejected"}`, null, { count: decided.length });
    return c.json({ changed: decided.length });
  });
