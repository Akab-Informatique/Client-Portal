import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * Cash forecast (Accounting › Paiements fournisseurs): the money in (the portal's unpaid client invoices, on their due
 * day) against the money out (the vendors' unpaid bills copied from QuickBooks, on their due day), day by day from the
 * balance typed by hand. A forecast, never a booking: nothing is paid or collected by it.
 */
export type ForecastSettings = {
  /** What is in the bank today (cents), typed by hand: the portal does not read the bank */
  balanceCents: number;
  balanceOn: string | null;
  /** Clients usually pay this many days after the due day */
  payDelayDays: number;
  /** An invoice already late is counted as collected this many days from today */
  lateDelayDays: number;
};

const PROVIDER = "vendor.forecast";
const DEFAULTS: ForecastSettings = { balanceCents: 0, balanceOn: null, payDelayDays: 0, lateDelayDays: 14 };

export async function forecastSettings(): Promise<ForecastSettings> {
  const [r] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  return { ...DEFAULTS, ...((r?.config ?? {}) as Partial<ForecastSettings>) };
}

export async function saveForecastSettings(actorId: string | null, p: Partial<ForecastSettings>) {
  const cur = await forecastSettings();
  const n = { ...cur, ...p };
  const config = { balanceCents: n.balanceCents, balanceOn: n.balanceOn, payDelayDays: n.payDelayDays, lateDelayDays: n.lateDelayDays };
  const set = { config, updatedBy: actorId, updatedAt: new Date() };
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled: true, ...set })
    .onConflictDoUpdate({ target: schema.integrations.provider, set });
  return n;
}

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
export const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type ForecastEvent = { kind: "in" | "out"; date: string; cents: number; label: string; ref: string | null; late: boolean };
export type ForecastDay = { date: string; inCents: number; outCents: number; balanceCents: number };

/** The events of the horizon, day by day, the running balance and the verdict (first day the money runs out). */
export async function cashForecast(days: number, today = todayQc()) {
  const s = await forecastSettings();
  const d = db();
  const horizon = addDay(today, days);

  // money in: what is still owed on the invoices (not voided, not paid), on the due day plus the clients' usual delay
  const invoices = await d
    .select({ i: schema.clientInvoices, client: schema.clients.name })
    .from(schema.clientInvoices)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientInvoices.clientId))
    .where(and(eq(schema.clientInvoices.voided, false)));
  const open = invoices.filter((x) => x.i.paidOn === null);
  const payments = open.length ? await d.select().from(schema.invoicePayments).where(inArray(schema.invoicePayments.invoiceId, open.map((x) => x.i.id))) : [];
  const received = new Map<string, number>();
  for (const p of payments) received.set(p.invoiceId, (received.get(p.invoiceId) ?? 0) + p.amountCents);

  const events: ForecastEvent[] = [];
  let noDueIn = 0;
  for (const { i, client } of open) {
    const balance = i.totalCents - (received.get(i.id) ?? 0);
    if (balance <= 0) continue;
    if (!i.dueOn) {
      noDueIn += balance;
      continue;
    }
    const expected = addDay(i.dueOn, s.payDelayDays);
    const late = expected < today;
    events.push({ kind: "in", date: late ? addDay(today, s.lateDelayDays) : expected, cents: balance, label: `${client} · #${i.number}`, ref: i.id, late });
  }

  // money out: the vendors' unpaid bills, on their due day (a late one is paid today)
  const bills = await d.select().from(schema.vendorBills);
  let noDueOut = 0;
  for (const b of bills) {
    if (b.balanceCents <= 0) continue;
    if (!b.dueOn) {
      noDueOut += b.balanceCents;
      continue;
    }
    const late = b.dueOn < today;
    events.push({ kind: "out", date: late ? today : b.dueOn, cents: b.balanceCents, label: `${b.vendorName}${b.docNumber ? ` · #${b.docNumber}` : ""}`, ref: b.id, late });
  }

  const inside = events.filter((e) => e.date <= horizon).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "in" ? -1 : 1));
  const series: ForecastDay[] = [];
  let balance = s.balanceCents;
  let lowest = { date: today, balanceCents: balance };
  let shortfall: { date: string; balanceCents: number } | null = null;
  for (let n = 0; n <= days; n++) {
    const date = addDay(today, n);
    const today_ = inside.filter((e) => e.date === date);
    const inCents = today_.filter((e) => e.kind === "in").reduce((x, e) => x + e.cents, 0);
    const outCents = today_.filter((e) => e.kind === "out").reduce((x, e) => x + e.cents, 0);
    balance += inCents - outCents;
    series.push({ date, inCents, outCents, balanceCents: balance });
    if (balance < lowest.balanceCents) lowest = { date, balanceCents: balance };
    if (!shortfall && balance < 0) shortfall = { date, balanceCents: balance };
  }
  const sum = (kind: "in" | "out") => inside.filter((e) => e.kind === kind).reduce((x, e) => x + e.cents, 0);
  return {
    today,
    days,
    settings: s,
    startCents: s.balanceCents,
    inCents: sum("in"),
    outCents: sum("out"),
    endCents: balance,
    lowest,
    /** the first day the balance goes below zero: the money to find, and when */
    shortfall,
    /** what is not on the line: no due date, or beyond the horizon */
    leftOut: { noDueIn, noDueOut, beyondIn: events.filter((e) => e.kind === "in" && e.date > horizon).reduce((x, e) => x + e.cents, 0), beyondOut: events.filter((e) => e.kind === "out" && e.date > horizon).reduce((x, e) => x + e.cents, 0) },
    series,
    events: inside,
  };
}
