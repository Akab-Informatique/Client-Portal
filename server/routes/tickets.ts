import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { localAssets } from "../lib/queues.ts";
import { clientInfo } from "../lib/clientHours.ts";
import { contractOfTicket, contractsOfCompany, setTicketContract, type ContractView } from "../lib/contracts.ts";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { sanitizeMailHtml } from "../lib/mailHtml.ts";
import { sendMail } from "../lib/mail.ts";
import { notify } from "../lib/notify.ts";
import { AI_FEATURE_KEYS, AI_MODELS, AiError, aiSettings, askClaude, askClaudeJson, modelFor, todayOf, type AiModel } from "../lib/ai.ts";
import { sweepTimers, timerView, elapsedMs } from "../lib/timers.ts";
import { MAX_TICKET_ATTACHMENT_BYTES, SourceError, ticketSource, type Asset, type NTicket, type Options, type TicketSource } from "../lib/ticketSource.ts";
import { deleteTicket, ticketFile, ticketsLocal } from "../lib/localTickets.ts";
import { rmmLink, rmmSettings, type RmmSettings } from "../lib/rmm.ts";
import { searchProducts, serialsOf, StoreError, takeForTicket, undoTake } from "../lib/store.ts";
import { storeHttp } from "./store.ts";
import { rememberCompany, rememberContact } from "../lib/crm.ts";
import { fridayEnd } from "./meetings.ts";
import { addTicketTime } from "../lib/timesheets.ts";

/**
 * Tickets (staff). Data come from the ticket source: the portal's database,
 * sample tickets in development (see ticketSource.ts).
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** HH:MM, 24 h */
const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zUuidOrNull = z.uuid().nullable().default(null);
const FILTER_PARAMS = ["view", "assignee", "q", "due", "created", "attention", "statusKind", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "alerts", "sort"];
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

// ── Errors from the source → HTTP ──
function sourceError(e: unknown): HTTPException {
  if (e instanceof HTTPException) return e;
  if (e instanceof SourceError) {
    return new HTTPException(e.code === "not_found" ? 404 : 400, { message: e.code });
  }
  console.error("[tickets]", e);
  return new HTTPException(500, { message: "Internal error" });
}
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw sourceError(e);
  }
}

// ── AI helpers ──
const aiRole = (locale: string) =>
  `Tu es l'assistant des techniciens d'AKAB Informatique, un fournisseur de services TI (MSP) au Québec. Réponds en ${locale === "en" ? "anglais" : "français québécois"}. Sois concret et bref.`;
const zAnalysis = z.object({
  summary: z.string().max(2000),
  nextSteps: z.array(z.string().max(500)).max(15).default([]),
  risks: z.array(z.string().max(500)).max(10).default([]),
  questions: z.array(z.string().max(500)).max(10).default([]),
  suggestedPriority: z.enum(["critical", "high", "medium", "low"]).nullable().optional(),
});
const zPlan = z.object({
  overview: z.string().max(2000).default(""),
  items: z
    .array(z.object({ id: z.number(), order: z.number(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(400).default("") }))
    .max(100),
});
function aiHttpError(e: unknown) {
  if (e instanceof AiError) {
    const status = e.code === "not_configured" || e.code === "disabled" || e.code === "billing" ? 409 : e.code === "rate_limit" || e.code === "daily_limit" ? 429 : 502;
    console.warn("[ai]", e.message);
    return new HTTPException(status, { message: `ai_${e.code}` });
  }
  return sourceError(e);
}
/** A model picked next to an AI button (optional). */
async function askedModel(c: Context<AppEnv>): Promise<AiModel | null> {
  const raw = (await c.req.json().catch(() => ({}))) as { model?: unknown };
  return AI_MODELS.includes(raw?.model as AiModel) ? (raw.model as AiModel) : null;
}
const aiLimit = (userId: string) => {
  if (!rateLimit(`ai:${userId}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
};

// ── Labels and kinds from the source's lists ──
type Lookup = ReturnType<typeof lookup>;
export function lookup(o: Options) {
  const st = new Map(o.statuses.map((s) => [s.value, s]));
  const pr = new Map(o.priorities.map((s) => [s.value, s]));
  const qu = new Map(o.queues.map((s) => [s.value, s]));
  return {
    statusKind: (v: string) => st.get(v)?.kind ?? "other",
    statusLabel: (v: string) => st.get(v)?.label ?? null,
    priorityKind: (v: string) => pr.get(v)?.kind ?? "medium",
    priorityLabel: (v: string) => pr.get(v)?.label ?? null,
    queueLabel: (v: string) => qu.get(v)?.label ?? v,
    queueKind: (v: string) => qu.get(v)?.kind ?? "",
  };
}

const zEstimate = z.object({ quick: z.boolean(), minutes: z.number().int().min(5).max(240).nullable(), reason: z.string().max(400).default("") });

async function saveEstimate(id: number, minutes: number | null, source: "tech" | "ai", userId: string) {
  const set = { estimateMinutes: minutes, estimateSource: minutes ? source : null };
  await db()
    .insert(schema.ticketMeta)
    .values({ ticketId: id, ...set, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { ...set, updatedBy: userId, updatedAt: new Date() } });
}

/** The ticket as text for the AI (no portal account data). */
async function ticketForAi(src: TicketSource, id: number): Promise<string> {
  const t = await src.get(id);
  if (!t) throw new HTTPException(404, { message: "not_found" });
  const L = lookup(await src.options());
  const start = (await startDates([id])).get(id);
  const notes = t.notes.map((n) => `- [${n.at.slice(0, 16)}] ${n.author}${n.internal ? " (note interne)" : ""} : ${n.text}`).join("\n");
  return [
    `Billet ${t.number} — ${t.title}`,
    `Client : ${t.company.name}${t.contact ? ` (contact : ${t.contact})` : ""}`,
    `Statut : ${L.statusLabel(t.status) ?? L.statusKind(t.status)} · Priorité : ${L.priorityLabel(t.priority) ?? L.priorityKind(t.priority)} · File : ${L.queueLabel(t.queue)}`,
    `Assigné à : ${t.assignee?.name ?? "personne"} · Créé : ${t.createdAt.slice(0, 16)} · Échéance : ${t.dueAt.slice(0, 16)}${start ? ` · Début prévu : ${start}` : ""}`,
    `Description :\n${t.description || "(aucune)"}`,
    `Historique :\n${notes || "(aucun)"}`,
  ].join("\n");
}

// ── Presence: who has a ticket open right now (in memory, 30 s heartbeat) ─────
const PRESENCE_TTL = 30_000;
const presence = new Map<number, Map<string, { name: string; at: number }>>();
/** Technicians who have this ticket open right now (first names), for the client portal. */
export const techniciansViewing = (ticketId: number) => viewersOf(ticketId).map((v) => v.name);
function viewersOf(ticketId: number, exceptUserId?: string) {
  const m = presence.get(ticketId);
  if (!m) return [];
  const now = Date.now();
  for (const [id, v] of m) if (now - v.at > PRESENCE_TTL) m.delete(id);
  return [...m].filter(([id]) => id !== exceptUserId).map(([userId, v]) => ({ userId, name: v.name }));
}

/** Start dates set in the portal (and the tickets restricted until then). */
async function startDates(ids: number[]) {
  const out = new Map<number, string>() as Map<number, string> & { locked: Set<number>; times: Map<number, string> };
  out.locked = new Set<number>();
  out.times = new Map<number, string>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db().select().from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, ids.slice(i, i + 500)));
    for (const r of rows) {
      if (!r.startDate) continue;
      out.set(r.ticketId, r.startDate);
      if (r.startTime) out.times.set(r.ticketId, r.startTime);
      if (r.startLocked) out.locked.add(r.ticketId);
    }
  }
  return out;
}
/** Today in Québec, YYYY-MM-DD */
const todayQuebec = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
/** Now in Québec, "YYYY-MM-DD HH:MM" */
const nowQuebec = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
/** Restricted and its start (day, and time when set) not reached yet: no work on it */
async function notStartedYet(id: number): Promise<string | null> {
  const [m] = await db().select().from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, id));
  if (!m?.startLocked || !m.startDate) return null;
  const notYet = m.startTime ? `${m.startDate} ${m.startTime}` > nowQuebec() : m.startDate > todayQuebec();
  return notYet ? m.startDate : null;
}

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
/** Ticket sources of monitoring ("Monitoring Alert", "monitoring"…) */
const ALERT_SOURCE = /alert|monitor/i;
/** A monitoring alert: in a queue marked as alerts (Admin › Files d'attente), or created by monitoring */
export const isAlert = (L: Lookup) => (t: NTicket) => L.queueKind(t.queue) === "alerts" || ALERT_SOURCE.test(t.source ?? "");

const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

function summary(t: NTicket, L: Lookup, start: string | undefined, me: string, locked = false, startTime?: string) {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    company: t.company,
    contact: t.contact,
    contactId: t.contactId,
    status: t.status,
    statusLabel: L.statusLabel(t.status),
    statusKind: L.statusKind(t.status),
    priority: t.priority,
    priorityLabel: L.priorityLabel(t.priority),
    priorityKind: L.priorityKind(t.priority),
    queue: t.queue,
    queueLabel: L.queueLabel(t.queue),
    source: t.source,
    assignee: t.assignee,
    secondary: t.secondary,
    /** First line of the description, for the list */
    excerpt: t.description.split("\n").find((l) => l.trim())?.slice(0, 180) ?? "",
    createdAt: t.createdAt,
    dueAt: t.dueAt,
    updatedAt: t.updatedAt,
    startDate: start ?? null,
    /** HH:MM on the start date, when set */
    startTime: (start && startTime) || null,
    /** No work before the start date */
    startLocked: Boolean(start && locked),
    viewers: viewersOf(t.id, me),
  };
}

const myTimers = (userId: string) =>
  db().select().from(schema.ticketTimers).where(eq(schema.ticketTimers.userId, userId)).orderBy(asc(schema.ticketTimers.startedAt));

async function ownTimer(timerId: string, userId: string) {
  const id = z.uuid().safeParse(timerId);
  if (!id.success) throw new HTTPException(404, { message: "not_found" });
  const [t] = await db()
    .select()
    .from(schema.ticketTimers)
    .where(and(eq(schema.ticketTimers.id, id.data), eq(schema.ticketTimers.userId, userId)));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  return t;
}

/** A device with its RMM links (device page, web remote control) when the RMM is set up. */
function assetView(x: Asset, r: RmmSettings) {
  const values = { uid: x.rmm.uid, id: x.rmm.id, hostname: x.hostname, serial: x.serial, ip: x.ip };
  return {
    ...x,
    /** "local": made in the portal; "rmm": synced from the RMM */
    origin: x.id.startsWith("local:") ? ("local" as const) : ("rmm" as const),
    links: r.enabled
      ? { rmm: r.name || null, device: rmmLink(r.deviceUrl, values), remote: rmmLink(r.remoteUrl, values) }
      : { rmm: null, device: null, remote: null },
  };
}

const L_OPEN = (o: Options, t: NTicket) => o.statuses.find((s) => s.value === t.status)?.kind !== "complete";

/** Lower case, no accents: "Résumé" finds "resume". */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * The work done, by email (a time entry's description): to the ticket contact
 * when asked, and to the other addresses typed. One message per recipient.
 */
async function notifyWork(
  src: TicketSource,
  tk: Awaited<ReturnType<TicketSource["get"]>> | null,
  summary: string,
  n: { contact: boolean; others: string[] },
  a: AuthContext,
): Promise<{ to: string[]; failed: number; noContactEmail: boolean; inPortal: number }> {
  if (!tk || (!n.contact && !n.others.length)) return { to: [], failed: 0, noContactEmail: false, inPortal: 0 };
  const contact =
    n.contact && tk.contactId
      ? await src
          .contacts(tk.company.id)
          .then((l) => l.find((x) => x.id === tk.contactId) ?? null)
          .catch(() => null)
      : null;
  const contactEmail = contact?.email?.trim().toLowerCase() || null;
  const to = [...new Set([...(contactEmail ? [contactEmail] : []), ...n.others.map((x) => x.trim().toLowerCase())])];
  const hello = contact?.name ? `Bonjour ${contact.name},` : "Bonjour,";
  const subject = `Billet ${tk.number} — ${tk.title}`.slice(0, 250);
  const intro = `Voici le travail effectué sur votre billet ${tk.number} (${tk.title}) :`;
  const sign = `${a.realUser.name}\nAKAB Informatique`;
  const text = [hello, "", intro, "", summary, "", "—", sign].join("\n");
  const html = `<p>${escHtml(hello)}</p><p>${escHtml(intro)}</p><p style="white-space:pre-wrap;border-left:3px solid #ffce1a;padding-left:10px">${escHtml(summary)}</p><p>—<br>${escHtml(a.realUser.name)}<br>AKAB Informatique</p>`;
  let failed = 0;
  for (const addr of to) if (!(await sendMail({ to: addr, subject, text, html }))) failed++;
  // the client portal too: whoever got the email and has an account there sees it on their bell
  const inPortal = await tellClientUsers(tk, to, summary, a);
  return { to, failed, noContactEmail: n.contact && !contactEmail, inPortal };
}

/**
 * Client portal users (of the ticket's company) with one of these addresses
 * get a notification: a technician shared the work done on their ticket.
 */
async function tellClientUsers(tk: NTicket, emails: string[], summary: string, a: AuthContext): Promise<number> {
  if (!emails.length) return 0;
  const d = db();
  // the portal clients tied to the ticket's company: its Autotask id, or (sample data) its name
  const clients = await d
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(or(eq(schema.clients.autotaskId, tk.company.id), sql`lower(${schema.clients.name}) = ${tk.company.name.trim().toLowerCase()}`));
  if (!clients.length) return 0;
  const users = await d
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.kind, "client"),
        eq(schema.users.active, true),
        inArray(
          schema.users.clientId,
          clients.map((c) => c.id),
        ),
        inArray(sql`lower(${schema.users.email})`, emails),
      ),
    );
  await notify(
    users.map((u) => u.id),
    { type: "ticket.work", data: { number: tk.number, title: tk.title, from: a.realUser.name, preview: summary.slice(0, 140) }, link: `/tickets?t=${tk.id}` },
  );
  return users.length;
}

/** Full ticket for the ticket window, with the choices needed to edit it inline. */
async function detailOf(src: TicketSource, id: number, a: AuthContext) {
  const t = await src.get(id);
  if (!t) throw new HTTPException(404, { message: "not_found" });
  const [o, technicians, starts, ai, asset, contactInfo, client, meta, billing] = await Promise.all([
    src.options(),
    src.technicians(),
    startDates([id]),
    a.permissions.includes("tickets.ai") ? aiSettings() : Promise.resolve(null),
    // the device: from the client's (cached) list; a failure only hides it
    t.assetId
      ? Promise.all([src.assets(t.company.id), rmmSettings()])
          .then(([list, r]) => {
            const x = list.find((d) => d.id === t.assetId);
            return x ? assetView(x, r) : null;
          })
          .catch(() => null)
      : Promise.resolve(null),
    // the contact phone / email, for one-click call or email (cached list)
    t.contactId
      ? src
          .contacts(t.company.id)
          .then((list) => {
            const x = list.find((c) => c.id === t.contactId);
            return x ? { email: x.email, phone: x.phone } : null;
          })
          .catch(() => null)
      : Promise.resolve(null),
    // the client's classification and this month's hours (a failure only hides them)
    clientInfo(t.company.id).catch(() => null),
    db().select({ minutes: schema.ticketMeta.estimateMinutes, source: schema.ticketMeta.estimateSource }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, id)),
    // the contract the work is billed on, and the client's others (a failure only hides them)
    contractOfTicket(id, t.company.id).catch(() => null),
  ]);
  return {
    ...summary(t, lookup(o), starts.get(id), a.user.id, starts.locked.has(id), starts.times.get(id)),
    description: t.description,
    source: t.source,
    hours: t.hours,
    notes: t.notes,
    assetId: t.assetId ?? null,
    asset,
    contactInfo,
    client,
    contract: billing?.contract ?? null,
    contracts: billing?.contracts ?? [],
    estimate: meta[0]?.minutes ? { minutes: meta[0].minutes, source: meta[0].source === "ai" ? ("ai" as const) : ("tech" as const) } : null,
    demo: src.demo,
    /** The ticket lives in the portal's own database (it can be deleted here) */
    local: await ticketsLocal(),
    ai: Boolean(ai?.enabled && ai.apiKey),
    options: { statuses: o.statuses, priorities: o.priorities, queues: o.queues, sources: o.ticketSources ?? [], technicians },
  };
}

/** Timers being validated (a double click makes one time entry) */
const submitting = new Set<string>();

export const ticketRoutes = new Hono<AppEnv>()
  .use(requirePermission("tickets.view"))

  .get("/", async (c) => {
    const a = auth(c);
    const q = c.req.query();
    const src = await ticketSource();
    const [all, o, technicians, meId] = await run(() => Promise.all([src.list(), src.options(), src.technicians(), src.meId(a)]));
    // Client filter: only the clients that have tickets (the full list is /companies)
    const companies = [...new Map(all.map((t) => [t.company.id, t.company])).values()].sort((x, y) => x.name.localeCompare(y.name));
    const L = lookup(o);
    const starts = await startDates(all.map((t) => t.id));
    const eod = endOfToday();
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    const isOverdue = (t: NTicket) => new Date(t.dueAt).getTime() < Date.now();
    // The weekly meeting gauge: not overdue yet, due by the end of this Friday (Québec)
    const friday = fridayEnd(new Date()).getTime();
    const isDueThisWeek = (t: NTicket) => !isOverdue(t) && new Date(t.dueAt).getTime() <= friday;
    const isDueToday = (t: NTicket) => {
      const d = new Date(t.dueAt).getTime();
      return d >= Date.now() && d <= eod;
    };
    const isCritical = (t: NTicket) => L.priorityKind(t.priority) === "critical";
    /** Needs attention: open and overdue, due today or critical */
    const attention = (t: NTicket) => open(t) && (isOverdue(t) || isDueToday(t) || isCritical(t));

    const isMine = (t: NTicket) => Boolean(meId) && (t.assignee?.id === meId || t.secondary.some((p) => p.id === meId));
    // monitoring alerts (the alerts queue, alert emails) are not tickets to pick up: not in "unassigned"
    const alert = isAlert(L);
    /** Open, nobody on it, not a monitoring alert */
    const toPickUp = (t: NTicket) => !t.assignee && open(t) && !alert(t);
    /** New: in a "new" status and nobody on it, not a monitoring alert */
    const fresh = (t: NTicket) => toPickUp(t) && L.statusKind(t.status) === "new";
    const views = {
      // Mine: assigned to me, or I am one of the secondary technicians
      mine: (t: NTicket) => isMine(t) && open(t),
      unassigned: toPickUp,
      due: (t: NTicket) => open(t) && new Date(t.dueAt).getTime() <= eod,
      all: (_t: NTicket) => true,
    };
    const inRange = (v: string | undefined, from?: string, to?: string) =>
      (!from && !to) || (v !== undefined && (!from || v.slice(0, 10) >= from) && (!to || v.slice(0, 10) <= to));
    /** The tickets a set of list parameters selects (the list, and the saved filters' buttons). */
    const select = (q: Record<string, string | undefined>) => {
      const view = ((q.view ?? "") in views ? q.view : "mine") as keyof typeof views;
      const status = list(q.status);
      const statusKinds = list(q.statusKind);
      const priority = list(q.priority);
      const queue = list(q.queue);
      const company = list(q.company).map(Number);
      const assignee = list(q.assignee);
      const text = (q.q ?? "").trim().toLowerCase();
      return all
      .filter(views[view])
      // Completed tickets only when asked for (status filter) or in "all"
      .filter((t) => (status.length || statusKinds.length ? true : view === "all" || open(t)))
      .filter((t) => !status.length || status.includes(t.status))
      .filter((t) => !statusKinds.length || statusKinds.includes(L.statusKind(t.status)))
      .filter((t) => !priority.length || priority.includes(t.priority))
      .filter((t) => !queue.length || queue.includes(t.queue))
      .filter((t) => !company.length || company.includes(t.company.id))
      .filter((t) => !assignee.length || assignee.includes(t.assignee?.id ?? "none"))
      .filter((t) => !text || `${t.number} ${t.title} ${t.company.name} ${t.contact}`.toLowerCase().includes(text))
      .filter((t) => inRange(t.dueAt, q.dueFrom, q.dueTo))
      // Tiles: "due=overdue|today" (to the minute) and "created=today"
      .filter((t) => (q.due === "overdue" ? isOverdue(t) : q.due === "today" ? isDueToday(t) : q.due === "week" ? isDueThisWeek(t) : true))
      .filter((t) => q.created !== "today" || new Date(t.createdAt).toDateString() === new Date().toDateString())
      .filter((t) => q.attention !== "1" || attention(t))
      // Weekly meeting: "alerts=0" leaves monitoring alerts out, "alerts=1" keeps only them
      .filter((t) => (q.alerts === "0" ? !alert(t) : q.alerts === "1" ? alert(t) : true))
      // Portal-only filter: Autotask has no start date
      .filter((t) => inRange(starts.get(t.id), q.startFrom, q.startTo));
    };
    const items = select(q).map((t) => summary(t, L, starts.get(t.id), a.user.id, starts.locked.has(t.id), starts.times.get(t.id)));
    // the saved filters shown as buttons, with their counts
    const pinnedFilters = await db()
      .select({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query })
      .from(schema.ticketFilters)
      .where(and(eq(schema.ticketFilters.userId, a.user.id), eq(schema.ticketFilters.pinned, true)))
      .orderBy(asc(schema.ticketFilters.createdAt));
    /** What a tile counts, by category (shown when the pointer rests on it): most first */
    // label: the source's own (Autotask), kind: for the portal's wording when there is none
    const tally = (list: NTicket[], key: (t: NTicket) => { label: string | null; kind?: string }) => {
      const m = new Map<string, { label: string | null; kind?: string; count: number }>();
      for (const x of list) {
        const k = key(x);
        const id = `${k.kind ?? ""}|${k.label ?? ""}`;
        const v = m.get(id) ?? { ...k, count: 0 };
        v.count++;
        m.set(id, v);
      }
      return [...m.values()].sort((x, y) => y.count - x.count || (x.label ?? x.kind ?? "").localeCompare(y.label ?? y.kind ?? ""));
    };
    const byStatus = (list: NTicket[]) => tally(list, (x) => ({ label: L.statusLabel(x.status), kind: L.statusKind(x.status) }));
    const buttons = pinnedFilters.map((f) => {
      const found = select(Object.fromEntries(new URLSearchParams(f.query)));
      return { ...f, count: found.length, breakdown: byStatus(found) };
    });
    // My priorities (given by an admin), not done: marked in the list
    const mine = await db()
      .select({ ticketId: schema.ticketPins.ticketId, horizon: schema.ticketPins.horizon })
      .from(schema.ticketPins)
      .where(and(eq(schema.ticketPins.technicianId, a.user.id), isNull(schema.ticketPins.doneAt)));
    for (const it of items as (ReturnType<typeof summary> & { myPriority?: "day" | "week" })[]) {
      const p = mine.find((x) => x.ticketId === it.id);
      if (p) it.myPriority = p.horizon;
    }

    const sort = q.sort ?? "due";
    // the order the AI planned (the last plan applied): its tickets in that order, the others after, by due date
    const aiRows = await db().select().from(schema.ticketAiPlan).where(eq(schema.ticketAiPlan.userId, a.user.id));
    const aiPos = new Map(aiRows.map((r) => [r.ticketId, r.position]));
    const aiPlannedAt = aiRows[0]?.plannedAt ?? null;
    // "my priorities first": those of the day, then of the week, then by due date (the default is the due date only)
    const rankOf = (x: object) => {
      const p = (x as { myPriority?: "day" | "week" }).myPriority;
      return sort === "priorities" ? (p === "day" ? 0 : p === "week" ? 1 : 2) : 2;
    };
    items.sort((x, y) =>
      rankOf(x) - rankOf(y) ||
      (sort === "ai"
        ? (aiPos.get(x.id) ?? 1e9) - (aiPos.get(y.id) ?? 1e9) || x.dueAt.localeCompare(y.dueAt)
        : sort === "priority"
        ? PRIORITY_ORDER[x.priorityKind] - PRIORITY_ORDER[y.priorityKind] || x.dueAt.localeCompare(y.dueAt)
        : sort === "updated"
          ? y.updatedAt.localeCompare(x.updatedAt)
          : sort === "start"
            ? (x.startDate ?? "9999").localeCompare(y.startDate ?? "9999") || x.dueAt.localeCompare(y.dueAt)
            : // default: due date, then start date
              x.dueAt.localeCompare(y.dueAt) || (x.startDate ?? "9999").localeCompare(y.startDate ?? "9999")),
    );

    // Key figures for the tiles (whole set, not the current filters)
    const needs = all.filter(attention);
    const metrics = {
      mine: all.filter(views.mine).length,
      unassigned: all.filter(views.unassigned).length,
      /** New tickets nobody has taken */
      fresh: all.filter(fresh).length,
      attention: needs.length,
      /** Tickets in a "Needs attention" status (e.g. the client replied) */
      statusAttention: all.filter((t) => open(t) && L.statusKind(t.status) === "needsAttention").length,
      attentionBreakdown: {
        overdue: needs.filter(isOverdue).length,
        dueToday: needs.filter(isDueToday).length,
        critical: needs.filter(isCritical).length,
      },
      /** Per tile, by category: mine by status, unassigned by priority, "needs attention" by technician */
      breakdown: {
        mine: byStatus(all.filter(views.mine)),
        unassigned: tally(all.filter(views.unassigned), (x) => ({ label: L.priorityLabel(x.priority), kind: L.priorityKind(x.priority) })),
        fresh: tally(all.filter(fresh), (x) => ({ label: L.priorityLabel(x.priority), kind: L.priorityKind(x.priority) })),
        statusAttention: tally(
          all.filter((x) => open(x) && L.statusKind(x.status) === "needsAttention"),
          (x) => ({ label: x.assignee?.name ?? null }),
        ),
      },
    };

    // Team: linked technicians first, plus anyone who has open tickets
    const openBy = new Map<string, number>();
    for (const t of all) if (open(t) && t.assignee) openBy.set(t.assignee.id, (openBy.get(t.assignee.id) ?? 0) + 1);
    const team = technicians
      .filter((p) => src.demo || !p.id.startsWith("at-") || openBy.has(p.id))
      .map((p) => ({ ...p, open: openBy.get(p.id) ?? 0 }));

    const ai = a.permissions.includes("tickets.ai") ? await aiSettings() : null;
    return c.json({
      demo: src.demo,
      /** Autotask mode and my account is not linked to an Autotask user */
      ai: Boolean(ai?.enabled && ai.apiKey),
      metrics,
      buttons,
      /** The last AI plan applied by this technician (for the sort "Planifié par l'IA") */
      aiPlan: aiPlannedAt ? { at: aiPlannedAt, count: aiRows.length } : null,
      items,
      counts: Object.fromEntries(Object.entries(views).map(([k, f]) => [k, all.filter(f).filter((t) => k === "all" || open(t)).length])),
      facets: { queues: o.queues, sources: o.ticketSources ?? [], companies, statuses: o.statuses, priorities: o.priorities, technicians: team },
    });
  })

  /**
   * AI: a text written in the portal (note, time entry, ticket, email, message…)
   * corrected — spelling, grammar, structure — in French by default, or English.
   * Meaning, facts, names and numbers are kept; nothing is added.
   */
  .post("/ai/polish", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        text: z.string().trim().min(1).max(20_000),
        format: z.enum(["text", "html"]).default("text"),
        lang: z.enum(["fr", "en"]).default("fr"),
      }),
    );
    if (!rateLimit(`ai-polish:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const language = p.lang === "en" ? "anglais (canadien)" : "français (québécois standard, registre professionnel)";
    const system = [
      "Tu es le correcteur d'une entreprise de services informatiques (AKAB Informatique, au Québec).",
      `Corrige et améliore le texte fourni en ${language} : orthographe, grammaire, ponctuation, accords, tournures.`,
      "Améliore la structure quand c'est utile : phrases claires, paragraphes courts, listes à puces pour des étapes ou des éléments.",
      "Garde exactement le sens, les faits, les noms, les numéros, les montants, les dates et les termes techniques. N'invente rien, n'ajoute ni formule ni signature.",
      "Si le texte est dans une autre langue, traduis-le dans la langue demandée.",
      p.format === "html"
        ? "Le texte est du HTML simple (p, br, b, i, u, ul, ol, li, a). Réponds avec du HTML simple du même genre, sans balise html/body, sans style."
        : "Réponds en texte brut (sauts de ligne permis, tirets pour les listes), sans Markdown, sans guillemets autour.",
      "Réponds uniquement avec le texte corrigé, rien d'autre.",
    ].join("\n");
    try {
      let out = await askClaude({ system, prompt: p.text, feature: "text.polish", userId: a.user.id, maxTokens: 8000 });
      out = out.replace(/^```(?:html|text)?\s*/i, "").replace(/\s*```$/, "").trim();
      if (!out) throw new AiError("bad_output");
      return c.json({ text: p.format === "html" ? sanitizeMailHtml(out) : out });
    } catch (e) {
      throw aiHttpError(e);
    }
  })

  // ── AI: plan my open tickets (order + suggested start dates) ──
  /** For the AI buttons: the model of each part, whether another may be picked, and today's spending. */
  .get("/ai/options", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    const s = await aiSettings();
    return c.json({
      models: AI_MODELS,
      allowChoice: s.allowChoice,
      features: Object.fromEntries(AI_FEATURE_KEYS.map((k) => [k, modelFor(s, k)])),
      today: await todayOf(s, a.user.id),
    });
  })

  .post("/ai/plan", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const model = await askedModel(c);
    const src = await ticketSource();
    const [all, o, meId] = await run(() => Promise.all([src.list(), src.options(), src.meId(a)]));
    const L = lookup(o);
    const mine = all.filter((x) => meId && (x.assignee?.id === meId || x.secondary.some((p) => p.id === meId)) && L.statusKind(x.status) !== "complete");
    if (!mine.length) return c.json({ overview: "", items: [] });
    const starts = await startDates(mine.map((x) => x.id));
    const today = new Date().toISOString().slice(0, 10);
    const lines = mine.map(
      (x) =>
        `- id ${x.id} · ${x.number} · « ${x.title} » · client ${x.company.name} · priorité ${L.priorityLabel(x.priority) ?? L.priorityKind(x.priority)} · statut ${L.statusLabel(x.status) ?? L.statusKind(x.status)} · échéance ${x.dueAt.slice(0, 16)} · début prévu ${starts.get(x.id) ?? "aucun"}`,
    );
    try {
      const out = await askClaudeJson<unknown>({
        system: `${aiRole(a.user.locale)} Tu aides un technicien à planifier ses billets. Aujourd'hui : ${today}, journée de travail 8 h à 17 h, lundi au vendredi.`,
        feature: "tickets.plan",
        userId: a.user.id,
        model,
        prompt: `Voici mes billets ouverts :\n${lines.join("\n")}\n\nPropose un ordre de traitement et une date de début (AAAA-MM-JJ, au plus tôt aujourd'hui, jours ouvrables) pour chacun, en tenant compte des échéances, des priorités et d'une charge réaliste (environ 4 à 6 billets par jour). Format : {"overview": "2 ou 3 phrases", "items": [{"id": nombre, "order": nombre, "startDate": "AAAA-MM-JJ", "reason": "courte justification"}]}`,
        maxTokens: 6000,
      });
      const parsed = zPlan.safeParse(out);
      if (!parsed.success) throw new AiError("bad_output");
      const byId = new Map(mine.map((x) => [x.id, x]));
      const items = parsed.data.items
        .filter((i) => byId.has(i.id))
        .map((i) => ({ ...i, startDate: i.startDate < today ? today : i.startDate, number: byId.get(i.id)!.number, title: byId.get(i.id)!.title }))
        .sort((x, y) => x.order - y.order);
      await audit(a.user.id, "ai.tickets_plan", null, { tickets: mine.length });
      return c.json({ overview: parsed.data.overview, items });
    } catch (e) {
      throw aiHttpError(e);
    }
  })

  /** Several start dates at once (e.g. from the AI plan). */
  .post("/start-dates", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ items: z.array(z.object({ id: z.number().int().positive(), startDate: zDate.nullable() })).max(200), plan: z.boolean().optional() }));
    // the AI plan applied: its order is kept for the sort "Planifié par l'IA" (a new plan replaces the last one)
    if (p.plan) {
      const now = new Date();
      await db().transaction(async (tx) => {
        await tx.delete(schema.ticketAiPlan).where(eq(schema.ticketAiPlan.userId, a.user.id));
        if (p.items.length) await tx.insert(schema.ticketAiPlan).values(p.items.map((it, position) => ({ userId: a.user.id, ticketId: it.id, position, plannedAt: now })));
      });
      await audit(a.user.id, "ai.plan_applied", null, { tickets: p.items.length });
    }
    for (const it of p.items) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId: it.id, startDate: it.startDate, updatedBy: a.user.id })
        .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { startDate: it.startDate, updatedBy: a.user.id, updatedAt: new Date() } });
    }
    return c.json({ ok: true });
  })

  // ── Clients and their contacts ──
  .get("/companies", async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.companies()));
  })
  /** A new client, when the ticket is for someone not yet in the portal. */
  .post("/companies", requirePermission("tickets.clients"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().min(7).max(40) }));
    const src = await ticketSource();
    const same = (await run(() => src.companies())).find((x) => x.name.trim().toLowerCase() === p.name.toLowerCase());
    if (same) throw new HTTPException(409, { message: "company_exists" });
    const company = await run(() => src.addCompany(p, a));
    await rememberCompany({ ...company, phone: p.phone });
    await audit(a.user.id, "ticket.company_created", String(company.id), { name: company.name });
    return c.json(company, 201);
  })
  .get("/companies/:cid/contracts", async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.contracts(Number(c.req.param("cid")))));
  })
  .get("/companies/:cid/contacts", async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.contacts(Number(c.req.param("cid")))));
  })
  .post("/companies/:cid/contacts", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const companyId = Number(c.req.param("cid"));
    const p = await body(
      c,
      z.object({
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        email: z.union([zEmail, z.literal("")]).optional(),
        phone: z.string().trim().max(40).optional(),
      }),
    );
    const src = await ticketSource();
    const contact = await run(() => src.addContact(companyId, { firstName: p.firstName, lastName: p.lastName, email: p.email || null, phone: p.phone || null }, a));
    await rememberContact(companyId, { id: contact.id, firstName: p.firstName, lastName: p.lastName, email: contact.email, phone: contact.phone });
    await audit(a.user.id, "ticket.contact_created", contact.id, { companyId });
    return c.json(contact, 201);
  })

  // ── Saved filters (per technician) ──
  .get("/filters", async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query, pinned: schema.ticketFilters.pinned })
      .from(schema.ticketFilters)
      .where(eq(schema.ticketFilters.userId, a.user.id))
      .orderBy(asc(schema.ticketFilters.name));
    return c.json(rows);
  })
  /** Show a saved filter as a button above the list (or not). */
  .patch("/filters/:fid", async (c) => {
    const a = auth(c);
    const fid = z.uuid().parse(c.req.param("fid"));
    const p = await body(c, z.object({ pinned: z.boolean().optional(), name: z.string().trim().min(1).max(60).optional() }));
    const [row] = await db()
      .update(schema.ticketFilters)
      .set(p)
      .where(and(eq(schema.ticketFilters.id, fid), eq(schema.ticketFilters.userId, a.user.id)))
      .returning({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query, pinned: schema.ticketFilters.pinned });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    return c.json(row);
  })
  .post("/filters", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(60), query: z.string().max(1000), pinned: z.boolean().default(false) }));
    // Keep only known list parameters
    const src = new URLSearchParams(p.query);
    const clean = new URLSearchParams();
    for (const k of FILTER_PARAMS) {
      const v = src.get(k);
      if (v) clean.set(k, v.slice(0, 300));
    }
    const count = await db().select({ id: schema.ticketFilters.id }).from(schema.ticketFilters).where(eq(schema.ticketFilters.userId, a.user.id));
    if (count.length >= 30) throw new HTTPException(409, { message: "too_many_filters" });
    const [row] = await db()
      .insert(schema.ticketFilters)
      .values({ userId: a.user.id, name: p.name, query: clean.toString(), pinned: p.pinned })
      .returning({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query, pinned: schema.ticketFilters.pinned });
    return c.json(row, 201);
  })
  .delete("/filters/:fid", async (c) => {
    const a = auth(c);
    const fid = z.uuid().parse(c.req.param("fid"));
    await db().delete(schema.ticketFilters).where(and(eq(schema.ticketFilters.id, fid), eq(schema.ticketFilters.userId, a.user.id)));
    return c.json({ ok: true });
  })

  /**
   * Search every ticket (all views, all technicians, recently completed) in the
   * local copy: number, title, client, contact, description. With deep=1 (or an
   * exact ticket number not found), older tickets are asked to Autotask.
   */
  .get("/search", async (c) => {
    const a = auth(c);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return c.json({ items: [], total: 0, archive: [] });
    const src = await ticketSource();
    const [all, o] = await run(() => Promise.all([src.list(), src.options()]));
    const words = fold(q).split(/\s+/).filter(Boolean);
    const scored = all
      .map((t) => {
        const num = fold(t.number);
        const title = fold(t.title);
        const hay = `${num} ${title} ${fold(t.company.name)} ${fold(t.contact)} ${fold(t.description)}`;
        if (!words.every((w) => hay.includes(w))) return null;
        const score = (num === fold(q) ? 100 : num.includes(fold(q)) ? 50 : 0) + words.filter((w) => title.includes(w)).length * 10 + (L_OPEN(o, t) ? 5 : 0);
        return { t, score };
      })
      .filter((x): x is { t: NTicket; score: number } => Boolean(x))
      .sort((x, y) => y.score - x.score || y.t.updatedAt.localeCompare(x.t.updatedAt));
    const L = lookup(o);
    const top = scored.slice(0, 20).map((x) => x.t);
    const starts = await startDates(top.map((t) => t.id));
    let archive: ReturnType<typeof summary>[] = [];
    const exactNumber = /^T\d{8}\.\d{3,5}$/i.test(q) && !scored.length;
    if (!src.demo && (c.req.query("deep") === "1" || exactNumber)) {
      if (!rateLimit(`ticket-search:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
      const known = new Set(all.map((t) => t.id));
      const older = await run(() => src.searchArchive(q));
      archive = older.filter((t) => !known.has(t.id)).map((t) => summary(t, L, undefined, a.user.id));
    }
    return c.json({ items: top.map((t) => summary(t, L, starts.get(t.id), a.user.id, starts.locked.has(t.id), starts.times.get(t.id))), total: scored.length, archive });
  })

  /** A client's devices, with RMM links. */
  .get("/companies/:cid/assets", async (c) => {
    const cid = Number(c.req.param("cid"));
    if (!Number.isInteger(cid)) throw new HTTPException(400, { message: "invalid_id" });
    const src = await ticketSource();
    const [list, r] = await Promise.all([run(() => src.assets(cid)), rmmSettings()]);
    return c.json(list.map((x) => assetView(x, r)));
  })

  /** A contact's open tickets (the last five, newest first), for the ticket view; `exclude` leaves out the ticket being viewed. */
  .get("/contacts/:contactId/open", async (c) => {
    const contactId = c.req.param("contactId");
    const exclude = Number(c.req.query("exclude"));
    const src = await ticketSource();
    const [all, o] = await run(() => Promise.all([src.list(), src.options()]));
    const L = lookup(o);
    const mine = all.filter((t) => t.contactId === contactId && L.statusKind(t.status) !== "complete" && t.id !== exclude).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return c.json({
      total: mine.length,
      items: mine.slice(0, 5).map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        statusLabel: L.statusLabel(t.status),
        statusKind: L.statusKind(t.status),
        priorityKind: L.priorityKind(t.priority),
        dueAt: t.dueAt,
        createdAt: t.createdAt,
      })),
    });
  })

  /** A device made in the portal, for a client the RMM does not know. */
  .post("/companies/:cid/assets", requirePermission("tickets.edit"), async (c) => {
    const cid = Number(c.req.param("cid"));
    if (!Number.isInteger(cid)) throw new HTTPException(400, { message: "invalid_id" });
    const opt = z.string().trim().max(120).nullish().transform((v) => v || null);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        type: opt,
        hostname: opt,
        serial: opt,
        ip: opt,
        os: opt,
        contactId: z.string().max(60).nullish(),
        contactName: opt,
        notes: z.string().trim().max(2000).nullish(),
      }),
    );
    const [row] = await db()
      .insert(schema.localAssets)
      .values({ ...p, companyId: cid, contactId: p.contactId ?? null, notes: p.notes || null, createdBy: auth(c).user.id })
      .returning();
    await audit(auth(c).user.id, "ticket.asset_created", row!.id, { companyId: cid, name: p.name });
    const [list, r] = await Promise.all([localAssets(cid), rmmSettings()]);
    return c.json(assetView(list.find((x) => x.id === "local:" + row!.id)!, r), 201);
  })

  // ── Timers (work time → time entries) ──
  /** My timers: running / paused / waiting for validation (closed tab). */
  .get("/timers", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    await sweepTimers(a.user.id);
    return c.json((await myTimers(a.user.id)).map(timerView));
  })
  /** Work types offered for time entries (empty when the source has none). */
  /** Catalogue products to charge (search: 2 characters or more). */
  .get("/products", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const q = (c.req.query("q") ?? "").trim().slice(0, 60);
    if (q.length < 2) return c.json([]);
    if (!rateLimit(`products:${a.user.id}`, 60, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const src = await ticketSource();
    return c.json(await run(() => src.products(q)));
  })
  /** Portal inventory products to charge on a ticket (name, SKU, manufacturer, category). */
  .get("/store-products", requirePermission("tickets.edit"), async (c) => c.json(await searchProducts((c.req.query("q") ?? "").slice(0, 60))))
  /** Serial numbers of a product in stock at a location (to pick for a charge). */
  .get("/store-products/:pid/serials", requirePermission("tickets.edit"), async (c) => {
    const pid = z.uuid().parse(c.req.param("pid"));
    const locationId = z.uuid().parse(c.req.query("locationId"));
    return c.json((await serialsOf(pid, { locationId, inStock: true })).map(({ id, serial }) => ({ id, serial })));
  })
  /** Add a product to the portal inventory from a ticket, when it does not exist yet. */
  .post("/store-products", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        sku: z.string().trim().max(60).nullable().default(null),
        manufacturer: z.string().trim().max(120).nullable().default(null),
        priceCents: z.number().int().min(0).max(100_000_000),
        costCents: z.number().int().min(0).max(100_000_000).default(0),
      }),
    );
    const sku = p.sku || null;
    if (sku) {
      const [dup] = await db().select({ id: schema.storeProducts.id }).from(schema.storeProducts).where(eq(schema.storeProducts.sku, sku));
      if (dup) throw new HTTPException(409, { message: "sku_taken" });
    }
    const [row] = await db()
      .insert(schema.storeProducts)
      .values({ name: p.name, sku, manufacturer: p.manufacturer || null, priceCents: p.priceCents, costCents: p.costCents })
      .returning({ id: schema.storeProducts.id });
    await audit(a.user.id, "store.product_created", row.id, { name: p.name, sku, from: "ticket" });
    return c.json((await searchProducts(p.name)).find((x) => x.id === row.id), 201);
  })
  /** Choices for a new charge: types, statuses, material codes. */
  .get("/charge-options", requirePermission("tickets.edit"), async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.chargeOptions()));
  })
  .get("/work-types", requirePermission("tickets.edit"), async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.workTypes()));
  })
  /** The page is alive: keeps my running timers going. */
  .post("/timers/beat", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    await db()
      .update(schema.ticketTimers)
      .set({ lastBeatAt: new Date() })
      .where(and(eq(schema.ticketTimers.userId, a.user.id), eq(schema.ticketTimers.state, "running")));
    return c.json((await myTimers(a.user.id)).map(timerView));
  })
  /** Validate a timer: becomes a time entry. */
  .post("/timers/:timerId/submit", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const timer = await ownTimer(c.req.param("timerId"), a.user.id);
    const p = await body(
      c,
      z.object({
        hours: z.number().positive().max(24),
        summary: z.string().trim().min(1).max(8000),
        internal: z.string().trim().max(8000).default(""),
        workTypeId: z.string().max(40).nullable().default(null),
        billable: z.boolean().default(true),
        offsetHours: z.number().min(0).max(24).default(0),
        // the contract the time is logged on (none: the ticket's contract)
        contractId: z.uuid().nullable().optional(),
        // banked instead of paid (none: the technician's profile says)
        banked: z.boolean().optional(),
        // the description sent by email: to the ticket contact, and to other addresses
        notify: z
          .object({ contact: z.boolean().default(false), others: z.array(zEmail).max(10).default([]) })
          .default({ contact: false, others: [] }),
      }),
    );
    // the contract: the one picked, else the ticket's; only a contract that does not bill hours makes the time non billable
    const tkForContract = await (await ticketSource()).get(timer.ticketId).catch(() => null);
    let contract: ContractView | null = null;
    if (tkForContract) {
      const cs = await contractOfTicket(timer.ticketId, tkForContract.company.id);
      contract = p.contractId ? (cs.contracts.find((k) => k.id === p.contractId) ?? null) : cs.contract;
      if (p.contractId && !contract) throw new HTTPException(400, { message: "invalid_contract" });
    }
    if (contract && !contract.billed) p.billable = false;
    // the offset cannot exceed the hours worked; it means nothing when nothing is billed
    if (p.offsetHours > p.hours) throw new HTTPException(400, { message: "offset_too_large" });
    if (!p.billable) p.offsetHours = 0;
    if (submitting.has(timer.id)) throw new HTTPException(409, { message: "timer_busy" });
    submitting.add(timer.id);
    try {
    const endedAt = timer.endedAt ?? new Date();
    const src = await ticketSource();
    await run(() => src.addTimeEntry(timer.ticketId, { ...p, contractSourceId: contract?.sourceId ?? null, startedAt: new Date(endedAt.getTime() - p.hours * 3_600_000), endedAt }, a));
    // on the technician's timesheet too, with the ticket
    const tk = await src.get(timer.ticketId).catch(() => null);
    await addTicketTime(a.realUser.id, {
      ticketId: timer.ticketId,
      ticketNumber: tk?.number ?? null,
      ticketTitle: tk?.title ?? null,
      hours: p.hours,
      date: endedAt.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
      note: p.summary,
      contractId: contract?.id ?? null,
      // what counts as billable time in the timesheet stats: worked minus the offset, nothing when not billed
      billableHours: p.billable ? Math.max(0, p.hours - p.offsetHours) : 0,
      banked: p.banked,
    });
    await db().delete(schema.ticketTimers).where(eq(schema.ticketTimers.id, timer.id));
    const notified = await notifyWork(src, tk, p.summary, p.notify, a);
    await audit(a.user.id, "ticket.time_entry", String(timer.ticketId), { hours: p.hours, billable: p.billable, contract: contract?.name ?? null, offsetHours: p.offsetHours, ...(notified.to.length ? { notified: notified.to } : {}) });
    return c.json({ ok: true, notified: notified.to.length, notifyFailed: notified.failed, noContactEmail: notified.noContactEmail, notifiedInPortal: notified.inPortal }, 201);
    } finally {
      submitting.delete(timer.id);
    }
  })
  /** "Later": a stopped timer goes back to paused; it resumes when the ticket is opened again. */
  .post("/timers/:timerId/later", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const timer = await ownTimer(c.req.param("timerId"), a.user.id);
    if (timer.state === "pending") {
      await db()
        .update(schema.ticketTimers)
        .set({ state: "paused", runningSince: null, endedAt: null, updatedAt: new Date() })
        .where(eq(schema.ticketTimers.id, timer.id));
    }
    return c.json((await myTimers(a.user.id)).map(timerView));
  })
  /** Discard a timer (no time entry). */
  .delete("/timers/:timerId", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const timer = await ownTimer(c.req.param("timerId"), a.user.id);
    await db().delete(schema.ticketTimers).where(eq(schema.ticketTimers.id, timer.id));
    return c.json({ ok: true });
  })
  /** Start (or resume) my timer on this ticket; my other running timers pause. */
  .post("/:id/timer/start", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const until = await notStartedYet(id);
    if (until) throw new HTTPException(409, { message: "ticket_not_started", cause: [{ path: "startDate", message: until }] });
    const now = new Date();
    // several timers may run at once (tickets minimized keep going)
    const mine = await myTimers(a.user.id);
    const existing = mine.find((x) => x.ticketId === id);
    if (existing?.state === "pending") throw new HTTPException(409, { message: "timer_pending" });
    if (existing) {
      if (existing.state !== "running") {
        await db()
          .update(schema.ticketTimers)
          .set({ state: "running", runningSince: now, lastBeatAt: now, updatedAt: now })
          .where(eq(schema.ticketTimers.id, existing.id));
      }
    } else {
      const src = await ticketSource();
      const tk = (await run(() => src.list())).find((x) => x.id === id) ?? (await run(() => src.get(id)));
      if (!tk) throw new HTTPException(404, { message: "not_found" });
      await db()
        .insert(schema.ticketTimers)
        .values({ userId: a.user.id, ticketId: id, ticketNumber: tk.number, ticketTitle: tk.title.slice(0, 250), state: "running", runningSince: now, lastBeatAt: now, startedAt: now });
    }
    return c.json((await myTimers(a.user.id)).map(timerView));
  })
  .post("/:id/timer/pause", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const t = (await myTimers(a.user.id)).find((x) => x.ticketId === id && x.state === "running");
    if (t) {
      const now = new Date();
      await db()
        .update(schema.ticketTimers)
        .set({ state: "paused", accumulatedMs: elapsedMs(t, now.getTime()), runningSince: null, updatedAt: now })
        .where(eq(schema.ticketTimers.id, t.id));
    }
    return c.json((await myTimers(a.user.id)).map(timerView));
  })
  /** Stop: the timer waits for its time entry (summary, hours) to be validated. */
  .post("/:id/timer/stop", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const t = (await myTimers(a.user.id)).find((x) => x.ticketId === id && x.state !== "pending");
    if (!t) throw new HTTPException(404, { message: "not_found" });
    const now = new Date();
    await db()
      .update(schema.ticketTimers)
      .set({ state: "pending", accumulatedMs: elapsedMs(t, now.getTime()), runningSince: null, endedAt: now, updatedAt: now })
      .where(eq(schema.ticketTimers.id, t.id));
    return c.json((await myTimers(a.user.id)).map(timerView));
  })

  .get("/:id", async (c) => {
    const a = auth(c);
    const src = await ticketSource();
    return c.json(await run(() => detailOf(src, Number(c.req.param("id")), a)));
  })

  // ── AI on one ticket ──
  /** Saved AI analyses (portal only), newest first. */
  .get("/:id/ai", async (c) => {
    const id = Number(c.req.param("id"));
    const rows = await db()
      .select({ id: schema.ticketAiNotes.id, content: schema.ticketAiNotes.content, createdAt: schema.ticketAiNotes.createdAt, author: schema.users.name })
      .from(schema.ticketAiNotes)
      .leftJoin(schema.users, eq(schema.users.id, schema.ticketAiNotes.createdBy))
      .where(eq(schema.ticketAiNotes.ticketId, id))
      .orderBy(desc(schema.ticketAiNotes.createdAt))
      .limit(10);
    return c.json(rows);
  })

  .post("/:id/ai/analyze", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const model = await askedModel(c);
    const id = Number(c.req.param("id"));
    try {
      const tk = await ticketForAi(await ticketSource(), id);
      const out = await askClaudeJson<unknown>({
        system: `${aiRole(a.user.locale)} Tu analyses un billet de support pour le technicien.`,
        feature: "ticket.analyze",
        userId: a.user.id,
        model,
        prompt: `${tk}\n\nAnalyse ce billet. Format : {"summary": "résumé en 2 à 4 phrases", "nextSteps": ["étapes concrètes, dans l'ordre"], "risks": ["points d'attention, s'il y en a"], "questions": ["questions à poser au client, s'il en manque"], "suggestedPriority": "critical|high|medium|low"}`,
        maxTokens: 4000,
      });
      const parsed = zAnalysis.safeParse(out);
      if (!parsed.success) throw new AiError("bad_output");
      const [row] = await db().insert(schema.ticketAiNotes).values({ ticketId: id, kind: "analysis", content: parsed.data, createdBy: a.user.id }).returning();
      await audit(a.user.id, "ai.ticket_analyze", String(id));
      return c.json({ id: row.id, content: row.content, createdAt: row.createdAt, author: a.user.name }, 201);
    } catch (e) {
      throw aiHttpError(e);
    }
  })

  /**
   * The AI estimates the time to resolve, only for a quick action (a few hours
   * at most); anything bigger or too vague stays empty (`minutes: null`).
   * A usable answer is saved on the ticket, marked as the AI's.
   */
  .post("/:id/ai/estimate", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const model = await askedModel(c);
    const id = Number(c.req.param("id"));
    try {
      const tk = await ticketForAi(await ticketSource(), id);
      const out = await askClaudeJson<unknown>({
        system: `${aiRole(a.user.locale)} Tu estimes le temps de travail d'un technicien.`,
        feature: "ticket.analyze",
        userId: a.user.id,
        model,
        prompt: `${tk}\n\nEstime le temps de travail nécessaire pour RÉSOUDRE ce billet. Ne donne une estimation que si l'action est rapide et claire (au plus 4 heures de travail) ; si le travail est grand, flou, dépend du client ou d'un fournisseur, ne donne rien. Format : {"quick": true|false, "minutes": nombre entier de minutes (multiple de 5) ou null, "reason": "une phrase"}`,
        maxTokens: 600,
      });
      const parsed = zEstimate.safeParse(out);
      if (!parsed.success) throw new AiError("bad_output");
      const { quick, minutes, reason } = parsed.data;
      await audit(a.user.id, "ai.ticket_estimate", String(id), { minutes: quick ? minutes : null });
      if (!quick || !minutes) return c.json({ minutes: null, reason });
      await saveEstimate(id, minutes, "ai", a.user.id);
      return c.json({ minutes, reason });
    } catch (e) {
      throw aiHttpError(e);
    }
  })

  /** Draft a reply to the client (not saved: it goes into the note box). */
  .post("/:id/ai/reply", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const model = await askedModel(c);
    try {
      const tk = await ticketForAi(await ticketSource(), Number(c.req.param("id")));
      const text = await askClaude({
        system: `${aiRole(a.user.locale)} Tu rédiges des réponses aux clients : courtoises, claires, sans jargon, sans promettre de délai précis.`,
        feature: "ticket.reply",
        userId: a.user.id,
        model,
        prompt: `${tk}\n\nRédige la prochaine réponse au client (texte seul, sans objet), signée « ${a.user.name.split(" ")[0]} – AKAB Informatique ».`,
        maxTokens: 2000,
      });
      await audit(a.user.id, "ai.ticket_reply", c.req.param("id"));
      return c.json({ text });
    } catch (e) {
      throw aiHttpError(e);
    }
  })

  /** Heartbeat while the ticket is open; returns the other people on it. */
  .post("/:id/presence", async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const m = presence.get(id) ?? new Map();
    m.set(a.realUser.id, { name: a.realUser.name, at: Date.now() });
    presence.set(id, m);
    return c.json({ viewers: viewersOf(id, a.realUser.id) });
  })

  .delete("/:id/presence", async (c) => {
    const a = auth(c);
    presence.get(Number(c.req.param("id")))?.delete(a.realUser.id);
    return c.json({ ok: true });
  })

  /** Change status, priority, queue, assignees, due date, client, contact, title or description. */
  .patch("/:id", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        status: z.string().max(40).optional(),
        priority: z.string().max(40).optional(),
        queue: z.string().max(120).optional(),
        companyId: z.number().int().optional(),
        contactId: z.string().max(60).nullable().optional(),
        assigneeId: z.string().max(60).nullable().optional(),
        dueDate: zDate.optional(),
        // an exact moment (date and time), within reason
        dueAt: z
          .string()
          .datetime({ offset: true })
          .refine((v) => {
            const y = new Date(v).getUTCFullYear();
            return y >= 2000 && y <= 2100;
          })
          .optional(),
        title: z.string().trim().min(1).max(250).optional(),
        description: z.string().max(8000).optional(),
        secondaryIds: z.array(z.string().max(60)).max(20).optional(),
        assetId: z.string().max(60).nullable().optional(),
        source: z.string().trim().max(40).optional(),
      }),
    );
    const src = await ticketSource();
    if (src.demo) {
      // sample data: values must be from the fixed lists
      const o = await src.options();
      if (p.status && !o.statuses.some((s) => s.value === p.status)) throw new HTTPException(400, { message: "Validation failed" });
      if (p.priority && !o.priorities.some((s) => s.value === p.priority)) throw new HTTPException(400, { message: "Validation failed" });
      if (p.queue && !o.queues.some((s) => s.value === p.queue)) throw new HTTPException(400, { message: "Validation failed" });
    }
    await run(() => src.update(id, p, a));
    await audit(a.user.id, "ticket.updated", String(id), { fields: Object.keys(p) });
    return c.json(await run(() => detailOf(src, id, a)));
  })

  /** Charges on the ticket (material, expenses…). */
  .get("/:id/charges", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const src = await ticketSource();
    return c.json(await run(() => src.charges(id)));
  })
  .post("/:id/charges", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        description: z.string().trim().max(2000).default(""),
        quantity: z.number().positive().max(100_000),
        unitPrice: z.number().min(0).max(1_000_000).nullable().default(null),
        unitCost: z.number().min(0).max(1_000_000).nullable().default(null),
        billable: z.boolean().default(true),
        typeId: z.string().max(20).nullable().default(null),
        statusId: z.string().max(20).nullable().default(null),
        materialCodeId: z.string().max(20).nullable().default(null),
        date: zDate.nullable().default(null),
        productId: z.string().max(20).nullable().default(null),
        /** Portal inventory product charged, and the location its units come out of (null: no stock taken) */
        storeProductId: zUuidOrNull,
        locationId: zUuidOrNull,
        /** Serialized product: the units taken */
        serialIds: z.array(z.uuid()).max(500).default([]),
      }),
    );
    const src = await ticketSource();
    const { storeProductId, locationId, serialIds, ...charge } = p;
    let taken: { movementId: string; serials: string[] } | null = null;
    if (storeProductId) {
      const [product] = await db().select().from(schema.storeProducts).where(eq(schema.storeProducts.id, storeProductId));
      if (!product || !product.active) throw new HTTPException(404, { message: "not_found" });
      charge.productId = null;
      if (locationId) {
        // Whole units only, never more than what is on hand
        if (!Number.isInteger(charge.quantity)) throw new HTTPException(400, { message: "Validation failed" });
        const number = (await run(() => src.list())).find((t) => t.id === id)?.number ?? null;
        try {
          taken = await takeForTicket({ productId: storeProductId, locationId, quantity: charge.quantity, serialIds, ticket: { id, number }, userId: a.user.id });
        } catch (e) {
          throw e instanceof StoreError ? storeHttp(e) : e;
        }
        // The serial numbers go on the charge too
        if (taken.serials.length) {
          const line = `N° de série : ${taken.serials.join(", ")}`;
          charge.description = (charge.description ? `${charge.description}\n${line}` : line).slice(0, 2000);
        }
      }
    } else if (locationId) {
      throw new HTTPException(400, { message: "Validation failed" });
    }
    try {
      await run(() => src.addCharge(id, charge, a));
    } catch (e) {
      // Not charged: the items go back in stock
      if (taken) await undoTake(taken.movementId);
      throw e;
    }
    await audit(a.user.id, "ticket.charge_added", String(id), { name: p.name, quantity: p.quantity, unitPrice: p.unitPrice, billable: p.billable, productId: p.productId });
    return c.json(await run(() => src.charges(id)), 201);
  })

  /** Reply to the client or internal note (the technician is the author). */
  .post("/:id/notes", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(8000), internal: z.boolean() }));
    const src = await ticketSource();
    await run(() => src.addNote(id, p, a));
    return c.json({ ok: true }, 201);
  })

  /**
   * Delete a ticket for good (tickets.delete: administrators): it leaves every
   * list, count and statistic, with its notes, time and charges. Only tickets the
   * portal owns (Admin › Billets); one still kept in Autotask is not touched.
   */
  .delete("/:id", requirePermission("tickets.delete"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    if (!(await ticketsLocal())) throw new HTTPException(409, { message: "tickets_not_local" });
    const gone = await run(() => deleteTicket(id, a));
    return c.json({ ok: true, ...gone });
  })

  /** A file attached to a ticket of the portal (always a download, never shown in the page) */
  .get("/:id/files/:fileId", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const f = await ticketFile(id, zUuid.parse(c.req.param("fileId")));
    if (!f?.data) throw new HTTPException(404, { message: "not_found" });
    return new Response(Buffer.from(f.data, "base64"), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  })

  /** Attach a file (one per request, base64). */
  .post("/:id/attachments", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().max(120).default("application/octet-stream"),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_TICKET_ATTACHMENT_BYTES / 3) * 4),
      }),
    );
    if (!p.data) throw new HTTPException(400, { message: "Validation failed" });
    const src = await ticketSource();
    await run(() => src.addAttachment(id, p, a));
    await audit(a.user.id, "ticket.attachment_added", String(id), { name: p.name, bytes: Math.floor((p.data.length * 3) / 4) });
    return c.json({ ok: true }, 201);
  })

  .put("/:id/start-date", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ startDate: zDate.nullable().optional(), startTime: zTime.nullable().optional(), startLocked: z.boolean().optional() }));
    const set = {
      ...(p.startDate !== undefined ? { startDate: p.startDate } : {}),
      // no day: no time either
      ...(p.startTime !== undefined ? { startTime: p.startTime } : p.startDate === null ? { startTime: null } : {}),
      ...(p.startLocked !== undefined ? { startLocked: p.startLocked } : {}),
    };
    const [row] = await db()
      .insert(schema.ticketMeta)
      .values({ ticketId: id, startDate: p.startDate ?? null, startTime: p.startDate ? (p.startTime ?? null) : null, startLocked: p.startLocked ?? false, updatedBy: a.user.id })
      .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { ...set, updatedBy: a.user.id, updatedAt: new Date() } })
      .returning();
    if (p.startLocked !== undefined) await audit(a.user.id, p.startLocked ? "ticket.start_locked" : "ticket.start_unlocked", String(id), { startDate: row.startDate });
    return c.json({ ok: true, startDate: row.startDate, startTime: row.startDate ? row.startTime : null, startLocked: Boolean(row.startDate && row.startLocked) });
  })

  /** The contract the ticket's work is billed on (null: back to the client's default support contract). */
  .put("/:id/contract", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ contractId: z.uuid().nullable() }));
    const src = await ticketSource();
    const t = await run(() => src.get(id));
    if (!t) throw new HTTPException(404, { message: "not_found" });
    if (p.contractId && !(await contractsOfCompany(t.company.id)).some((k) => k.id === p.contractId)) throw new HTTPException(400, { message: "invalid_contract" });
    await setTicketContract(id, p.contractId, a.user.id);
    await audit(a.user.id, "ticket.contract_set", String(id), { contractId: p.contractId });
    return c.json(await contractOfTicket(id, t.company.id));
  })

  /** The time the ticket should take to resolve (minutes; null clears it), typed by a technician. */
  .put("/:id/estimate", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ minutes: z.number().int().min(1).max(60 * 40).nullable() }));
    await saveEstimate(id, p.minutes, "tech", a.user.id);
    await audit(a.user.id, "ticket.estimate_set", String(id), { minutes: p.minutes });
    return c.json({ ok: true, estimate: p.minutes ? { minutes: p.minutes, source: "tech" } : null });
  })

  .post("/", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        title: z.string().trim().min(1).max(250),
        description: z.string().trim().max(8000).default(""),
        companyId: z.number().int(),
        contactId: z.string().max(60).nullable().optional(),
        priority: z.string().min(1).max(40),
        /** Not asked in the portal any more: Autotask's workflow rules route the ticket */
        queue: z.string().max(120).default(""),
        assigneeId: z.string().max(60).nullable(),
        dueDate: zDate,
        /** The exact due date and time (ISO); otherwise the due day at 17:00 */
        dueAt: z
          .string()
          .datetime({ offset: true })
          .refine((v) => {
            const y = new Date(v).getUTCFullYear();
            return y >= 2000 && y <= 2100;
          })
          .optional(),
        startDate: zDate.nullable().optional(),
        startTime: zTime.nullable().optional(),
        contractId: z.string().max(60).nullable().optional(),
        // where it comes from (ticket_sources.key): phone by default, email from an email, sms from a text
        source: z.string().trim().max(40).optional(),
      }),
    );
    const src = await ticketSource();
    const o = await run(() => src.options());
    if (!o.priorities.some((x) => x.value === p.priority)) throw new HTTPException(400, { message: "Validation failed" });
    if (p.queue && !o.queues.some((x) => x.value === p.queue)) throw new HTTPException(400, { message: "Validation failed" });
    if (p.contractId && !(await run(() => src.contracts(p.companyId))).some((x) => x.id === p.contractId)) throw new HTTPException(400, { message: "invalid_contract" });
    const id = await run(() => src.create({ ...p, contactId: p.contactId ?? null, contractId: p.contractId ?? null }, a));
    if (p.startDate) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId: id, startDate: p.startDate, startTime: p.startTime ?? null, updatedBy: a.user.id })
        // the row may already exist (the queue chosen for the ticket is stored in it)
        .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { startDate: p.startDate, startTime: p.startTime ?? null, updatedBy: a.user.id, updatedAt: new Date() } });
    }
    {
      const list = await contractsOfCompany(p.companyId);
      const mine = (p.contractId ? list.find((k) => k.sourceId === p.contractId) : undefined) ?? list.find((k) => k.isDefault);
      if (mine) await setTicketContract(id, mine.id, a.user.id);
    }
    await audit(a.user.id, "ticket.created", String(id));
    const t = await run(() => src.get(id));
    if (!t) return c.json({ id }, 201);
    return c.json(summary(t, lookup(o), p.startDate ?? undefined, a.user.id, false, p.startTime ?? undefined), 201);
  });
