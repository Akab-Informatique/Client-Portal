/**
 * Prorata of a recurring service added to a contract (the portal and the API use the same rule).
 *
 * A service is billed per period: monthly = calendar months, yearly = contract years (from the contract's
 * start date, one year at a time). Added during a period, its first charge covers only the days left in
 * it: price × days left ÷ days in the period. Then every full period, and a last one prorated again when
 * the contract ends before the period does. Dates are YYYY-MM-DD, both ends included.
 */
export type ServicePeriod = "monthly" | "yearly";
export type ProrataPeriod = {
  from: string;
  to: string;
  /** Days covered by the service in this period */
  days: number;
  /** Days of the whole period (a month, or a contract year) */
  periodDays: number;
  /** The whole period is covered: no prorata */
  full: boolean;
  amountCents: number;
};
export type Prorata = {
  periods: ProrataPeriod[];
  /** What is charged when the service is added: its first period */
  firstCents: number;
  /** Every period up to the end of the contract */
  totalCents: number;
};
export type ProrataError = "dates" | "outside";

const DAY = 86_400_000;
const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const plus = (d: string, n: number) => iso(ms(d) + n * DAY);
const inclusive = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY) + 1;
const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
const endOfMonth = (d: string) => `${d.slice(0, 8)}${String(daysInMonth(d)).padStart(2, "0")}`;
/** The same day n years later (29 February → 28 February in a common year) */
export function addYears(d: string, n: number): string {
  const y = Number(d.slice(0, 4)) + n;
  const m = Number(d.slice(5, 7));
  const day = Math.min(Number(d.slice(8, 10)), new Date(Date.UTC(y, m, 0)).getUTCDate());
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The charges of a service added on a day to a contract running from `start` to `end`. */
export function prorata(p: { period: ServicePeriod; priceCents: number; addedOn: string; start: string; end: string }): Prorata | ProrataError {
  const { period, priceCents, addedOn, start, end } = p;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(addedOn) || end < start) return "dates";
  if (addedOn < start || addedOn > end) return "outside";
  const periods: ProrataPeriod[] = [];
  const take = (from: string, to: string, periodFrom: string, periodTo: string) => {
    const days = inclusive(from, to);
    const periodDays = inclusive(periodFrom, periodTo);
    const full = from === periodFrom && to === periodTo;
    periods.push({ from, to, days, periodDays, full, amountCents: full ? priceCents : Math.round((priceCents * days) / periodDays) });
  };
  let cursor = addedOn;
  if (period === "monthly") {
    while (cursor <= end && periods.length < 600) {
      const monthStart = `${cursor.slice(0, 8)}01`;
      const monthEnd = endOfMonth(cursor);
      take(cursor, monthEnd < end ? monthEnd : end, monthStart, monthEnd);
      cursor = plus(monthEnd < end ? monthEnd : end, 1);
    }
  } else {
    // the contract year the day falls in
    let k = 0;
    while (addYears(start, k + 1) <= addedOn) k++;
    while (cursor <= end && periods.length < 100) {
      const yearStart = addYears(start, k);
      const yearEnd = plus(addYears(start, k + 1), -1);
      take(cursor, yearEnd < end ? yearEnd : end, yearStart, yearEnd);
      cursor = plus(yearEnd < end ? yearEnd : end, 1);
      k++;
    }
  }
  return { periods, firstCents: periods[0]?.amountCents ?? 0, totalCents: periods.reduce((n, x) => n + x.amountCents, 0) };
}
