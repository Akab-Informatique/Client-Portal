import { Hono } from "hono";
import { requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { lookup, run } from "./tickets.ts";

/**
 * Weekly team meeting dashboard (meetings.view). Tickets: every technician
 * with their open tickets past the due date, the most overdue first.
 */
export const meetingRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("meetings.view"))

  .get("/overdue", async (c) => {
    const src = await ticketSource();
    const [all, o, technicians] = await run(() => Promise.all([src.list(), src.options(), src.technicians()]));
    const L = lookup(o);
    const now = Date.now();
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    const overdue = all.filter((t) => open(t) && new Date(t.dueAt).getTime() < now).sort((x, y) => x.dueAt.localeCompare(y.dueAt));
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
      secondary: t.secondary.map((p) => p.name),
    });

    // Every technician (linked in the portal, or with open tickets in the source), even with none overdue
    const openBy = new Set(all.filter(open).flatMap((t) => (t.assignee ? [t.assignee.id] : [])));
    const people = new Map(technicians.filter((p) => src.demo || !p.id.startsWith("at-") || openBy.has(p.id)).map((p) => [p.id, p.name]));
    for (const t of overdue) if (t.assignee && !people.has(t.assignee.id)) people.set(t.assignee.id, t.assignee.name);
    const byTech = [...people].map(([id, name]) => ({ id, name, tickets: overdue.filter((t) => t.assignee?.id === id).map(item) }));
    byTech.sort((x, y) => y.tickets.length - x.tickets.length || x.name.localeCompare(y.name));

    return c.json({
      demo: src.demo,
      total: overdue.length,
      technicians: byTech,
      unassigned: overdue.filter((t) => !t.assignee).map(item),
    });
  });
