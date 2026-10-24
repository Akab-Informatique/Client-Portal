/**
 * When an invoice falls due. It counts from the day it is **sent** — an invoice is sent as soon as it is made — not from
 * the date written on it: the client's terms (0 = due on receipt) plus one day. Made and sent the 5th with terms of
 * 15 days: due the 21st; on receipt: the 6th.
 */
export const DUE_EXTRA_DAYS = 1;

/** YYYY-MM-DD plus a number of days (calendar days, no time zone involved) */
export function addDaysYmd(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The due day of an invoice sent on `sentDay` under terms of `termsDays` days (0 = on receipt) */
export const dueAfterSent = (sentDay: string, termsDays: number) => addDaysYmd(sentDay, Math.max(0, termsDays) + DUE_EXTRA_DAYS);
