import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * Timesheets (My tools): a technician's week. Time logged on tickets adds
 * itself (type "labour", with the ticket); other hours are entered by hand
 * with a type set in Admin › Temps et dépenses. The week is submitted, then
 * approved by someone who sees only the hours per type, not the details.
 */

/** The starting types, created the first time (changeable in Admin). */
const TIME_TYPES = [
  { name: "Main-d'œuvre (billets)", kind: "labour" },
  { name: "Administration", kind: "other" },
  { name: "Formation", kind: "other" },
  { name: "Réunion", kind: "other" },
  { name: "Déplacement", kind: "other" },
  { name: "Vacances", kind: "other" },
  { name: "Maladie", kind: "other" },
];
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

/** Time logged on a ticket: on the technician's timesheet, with the ticket. */
export async function addTicketTime(userId: string, p: { ticketId: number; ticketNumber: string | null; ticketTitle: string | null; hours: number; date: string; note?: string | null }) {
  const type = await labourType();
  await sheetOf(userId, weekStartOf(p.date));
  await db()
    .insert(schema.timesheetEntries)
    .values({ userId, date: p.date, typeId: type.id, hoursX100: Math.round(p.hours * 100), note: p.note?.slice(0, 500) ?? null, ticketId: p.ticketId, ticketNumber: p.ticketNumber, ticketTitle: p.ticketTitle?.slice(0, 250) ?? null, source: "ticket" });
}

/** A week's entries (with their type). */
export async function weekEntries(userId: string, weekStart: string) {
  return db()
    .select({ e: schema.timesheetEntries, type: schema.timesheetTypes.name, kind: schema.timesheetTypes.kind })
    .from(schema.timesheetEntries)
    .innerJoin(schema.timesheetTypes, eq(schema.timesheetTypes.id, schema.timesheetEntries.typeId))
    .where(and(eq(schema.timesheetEntries.userId, userId), gte(schema.timesheetEntries.date, weekStart), lte(schema.timesheetEntries.date, addDays(weekStart, 6))))
    .orderBy(asc(schema.timesheetEntries.date), asc(schema.timesheetEntries.createdAt));
}

/** Hours per type for a week: labour (tickets) and each other type — no details. */
export async function weekTotals(userId: string, weekStart: string) {
  const rows = await weekEntries(userId, weekStart);
  const byType = new Map<string, { type: string; kind: string; hoursX100: number }>();
  for (const r of rows) {
    const v = byType.get(r.e.typeId) ?? { type: r.type, kind: r.kind, hoursX100: 0 };
    v.hoursX100 += r.e.hoursX100;
    byType.set(r.e.typeId, v);
  }
  const list = [...byType.values()].sort((x, y) => (x.kind === "labour" ? -1 : y.kind === "labour" ? 1 : x.type.localeCompare(y.type)));
  return { types: list.map((x) => ({ type: x.type, kind: x.kind, hours: x.hoursX100 / 100 })), labourHours: list.filter((x) => x.kind === "labour").reduce((s, x) => s + x.hoursX100, 0) / 100, totalHours: list.reduce((s, x) => s + x.hoursX100, 0) / 100 };
}

/** Per day and type, for QuickBooks (one time activity each). */
export async function weekByDayAndType(userId: string, weekStart: string) {
  const rows = await weekEntries(userId, weekStart);
  const m = new Map<string, { date: string; typeId: string; type: string; hoursX100: number }>();
  for (const r of rows) {
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
