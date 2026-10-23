import { dayItems, isWorkday, layout, pipelineSettings, type DayItem } from "./pipeline.ts";

/**
 * "Planifier mes billets": the AI only orders the tickets; the hours are laid out here, in the free time of
 * each working day (work hours less lunch, the technician's events and absences, holidays), so two tickets
 * never overlap and nothing lands outside the day. A ticket longer than the room left continues on the next day.
 */
export type SchedIn = {
  id: number;
  number: string;
  title: string;
  priority: DayItem["priority"];
  /** Estimated time (minutes) */
  minutes: number;
  /** A start the technician locked: not planned before this day (YYYY-MM-DD) */
  earliest: string | null;
};
export type Slot = { date: string; start: string; end: string };
export type Scheduled = { slots: Slot[]; placedMinutes: number; unscheduledMinutes: number };

const TZ = "America/Toronto";
const nextDay = (date: string) => new Date(new Date(`${date}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Today (YYYY-MM-DD) and the minute of the day in Québec */
export function nowInQuebec(at = new Date()): { date: string; minute: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minute: Number(g("hour")) * 60 + Number(g("minute")) };
}

/** An instant as "YYYY-MM-DD HH:MM" in Québec (to compare with a planned finish) */
export const quebecStamp = (at: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

/** `items` in the order to work them. Looks at most `horizonDays` calendar days ahead. */
export async function scheduleTickets(userId: string, items: SchedIn[], at = new Date(), horizonDays = 28): Promise<Map<number, Scheduled>> {
  const settings = await pipelineSettings();
  const now = nowInQuebec(at);
  const left = new Map(items.map((i) => [i.id, i.minutes]));
  const out = new Map<number, Scheduled>(items.map((i) => [i.id, { slots: [], placedMinutes: 0, unscheduledMinutes: i.minutes }]));
  let day = now.date;
  for (let n = 0; n < horizonDays && [...left.values()].some((m) => m > 0); n++, day = nextDay(day)) {
    if (!isWorkday(day)) continue;
    const view = await dayItems(userId, day);
    if (view.absent || view.holiday) continue;
    // never in the past: today starts at the next quarter hour
    const notBefore = day === now.date ? Math.ceil(now.minute / 15) * 15 : undefined;
    const todo: DayItem[] = items
      .filter((i) => (left.get(i.id) ?? 0) > 0 && (!i.earliest || i.earliest <= day))
      .map((i) => ({
        key: `t${i.id}`,
        kind: "ticket" as const,
        refId: String(i.id),
        title: i.title,
        priority: i.priority,
        due: null,
        overdue: false,
        minutes: left.get(i.id)!,
        ticketNumber: i.number,
        ...(notBefore !== undefined ? { notBefore } : {}),
      }));
    if (!todo.length) continue;
    const { blocks } = layout(todo, settings, view.busy);
    for (const b of blocks) {
      if (b.kind !== "ticket" || b.overflow || !b.start || !b.refId) continue;
      const id = Number(b.refId);
      const s = out.get(id)!;
      s.slots.push({ date: day, start: b.start, end: b.end });
      const took = toMinutes(b.end) - toMinutes(b.start);
      s.placedMinutes += took;
      left.set(id, (left.get(id) ?? 0) - took);
    }
  }
  for (const [id, s] of out) s.unscheduledMinutes = Math.max(0, left.get(id) ?? 0);
  return out;
}
