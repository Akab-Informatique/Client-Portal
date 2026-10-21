/**
 * A task that comes back: every n days / weeks / months / years, on chosen weekdays for weekly ones, until a day.
 * The next one is made when the current one is completed, dated after the current due day (and after today).
 */
export type Recurrence = { freq: "daily" | "weekly" | "monthly" | "yearly"; interval: number; weekdays?: number[]; until?: string | null };

const parse = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (ymd: string, n: number) => fmt(new Date(parse(ymd).getTime() + n * 86_400_000));

/** The same day of the month n months later, or the last day of that month ("31 Jan" + 1 month = "28/29 Feb") */
function plusMonths(ymd: string, n: number): string {
  const d = parse(ymd);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return fmt(target);
}

/** The day after `from` the task comes back, or null when the series is over (`until`) */
export function nextOccurrence(from: string, r: Recurrence): string | null {
  const n = Math.max(1, Math.min(r.interval || 1, 365));
  let next: string;
  if (r.freq === "daily") next = plusDays(from, n);
  else if (r.freq === "weekly") {
    const days = [...new Set((r.weekdays ?? []).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!days.length) next = plusDays(from, 7 * n);
    else {
      const dow = parse(from).getUTCDay();
      const later = days.find((d) => d > dow);
      // a later day this week, else the first chosen day of the week n weeks on (weeks start on Sunday)
      next = later !== undefined ? plusDays(from, later - dow) : plusDays(from, 7 * n - dow + days[0]);
    }
  } else if (r.freq === "monthly") next = plusMonths(from, n);
  else next = plusMonths(from, 12 * n);
  return r.until && next > r.until ? null : next;
}

/** The next occurrence that is after both `from` and `after` (e.g. today, for a task completed late) */
export function nextAfter(from: string, after: string, r: Recurrence): string | null {
  let cur: string | null = from;
  for (let i = 0; i < 400 && cur; i++) {
    cur = nextOccurrence(cur, r);
    if (cur && cur > after) return cur;
  }
  return null;
}
