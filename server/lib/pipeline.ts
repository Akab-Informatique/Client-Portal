import { and, eq, inArray, ne, sql } from "drizzle-orm";
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
};
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
const ticketPriority = (kind: string): DayItem["priority"] => (kind === "critical" ? "urgent" : kind === "high" ? "high" : kind === "low" ? "low" : "normal");

export async function dayItems(userId: string, date: string): Promise<{ items: DayItem[]; busy: { start: number; end: number; title: string }[]; absent: boolean; holiday: boolean }> {
  const d = db();
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
    d.select().from(schema.ticketPins).where(and(eq(schema.ticketPins.technicianId, userId), eq(schema.ticketPins.horizon, "day"), eq(schema.ticketPins.forDate, date), sql`${schema.ticketPins.doneAt} is null`)),
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
    const relevant = t.status === "doing" || t.priority === "urgent" || (due !== null && due <= date);
    if (!relevant) continue;
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      refId: t.id,
      title: t.title,
      priority: t.priority,
      due,
      overdue: due !== null && due < date,
      minutes: t.estimateMinutes ?? 30,
      ticketNumber: t.ticketNumber,
      blocked: t.status === "blocked" || (t.blockedById !== null && openIds.has(t.blockedById)),
    });
  }
  // the technician's open tickets due by the end of the day, and the ones pinned for the day
  const src = await ticketSource();
  const [all, o] = await Promise.all([src.list().catch(() => [] as NTicket[]), src.options()]);
  const kindOf = new Map(o.statuses.map((s) => [s.value, s.kind]));
  const prio = new Map(o.priorities.map((p) => [p.value, p.kind]));
  const pinned = new Set(pins.map((p) => p.ticketId));
  const endOfDay = new Date(`${nextDay(date)}T00:00:00-05:00`).getTime();
  const mine = all.filter((t) => t.assignee?.id === userId && kindOf.get(t.status) !== "complete" && (pinned.has(t.id) || new Date(t.dueAt).getTime() < endOfDay));
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
      priority: ticketPriority(prio.get(t.priority) ?? "medium"),
      due,
      overdue: new Date(t.dueAt).getTime() < Date.now() && due < date,
      minutes: estimate.get(t.id) ?? 45,
      ticketNumber: t.number,
      client: t.company.name,
    });
  }
  const busy = blocks.map((b) => ({ start: minutesOnDay(b.startsAt, date), end: minutesOnDay(b.endsAt, date), title: b.title }));
  const absent = absences.length > 0;
  return { items, busy, absent, holiday: holidaysBetween(date, date).has(date) };
}

const score = (i: DayItem) => [i.overdue ? 0 : 1, RANK[i.priority], i.due ?? "9999", i.kind === "ticket" ? 0 : 1] as const;
export function byUrgency(a: DayItem, b: DayItem): number {
  const x = score(a);
  const y = score(b);
  return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || x[3] - y[3];
}

/** Lay the items out in the free hours of the day (in the order given), splitting a long one across the lunch hour. */
export function layout(items: DayItem[], s: Pick<PipelineSettings, "workStart" | "workEnd" | "lunchStart" | "lunchEnd">, busy: { start: number; end: number; title: string }[], notes: Map<string, string> = new Map()) {
  const work = [
    { start: mins(s.workStart), end: mins(s.lunchStart) },
    { start: mins(s.lunchEnd), end: mins(s.workEnd) },
  ];
  // free segments: work hours less the events
  let free = work.filter((w) => w.end > w.start);
  for (const b of busy) {
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
  for (const it of items) {
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
        note: first ? (notes.get(it.key) ?? null) : null,
      });
      cursor += take;
      left -= take;
      planned += take;
      first = false;
    }
    if (left > 0) {
      overflowMinutes += left;
      blocks.push({ start: "", end: "", title: it.title, kind: it.kind, refId: it.refId, ticketNumber: it.ticketNumber ?? null, priority: it.priority, note: notes.get(it.key) ?? null, overflow: true });
    }
  }
  for (const b of busy) if (b.end > b.start) blocks.push({ start: hhmm(b.start), end: hhmm(b.end), title: b.title, kind: "event", refId: null });
  if (mins(s.lunchEnd) > mins(s.lunchStart)) blocks.push({ start: s.lunchStart, end: s.lunchEnd, title: "", kind: "break", refId: null });
  blocks.sort((a, b) => (a.overflow ? 1 : 0) - (b.overflow ? 1 : 0) || a.start.localeCompare(b.start));
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
  const enough = overflow === 0;
  if (locale === "en")
    return `${t} ticket${t === 1 ? "" : "s"} and ${k} task${k === 1 ? "" : "s"} for today, about ${hours(planned + overflow)} of work for ${hours(cap)} available.${over ? ` ${over} already late.` : ""} ${enough ? "It fits in the day." : `About ${hours(overflow)} will not fit: move or hand off something.`}`;
  return `${t} billet${t > 1 ? "s" : ""} et ${k} tâche${k > 1 ? "s" : ""} aujourd'hui, environ ${hours(planned + overflow)} de travail pour ${hours(cap)} de disponible.${over ? ` ${over} déjà en retard.` : ""} ${enough ? "Ça entre dans la journée." : `Environ ${hours(overflow)} ne rentreront pas : déplacez ou déléguez quelque chose.`}`;
}

/** Plan one technician's day and keep it. The AI orders the work and writes the summary; the hours are laid out here. */
export async function buildPlan(userId: string, date: string, opts: { ai: boolean; locale?: "fr" | "en"; by?: string | null } = { ai: false }) {
  const settings = await pipelineSettings();
  const [user] = await db().select({ name: schema.users.name, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId));
  const locale = opts.locale ?? user?.locale ?? "fr";
  const day = await dayItems(userId, date);
  const { items, busy, absent } = day;
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
        const lines = planable.map((i) => `- ${i.key} · ${i.kind === "ticket" ? `billet ${i.ticketNumber ?? ""}` : "tâche"} · « ${i.title} »${i.client ? ` · client ${i.client}` : ""} · priorité ${i.priority} · échéance ${i.due ?? "aucune"}${i.overdue ? " (EN RETARD)" : ""} · ${i.minutes} min`);
        const free = layout([], settings, busy).capacityMinutes;
        const out = await askClaudeJson<{ summary?: unknown; order?: { ref?: unknown; note?: unknown }[] }>({
          system: `Tu es l'assistant de planification d'AKAB Informatique (services TI, Québec). Réponds en ${locale === "en" ? "anglais" : "français québécois"}, ton direct et chaleureux, tutoiement. Tu prépares la journée d'un technicien : c'est une suggestion, pas un horaire fixe.`,
          feature: "pipeline.day",
          userId,
          prompt: `Date : ${date}. Heures de travail ${settings.workStart}–${settings.workEnd} (dîner ${settings.lunchStart}–${settings.lunchEnd}), ${hours(free)} libres après les événements. Voici ce qui est à faire :\n${lines.join("\n")}\n\nChoisis l'ordre de traitement (les retards et les urgences d'abord, regroupe ce qui va ensemble, garde les tâches longues pour le début de la matinée ou de l'après-midi). Donne un résumé de 2 à 4 phrases de la journée : ce qui compte le plus, si le temps est suffisant, ce qu'il faudrait déplacer ou déléguer sinon. Format : {"summary": "...", "order": [{"ref": "task:... ou ticket:...", "note": "raison en 12 mots ou moins"}]}`,
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
  const values = { userId, date, summary, blocks: lay.blocks, capacityMinutes: cap, plannedMinutes: lay.plannedMinutes + lay.overflowMinutes, source, updatedAt: new Date() };
  const [row] = await db()
    .insert(schema.pipelineDayPlans)
    .values(values)
    .onConflictDoUpdate({ target: [schema.pipelineDayPlans.userId, schema.pipelineDayPlans.date], set: { summary, blocks: lay.blocks, capacityMinutes: cap, plannedMinutes: values.plannedMinutes, source, updatedAt: new Date() } })
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
export async function buildPipelineView(userId: string, date: string) {
  const { items, absent, holiday, busy } = await dayItems(userId, date);
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
}

