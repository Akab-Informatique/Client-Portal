import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { addDemoNote, addDemoTicket, demoCompanies, demoTickets, QUEUES, updateDemoTicket, type Ticket } from "../lib/demoTickets.ts";
import { body } from "../lib/validate.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { AiError, aiSettings, askClaude, askClaudeJson } from "../lib/ai.ts";

/**
 * Tickets (staff). For now the data are sample tickets (see demoTickets.ts);
 * the same endpoints will read Autotask once connected. The start date is a
 * portal-only field (Autotask has none), stored in ticket_meta.
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const FILTER_PARAMS = ["view", "assignee", "q", "due", "created", "attention", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "sort"];

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
  return e instanceof HTTPException ? e : new HTTPException(502, { message: "ai_api" });
}
const aiLimit = (userId: string) => {
  if (!rateLimit(`ai:${userId}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
};
/** The ticket as text for the AI (no portal account data). */
async function ticketForAi(id: number): Promise<string> {
  const t = demoTickets(await staffPeople()).find((x) => x.id === id);
  if (!t) throw new HTTPException(404, { message: "not_found" });
  const start = (await startDates([id])).get(id);
  const notes = t.notes.map((n) => `- [${n.at.slice(0, 16)}] ${n.author}${n.internal ? " (note interne)" : ""} : ${n.text}`).join("\n");
  return [
    `Billet ${t.number} — ${t.title}`,
    `Client : ${t.company.name}${t.contact ? ` (contact : ${t.contact})` : ""}`,
    `Statut : ${t.status} · Priorité : ${t.priority} · File : ${t.queue} · Source : ${t.source}`,
    `Assigné à : ${t.assignee?.name ?? "personne"} · Créé : ${t.createdAt.slice(0, 16)} · Échéance : ${t.dueAt.slice(0, 16)}${start ? ` · Début prévu : ${start}` : ""}`,
    `Description :\n${t.description || "(aucune)"}`,
    `Historique :\n${notes || "(aucun)"}`,
  ].join("\n");
}

/** Full ticket for the ticket window, with the choices needed to edit it inline. */
async function detailOf(t: Ticket, start: string | undefined, a: AuthContext) {
  const staff = await staffPeople();
  const ai = a.permissions.includes("tickets.ai") ? await aiSettings() : null;
  return {
    ...summary(t, start, a.user.id),
    description: t.description,
    source: t.source,
    hours: t.hours,
    notes: t.notes,
    ai: Boolean(ai?.enabled && ai.apiKey),
    options: { statuses: STATUSES, priorities: PRIORITIES, queues: QUEUES, technicians: staff },
  };
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

async function staffPeople() {
  const rows = await db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name));
  return rows;
}

async function startDates(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const rows = await db().select().from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, ids));
  return new Map(rows.filter((r) => r.startDate).map((r) => [r.ticketId, r.startDate!]));
}

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

function summary(t: Ticket, start: string | undefined, me: string) {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    company: t.company,
    contact: t.contact,
    status: t.status,
    priority: t.priority,
    queue: t.queue,
    assignee: t.assignee,
    createdAt: t.createdAt,
    dueAt: t.dueAt,
    updatedAt: t.updatedAt,
    startDate: start ?? null,
    viewers: viewersOf(t.id, me),
  };
}

export const ticketRoutes = new Hono<AppEnv>()
  .use(requirePermission("tickets.view"))

  .get("/", async (c) => {
    const a = auth(c);
    const q = c.req.query();
    const staff = await staffPeople();
    const all = demoTickets(staff);
    const starts = await startDates(all.map((t) => t.id));
    const me = a.user.id;
    const eod = endOfToday();
    const open = (t: Ticket) => t.status !== "complete";
    const isOverdue = (t: Ticket) => new Date(t.dueAt).getTime() < Date.now();
    const isDueToday = (t: Ticket) => {
      const d = new Date(t.dueAt).getTime();
      return d >= Date.now() && d <= eod;
    };
    /** Needs attention: open and overdue, due today or critical */
    const attention = (t: Ticket) => open(t) && (isOverdue(t) || isDueToday(t) || t.priority === "critical");

    const views = {
      mine: (t: Ticket) => t.assignee?.id === me && open(t),
      unassigned: (t: Ticket) => !t.assignee && open(t),
      due: (t: Ticket) => open(t) && new Date(t.dueAt).getTime() <= eod,
      all: (_t: Ticket) => true,
    };
    const view = (q.view in views ? q.view : "mine") as keyof typeof views;
    const status = list(q.status);
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
      .filter((t) => (status.length ? status.includes(t.status) : view === "all" || open(t)))
      .filter((t) => !priority.length || priority.includes(t.priority))
      .filter((t) => !queue.length || queue.includes(t.queue))
      .filter((t) => !company.length || company.includes(t.company.id))
      .filter((t) => !assignee.length || assignee.includes(t.assignee?.id ?? "none"))
      .filter((t) => !text || `${t.number} ${t.title} ${t.company.name} ${t.contact}`.toLowerCase().includes(text))
      .filter((t) => inRange(t.dueAt, q.dueFrom, q.dueTo))
      // Tiles: "due=overdue|today" (to the minute) and "created=today"
      .filter((t) => {
        const d = new Date(t.dueAt).getTime();
        return q.due === "overdue" ? d < Date.now() : q.due === "today" ? d >= Date.now() && d <= eod : true;
      })
      .filter((t) => q.created !== "today" || new Date(t.createdAt).toDateString() === new Date().toDateString())
      .filter((t) => q.attention !== "1" || attention(t))
      // Portal-only filter: Autotask has no start date
      .filter((t) => inRange(starts.get(t.id), q.startFrom, q.startTo))
      .map((t) => summary(t, starts.get(t.id), me));

    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    const sort = q.sort ?? "due";
    items.sort((x, y) =>
      sort === "priority"
        ? order[x.priority] - order[y.priority] || x.dueAt.localeCompare(y.dueAt)
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
      /** Tickets in the "Needs attention" status (e.g. the client replied) */
      statusAttention: all.filter((t) => t.status === "needsAttention").length,
      attentionBreakdown: {
        overdue: needs.filter(isOverdue).length,
        dueToday: needs.filter(isDueToday).length,
        critical: needs.filter((t) => t.priority === "critical").length,
      },
    };

    const ai = a.permissions.includes("tickets.ai") ? await aiSettings() : null;
    return c.json({
      demo: true,
      ai: Boolean(ai?.enabled && ai.apiKey),
      metrics,
      items,
      counts: Object.fromEntries(Object.entries(views).map(([k, f]) => [k, all.filter(f).filter((t) => k === "all" || open(t)).length])),
      facets: {
        queues: QUEUES,
        companies: demoCompanies(),
        statuses: STATUSES,
        priorities: PRIORITIES,
        // each technician with their open tickets (team strip)
        technicians: staff.map((s) => ({ ...s, open: all.filter((t) => open(t) && t.assignee?.id === s.id).length })),
      },
    });
  })

  // ── AI: plan my open tickets (order + suggested start dates) ──
  .post("/ai/plan", requirePermission("tickets.ai"), async (c) => {
    const a = auth(c);
    aiLimit(a.user.id);
    const mine = demoTickets(await staffPeople()).filter((x) => x.assignee?.id === a.user.id && x.status !== "complete");
    if (!mine.length) return c.json({ overview: "", items: [] });
    const starts = await startDates(mine.map((x) => x.id));
    const today = new Date().toISOString().slice(0, 10);
    const lines = mine.map(
      (x) =>
        `- id ${x.id} · ${x.number} · « ${x.title} » · client ${x.company.name} · priorité ${x.priority} · statut ${x.status} · échéance ${x.dueAt.slice(0, 16)} · début prévu ${starts.get(x.id) ?? "aucun"}`,
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
    const p = await body(c, z.object({ items: z.array(z.object({ id: z.number().int(), startDate: zDate.nullable() })).max(100) }));
    const known = new Set(demoTickets(await staffPeople()).map((x) => x.id));
    for (const it of p.items.filter((i) => known.has(i.id))) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId: it.id, startDate: it.startDate, updatedBy: a.user.id })
        .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { startDate: it.startDate, updatedBy: a.user.id, updatedAt: new Date() } });
    }
    return c.json({ ok: true });
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
    const id = Number(c.req.param("id"));
    const t = demoTickets(await staffPeople()).find((x) => x.id === id);
    if (!t) throw new HTTPException(404, { message: "not_found" });
    const start = (await startDates([id])).get(id);
    return c.json(await detailOf(t, start, a));
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
    const tk = await ticketForAi(id);
    try {
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
    const tk = await ticketForAi(Number(c.req.param("id")));
    try {
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

  /** Change status, priority, queue, assignee or due date (inline in the ticket window). */
  .patch("/:id", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    const staff = await staffPeople();
    if (!demoTickets(staff).some((x) => x.id === id)) throw new HTTPException(404, { message: "not_found" });
    const p = await body(
      c,
      z.object({
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        queue: z.string().refine((v) => QUEUES.includes(v)).optional(),
        assigneeId: z.uuid().nullable().optional(),
        dueDate: zDate.optional(),
      }),
    );
    const patch: Parameters<typeof updateDemoTicket>[1] = {};
    if (p.status) patch.status = p.status;
    if (p.priority) patch.priority = p.priority;
    if (p.queue) patch.queue = p.queue;
    if (p.dueDate) patch.dueAt = new Date(`${p.dueDate}T17:00:00`).toISOString();
    if (p.assigneeId !== undefined) {
      const person = p.assigneeId ? staff.find((s) => s.id === p.assigneeId) : null;
      if (p.assigneeId && !person) throw new HTTPException(400, { message: "invalid_assignee" });
      patch.assignee = person ?? null;
    }
    updateDemoTicket(id, patch);
    const t = demoTickets(staff).find((x) => x.id === id)!;
    const start = (await startDates([id])).get(id);
    return c.json(await detailOf(t, start, a));
  })

  /** Reply to the client or internal note (the technician is the author). */
  .post("/:id/notes", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    demoTickets(await staffPeople());
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(8000), internal: z.boolean() }));
    const n = addDemoNote(id, { author: a.user.name, text: p.text, internal: p.internal });
    if (!n) throw new HTTPException(404, { message: "not_found" });
    return c.json(n, 201);
  })

  .put("/:id/start-date", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!demoTickets(await staffPeople()).some((x) => x.id === id)) throw new HTTPException(404, { message: "not_found" });
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
        contact: z.string().trim().max(120).default(""),
        priority: z.enum(PRIORITIES),
        queue: z.string().refine((v) => QUEUES.includes(v)),
        assigneeId: z.uuid().nullable(),
        dueDate: zDate,
        startDate: zDate.nullable().optional(),
      }),
    );
    const company = demoCompanies().find((x) => x.id === p.companyId);
    if (!company) throw new HTTPException(400, { message: "invalid_company" });
    const staff = await staffPeople();
    demoTickets(staff);
    const assignee = p.assigneeId ? (staff.find((s) => s.id === p.assigneeId) ?? null) : null;
    const t = addDemoTicket({
      title: p.title,
      description: p.description,
      company,
      contact: p.contact,
      status: assignee ? "inProgress" : "new",
      priority: p.priority,
      queue: p.queue,
      source: "portal",
      assignee,
      dueAt: new Date(`${p.dueDate}T17:00:00`).toISOString(),
    });
    if (p.startDate) await db().insert(schema.ticketMeta).values({ ticketId: t.id, startDate: p.startDate, updatedBy: a.user.id });
    return c.json(summary(t, p.startDate ?? undefined, a.user.id), 201);
  });
