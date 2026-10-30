import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zOptText, zUuid } from "../lib/validate.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { isAlert, lookup, run } from "./tickets.ts";
import { asSeen, seesFull, team as planningTeam } from "./planning.ts";
import { addDay, gaugeQueues } from "../lib/meetingsData.ts";
import { briefOf, briefWeek, buildBrief } from "../lib/weekBrief.ts";
import { rateLimit } from "../lib/http.ts";

/**
 * Weekly team meeting dashboard (meetings.view). Tickets: every technician
 * with their open tickets past the due date, the most overdue first.
 */
export const meetingRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("meetings.view"))

  /**
   * The week ahead in a few bullets and what management could do about it (written by the AI from the meeting page's
   * data and each technician's days; the portal's own rules when the AI is off). Kept per week.
   */
  .get("/brief", async (c) => {
    const q = z.object({ from: zDay.optional() }).safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: "invalid_range" });
    return c.json(await briefOf(q.data.from ?? briefWeek(todayQc())));
  })
  .post("/brief", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`week-brief:${a.user.id}`, 10, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, z.object({ from: zDay.optional() }));
    return c.json(await buildBrief(p.from ?? briefWeek(todayQc()), { ai: true, userId: a.user.id }));
  })

  .get("/overdue", async (c) => {
    const src = await ticketSource();
    const [everything, o, technicians] = await run(() => Promise.all([src.list(), src.options(), src.technicians()]));
    const L = lookup(o);
    // Only the queues the gauges count (support work); monitoring alerts have their own gauge
    const queues = await gaugeQueues(o.queues);
    const alert = isAlert(L);
    const all = everything.filter((t) => queues.counted.includes(t.queue) && !alert(t));
    const now = Date.now();
    const friday = fridayEnd(new Date(now));
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    // Past the due date, or due by the end of this Friday (the meeting is on Monday)
    const listed = all.filter((t) => open(t) && new Date(t.dueAt).getTime() <= friday.getTime()).sort((x, y) => x.dueAt.localeCompare(y.dueAt));
    const isOverdue = (t: NTicket) => new Date(t.dueAt).getTime() < now;
    const item = (t: NTicket) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      company: t.company.name,
      statusLabel: L.statusLabel(t.status),
      statusKind: L.statusKind(t.status),
      priorityLabel: L.priorityLabel(t.priority),
      priorityKind: L.priorityKind(t.priority),
      dueAt: t.dueAt,
      overdue: isOverdue(t),
      secondary: t.secondary.map((p) => p.name),
    });

    // Every technician (linked in the portal, or with open tickets in the source), even with nothing to discuss
    const openBy = new Set(all.filter(open).flatMap((t) => (t.assignee ? [t.assignee.id] : [])));
    const people = new Map(technicians.filter((p) => src.demo || !p.id.startsWith("at-") || openBy.has(p.id)).map((p) => [p.id, p.name]));
    for (const t of listed) if (t.assignee && !people.has(t.assignee.id)) people.set(t.assignee.id, t.assignee.name);
    const stray = () => {
      const rows = all.filter((x) => open(x) && !x.assignee && L.statusKind(x.status) !== "new");
      const by = new Map<string, { label: string; kind: string; count: number }>();
      for (const x of rows) {
        const key = String(x.status);
        const cur = by.get(key) ?? { label: L.statusLabel(x.status) ?? "", kind: L.statusKind(x.status), count: 0 };
        cur.count++;
        by.set(key, cur);
      }
      return {
        total: rows.length,
        byStatus: [...by.values()].sort((p, q) => q.count - p.count),
        tickets: [...rows].sort((p, q) => p.dueAt.localeCompare(q.dueAt)).map(item),
      };
    };
    const byTech = [...people].map(([id, name]) => ({ id, name, tickets: listed.filter((t) => t.assignee?.id === id).map(item) }));
    const late = (x: { tickets: { overdue: boolean }[] }) => x.tickets.filter((t) => t.overdue).length;
    byTech.sort((x, y) => late(y) - late(x) || y.tickets.length - x.tickets.length || x.name.localeCompare(y.name));

    return c.json({
      demo: src.demo,
      total: listed.filter(isOverdue).length,
      dueThisWeek: listed.filter((t) => !isOverdue(t)).length,
      /** End of the Friday the "this week" tickets are due by */
      until: friday.toISOString(),
      /** That Friday, YYYY-MM-DD (for display) */
      untilDate: fridayDate(new Date(now)),
      technicians: byTech,
      unassigned: listed.filter((t) => !t.assignee).map(item),
      // Open tickets nobody has, past "new": someone moved them on, then nobody took them (not to lose)
      stray: stray(),
      queues,
      // Open monitoring alerts, the newest first
      alerts: everything
        .filter((t) => open(t) && alert(t))
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        .map((t) => ({ ...item(t), createdAt: t.createdAt })),
      /** The status a ticket gets when marked resolved from the meeting */
      completeStatus: o.statuses.find((s) => s.kind === "complete")?.value ?? null,
    });
  })

  /** Which ticket queues the gauges count (null: the default, every queue but alerts). */
  .put("/gauge-queues", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const v = await body(c, z.object({ queues: z.array(z.string().min(1).max(100)).max(200).nullable() }));
    if (v.queues) {
      const src = await ticketSource();
      const o = await run(() => src.options());
      const known = new Set(o.queues.map((q) => q.value));
      if (!v.queues.length || v.queues.some((q) => !known.has(q))) throw new HTTPException(400, { message: "invalid_queue" });
    }
    const [cur] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "meetings"));
    const config = { ...(cur?.config ?? {}), gaugeQueues: v.queues ? [...new Set(v.queues)] : null };
    await db()
      .insert(schema.integrations)
      .values({ provider: "meetings", enabled: true, config, updatedBy: a.user.id })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { config, updatedBy: a.user.id, updatedAt: new Date() } });
    await audit(a.user.id, "meeting.gauge_queues", null, { queues: v.queues });
    return c.json({ ok: true });
  })

  // ── Points to discuss (meetings.manage to change) ──
  // The list: open ones and those settled in the last 7 days; never archived ones,
  // nor those put off to a later day (back on the list that day).
  .get("/points", async (c) => {
    const p = schema.meetingPoints;
    const today = todayQc();
    const rows = await db()
      .select(pointFields)
      .from(p)
      .where(
        and(
          isNull(p.archivedAt),
          or(isNull(p.snoozeUntil), lte(p.snoozeUntil, today)),
          or(isNull(p.doneAt), gt(p.doneAt, new Date(Date.now() - 7 * 86_400_000))),
        ),
      )
      .orderBy(asc(p.position), asc(p.createdAt))
      .limit(300);
    return c.json(await withNotes(rows));
  })

  /** Points put off to a later day, the soonest first. */
  .get("/points/later", async (c) => {
    const p = schema.meetingPoints;
    const rows = await db()
      .select(pointFields)
      .from(p)
      .where(and(isNull(p.archivedAt), gt(p.snoozeUntil, todayQc())))
      .orderBy(asc(p.snoozeUntil), asc(p.createdAt))
      .limit(300);
    return c.json(await withNotes(rows));
  })

  /** Archived points, the latest archived first. */
  .get("/points/archive", async (c) => {
    const p = schema.meetingPoints;
    const rows = await db().select(pointFields).from(p).where(isNotNull(p.archivedAt)).orderBy(desc(p.archivedAt)).limit(200);
    return c.json(await withNotes(rows));
  })

  .post("/points", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const v = await body(c, z.object({ text: z.string().trim().min(1).max(2000), details: z.string().trim().max(8000).nullable().optional() }));
    // a new point goes to the end of the list
    const [last] = await db().select({ m: sql<number>`coalesce(max(${schema.meetingPoints.position}), 0)::int` }).from(schema.meetingPoints);
    const [row] = await db()
      .insert(schema.meetingPoints)
      .values({ text: v.text, details: v.details || null, authorId: a.user.id, authorName: a.user.name, position: (last?.m ?? 0) + 1 })
      .returning({ id: schema.meetingPoints.id });
    return c.json({ id: row.id }, 201);
  })
  /** The order the team wants the points discussed in: the ids, first to last */
  .put("/points/order", requirePermission("meetings.manage"), async (c) => {
    const v = await body(c, z.object({ ids: z.array(z.uuid()).min(1).max(500) }));
    await db().transaction(async (tx) => {
      for (const [i, id] of v.ids.entries()) await tx.update(schema.meetingPoints).set({ position: i + 1 }).where(eq(schema.meetingPoints.id, id));
    });
    return c.json({ ok: true });
  })

  .patch("/points/:id", requirePermission("meetings.manage"), async (c) => {
    const id = projectId(c.req.param("id"));
    const v = await body(
      c,
      z.object({
        text: z.string().trim().min(1).max(2000).optional(),
        details: z.string().trim().max(8000).nullable().optional(),
        done: z.boolean().optional(),
        archived: z.boolean().optional(),
        // put off to that day (after today), or null: back on the list now
        snoozeUntil: zDay.nullable().optional(),
      }),
    );
    if (v.snoozeUntil && v.snoozeUntil <= todayQc()) throw new HTTPException(400, { message: "snooze_not_future" });
    const set: Partial<typeof schema.meetingPoints.$inferInsert> = {};
    if (v.text !== undefined) set.text = v.text;
    if (v.details !== undefined) set.details = v.details || null;
    // checking a point settles it and sends it to the archive; unchecking (or restoring it) puts it back on the list
    if (v.done !== undefined) {
      set.doneAt = v.done ? new Date() : null;
      set.archivedAt = v.done ? new Date() : null;
    }
    if (v.archived !== undefined) {
      set.archivedAt = v.archived ? new Date() : null;
      if (!v.archived) set.doneAt = null;
    }
    if (v.snoozeUntil !== undefined) set.snoozeUntil = v.snoozeUntil;
    // restored from the archive: on the list again, not put off
    if (v.archived === false) set.snoozeUntil = null;
    if (!Object.keys(set).length) return c.json({ ok: true });
    const rows = await db().update(schema.meetingPoints).set(set).where(eq(schema.meetingPoints.id, id)).returning({ id: schema.meetingPoints.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  .delete("/points/:id", requirePermission("meetings.manage"), async (c) => {
    const id = projectId(c.req.param("id"));
    const rows = await db().delete(schema.meetingPoints).where(eq(schema.meetingPoints.id, id)).returning({ id: schema.meetingPoints.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  .post("/points/:id/notes", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const v = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    const [p] = await db().select({ id: schema.meetingPoints.id }).from(schema.meetingPoints).where(eq(schema.meetingPoints.id, id));
    if (!p) throw new HTTPException(404, { message: "not_found" });
    const [n] = await db()
      .insert(schema.meetingPointNotes)
      .values({ pointId: id, text: v.text, authorId: a.user.id, authorName: a.user.name })
      .returning({ id: schema.meetingPointNotes.id });
    return c.json({ id: n.id }, 201);
  })

  .delete("/points/:id/notes/:noteId", requirePermission("meetings.manage"), async (c) => {
    const id = projectId(c.req.param("id"));
    const noteId = projectId(c.req.param("noteId"));
    const n = schema.meetingPointNotes;
    const rows = await db()
      .delete(n)
      .where(and(eq(n.id, noteId), eq(n.pointId, id)))
      .returning({ id: n.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  // ── Ticket trends: week by week, and the last 7 days against any earlier week ──
  .get("/trends", async (c) => {
    const q = z.object({ weeks: z.coerce.number().int().min(4).max(52).default(12) }).safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: "invalid_range" });
    const weeks = q.data.weeks;
    const src = await ticketSource();
    const now = Date.now();
    const monday = mondayOf(todayQc());
    // weeks start on Monday 00:00, Québec (-05:00: within an hour in summer time)
    const startOf = (k: number) => Date.parse(`${addDay(monday, -7 * k)}T00:00:00-05:00`);
    const since = Math.min(startOf(weeks - 1), now - 7 * 86_400_000 * (weeks + 1));
    const [history, everything, o] = await run(() => Promise.all([src.history(new Date(since).toISOString()), src.list(), src.options()]));
    const L = lookup(o);
    const queues = await gaugeQueues(o.queues);
    const alert = isAlert(L);
    // the same tickets as the gauges: the counted queues, no monitoring alerts
    const counts = (t: { queue: string; source: string }) => queues.counted.includes(t.queue) && !alert(t as NTicket);
    const rows = history.filter(counts).map((t) => ({ created: Date.parse(t.createdAt), done: t.completedAt ? Date.parse(t.completedAt) : null }));
    const openNow = everything.filter((t) => counts(t) && L.statusKind(t.status) !== "complete").length;

    /** Created, resolved and resolution times between two moments */
    const measure = (from: number, to: number) => {
      const created = rows.filter((r) => r.created >= from && r.created < to).length;
      const hours = rows
        .filter((r) => r.done != null && r.done >= from && r.done < to)
        .map((r) => (r.done! - r.created) / 3_600_000)
        .filter((h) => h >= 0)
        .sort((x, y) => x - y);
      const round = (v: number) => Math.round(v * 10) / 10;
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        created,
        resolved: hours.length,
        avgHours: hours.length ? round(hours.reduce((x, y) => x + y, 0) / hours.length) : null,
        medianHours: hours.length ? round(hours[Math.floor((hours.length - 1) / 2)]) : null,
        // resolved within a day of coming in
        within24h: hours.length ? Math.round((hours.filter((h) => h <= 24).length / hours.length) * 100) : null,
      };
    };
    // open tickets at a moment: open today, minus those that came in since and are still open,
    // plus those already there then and resolved since
    const backlogAt = (at: number) => {
      if (at >= now) return openNow;
      const cameSince = rows.filter((r) => r.created >= at && r.done == null).length;
      const resolvedSince = rows.filter((r) => r.created < at && r.done != null && r.done >= at).length;
      return Math.max(0, openNow - cameSince + resolvedSince);
    };
    const window = (to: number) => ({ ...measure(to - 7 * 86_400_000, to), backlog: backlogAt(to) });

    return c.json({
      demo: src.demo,
      generatedAt: new Date(now).toISOString(),
      // calendar weeks, this one (so far) first
      weeks: Array.from({ length: weeks }, (_, k) => {
        const from = startOf(k);
        const to = k === 0 ? now : startOf(k - 1);
        return { ...measure(from, to), monday: addDay(monday, -7 * k), current: k === 0, backlog: backlogAt(to) };
      }),
      // the last 7 days, and the same 7 days 1, 2, … weeks earlier
      live: window(now),
      past: Array.from({ length: weeks }, (_, k) => window(now - 7 * 86_400_000 * (k + 1))),
    });
  })

  // ── The week at a glance: everything planned, day by day ──
  .get("/week", async (c) => {
    const a = auth(c);
    const q = z.object({ from: zDay }).safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: "invalid_range" });
    const from = q.data.from;
    const to = addDay(from, 6);
    // Québec days: from midnight of the first to midnight after the last (a margin for the offset, filtered by day client side)
    const start = new Date(`${from}T00:00:00-04:00`);
    const end = new Date(`${addDay(to, 1)}T00:00:00-05:00`);
    const people = await planningTeam();
    const byId = new Map(people.map((p) => [p.id, p]));
    const names = new Map((await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((u) => [u.id, u.name]));
    const cb = schema.calendarBlocks;
    const blocks = (
      await db()
        .select()
        .from(cb)
        .where(and(lt(cb.startsAt, end), gt(cb.endsAt, start)))
        .orderBy(asc(cb.startsAt))
    )
      .filter((b) => byId.has(b.technicianId))
      .map((b) => {
        const s = asSeen(b, seesFull(a, byId.get(b.technicianId)!));
        return {
          id: s.id,
          technicianId: s.technicianId,
          technicianName: names.get(s.technicianId) ?? "",
          kind: s.kind,
          title: s.title,
          ticketId: s.ticketId,
          ticketNumber: s.ticketNumber,
          companyName: s.companyName,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          busy: "busy" in s,
        };
      });
    const ab = schema.meetingAbsences;
    const absences = await db()
      .select({ id: ab.id, userId: ab.userId, name: schema.users.name, startDate: ab.startDate, endDate: ab.endDate, kind: ab.kind, note: ab.note })
      .from(ab)
      .innerJoin(schema.users, eq(schema.users.id, ab.userId))
      .where(and(lte(ab.startDate, to), gte(ab.endDate, from)))
      .orderBy(asc(schema.users.name));
    const p = schema.meetingProjects;
    const projects = await db()
      .select({ id: p.id, title: p.title, client: p.client, dueDate: p.dueDate })
      .from(p)
      .where(and(isNull(p.doneAt), gte(p.dueDate, from), lte(p.dueDate, to)))
      .orderBy(asc(p.dueDate));
    // Tickets due that week: the ticket source may be unreachable, the rest still shows
    let tickets: { id: number; number: string; title: string; company: string; dueAt: string; assignee: string | null }[] = [];
    let ticketsError = false;
    try {
      const src = await ticketSource();
      const [all, o] = await Promise.all([src.list(), src.options()]);
      const L = lookup(o);
      // the support tickets, as the gauges count them (no monitoring alerts)
      const queues = await gaugeQueues(o.queues);
      const alert = isAlert(L);
      tickets = all
        .filter((x) => queues.counted.includes(x.queue) && !alert(x))
        .filter((x) => L.statusKind(x.status) !== "complete" && x.dueAt && new Date(x.dueAt) >= start && new Date(x.dueAt) < end)
        .sort((x, y) => x.dueAt.localeCompare(y.dueAt))
        .slice(0, 500)
        .map((x) => ({ id: x.id, number: x.number, title: x.title, company: x.company.name, dueAt: x.dueAt, assignee: x.assignee?.name ?? null }));
    } catch (e) {
      console.warn("[meetings] week tickets:", e instanceof Error ? e.message : e);
      ticketsError = true;
    }
    const ev = schema.meetingEvents;
    const events = await db()
      .select({
        id: ev.id,
        date: ev.date,
        startTime: ev.startTime,
        endTime: ev.endTime,
        title: ev.title,
        note: ev.note,
        userId: ev.userId,
        name: schema.users.name,
        ticketId: ev.ticketId,
        ticketNumber: ev.ticketNumber,
        ticketTitle: ev.ticketTitle,
      })
      .from(ev)
      .leftJoin(schema.users, eq(schema.users.id, ev.userId))
      .where(and(gte(ev.date, from), lte(ev.date, to)))
      .orderBy(asc(ev.date), asc(ev.startTime));
    return c.json({ from, to, events, blocks, absences, projects, tickets, ticketsError });
  })

  // ── Things on the team week (meetings.manage) ──
  .post("/events", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const v = await body(c, zEvent);
    if (v.userId) await checkMember(v.userId);
    const ticket = await eventTicket(v.ticketId);
    const [row] = await db()
      .insert(schema.meetingEvents)
      .values({ ...eventValues(v), ...ticket, createdBy: a.user.id })
      .returning({ id: schema.meetingEvents.id });
    await audit(a.user.id, "meeting.event.created", row.id, { date: v.date });
    return c.json({ id: row.id }, 201);
  })

  .put("/events/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const v = await body(c, zEvent);
    if (v.userId) await checkMember(v.userId);
    const ticket = await eventTicket(v.ticketId);
    const rows = await db()
      .update(schema.meetingEvents)
      .set({ ...eventValues(v), ...ticket })
      .where(eq(schema.meetingEvents.id, id))
      .returning({ id: schema.meetingEvents.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "meeting.event.updated", id, { date: v.date });
    return c.json({ ok: true });
  })

  .delete("/events/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const rows = await db().delete(schema.meetingEvents).where(eq(schema.meetingEvents.id, id)).returning({ id: schema.meetingEvents.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "meeting.event.deleted", id);
    return c.json({ ok: true });
  })

  // ── Absences calendar (meetings.manage to change) ──
  .get("/absences", async (c) => {
    const q = z.object({ from: zDay, to: zDay }).safeParse(c.req.query());
    if (!q.success || q.data.to < q.data.from) throw new HTTPException(400, { message: "invalid_range" });
    const ab = schema.meetingAbsences;
    const rows = await db()
      .select({ id: ab.id, userId: ab.userId, name: schema.users.name, startDate: ab.startDate, endDate: ab.endDate, kind: ab.kind, note: ab.note })
      .from(ab)
      .innerJoin(schema.users, eq(schema.users.id, ab.userId))
      // Overlaps the range (dates as YYYY-MM-DD compare as text)
      .where(and(lte(ab.startDate, q.data.to), gte(ab.endDate, q.data.from)))
      .orderBy(asc(ab.startDate), asc(schema.users.name))
      .limit(1000);
    return c.json(rows);
  })

  .post("/absences", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const v = await body(c, zAbsence);
    await checkMember(v.userId);
    const [row] = await db()
      .insert(schema.meetingAbsences)
      .values({ userId: v.userId, startDate: v.startDate, endDate: v.endDate, kind: v.kind, note: v.note ?? null, createdBy: a.user.id })
      .returning({ id: schema.meetingAbsences.id });
    await audit(a.user.id, "meeting.absence.created", row.id, { userId: v.userId, startDate: v.startDate, endDate: v.endDate });
    return c.json({ id: row.id }, 201);
  })

  .put("/absences/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const v = await body(c, zAbsence);
    await checkMember(v.userId);
    const rows = await db()
      .update(schema.meetingAbsences)
      .set({ userId: v.userId, startDate: v.startDate, endDate: v.endDate, kind: v.kind, note: v.note ?? null })
      .where(eq(schema.meetingAbsences.id, id))
      .returning({ id: schema.meetingAbsences.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "meeting.absence.updated", id, { userId: v.userId, startDate: v.startDate, endDate: v.endDate });
    return c.json({ ok: true });
  })

  .delete("/absences/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const rows = await db().delete(schema.meetingAbsences).where(eq(schema.meetingAbsences.id, id)).returning({ id: schema.meetingAbsences.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "meeting.absence.deleted", id);
    return c.json({ ok: true });
  })

  // ── Projects in progress (meetings.manage to change) ──
  .get("/team", async (c) => c.json(await team()))

  .get("/projects", async (c) => {
    const done = c.req.query("done") === "1";
    const p = schema.meetingProjects;
    const projects = await db()
      .select()
      .from(p)
      .where(done ? isNotNull(p.doneAt) : isNull(p.doneAt))
      // Open: the closest due date first (no date last); done: the latest first
      .orderBy(...(done ? [desc(p.doneAt)] : [asc(p.dueDate), asc(p.createdAt)]))
      .limit(done ? 50 : 500);
    const notes = projects.length
      ? await db()
          .select()
          .from(schema.meetingProjectNotes)
          .where(
            inArray(
              schema.meetingProjectNotes.projectId,
              projects.map((x) => x.id),
            ),
          )
          .orderBy(desc(schema.meetingProjectNotes.createdAt))
      : [];
    const members = projects.length
      ? await db()
          .select({ projectId: schema.meetingProjectMembers.projectId, id: schema.users.id, name: schema.users.name })
          .from(schema.meetingProjectMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.meetingProjectMembers.userId))
          .where(
            inArray(
              schema.meetingProjectMembers.projectId,
              projects.map((x) => x.id),
            ),
          )
          .orderBy(asc(schema.users.name))
      : [];
    const doneCount = done ? projects.length : (await db().select({ id: p.id }).from(p).where(isNotNull(p.doneAt))).length;
    return c.json({
      doneCount,
      items: projects.map((x) => ({
        id: x.id,
        title: x.title,
        client: x.client,
        dueDate: x.dueDate,
        doneAt: x.doneAt,
        createdAt: x.createdAt,
        members: members.filter((m) => m.projectId === x.id).map((m) => ({ id: m.id, name: m.name })),
        notes: notes.filter((n) => n.projectId === x.id).map((n) => ({ id: n.id, text: n.text, authorName: n.authorName, createdAt: n.createdAt })),
      })),
    });
  })

  .post("/projects", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const v = await body(c, zProject);
    const [row] = await db()
      .insert(schema.meetingProjects)
      .values({ title: v.title, client: v.client ?? null, dueDate: v.dueDate ?? null, createdBy: a.user.id })
      .returning({ id: schema.meetingProjects.id });
    if (v.memberIds?.length) await setMembers(row.id, v.memberIds);
    await audit(a.user.id, "meeting.project.created", row.id, { title: v.title });
    return c.json({ id: row.id }, 201);
  })

  .patch("/projects/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const v = await body(c, zProject.partial().extend({ done: z.boolean().optional() }));
    const set: Partial<typeof schema.meetingProjects.$inferInsert> = { updatedAt: new Date() };
    if (v.title !== undefined) set.title = v.title;
    if (v.client !== undefined) set.client = v.client;
    if (v.dueDate !== undefined) set.dueDate = v.dueDate;
    if (v.done !== undefined) set.doneAt = v.done ? new Date() : null;
    const rows = await db().update(schema.meetingProjects).set(set).where(eq(schema.meetingProjects.id, id)).returning({ id: schema.meetingProjects.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    if (v.memberIds !== undefined) await setMembers(id, v.memberIds);
    await audit(a.user.id, "meeting.project.updated", id, { fields: Object.keys(v) });
    return c.json({ ok: true });
  })

  .delete("/projects/:id", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const rows = await db().delete(schema.meetingProjects).where(eq(schema.meetingProjects.id, id)).returning({ title: schema.meetingProjects.title });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "meeting.project.deleted", id, { title: rows[0].title });
    return c.json({ ok: true });
  })

  .post("/projects/:id/notes", requirePermission("meetings.manage"), async (c) => {
    const a = auth(c);
    const id = projectId(c.req.param("id"));
    const v = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    const [p] = await db().select({ id: schema.meetingProjects.id }).from(schema.meetingProjects).where(eq(schema.meetingProjects.id, id));
    if (!p) throw new HTTPException(404, { message: "not_found" });
    const [n] = await db()
      .insert(schema.meetingProjectNotes)
      .values({ projectId: id, text: v.text, authorId: a.user.id, authorName: a.user.name })
      .returning({ id: schema.meetingProjectNotes.id });
    await db().update(schema.meetingProjects).set({ updatedAt: new Date() }).where(eq(schema.meetingProjects.id, id));
    return c.json({ id: n.id }, 201);
  })

  .delete("/projects/:id/notes/:noteId", requirePermission("meetings.manage"), async (c) => {
    const id = projectId(c.req.param("id"));
    const noteId = projectId(c.req.param("noteId"));
    const n = schema.meetingProjectNotes;
    const rows = await db()
      .delete(n)
      .where(and(eq(n.id, noteId), eq(n.projectId, id)))
      .returning({ id: n.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  });

/**
 * End of Friday (Québec time) of the current week; on a weekend, the coming
 * Friday. -05:00 covers the whole day in summer and winter time.
 */
export function fridayEnd(now: Date) {
  return new Date(`${fridayDate(now)}T23:59:59.999-05:00`);
}

/** That Friday as YYYY-MM-DD. */
export function fridayDate(now: Date) {
  const tz = "America/Toronto";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + ((5 - dow + 7) % 7))).toISOString().slice(0, 10);
}

/** Today in Québec, YYYY-MM-DD */
const todayQc = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());

/** The Monday of that day's week (YYYY-MM-DD) */
function mondayOf(day: string) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDay(day, -((dow + 6) % 7));
}

const pointFields = {
  id: schema.meetingPoints.id,
  text: schema.meetingPoints.text,
  details: schema.meetingPoints.details,
  doneAt: schema.meetingPoints.doneAt,
  archivedAt: schema.meetingPoints.archivedAt,
  snoozeUntil: schema.meetingPoints.snoozeUntil,
  authorName: schema.meetingPoints.authorName,
  createdAt: schema.meetingPoints.createdAt,
};

/** The points with their notes, oldest note first. */
async function withNotes<T extends { id: string }>(points: T[]) {
  if (!points.length) return [];
  const n = schema.meetingPointNotes;
  const notes = await db()
    .select({ id: n.id, pointId: n.pointId, text: n.text, authorName: n.authorName, createdAt: n.createdAt })
    .from(n)
    .where(
      inArray(
        n.pointId,
        points.map((p) => p.id),
      ),
    )
    .orderBy(asc(n.createdAt));
  return points.map((p) => ({ ...p, notes: notes.filter((x) => x.pointId === p.id).map(({ pointId: _, ...x }) => x) }));
}

/** Active team members a project can be assigned to. */
const team = () =>
  db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name));

/** A real calendar day, YYYY-MM-DD */
const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => {
      const d = new Date(`${v}T12:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    },
    { message: "invalid_date" },
  );
const zAbsence = z
  .object({
    userId: zUuid,
    startDate: zDay,
    endDate: zDay,
    kind: z.enum(["vacation", "sick", "training", "personal", "other"]).default("vacation"),
    note: zOptText(300),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "end_before_start", path: ["endDate"] })
  .refine((v) => new Date(v.endDate).getTime() - new Date(v.startDate).getTime() <= 366 * 86_400_000, { message: "too_long", path: ["endDate"] });

const zTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));
const zEvent = z
  .object({
    date: zDay,
    startTime: zTime,
    endTime: zTime,
    title: z.string().trim().min(1).max(200),
    note: zOptText(1000),
    userId: zUuid
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    ticketId: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => !v.startTime || !v.endTime || v.endTime > v.startTime, { message: "end_before_start", path: ["endTime"] });
const eventValues = (v: z.infer<typeof zEvent>) => ({
  date: v.date,
  startTime: v.startTime || null,
  // an end time only with a start time
  endTime: v.startTime ? v.endTime || null : null,
  title: v.title,
  note: v.note || null,
  userId: v.userId || null,
});

/** The ticket an event is about, read from the ticket source (never the number/title the browser sends) */
async function eventTicket(id: number | null | undefined) {
  if (!id) return { ticketId: null, ticketNumber: null, ticketTitle: null };
  const src = await ticketSource();
  const tk = await run(() => src.get(id));
  if (!tk) throw new HTTPException(400, { message: "invalid_ticket" });
  return { ticketId: tk.id, ticketNumber: tk.number, ticketTitle: tk.title };
}

async function checkMember(userId: string) {
  if (!(await team()).some((u) => u.id === userId)) throw new HTTPException(400, { message: "invalid_member" });
}

/** Replace the project's team (only active staff; anything else is refused). */
async function setMembers(projectId: string, ids: string[]) {
  const wanted = [...new Set(ids)];
  const allowed = new Set((await team()).map((u) => u.id));
  if (wanted.some((id) => !allowed.has(id))) throw new HTTPException(400, { message: "invalid_member" });
  await db().delete(schema.meetingProjectMembers).where(eq(schema.meetingProjectMembers.projectId, projectId));
  if (wanted.length)
    await db()
      .insert(schema.meetingProjectMembers)
      .values(wanted.map((userId) => ({ projectId, userId })));
}

const zProject = z.object({
  title: z.string().trim().min(1).max(200),
  memberIds: z.array(zUuid).max(50).optional(),
  client: zOptText(200),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});

function projectId(v: string) {
  const r = zUuid.safeParse(v);
  if (!r.success) throw new HTTPException(404, { message: "not_found" });
  return r.data;
}
