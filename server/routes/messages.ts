import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { sendTemplate } from "../lib/mail.ts";
import { notifyMessagePosted } from "../lib/notify.ts";
import { body, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { billingSettings } from "../lib/billing.ts";
import { SourceError, ticketSource } from "../lib/ticketSource.ts";
import { contactOfUser, ticketCompanyOf } from "../lib/clientTickets.ts";

type MessageRow = typeof schema.messages.$inferSelect;

async function decorate(rows: MessageRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const d = db();
  const targets = await d
    .select({ messageId: schema.messageTargets.messageId, id: schema.clients.id, name: schema.clients.name })
    .from(schema.messageTargets)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.messageTargets.clientId))
    .where(inArray(schema.messageTargets.messageId, ids));
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter((x): x is string => Boolean(x)))];
  const authors = authorIds.length
    ? await d.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, authorIds))
    : [];
  const reads = await d
    .select({ messageId: schema.messageReads.messageId, n: sql<number>`count(*)::int` })
    .from(schema.messageReads)
    .where(inArray(schema.messageReads.messageId, ids))
    .groupBy(schema.messageReads.messageId);
  return rows.map((m) => ({
    ...m,
    author: authors.find((a) => a.id === m.authorId)?.name ?? null,
    clients: targets.filter((t) => t.messageId === m.id).map((t) => ({ id: t.id, name: t.name })),
    readCount: reads.find((r) => r.messageId === m.id)?.n ?? 0,
  }));
}

/** Active client users who opted in to email copies, for the message's audience. */
async function emailRecipients(audience: "all" | "selected", clientIds: string[]) {
  const d = db();
  const conds = [
    eq(schema.users.kind, "client"),
    eq(schema.users.active, true),
    eq(schema.users.notifyEmail, true),
    eq(schema.clients.active, true),
    // a company whose portal is not open yet gets nothing
    eq(schema.clients.portalEnabled, true),
  ];
  if (audience === "selected") {
    if (!clientIds.length) return [];
    conds.push(inArray(schema.users.clientId, clientIds));
  }
  return d
    .select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
    .from(schema.users)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.users.clientId))
    .where(and(...conds));
}

async function sendCopies(message: MessageRow, clientIds: string[]): Promise<number> {
  const recipients = await emailRecipients(message.audience, clientIds);
  let sent = 0;
  const portal = config.publicUrl ? `${config.publicUrl}/` : "";
  for (const r of recipients) {
    const ok = await sendTemplate("boardMessage", r, { name: r.name, title: message.title, body: message.body, portalUrl: portal });
    if (ok) sent++;
  }
  await db().update(schema.messages).set({ emailSent: sent }).where(eq(schema.messages.id, message.id));
  return sent;
}

const messageInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  pinned: z.boolean().default(false),
  audience: z.enum(["all", "selected"]),
  clientIds: z.array(zUuid).max(1000).default([]),
  emailCopy: z.boolean().default(false),
});

// ── Staff side ───────────────────────────────────────────────────────────────
export const messageRoutes = new Hono<AppEnv>()
  .get("/", requirePermission("messages.view"), async (c) => {
    const rows = await db()
      .select()
      .from(schema.messages)
      .orderBy(desc(schema.messages.pinned), desc(schema.messages.createdAt))
      .limit(200);
    return c.json(await decorate(rows));
  })

  /** Clients a message can target (does not require admin rights). */
  .get("/client-options", requirePermission("messages.post"), async (c) => {
    const rows = await db()
      .select({
        id: schema.clients.id,
        name: schema.clients.name,
        code: schema.clients.code,
        notifyCount: sql<number>`(select count(*)::int from users u where u.client_id = "clients"."id" and u.active and u.notify_email)`,
      })
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(asc(schema.clients.name));
    return c.json(rows);
  })

  .post("/", requirePermission("messages.post"), async (c) => {
    const a = auth(c);
    const p = await body(c, messageInput);
    if (p.pinned && !a.permissions.includes("messages.pin")) throw new HTTPException(403, { message: "Forbidden" });
    if (p.emailCopy && !a.permissions.includes("messages.email")) throw new HTTPException(403, { message: "Forbidden" });
    const clientIds = p.audience === "selected" ? [...new Set(p.clientIds)] : [];
    if (p.audience === "selected") {
      if (!clientIds.length) throw new HTTPException(400, { message: "no_clients" });
      const found = await db().select({ id: schema.clients.id }).from(schema.clients).where(inArray(schema.clients.id, clientIds));
      if (found.length !== clientIds.length) throw new HTTPException(400, { message: "invalid_client" });
    }
    const [m] = await db()
      .insert(schema.messages)
      .values({ title: p.title, body: p.body, pinned: p.pinned, audience: p.audience, authorId: a.user.id, emailCopy: p.emailCopy })
      .returning();
    if (clientIds.length) {
      await db().insert(schema.messageTargets).values(clientIds.map((clientId) => ({ messageId: m.id, clientId })));
    }
    await audit(a.user.id, "message.posted", m.id, { audience: p.audience, clients: clientIds.length, emailCopy: p.emailCopy });
    // Email copies go out in the background; the count is stored on the message.
    if (p.emailCopy) void sendCopies(m, clientIds).catch((e) => console.error("[messages] email copies failed", e));
    // Bell notifications for the targeted clients and the other technicians
    await notifyMessagePosted(m, clientIds, a.user.id, a.user.name);
    return c.json((await decorate([m]))[0], 201);
  })

  .patch("/:id", requirePermission("messages.post", "messages.pin", "messages.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, id));
    if (!m) throw new HTTPException(404, { message: "not_found" });
    const p = await body(
      c,
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().trim().min(1).max(10_000).optional(),
        pinned: z.boolean().optional(),
      }),
    );
    if (p.pinned !== undefined && !a.permissions.includes("messages.pin")) throw new HTTPException(403, { message: "Forbidden" });
    const editsContent = p.title !== undefined || p.body !== undefined;
    const own = m.authorId === a.user.id && a.permissions.includes("messages.post");
    if (editsContent && !own && !a.permissions.includes("messages.manage")) throw new HTTPException(403, { message: "Forbidden" });
    const [row] = await db()
      .update(schema.messages)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.messages.id, id))
      .returning();
    await audit(a.user.id, "message.updated", id, p);
    return c.json((await decorate([row]))[0]);
  })

  .delete("/:id", requirePermission("messages.post", "messages.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, id));
    if (!m) throw new HTTPException(404, { message: "not_found" });
    const own = m.authorId === a.user.id;
    if (!own && !a.permissions.includes("messages.manage")) throw new HTTPException(403, { message: "Forbidden" });
    await db().delete(schema.messages).where(eq(schema.messages.id, id));
    // Its bell notifications would point to nothing — remove them for everyone
    await db()
      .delete(schema.notifications)
      .where(and(eq(schema.notifications.type, "message.new"), sql`${schema.notifications.data}->>'messageId' = ${id}`));
    await audit(a.user.id, "message.deleted", id, { title: m.title });
    return c.json({ ok: true });
  });

// ── Client side (receiving module) ───────────────────────────────────────────
export const boardRoutes = new Hono<AppEnv>()
  .get("/", requirePermission("board.view"), async (c) => {
    const a = auth(c);
    if (a.user.kind !== "client" || !a.user.clientId) throw new HTTPException(403, { message: "Forbidden" });
    const clientId = a.user.clientId;
    const rows = await db()
      .select({
        message: schema.messages,
        readAt: schema.messageReads.readAt,
      })
      .from(schema.messages)
      .leftJoin(
        schema.messageReads,
        and(eq(schema.messageReads.messageId, schema.messages.id), eq(schema.messageReads.userId, a.user.id)),
      )
      .where(
        or(
          eq(schema.messages.audience, "all"),
          exists(
            db()
              .select({ x: sql`1` })
              .from(schema.messageTargets)
              .where(and(eq(schema.messageTargets.messageId, schema.messages.id), eq(schema.messageTargets.clientId, clientId))),
          ),
        ),
      )
      .orderBy(desc(schema.messages.pinned), desc(schema.messages.createdAt))
      .limit(200);
    return c.json(
      rows.map((r) => ({
        id: r.message.id,
        title: r.message.title,
        body: r.message.body,
        pinned: r.message.pinned,
        createdAt: r.message.createdAt,
        read: Boolean(r.readAt),
      })),
    );
  })
  .post("/:id/read", requirePermission("board.view"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    if (a.user.kind !== "client" || !a.user.clientId) throw new HTTPException(403, { message: "Forbidden" });
    await visibleMessage(id, a.user.clientId);
    await db().insert(schema.messageReads).values({ messageId: id, userId: a.user.id }).onConflictDoNothing();
    return c.json({ ok: true });
  })

  /** AKAB's support phone / email, shown under every message (Admin › Billing › Company). */
  .get("/contact", requirePermission("board.view"), async (c) => {
    const { company } = await billingSettings();
    return c.json({ phone: company.phone || null, email: company.email || null });
  })

  /**
   * A client's question about a message: a support ticket for their company,
   * with them as the contact when they are one. Clients cannot write on the
   * board itself; technicians in client view cannot do this (read-only).
   */
  .post("/:id/ticket", requirePermission("board.ticket"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    if (a.user.kind !== "client" || !a.user.clientId) throw new HTTPException(403, { message: "Forbidden" });
    const { question } = await body(c, z.object({ question: z.string().trim().min(1).max(4000) }));
    const m = await visibleMessage(id, a.user.clientId);
    if (!rateLimit(`board-ticket:${a.user.id}`, 10, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    try {
      const src = await ticketSource();
      const company = await ticketCompanyOf(a.user.clientId, src, { create: true });
      if (!company) throw new HTTPException(409, { message: "board_not_linked" });
      // Not a contact yet: they become one, so the ticket shows in their "My tickets"
      let contactId = await contactOfUser(a.user, company.id, src);
      if (!contactId) {
        const [first, ...rest] = a.user.name.trim().split(/\s+/);
        const added = await src
          .addContact(company.id, { firstName: first || a.user.email, lastName: rest.join(" ") || "-", email: a.user.email, phone: a.user.phone ?? null }, a)
          .catch((e) => {
            console.warn("[board] contact not added:", e);
            return null;
          });
        contactId = added?.id ?? null;
      }
      const o = await src.options();
      const priority = (o.priorities.find((x) => x.kind === "medium") ?? o.priorities[0])?.value ?? "";
      const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const posted = new Date(m.createdAt).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
      const description = [
        `Question de ${a.user.name} (${a.user.email}), envoyée depuis le portail client :`,
        "",
        question,
        "",
        "---",
        `Au sujet du message du babillard « ${m.title} » (publié le ${posted}) :`,
        "",
        m.body,
      ]
        .join("\n")
        .slice(0, 8000);
      const ticketId = await src.create(
        { title: `Question — ${m.title}`.slice(0, 250), description, companyId: company.id, contactId, priority, queue: o.queues[0]?.value ?? "", assigneeId: null, dueDate: due },
        a,
      );
      const t = await src.get(ticketId).catch(() => null);
      await audit(a.user.id, "board.ticket", String(ticketId), { messageId: id });
      return c.json({ id: ticketId, number: t?.number ?? null }, 201);
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      if (e instanceof SourceError) {
        console.error("[board] ticket:", e);
        throw new HTTPException(502, { message: "board_ticket_failed" });
      }
      throw e;
    }
  });

/** A message this client company may see (all clients, or targeted at it); 404 otherwise. */
async function visibleMessage(id: string, clientId: string) {
  const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, id));
  if (!m) throw new HTTPException(404, { message: "not_found" });
  if (m.audience === "selected") {
    const [t] = await db()
      .select()
      .from(schema.messageTargets)
      .where(and(eq(schema.messageTargets.messageId, id), eq(schema.messageTargets.clientId, clientId)));
    if (!t) throw new HTTPException(404, { message: "not_found" });
  }
  return m;
}

