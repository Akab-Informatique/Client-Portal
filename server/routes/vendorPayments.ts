import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, gt, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { body, zUuid } from "../lib/validate.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { quickbooksSettings } from "../lib/billing.ts";
import { errText, QuickBooksError } from "../lib/quickbooks.ts";
import { billsSummary, billView, pullBills } from "../lib/vendorBills.ts";
import { cashForecast, forecastSettings, saveForecastSettings } from "../lib/cashForecast.ts";
import { AVERAGE_WEEKS, payrollTable } from "../lib/payroll.ts";
import { parseSheet } from "../lib/recurringPayments.ts";

/**
 * Accounting › Paiements fournisseurs: the vendors' bills copied from QuickBooks and what is due when
 * (`accounting.view`; `accounting.manage` to refresh from QuickBooks). Read only: nothing goes back to QuickBooks.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();
const zRecurring = z.object({
  name: z.string().trim().min(1).max(200),
  /** dollars, as typed; none = not known yet */
  amountCents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  frequency: z.enum(["weekly", "monthly", "yearly"]).default("monthly"),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  month: z.number().int().min(1).max(12).nullable().optional(),
  account: zText(80),
  method: zText(80),
  notes: zText(1000),
  inQuickbooks: z.boolean().optional(),
  active: z.boolean().optional(),
});
const zList = z.object({
  /** open = still to pay (late included) · overdue · paid · all */
  status: z.enum(["open", "overdue", "paid", "all"]).default("open"),
  /** on the due date */
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
});

export const vendorPaymentRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("accounting.view"))

  .get("/status", async (c) => {
    const s = await quickbooksSettings();
    return c.json({ connected: Boolean(s.enabled && s.refreshToken && s.realmId), syncOn: s.sync.bills, last: s.imports.bills ?? null });
  })

  .get("/summary", async (c) => c.json(await billsSummary()))

  .get("/bills", async (c) => {
    const p = zList.parse(c.req.query());
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const t = schema.vendorBills;
    const where = and(
      p.status === "paid" ? sql`${t.balanceCents} <= 0` : p.status === "all" ? undefined : gt(t.balanceCents, 0),
      p.status === "overdue" ? sql`${t.dueOn} < ${today}` : undefined,
      p.from ? gte(t.dueOn, p.from) : undefined,
      p.to ? lte(t.dueOn, p.to) : undefined,
      p.q ? or(ilike(t.vendorName, `%${p.q}%`), ilike(t.docNumber, `%${p.q}%`)) : undefined,
    );
    const rows = await db().select().from(t).where(where).orderBy(p.status === "paid" ? desc(t.dueOn) : asc(t.dueOn), asc(t.vendorName)).limit(2000);
    const bills = rows.map((b) => billView(b, today));
    return c.json({ today, bills, totalCents: bills.reduce((x, b) => x + b.balanceCents, 0) });
  })

  .get("/forecast", async (c) => {
    // 14 to 180 days (60 when missing)
    const days = Math.min(180, Math.max(14, Math.round(Number(c.req.query("days"))) || 60));
    return c.json(await cashForecast(days));
  })

  .put("/forecast/settings", requirePermission("accounting.manage"), async (c) => {
    const p = await body(
      c,
      z.object({
        /** dollars, as typed */
        balance: z.number().min(-100_000_000).max(100_000_000).optional(),
        payDelayDays: z.number().int().min(0).max(120).optional(),
        lateDelayDays: z.number().int().min(0).max(180).optional(),
        payrollWeekday: z.number().int().min(1).max(7).optional(),
      }),
    );
    const a = auth(c);
    const n = await saveForecastSettings(a.user.id, {
      ...(p.balance !== undefined ? { balanceCents: Math.round(p.balance * 100), balanceOn: new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) } : {}),
      ...(p.payDelayDays !== undefined ? { payDelayDays: p.payDelayDays } : {}),
      ...(p.lateDelayDays !== undefined ? { lateDelayDays: p.lateDelayDays } : {}),
      ...(p.payrollWeekday !== undefined ? { payrollWeekday: p.payrollWeekday } : {}),
    });
    await audit(a.user.id, "vendor_forecast.settings", null, { payDelayDays: n.payDelayDays, lateDelayDays: n.lateDelayDays });
    return c.json(n);
  })

  // ── recurring payments (rent, insurance, subscriptions, payroll…): money out counted by the forecast ──
  .get("/recurring", async (c) => c.json(await db().select().from(schema.recurringPayments).orderBy(asc(schema.recurringPayments.name))))

  .post("/recurring", requirePermission("accounting.manage"), async (c) => {
    const p = await body(c, zRecurring);
    const [row] = await db().insert(schema.recurringPayments).values(p).returning();
    await audit(auth(c).user.id, "recurring_payment.created", row.id, { name: p.name });
    return c.json(row, 201);
  })

  .patch("/recurring/:id", requirePermission("accounting.manage"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, zRecurring.partial());
    const [row] = await db().update(schema.recurringPayments).set({ ...p, updatedAt: new Date() }).where(eq(schema.recurringPayments.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(auth(c).user.id, "recurring_payment.updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  .delete("/recurring/:id", requirePermission("accounting.manage"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().delete(schema.recurringPayments).where(eq(schema.recurringPayments.id, id)).returning({ name: schema.recurringPayments.name });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(auth(c).user.id, "recurring_payment.deleted", id, { name: row.name });
    return c.json({ ok: true });
  })

  /** What is pasted from the spreadsheet: `apply: false` only shows what would come in; a name already listed is skipped, never doubled */
  .post("/recurring/import", requirePermission("accounting.manage"), async (c) => {
    const p = await body(c, z.object({ text: z.string().max(200_000), apply: z.boolean().default(false) }));
    // the payroll is planned per employee in the Paie tab: the spreadsheet's payroll line would be counted twice
    const parsed = parseSheet(p.text);
    const payrollLine = (n: string) => /masse salariale|payroll|^paie/i.test(n);
    const rows = parsed.rows.filter((r) => !payrollLine(r.name));
    const skipped = parsed.skipped;
    const payrollSkipped = parsed.rows.length - rows.length;
    const have = await db().select({ name: schema.recurringPayments.name, amount: schema.recurringPayments.amountCents }).from(schema.recurringPayments);
    const key = (n: string, a: number | null) => `${n.trim().toLowerCase()}|${a ?? ""}`;
    const known = new Set(have.map((h) => key(h.name, h.amount)));
    const fresh = rows.filter((r) => !known.has(key(r.name, r.amountCents)));
    if (p.apply && fresh.length) {
      await db().insert(schema.recurringPayments).values(fresh);
      await audit(auth(c).user.id, "recurring_payment.imported", null, { count: fresh.length });
    }
    return c.json({ rows, skipped, payrollSkipped, added: p.apply ? fresh.length : 0, alreadyThere: rows.length - fresh.length, applied: p.apply });
  })

  // ── payroll: what is planned each week per employee (hr.manage: it is everyone's pay) ──
  .get("/payroll", requirePermission("hr.manage"), async (c) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const employees = await payrollTable(today);
    return c.json({ weekday: (await forecastSettings()).payrollWeekday, weeks: AVERAGE_WEEKS, employees, plannedCents: employees.filter((e) => e.active).reduce((x, e) => x + (e.planCents ?? 0), 0) });
  })

  .put("/payroll/:userId", requirePermission("hr.manage"), async (c) => {
    const userId = zUuid.parse(c.req.param("userId"));
    const p = await body(c, z.object({ weeklyCents: z.number().int().min(0).max(100_000_000).nullable().optional(), active: z.boolean().optional() }));
    const [u] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.kind, "staff")));
    if (!u) throw new HTTPException(404, { message: "not_found" });
    const set = { ...(p.weeklyCents !== undefined ? { weeklyCents: p.weeklyCents } : {}), ...(p.active !== undefined ? { active: p.active } : {}), updatedAt: new Date() };
    await db().insert(schema.payrollPlans).values({ userId, ...set }).onConflictDoUpdate({ target: schema.payrollPlans.userId, set });
    await audit(auth(c).user.id, "payroll_plan.updated", userId, { weeklyCents: p.weeklyCents, active: p.active });
    return c.json({ ok: true });
  })

  .put("/payroll-day", requirePermission("hr.manage"), async (c) => {
    const p = await body(c, z.object({ weekday: z.number().int().min(1).max(7) }));
    await saveForecastSettings(auth(c).user.id, { payrollWeekday: p.weekday });
    return c.json({ weekday: p.weekday });
  })

  .post("/sync", requirePermission("accounting.manage"), async (c) => {
    try {
      const r = await pullBills(auth(c).user.id);
      await audit(auth(c).user.id, "vendor_bills.synced", null, { added: r.added, updated: r.updated, removed: r.removed });
      return c.json(r);
    } catch (e) {
      if (e instanceof QuickBooksError) throw new HTTPException(e.code === "not_connected" ? 409 : 502, { message: e.code === "not_connected" ? "quickbooks_not_connected" : "quickbooks_failed", cause: errText(e) });
      throw e;
    }
  });
