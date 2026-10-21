import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { holidaysBetween } from "../../shared/holidays.ts";
import { AiError, aiSettings, askClaudeJson } from "./ai.ts";
import { audit } from "./audit.ts";
import { permissionsOf } from "./auth.ts";
import { calendarOfDay, dayItems, isWorkday, mondayOf, pipelineSettings, type DayItem } from "./pipeline.ts";
import { ticketSource, type NTicket } from "./ticketSource.ts";
import { isAlert, lookup } from "../routes/tickets.ts";
import { addDay, gaugeQueues } from "./meetingsData.ts";

/**
 * The week ahead, for the Monday meeting: a short list of what the week will look like and what management could
 * do about it. Built from the same sources as the weekly meeting page (absences, team events, projects, tickets due
 * and late, the gauges' queues) and from each technician's days as My day works them out (what is due, what is
 * pinned, their Outlook calendar, their capacity). The AI writes the bullets from a compact digest; without it
 * the portal writes them from the same numbers.
 */
export type Brief = { weekStart: string; bullets: string[]; suggestions: string[]; source: "ai" | "rules"; generatedAt: string };

const hours = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
const DAYS_FR = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const dayName = (ymd: string) => DAYS_FR[new Date(`${ymd}T12:00:00Z`).getUTCDay()];
const dayNum = (ymd: string) => `${dayName(ymd)} ${Number(ymd.slice(8))}`;

type Person = { id: string; name: string; capacity: Record<string, number>; load: Record<string, number>; backlog: number; absentDays: string[]; pinned: number; overdue: number; dueWeek: number; tickets: number; tasks: number };
export type Facts = {
  from: string;
  to: string;
  workdays: string[];
  holidays: { date: string; key: string }[];
  absences: { name: string; from: string; to: string; kind: string }[];
  events: { date: string; time: string | null; title: string; who: string | null }[];
  projects: { title: string; client: string | null; due: string }[];
  projectsLate: number;
  tickets: { overdue: number; dueWeek: number; dueByDay: Record<string, number>; unassigned: number; stray: number; alerts: number; demo: boolean };
  people: Person[];
  tasks: { unassigned: number; overdue: number };
};

/** Monday of the week the meeting is about: this week from Monday to Friday, the next one over a weekend */
export function briefWeek(today: string): string {
  const d = new Date(`${today}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6 ? addDay(mondayOf(today), 7) : mondayOf(today);
}

export async function gatherFacts(from: string): Promise<Facts> {
  const to = addDay(from, 6);
  const friday = addDay(from, 4);
  const workdays = [0, 1, 2, 3, 4].map((n) => addDay(from, n)).filter((d) => isWorkday(d));
  const holidayMap = holidaysBetween(from, friday);
  const d = db();
  const [absRows, evRows, projRows, projLate, taskRows, settings] = await Promise.all([
    d
      .select({ name: schema.users.name, userId: schema.meetingAbsences.userId, from: schema.meetingAbsences.startDate, to: schema.meetingAbsences.endDate, kind: schema.meetingAbsences.kind })
      .from(schema.meetingAbsences)
      .innerJoin(schema.users, eq(schema.users.id, schema.meetingAbsences.userId))
      .where(and(lte(schema.meetingAbsences.startDate, to), gte(schema.meetingAbsences.endDate, from)))
      .orderBy(asc(schema.users.name)),
    d
      .select({ date: schema.meetingEvents.date, time: schema.meetingEvents.startTime, title: schema.meetingEvents.title, who: schema.users.name })
      .from(schema.meetingEvents)
      .leftJoin(schema.users, eq(schema.users.id, schema.meetingEvents.userId))
      .where(and(gte(schema.meetingEvents.date, from), lte(schema.meetingEvents.date, to)))
      .orderBy(asc(schema.meetingEvents.date), asc(schema.meetingEvents.startTime)),
    d
      .select({ title: schema.meetingProjects.title, client: schema.meetingProjects.client, due: schema.meetingProjects.dueDate })
      .from(schema.meetingProjects)
      .where(and(isNull(schema.meetingProjects.doneAt), gte(schema.meetingProjects.dueDate, from), lte(schema.meetingProjects.dueDate, to)))
      .orderBy(asc(schema.meetingProjects.dueDate)),
    d.select({ id: schema.meetingProjects.id }).from(schema.meetingProjects).where(and(isNull(schema.meetingProjects.doneAt), lte(schema.meetingProjects.dueDate, addDay(from, -1)))),
    d.select({ assigneeId: schema.pipelineTasks.assigneeId, due: schema.pipelineTasks.dueDate }).from(schema.pipelineTasks).where(and(eq(schema.pipelineTasks.visibility, "team"), isNull(schema.pipelineTasks.completedAt))),
    pipelineSettings(),
  ]);

  // the tickets: the support queues the meeting gauges count, no monitoring alerts
  const tickets: Facts["tickets"] = { overdue: 0, dueWeek: 0, dueByDay: {}, unassigned: 0, stray: 0, alerts: 0, demo: false };
  try {
    const src = await ticketSource();
    const [all, o] = await Promise.all([src.list(), src.options()]);
    const L = lookup(o);
    const queues = await gaugeQueues(o.queues);
    const alert = isAlert(L);
    tickets.demo = src.demo;
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    const counted = all.filter((t) => queues.counted.includes(t.queue) && !alert(t) && open(t));
    const start = new Date(`${from}T00:00:00-04:00`).getTime();
    const end = new Date(`${addDay(friday, 1)}T00:00:00-05:00`).getTime();
    for (const t of counted) {
      const at = new Date(t.dueAt).getTime();
      if (at < start) tickets.overdue++;
      else if (at < end) {
        tickets.dueWeek++;
        const day = t.dueAt.slice(0, 10);
        tickets.dueByDay[day] = (tickets.dueByDay[day] ?? 0) + 1;
      }
      if (!t.assignee) tickets.unassigned++;
    }
    tickets.stray = counted.filter((t) => !t.assignee && L.statusKind(t.status) !== "new").length;
    tickets.alerts = all.filter((t) => open(t) && alert(t)).length;
  } catch (e) {
    console.warn("[week brief] tickets:", e instanceof Error ? e.message : e);
  }

  // each technician's week, worked out as "My day" does: what is due by Friday (late ones first), what is pinned, their calendar
  const users = await d.select().from(schema.users).where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  const absentOn = (userId: string, day: string) => absRows.some((a) => a.userId === userId && a.from <= day && a.to >= day);
  const people: Person[] = [];
  for (const u of users) {
    if (!(await permissionsOf(u)).includes("pipeline.view")) continue;
    const p: Person = { id: u.id, name: u.name, capacity: {}, load: {}, backlog: 0, absentDays: [], pinned: 0, overdue: 0, dueWeek: 0, tickets: 0, tasks: 0 };
    const work = (Number(settings.workEnd.slice(0, 2)) * 60 + Number(settings.workEnd.slice(3)) - (Number(settings.workStart.slice(0, 2)) * 60 + Number(settings.workStart.slice(3)))) - (Number(settings.lunchEnd.slice(0, 2)) * 60 + Number(settings.lunchEnd.slice(3)) - (Number(settings.lunchStart.slice(0, 2)) * 60 + Number(settings.lunchStart.slice(3))));
    for (const day of workdays) {
      if (absentOn(u.id, day)) {
        p.absentDays.push(day);
        p.capacity[day] = 0;
        continue;
      }
      const cal = await calendarOfDay(u.id, day).catch(() => ({ events: [] as { start: number; end: number; allDay: boolean; free: boolean }[] }));
      const busy = cal.events.filter((e) => !e.free && !e.allDay).reduce((n, e) => n + Math.max(0, e.end - e.start), 0);
      p.capacity[day] = Math.max(0, work - busy);
    }
    const { items } = await dayItems(u.id, friday).catch(() => ({ items: [] as DayItem[] }));
    for (const it of items.filter((x) => !x.blocked)) {
      const due = it.due ?? friday;
      const day = due < from ? "backlog" : (workdays.includes(due) ? due : (workdays.find((w) => w >= due) ?? workdays[workdays.length - 1] ?? friday));
      if (day === "backlog") {
        p.backlog += it.minutes;
        p.overdue++;
      } else {
        p.load[day] = (p.load[day] ?? 0) + it.minutes;
        p.dueWeek++;
      }
      if (it.pin) p.pinned++;
      if (it.kind === "ticket") p.tickets++;
      else p.tasks++;
    }
    people.push(p);
  }

  return {
    from,
    to,
    workdays,
    holidays: [...holidayMap].map(([date, key]) => ({ date, key })),
    absences: absRows.map((a) => ({ name: a.name, from: a.from < from ? from : a.from, to: a.to > friday ? friday : a.to, kind: a.kind })),
    events: evRows.map((e) => ({ date: e.date, time: e.time, title: e.title, who: e.who })),
    projects: projRows.filter((p): p is typeof p & { due: string } => p.due !== null),
    projectsLate: projLate.length,
    tickets,
    people,
    tasks: { unassigned: taskRows.filter((t) => !t.assigneeId).length, overdue: taskRows.filter((t) => t.due && t.due < from).length },
  };
}

/** What the AI reads: the facts, compact, in French */
function digest(f: Facts): string {
  const lines: string[] = [];
  lines.push(`Semaine du ${f.from} au ${addDay(f.from, 4)} (jours ouvrables : ${f.workdays.map(dayNum).join(", ") || "aucun"}).`);
  if (f.holidays.length) lines.push(`Jours fériés : ${f.holidays.map((h) => dayNum(h.date)).join(", ")}.`);
  lines.push(f.absences.length ? `Absences : ${f.absences.map((a) => `${a.name} (${dayNum(a.from)}${a.to !== a.from ? ` au ${dayNum(a.to)}` : ""}, ${a.kind})`).join(" ; ")}.` : "Aucune absence.");
  lines.push(f.events.length ? `Événements d'équipe : ${f.events.map((e) => `${dayNum(e.date)}${e.time ? ` ${e.time}` : ""} ${e.title}${e.who ? ` (${e.who})` : ""}`).join(" ; ")}.` : "Aucun événement d'équipe.");
  lines.push(f.projects.length ? `Projets qui arrivent à échéance : ${f.projects.map((p) => `${p.title}${p.client ? ` (${p.client})` : ""} le ${dayNum(p.due)}`).join(" ; ")}.` : "Aucun projet à échéance cette semaine.");
  if (f.projectsLate) lines.push(`${f.projectsLate} projet(s) déjà en retard.`);
  const t = f.tickets;
  lines.push(`Billets de support : ${t.overdue} déjà en retard, ${t.dueWeek} à échéance cette semaine (${f.workdays.map((d) => `${dayName(d)} ${t.dueByDay[d] ?? 0}`).join(", ")}), ${t.unassigned} sans technicien, ${t.stray} sans technicien et déjà avancés, ${t.alerts} alertes de surveillance ouvertes.`);
  lines.push(`Tâches d'équipe (Pipeline) : ${f.tasks.unassigned} non assignées, ${f.tasks.overdue} en retard.`);
  lines.push("Charge de chaque technicien (travail dû ou en retard / temps disponible après absences et agenda Outlook) :");
  for (const p of f.people) {
    const cap = Object.values(p.capacity).reduce((a, b) => a + b, 0);
    const load = Object.values(p.load).reduce((a, b) => a + b, 0) + p.backlog;
    const perDay = f.workdays.map((d) => `${dayName(d)} ${hours(p.load[d] ?? 0)}/${hours(p.capacity[d] ?? 0)}`).join(", ");
    lines.push(`- ${p.name} : ${hours(load)} de travail (dont ${hours(p.backlog)} en retard) pour ${hours(cap)} disponibles${p.absentDays.length ? `, absent ${p.absentDays.map(dayName).join(" ")}` : ""}${p.pinned ? `, ${p.pinned} priorité(s) épinglée(s)` : ""} ; ${perDay}.`);
  }
  return lines.join("\n");
}

/** The brief written by the portal's rules from the same numbers (AI off or failed) */
export function rulesBrief(f: Facts): { bullets: string[]; suggestions: string[] } {
  const bullets: string[] = [];
  const suggestions: string[] = [];
  const t = f.tickets;
  bullets.push(`${f.workdays.length} jour${f.workdays.length > 1 ? "s" : ""} ouvrable${f.workdays.length > 1 ? "s" : ""}${f.holidays.length ? ` (férié : ${f.holidays.map((h) => dayNum(h.date)).join(", ")})` : ""}.`);
  if (f.absences.length) bullets.push(`Absences : ${f.absences.map((a) => `${a.name} (${dayNum(a.from)}${a.to !== a.from ? `–${dayNum(a.to)}` : ""})`).join(", ")}.`);
  if (f.events.length) bullets.push(`À l'agenda de l'équipe : ${f.events.slice(0, 5).map((e) => `${dayNum(e.date)}${e.time ? ` ${e.time}` : ""} ${e.title}`).join(" ; ")}.`);
  if (f.projects.length) bullets.push(`Projets à échéance : ${f.projects.map((p) => `${p.title} (${dayNum(p.due)})`).join(", ")}.`);
  bullets.push(`Billets : ${t.overdue} en retard, ${t.dueWeek} à échéance cette semaine${t.unassigned ? `, ${t.unassigned} sans technicien` : ""}.`);
  const busiest = Object.entries(t.dueByDay).sort((a, b) => b[1] - a[1])[0];
  if (busiest && busiest[1] >= 5) bullets.push(`Journée la plus chargée en échéances : ${dayNum(busiest[0])} (${busiest[1]} billets).`);
  // the overloaded and the ones with room
  const rows = f.people.map((p) => {
    const cap = Object.values(p.capacity).reduce((a, b) => a + b, 0);
    const load = Object.values(p.load).reduce((a, b) => a + b, 0) + p.backlog;
    return { p, cap, load, free: cap - load };
  });
  const over = rows.filter((r) => r.cap > 0 && r.load > r.cap).sort((a, b) => a.free - b.free);
  const room = rows.filter((r) => r.free > 60).sort((a, b) => b.free - a.free);
  for (const r of over.slice(0, 3)) bullets.push(`${r.p.name} : ${hours(r.load)} de travail pour ${hours(r.cap)} disponibles (il manque ${hours(-r.free)}).`);
  if (!over.length && rows.length) bullets.push("Personne n'est en surcharge d'après les échéances connues.");
  if (t.unassigned) suggestions.push(`Répartir les ${t.unassigned} billet(s) sans technicien en début de semaine${room[0] ? ` (${room.slice(0, 2).map((r) => r.p.name).join(", ")} ont du temps)` : ""}.`);
  for (const r of over.slice(0, 2)) suggestions.push(`Alléger ${r.p.name}${room[0] ? ` : déplacer environ ${hours(Math.min(-r.free, room[0].free))} vers ${room[0].p.name}` : " : reporter ou déléguer une partie de son travail"}.`);
  for (const a of f.absences) {
    const row = f.people.find((p) => p.name === a.name);
    if (row && (row.tickets || row.tasks)) suggestions.push(`Réassigner ou couvrir les billets et tâches de ${a.name} avant son absence (${dayNum(a.from)}).`);
  }
  if (t.overdue > 5) suggestions.push(`Planifier du temps pour résorber les ${t.overdue} billets en retard.`);
  if (f.tasks.unassigned) suggestions.push(`Assigner les ${f.tasks.unassigned} tâche(s) d'équipe sans responsable.`);
  if (f.projectsLate) suggestions.push(`Faire le point sur les ${f.projectsLate} projet(s) en retard.`);
  if (!suggestions.length) suggestions.push("Rien d'urgent à ajuster : garder le cap et revoir les priorités en milieu de semaine.");
  return { bullets: bullets.slice(0, 8), suggestions: suggestions.slice(0, 5) };
}

const rowToBrief = (r: typeof schema.meetingWeekBriefs.$inferSelect): Brief => ({ weekStart: r.weekStart, bullets: r.bullets, suggestions: r.suggestions, source: r.source, generatedAt: r.generatedAt.toISOString() });

/** Write the brief of a week (the AI when it is set up and `ai`), keep it, and return it */
export async function buildBrief(from: string, opts: { ai: boolean; userId?: string | null }): Promise<{ brief: Brief; aiError: string | null }> {
  const facts = await gatherFacts(from);
  let out = rulesBrief(facts);
  let source: "ai" | "rules" = "rules";
  let aiError: string | null = null;
  if (opts.ai) {
    const s = await aiSettings();
    if (s.enabled && s.apiKey) {
      try {
        const r = await askClaudeJson<{ bullets?: unknown; suggestions?: unknown }>({
          system: "Tu es l'assistant de gestion d'AKAB Informatique (services TI, Québec). Tu prépares la rencontre d'équipe du lundi : un aperçu bref et concret de la semaine à venir, et des suggestions de gestion. Français québécois, ton direct, parle de l'équipe à la troisième personne, pas de blabla.",
          feature: "meetings.week",
          userId: opts.userId ?? null,
          prompt: `${digest(facts)}\n\nÉcris : « bullets » = 5 à 8 puces courtes (une ligne chacune) sur ce à quoi ressemble la semaine : jours chargés ou calmes, absences et leur effet, échéances, surcharge ou marge de chaque technicien, retards. « suggestions » = 3 à 5 puces d'actions de gestion précises (qui déplacer, quoi reporter, ce à quoi décider en réunion), avec des noms et des chiffres tirés des données. N'invente rien. Format : {"bullets": ["..."], "suggestions": ["..."]}`,
          maxTokens: 3000,
        });
        const clean = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().replace(/^[-•·]\s*/, "").slice(0, 280)).slice(0, max) : []);
        const bullets = clean(r.bullets, 8);
        const suggestions = clean(r.suggestions, 5);
        if (bullets.length >= 2) {
          out = { bullets, suggestions: suggestions.length ? suggestions : out.suggestions };
          source = "ai";
        } else aiError = "bad_output";
      } catch (e) {
        aiError = e instanceof AiError ? e.code : "error";
        console.warn("[week brief] AI:", e instanceof Error ? e.message : e);
      }
    } else aiError = s.apiKey ? "disabled" : "not_configured";
  }
  const [row] = await db()
    .insert(schema.meetingWeekBriefs)
    .values({ weekStart: from, bullets: out.bullets, suggestions: out.suggestions, source, generatedBy: opts.userId ?? null })
    .onConflictDoUpdate({ target: schema.meetingWeekBriefs.weekStart, set: { bullets: out.bullets, suggestions: out.suggestions, source, generatedBy: opts.userId ?? null, generatedAt: new Date() } })
    .returning();
  if (opts.ai) await audit(opts.userId ?? null, "meetings.week_brief", from, { source, aiError });
  return { brief: rowToBrief(row), aiError };
}

/** The kept brief; the portal's own is always rebuilt (cheap, always current), an AI one is kept until asked again */
export async function briefOf(from: string): Promise<Brief> {
  const [hit] = await db().select().from(schema.meetingWeekBriefs).where(eq(schema.meetingWeekBriefs.weekStart, from));
  if (hit && hit.source === "ai") return rowToBrief(hit);
  return (await buildBrief(from, { ai: false })).brief;
}
