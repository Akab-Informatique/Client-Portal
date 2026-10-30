import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { PipelineBlock } from "../db/schema.ts";
import { config } from "../config.ts";
import { holidaysBetween } from "../../shared/holidays.ts";
import { AiError, aiSettings, askClaudeJson } from "./ai.ts";
import { audit } from "./audit.ts";
import { ticketSource, type NTicket } from "./ticketSource.ts";
import { smsReady, sendSms, normalizePhone } from "./voipms.ts";
import { todayQc } from "./timesheets.ts";
import { permissionsOf } from "./auth.ts";
import { calendarsOf, onCalendar, type CalendarTarget } from "./planning.ts";
import { o365Ready, outlookEvents } from "./o365.ts";
import { directionPrompt } from "./aiDirection.ts";

/**
 * Pipeline: each technician's day. What is on their plate (their tasks and tickets due), laid out as a
 * suggestion in time blocks (not a calendar: nothing is booked), summarised by the AI each morning, and
 * texted to them in a few lines. The AI only orders the work and says why; the hours are laid out by the
 * portal, so a block never lands in the lunch hour, on an event, or past the end of the day.
 */
const PROVIDER = "pipeline";

export type PipelineSettings = {
  /** The morning run (plans and texts) — on by default */
  auto: boolean;
  /** HH:MM Québec */
  time: string;
  /** Text each technician their day (needs the SMS line and their mobile number) */
  sms: boolean;
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  /** The day of the last morning run (YYYY-MM-DD) */
  lastRun: string | null;
};
export const DEFAULT_SETTINGS: PipelineSettings = { auto: true, time: "07:30", sms: true, workStart: "08:00", workEnd: "17:00", lunchStart: "12:00", lunchEnd: "13:00", lastRun: null };

export async function pipelineSettings(): Promise<PipelineSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  return { ...DEFAULT_SETTINGS, ...((row?.config ?? {}) as Partial<PipelineSettings>) };
}
export async function savePipelineSettings(p: Partial<PipelineSettings>): Promise<PipelineSettings> {
  const next = { ...(await pipelineSettings()), ...p };
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled: true, config: next })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: next, updatedAt: new Date() } });
  return next;
}

// ── time helpers (Québec) ──
const TZ = "America/Toronto";
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** Minutes since midnight of `date` for an instant (clamped to the day) */
function minutesOnDay(at: Date, date: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  if (ymd < date) return 0;
  if (ymd > date) return 1440;
  return Number(g("hour")) * 60 + Number(g("minute"));
}
export const isWorkday = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5 && !holidaysBetween(date, date).has(date);
};
/** The Monday of the week of a day (YYYY-MM-DD): where the week's priorities are kept */
export const mondayOf = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
};
const nextDay = (date: string) => new Date(new Date(`${date}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

// ── what is on the day ──
export type DayItem = {
  key: string;
  kind: "task" | "ticket";
  refId: string;
  title: string;
  priority: "urgent" | "high" | "normal" | "low";
  due: string | null;
  overdue: boolean;
  minutes: number;
  ticketNumber?: string | null;
  client?: string | null;
  /** Waits for another task: not planned */
  blocked?: boolean;
  /** HH:MM on the due day, when it has one */
  dueTime?: string | null;
  /** Not before this time today (minutes since midnight) */
  notBefore?: number;
  /** A private task the viewer may not see in detail */
  masked?: boolean;
  /** A priority pinned for the technician (Planning): of the day, or of the week, with its rank and the direction given */
  pin?: "day" | "week";
  pinRank?: number;
  pinNote?: string | null;
  /** A ticket's checkpoint date (the goal day): it decides, with the due date, which day the ticket is on */
  checkpoint?: string | null;
  checkpointTime?: string | null;
  /** A ticket: what the compact list shows */
  dueAt?: string;
  priorityKind?: string;
  priorityLabel?: string | null;
  statusKind?: string;
  statusLabel?: string | null;
  companyName?: string;
};
type Busy = { start: number; end: number; title: string; o365?: boolean; allDay?: boolean };
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
const ticketPriority = (kind: string): DayItem["priority"] => (kind === "critical" ? "urgent" : kind === "high" ? "high" : kind === "low" ? "low" : "normal");

export async function dayItems(userId: string, date: string, viewerId: string = userId): Promise<{ items: DayItem[]; busy: Busy[]; absent: boolean; holiday: boolean }> {
  const d = db();
  // who may see which private task: the one who made it, the one who has it, the people chosen
  const viewing = viewerId !== userId;
  const shared = viewing ? new Set((await d.select({ taskId: schema.pipelineTaskViewers.taskId }).from(schema.pipelineTaskViewers).where(eq(schema.pipelineTaskViewers.userId, viewerId))).map((r) => r.taskId)) : new Set<string>();
  const dayStart = new Date(`${date}T00:00:00-05:00`);
  const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000);
  const [tasks, children, absences, blocks, pins] = await Promise.all([
    d
      .select()
      .from(schema.pipelineTasks)
      .where(and(eq(schema.pipelineTasks.assigneeId, userId), ne(schema.pipelineTasks.status, "done"))),
    d.select({ parentId: schema.pipelineTasks.parentId }).from(schema.pipelineTasks).where(and(ne(schema.pipelineTasks.status, "done"), sql`${schema.pipelineTasks.parentId} is not null`)),
    d.select().from(schema.meetingAbsences).where(and(eq(schema.meetingAbsences.userId, userId), sql`${schema.meetingAbsences.startDate} <= ${date} and ${schema.meetingAbsences.endDate} >= ${date}`)),
    d.select().from(schema.calendarBlocks).where(and(eq(schema.calendarBlocks.technicianId, userId), sql`${schema.calendarBlocks.startsAt} < ${dayEnd} and ${schema.calendarBlocks.endsAt} > ${dayStart}`)),
    // the priorities pinned for the technician: this day's, and this week's (the Monday of its week)
    d
      .select()
      .from(schema.ticketPins)
      .where(
        and(
          eq(schema.ticketPins.technicianId, userId),
          or(and(eq(schema.ticketPins.horizon, "day"), eq(schema.ticketPins.forDate, date)), and(eq(schema.ticketPins.horizon, "week"), eq(schema.ticketPins.forDate, mondayOf(date)))),
          sql`${schema.ticketPins.doneAt} is null`,
        ),
      ),
  ]);
  const hasOpenChildren = new Set(children.map((c) => c.parentId));
  const openIds = new Set(
    (await d.select({ id: schema.pipelineTasks.id }).from(schema.pipelineTasks).where(ne(schema.pipelineTasks.status, "done"))).map((r) => r.id),
  );
  const items: DayItem[] = [];
  for (const t of tasks) {
    // a parent is done through its subtasks: they are planned, not the parent
    if (hasOpenChildren.has(t.id)) continue;
    const due = t.dueDate;
    // not to be started yet: its start day is later
    if (t.startDate && t.startDate > date && t.status !== "doing") continue;
    const relevant = t.status === "doing" || t.priority === "urgent" || (due !== null && due <= date);
    if (!relevant) continue;
    const masked = viewing && t.visibility !== "team" && t.createdBy !== viewerId && !(t.visibility === "selected" && shared.has(t.id));
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      refId: t.id,
      title: masked ? "" : t.title,
      masked,
      dueTime: t.dueDate === date ? t.dueTime : null,
      notBefore: t.startDate === date && t.startTime ? mins(t.startTime) : undefined,
      priority: t.priority,
      due,
      overdue: due !== null && due < date,
      minutes: t.estimateMinutes ?? 30,
      ticketNumber: masked ? null : t.ticketNumber,
      blocked: t.status === "blocked" || (t.blockedById !== null && openIds.has(t.blockedById)),
    });
  }
  // the technician's open tickets due by the end of the day, and the ones pinned for the day
  const src = await ticketSource();
  const [all, o] = await Promise.all([src.list().catch(() => [] as NTicket[]), src.options()]);
  const kindOf = new Map(o.statuses.map((s) => [s.value, s.kind]));
  const prio = new Map(o.priorities.map((p) => [p.value, p.kind]));
  // a day pin outranks a week pin on the same ticket
  const pinOf = new Map<number, (typeof pins)[number]>();
  for (const p of [...pins].sort((a, b) => (a.horizon === "week" ? 1 : 0) - (b.horizon === "week" ? 1 : 0))) if (!pinOf.has(p.ticketId)) pinOf.set(p.ticketId, p);
  const endOfDay = new Date(`${nextDay(date)}T00:00:00-05:00`).getTime();
  // the ones assigned to the technician and due by the end of the day, and every ticket pinned to them (even one assigned to someone else)
  // a ticket is on the day by its checkpoint (the goal date, today or already passed) or by its due date (due by the end of the day)
  const assigned = all.filter((t) => kindOf.get(t.status) !== "complete" && t.assignee?.id === userId);
  const checks = assigned.length
    ? await d.select({ id: schema.ticketMeta.ticketId, m: schema.ticketMeta.milestoneDate, time: schema.ticketMeta.milestoneTime }).from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, assigned.map((t) => t.id)))
    : [];
  const checkpoint = new Map(checks.filter((r) => r.m).map((r) => [r.id, r.m as string]));
  const checkpointTime = new Map(checks.filter((r) => r.m && r.time).map((r) => [r.id, r.time as string]));
  // a pinned ticket of someone else has no checkpoint read above
  const pinnedOnly = [...pinOf.keys()].filter((id) => !checkpoint.has(id) && !assigned.some((t) => t.id === id));
  if (pinnedOnly.length) {
    for (const r of await d.select({ id: schema.ticketMeta.ticketId, m: schema.ticketMeta.milestoneDate, time: schema.ticketMeta.milestoneTime }).from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, pinnedOnly))) {
      if (r.m) checkpoint.set(r.id, r.m);
      if (r.m && r.time) checkpointTime.set(r.id, r.time);
    }
  }
  const mine = all.filter((t) => kindOf.get(t.status) !== "complete" && (pinOf.has(t.id) || (t.assignee?.id === userId && (new Date(t.dueAt).getTime() < endOfDay || (checkpoint.get(t.id) ?? "9999") <= date))));
  const est = mine.length
    ? await d.select({ id: schema.ticketMeta.ticketId, m: schema.ticketMeta.estimateMinutes }).from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, mine.map((t) => t.id)))
    : [];
  const estimate = new Map(est.map((r) => [r.id, r.m]));
  for (const t of mine) {
    const due = t.dueAt.slice(0, 10);
    items.push({
      key: `ticket:${t.id}`,
      kind: "ticket",
      refId: String(t.id),
      title: t.title,
      priority: ((p) => (pinOf.has(t.id) && (p === "normal" || p === "low") ? "high" : p))(ticketPriority(prio.get(t.priority) ?? "medium")),
      due,
      overdue: new Date(t.dueAt).getTime() < Date.now() && due < date,
      minutes: estimate.get(t.id) ?? 45,
      ticketNumber: t.number,
      client: t.company.name,
      checkpoint: checkpoint.get(t.id) ?? null,
      checkpointTime: checkpointTime.get(t.id) ?? null,
      dueAt: t.dueAt,
      priorityKind: prio.get(t.priority) ?? "medium",
      priorityLabel: o.priorities.find((p) => p.value === t.priority)?.label ?? null,
      statusKind: kindOf.get(t.status) ?? "new",
      statusLabel: o.statuses.find((s) => s.value === t.status)?.label ?? null,
      companyName: t.company.name,
      ...(pinOf.has(t.id) ? { pin: pinOf.get(t.id)!.horizon, pinRank: pinOf.get(t.id)!.rank, pinNote: pinOf.get(t.id)!.note || null } : {}),
    });
  }
  const busy = blocks.map((b) => ({ start: minutesOnDay(b.startsAt, date), end: minutesOnDay(b.endsAt, date), title: b.title }));
  const absent = absences.length > 0;
  return { items, busy, absent, holiday: holidaysBetween(date, date).has(date) };
}

// the priorities of the day first (in their rank), then what is late, then the priorities of the week, then the rest
const score = (i: DayItem) => [i.pin === "day" ? 0 : 1, i.pin === "day" ? (i.pinRank ?? 99) : 0, i.overdue ? 0 : 1, i.pin === "week" ? 0 : 1, RANK[i.priority], i.checkpoint ?? i.due ?? "9999", i.dueTime ?? "99:99", i.kind === "ticket" ? 0 : 1] as const;
export function byUrgency(a: DayItem, b: DayItem): number {
  const x = score(a);
  const y = score(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || x[4] - y[4] || x[5].localeCompare(y[5]) || x[6].localeCompare(y[6]) || x[7] - y[7];
}

// ── the technician's Microsoft 365 calendar ──
type CalEvent = { title: string; start: number; end: number; allDay: boolean; private: boolean; free: boolean };
const calCache = new Map<string, { at: number; value: { status: string; events: CalEvent[] } }>();
/**
 * What is on the technician's own Outlook calendar that day (the calendars linked to them in Planning, else their own):
 * read through their Microsoft sign-in. Events marked "free" do not take time. Kept 5 minutes; a failure is
 * reported, never thrown (the day is planned without it).
 */
export async function calendarOfDay(userId: string, date: string): Promise<{ status: string; events: CalEvent[] }> {
  const key = `${userId}:${date}`;
  const hit = calCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  let value: { status: string; events: CalEvent[] } = { status: "none", events: [] };
  try {
    let targets = (await calendarsOf(userId)).filter((t) => t.ownerId === userId || t.display === "details");
    // none linked (or no right on Planning calendars): their own Microsoft sign-in, when they have one
    let notSignedIn = false;
    if (!targets.length && (await o365Ready())) {
      const [u] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
      const [conn] = await db().select({ email: schema.msConnections.email }).from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
      if (conn) targets = [{ id: null, source: "user", ownerId: userId, mailbox: conn.email, calendarId: null, calendarName: null, label: u?.name ?? "", display: "details", push: false } satisfies CalendarTarget];
      else notSignedIn = true;
    }
    if (notSignedIn) value = { status: "o365_not_signed_in", events: [] };
    if (targets.length) {
      const from = new Date(`${date}T00:00:00-05:00`);
      const to = new Date(from.getTime() + 30 * 3_600_000);
      const events: CalEvent[] = [];
      let error: string | null = null;
      let read = 0;
      for (const t of targets) {
        if (!t.mailbox) {
          error ??= "o365_not_signed_in";
          continue;
        }
        try {
          const list = await onCalendar(t, () => outlookEvents(t.mailbox!, from, to, t.calendarId));
          read++;
          for (const e of list) {
            const start = minutesOnDay(new Date(e.startsAt), date);
            const end = minutesOnDay(new Date(e.endsAt), date);
            // an event of another day that Graph returned for the window: only this day's count
            if (end <= start && !e.allDay) continue;
            events.push({ title: e.private ? "Occupé" : e.title, start, end, allDay: e.allDay, private: e.private, free: e.showAs === "free" });
          }
        } catch (e) {
          error ??= e instanceof Error ? e.message.slice(0, 80) : "error";
        }
      }
      value = { status: read ? "ok" : (error ?? "none"), events };
    }
  } catch (e) {
    value = { status: e instanceof Error ? e.message.slice(0, 80) : "error", events: [] };
  }
  calCache.set(key, { at: Date.now(), value });
  return value;
}

/** Lay the items out in the free hours of the day (in the order given), splitting a long one across the lunch hour. */
export function layout(items: DayItem[], s: Pick<PipelineSettings, "workStart" | "workEnd" | "lunchStart" | "lunchEnd">, busy: Busy[], notes: Map<string, string> = new Map()) {
  const work = [
    { start: mins(s.workStart), end: mins(s.lunchStart) },
    { start: mins(s.lunchEnd), end: mins(s.workEnd) },
  ];
  // free segments: work hours less the events
  let free = work.filter((w) => w.end > w.start);
  for (const b of busy.filter((x) => !x.allDay)) {
    free = free.flatMap((f) => {
      if (b.end <= f.start || b.start >= f.end) return [f];
      const out: { start: number; end: number }[] = [];
      if (b.start > f.start) out.push({ start: f.start, end: b.start });
      if (b.end < f.end) out.push({ start: b.end, end: f.end });
      return out;
    });
  }
  const capacityMinutes = free.reduce((n, f) => n + (f.end - f.start), 0);
  const blocks: PipelineBlock[] = [];
  let seg = 0;
  let cursor = free[0]?.start ?? 0;
  let planned = 0;
  let overflowMinutes = 0;
  // an item that must not start before a time waits for it; the others fill the gap meanwhile
  const queue = [...items];
  const moveTo = (minute: number) => {
    while (seg < free.length && free[seg].end <= minute) {
      seg++;
      cursor = free[seg]?.start ?? 0;
    }
    if (seg < free.length && cursor < minute) cursor = minute;
  };
  while (queue.length) {
    const now = seg < free.length ? cursor : Infinity;
    let at = queue.findIndex((q) => (q.notBefore ?? 0) <= now);
    if (at < 0) {
      // nothing is ready: jump to the earliest start
      moveTo(Math.min(...queue.map((q) => q.notBefore ?? 0)));
      at = queue.findIndex((q) => (q.notBefore ?? 0) <= (seg < free.length ? cursor : Infinity));
      if (at < 0) at = 0;
    }
    const it = queue.splice(at, 1)[0];
    if (it.notBefore !== undefined && seg < free.length) moveTo(it.notBefore);
    let left = it.minutes;
    let first = true;
    while (left > 0 && seg < free.length) {
      const room = free[seg].end - cursor;
      if (room < 10) {
        seg++;
        cursor = free[seg]?.start ?? 0;
        continue;
      }
      const take = Math.min(left, room);
      blocks.push({
        start: hhmm(cursor),
        end: hhmm(cursor + take),
        title: first ? it.title : `${it.title}`,
        kind: it.kind,
        refId: it.refId,
        ticketNumber: it.ticketNumber ?? null,
        priority: it.priority,
        ...(it.pin ? { pinned: it.pin } : {}),
        note: first ? (notes.get(it.key) ?? (it.pinNote ? `${it.pinNote}` : null)) : null,
      });
      cursor += take;
      left -= take;
      planned += take;
      first = false;
    }
    if (left > 0) {
      overflowMinutes += left;
      blocks.push({ start: "", end: "", title: it.title, kind: it.kind, refId: it.refId, ticketNumber: it.ticketNumber ?? null, priority: it.priority, ...(it.pin ? { pinned: it.pin } : {}), note: notes.get(it.key) ?? it.pinNote ?? null, overflow: true });
    }
  }
  for (const b of busy) {
    if (b.allDay) blocks.push({ start: "", end: "", title: b.title, kind: "event", refId: null, allDay: true, o365: Boolean(b.o365) });
    else if (b.end > b.start) blocks.push({ start: hhmm(b.start), end: hhmm(b.end), title: b.title, kind: "event", refId: null, o365: Boolean(b.o365) });
  }
  if (mins(s.lunchEnd) > mins(s.lunchStart)) blocks.push({ start: s.lunchStart, end: s.lunchEnd, title: "", kind: "break", refId: null });
  blocks.sort((a, b) => (a.overflow ? 1 : 0) - (b.overflow ? 1 : 0) || (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || a.start.localeCompare(b.start));
  return { blocks, capacityMinutes, plannedMinutes: planned, overflowMinutes };
}

const hours = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;

/** The summary written by the portal's own rules (AI off, or it failed) */
function rulesSummary(items: DayItem[], cap: number, planned: number, overflow: number, locale: "fr" | "en", absent: boolean, holiday: boolean): string {
  const t = items.filter((i) => i.kind === "ticket").length;
  const k = items.filter((i) => i.kind === "task").length;
  if (absent) return locale === "en" ? "You are marked absent today: nothing is planned." : "Vous êtes marqué absent aujourd'hui : rien n'est planifié.";
  if (holiday) return locale === "en" ? "Today is a day off: nothing is planned." : "Aujourd'hui est un jour de congé : rien n'est planifié.";
  if (!items.length) return locale === "en" ? "Nothing due today. A good day to move the backlog forward." : "Rien d'échu aujourd'hui. Bonne journée pour faire avancer le reste.";
  const over = items.filter((i) => i.overdue).length;
  const pins = items.filter((i) => i.pin).length;
  const enough = overflow === 0;
  if (locale === "en")
    return `${t} ticket${t === 1 ? "" : "s"} and ${k} task${k === 1 ? "" : "s"} for today, about ${hours(planned + overflow)} of work for ${hours(cap)} available.${over ? ` ${over} already late.` : ""}${pins ? ` ${pins} pinned priorit${pins === 1 ? "y" : "ies"} first.` : ""} ${enough ? "It fits in the day." : `About ${hours(overflow)} will not fit: move or hand off something.`}`;
  return `${t} billet${t > 1 ? "s" : ""} et ${k} tâche${k > 1 ? "s" : ""} aujourd'hui, environ ${hours(planned + overflow)} de travail pour ${hours(cap)} de disponible.${over ? ` ${over} déjà en retard.` : ""}${pins ? ` ${pins} priorité${pins > 1 ? "s" : ""} épinglée${pins > 1 ? "s" : ""} en premier.` : ""} ${enough ? "Ça entre dans la journée." : `Environ ${hours(overflow)} ne rentreront pas : déplacez ou déléguez quelque chose.`}`;
}

/** Plan one technician's day and keep it. The AI orders the work and writes the summary; the hours are laid out here. */
export async function buildPlan(userId: string, date: string, opts: { ai: boolean; locale?: "fr" | "en"; by?: string | null; direction?: string } = { ai: false }) {
  const settings = await pipelineSettings();
  const [user] = await db().select({ name: schema.users.name, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId));
  const locale = opts.locale ?? user?.locale ?? "fr";
  const day = await dayItems(userId, date);
  const { items, absent } = day;
  // what is already on the technician's Outlook calendar takes its hours off the day
  const cal = await calendarOfDay(userId, date);
  const calEvents = cal.events.filter((e) => !e.free);
  const busy: Busy[] = [...day.busy, ...calEvents.map((e) => ({ start: e.start, end: e.end, title: e.title, o365: true, allDay: e.allDay }))];
  // a holiday or a weekend: a day off, nothing is planned
  const holiday = day.holiday || !isWorkday(date);
  const planable = absent || holiday ? [] : items.filter((i) => !i.blocked).sort(byUrgency);
  let ordered = planable;
  let notes = new Map<string, string>();
  let summary = "";
  let source: "ai" | "rules" = "rules";
  let aiError: string | null = null;
  if (opts.ai && planable.length) {
    const s = await aiSettings();
    if (s.enabled && s.apiKey) {
      try {
        const lines = planable.map((i) => `- ${i.key} · ${i.kind === "ticket" ? `billet ${i.ticketNumber ?? ""}` : "tâche"} · « ${i.title} »${i.client ? ` · client ${i.client}` : ""} · priorité ${i.priority} · échéance ${i.due ?? "aucune"}${i.dueTime ? ` ${i.dueTime}` : ""}${i.overdue ? " (EN RETARD)" : ""}${i.pin ? ` · PRIORITÉ ${i.pin === "day" ? "DU JOUR" : "DE LA SEMAINE"}${i.pinNote ? ` (directive : ${i.pinNote})` : ""}` : ""}${i.notBefore !== undefined ? ` · pas avant ${hhmm(i.notBefore)}` : ""} · ${i.minutes} min`);
        const agenda = calEvents.filter((e) => !e.allDay).map((e) => `- ${hhmm(e.start)}–${hhmm(e.end)} ${e.title}`);
        const free = layout([], settings, busy).capacityMinutes;
        const out = await askClaudeJson<{ summary?: unknown; order?: { ref?: unknown; note?: unknown }[] }>({
          system: `Tu es l'assistant de planification d'AKAB Informatique (services TI, Québec). Réponds en ${locale === "en" ? "anglais" : "français québécois"}, ton direct et chaleureux, tutoiement. Tu prépares la journée d'un technicien : c'est une suggestion, pas un horaire fixe.`,
          feature: "pipeline.day",
          userId,
          prompt: `Date : ${date}. Heures de travail ${settings.workStart}–${settings.workEnd} (dîner ${settings.lunchStart}–${settings.lunchEnd}), ${hours(free)} libres après les événements.${agenda.length ? ` Déjà à son agenda Outlook :\n${agenda.join("\n")}\n` : ""} Voici ce qui est à faire :\n${lines.join("\n")}\n\nLes priorités du jour passent en premier. Respecte « pas avant » et garde ce qui a une heure d'échéance avant cette heure. Choisis l'ordre de traitement (les retards et les urgences d'abord, regroupe ce qui va ensemble, garde les tâches longues pour le début de la matinée ou de l'après-midi). Donne un résumé de 2 à 4 phrases de la journée : ce qui compte le plus, si le temps est suffisant, ce qu'il faudrait déplacer ou déléguer sinon. Format : {"summary": "...", "order": [{"ref": "task:... ou ticket:...", "note": "raison en 12 mots ou moins"}]}${directionPrompt(opts.direction ?? "")}`,
          maxTokens: 4000,
        });
        const byKey = new Map(planable.map((i) => [i.key, i]));
        const seen = new Set<string>();
        const picked: DayItem[] = [];
        for (const o of Array.isArray(out.order) ? out.order : []) {
          const key = typeof o.ref === "string" ? o.ref : "";
          const it = byKey.get(key);
          if (!it || seen.has(key)) continue;
          seen.add(key);
          picked.push(it);
          if (typeof o.note === "string" && o.note.trim()) notes.set(key, o.note.trim().slice(0, 160));
        }
        // whatever the AI left out follows, by urgency
        ordered = [...picked, ...planable.filter((i) => !seen.has(i.key))];
        if (typeof out.summary === "string" && out.summary.trim()) summary = out.summary.trim().slice(0, 900);
        source = "ai";
      } catch (e) {
        aiError = e instanceof AiError ? e.code : "error";
        console.warn("[pipeline] AI day plan:", e instanceof Error ? e.message : e);
        notes = new Map();
      }
    } else aiError = s.apiKey ? "disabled" : "not_configured";
  }
  const lay = layout(ordered, settings, busy, notes);
  // the blocked ones are listed after, so they are not forgotten
  for (const i of absent || holiday ? [] : items.filter((x) => x.blocked)) lay.blocks.push({ start: "", end: "", title: i.title, kind: i.kind, refId: i.refId, ticketNumber: i.ticketNumber ?? null, priority: i.priority, note: locale === "en" ? "Waiting on another task" : "En attente d'une autre tâche", overflow: true });
  const cap = absent || holiday ? 0 : lay.capacityMinutes;
  if (!summary) summary = rulesSummary(planable, cap, lay.plannedMinutes, lay.overflowMinutes, locale, absent, holiday);
  const values = { userId, date, summary, blocks: lay.blocks, capacityMinutes: cap, plannedMinutes: lay.plannedMinutes + lay.overflowMinutes, source, calendar: cal.status, calendarEvents: calEvents.length, updatedAt: new Date() };
  const [row] = await db()
    .insert(schema.pipelineDayPlans)
    .values(values)
    .onConflictDoUpdate({ target: [schema.pipelineDayPlans.userId, schema.pipelineDayPlans.date], set: { summary, blocks: lay.blocks, capacityMinutes: cap, plannedMinutes: values.plannedMinutes, source, calendar: cal.status, calendarEvents: calEvents.length, updatedAt: new Date() } })
    .returning();
  return { plan: row, aiError };
}

/** The day's plan, made by the rules when there is none yet */
export async function planOf(userId: string, date: string) {
  const [hit] = await db().select().from(schema.pipelineDayPlans).where(and(eq(schema.pipelineDayPlans.userId, userId), eq(schema.pipelineDayPlans.date, date)));
  // an AI plan is kept as it was written (the screen says when the list changed since); the portal's own is always current
  if (hit && hit.source === "ai") return hit;
  return (await buildPlan(userId, date, { ai: false })).plan;
}

/** What the day screen lists besides the plan: everything on the plate, the urgent first */
export async function buildPipelineView(userId: string, date: string, viewerId: string = userId) {
  const { items, absent, holiday, busy } = await dayItems(userId, date, viewerId);
  const doneToday = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.pipelineTasks)
    .where(and(eq(schema.pipelineTasks.assigneeId, userId), eq(schema.pipelineTasks.status, "done"), sql`(${schema.pipelineTasks.completedAt} at time zone 'America/Toronto')::date = ${date}::date`));
  return { items: [...items].sort(byUrgency), absent, holiday, events: busy.length, doneToday: doneToday[0]?.n ?? 0 };
}

// ── the morning text ──
export function planSms(name: string, plan: { blocks: PipelineBlock[]; capacityMinutes: number; plannedMinutes: number }, locale: "fr" | "en"): string | null {
  const work = plan.blocks.filter((b) => b.kind === "task" || b.kind === "ticket");
  const seen = new Set<string>();
  const unique = work.filter((b) => {
    const k = `${b.kind}:${b.refId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) return null;
  const tickets = unique.filter((b) => b.kind === "ticket").length;
  const tasks = unique.length - tickets;
  const first = name.split(/\s+/)[0] ?? name;
  const top = unique
    .filter((b) => !b.overflow)
    .slice(0, 3)
    .map((b, i) => `${i + 1}) ${b.start} ${b.title.slice(0, 40)}`)
    .join(" ");
  const late = unique.filter((b) => b.overflow).length;
  const link = config.publicUrl ? ` ${config.publicUrl}/pipeline` : "";
  if (locale === "en")
    return `AKAB — Good morning ${first}! Today: ${tickets} ticket${tickets === 1 ? "" : "s"}, ${tasks} task${tasks === 1 ? "" : "s"} (${hours(plan.plannedMinutes)} for ${hours(plan.capacityMinutes)} free).${late ? ` ${late} may not fit.` : ""} ${top}${link}`.trim();
  return `AKAB — Bonjour ${first} ! Aujourd'hui : ${tickets} billet${tickets > 1 ? "s" : ""}, ${tasks} tâche${tasks > 1 ? "s" : ""} (${hours(plan.plannedMinutes)} pour ${hours(plan.capacityMinutes)} de libre).${late ? ` ${late} risque${late > 1 ? "nt" : ""} de ne pas entrer.` : ""} ${top}${link}`.trim();
}

/** The mobile number of a technician (profile), as the SMS line wants it */
export const phoneOf = (u: { mobile: string | null; phone: string | null }) => normalizePhone(u.mobile) ?? normalizePhone(u.phone);
/** "••• 1234" */
export const maskPhone = (p: string | null) => (p ? `••• ${p.slice(-4)}` : null);

/**
 * A test text to one person: their real morning text for today (what they would get), or a short line that
 * only proves the number and the SMS line work. Nothing is saved on the day's plan.
 */
export async function sendTestSms(userId: string, mode: "plan" | "short"): Promise<{ to: string; text: string }> {
  const [u] = await db().select().from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new PipelineError("not_found");
  const phone = phoneOf(u);
  if (!phone) throw new PipelineError("no_phone");
  if (!(await smsReady().catch(() => false))) throw new PipelineError("sms_not_ready");
  let text: string;
  if (mode === "plan") {
    const { plan } = await buildPlan(u.id, todayQc(), { ai: true, locale: u.locale });
    text = planSms(u.name, plan, u.locale) ?? (u.locale === "en" ? "AKAB — Pipeline test: nothing planned for you today." : "AKAB — Test du Pipeline : rien de prévu pour vous aujourd'hui.");
    text = `[TEST] ${text}`;
  } else text = u.locale === "en" ? "AKAB — Pipeline test text. If you get this, your morning text will reach you." : "AKAB — Texto de test du Pipeline. Si vous le recevez, votre texto du matin vous parviendra.";
  try {
    await sendSms(phone, text);
  } catch (e) {
    throw new PipelineError("sms_failed", e instanceof Error ? e.message : undefined);
  }
  return { to: maskPhone(phone) ?? "", text };
}

export class PipelineError extends Error {
  constructor(
    public code: "not_found" | "no_phone" | "sms_not_ready" | "sms_failed",
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Plan every technician's day (AI) and text them. Returns what was done. */
export async function morningRun(opts: { sms?: boolean; date?: string; onlyUserId?: string } = {}): Promise<{ planned: number; texted: number; failed: number }> {
  const settings = await pipelineSettings();
  const date = opts.date ?? todayQc();
  const users = await db()
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true), opts.onlyUserId ? eq(schema.users.id, opts.onlyUserId) : undefined));
  const sms = (opts.sms ?? settings.sms) && (await smsReady().catch(() => false));
  let planned = 0;
  let texted = 0;
  let failed = 0;
  for (const u of users) {
    try {
      if (!(await permissionsOf(u)).includes("pipeline.view")) continue;
      const { plan } = await buildPlan(u.id, date, { ai: true, locale: u.locale });
      planned++;
      const phone = phoneOf(u);
      const text = sms && phone && isWorkday(date) ? planSms(u.name, plan, u.locale) : null;
      if (text && phone) {
        await sendSms(phone, text);
        await db().update(schema.pipelineDayPlans).set({ smsSentAt: new Date() }).where(eq(schema.pipelineDayPlans.id, plan.id));
        texted++;
      }
    } catch (e) {
      failed++;
      console.warn("[pipeline] morning:", u.email, e instanceof Error ? e.message : e);
    }
  }
  await audit(null, "pipeline.morning_run", null, { date, planned, texted, failed });
  return { planned, texted, failed };
}

/** Every minute: at the chosen time, on a work day, once a day */
export async function pipelineTick(now = new Date()): Promise<void> {
  const s = await pipelineSettings();
  if (!s.auto) return;
  const date = todayQc();
  if (s.lastRun === date || !isWorkday(date)) return;
  const nowHm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  if (nowHm < s.time) return;
  // claimed before anything is done (one run a day, never twice)
  await savePipelineSettings({ lastRun: date });
  await morningRun({ date });
  // Monday: the week ahead for the team meeting
  if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) {
    const { buildBrief } = await import("./weekBrief.ts");
    await buildBrief(date, { ai: true }).catch((e) => console.warn("[pipeline] week brief:", e instanceof Error ? e.message : e));
  }
}

