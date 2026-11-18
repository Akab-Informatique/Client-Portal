import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";
import { getScreen, newKey, sameSecret, shouldRest } from "./tv.ts";

/**
 * Technical TV dashboard ("Écran technique"): a second kiosk screen for the technical department, on its own link
 * (/noc/index.html?key=…) and its own display key. The feed is PUBLIC (a secret key in the URL), so it carries only what the
 * screen shows: ticket number, client NAME, title cut to 60 characters, technician FIRST name, priority and status labels,
 * due day, project number / name / client / progress / hours, and plain counts for the RMM and UniFi. Never an address,
 * MAC, host name, contact, email, phone, note or amount of money.
 * The burn-in protection (rest screen, brightness) uses the SAME screen settings as the lobby TV.
 */

export const NOC_PROVIDER = "noc";
export const SNAPSHOT_MS = 30_000;
export const TITLE_MAX = 60;
export const URGENT_MAX = 8;

// ── Display key (its own integrations row, sealed like the lobby's) ──
export async function getNocKey(): Promise<string> {
  const claimed = await db()
    .insert(schema.integrations)
    .values({ provider: NOC_PROVIDER, enabled: true, config: {}, secret: seal(JSON.stringify({ displayKey: newKey() })) })
    .onConflictDoNothing()
    .returning({ provider: schema.integrations.provider });
  void claimed;
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, NOC_PROVIDER));
  const key = (JSON.parse(unseal(row?.secret) ?? "{}") as { displayKey?: string }).displayKey;
  return key ?? rotateNocKey();
}

export async function rotateNocKey(): Promise<string> {
  const key = newKey();
  const done = await db()
    .update(schema.integrations)
    .set({ secret: seal(JSON.stringify({ displayKey: key })), updatedAt: new Date() })
    .where(eq(schema.integrations.provider, NOC_PROVIDER))
    .returning({ provider: schema.integrations.provider });
  if (!done.length) {
    await db().insert(schema.integrations).values({ provider: NOC_PROVIDER, enabled: true, config: {}, secret: seal(JSON.stringify({ displayKey: key })) }).onConflictDoNothing();
  }
  snapshotCache = null;
  return key;
}

export async function nocKeyMatches(probe: string): Promise<boolean> {
  return sameSecret(probe, await getNocKey());
}

// ── Helpers ──
const dayOf = (d: Date | string | number) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const firstName = (full: string) => (full.trim().split(/\s+/)[0] ?? "").slice(0, 20);
export const shortTitle = (t: string) => {
  const s = String(t).replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : s;
};
const startOfQuebecDay = (day: string) => {
  // midnight Québec: -05:00 in winter, -04:00 in summer; the hour of difference never changes which day an event falls on for a TV
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "shortOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const h = Math.abs(Number(off.replace("GMT", "").split(":")[0]) || -5);
  return Date.parse(`${day}T00:00:00-${String(h).padStart(2, "0")}:00`);
};

type Panel<T> = (T & { error?: undefined }) | { error: true } | null;

async function safe<T>(fn: () => Promise<T | null>): Promise<Panel<T>> {
  try {
    return (await fn()) as Panel<T>;
  } catch {
    return { error: true };
  }
}

// ── Tickets, technicians, trend ──
async function ticketData() {
  const { ticketSource } = await import("./ticketSource.ts");
  const { isAlert, lookup } = await import("../routes/tickets.ts");
  const { gaugeQueues } = await import("./meetingsData.ts");
  const src = await ticketSource(); // staff-scoped: tickets of self-managed clients stay hidden
  const now = Date.now();
  const today = dayOf(now);
  const days = [6, 5, 4, 3, 2, 1, 0].map((n) => addDays(today, -n));
  const since = new Date(startOfQuebecDay(days[0])).toISOString();
  const [all, o, history] = await Promise.all([src.list(), src.options(), src.history(since)]);
  const L = lookup(o);
  const queues = await gaugeQueues(o.queues);
  const alert = isAlert(L);
  const counted = (t: { queue: string }) => queues.counted.includes(t.queue);
  const open = all.filter((t) => L.statusKind(t.status) !== "complete");
  const real = open.filter((t) => counted(t) && !alert(t));
  const isLate = (t: { dueAt: string }) => Boolean(t.dueAt) && Date.parse(t.dueAt) < now;
  const overdue = real.filter(isLate);
  const dueToday = real.filter((t) => t.dueAt && dayOf(t.dueAt) === today && !isLate(t));
  const unassigned = real.filter((t) => !t.assignee && L.statusKind(t.status) === "new");
  const alerts = open.filter((t) => alert(t));

  const rows = history.filter((h) => counted(h) && !alert(h as never));
  const trend = days.map((day) => ({
    day,
    created: rows.filter((r) => dayOf(r.createdAt) === day).length,
    resolved: rows.filter((r) => r.completedAt && dayOf(r.completedAt) === day).length,
  }));
  const todayRow = trend[trend.length - 1];

  const urgent = [...real]
    .sort((a, b) => {
      const la = isLate(a) ? 0 : 1;
      const lb = isLate(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      return (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity);
    })
    .slice(0, URGENT_MAX)
    .map((t) => ({
      number: t.number,
      client: t.company.name,
      title: shortTitle(t.title),
      tech: t.assignee ? firstName(t.assignee.name) : null,
      priority: t.priority,
      priorityLabel: L.priorityLabel(t.priority) ?? t.priority,
      priorityKind: L.priorityKind(t.priority),
      status: L.statusLabel(t.status) ?? t.status,
      due: t.dueAt ? dayOf(t.dueAt) : null,
      late: isLate(t),
    }));

  const staff = await db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  const running = await runningWork();
  const techs = staff
    .map((u) => {
      const mine = real.filter((t) => t.assignee?.id === u.id);
      return { id: u.id, name: firstName(u.name), open: mine.length, overdue: mine.filter(isLate).length, on: running.get(u.id) ?? null };
    })
    .filter((t) => t.open > 0 || t.on)
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name))
    .map(({ id: _id, ...t }) => t);

  return {
    tickets: {
      open: real.length,
      unassigned: unassigned.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      alerts: alerts.length,
      createdToday: todayRow.created,
      resolvedToday: todayRow.resolved,
      urgent,
    },
    techs,
    trend,
  };
}

/** What each person is working on right now: a running ticket timer (number) or a running project timer (number). */
async function runningWork() {
  const d = db();
  const out = new Map<string, { kind: "ticket" | "project"; ref: string }>();
  const t = await d.select({ userId: schema.ticketTimers.userId, n: schema.ticketTimers.ticketNumber }).from(schema.ticketTimers).where(and(eq(schema.ticketTimers.state, "running"), isNull(schema.ticketTimers.endedAt)));
  for (const r of t) out.set(r.userId, { kind: "ticket", ref: r.n });
  const p = await d
    .select({ userId: schema.projTimers.userId, n: schema.projProjects.number })
    .from(schema.projTimers)
    .innerJoin(schema.projProjects, eq(schema.projProjects.id, schema.projTimers.projectId))
    .where(isNull(schema.projTimers.pausedAt));
  for (const r of p) if (!out.has(r.userId)) out.set(r.userId, { kind: "project", ref: r.n });
  return out;
}

// ── Projects (new format) in progress ──
async function projectData() {
  const d = db();
  const rows = await d.select().from(schema.projProjects).where(inArray(schema.projProjects.status, ["planning", "active", "waiting_customer", "waiting_vendor"]));
  if (!rows.length) return { items: [] as never[], total: 0 };
  const ids = rows.map((p) => p.id);
  const [tasks, hours, clients] = await Promise.all([
    d.select({ projectId: schema.projTasks.projectId, status: schema.projTasks.status }).from(schema.projTasks).where(inArray(schema.projTasks.projectId, ids)),
    d
      .select({ projectId: schema.timesheetEntries.projId, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
      .from(schema.timesheetEntries)
      .where(inArray(schema.timesheetEntries.projId, ids))
      .groupBy(schema.timesheetEntries.projId),
    d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients),
  ]);
  const cname = new Map(clients.map((c) => [c.id, c.name]));
  const today = dayOf(Date.now());
  const items = rows
    .map((p) => {
      const mine = tasks.filter((t) => t.projectId === p.id);
      const done = mine.filter((t) => t.status === "done").length;
      const worked = Number(hours.find((h) => h.projectId === p.id)?.h ?? 0) / 100;
      return {
        number: p.number,
        name: shortTitle(p.name),
        client: p.clientId ? (cname.get(p.clientId) ?? null) : null,
        pct: mine.length ? Math.round((done / mine.length) * 100) : null,
        tasks: mine.length,
        worked: Math.round(worked * 10) / 10,
        sold: p.soldHoursX100 == null ? null : Math.round(p.soldHoursX100 / 10) / 10,
        due: p.dueDate,
        late: Boolean(p.dueDate) && (p.dueDate as string) < today,
      };
    })
    .sort((a, b) => Number(b.late) - Number(a.late) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.number.localeCompare(b.number));
  return { items: items.slice(0, 6), total: items.length };
}

// ── RMM (from the synced table: no live Datto call) ──
async function rmmData() {
  const devs = await db()
    .select({ online: schema.rmmDevices.online, lastSeen: schema.rmmDevices.lastSeen, reboot: schema.rmmDevices.rebootRequired, patches: schema.rmmDevices.patchesPending })
    .from(schema.rmmDevices);
  if (!devs.length) return null; // Datto not set up (or nothing synced yet): the panel is hidden
  const weekAgo = Date.now() - 7 * 86_400_000;
  return {
    total: devs.length,
    online: devs.filter((x) => x.online).length,
    offline: devs.filter((x) => !x.online).length,
    offline7d: devs.filter((x) => !x.online && (!x.lastSeen || x.lastSeen.getTime() < weekAgo)).length,
    reboot: devs.filter((x) => x.reboot).length,
    patches: devs.filter((x) => x.patches > 0).length,
  };
}

// ── UniFi (counts only; unifiOverview has its own 60 s cache) ──
async function unifiData() {
  const { unifiOverview, UnifiError } = await import("./unifi.ts");
  try {
    const o = await unifiOverview();
    return {
      consoles: o.hosts.length,
      consolesOnline: o.hosts.filter((h) => h.online).length,
      devices: o.devices.length,
      devicesOnline: o.devices.filter((x) => x.online).length,
      updates: o.devices.filter((x) => x.updateAvailable).length,
      sitesOffline: o.sites.filter((s) => s.offline > 0).length,
      sites: o.sites.length,
    };
  } catch (e) {
    if (e instanceof UnifiError && e.code === "unifi_not_configured") return null;
    throw e;
  }
}

// ── The snapshot (kept 30 s, never fails as a whole) ──
let snapshotCache: { at: number; data: Awaited<ReturnType<typeof build>>; pending?: undefined } | null = null;
let inflight: Promise<Awaited<ReturnType<typeof build>>> | null = null;

async function build() {
  const [t, projects, rmm, unifi] = await Promise.all([
    safe(ticketData),
    safe(projectData),
    safe(rmmData),
    safe(unifiData),
  ]);
  const tk = t && !("error" in t && t.error) ? (t as Awaited<ReturnType<typeof ticketData>>) : null;
  return {
    updatedAt: new Date().toISOString(),
    tickets: tk ? tk.tickets : t,
    techs: tk ? tk.techs : t,
    trend: tk ? tk.trend : t,
    projects,
    rmm,
    unifi,
  };
}

export async function nocSnapshot(opts: { rest?: boolean; now?: Date } = {}) {
  const now = Date.now();
  if (!snapshotCache || now - snapshotCache.at >= SNAPSHOT_MS) {
    inflight ??= build().finally(() => {
      inflight = null;
    });
    const data = await inflight;
    snapshotCache = { at: Date.now(), data };
  }
  const sc = await getScreen();
  const screen = { rest: opts.rest === true || shouldRest(sc, opts.now ?? new Date(now)), brightness: sc.brightness };
  return { ...snapshotCache.data, screen };
}

export function resetNocCache() {
  snapshotCache = null;
}
