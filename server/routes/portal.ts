import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { SYSTEM_ROLES } from "../../shared/permissions.ts";
import { isSmsNote, MAX_TICKET_ATTACHMENT_BYTES, SourceError, ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { body } from "../lib/validate.ts";
import { contactOfUser, ticketCompanyOf } from "../lib/clientTickets.ts";
import { isAlert, lookup, techniciansViewing } from "./tickets.ts";

/**
 * Client portal › Admin settings: what a client's admin may see about their
 * own company. Read only for now; always scoped to the signed-in user's
 * company (auth.user.clientId), never to an id sent by the browser.
 */
function companyOf(a: AuthContext): string {
  if (a.user.kind !== "client" || !a.user.clientId) throw new HTTPException(403, { message: "Forbidden" });
  return a.user.clientId;
}

export const portalRoutes = new Hono<AppEnv>()
  .get("/company", requirePermission("clientAdmin.company"), async (c) => {
    const clientId = companyOf(auth(c));
    const [co] = await db()
      .select({
        name: schema.clients.name,
        email: schema.clients.email,
        phone: schema.clients.phone,
        address: schema.clients.address,
        city: schema.clients.city,
        province: schema.clients.province,
        postalCode: schema.clients.postalCode,
        website: schema.clients.website,
      })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId));
    if (!co) throw new HTTPException(404, { message: "not_found" });
    return c.json(co);
  })

  .get("/users", requirePermission("clientAdmin.users"), async (c) => {
    const clientId = companyOf(auth(c));
    const rows = await db()
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        title: schema.users.title,
        phone: schema.users.phone,
        active: schema.users.active,
        lastLoginAt: schema.users.lastLoginAt,
        roleSlug: schema.roles.slug,
        roleName: schema.roles.name,
      })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(and(eq(schema.users.clientId, clientId), eq(schema.users.kind, "client")))
      .orderBy(asc(schema.users.name));
    return c.json(
      rows.map(({ roleSlug, roleName, ...u }) => {
        const sys = roleSlug ? SYSTEM_ROLES.find((r) => r.slug === roleSlug) : undefined;
        return { ...u, role: roleName ? { fr: sys?.name.fr ?? roleName, en: sys?.name.en ?? roleName } : null };
      }),
    );
  })

  /**
   * The client's tickets (theirs: they are the contact, or one of the other
   * contacts). With clientTickets.all: every ticket of their company
   * (scope=company), or one contact's (scope=contact&contact=<id>).
   * Monitoring alerts, internal notes and hours are never shown to clients.
   */
  .get("/tickets", requirePermission("clientTickets.view"), async (c) => {
    const a = auth(c);
    const clientId = companyOf(a);
    const all = a.permissions.includes("clientTickets.all");
    const q = c.req.query("scope");
    const scope = q === "company" || q === "contact" ? q : "mine";
    if (scope !== "mine" && !all) throw new HTTPException(403, { message: "Forbidden" });
    const ctx = await ticketContext(a, clientId);
    if (!ctx) return c.json({ linked: false, canSeeAll: all, contacts: [], items: [] });
    // the company's contacts, for the filter (only to whom may see everyone's tickets)
    const contacts = all ? (await ctx.src.contacts(ctx.companyId).catch(() => [])).map((x) => ({ id: x.id, name: x.name })) : [];
    let keep: (t: NTicket) => boolean = ctx.mine;
    if (scope === "company") keep = () => true;
    if (scope === "contact") {
      // one or several people of the company (comma separated); one no longer there is ignored
      const known = new Set(contacts.map((x) => x.id));
      const who = [...new Set((c.req.query("contact") ?? "").split(",").map((x) => x.trim()).filter((x) => known.has(x)))].slice(0, 50);
      if (!who.length) throw new HTTPException(404, { message: "not_found" });
      const others = new Set((await Promise.all(who.map((id) => ctx.src.ticketsWithOtherContact(id)))).flat());
      keep = (t) => (t.contactId != null && who.includes(t.contactId)) || others.has(t.id);
    }
    // recent tickets from the list, plus every older resolved one of the company
    const [recent, history] = await Promise.all([ctx.src.list(), ctx.src.companyHistory(ctx.companyId)]);
    const seen = new Set(recent.map((t) => t.id));
    const items = [...recent, ...history.filter((t) => !seen.has(t.id))]
      .filter((t) => ctx.visible(t) && keep(t))
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
      .map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        excerpt: t.description.split("\n").find((l) => l.trim())?.slice(0, 160) ?? "",
        statusKind: ctx.L.statusKind(t.status),
        statusLabel: ctx.L.statusLabel(t.status),
        priorityKind: ctx.L.priorityKind(t.priority),
        contact: t.contact || null,
        mine: ctx.mine(t),
        technician: t.assignee?.name ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    return c.json({ linked: true, canSeeAll: all, contacts, items });
  })

  /**
   * Saved filters of the tickets page: a name and the people of the company
   * whose tickets to show. Each person keeps their own (only for whom may see
   * the whole company's tickets).
   */
  .get("/ticket-filters", requirePermission("clientTickets.all"), async (c) => {
    const rows = await db()
      .select({ id: schema.clientTicketFilters.id, name: schema.clientTicketFilters.name, contactIds: schema.clientTicketFilters.contactIds })
      .from(schema.clientTicketFilters)
      .where(eq(schema.clientTicketFilters.userId, auth(c).user.id))
      .orderBy(asc(schema.clientTicketFilters.name));
    return c.json(rows);
  })

  .post(
    "/ticket-filters",
    requirePermission("clientTickets.all"),
    async (c) => {
      const a = auth(c);
      const p = await body(c, z.object({ name: z.string().trim().min(1).max(60), contactIds: z.array(z.string().max(60)).min(1).max(50) }));
      const mine = await db().select({ id: schema.clientTicketFilters.id }).from(schema.clientTicketFilters).where(eq(schema.clientTicketFilters.userId, a.user.id));
      if (mine.length >= 30) throw new HTTPException(400, { message: "filters_limit" });
      // only people of their own company
      const ctx = await ticketContext(a, companyOf(a));
      const known = new Set((ctx ? await ctx.src.contacts(ctx.companyId).catch(() => []) : []).map((x) => x.id));
      const contactIds = [...new Set(p.contactIds)].filter((id) => known.has(id));
      if (!contactIds.length) throw new HTTPException(400, { message: "filter_no_people" });
      const [row] = await db().insert(schema.clientTicketFilters).values({ userId: a.user.id, name: p.name, contactIds }).returning({ id: schema.clientTicketFilters.id, name: schema.clientTicketFilters.name, contactIds: schema.clientTicketFilters.contactIds });
      return c.json(row, 201);
    },
  )

  .delete("/ticket-filters/:id", requirePermission("clientTickets.all"), async (c) => {
    const a = auth(c);
    const gone = await db()
      .delete(schema.clientTicketFilters)
      .where(and(eq(schema.clientTicketFilters.id, c.req.param("id")), eq(schema.clientTicketFilters.userId, a.user.id)))
      .returning({ id: schema.clientTicketFilters.id });
    if (!gone.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  /** One ticket, with its public activity only, and who at AKAB has it open. */
  .get("/tickets/:id", requirePermission("clientTickets.view"), async (c) => {
    const a = auth(c);
    const { ctx, t } = await ownTicket(a, c.req.param("id"));
    return c.json({
      id: t.id,
      number: t.number,
      title: t.title,
      description: t.description,
      statusKind: ctx.L.statusKind(t.status),
      statusLabel: ctx.L.statusLabel(t.status),
      priorityKind: ctx.L.priorityKind(t.priority),
      contact: t.contact || null,
      mine: ctx.mine(t),
      technician: t.assignee?.name ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      dueAt: t.dueAt,
      startDate: (await db().select({ d: schema.ticketMeta.startDate }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, t.id)))[0]?.d ?? null,
      ...onTicket(t),
      attachments: (t.attachments ?? []).filter((f) => !f.internal).map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.at, author: f.author })),
      activity: t.notes
        .filter((n) => !n.internal && n.text.trim() && !isSmsNote(n.text))
        .map((n) => ({ id: n.id, author: n.author, at: n.at, text: n.text, work: n.kind === "time" }))
        .sort((x, y) => x.at.localeCompare(y.at)),
    });
  })

  /** A follow-up comment or an answer to the technician (a public note in the client's name). */
  .post("/tickets/:id/comments", requirePermission("clientTickets.comment"), async (c) => {
    const a = auth(c);
    const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(6000) }));
    const { ctx, t } = await ownTicket(a, c.req.param("id"));
    limit(a, "comment", 30);
    await run(() => ctx.src.addNote(t.id, { text, internal: false }, a));
    // the client answered: the ticket asks for the team's attention, and a complete one is reopened
    await ctx.src.markNeedsAttention(t.id, { reopen: true }).catch(() => false);
    await audit(a.user.id, "portal.ticket_comment", String(t.id));
    await tellTechnicians(t, a, "comment", text);
    return c.json({ ok: true }, 201);
  })

  /** A document for the technician (one file per request, base64). */
  .post("/tickets/:id/attachments", requirePermission("clientTickets.attach"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().max(120).default("application/octet-stream"),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).min(1).max(Math.ceil(MAX_TICKET_ATTACHMENT_BYTES / 3) * 4),
      }),
    );
    const { ctx, t } = await ownTicket(a, c.req.param("id"));
    limit(a, "file", 20);
    await run(() => ctx.src.addAttachment(t.id, p, a));
    await ctx.src.markNeedsAttention(t.id, { reopen: true }).catch(() => false);
    await audit(a.user.id, "portal.ticket_file", String(t.id), { name: p.name, bytes: Math.floor((p.data.length * 3) / 4) });
    await tellTechnicians(t, a, "file", p.name);
    return c.json({ ok: true }, 201);
  })

  /**
   * Ask for a higher priority: a public note with the reason, and the ticket's
   * technicians (or the dispatchers) are told. The client does not change the
   * priority; AKAB decides. Once per ticket every 4 hours.
   */
  .post("/tickets/:id/escalate", requirePermission("clientTickets.escalate"), async (c) => {
    const a = auth(c);
    const { reason } = await body(c, z.object({ reason: z.string().trim().min(3).max(2000) }));
    const { ctx, t } = await ownTicket(a, c.req.param("id"));
    if (ctx.L.statusKind(t.status) === "complete") throw new HTTPException(409, { message: "portal_ticket_closed" });
    if (!rateLimit(`portal-escalate:${a.user.id}:${t.id}`, 1, 4 * 3600_000).ok) throw new HTTPException(429, { message: "portal_already_escalated" });
    await run(() => ctx.src.addNote(t.id, { text: `Demande d'escalade de priorité par le client :\n${reason}`, internal: false }, a));
    await ctx.src.markNeedsAttention(t.id).catch(() => false);
    await audit(a.user.id, "portal.ticket_escalation", String(t.id));
    await tellTechnicians(t, a, "escalation", reason, true);
    return c.json({ ok: true }, 201);
  });

/**
 * The ticket's technicians (assigned first, then the secondary ones), each
 * marked when they have it open right now; plus anyone else from AKAB on it.
 */
function onTicket(t: NTicket) {
  const open = new Set(techniciansViewing(t.id));
  const people = [
    ...(t.assignee ? [{ name: t.assignee.name, primary: true }] : []),
    ...t.secondary.filter((s) => s.id !== t.assignee?.id).map((s) => ({ name: s.name, primary: false })),
  ];
  const first = (n: string) => n.split(" ")[0];
  return {
    technicians: people.map((p) => ({ ...p, viewing: open.has(p.name) })),
    viewing: [...open].map(first),
  };
}

/** The client's ticket company, and how to tell their own tickets from the rest. */
async function ticketContext(a: AuthContext, clientId: string) {
  const src = await ticketSource();
  const company = await ticketCompanyOf(clientId, src);
  if (!company) return null;
  const [o, contactId] = await Promise.all([src.options(), contactOfUser(a.user, company.id, src)]);
  const others = new Set(contactId ? await src.ticketsWithOtherContact(contactId) : []);
  const L = lookup(o);
  const alert = isAlert(L);
  const name = a.user.name.trim().toLowerCase();
  return {
    src,
    L,
    companyId: company.id,
    companyName: company.name,
    visible: (t: NTicket) => t.company.id === company.id && !alert(t),
    // their tickets: they opened it (the contact) or are one of its other contacts;
    // not a contact yet: by name
    mine: (t: NTicket) => (contactId ? t.contactId === contactId || others.has(t.id) : t.contact.trim().toLowerCase() === name),
  };
}

/** A ticket this client may open: their own, or any of their company with clientTickets.all. 404 otherwise. */
async function ownTicket(a: AuthContext, rawId: string) {
  const clientId = companyOf(a);
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(404, { message: "not_found" });
  const ctx = await ticketContext(a, clientId);
  const t = ctx ? await ctx.src.get(id) : null;
  // the same answer whether it does not exist or is not theirs
  if (!ctx || !t || !ctx.visible(t) || (!ctx.mine(t) && !a.permissions.includes("clientTickets.all"))) {
    throw new HTTPException(404, { message: "not_found" });
  }
  return { ctx, t };
}

function limit(a: AuthContext, what: string, perHour: number) {
  if (!rateLimit(`portal-${what}:${a.user.id}`, perHour, 3600_000).ok) throw new HTTPException(429, { message: "rate_limited" });
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SourceError) {
      console.error("[portal] ticket:", e);
      throw new HTTPException(502, { message: "portal_ticket_failed" });
    }
    throw e;
  }
}

/**
 * The client wrote, sent a file or asked for an escalation: the ticket's
 * technicians are told; nobody on it (or an escalation) → the dispatchers too.
 */
async function tellTechnicians(t: NTicket, a: AuthContext, kind: "comment" | "file" | "escalation", text: string, dispatchers = false) {
  const people = [t.assignee, ...t.secondary].filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => p.id).filter((id) => !id.startsWith("at-"));
  const to = people.length && !dispatchers ? people : [...people, ...(await usersWith("staff", "tickets.plan"))];
  await notify(to, {
    type: "ticket.client",
    data: { kind, number: t.number, title: t.title, from: a.user.name, company: t.company.name, preview: text.slice(0, 140) },
    link: `/tickets?ticket=${t.id}`,
  });
}
