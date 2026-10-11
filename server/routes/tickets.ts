import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { addDemoTicket, demoCompanies, demoTickets, QUEUES, type Ticket } from "../lib/demoTickets.ts";
import { body } from "../lib/validate.ts";

/**
 * Tickets (staff). For now the data are sample tickets (see demoTickets.ts);
 * the same endpoints will read Autotask once connected. The start date is a
 * portal-only field (Autotask has none), stored in ticket_meta.
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ["new", "inProgress", "waitingCustomer", "waitingVendor", "scheduled", "complete"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const FILTER_PARAMS = ["view", "q", "due", "created", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "sort"];

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
      .filter((t) => !text || `${t.number} ${t.title} ${t.company.name} ${t.contact}`.toLowerCase().includes(text))
      .filter((t) => inRange(t.dueAt, q.dueFrom, q.dueTo))
      // Tiles: "due=overdue|today" (to the minute) and "created=today"
      .filter((t) => {
        const d = new Date(t.dueAt).getTime();
        return q.due === "overdue" ? d < Date.now() : q.due === "today" ? d >= Date.now() && d <= eod : true;
      })
      .filter((t) => q.created !== "today" || new Date(t.createdAt).toDateString() === new Date().toDateString())
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
            ? (x.startDate ?? "9999").localeCompare(y.startDate ?? "9999")
            : x.dueAt.localeCompare(y.dueAt),
    );

    // Key figures for the tiles (whole set, not the current filters)
    const mineOpen = all.filter(views.mine);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const metrics = {
      mine: mineOpen.length,
      overdue: mineOpen.filter((t) => new Date(t.dueAt).getTime() < Date.now()).length,
      dueToday: mineOpen.filter((t) => {
        const d = new Date(t.dueAt).getTime();
        return d >= Date.now() && d <= eod;
      }).length,
      critical: all.filter((t) => open(t) && (t.priority === "critical" || t.priority === "high")).length,
      unassigned: all.filter(views.unassigned).length,
      newToday: all.filter((t) => new Date(t.createdAt) >= startOfToday).length,
    };

    return c.json({
      demo: true,
      metrics,
      items,
      counts: Object.fromEntries(Object.entries(views).map(([k, f]) => [k, all.filter(f).filter((t) => k === "all" || open(t)).length])),
      facets: { queues: QUEUES, companies: demoCompanies(), statuses: STATUSES, priorities: PRIORITIES, technicians: staff },
    });
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
    return c.json({ ...summary(t, start, a.user.id), description: t.description, source: t.source, hours: t.hours, notes: t.notes });
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
