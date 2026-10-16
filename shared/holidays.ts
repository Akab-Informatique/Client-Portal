/**
 * Quebec statutory holidays (Loi sur les normes du travail), computed for any
 * year, so the calendars show them without anyone entering them.
 * Good Friday and Easter Monday are both listed: the employer picks one.
 */

export type HolidayKey =
  | "newYear"
  | "goodFriday"
  | "easterMonday"
  | "patriots"
  | "stJean"
  | "canada"
  | "labour"
  | "thanksgiving"
  | "christmas";

export type Holiday = { date: string; key: HolidayKey };

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Day of week (0 = Sunday) without time zone surprises */
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const shift = (y: number, m: number, d: number, days: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/** Easter Sunday (Gregorian, anonymous algorithm): [month, day] */
function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** The n-th Monday of a month (n = 1, 2…) */
const nthMonday = (y: number, m: number, n: number) => ymd(y, m, 1 + ((8 - dow(y, m, 1)) % 7) + 7 * (n - 1));

/** June 24 and July 1 falling on a Sunday move to Monday. */
const sundayToMonday = (y: number, m: number, d: number) => (dow(y, m, d) === 0 ? shift(y, m, d, 1) : ymd(y, m, d));

export function quebecHolidays(year: number): Holiday[] {
  const [em, ed] = easter(year);
  // The Monday before May 25 (May 18 when the 25th is itself a Monday)
  const patriots = shift(year, 5, 25, -(((dow(year, 5, 25) + 6) % 7) || 7));
  return [
    { date: ymd(year, 1, 1), key: "newYear" },
    { date: shift(year, em, ed, -2), key: "goodFriday" },
    { date: shift(year, em, ed, 1), key: "easterMonday" },
    { date: patriots, key: "patriots" },
    { date: sundayToMonday(year, 6, 24), key: "stJean" },
    { date: sundayToMonday(year, 7, 1), key: "canada" },
    { date: nthMonday(year, 9, 1), key: "labour" },
    { date: nthMonday(year, 10, 2), key: "thanksgiving" },
    { date: ymd(year, 12, 25), key: "christmas" },
  ];
}

/** Holidays between two days (YYYY-MM-DD, both included), by date. */
export function holidaysBetween(from: string, to: string): Map<string, HolidayKey> {
  const out = new Map<string, HolidayKey>();
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of quebecHolidays(y)) if (h.date >= from && h.date <= to) out.set(h.date, h.key);
  }
  return out;
}
