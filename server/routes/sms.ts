import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
import { body, zUuid } from "../lib/validate.ts";
import { conversationForTicket, mapConversation, openTicket, queueReceived, replyAsTechnician, SmsTicketError } from "../lib/sms.ts";
import { normalizePhone, SmsError, smsReady, smsSettings, SMS_MAX, tokenMatches } from "../lib/voipms.ts";
import { SourceError, ticketSource } from "../lib/ticketSource.ts";

/**
 * VoIP.ms "SMS URL Callback": called for each text received, with our secret
 * token. Answers "ok" (what VoIP.ms expects), and never says why a call was
 * refused.
 */
export const smsHookRoutes = new Hono<AppEnv>().get("/voipms", async (c) => {
  if (!rateLimit(`sms-hook:${clientIp(c)}`, 120, 60_000).ok) return c.text("ok");
  const q = c.req.query();
  if (!(await tokenMatches(q.token))) {
    console.warn("[sms] callback refused (bad token)");
    return c.text("ok");
  }
  // answered at once: VoIP.ms waits for this answer, and a text sent to it
  // meanwhile (the automatic reply) would time out. The text is handled just after.
  void queueReceived({ from: q.from ?? "", message: q.message ?? "", id: q.id || null });
  return c.text("ok");
});

/** Errors of sending / ticket creation → HTTP. */
export function smsHttp(e: unknown): HTTPException {
  if (e instanceof HTTPException) return e;
  if (e instanceof SmsError) return new HTTPException(e.code === "not_configured" || e.code === "disabled" ? 409 : 502, { message: `sms_${e.code}`, cause: e.detail ? [{ path: "sms", message: e.detail }] : undefined });
  if (e instanceof SmsTicketError) return new HTTPException(e.code === "unknown_client" || e.code === "unknown_contact" ? 400 : 409, { message: `sms_${e.code}` });
  if (e instanceof SourceError) return new HTTPException(400, { message: e.code });
  console.error("[sms]", e);
  return new HTTPException(500, { message: "Internal error" });
}
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw smsHttp(e);
  }
}

async function conversation(id: string) {
  const [c] = await db().select().from(schema.smsConversations).where(eq(schema.smsConversations.id, id));
  if (!c) throw new HTTPException(404, { message: "not_found" });
  return c;
}

/** Text conversations: every technician with sms.view sees and answers them. */
export const smsRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("sms.view"))

  /** For the tile: conversations waiting for a reply, unread texts. */
  .get("/summary", async (c) => {
    const [r] = await db()
      .select({
        waiting: sql<number>`count(*) filter (where ${schema.smsConversations.status} = 'waiting')`.mapWith(Number),
        unread: sql<number>`coalesce(sum(${schema.smsConversations.unread}) filter (where ${schema.smsConversations.status} <> 'closed'), 0)`.mapWith(Number),
        open: sql<number>`count(*) filter (where ${schema.smsConversations.status} in ('waiting', 'open'))`.mapWith(Number),
        next: sql<string | null>`min(${schema.smsConversations.autoTicketAt}) filter (where ${schema.smsConversations.status} = 'waiting')`,
      })
      .from(schema.smsConversations);
    return c.json({ ...r, ready: await smsReady(), longAsMms: (await smsSettings()).longAsMms });
  })

  /** Conversations, newest first (closed ones on demand). */
  .get("/conversations", async (c) => {
    const all = c.req.query("all") === "1";
    return c.json(
      await db()
        .select()
        .from(schema.smsConversations)
        .where(all ? undefined : ne(schema.smsConversations.status, "closed"))
        .orderBy(desc(schema.smsConversations.lastMessageAt))
        .limit(200),
    );
  })

  /** One conversation with its texts (reading it marks it read). */
  .get("/conversations/:id", async (c) => {
    const conv = await conversation(zUuid.parse(c.req.param("id")));
    const messages = await db()
      .select({
        id: schema.smsMessages.id,
        direction: schema.smsMessages.direction,
        body: schema.smsMessages.body,
        auto: schema.smsMessages.auto,
        status: schema.smsMessages.status,
        error: schema.smsMessages.error,
        createdAt: schema.smsMessages.createdAt,
        author: schema.users.name,
      })
      .from(schema.smsMessages)
      .leftJoin(schema.users, eq(schema.users.id, schema.smsMessages.userId))
      .where(eq(schema.smsMessages.conversationId, conv.id))
      .orderBy(asc(schema.smsMessages.createdAt));
    if (conv.unread) await db().update(schema.smsConversations).set({ unread: 0 }).where(eq(schema.smsConversations.id, conv.id));
    return c.json({ ...conv, unread: 0, messages, max: SMS_MAX });
  })

  /** A technician's reply (stops the automatic ticket). */
  .post("/conversations/:id/messages", async (c) => {
    const a = auth(c);
    const conv = await conversation(zUuid.parse(c.req.param("id")));
    if (!rateLimit(`sms-send:${a.realUser.id}`, 60, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, z.object({ body: z.string().trim().min(1).max(1000) }));
    await run(() => replyAsTechnician(conv, p.body, a));
    return c.json({ ok: true }, 201);
  })

  /** Open a ticket now (the client is told its number), or link to an existing ticket. */
  .post("/conversations/:id/ticket", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const conv = await conversation(zUuid.parse(c.req.param("id")));
    const p = await body(
      c,
      z.object({
        ticketId: z.number().int().positive().optional(),
        ticketNumber: z.string().max(40).optional(),
        // a number nobody knows: the client (and contact) the technician picked
        companyId: z.number().int().min(0).optional(),
        contactId: z.string().max(40).nullable().optional(),
      }),
    );
    if (p.ticketId) {
      await db()
        .update(schema.smsConversations)
        .set({ status: "ticket", ticketId: p.ticketId, ticketNumber: p.ticketNumber ?? String(p.ticketId), autoTicketAt: null, updatedAt: new Date() })
        .where(eq(schema.smsConversations.id, conv.id));
      await audit(a.realUser.id, "sms.linked", conv.id, { ticketId: p.ticketId });
      return c.json({ id: p.ticketId, number: p.ticketNumber ?? String(p.ticketId) });
    }
    const mapped = p.companyId !== undefined ? await run(() => mapConversation(conv, { companyId: p.companyId!, contactId: p.contactId ?? null })) : conv;
    if (mapped !== conv) await audit(a.realUser.id, "sms.mapped", conv.id, { companyId: mapped.companyId, contactId: mapped.contactId });
    return c.json(await run(() => openTicket(mapped, a)), 201);
  })

  /** Done: the next text from this number starts a new conversation. */
  .post("/conversations/:id/close", async (c) => {
    const a = auth(c);
    const conv = await conversation(zUuid.parse(c.req.param("id")));
    await db().update(schema.smsConversations).set({ status: "closed", autoTicketAt: null, unread: 0, updatedAt: new Date() }).where(eq(schema.smsConversations.id, conv.id));
    await audit(a.realUser.id, "sms.closed", conv.id, {});
    return c.json({ ok: true });
  })

  /** Every closed conversation, deleted with its texts. */
  .delete("/conversations", async (c) => {
    const a = auth(c);
    if (c.req.query("closed") !== "1") throw new HTTPException(400, { message: "invalid_value" });
    const gone = await db().delete(schema.smsConversations).where(eq(schema.smsConversations.status, "closed")).returning({ id: schema.smsConversations.id });
    await audit(a.realUser.id, "sms.deleted_closed", null, { count: gone.length });
    return c.json({ ok: true, deleted: gone.length });
  })

  /** A conversation deleted for good, with its texts (the ticket it made, if any, stays). The next text from this number starts a new one. */
  .delete("/conversations/:id", async (c) => {
    const a = auth(c);
    const conv = await conversation(zUuid.parse(c.req.param("id")));
    await db().delete(schema.smsConversations).where(eq(schema.smsConversations.id, conv.id));
    await audit(a.realUser.id, "sms.deleted", conv.id, { phone: conv.phone, status: conv.status });
    return c.json({ ok: true });
  })

  /** A text to the client from a ticket (to the contact's number, or the one typed). */
  .post("/ticket/:ticketId", async (c) => {
    const a = auth(c);
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId)) throw new HTTPException(400, { message: "invalid_id" });
    if (!rateLimit(`sms-send:${a.realUser.id}`, 60, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    // one number (the ticket's client by default), or several people: a group text
    const p = await body(
      c,
      z.object({
        phone: z.string().max(30).optional(),
        recipients: z.array(z.object({ phone: z.string().max(30), name: z.string().trim().max(120).nullable().optional(), contactId: z.string().max(40).nullable().optional() })).min(1).max(10).optional(),
        groupKey: z.string().uuid().optional(),
        body: z.string().trim().min(1).max(1000),
      }),
    );
    const wanted = p.recipients ?? (p.phone ? [{ phone: p.phone }] : []);
    if (!wanted.length) throw new HTTPException(400, { message: "invalid_phone" });
    const phones = wanted.map((r) => normalizePhone(r.phone));
    if (phones.some((x) => !x)) throw new HTTPException(400, { message: "invalid_phone" });
    if (new Set(phones).size !== phones.length) throw new HTTPException(400, { message: "duplicate_recipient" });
    const src = await ticketSource();
    const t = await run(() => src.get(ticketId));
    if (!t) throw new HTTPException(404, { message: "not_found" });
    // the company's contacts: a contact id must be one of them (never trust the browser), and the ticket's own contact is known by its number
    const contacts = await run(() => src.contacts(t.company.id)).catch(() => []);
    const clientPhone = normalizePhone(contacts.find((x) => x.id === t.contactId)?.phone ?? "");
    const groupKey = wanted.length > 1 ? (p.groupKey ?? crypto.randomUUID()) : null;
    const sent: { phone: string; conversationId: string; ok: boolean }[] = [];
    let firstError: unknown = null;
    for (const [i, r] of wanted.entries()) {
      const own = (Boolean(clientPhone) && phones[i] === clientPhone) || (!("contactId" in r) && wanted.length === 1);
      const known = "contactId" in r && r.contactId ? contacts.find((x) => x.id === r.contactId) : undefined;
      const conv = await conversationForTicket({
        id: t.id,
        number: t.number,
        phone: phones[i]!,
        contactName: known?.name ?? ("name" in r && r.name ? r.name : own ? t.contact || null : null),
        contactId: known?.id ?? (own ? t.contactId : null),
        companyId: t.company.id,
        companyName: t.company.name,
      });
      // one failing number does not stop the others; its failed text stays in its conversation
      const ok = await run(() => replyAsTechnician(conv, p.body, a, groupKey)).then(
        () => true,
        (e) => {
          firstError ??= e;
          return false;
        },
      );
      sent.push({ phone: phones[i]!, conversationId: conv.id, ok });
    }
    // nobody got it: the reason (VoIP.ms's) goes back
    if (sent.every((x) => !x.ok)) throw firstError;
    return c.json({ ok: true, conversationId: sent[0].conversationId, groupKey, sent }, 201);
  })

  /** The texts of a ticket were looked at: their unread count goes back to zero. */
  .post("/ticket/:ticketId/read", async (c) => {
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId)) throw new HTTPException(400, { message: "invalid_id" });
    await db().update(schema.smsConversations).set({ unread: 0 }).where(and(eq(schema.smsConversations.ticketId, ticketId), sql`${schema.smsConversations.unread} > 0`));
    return c.json({ ok: true });
  })

  /** Texts of the conversations linked to a ticket. */
  .get("/ticket/:ticketId", async (c) => {
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId)) throw new HTTPException(400, { message: "invalid_id" });
    const convs = await db().select().from(schema.smsConversations).where(eq(schema.smsConversations.ticketId, ticketId));
    if (!convs.length) return c.json({ conversations: [], messages: [] });
    const messages = await db()
      .select({
        id: schema.smsMessages.id,
        conversationId: schema.smsMessages.conversationId,
        direction: schema.smsMessages.direction,
        body: schema.smsMessages.body,
        auto: schema.smsMessages.auto,
        groupKey: schema.smsMessages.groupKey,
        status: schema.smsMessages.status,
        error: schema.smsMessages.error,
        createdAt: schema.smsMessages.createdAt,
        author: schema.users.name,
      })
      .from(schema.smsMessages)
      .leftJoin(schema.users, eq(schema.users.id, schema.smsMessages.userId))
      .where(and(inArray(schema.smsMessages.conversationId, convs.map((x) => x.id))))
      .orderBy(asc(schema.smsMessages.createdAt));
    return c.json({ conversations: convs, messages });
  });
