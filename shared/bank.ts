/**
 * The hours bank of a contract: hours of work sold by the month (a quantity of hours at a price per hour). The hours worked
 * under the contract are drawn from it. What happens to the hours not used in a month is the contract's choice:
 *  - `carry`: they add to next month's hours (the full bank is still bought every month);
 *  - `topup`: they stay for next month, which only buys what tops the bank back up (hours bought = bank − what is left);
 *  - `lose`: they are lost, every month starts with the bank's hours.
 * Months are calendar months (YYYY-MM, Québec time). The portal and the API use the same rule.
 */
export const BANK_ROLLOVERS = ["lose", "carry", "topup"] as const;
export type BankRollover = (typeof BANK_ROLLOVERS)[number];
export const bankRollover = (v: string | null | undefined): BankRollover => ((BANK_ROLLOVERS as readonly string[]).includes(v ?? "") ? (v as BankRollover) : "lose");

export type BankMonth = {
  month: string;
  /** Hours that can be used this month (the bank, plus what was carried when the hours roll over) */
  available: number;
  used: number;
  /** Hours left at the end of the month (never below 0) */
  left: number;
  /** Hours worked beyond what was available (taken off next month) */
  over: number;
  /** Hours bought for this month (the bank, or only the top-up) */
  charge: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The price of the bank for one month as a bundle (price per unit, quantity): whole hours at the hourly price, else one unit at the total */
export function bankBundle(hours: number, rateCents: number): { priceCents: number; quantity: number } {
  return Number.isInteger(hours) && hours >= 1 ? { priceCents: rateCents, quantity: hours } : { priceCents: Math.round(hours * rateCents), quantity: 1 };
}

/** Month by month from the contract's first month to `today`'s (or its last), with what is left and what each month buys */
export function bankMonths(p: { hours: number; rollover: BankRollover; start: string | null; end?: string | null; endedOn?: string | null; today: string; used: Map<string, number> }): BankMonth[] {
  if (!p.start || !(p.hours > 0)) return [];
  const last = [p.today, p.end, p.endedOn].filter((d): d is string => Boolean(d)).reduce((a, b) => (b < a ? b : a)).slice(0, 7);
  const rows: BankMonth[] = [];
  let [y, m] = [Number(p.start.slice(0, 4)), Number(p.start.slice(5, 7))];
  let leftover = 0;
  let debt = 0;
  for (let i = 0; i < 240; i++) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    if (month > last) break;
    // hours worked beyond the bank (the technician chose to go negative) are taken right away from next month
    const available = (p.rollover === "carry" ? p.hours + leftover : p.hours) - debt;
    const charge = p.rollover === "topup" ? Math.max(0, p.hours - leftover) : p.hours;
    const used = round2(p.used.get(month) ?? 0);
    const left = Math.max(0, round2(available - used));
    const over = Math.max(0, round2(used - available));
    rows.push({ month, available: round2(available), used, left, over, charge: round2(charge) });
    leftover = left;
    debt = over;
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return rows;
}

/** Where the bank stands today: the hours that could be used this month, the ones used and what is left */
export function bankNow(rows: BankMonth[], today: string): { available: number; used: number; left: number; over: number } | null {
  const row = rows.find((r) => r.month === today.slice(0, 7));
  return row ? { available: row.available, used: row.used, left: row.left, over: row.over } : null;
}
