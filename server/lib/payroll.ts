import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { weekPay } from "./hr.ts";
import { mondayOf } from "./pipeline.ts";
import { addDays } from "./timesheets.ts";

/**
 * Payroll for the cash forecast. Each employee has a weekly amount fixed by hand (`payroll_plans`); the average of what
 * they were really paid the last weeks (their timesheet × their hourly wage of the HR file, as `weekPay` works it
 * out) is shown beside it to help choose. Payday is one weekday for everyone (the forecast settings).
 */
export const AVERAGE_WEEKS = 8;

export type PayrollRow = {
  userId: string;
  name: string;
  wageCents: number | null;
  /** Average paid a week over the last complete weeks that had pay (none when no wage or no pay) */
  avgWeeklyCents: number | null;
  weeks: number;
  /** The last complete week's pay */
  lastWeekCents: number | null;
  planCents: number | null;
  active: boolean;
};

/** Active staff who are paid through the portal: they fill a timesheet, or already have a wage or a plan. */
export async function payrollTable(today: string): Promise<PayrollRow[]> {
  const d = db();
  const staff = await d
    .select({ id: schema.users.id, name: schema.users.name, required: schema.users.timesheetRequired })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  const ids = staff.map((s) => s.id);
  if (!ids.length) return [];
  const plans = new Map((await d.select().from(schema.payrollPlans).where(inArray(schema.payrollPlans.userId, ids))).map((p) => [p.userId, p]));
  const wages = new Map((await d.select().from(schema.hrProfiles).where(inArray(schema.hrProfiles.userId, ids))).map((p) => [p.userId, p.hourlyWageCents]));
  const lastMonday = addDays(mondayOf(today), -7);
  const rows: PayrollRow[] = [];
  for (const s of staff) {
    const plan = plans.get(s.id);
    const wage = wages.get(s.id) ?? null;
    if (!s.required && wage === null && !plan) continue;
    const paid: number[] = [];
    let last: number | null = null;
    for (let i = 0; i < AVERAGE_WEEKS && wage !== null; i++) {
      const week = addDays(lastMonday, -7 * i);
      const cents = (await weekPay(s.id, week)).paidCents;
      if (i === 0) last = cents;
      if (cents && cents > 0) paid.push(cents);
    }
    rows.push({
      userId: s.id,
      name: s.name,
      wageCents: wage,
      avgWeeklyCents: paid.length ? Math.round(paid.reduce((x, c) => x + c, 0) / paid.length) : null,
      weeks: paid.length,
      lastWeekCents: last,
      planCents: plan?.weeklyCents ?? null,
      active: plan?.active ?? true,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the plan costs each week (the active employees with a fixed amount) and how many people it covers. */
export async function plannedWeekly(): Promise<{ cents: number; people: number }> {
  const plans = await db()
    .select({ c: schema.payrollPlans.weeklyCents, userActive: schema.users.active })
    .from(schema.payrollPlans)
    .innerJoin(schema.users, eq(schema.users.id, schema.payrollPlans.userId))
    .where(eq(schema.payrollPlans.active, true));
  const live = plans.filter((p) => p.userActive && p.c && p.c > 0);
  return { cents: live.reduce((x, p) => x + (p.c ?? 0), 0), people: live.length };
}
