import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";
import { notify, usersWith } from "./notify.ts";
import { addDays, weekEntries, weekStartOf } from "./timesheets.ts";

/**
 * Human resources (the RH tab) and what the timesheet pays.
 *
 * Three kinds of hours, never mixed:
 *  1. paid hours — what the employee is paid: work days (less the hours put in the bank), vacation, sick days,
 *     holidays and hours paid out of the bank. They are what the timesheet report shows.
 *  2. billable hours and 3. non billable hours — time spent on clients, kept per client (`timesheet_entries.client_id`)
 *     only to see how productive a technician is; shown nowhere for now.
 *
 * The accounts of an employee: the hours bank and the vacation bank, in dollars (hours × the hourly wage of the day),
 * and the sick days, in hours. Everything that moves them is a row of `hr_ledger`.
 */

/** Vacation pay put aside on each week's gross pay */
export const VACATION_RATE = 0.04;
/** Holiday pay: this part of the wages of the 4 complete weeks before the holiday's week (overtime left out) */
export const HOLIDAY_FRACTION = 1 / 20;
export const OVERTIME_AFTER_DEFAULT_X100 = 4000;

export type Account = "bank" | "vacation" | "sick";

export async function hrProfile(userId: string) {
  const [p] = await db().select().from(schema.hrProfiles).where(eq(schema.hrProfiles.userId, userId));
  return { hourlyWageCents: p?.hourlyWageCents ?? null, overtimeAfterX100: p?.overtimeAfterX100 ?? OVERTIME_AFTER_DEFAULT_X100 };
}

/** Hours (×100) at an hourly wage (cents) → cents */
export const moneyOf = (hoursX100: number, wageCents: number) => Math.round((hoursX100 * wageCents) / 100);
/** Cents at an hourly wage → hours ×100 */
export const hoursOf = (cents: number, wageCents: number) => (wageCents > 0 ? Math.round((cents * 100) / wageCents) : 0);

export async function balances(userId: string) {
  const rows = await db()
    .select({ account: schema.hrLedger.account, cents: sql<number>`coalesce(sum(${schema.hrLedger.cents}), 0)::float8`, hours: sql<number>`coalesce(sum(${schema.hrLedger.hoursX100}), 0)::float8` })
    .from(schema.hrLedger)
    .where(eq(schema.hrLedger.userId, userId))
    .groupBy(schema.hrLedger.account);
  const by = new Map(rows.map((r) => [r.account, r]));
  return { bankCents: Math.round(by.get("bank")?.cents ?? 0), vacationCents: Math.round(by.get("vacation")?.cents ?? 0), sickHoursX100: Math.round(by.get("sick")?.hours ?? 0) };
}

type Row = typeof schema.hrLedger.$inferInsert;

/** The ledger rows an entry makes, by the kind of its type (nothing for the others) */
function ledgerRows(kind: string, e: { id: string; userId: string; hoursX100: number; bankX100: number }, wage: number | null): Row[] {
  const base = { userId: e.userId, entryId: e.id };
  if (kind === "workday" && e.bankX100 > 0) return [{ ...base, account: "bank", kind: "banked", cents: moneyOf(e.bankX100, wage ?? 0) }];
  if (kind === "bankpay") return [{ ...base, account: "bank", kind: "payout", cents: -moneyOf(e.hoursX100, wage ?? 0) }];
  if (kind === "vacation") return [{ ...base, account: "vacation", kind: "used", cents: -moneyOf(e.hoursX100, wage ?? 0) }];
  if (kind === "sick") return [{ ...base, account: "sick", kind: "used", hoursX100: -e.hoursX100 }];
  return [];
}

/** Whether an entry of this kind has to be turned into dollars (it needs the wage) */
export const needsWage = (kind: string, bankX100 = 0) => kind === "bankpay" || kind === "vacation" || kind === "holiday" || (kind === "workday" && bankX100 > 0);

/** The wage, or the refusal that says to set it in the RH tab first */
export async function wageFor(userId: string, kind: string, bankX100 = 0): Promise<number | null> {
  const { hourlyWageCents } = await hrProfile(userId);
  if (needsWage(kind, bankX100) && !hourlyWageCents) throw new HTTPException(409, { message: "hr_wage_missing" });
  return hourlyWageCents;
}

const ACCOUNT_LABEL: Record<Account, string> = { bank: "bank", vacation: "vacation", sick: "sick" };

/** The accounts that are below zero now */
export async function negativeAccounts(userId: string): Promise<Account[]> {
  const b = await balances(userId);
  const out: Account[] = [];
  if (b.bankCents < 0) out.push("bank");
  if (b.vacationCents < 0) out.push("vacation");
  if (b.sickHoursX100 < 0) out.push("sick");
  return out;
}

/** Tell everyone who looks after RH that an account went below zero (the entry is kept; the admins decide what to do) */
export async function warnNegative(userId: string, accounts: Account[]) {
  if (!accounts.length) return;
  const [u] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
  const admins = await usersWith("staff", "hr.manage");
  for (const account of accounts) await notify(admins, { type: "hr.negative", data: { userId, name: u?.name ?? "", account: ACCOUNT_LABEL[account] }, link: `/hr?user=${userId}` });
}

/**
 * (Re)write what an entry does to the accounts: its old rows go, its new ones come. Returns the accounts that are below
 * zero afterwards — the entry stays, the admins are told, and the report shows it.
 */
export async function applyEntryLedger(e: { id: string; userId: string; hoursX100: number; bankX100: number }, kind: string): Promise<Account[]> {
  const d = db();
  await d.delete(schema.hrLedger).where(eq(schema.hrLedger.entryId, e.id));
  const wage = (await hrProfile(e.userId)).hourlyWageCents;
  const rows = ledgerRows(kind, e, wage);
  if (!rows.length) return [];
  await d.insert(schema.hrLedger).values(rows);
  const negative = await negativeAccounts(e.userId);
  await warnNegative(e.userId, negative);
  return negative;
}

/** What a person is paid for a week, from the entries of that week. */
export async function weekPay(userId: string, weekStart: string) {
  const rows = await weekEntries(userId, weekStart);
  const { hourlyWageCents: wage } = await hrProfile(userId);
  let workday = 0;
  let banked = 0;
  let vacation = 0;
  let sick = 0;
  let holiday = 0;
  let holidayCents = 0;
  let bankPaid = 0;
  for (const r of rows) {
    const h = r.e.hoursX100;
    if (r.kind === "workday") {
      workday += h;
      banked += r.e.bankX100;
    } else if (r.kind === "vacation") vacation += h;
    else if (r.kind === "sick") sick += h;
    else if (r.kind === "holiday") {
      holiday += h;
      holidayCents += r.e.amountCents ?? 0;
    } else if (r.kind === "bankpay") bankPaid += h;
  }
  const workdayPaid = Math.max(0, workday - banked);
  const paid = workdayPaid + vacation + sick + holiday + bankPaid;
  const paidCents = wage == null ? null : moneyOf(workdayPaid + vacation + sick + bankPaid, wage) + holidayCents;
  // vacation pay put aside: 4 % of the gross pay (what is paid, less the vacation taken, which comes out of that account)
  const grossCents = wage == null ? null : moneyOf(workdayPaid + sick + bankPaid, wage) + holidayCents;
  return {
    wageCents: wage,
    /** The work days: start to end, lunch taken off */
    workdayHours: workday / 100,
    /** Part of the work days put in the hours bank (not paid this week) */
    bankedHours: banked / 100,
    workdayPaidHours: workdayPaid / 100,
    vacationHours: vacation / 100,
    sickHours: sick / 100,
    holidayHours: holiday / 100,
    holidayCents,
    bankPaidHours: bankPaid / 100,
    /** Hours paid to the employee this week */
    paidHours: paid / 100,
    paidCents,
    /** 4 % of the gross pay, added to the vacation bank */
    vacationAccrualCents: grossCents == null ? null : Math.round(grossCents * VACATION_RATE),
  };
}
export type WeekPay = Awaited<ReturnType<typeof weekPay>>;

/** Put the week's 4 % in the vacation bank (once a week) once it is sent; take it back when the week is open again. */
export async function refreshAccrual(userId: string, weekStart: string) {
  const d = db();
  const [sheet] = await d.select({ status: schema.timesheets.status }).from(schema.timesheets).where(and(eq(schema.timesheets.userId, userId), eq(schema.timesheets.weekStart, weekStart)));
  await d.delete(schema.hrLedger).where(and(eq(schema.hrLedger.userId, userId), eq(schema.hrLedger.weekStart, weekStart), eq(schema.hrLedger.kind, "accrual")));
  if (!sheet || !["submitted", "approved", "paid"].includes(sheet.status)) return;
  const pay = await weekPay(userId, weekStart);
  if (!pay.vacationAccrualCents) return;
  await d.insert(schema.hrLedger).values({ userId, account: "vacation", kind: "accrual", cents: pay.vacationAccrualCents, weekStart, note: "4 %" });
}

/**
 * Holiday pay for a holiday on `date`: 1/20 of the wages earned in the 4 complete weeks before the holiday's week, without
 * overtime (the paid hours of a week beyond the overtime threshold are left out). The wages are the work days (less what was
 * banked), vacation and sick hours, at the hourly wage.
 */
export async function holidayPay(userId: string, date: string): Promise<{ cents: number; hoursX100: number }> {
  const { hourlyWageCents: wage, overtimeAfterX100 } = await hrProfile(userId);
  if (!wage) throw new HTTPException(409, { message: "hr_wage_missing" });
  const week = weekStartOf(date);
  const from = addDays(week, -28);
  const rows = await db()
    .select({ e: schema.timesheetEntries, kind: schema.timesheetTypes.kind })
    .from(schema.timesheetEntries)
    .innerJoin(schema.timesheetTypes, eq(schema.timesheetTypes.id, schema.timesheetEntries.typeId))
    .where(and(eq(schema.timesheetEntries.userId, userId), gte(schema.timesheetEntries.date, from), lte(schema.timesheetEntries.date, addDays(week, -1)), inArray(schema.timesheetTypes.kind, ["workday", "vacation", "sick"])));
  const perWeek = new Map<string, number>();
  for (const r of rows) {
    const h = r.kind === "workday" ? Math.max(0, r.e.hoursX100 - r.e.bankX100) : r.e.hoursX100;
    const w = weekStartOf(r.e.date);
    perWeek.set(w, (perWeek.get(w) ?? 0) + h);
  }
  let regular = 0;
  for (const h of perWeek.values()) regular += Math.min(h, overtimeAfterX100);
  const cents = Math.round(moneyOf(regular, wage) * HOLIDAY_FRACTION);
  return { cents, hoursX100: hoursOf(cents, wage) };
}

// ── Billable and non billable time, kept per client ──────────────────────────────────

/** What is billable and what is not in an entry: not billable = the hours less the billable ones, never below zero (more can be billed than was worked) */
export function splitBillable(hoursX100: number, billableX100: number | null | undefined) {
  const billable = Math.max(0, billableX100 ?? 0);
  return { billableX100: billable, nonBillableX100: Math.max(0, hoursX100 - billable) };
}

/** How productive: the billable hours over the hours of the work days paid, in percent (null: no work day). 7,5 h worked and 9 h billed is 120 %. */
export function productivityPct(billableX100: number, workdayX100: number): number | null {
  return workdayX100 > 0 ? Math.round((billableX100 / workdayX100) * 1000) / 10 : null;
}

/** The client behind a ticket-side company id (the clients table keeps it as `autotask_id`) */
export async function clientOfCompany(companyId: number | null | undefined): Promise<string | null> {
  if (companyId == null) return null;
  const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, companyId));
  return c?.id ?? null;
}

/** Billable and non billable hours per client over a period (internal management; no screen uses it yet) */
export async function clientHourTotals(p: { from: string; to: string; clientId?: string; userId?: string }) {
  const rows = await db()
    .select({ clientId: schema.timesheetEntries.clientId, billable: sql<number>`coalesce(sum(${schema.timesheetEntries.billableX100}), 0)::float8`, nonBillable: sql<number>`coalesce(sum(${schema.timesheetEntries.nonBillableX100}), 0)::float8` })
    .from(schema.timesheetEntries)
    .where(and(sql`${schema.timesheetEntries.clientId} is not null`, gte(schema.timesheetEntries.date, p.from), lte(schema.timesheetEntries.date, p.to), p.clientId ? eq(schema.timesheetEntries.clientId, p.clientId) : undefined, p.userId ? eq(schema.timesheetEntries.userId, p.userId) : undefined))
    .groupBy(schema.timesheetEntries.clientId);
  return rows.map((r) => ({ clientId: r.clientId as string, billableHours: r.billable / 100, nonBillableHours: r.nonBillable / 100 }));
}
