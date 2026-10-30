import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { clientOfCompany, splitBillable } from "./hr.ts";

/**
 * Timesheets (My tools): a technician's week. Time logged on tickets adds
 * itself (type "labour", with the ticket); other hours are entered by hand
 * with a type set in Admin › Temps et dépenses. The week is submitted, then
 * approved by someone who sees only the hours per type, not the details.
 */

/**
 * The starting types, created the first time. What a person can pick when adding an entry by hand: the work day, hours paid out
 * of the bank, training, a meeting, a trip, vacation, sick day and a holiday. "labour" is ticket time: it adds itself.
 */
const TIME_TYPES = [
  { name: "Journée de travail", kind: "workday", billable: false },
  { name: "Paiement de banque d'heures", kind: "bankpay", billable: false },
  { name: "Main-d'œuvre (billets)", kind: "labour", billable: true },
  { name: "Formation", kind: "other", billable: false },
  { name: "Réunion", kind: "other", billable: false },
  { name: "Déplacement", kind: "travel", billable: false },
  { name: "Vacances", kind: "vacation", billable: false },
  { name: "Maladie", kind: "sick", billable: false },
  { name: "Férié", kind: "holiday", billable: false },
];
/** Built in: always there, also on installs made before they existed */
const BUILT_IN_KINDS = ["workday", "bankpay", "vacation", "sick", "holiday", "travel"];
const EXPENSE_TYPES = [
  { name: "Kilométrage", unit: "km", unitPriceCents: 68, account: "5100", billable: false },
  { name: "Stationnement", unit: null, unitPriceCents: null, account: "5100", billable: false },
  { name: "Repas", unit: null, unitPriceCents: null, account: null, billable: false },
  { name: "Matériel pour un client", unit: null, unitPriceCents: null, account: "5000", billable: true },
  { name: "Logiciels et abonnements", unit: null, unitPriceCents: null, account: "5200", billable: false },
  { name: "Autre", unit: null, unitPriceCents: null, account: null, billable: false },
];

let ensured = false;
/** The types exist (the built-in labour one always). */
export async function ensureTypes() {
  if (ensured) return linkDefaultAccounts();
  const d = db();
  if (!(await d.select({ id: schema.timesheetTypes.id }).from(schema.timesheetTypes).limit(1)).length) {
    await d.insert(schema.timesheetTypes).values(TIME_TYPES.map((x, i) => ({ ...x, position: i })));
  }
  if (!(await d.select({ id: schema.expenseTypes.id }).from(schema.expenseTypes).limit(1)).length) {
    const accounts = new Map((await d.select({ id: schema.ledgerAccounts.id, number: schema.ledgerAccounts.number }).from(schema.ledgerAccounts)).map((a) => [a.number, a.id]));
    await d.insert(schema.expenseTypes).values(
      EXPENSE_TYPES.map((x, i) => ({ name: x.name, unit: x.unit, unitPriceCents: x.unitPriceCents, billable: x.billable, ledgerAccountId: x.account ? (accounts.get(x.account) ?? null) : null, position: i })),
    );
  }
  // the built-in types (work day, bank payout, vacation, sick day, holiday, trip) are always there, also on installs made before them
  for (const kind of BUILT_IN_KINDS) {
    if (!(await d.select({ id: schema.timesheetTypes.id }).from(schema.timesheetTypes).where(eq(schema.timesheetTypes.kind, kind)).limit(1)).length) {
      const def = TIME_TYPES.find((x) => x.kind === kind)!;
      await d.insert(schema.timesheetTypes).values({ name: def.name, kind, position: -1 });
    }
  }
  ensured = true;
  await linkDefaultAccounts();
}

/** The starting expense types get their account once the chart of accounts exists (made after them, or later). */
export async function linkDefaultAccounts() {
  const d = db();
  const missing = (await d.select().from(schema.expenseTypes)).filter((x) => !x.ledgerAccountId);
  if (!missing.length) return;
  const accounts = new Map((await d.select({ id: schema.ledgerAccounts.id, number: schema.ledgerAccounts.number }).from(schema.ledgerAccounts)).map((a) => [a.number, a.id]));
  for (const x of missing) {
    const number = EXPENSE_TYPES.find((e) => e.name === x.name)?.account;
    const id = number ? accounts.get(number) : undefined;
    if (id) await d.update(schema.expenseTypes).set({ ledgerAccountId: id, updatedAt: new Date() }).where(eq(schema.expenseTypes.id, x.id));
  }
}

export async function labourType() {
  await ensureTypes();
  const [t] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.kind, "labour")).limit(1);
  return t;
}

/** Monday of the week of a day (YYYY-MM-DD). */
export function weekStartOf(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** The week's sheet (made when first needed). */
export async function sheetOf(userId: string, weekStart: string) {
  const d = db();
  const [hit] = await d.select().from(schema.timesheets).where(and(eq(schema.timesheets.userId, userId), eq(schema.timesheets.weekStart, weekStart)));
  if (hit) return hit;
  const [row] = await d.insert(schema.timesheets).values({ userId, weekStart }).onConflictDoNothing().returning();
  return row ?? (await d.select().from(schema.timesheets).where(and(eq(schema.timesheets.userId, userId), eq(schema.timesheets.weekStart, weekStart))))[0];
}

/** A week can be changed while it is a draft or was sent back. */
export const editable = (status: string) => status === "draft" || status === "rejected";

/**
 * Time logged on a ticket: on the technician's timesheet, with the ticket and its client. `billableHours` is what is billed
 * (it may be more than the hours worked); what is not billable is kept apart, per client, for internal management.
 */
export async function addTicketTime(userId: string, p: { ticketId: number; ticketNumber: string | null; ticketTitle: string | null; companyId?: number | null; hours: number; date: string; note?: string | null; contractId?: string | null; billableHours?: number; ticketTimeId?: string | null }) {
  const type = await labourType();
  await sheetOf(userId, weekStartOf(p.date));
  const hoursX100 = Math.round(p.hours * 100);
  const split = splitBillable(hoursX100, p.billableHours === undefined ? hoursX100 : Math.round(p.billableHours * 100));
  await db()
    .insert(schema.timesheetEntries)
    .values({
      userId,
      date: p.date,
      typeId: type.id,
      hoursX100,
      note: p.note?.slice(0, 500) ?? null,
      ticketId: p.ticketId,
      ticketNumber: p.ticketNumber,
      ticketTitle: p.ticketTitle?.slice(0, 250) ?? null,
      contractId: p.contractId ?? null,
      billableX100: split.billableX100,
      nonBillableX100: split.nonBillableX100,
      clientId: await clientOfCompany(p.companyId),
      ticketTimeId: p.ticketTimeId ?? null,
      source: "ticket",
    });
}

/** A week's entries (with their type). */
export async function weekEntries(userId: string, weekStart: string) {
  return db()
    .select({ e: schema.timesheetEntries, type: schema.timesheetTypes.name, kind: schema.timesheetTypes.kind, typeBillable: schema.timesheetTypes.billable })
    .from(schema.timesheetEntries)
    .innerJoin(schema.timesheetTypes, eq(schema.timesheetTypes.id, schema.timesheetEntries.typeId))
    .where(and(eq(schema.timesheetEntries.userId, userId), gte(schema.timesheetEntries.date, weekStart), lte(schema.timesheetEntries.date, addDays(weekStart, 6))))
    .orderBy(asc(schema.timesheetEntries.date), asc(schema.timesheetEntries.createdAt));
}

/**
 * Hours per type for a week — no details, no billable figures (those are kept per client and shown nowhere for now). The
 * hours PAID are worked out in hr.ts (`weekPay`): work days less what is banked, vacation, sick days, holidays and bank payouts.
 * `enteredHours` is the time entered on tickets and by hand (training, meetings, trips): it fills the work day.
 */
export async function weekTotals(userId: string, weekStart: string) {
  const rows = await weekEntries(userId, weekStart);
  const byType = new Map<string, { type: string; kind: string; hoursX100: number }>();
  let entered = 0;
  for (const r of rows) {
    const v = byType.get(r.e.typeId) ?? { type: r.type, kind: r.kind, hoursX100: 0 };
    v.hoursX100 += r.e.hoursX100;
    byType.set(r.e.typeId, v);
    if (["labour", "other", "travel"].includes(r.kind)) entered += r.e.hoursX100;
  }
  const order = ["workday", "labour", "other", "travel", "vacation", "sick", "holiday", "bankpay"];
  const list = [...byType.values()].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.type.localeCompare(y.type));
  return { types: list.map((x) => ({ type: x.type, kind: x.kind, hours: x.hoursX100 / 100 })), enteredHours: entered / 100 };
}

/** Per day and type, for QuickBooks (one time activity each). */
export async function weekByDayAndType(userId: string, weekStart: string) {
  const rows = await weekEntries(userId, weekStart);
  const m = new Map<string, { date: string; typeId: string; type: string; hoursX100: number }>();
  for (const r of rows) {
    // the work day is attendance, not time to pay or bill; banked hours are not paid
    if (r.kind === "workday") continue;
    const k = `${r.e.date}|${r.e.typeId}`;
    const v = m.get(k) ?? { date: r.e.date, typeId: r.e.typeId, type: r.type, hoursX100: 0 };
    v.hoursX100 += r.e.hoursX100;
    m.set(k, v);
  }
  return [...m.values()];
}

/** The type rows by id (for QuickBooks items). */
export async function typesById(ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.timesheetTypes.$inferSelect>();
  return new Map((await db().select().from(schema.timesheetTypes).where(inArray(schema.timesheetTypes.id, ids))).map((t) => [t.id, t]));
}
