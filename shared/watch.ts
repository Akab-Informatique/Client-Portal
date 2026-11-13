/**
 * The "no activity" reminder: an open ticket, task, to-do or project flashes in the lists when nothing happened on it for
 * `days` working days (Monday to Friday; weekends do not count). The delay is the same for everyone: 3 working days, or 6 when the
 * due day is more than 3 weeks away, unless it was set on the item itself. Any activity, opening the item or the reset button
 * starts the count again.
 */
export const WATCH_DEFAULT_DAYS = 3;
export const WATCH_FAR_DAYS = 6;
/** "More than 3 weeks away" */
export const WATCH_FAR_AFTER = 21;
export const WATCH_MAX_DAYS = 60;

const dayNumber = (ymd: string) => Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);

/** Days from `from` to `to` (YYYY-MM-DD), 0 when `to` is not after `from` */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.max(0, dayNumber(to) - dayNumber(from));
}

/** Working days (Monday to Friday) after `from` up to and including `to` */
export function workingDaysBetween(from: string, to: string): number {
  const a = dayNumber(from);
  const b = dayNumber(to);
  let n = 0;
  for (let d = a + 1; d <= b; d++) {
    const wd = new Date(d * 86_400_000).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** The delay in working days: the one set on the item, else 6 for a due day more than 3 weeks away, else 3 */
export function watchDays(due: string | null | undefined, today: string, own?: number | null): number {
  if (own != null && own > 0) return Math.min(WATCH_MAX_DAYS, own);
  return due && calendarDaysBetween(today, due.slice(0, 10)) > WATCH_FAR_AFTER ? WATCH_FAR_DAYS : WATCH_DEFAULT_DAYS;
}

/** Whether an open item has been quiet for its delay (`lastActivity`: the day of the last activity, YYYY-MM-DD) */
export function isStale(lastActivity: string, today: string, days: number): boolean {
  return workingDaysBetween(lastActivity, today) >= days;
}
