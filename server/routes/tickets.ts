import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { body, zEmail } from "../lib/validate.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { AiError, aiSettings, askClaude, askClaudeJson } from "../lib/ai.ts";
import { AutotaskError } from "../lib/autotask.ts";
import { SourceError, ticketSource, type NTicket, type Options, type TicketSource } from "../lib/ticketSource.ts";

/**
 * Tickets (staff). Data come from the ticket source: Autotask when the
 * integration is enabled, sample tickets otherwise (see ticketSource.ts).
 * Writes go to Autotask on behalf of the technician. The start date, saved
 * filters, presence and AI analyses are portal-only.
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FILTER_PARAMS = ["view", "assignee", "q", "due", "created", "attention", "statusKind", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "sort"];
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

// ── Errors from the source (Autotask) → HTTP ──
function sourceError(e: unknown): HTTPException {
  if (e instanceof HTTPException) return e;
  if (e instanceof SourceError) {
    const status = e.code === "not_found" ? 404 : e.code === "not_linked" ? 409 : 400;
    return new HTTPException(status, { message: e.code === "not_linked" ? "autotask_not_linked" : e.code });
  }
  if (e instanceof AutotaskError) {
    const status = e.code === "not_configured" || e.code === "disabled" ? 409 : e.code === "rate_limit" ? 429 : 502;
    // Autotask's own message (e.g. a required field) helps the technician
    return new HTTPException(status, { message: `autotask_${e.code}`, cause: e.detail ? [{ path: "autotask", message: e.detail }] : undefined });
  }
  console.error("[tickets]", e);
  return new HTTPException(500, { message: "Internal error" });
}
async function run<T>(fn: () => Promise<T>): Promise<T> {
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
    const status = e.code === "not_configured" || e.code === "disabled" ? 409 : e.code === "rate_limit" ? 429 : 502;
    return new HTTPException(status, { message: `ai_${e.code}` });
  }
  return sourceError(e);
}
const aiLimit = (userId: string) => {
  if (!rateLimit(`ai:${userId}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
};

// ── Labels and kinds from the source's lists ──
type Lookup = ReturnType<typeof lookup>;
function lookup(o: Options) {
  const st = new Map(o.statuses.map((s) => [s.value, s]));
  const pr = new Map(o.priorities.map((s) => [s.value, s]));
  const qu = new Map(o.queues.map((s) => [s.value, s]));
  return {
    statusKind: (v: string) => st.get(v)?.kind ?? "other",
    statusLabel: (v: string) => st.get(v)?.label ?? null,
    priorityKind: (v: string) => pr.get(v)?.kind ?? "medium",
    priorityLabel: (v: string) => pr.get(v)?.label ?? null,
    queueLabel: (v: string) => qu.get(v)?.label ?? v,
  };
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
function viewersOf(ticketId: number, exceptUserId?: string) {
  const m = presence.get(ticketId);
  if (!m) return [];
  const now = Date.now();
  for (const [id, v] of m) if (now - v.at > PRESENCE_TTL) m.delete(id);
  return [...m].filter(([id]) => id !== exceptUserId).map(([userId, v]) => ({ userId, name: v.name }));
}

async function startDates(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db().select().from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, ids.slice(i, i + 500)));
    for (const r of rows) if (r.startDate) out.set(r.ticketId, r.startDate);
  }
  return out;
}

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

function summary(t: NTicket, L: Lookup, start: string | undefined, me: string) {
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
    assignee: t.assignee,
    secondary: t.secondary,
    /** First line of the description, for the list */
    excerpt: t.description.split("\n").find((l) => l.trim())?.slice(0, 180) ?? "",
    createdAt: t.createdAt,
    dueAt: t.dueAt,
    updatedAt: t.updatedAt,
    startDate: start ?? null,
    viewers: viewersOf(t.id, me),
  };
}

/** Full ticket for the ticket window, with the choices needed to edit it inline. */
async function detailOf(src: TicketSource, id: number, a: AuthContext) {
  const t = await src.get(id);
  if (!t) throw new HTTPException(404, { message: "not_found" });
  const [o, technicians, companies, start, ai] = await Promise.all([
    src.options(),
    src.technicians(),
    src.companies(),
    startDates([id]).then((m) => m.get(id)),
    a.permissions.includes("tickets.ai") ? aiSettings() : Promise.resolve(null),
  ]);
  return {
    ...summary(t, lookup(o), start, a.user.id),
    description: t.description,
    source: t.source,
    hours: t.hours,
    notes: t.notes,
    demo: src.demo,
    ai: Boolean(ai?.enabled && ai.apiKey),
    options: { statuses: o.statuses, priorities: o.priorities, queues: o.queues, technicians, companies },
  };
}

export const ticketRoutes = new Hono<AppEnv>()
  .use(requirePermission("tickets.view"))

  .get("/", async (c) => {
    const a = auth(c);
    const q = c.req.query();
    const src = await ticketSource();
    const [all, o, technicians, companies, meId] = await run(() => Promise.all([src.list(), src.options(), src.technicians(), src.companies(), src.meId(a)]));
    const L = lookup(o);
    const starts = await startDates(all.map((t) => t.id));
    const eod = endOfToday();
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    const isOverdue = (t: NTicket) => new Date(t.dueAt).getTime() < Date.now();
    const isDueToday = (t: NTicket) => {
      const d = new Date(t.dueAt).getTime();
      return d >= Date.now() && d <= eod;
    };
    const isCritical = (t: NTicket) => L.priorityKind(t.priority) === "critical";
    /** Needs attention: open and overdue, due today or critical */
    const attention = (t: NTicket) => open(t) && (isOverdue(t) || isDueToday(t) || isCritical(t));

    const isMine = (t: NTicket) => Boolean(meId) && (t.assignee?.id === meId || t.secondary.some((p) => p.id === meId));
    const views = {
      // Mine: assigned to me, or I am one of the secondary technicians
      mine: (t: NTicket) => isMine(t) && open(t),
      unassigned: (t: NTicket) => !t.assignee && open(t),
      due: (t: NTicket) => open(t) && new Date(t.dueAt).getTime() <= eod,
      all: (_t: NTicket) => true,
    };
    const view = (q.view in views ? q.view : "mine") as keyof typeof views;
    const status = list(q.status);
    const statusKinds = list(q.statusKind);
    const priority = list(q.priority);
    const queue = list(q.queue);
    const company = list(q.company).map(Number);
    const assignee = list(q.assignee);
    const text = (q.q ?? "").trim().toLowerCase();
    const inRange = (v: string | undefined, from?: string, to?: string) =>
      (!from && !to) || (v !== undefined && (!from || v.slice(0, 10) >= from) && (!to || v.slice(0, 10) <= to));

    const items = all
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
      .filter((t) => (q.due === "overdue" ? isOverdue(t) : q.due === "today" ? isDueToday(t) : true))
      .filter((t) => q.created !== "today" || new Date(t.createdAt).toDateString() === new Date().toDateString())
      .filter((t) => q.attention !== "1" || attention(t))
      // Portal-only filter: Autotask has no start date
      .filter((t) => inRange(starts.get(t.id), q.startFrom, q.startTo))
      .map((t) => summary(t, L, starts.get(t.id), a.user.id));

    const sort = q.sort ?? "due";
    items.sort((x, y) =>
      sort === "priority"
        ? PRIORITY_ORDER[x.priorityKind] - PRIORITY_ORDER[y.priorityKind] || x.dueAt.localeCompare(y.dueAt)
        : sort === "updated"
          ? y.updatedAt.localeCompare(x.updatedAt)
          : sort === "start"
            ? (x.startDate ?? "9999").localeCompare(y.startDate ?? "9999") || x.dueAt.localeCompare(y.dueAt)
            : // default: due date, then start date
              x.dueAt.localeCompare(y.dueAt) || (x.startDate ?? "9999").localeCompare(y.startDate ?? "9999"),
    );

    // Key figures for the tiles (whole set, not the current filters)
    const needs = all.filter(attention);
    const metrics = {
      mine: all.filter(views.mine).length,
      unassigned: all.filter(views.unassigned).length,
      attention: needs.length,
      /** Tickets in a "Needs attention" status (e.g. the client replied) */
      statusAttention: all.filter((t) => open(t) && L.statusKind(t.status) === "needsAttention").length,
      attentionBreakdown: {
        overdue: needs.filter(isOverdue).length,
        dueToday: needs.filter(isDueToday).length,
        critical: needs.filter(isCritical).length,
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
      notLinked: !src.demo && !meId,
      ai: Boolean(ai?.enabled && ai.apiKey),
      metrics,
      items,
      counts: Object.fromEntries(Object.entries(views).map(([k, f]) => [k, all.filter(f).filter((t) => k === "all" || open(t)).length])),
      facets: { queues: o.queues, companies, statuses: o.statuses, priorities: o.priorities, technicians: team },
    });
  })

  // ── AI: plan my open tickets (order + suggested start dates) ──
  .post("/ai/plan", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
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
        prompt: `Voici mes billets ouverts :\n${lines.join("\n")}\n\nPropose un ordre de traitement et une date de début (AAAA-MM-JJ, au plus tôt aujourd'hui, jours ouvrables) pour chacun, en tenant compte des échéances, des priorités et d'une charge réaliste (environ 4 à 6 billets par jour). Format : {"overview": "2 ou 3 phrases", "items": [{"id": nombre, "order": nombre, "startDate": "AAAA-MM-JJ", "reason": "courte justification"}]}`,
        maxTokens: 2500,
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
    const p = await body(c, z.object({ items: z.array(z.object({ id: z.number().int().positive(), startDate: zDate.nullable() })).max(200) }));
    for (const it of p.items) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId: it.id, startDate: it.startDate, updatedBy: a.user.id })
        .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { startDate: it.startDate, updatedBy: a.user.id, updatedAt: new Date() } });
    }
    return c.json({ ok: true });
  })

  // ── Clients and their contacts (Autotask Companies / Contacts) ──
  .get("/companies", async (c) => {
    const src = await ticketSource();
    return c.json(await run(() => src.companies()));
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
    await audit(a.user.id, "ticket.contact_created", contact.id, { companyId });
    return c.json(contact, 201);
  })

  // ── Saved filters (per technician) ──
  .get("/filters", async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query })
      .from(schema.ticketFilters)
      .where(eq(schema.ticketFilters.userId, a.user.id))
      .orderBy(asc(schema.ticketFilters.name));
    return c.json(rows);
  })
  .post("/filters", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(60), query: z.string().max(1000) }));
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
      .values({ userId: a.user.id, name: p.name, query: clean.toString() })
      .returning({ id: schema.ticketFilters.id, name: schema.ticketFilters.name, query: schema.ticketFilters.query });
    return c.json(row, 201);
  })
  .delete("/filters/:fid", async (c) => {
    const a = auth(c);
    const fid = z.uuid().parse(c.req.param("fid"));
    await db().delete(schema.ticketFilters).where(and(eq(schema.ticketFilters.id, fid), eq(schema.ticketFilters.userId, a.user.id)));
    return c.json({ ok: true });
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
    const id = Number(c.req.param("id"));
    try {
      const tk = await ticketForAi(await ticketSource(), id);
      const out = await askClaudeJson<unknown>({
        system: `${aiRole(a.user.locale)} Tu analyses un billet de support pour le technicien.`,
        prompt: `${tk}\n\nAnalyse ce billet. Format : {"summary": "résumé en 2 à 4 phrases", "nextSteps": ["étapes concrètes, dans l'ordre"], "risks": ["points d'attention, s'il y en a"], "questions": ["questions à poser au client, s'il en manque"], "suggestedPriority": "critical|high|medium|low"}`,
        maxTokens: 1500,
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

  /** Draft a reply to the client (not saved: it goes into the note box). */
  .post("/:id/ai/reply", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    try {
      const tk = await ticketForAi(await ticketSource(), Number(c.req.param("id")));
      const text = await askClaude({
        system: `${aiRole(a.user.locale)} Tu rédiges des réponses aux clients : courtoises, claires, sans jargon, sans promettre de délai précis.`,
        prompt: `${tk}\n\nRédige la prochaine réponse au client (texte seul, sans objet), signée « ${a.user.name.split(" ")[0]} – AKAB Informatique ».`,
        maxTokens: 800,
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

  /** Change status, priority, queue, assignee, due date, client or contact. */
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

  /** Reply to the client or internal note (the technician is the author). */
  .post("/:id/notes", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(8000), internal: z.boolean() }));
    const src = await ticketSource();
    await run(() => src.addNote(id, p, a));
    return c.json({ ok: true }, 201);
  })

  .put("/:id/start-date", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ startDate: zDate.nullable() }));
    await db()
      .insert(schema.ticketMeta)
      .values({ ticketId: id, startDate: p.startDate, updatedBy: a.user.id })
      .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { startDate: p.startDate, updatedBy: a.user.id, updatedAt: new Date() } });
    return c.json({ ok: true, startDate: p.startDate });
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
        queue: z.string().max(120).default(""),
        assigneeId: z.string().max(60).nullable(),
        dueDate: zDate,
        startDate: zDate.nullable().optional(),
      }),
    );
    const src = await ticketSource();
    const o = await run(() => src.options());
    if (!o.priorities.some((x) => x.value === p.priority)) throw new HTTPException(400, { message: "Validation failed" });
    if (src.demo && !o.queues.some((x) => x.value === p.queue)) throw new HTTPException(400, { message: "Validation failed" });
    const id = await run(() => src.create({ ...p, contactId: p.contactId ?? null }, a));
    if (p.startDate) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId: id, startDate: p.startDate, updatedBy: a.user.id })
        .onConflictDoNothing();
    }
    await audit(a.user.id, "ticket.created", String(id));
    const t = await run(() => src.get(id));
    if (!t) return c.json({ id }, 201);
    return c.json(summary(t, lookup(o), p.startDate ?? undefined, a.user.id), 201);
  });
