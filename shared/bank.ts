/**
 * The hours bank of a contract: hours of work sold by the month (a quantity of hours at a price per hour). The hours worked
 * under the contract are drawn from it. What happens to the hours not used in a month is the contract's choice:
 *  - `carry`: they add to next month's hours (the full bank is still bought every month);
 *  - `topup`: they stay for next month and can all be used, even above the bank (a client with 64 h left uses them and buys nothing); the month only buys what brings the bank back to its hours (hours bought = bank − what is left, none when he has more). Hours taken from next month (the "go negative" choice) are bought back too: 5 h over at a 20 h bank = 25 h bought next month;
 *  - `lose`: they are lost, every month starts with the bank's hours.
 * Months are calendar months (YYYY-MM, Québec time). The portal and the API use the same rule.
 */
export const BANK_ROLLOVERS = ["lose", "carry", "topup"] as const;
export type BankRollover = (typeof BANK_ROLLOVERS)[number];
export const bankRollover = (v: string | null | undefined): BankRollover => ((BANK_ROLLOVERS as readonly string[]).includes(v ?? "") ? (v as BankRollover) : "lose");

export type BankMonth = {
  month: string;
  /** Hours that can be used this month (the bank, plus what was carried when the hours roll over, plus what was added or taken off by hand) */
  available: number;
  /** Hours added (+) or taken off (−) by hand this month */
  adjusted: number;
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
export function bankMonths(p: { hours: number; rollover: BankRollover; start: string | null; end?: string | null; endedOn?: string | null; today: string; used: Map<string, number>; adjust?: Map<string, number>; /** Go on past today to the contract's end with no more hours worked (to foresee what the next months buy) */ project?: boolean }): BankMonth[] {
  if (!p.start || !(p.hours > 0)) return [];
  const last = [p.project ? null : p.today, p.end, p.endedOn].filter((d): d is string => Boolean(d)).reduce((a, b) => (b < a ? b : a)).slice(0, 7);
  const rows: BankMonth[] = [];
  let [y, m] = [Number(p.start.slice(0, 4)), Number(p.start.slice(5, 7))];
  let leftover = 0;
  let debt = 0;
  for (let i = 0; i < 240; i++) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    if (month > last) break;
    // hours worked beyond the bank (the technician chose to go negative) are taken right away from next month
    const adjusted = round2(p.adjust?.get(month) ?? 0);
    // what he still has, once the hours taken from this month are off (below zero after a "go negative")
    const net = leftover - debt;
    const available = (p.rollover === "carry" ? p.hours + net : p.rollover === "topup" ? Math.max(p.hours, net) : p.hours - debt) + adjusted;
    const charge = p.rollover === "topup" ? Math.max(0, p.hours - net) : p.hours;
    const used = round2(p.used.get(month) ?? 0);
    const left = Math.max(0, round2(available - used));
    const over = Math.max(0, round2(used - available));
    rows.push({ month, available: round2(available), adjusted, used, left, over, charge: round2(charge) });
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

/**
 * The schedule of an hours bank that tops up each month, as it will really be charged: a month buys only the hours that bring
 * the bank back to its hours (none while the client has more). `hoursByMonth` is `charge` of `bankMonths(..., project: true)`.
 * Only whole-period bundle pieces change (a prorated first or last month keeps its price); the total follows.
 */
export function withTopupCharges<T extends { entries: { date: string; amountCents: number; prorated: boolean; pieces: { lineId: string; amountCents: number; prorated: boolean }[] }[]; revenueCents: number }>(ch: T, hoursByMonth: Map<string, number>, unitCents: number): T {
  const entries = ch.entries.map((e) => {
    const hours = hoursByMonth.get(e.date.slice(0, 7));
    const piece = e.pieces.find((q) => q.lineId === "bundle" && !q.prorated);
    if (hours === undefined || !piece) return e;
    const amountCents = Math.round(hours * unitCents);
    return { ...e, amountCents: e.amountCents - piece.amountCents + amountCents, pieces: e.pieces.map((q) => (q === piece ? { ...q, amountCents } : q)) };
  });
  return { ...ch, entries, revenueCents: entries.reduce((n, e) => n + e.amountCents, 0) };
}
