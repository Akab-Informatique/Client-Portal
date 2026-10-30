import { isMileageUnit, tripLabel } from "../../shared/mileage.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { unpaidLunch } from "../../shared/workday.ts";
import { body, zUuid } from "../lib/validate.ts";
import { mailExpenseReport, mailTimesheet, saveTimeReportSettings, timeReportSettings } from "../lib/timeReports.ts";
import { expenseReportPdf, timesheetPdf } from "../lib/timePdf.ts";
import { addDays, editable, ensureTypes, sheetOf, todayQc, weekEntries, weekStartOf, weekTotals } from "../lib/timesheets.ts";
import { applyEntryLedger, clientOfCompany, holidayPay, refreshAccrual, splitBillable, wageFor, weekPay } from "../lib/hr.ts";
import { ticketSource } from "../lib/ticketSource.ts";

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
/** Where from / to of a trip, trimmed (a mileage type needs both) */
const place = z.string().trim().max(200).nullable().optional();
const expenseView = (x: Omit<Expense, "receiptData"> & { receiptData?: string | null; hasReceipt?: boolean }, extra: Record<string, unknown> = {}) => {
  const { receiptData, hasReceipt, ...rest } = x;
  return { ...rest, hasReceipt: hasReceipt ?? Boolean(receiptData), ...extra };
};
/** The expense columns, without the receipt file (lists stay small). */
const { receiptData: _receipt, ...EXPENSE_COLUMNS } = getTableColumns(schema.expenses);
const listColumns = { ...EXPENSE_COLUMNS, hasReceipt: sql<boolean>`(${schema.expenses.receiptData} is not null)` };
/** A mileage expense (km): the screens show the distance, never the amount in money */
const mileageExtra = (unit: string | null) => ({ unit, mileage: isMileageUnit(unit) });

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

const isManager = (a: AuthContext) => a.permissions.includes("timesheets.manage");
/** Amounts, vacation and balances are for accounting, HR and the managers of timesheets — never the employee */
const seesMoney = (a: AuthContext) => (["timesheets.manage", "timesheets.approve", "accounting.manage", "hr.manage"] as const).some((k) => a.permissions.includes(k));

/**
 * Before an entry of a week is added, changed or removed. A week still open (draft or sent back): fine. Once the week is sent
 * (submitted, approved or paid) its owner can no longer change it; a manager (timesheets.manage) always can, for anyone, and
 * the week keeps its status. The returned function is kept for the callers: there is nothing to reopen any more.
 */
async function weekLock(owner: string, date: string, a: AuthContext): Promise<() => Promise<void>> {
  const sheet = await sheetOf(owner, weekStartOf(date));
  if (editable(sheet.status) || isManager(a)) return async () => {};
  throw new HTTPException(409, { message: "timesheet_locked" });
}

type EntryInput = { date: string; hours?: number; start?: string; end?: string; bankHours?: number; clientId?: string | null; ticketId?: number | null; billable?: boolean; amount?: number };

/**
 * What an entry stores, by the kind of its type. Work day: start and end (lunch taken off), and the hours of it put in the bank.
 * Holiday: worked out from the last 4 weeks. Trip: hours, optionally a client and a ticket, billable with an amount. Everything
 * else: hours. Billable and non billable hours are kept with the client (nothing shows them yet).
 */
async function entryFields(kind: string, owner: string, p: EntryInput): Promise<Partial<typeof schema.timesheetEntries.$inferInsert>> {
  const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  if (kind === "workday") {
    if (!p.start || !p.end) throw new HTTPException(400, { message: "workday_times" });
    const lunch = unpaidLunch(minutes(p.start), minutes(p.end));
    const span = minutes(p.end) - minutes(p.start) - lunch;
    if (span <= 0) throw new HTTPException(400, { message: "workday_times" });
    const hoursX100 = Math.round((span / 60) * 100);
    const bankX100 = Math.round((p.bankHours ?? 0) * 100);
    if (bankX100 > hoursX100) throw new HTTPException(400, { message: "bank_too_large" });
    return { hoursX100, startTime: p.start, endTime: p.end, lunchMinutes: lunch, bankX100 };
  }
  if (kind === "holiday") {
    const pay = await holidayPay(owner, p.date);
    return { hoursX100: pay.hoursX100, amountCents: pay.cents };
  }
  if (!p.hours) throw new HTTPException(400, { message: "Validation failed" });
  const hoursX100 = Math.round(p.hours * 100);
  if (kind === "travel") {
    let clientId: string | null = null;
    let ticket: { ticketId: number; ticketNumber: string; ticketTitle: string } | null = null;
    if (p.ticketId) {
      const tk = await (await ticketSource()).get(p.ticketId).catch(() => null);
      if (!tk) throw new HTTPException(404, { message: "not_found" });
      ticket = { ticketId: p.ticketId, ticketNumber: tk.number, ticketTitle: tk.title.slice(0, 250) };
      clientId = await clientOfCompany(tk.company.id);
    } else if (p.clientId) {
      const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, p.clientId));
      if (!c) throw new HTTPException(404, { message: "not_found" });
      clientId = c.id;
    }
    // billable only when ticked, with the amount to bill; the client is then needed
    if (p.billable) {
      if (!p.amount || p.amount <= 0) throw new HTTPException(400, { message: "travel_amount_required" });
      if (!clientId) throw new HTTPException(400, { message: "travel_client_required" });
    }
    const split = splitBillable(hoursX100, p.billable ? hoursX100 : 0);
    return { hoursX100, clientId, ticketId: ticket?.ticketId ?? null, ticketNumber: ticket?.ticketNumber ?? null, ticketTitle: ticket?.ticketTitle ?? null, amountCents: p.billable ? Math.round(p.amount! * 100) : null, ...split };
  }
  // vacation, sick days, bank payout, training, meetings
  return { hoursX100, ...(kind === "other" ? splitBillable(hoursX100, 0) : {}) };
}

/** A trip billed to a client becomes work to bill; once approved (or invoiced) it cannot be changed any more */
async function tripLocked(entryId: string) {
  const [b] = await db().select({ status: schema.billingItems.status }).from(schema.billingItems).where(eq(schema.billingItems.sourceId, `ptravel:${entryId}`));
  if (b && (b.status === "approved" || b.status === "posted")) throw new HTTPException(409, { message: "entry_billed" });
}

/** An expense: its owner's, or anyone's for a manager (timesheets.manage) */
async function ownExpense(id: string, a: AuthContext) {
  const [x] = await db()
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, zUuid.parse(id)), isManager(a) ? undefined : eq(schema.expenses.userId, a.user.id)));
  if (!x) throw new HTTPException(404, { message: "not_found" });
  return x;
}

/** An expense report: its owner's, or anyone's for a manager; `open`: the owner cannot change a report once it was sent (a manager always can). */
async function ownReport(id: string, a: AuthContext, opts: { open?: boolean } = {}) {
  const r = zUuid.safeParse(id);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  const [rep] = await db()
    .select()
    .from(schema.expenseReports)
    .where(and(eq(schema.expenseReports.id, r.data), isManager(a) ? undefined : eq(schema.expenseReports.userId, a.user.id)));
  if (!rep) throw new HTTPException(404, { message: "not_found" });
  if (opts.open && rep.submittedAt && !isManager(a)) throw new HTTPException(409, { message: "report_submitted" });
  return rep;
}

/** The work to bill an expense gave: what is already on an invoice cannot be changed (cancel the invoice first), the rest is taken off */
async function billedBy(x: { billingItemId: string | null }) {
  if (!x.billingItemId) return null;
  const [bi] = await db().select({ id: schema.billingItems.id, status: schema.billingItems.status, invoiceId: schema.billingItems.invoiceId }).from(schema.billingItems).where(eq(schema.billingItems.id, x.billingItemId));
  return bi ?? null;
}
/** Before an expense is changed or removed: nothing on an invoice; a paid one only by a manager */
async function expenseGuard(x: { status: string; billingItemId: string | null }, a: AuthContext) {
  const bi = await billedBy(x);
  if (bi && (bi.status === "posted" || bi.invoiceId)) throw new HTTPException(409, { message: "expense_billed" });
  if (x.status === "paid" && !isManager(a)) throw new HTTPException(409, { message: "expense_locked" });
}
/** Takes the (not invoiced) work to bill of an expense away, it is made again when the expense is approved */
async function releaseBilling(x: { id: string; billingItemId: string | null }) {
  if (!x.billingItemId) return;
  await db().delete(schema.billingItems).where(eq(schema.billingItems.id, x.billingItemId));
  await db().update(schema.expenses).set({ billingItemId: null }).where(eq(schema.expenses.id, x.id));
}

/**
 * Send a report: its items not sent yet (draft, or refused and fixed) go to
 * approval together. Nothing to send: report_empty.
 */
async function submitReport(reportId: string, userId: string) {
  const x = schema.expenses;
  // no approver for now: the items are approved as they are sent (Admin › PSA › Temps et dépenses)
  const auto = (await timeReportSettings()).autoApprove;
  const now = new Date();
  const sent = await db().transaction(async (tx) => {
    const rows = await tx
      .update(x)
      .set(auto ? { status: "approved", submittedAt: now, decidedAt: now, comment: null, updatedAt: now } : { status: "submitted", submittedAt: now, updatedAt: now })
      .where(and(eq(x.reportId, reportId), eq(x.userId, userId), inArray(x.status, ["draft", "rejected"])))
      .returning({ id: x.id, amountCents: x.amountCents, billable: x.billable, clientId: x.clientId, typeId: x.typeId, userId: x.userId, date: x.date, description: x.description, quantityX100: x.quantityX100, unitPriceCents: x.unitPriceCents });
    if (!rows.length) throw new HTTPException(409, { message: "report_empty" });
    await tx.update(schema.expenseReports).set({ submittedAt: now, updatedAt: now }).where(eq(schema.expenseReports.id, reportId));
    if (auto) for (const r of rows) await billExpense(tx, r, userId);
    return rows;
  });
  // accounting gets the report as a PDF (the email failing never undoes the report)
  await mailExpenseReport(reportId, userId);
  return sent;
}

/** A billable expense (to a client) becomes work to invoice, already approved. Returns the billing item. */
async function billExpense(
  tx: Pick<ReturnType<typeof db>, "select" | "insert" | "update">,
  x: Pick<Expense, "id" | "billable" | "clientId" | "typeId" | "userId" | "date" | "description" | "quantityX100" | "unitPriceCents" | "amountCents">,
  actorId: string,
) {
  if (!x.billable || !x.clientId) return null;
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
      approvedBy: actorId,
      approvedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.billingItems.id });
  if (item) await tx.update(schema.expenses).set({ billingItemId: item.id }).where(eq(schema.expenses.id, x.id));
  return item?.id ?? null;
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
/** The trip of a mileage type (both places asked, the line reads "from → to"); nothing for the other types */
function tripOf(unit: string | null | undefined, from: string | null | undefined, to: string | null | undefined): { mileage: boolean; from: string | null; to: string | null; label: string } {
  if (!isMileageUnit(unit)) return { mileage: false, from: null, to: null, label: "" };
  const f = (from ?? "").trim();
  const t = (to ?? "").trim();
  if (!f || !t) throw new HTTPException(400, { message: "mileage_places_required" });
  return { mileage: true, from: f, to: t, label: tripLabel(f, t) };
}

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
  /** What happens when a week or a report is sent: approved at once, and who gets the PDF */
  .get("/admin/report-settings", requirePermission("admin.billing"), async (c) => c.json(await timeReportSettings()))
  .put("/admin/report-settings", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ autoApprove: z.boolean().optional(), recipients: z.array(z.string().trim().toLowerCase().email().max(200)).max(10).optional() }));
    const next = await saveTimeReportSettings(p);
    await audit(a.user.id, "time.report_settings", null, { autoApprove: next.autoApprove, recipients: next.recipients.length });
    return c.json(next);
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
    const money = seesMoney(a);
    const pay = await weekPay(owner, weekStart);
    const [me] = await db().select({ required: schema.users.timesheetRequired }).from(schema.users).where(eq(schema.users.id, owner));
    return c.json({
      userId: owner,
      weekStart,
      /** This person submits weekly timesheets for approval (set by an admin) */
      required: me?.required ?? true,
      weekEnd: addDays(weekStart, 6),
      status: sheet.status,
      comment: sheet.comment,
      entries: rows.map((r) => ({ ...r.e, ...(money ? {} : { amountCents: r.kind === "holiday" ? null : r.e.amountCents }), hours: r.e.hoursX100 / 100, type: r.type, kind: r.kind })),
      ...(await weekTotals(owner, weekStart)),
      /** What is paid this week, in hours: work days less the hours banked, vacation, sick, holidays, bank payouts (amounts only for accounting, HR and managers) */
      pay: money ? pay : { ...pay, wageCents: null, holidayCents: 0, paidCents: null, vacationAccrualCents: null },
    });
  })
  /**
   * A person's hours over a period (own, or anyone's with timesheets.manage): the hours PAID — work days (less the hours put
   * in the bank), vacation, sick days, holidays, bank payouts — per week and per type. Billable time is not part of it.
   */
  .get("/report", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const owner = await timesheetOwner(a, c.req.query("userId"));
    const from = c.req.query("from") ? zDay.parse(c.req.query("from")) : weekStartOf(todayQc());
    const to = c.req.query("to") ? zDay.parse(c.req.query("to")) : addDays(from, 6);
    if (to < from || (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > 800) throw new HTTPException(400, { message: "Validation failed" });
    const d = db();
    const rows = await d
      .select({ e: schema.timesheetEntries, type: schema.timesheetTypes.name, kind: schema.timesheetTypes.kind })
      .from(schema.timesheetEntries)
      .innerJoin(schema.timesheetTypes, eq(schema.timesheetTypes.id, schema.timesheetEntries.typeId))
      .where(and(eq(schema.timesheetEntries.userId, owner), gte(schema.timesheetEntries.date, from), lte(schema.timesheetEntries.date, to)));
    const byType = new Map<string, { type: string; kind: string; hours: number }>();
    const byWeek = new Map<string, { weekStart: string; workday: number; banked: number; vacation: number; sick: number; holiday: number; bankPaid: number; entered: number }>();
    const sum = { workday: 0, banked: 0, vacation: 0, sick: 0, holiday: 0, holidayCents: 0, bankPaid: 0, entered: 0 };
    for (const r of rows) {
      const h = r.e.hoursX100;
      const w = weekStartOf(r.e.date);
      const wk = byWeek.get(w) ?? { weekStart: w, workday: 0, banked: 0, vacation: 0, sick: 0, holiday: 0, bankPaid: 0, entered: 0 };
      byWeek.set(w, wk);
      const t = byType.get(r.e.typeId) ?? { type: r.type, kind: r.kind, hours: 0 };
      t.hours += h;
      byType.set(r.e.typeId, t);
      if (r.kind === "workday") {
        sum.workday += h;
        sum.banked += r.e.bankX100;
        wk.workday += h;
        wk.banked += r.e.bankX100;
      } else if (r.kind === "vacation") {
        sum.vacation += h;
        wk.vacation += h;
      } else if (r.kind === "sick") {
        sum.sick += h;
        wk.sick += h;
      } else if (r.kind === "holiday") {
        sum.holiday += h;
        wk.holiday += h;
        sum.holidayCents += r.e.amountCents ?? 0;
      } else if (r.kind === "bankpay") {
        sum.bankPaid += h;
        wk.bankPaid += h;
      } else {
        sum.entered += h;
        wk.entered += h;
      }
    }
    const [u] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, owner));
    const h = (n: number) => n / 100;
    const paid = (x: { workday: number; banked: number; vacation: number; sick: number; holiday: number; bankPaid: number }) => Math.max(0, x.workday - x.banked) + x.vacation + x.sick + x.holiday + x.bankPaid;
    return c.json({
      userId: owner,
      name: u?.name ?? "",
      from,
      to,
      workdayHours: h(sum.workday),
      /** Part of the work days put in the hours bank (not paid) */
      bankedHours: h(sum.banked),
      vacationHours: h(sum.vacation),
      sickHours: h(sum.sick),
      holidayHours: h(sum.holiday),
      holidayCents: seesMoney(a) ? sum.holidayCents : 0,
      bankPaidHours: h(sum.bankPaid),
      /** Time entered on tickets and by hand (training, meetings, trips) */
      enteredHours: h(sum.entered),
      /** The hours paid to the employee */
      paidHours: h(paid(sum)),
      types: [...byType.values()].sort((x, y) => y.hours - x.hours).map((t) => ({ type: t.type, kind: t.kind, hours: h(t.hours) })),
      weeks: [...byWeek.values()].sort((x, y) => x.weekStart.localeCompare(y.weekStart)).map((w) => ({ weekStart: w.weekStart, workdayHours: h(w.workday), bankedHours: h(w.banked), paidHours: h(paid(w)), enteredHours: h(w.entered) })),
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
        // a work day: from and to (the lunch rule is in shared/workday.ts), and the hours of it put in the hours bank
        start: zTime.optional(),
        end: zTime.optional(),
        bankHours: z.number().min(0).max(24).optional(),
        // a trip: for which client and ticket, billable (with the amount to bill)
        clientId: zUuid.nullable().optional(),
        ticketId: z.number().int().positive().nullable().optional(),
        billable: z.boolean().optional(),
        amount: z.number().min(0).max(100_000).optional(),
      }),
    );
    const owner = await timesheetOwner(a, p.userId);
    const [type] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, p.typeId));
    // ticket time comes from the tickets only
    if (!type || !type.active || type.kind === "labour") throw new HTTPException(400, { message: "time_type_unknown" });
    await weekLock(owner, p.date, a);
    const fields = await entryFields(type.kind, owner, p);
    // one work day a day: change it by removing it first
    if (type.kind === "workday") {
      const [again] = await db()
        .select({ id: schema.timesheetEntries.id })
        .from(schema.timesheetEntries)
        .where(and(eq(schema.timesheetEntries.userId, owner), eq(schema.timesheetEntries.date, p.date), eq(schema.timesheetEntries.typeId, type.id)))
        .limit(1);
      if (again) throw new HTTPException(409, { message: "workday_exists" });
    }
    // what has to be turned into dollars needs the hourly wage (RH tab)
    await wageFor(owner, type.kind, fields.bankX100 ?? 0);
    const [row] = await db()
      .insert(schema.timesheetEntries)
      .values({ userId: owner, date: p.date, typeId: type.id, hoursX100: 0, note: p.note || null, source: "manual", ...fields })
      .returning();
    const negative = await applyEntryLedger(row, type.kind);
    await refreshAccrual(owner, weekStartOf(p.date));
    if (owner !== a.user.id) await audit(a.user.id, "timesheet.entry_added_for", owner, { date: p.date, hours: row.hoursX100 / 100 });
    return c.json({ ...row, negative }, 201);
  })
  /** Change an entry made by hand, while its week is not sent (a manager: any time): hours (or start and end of a work day), note, day, bank hours, trip details */
  .patch("/entries/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const p = await body(
      c,
      z.object({
        date: zDay.optional(),
        hours: z.number().positive().max(24).optional(),
        note: z.string().trim().max(500).nullable().optional(),
        start: zTime.optional(),
        end: zTime.optional(),
        bankHours: z.number().min(0).max(24).optional(),
        clientId: zUuid.nullable().optional(),
        ticketId: z.number().int().positive().nullable().optional(),
        billable: z.boolean().optional(),
        amount: z.number().min(0).max(100_000).optional(),
      }),
    );
    const manager = isManager(a);
    const [e] = await db()
      .select()
      .from(schema.timesheetEntries)
      .where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("id"))), manager ? undefined : eq(schema.timesheetEntries.userId, a.user.id)));
    // ticket time is changed on its ticket
    if (!e || e.source !== "manual") throw new HTTPException(404, { message: "not_found" });
    const [type] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, e.typeId));
    if (!type) throw new HTTPException(404, { message: "not_found" });
    const date = p.date ?? e.date;
    await weekLock(e.userId, e.date, a);
    if (date !== e.date) await weekLock(e.userId, date, a);
    await tripLocked(e.id);
    const fields = await entryFields(type.kind, e.userId, {
      date,
      hours: p.hours ?? e.hoursX100 / 100,
      start: p.start ?? e.startTime ?? undefined,
      end: p.end ?? e.endTime ?? undefined,
      bankHours: p.bankHours ?? e.bankX100 / 100,
      clientId: p.clientId !== undefined ? p.clientId : e.clientId,
      ticketId: p.ticketId !== undefined ? p.ticketId : e.ticketId,
      billable: p.billable ?? (e.billableX100 ?? 0) > 0,
      amount: p.amount ?? (e.amountCents != null ? e.amountCents / 100 : undefined),
    });
    if (type.kind === "workday" && date !== e.date) {
      const [again] = await db().select({ id: schema.timesheetEntries.id }).from(schema.timesheetEntries).where(and(eq(schema.timesheetEntries.userId, e.userId), eq(schema.timesheetEntries.date, date), eq(schema.timesheetEntries.typeId, e.typeId))).limit(1);
      if (again) throw new HTTPException(409, { message: "workday_exists" });
    }
    await wageFor(e.userId, type.kind, fields.bankX100 ?? 0);
    const [row] = await db()
      .update(schema.timesheetEntries)
      .set({ date, ...fields, ...(p.note !== undefined ? { note: p.note || null } : {}) })
      .where(eq(schema.timesheetEntries.id, e.id))
      .returning();
    const negative = await applyEntryLedger(row, type.kind);
    await refreshAccrual(e.userId, weekStartOf(e.date));
    if (weekStartOf(date) !== weekStartOf(e.date)) await refreshAccrual(e.userId, weekStartOf(date));
    await audit(a.user.id, "timesheet.entry_changed", e.id, { date: e.date, ...(e.userId !== a.user.id ? { for: e.userId } : {}) });
    return c.json({ ...row, negative });
  })
  .delete("/entries/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const manager = isManager(a);
    const [e] = await db()
      .select()
      .from(schema.timesheetEntries)
      .where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("id"))), manager ? undefined : eq(schema.timesheetEntries.userId, a.user.id)));
    if (!e || e.source !== "manual") throw new HTTPException(404, { message: "not_found" });
    await weekLock(e.userId, e.date, a);
    await tripLocked(e.id);
    // the account rows of the entry go with it (hr_ledger.entry_id cascades)
    await db().delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, e.id));
    await refreshAccrual(e.userId, weekStartOf(e.date));
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
    // no approver for now: the week is approved as it is sent (Admin › PSA › Temps et dépenses)
    const auto = (await timeReportSettings()).autoApprove;
    const now = new Date();
    const [row] = await db()
      .update(schema.timesheets)
      .set(auto ? { status: "approved", submittedAt: now, decidedAt: now, comment: null, updatedAt: now } : { status: "submitted", submittedAt: now, updatedAt: now })
      .where(eq(schema.timesheets.id, sheet.id))
      .returning();
    await audit(a.user.id, "timesheet.submitted", row.id, { weekStart: row.weekStart, ...(owner !== a.user.id ? { for: owner } : {}), ...(auto ? { auto: true } : {}) });
    // the week is sent: 4 % of its gross pay goes in the vacation bank
    await refreshAccrual(owner, row.weekStart);
    // accounting gets the week as a PDF (the email failing never undoes the submit)
    await mailTimesheet(owner, row.weekStart, a.user.id, row.id);
    return c.json(row);
  })

  /** The week as the PDF accounting gets: one's own, or anyone's for whoever manages or approves */
  .get("/week/pdf", requirePermission("timesheets.use", "timesheets.manage", "timesheets.approve", "accounting.manage"), async (c) => {
    const a = auth(c);
    const asked = c.req.query("userId");
    const owner = !asked || asked === a.user.id ? a.user.id : zUuid.parse(asked);
    if (owner !== a.user.id && !(["timesheets.manage", "timesheets.approve", "accounting.manage"] as const).some((k) => a.permissions.includes(k))) throw new HTTPException(403, { message: "Forbidden" });
    // an employee gets hours only; accounting and those who manage or approve get the complete report
    const pdf = await timesheetPdf(owner, weekStartOf(zDay.parse(c.req.query("start") ?? todayQc())), { forEmployee: !seesMoney(a) });
    if (!pdf) throw new HTTPException(404, { message: "not_found" });
    return new Response(new Uint8Array(pdf.content), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "no-store" } });
  })

  // ── my expense reports: items added while open, then sent together ──
  /** My reports, or (with timesheets.manage, `?userId=`) a team member's, to look at */
  .get("/expense-reports", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const owner = await timesheetOwner(a, c.req.query("userId"));
    const [reports, rows] = await Promise.all([
      db().select().from(schema.expenseReports).where(eq(schema.expenseReports.userId, owner)).orderBy(desc(schema.expenseReports.createdAt)),
      db()
        .select({ x: listColumns, type: schema.expenseTypes.name, unit: schema.expenseTypes.unit, client: schema.clients.name })
        .from(schema.expenses)
        .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
        .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
        .where(eq(schema.expenses.userId, owner))
        .orderBy(asc(schema.expenses.date), asc(schema.expenses.createdAt)),
    ]);
    const out = reports.map((r) => {
      const items = rows.filter((x) => x.x.reportId === r.id).map((x) => ({ ...expenseView(x.x, { type: x.type, clientName: x.client, ...mileageExtra(x.unit) }), mileage: isMileageUnit(x.unit) }));
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
        /** What shows in money (a mileage line shows its distance instead) and the kilometres paid */
        moneyCents: items.filter((i) => !i.mileage).reduce((s, i) => s + i.amountCents, 0),
        totalKm: items.filter((i) => i.mileage).reduce((s, i) => s + i.quantityX100, 0) / 100,
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
  .patch("/expense-reports/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a, { open: true });
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
  /**
   * A report goes with its items (and their work to bill). Its owner only while it is open (not sent); a manager
   * (timesheets.manage) for anyone, even sent, approved or paid. Nothing already on an invoice: cancel the invoice first.
   */
  .delete("/expense-reports/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a, { open: true });
    const items = await db().select().from(schema.expenses).where(eq(schema.expenses.reportId, rep.id));
    if (!isManager(a) && items.some((x) => x.status !== "draft" && x.status !== "rejected")) throw new HTTPException(409, { message: "expense_locked" });
    for (const x of items) await expenseGuard(x, a);
    for (const x of items) await releaseBilling(x);
    await db().delete(schema.expenseReports).where(eq(schema.expenseReports.id, rep.id));
    await audit(a.user.id, "expense.report_deleted", rep.id, { title: rep.title, items: items.length, ...(rep.userId !== a.user.id ? { for: rep.userId } : {}) });
    return c.json({ ok: true });
  })
  /** The report as the PDF accounting gets: its owner, or whoever manages, approves or does the accounting */
  .get("/expense-reports/:id/pdf", requirePermission("timesheets.use", "timesheets.manage", "timesheets.approve", "accounting.manage"), async (c) => {
    const a = auth(c);
    const [rep] = await db().select().from(schema.expenseReports).where(eq(schema.expenseReports.id, zUuid.parse(c.req.param("id"))));
    if (!rep || (rep.userId !== a.user.id && !(["timesheets.manage", "timesheets.approve", "accounting.manage"] as const).some((k) => a.permissions.includes(k)))) throw new HTTPException(404, { message: "not_found" });
    const pdf = await expenseReportPdf(rep.id);
    if (!pdf) throw new HTTPException(404, { message: "not_found" });
    return new Response(new Uint8Array(pdf.content), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "no-store" } });
  })
  .post("/expense-reports/:id/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rep = await ownReport(c.req.param("id"), a, { open: true });
    const sent = await submitReport(rep.id, rep.userId);
    await audit(a.user.id, "expense.submitted", rep.id, { count: sent.length, amountCents: sent.reduce((s, x) => s + x.amountCents, 0) });
    return c.json({ submitted: sent.length });
  })

  // ── my favourite expenses (the same trip, parking…) ──
  .get("/expense-favorites", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ f: schema.expenseFavorites, type: schema.expenseTypes.name, unit: schema.expenseTypes.unit, client: schema.clients.name })
      .from(schema.expenseFavorites)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenseFavorites.typeId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenseFavorites.clientId))
      .where(and(eq(schema.expenseFavorites.userId, a.user.id), eq(schema.expenseTypes.active, true)))
      .orderBy(asc(schema.expenseFavorites.name));
    return c.json(rows.map((r) => ({ ...r.f, type: r.type, clientName: r.client, ...mileageExtra(r.unit) })));
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
        fromPlace: place,
        toPlace: place,
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
        fromPlace: isMileageUnit(pr.type.unit) ? (p.fromPlace?.trim() || null) : null,
        toPlace: isMileageUnit(pr.type.unit) ? (p.toPlace?.trim() || null) : null,
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
      .select({ x: listColumns, type: schema.expenseTypes.name, unit: schema.expenseTypes.unit, client: schema.clients.name })
      .from(schema.expenses)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
      .where(eq(schema.expenses.userId, a.user.id))
      .orderBy(desc(schema.expenses.date), desc(schema.expenses.createdAt));
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, clientName: r.client, ...mileageExtra(r.unit) })));
  })
  .post("/expenses", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        date: zDay,
        typeId: zUuid,
        // a mileage type needs no note: the trip says it
        description: z.string().trim().max(500).default(""),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        fromPlace: place,
        toPlace: place,
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
        // the open report it goes in; none: a report of its own
        reportId: zUuid.optional(),
      }),
    );
    const pr = await priced(p.typeId, p);
    const trip = tripOf(pr.type.unit, p.fromPlace, p.toPlace);
    p.description = p.description || trip.label;
    if (!p.description) throw new HTTPException(400, { message: "Validation failed" });
    if (p.clientId) await activeClient(p.clientId);
    let reportId: string;
    if (p.reportId) {
      const rep = await ownReport(p.reportId, a, { open: true });
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
        fromPlace: trip.from,
        toPlace: trip.to,
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
  /**
   * Change an expense. Its owner can until it is paid or invoiced: a sent item goes back to a draft and its report is
   * open again, to be sent again. A manager (timesheets.manage) can change anyone's, whatever its status: it keeps it,
   * and its work to bill follows.
   */
  .patch("/expenses/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a);
    await expenseGuard(cur, a);
    const p = await body(
      c,
      z.object({
        date: zDay.optional(),
        typeId: zUuid.optional(),
        description: z.string().trim().max(500).optional(),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        fromPlace: place,
        toPlace: place,
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
      }),
    );
    if (p.date && cur.reportId) inPeriod(await ownReport(cur.reportId, a), p.date);
    const pr =
      p.typeId || p.quantity !== undefined || p.amountCents !== undefined
        ? await priced(p.typeId ?? cur.typeId, { quantity: p.quantity ?? cur.quantityX100 / 100, amountCents: p.amountCents ?? cur.amountCents })
        : null;
    const clientId = p.clientId !== undefined ? p.clientId : cur.clientId;
    if (p.clientId) await activeClient(p.clientId);
    // the trip of a mileage type: both places, the line reads "from → to" when no note is written
    const [curType] = await db().select().from(schema.expenseTypes).where(eq(schema.expenseTypes.id, p.typeId ?? cur.typeId));
    const trip = tripOf(curType?.unit, p.fromPlace !== undefined ? p.fromPlace : cur.fromPlace, p.toPlace !== undefined ? p.toPlace : cur.toPlace);
    const description = p.description !== undefined ? p.description || trip.label : trip.mileage && (!cur.description || cur.description === tripLabel(cur.fromPlace, cur.toPlace)) ? trip.label : cur.description;
    if (!description) throw new HTTPException(400, { message: "Validation failed" });
    const [row] = await db()
      .update(schema.expenses)
      .set({
        date: p.date ?? cur.date,
        description,
        fromPlace: trip.from,
        toPlace: trip.to,
        ...(pr ? { typeId: pr.type.id, quantityX100: pr.quantityX100, unitPriceCents: pr.unitPriceCents, amountCents: pr.amountCents } : {}),
        clientId,
        billable: Boolean(clientId) && (p.billable ?? cur.billable),
        ...(p.receipt !== undefined
          ? { receiptName: p.receipt?.name ?? null, receiptType: p.receipt?.contentType ?? null, receiptData: p.receipt?.data ?? null }
          : {}),
        // a manager keeps the status; the owner's change on a sent item sends it back
        ...(isManager(a) ? {} : { status: "draft", decidedAt: null, comment: null }),
        updatedAt: new Date(),
      })
      .where(eq(schema.expenses.id, cur.id))
      .returning();
    // the work to bill follows: taken off, and made again for an approved / paid item a manager changed
    await releaseBilling(cur);
    if (isManager(a) && (cur.status === "approved" || cur.status === "paid")) await billExpense(db(), row, a.user.id);
    if (!isManager(a) && cur.reportId && cur.status !== "draft") await db().update(schema.expenseReports).set({ submittedAt: null, updatedAt: new Date() }).where(eq(schema.expenseReports.id, cur.reportId));
    if (cur.userId !== a.user.id || cur.status !== "draft") await audit(a.user.id, "expense.changed", cur.id, { was: cur.status, ...(cur.userId !== a.user.id ? { for: cur.userId } : {}) });
    return c.json(expenseView(row));
  })
  /** Remove an expense: its owner while it is a draft or refused (not sent), a manager (timesheets.manage) anyone's whatever its status (not once invoiced) */
  .delete("/expenses/:id", requirePermission("timesheets.use", "timesheets.manage"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a);
    if (!isManager(a) && !editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    await expenseGuard(cur, a);
    await releaseBilling(cur);
    await db().delete(schema.expenses).where(eq(schema.expenses.id, cur.id));
    if (cur.userId !== a.user.id || cur.status !== "draft") await audit(a.user.id, "expense.removed", cur.id, { was: cur.status, description: cur.description, ...(cur.userId !== a.user.id ? { for: cur.userId } : {}) });
    return c.json({ ok: true });
  })
  /** Sends the item's whole report (items go to approval together). */
  .post("/expenses/:id/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a);
    if (!editable(cur.status) || !cur.reportId) throw new HTTPException(409, { message: "expense_locked" });
    const sent = await submitReport(cur.reportId, cur.userId);
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
    if (!x || !x.receiptData || (x.userId !== a.user.id && !a.permissions.includes("timesheets.approve") && !a.permissions.includes("timesheets.manage")))
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
    // a week sent back is open again: its 4 % comes out of the vacation bank until it is sent once more
    await refreshAccrual(row.userId, row.weekStart);
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
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, ...mileageExtra(r.unit), userName: r.user, clientName: r.client, reportTitle: r.report })));
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
        // billable to a client: it becomes work to invoice, already approved
        if (p.decision === "approve") await billExpense(tx, x, a.user.id);
      });
    }
    // a refused item opens its report again: fixed (or removed), then sent anew
    const reopen = [...new Set(decided.map((x) => x.reportId).filter((id): id is string => Boolean(id)))];
    if (p.decision === "reject" && reopen.length)
      await d.update(schema.expenseReports).set({ submittedAt: null, updatedAt: new Date() }).where(and(inArray(schema.expenseReports.id, reopen)));
    await audit(a.user.id, `expense.${p.decision === "approve" ? "approved" : "rejected"}`, null, { count: decided.length });
    return c.json({ changed: decided.length });
  });
