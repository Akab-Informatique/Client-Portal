import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, gt, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notify } from "../lib/notify.ts";
import { body, zUuid } from "../lib/validate.ts";
import { ticketSource } from "../lib/ticketSource.ts";

/**
 * Planning: an admin (tickets.plan) gives a technician priorities — tickets
 * for a day ("priorités du jour") or a week ("priorités de la semaine"),
 * with a direction — and reserves time on the technician's weekly calendar.
 * Only priorities go on a calendar. Unfinished priorities of earlier days /
 * weeks stay shown (carried over) until marked done. Technicians see their
 * own; tickets.plan sees everyone's.
 */
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Today in Québec, YYYY-MM-DD. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
/** Monday of that date's week. */
function monday(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
const canPlan = (a: AuthContext) => a.permissions.includes("tickets.plan");

/** Whose pins / calendar: me by default; someone else needs tickets.plan. */
function whose(c: Context<AppEnv>, a: AuthContext): string {
  const asked = c.req.query("technicianId");
  if (!asked || asked === a.user.id) return a.user.id;
  if (!canPlan(a)) throw new HTTPException(403, { message: "forbidden" });
  return zUuid.parse(asked);
}

async function technician(id: string) {
  const [u] = await db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new HTTPException(400, { message: "invalid_technician" });
  return u;
}

/** Number and title of a ticket (local copy first). */
async function ticketInfo(id: number) {
  const src = await ticketSource();
  const t = (await src.list().catch(() => [])).find((x) => x.id === id) ?? (await src.get(id).catch(() => null));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  return t;
}

/** Pin (or update the direction of) a ticket for a technician; tells them. */
async function pin(a: AuthContext, p: { ticketId: number; technicianId: string; note?: string; horizon?: "day" | "week"; forDate?: string }) {
  const horizon = p.horizon ?? "week";
  const day = p.forDate ?? today();
  const forDate = horizon === "week" ? monday(day) : day;
  const tech = await technician(p.technicianId);
  const t = await ticketInfo(p.ticketId);
  const [existing] = await db()
    .select()
    .from(schema.ticketPins)
    .where(and(eq(schema.ticketPins.ticketId, p.ticketId), eq(schema.ticketPins.technicianId, tech.id)));
  if (existing) {
    // from the calendar (no direction given): keep the priority as it is
    if (p.note === undefined && !p.horizon) return existing;
    const [row] = await db()
      .update(schema.ticketPins)
      .set({ ...(p.note !== undefined ? { note: p.note } : {}), ...(p.horizon ? { horizon, forDate } : {}), doneAt: null, updatedAt: new Date() })
      .where(eq(schema.ticketPins.id, existing.id))
      .returning();
    return row;
  }
  const [{ last }] = await db()
    .select({ last: max(schema.ticketPins.rank) })
    .from(schema.ticketPins)
    .where(eq(schema.ticketPins.technicianId, tech.id));
  const [row] = await db()
    .insert(schema.ticketPins)
    .values({ ticketId: p.ticketId, ticketNumber: t.number, ticketTitle: t.title.slice(0, 250), technicianId: tech.id, note: p.note ?? "", horizon, forDate, rank: (last ?? 0) + 1, pinnedBy: a.user.id })
    .returning();
  if (tech.id !== a.user.id) {
    await notify([tech.id], {
      type: "ticket.pinned",
      data: { number: t.number, title: t.title, by: a.user.name, horizon, note: (p.note ?? "").slice(0, 200) },
      link: `/tickets?ticket=${p.ticketId}`,
    });
  }
  await audit(a.user.id, "planning.pinned", String(p.ticketId), { technicianId: tech.id });
  return row;
}

const zIso = z.iso.datetime({ offset: true });

export const planningRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("tickets.view"))

  /** Technicians to plan for. */
  .get("/technicians", requirePermission("tickets.plan"), async (c) =>
    c.json(
      await db()
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
        .orderBy(asc(schema.users.name)),
    ),
  )

  // ── Pins ──
  /**
   * A technician's priorities for a date (today by default): of the day, of
   * the week, and the unfinished ones carried over — with the live status.
   */
  .get("/pins", async (c) => {
    const a = auth(c);
    const techId = whose(c, a);
    const day = zDay.parse(c.req.query("date") ?? today());
    const week = monday(day);
    const rows = await db()
      .select({ pin: schema.ticketPins, by: schema.users.name })
      .from(schema.ticketPins)
      .leftJoin(schema.users, eq(schema.users.id, schema.ticketPins.pinnedBy))
      .where(eq(schema.ticketPins.technicianId, techId))
      .orderBy(asc(schema.ticketPins.rank), asc(schema.ticketPins.createdAt));
    const src = await ticketSource();
    const [list, o] = await Promise.all([src.list().catch(() => []), src.options().catch(() => null)]);
    const bucket = (p: typeof schema.ticketPins.$inferSelect): "day" | "week" | "carried" | null => {
      if (p.horizon === "day" && p.forDate === day) return "day";
      if (p.horizon === "week" && p.forDate === week) return "week";
      const earlier = p.horizon === "day" ? p.forDate < day : p.forDate < week;
      return earlier && !p.doneAt ? "carried" : null;
    };
    return c.json(
      rows
        .map((r) => ({ ...r, bucket: bucket(r.pin) }))
        .filter((r) => r.bucket)
        .map(({ pin: p, by, bucket: b }) => {
        const t = list.find((x) => x.id === p.ticketId);
        const st = o?.statuses.find((s) => s.value === t?.status);
        const pr = o?.priorities.find((s) => s.value === t?.priority);
        return {
          ...p,
          bucket: b,
          ticketTitle: t?.title ?? p.ticketTitle,
          pinnedByName: by,
          company: t?.company.name ?? null,
          dueAt: t?.dueAt ?? null,
          status: st ? { label: st.label, kind: st.kind } : null,
          priority: pr ? { label: pr.label, kind: pr.kind } : null,
        };
      }),
    );
  })

  /** Who a ticket is pinned to, with the directions (banner in the ticket window). */
  .get("/pins/ticket/:ticketId", async (c) => {
    const id = Number(c.req.param("ticketId"));
    if (!Number.isInteger(id)) throw new HTTPException(400, { message: "invalid_id" });
    const by = sql<string | null>`(select name from users where users.id = ${schema.ticketPins.pinnedBy})`;
    return c.json(
      await db()
        .select({
          id: schema.ticketPins.id,
          technicianId: schema.ticketPins.technicianId,
          technician: schema.users.name,
          note: schema.ticketPins.note,
          horizon: schema.ticketPins.horizon,
          forDate: schema.ticketPins.forDate,
          doneAt: schema.ticketPins.doneAt,
          pinnedByName: by,
          createdAt: schema.ticketPins.createdAt,
        })
        .from(schema.ticketPins)
        .innerJoin(schema.users, eq(schema.users.id, schema.ticketPins.technicianId))
        .where(eq(schema.ticketPins.ticketId, id))
        .orderBy(asc(schema.users.name)),
    );
  })

  .post("/pins", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        ticketId: z.number().int().positive(),
        technicianId: zUuid,
        note: z.string().trim().max(2000).default(""),
        horizon: z.enum(["day", "week"]).default("week"),
        forDate: zDay.optional(),
      }),
    );
    return c.json(await pin(a, p), 201);
  })

  /** Done (or not): the technician it is for, or a planner. */
  .post("/pins/:id/done", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ done: z.boolean() }));
    const [row] = await db().select().from(schema.ticketPins).where(eq(schema.ticketPins.id, id));
    if (!row) throw new HTTPException(404, { message: "not_found" });
    if (row.technicianId !== a.user.id && !canPlan(a)) throw new HTTPException(403, { message: "forbidden" });
    const [next] = await db().update(schema.ticketPins).set({ doneAt: p.done ? new Date() : null, updatedAt: new Date() }).where(eq(schema.ticketPins.id, id)).returning();
    await audit(a.user.id, p.done ? "planning.priority_done" : "planning.priority_reopened", String(row.ticketId), { technicianId: row.technicianId });
    return c.json(next);
  })

  .patch("/pins/:id", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ note: z.string().trim().max(2000).optional(), horizon: z.enum(["day", "week"]).optional(), forDate: zDay.optional() }));
    const [cur] = await db().select().from(schema.ticketPins).where(eq(schema.ticketPins.id, id));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const horizon = p.horizon ?? cur.horizon;
    const day = p.forDate ?? cur.forDate;
    const [row] = await db()
      .update(schema.ticketPins)
      .set({ ...(p.note !== undefined ? { note: p.note } : {}), horizon, forDate: horizon === "week" ? monday(day) : day, updatedAt: new Date() })
      .where(eq(schema.ticketPins.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "planning.pin_updated", String(row.ticketId), { technicianId: row.technicianId });
    return c.json(row);
  })

  /** Move a pin up or down in the technician's order. */
  .post("/pins/:id/move", requirePermission("tickets.plan"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ dir: z.enum(["up", "down"]) }));
    const [row] = await db().select().from(schema.ticketPins).where(eq(schema.ticketPins.id, id));
    if (!row) throw new HTTPException(404, { message: "not_found" });
    const list = await db()
      .select()
      .from(schema.ticketPins)
      .where(eq(schema.ticketPins.technicianId, row.technicianId))
      .orderBy(asc(schema.ticketPins.rank), asc(schema.ticketPins.createdAt));
    const i = list.findIndex((x) => x.id === id);
    const j = p.dir === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
      [list[i], list[j]] = [list[j], list[i]];
      await db().transaction(async (tx) => {
        for (const [k, x] of list.entries()) await tx.update(schema.ticketPins).set({ rank: k + 1 }).where(eq(schema.ticketPins.id, x.id));
      });
    }
    return c.json({ ok: true });
  })

  .delete("/pins/:id", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().delete(schema.ticketPins).where(eq(schema.ticketPins.id, id)).returning();
    if (row) await audit(a.user.id, "planning.unpinned", String(row.ticketId), { technicianId: row.technicianId });
    return c.json({ ok: true });
  })

  // ── Calendar ──
  /** A technician's reserved time between two dates. */
  .get("/calendar", async (c) => {
    const a = auth(c);
    const techId = whose(c, a);
    const from = new Date(zIso.parse(c.req.query("from")));
    const to = new Date(zIso.parse(c.req.query("to")));
    if (!(to > from) || to.getTime() - from.getTime() > 62 * 86_400_000) throw new HTTPException(400, { message: "Validation failed" });
    return c.json(
      await db()
        .select()
        .from(schema.calendarBlocks)
        .where(and(eq(schema.calendarBlocks.technicianId, techId), lt(schema.calendarBlocks.startsAt, to), gt(schema.calendarBlocks.endsAt, from)))
        .orderBy(asc(schema.calendarBlocks.startsAt)),
    );
  })

  /** Reserve time. For a ticket, it is pinned to the technician if it was not. */
  .post("/calendar", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        technicianId: zUuid,
        ticketId: z.number().int().positive().nullable().default(null),
        title: z.string().trim().max(200).default(""),
        note: z.string().trim().max(2000).default(""),
        startsAt: zIso,
        endsAt: zIso,
      }),
    );
    const startsAt = new Date(p.startsAt);
    const endsAt = new Date(p.endsAt);
    if (!(endsAt > startsAt) || endsAt.getTime() - startsAt.getTime() > 14 * 3_600_000) throw new HTTPException(400, { message: "invalid_time" });
    const tech = await technician(p.technicianId);
    let number: string | null = null;
    let title = p.title;
    if (p.ticketId) {
      const pinned = await pin(a, { ticketId: p.ticketId, technicianId: tech.id, forDate: dayOf(startsAt) });
      number = pinned.ticketNumber;
      title ||= pinned.ticketTitle;
    }
    if (!title) throw new HTTPException(400, { message: "Validation failed" });
    const [row] = await db()
      .insert(schema.calendarBlocks)
      .values({ technicianId: tech.id, ticketId: p.ticketId, ticketNumber: number, title, note: p.note, startsAt, endsAt, createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "planning.block_created", row.id, { technicianId: tech.id, ticketId: p.ticketId });
    return c.json(row, 201);
  })

  .patch("/calendar/:id", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ startsAt: zIso.optional(), endsAt: zIso.optional(), note: z.string().trim().max(2000).optional(), title: z.string().trim().min(1).max(200).optional() }));
    const [cur] = await db().select().from(schema.calendarBlocks).where(eq(schema.calendarBlocks.id, id));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const startsAt = p.startsAt ? new Date(p.startsAt) : cur.startsAt;
    const endsAt = p.endsAt ? new Date(p.endsAt) : cur.endsAt;
    if (!(endsAt > startsAt) || endsAt.getTime() - startsAt.getTime() > 14 * 3_600_000) throw new HTTPException(400, { message: "invalid_time" });
    const [row] = await db()
      .update(schema.calendarBlocks)
      .set({ startsAt, endsAt, ...(p.note !== undefined ? { note: p.note } : {}), ...(p.title ? { title: p.title } : {}), updatedAt: new Date() })
      .where(eq(schema.calendarBlocks.id, id))
      .returning();
    await audit(a.user.id, "planning.block_updated", id, {});
    return c.json(row);
  })

  .delete("/calendar/:id", requirePermission("tickets.plan"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    await db().delete(schema.calendarBlocks).where(eq(schema.calendarBlocks.id, id));
    await audit(a.user.id, "planning.block_deleted", id, {});
    return c.json({ ok: true });
  });
