import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { body, zUuid } from "../lib/validate.ts";

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
  const link = config.publicUrl ? `${config.publicUrl}/` : "";
  for (const r of recipients) {
    const fr = r.locale !== "en";
    const intro = fr ? "Nouveau message d'AKAB Informatique" : "New message from AKAB Informatique";
    const cta = fr ? "Ouvrir le portail" : "Open the portal";
    const ok = await sendMail({
      to: r.email,
      subject: `[AKAB] ${message.title}`,
      text: `${intro}\n\n${message.title}\n\n${message.body}\n\n${link ? `${cta}: ${link}` : ""}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px">
  <p style="color:#5a5c63;font-size:13px">${escapeHtml(intro)}</p>
  <h2 style="margin:8px 0 12px;color:#16171b">${escapeHtml(message.title)}</h2>
  <div style="white-space:pre-wrap;color:#16171b;line-height:1.5">${escapeHtml(message.body)}</div>
  ${link ? `<p style="margin-top:24px"><a href="${escapeHtml(link)}" style="background:#ffce1a;color:#1a1204;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(cta)}</a></p>` : ""}
</div>`,
    });
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
    const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, id));
    if (!m) throw new HTTPException(404, { message: "not_found" });
    if (m.audience === "selected") {
      const [t] = await db()
        .select()
        .from(schema.messageTargets)
        .where(and(eq(schema.messageTargets.messageId, id), eq(schema.messageTargets.clientId, a.user.clientId)));
      if (!t) throw new HTTPException(404, { message: "not_found" });
    }
    await db().insert(schema.messageReads).values({ messageId: id, userId: a.user.id }).onConflictDoNothing();
    return c.json({ ok: true });
  });
