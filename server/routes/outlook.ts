import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { asConnection, O365Error, o365Ready } from "../lib/o365.ts";
import {
  attachment,
  getMessage,
  listFolders,
  listMessages,
  MAX_ATTACHMENT_BYTES,
  messageText,
  moveMessage,
  respond,
  sendMail,
  testMailbox,
  updateMessage,
  type OutgoingAttachment,
} from "../lib/outlook.ts";
import { AutotaskError } from "../lib/autotask.ts";
import { SourceError, ticketSource } from "../lib/ticketSource.ts";

const MAX_ACCOUNTS = 20;

/** Graph / ticket errors → HTTP (message "outlook_<code>"). */
function outlookHttp(e: unknown): HTTPException {
  if (e instanceof HTTPException) return e;
  if (e instanceof O365Error) {
    const status = e.code === "not_configured" ? 409 : e.code === "not_found" ? 404 : 502;
    return new HTTPException(status, { message: `outlook_${e.code}`, cause: e.detail ? [{ path: "outlook", message: e.detail }] : undefined });
  }
  if (e instanceof AutotaskError) return new HTTPException(502, { message: `autotask_${e.code}`, cause: e.detail ? [{ path: "autotask", message: e.detail }] : undefined });
  if (e instanceof SourceError) return new HTTPException(400, { message: e.code });
  console.error("[outlook]", e);
  return new HTTPException(500, { message: "Internal error" });
}
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw outlookHttp(e);
  }
}

/** The technician's own AKAB addresses (portal email and Microsoft 365 mailbox). */
function ownAddresses(a: AuthContext): string[] {
  return [...new Set([a.user.email, a.user.o365Email].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()))];
}

/** The technician's own Microsoft sign-in, if any. */
async function signInOf(userId: string) {
  const [conn] = await db().select({ email: schema.msConnections.email, lastError: schema.msConnections.lastError }).from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  return conn ?? null;
}

/** A mailbox linked by this technician (nobody else can open it). */
async function account(a: AuthContext, id: string) {
  const [acc] = await db()
    .select()
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.id, zUuid.parse(id)), eq(schema.mailAccounts.userId, a.user.id)));
  if (!acc) throw new HTTPException(404, { message: "not_found" });
  return acc;
}

const zMessageId = z.string().min(1).max(400);
const zAddressList = z.array(zEmail).max(100).default([]);
const zAttachments = z
  .array(z.object({ name: z.string().trim().min(1).max(200), contentType: z.string().max(120).default("application/octet-stream"), data: z.string().max(5_000_000) }))
  .max(10)
  .default([]);

/** Decoded size of the files; Graph refuses one request above ~4 MB. */
function checkAttachments(list: OutgoingAttachment[]) {
  const bytes = list.reduce((n, f) => n + Math.floor((f.data.length * 3) / 4), 0);
  if (bytes > MAX_ATTACHMENT_BYTES) throw new HTTPException(413, { message: "outlook_attachments_too_large" });
}

export const outlookRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("outlook.view"))
  // the module is turned on by the technician (profile › Microsoft 365)
  .use(async (c, next) => {
    const [p] = await db().select({ on: schema.userPreferences.outlook }).from(schema.userPreferences).where(eq(schema.userPreferences.userId, auth(c).user.id));
    if (!p?.on) throw new HTTPException(403, { message: "outlook_off" });
    await next();
  })
  // a mailbox reached through the technician's own sign-in: Graph calls go out as them
  .use("/accounts/:id/*", async (c, next) => {
    const acc = await account(auth(c), c.req.param("id") ?? "");
    try {
      await asConnection(acc.via === "user" ? acc.userId : null, () => next());
    } catch (e) {
      throw outlookHttp(e);
    }
  })

  /** Is Microsoft 365 set up, which mailboxes are linked, what may be linked. */
  .get("/status", async (c) => {
    const a = auth(c);
    const accounts = await db()
      .select({ id: schema.mailAccounts.id, address: schema.mailAccounts.address, displayName: schema.mailAccounts.displayName, via: schema.mailAccounts.via })
      .from(schema.mailAccounts)
      .where(eq(schema.mailAccounts.userId, a.user.id))
      .orderBy(asc(schema.mailAccounts.createdAt));
    const conn = await signInOf(a.user.id);
    return c.json({
      ready: await o365Ready(),
      signedIn: conn ? { email: conn.email, needsReconnect: conn.lastError === "reconnect" } : null,
      accounts,
      ownAddresses: ownAddresses(a),
      canLinkAny: a.permissions.includes("outlook.anyMailbox"),
      canSend: a.permissions.includes("outlook.send"),
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    });
  })

  /**
   * Link an AKAB mailbox: one's own through one's Microsoft sign-in (the
   * technician sets it up on their side), or any mailbox with
   * outlook.anyMailbox (the organisation access).
   */
  .post("/accounts", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ address: zEmail }));
    const address = p.address.toLowerCase();
    const conn = await signInOf(a.user.id);
    const mine = conn?.email.toLowerCase() === address;
    if (!mine && !a.permissions.includes("outlook.anyMailbox")) {
      throw new HTTPException(403, { message: ownAddresses(a).includes(address) || !conn ? "outlook_sign_in_first" : "outlook_not_own_mailbox" });
    }
    if (!(await o365Ready())) throw new HTTPException(409, { message: "outlook_not_configured" });
    if (!rateLimit(`outlook-link:${a.user.id}`, 20, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const [{ n }] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.mailAccounts)
      .where(eq(schema.mailAccounts.userId, a.user.id));
    if (n >= MAX_ACCOUNTS) throw new HTTPException(409, { message: "outlook_too_many" });
    const [dup] = await db()
      .select({ id: schema.mailAccounts.id })
      .from(schema.mailAccounts)
      .where(and(eq(schema.mailAccounts.userId, a.user.id), sql`lower(${schema.mailAccounts.address}) = ${address}`));
    if (dup) throw new HTTPException(409, { message: "outlook_already_linked" });
    const { displayName } = await run(() => asConnection(mine ? a.user.id : null, () => testMailbox(address)));
    const [row] = await db()
      .insert(schema.mailAccounts)
      .values({ userId: a.user.id, address, displayName, via: mine ? "user" : "app" })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HTTPException(409, { message: "outlook_already_linked" });
    await audit(a.realUser.id, "outlook.linked", row.id, { address, via: row.via });
    return c.json({ id: row.id, address: row.address, displayName: row.displayName, via: row.via }, 201);
  })

  .delete("/accounts/:id", async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    await db().delete(schema.mailAccounts).where(eq(schema.mailAccounts.id, acc.id));
    await audit(a.realUser.id, "outlook.unlinked", acc.id, { address: acc.address });
    return c.json({ ok: true });
  })

  .get("/accounts/:id/folders", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const parent = c.req.query("parent");
    return c.json(await run(() => listFolders(acc.address, parent ? zMessageId.parse(parent) : undefined)));
  })

  .get("/accounts/:id/messages", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const folder = zMessageId.parse(c.req.query("folder") || "inbox");
    const cursor = c.req.query("cursor");
    return c.json(await run(() => listMessages(acc.address, folder, { search: c.req.query("q") ?? "", cursor: cursor ? z.string().max(4000).parse(cursor) : undefined })));
  })

  /** Opening a message marks it as read, like Outlook. */
  .get("/accounts/:id/messages/:mid", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const mid = zMessageId.parse(c.req.param("mid"));
    const m = await run(() => getMessage(acc.address, mid));
    if (!m.isRead) await updateMessage(acc.address, mid, { isRead: true }).catch(() => undefined);
    return c.json({ ...m, isRead: true });
  })

  .patch("/accounts/:id/messages/:mid", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const p = await body(c, z.object({ isRead: z.boolean().optional(), flagged: z.boolean().optional() }));
    await run(() => updateMessage(acc.address, zMessageId.parse(c.req.param("mid")), p));
    return c.json({ ok: true });
  })

  .post("/accounts/:id/messages/:mid/move", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const p = await body(c, z.object({ destination: zMessageId }));
    const id = await run(() => moveMessage(acc.address, zMessageId.parse(c.req.param("mid")), p.destination));
    return c.json({ ok: true, id });
  })

  /** Delete = move to Deleted Items (recoverable in Outlook). */
  .delete("/accounts/:id/messages/:mid", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    await run(() => moveMessage(acc.address, zMessageId.parse(c.req.param("mid")), "deleteditems"));
    return c.json({ ok: true });
  })

  /** Always downloaded as a file (never rendered by the portal's page). */
  .get("/accounts/:id/messages/:mid/attachments/:aid", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const f = await run(() => attachment(acc.address, zMessageId.parse(c.req.param("mid")), zMessageId.parse(c.req.param("aid"))));
    const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  })

  .post("/accounts/:id/send", requirePermission("outlook.send"), async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const p = await body(
      c,
      z.object({
        to: z.array(zEmail).min(1).max(100),
        cc: zAddressList,
        bcc: zAddressList,
        subject: z.string().trim().max(250).default(""),
        text: z.string().max(100_000).default(""),
        attachments: zAttachments,
      }),
    );
    checkAttachments(p.attachments);
    if (!rateLimit(`outlook-send:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    await run(() => sendMail(acc.address, p));
    await audit(a.realUser.id, "outlook.sent", acc.id, { from: acc.address, to: p.to.length + p.cc.length + p.bcc.length, files: p.attachments.length });
    return c.json({ ok: true }, 201);
  })

  .post("/accounts/:id/messages/:mid/respond", requirePermission("outlook.send"), async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const p = await body(
      c,
      z.object({
        mode: z.enum(["reply", "replyAll", "forward"]),
        text: z.string().max(100_000).default(""),
        to: zAddressList,
        cc: zAddressList,
        attachments: zAttachments,
      }),
    );
    if (p.mode === "forward" && !p.to.length) throw new HTTPException(400, { message: "outlook_no_recipient" });
    checkAttachments(p.attachments);
    if (!rateLimit(`outlook-send:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    await run(() => respond(acc.address, zMessageId.parse(c.req.param("mid")), p.mode, p));
    await audit(a.realUser.id, `outlook.${p.mode}`, acc.id, { from: acc.address, files: p.attachments.length });
    return c.json({ ok: true }, 201);
  })

  /** Copy the email into a ticket as an internal note. */
  .post("/accounts/:id/messages/:mid/to-ticket", requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const p = await body(c, z.object({ ticketId: z.number().int().positive() }));
    const m = await run(() => messageText(acc.address, zMessageId.parse(c.req.param("mid"))));
    const who = (x: { name: string | null; address: string } | null) => (x ? (x.name ? `${x.name} <${x.address}>` : x.address) : "—");
    const header = [
      `Courriel ajouté depuis Outlook (${acc.address})`,
      `De : ${who(m.from)}`,
      `À : ${m.to.map(who).join(", ") || "—"}`,
      ...(m.cc.length ? [`Cc : ${m.cc.map(who).join(", ")}`] : []),
      `Date : ${m.receivedAt ? new Date(m.receivedAt).toLocaleString("fr-CA", { timeZone: "America/Toronto" }) : "—"}`,
      `Objet : ${m.subject || "—"}`,
    ].join("\n");
    const text = `${header}\n\n${m.text}`.slice(0, 8000);
    const src = await ticketSource();
    await run(() => src.addNote(p.ticketId, { text, internal: true }, a));
    await audit(a.realUser.id, "outlook.to_ticket", String(p.ticketId), { from: acc.address });
    return c.json({ ok: true }, 201);
  })

  /** Text of an email, to prefill a new ticket. */
  .get("/accounts/:id/messages/:mid/text", requirePermission("tickets.edit"), async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const m = await run(() => messageText(acc.address, zMessageId.parse(c.req.param("mid"))));
    return c.json({ subject: m.subject, from: m.from, receivedAt: m.receivedAt, text: m.text.slice(0, 7000) });
  });
