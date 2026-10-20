import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { asConnection, O365Error, o365Ready, SHARED_MAIL_SCOPE } from "../lib/o365.ts";
import {
  attachment,
  createFolder,
  deleteFolder,
  emptyFolder,
  getMessage,
  listFolders,
  listMessages,
  markFolderRead,
  moveFolder,
  MAX_ATTACHMENT_BYTES,
  messageText,
  moveMessage,
  renameFolder,
  respond,
  sendMail,
  testMailbox,
  updateMessage,
  type OutgoingAttachment,
} from "../lib/outlook.ts";
import { AutotaskError } from "../lib/autotask.ts";
import { htmlText, sanitizeMailHtml } from "../lib/mailHtml.ts";
import { SourceError, ticketSource } from "../lib/ticketSource.ts";
import { matchSender } from "../lib/mailIntake.ts";

const MAX_ACCOUNTS = 20;

/** Graph / ticket errors → HTTP (message "outlook_<code>"). */
function outlookHttp(e: unknown): HTTPException {
  if (e instanceof HTTPException) return e;
  if (e instanceof O365Error) {
    const status = e.code === "not_configured" ? 409 : e.code === "not_found" ? 404 : 502;
    return new HTTPException(status, { message: `outlook_${e.code}`, cause: e.detail ? [{ path: "outlook", message: e.detail }] : undefined });
  }
  if (e instanceof AutotaskError)
    return new HTTPException(502, { message: `autotask_${e.code}`, cause: e.detail ? [{ path: "autotask", message: e.detail }] : undefined });
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
  const [conn] = await db()
    .select({ email: schema.msConnections.email, lastError: schema.msConnections.lastError, scopes: schema.msConnections.scopes })
    .from(schema.msConnections)
    .where(eq(schema.msConnections.userId, userId));
  return conn ?? null;
}

/** A mailbox linked by this technician (nobody else can open it). */
async function account(a: AuthContext, id: string, opts: { unlinking?: boolean } = {}) {
  const [acc] = await db()
    .select()
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.id, zUuid.parse(id)), eq(schema.mailAccounts.userId, a.user.id)));
  if (!acc) throw new HTTPException(404, { message: "not_found" });
  // a mailbox reached through the organisation access needs the right now, not only when it was linked
  if (acc.via === "app" && !opts.unlinking && !a.permissions.includes("outlook.anyMailbox")) throw new HTTPException(403, { message: "outlook_no_access" });
  return acc;
}

const zMessageId = z.string().min(1).max(400);
const zFolderName = z.string().trim().min(1).max(200);
const zAddressList = z.array(zEmail).max(100).default([]);
const zAttachments = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(200),
      contentType: z.string().max(120).default("application/octet-stream"),
      data: z.string().max(5_000_000),
    }),
  )
  .max(10)
  .default([]);

/** What the compose window sends (new email, reply, reply all, forward). */
const zOutgoing = {
  to: zAddressList,
  cc: zAddressList,
  bcc: zAddressList,
  subject: z.string().trim().max(250).default(""),
  /** HTML from the editor (sanitized here), signature included */
  html: z.string().max(2_000_000).default(""),
  attachments: zAttachments,
  importance: z.enum(["low", "normal", "high"]).default("normal"),
  readReceipt: z.boolean().default(false),
};
const MAX_SIGNATURE = 200_000;

/** Everyone written to joins the technician's address book (or is used once more). */
async function rememberRecipients(userId: string, list: string[]) {
  const now = new Date();
  for (const address of [...new Set(list.map((x) => x.toLowerCase()))].slice(0, 100)) {
    await db()
      .insert(schema.mailContacts)
      .values({ userId, address, source: "sent", timesUsed: 1, lastUsedAt: now })
      .onConflictDoUpdate({
        target: [schema.mailContacts.userId, schema.mailContacts.address],
        set: { timesUsed: sql`${schema.mailContacts.timesUsed} + 1`, lastUsedAt: now },
      });
  }
}

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
    const [p] = await db()
      .select({ on: schema.userPreferences.outlook })
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, auth(c).user.id));
    if (!p?.on) throw new HTTPException(403, { message: "outlook_off" });
    await next();
  })
  // a mailbox reached through the technician's own sign-in: Graph calls go out as them
  .use("/accounts/:id/*", async (c, next) => {
    // unlinking calls nothing at Microsoft
    if (c.req.method === "DELETE" && /^\/api\/outlook\/accounts\/[^/]+\/?$/.test(c.req.path)) return next();
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
      .select({
        id: schema.mailAccounts.id,
        address: schema.mailAccounts.address,
        displayName: schema.mailAccounts.displayName,
        via: schema.mailAccounts.via,
        folderPrefs: schema.mailAccounts.folderPrefs,
      })
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
      signature: (await signatureOf(a.user.id)) ?? "",
    });
  })

  // ── Signature (profile) ──
  .put("/signature", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ html: z.string().max(MAX_SIGNATURE) }));
    const html = sanitizeMailHtml(p.html);
    const value = htmlText(html) || /<img/i.test(html) ? html : null;
    await db()
      .insert(schema.userPreferences)
      .values({ userId: a.user.id, outlook: true, emailSignature: value })
      .onConflictDoUpdate({ target: schema.userPreferences.userId, set: { emailSignature: value, updatedAt: new Date() } });
    return c.json({ html: value ?? "" });
  })

  // ── Address book: everyone written to, plus the ones added by hand ──
  .get("/contacts", async (c) => {
    const a = auth(c);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const limit = Math.min(Number(c.req.query("limit")) || 500, 1000);
    const mc = schema.mailContacts;
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const rows = await db()
      .select({ id: mc.id, address: mc.address, name: mc.name, note: mc.note, source: mc.source, timesUsed: mc.timesUsed, lastUsedAt: mc.lastUsedAt })
      .from(mc)
      .where(and(eq(mc.userId, a.user.id), q ? or(ilike(mc.address, like), ilike(mc.name, like)) : undefined))
      // the people written to most often first
      .orderBy(desc(mc.timesUsed), desc(mc.lastUsedAt), asc(mc.address))
      .limit(limit);
    return c.json(rows);
  })

  .post("/contacts", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ address: zEmail, name: z.string().trim().max(200).optional(), note: z.string().trim().max(1000).optional() }));
    const address = p.address.toLowerCase();
    const [row] = await db()
      .insert(schema.mailContacts)
      .values({ userId: a.user.id, address, name: p.name || null, note: p.note || null, source: "manual" })
      .onConflictDoUpdate({
        target: [schema.mailContacts.userId, schema.mailContacts.address],
        set: { ...(p.name ? { name: p.name } : {}), ...(p.note ? { note: p.note } : {}) },
      })
      .returning({ id: schema.mailContacts.id });
    return c.json({ id: row.id }, 201);
  })

  .patch("/contacts/:cid", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().max(200).nullable().optional(), note: z.string().trim().max(1000).nullable().optional() }));
    const rows = await db()
      .update(schema.mailContacts)
      .set({ ...(p.name !== undefined ? { name: p.name || null } : {}), ...(p.note !== undefined ? { note: p.note || null } : {}) })
      .where(and(eq(schema.mailContacts.id, zUuid.parse(c.req.param("cid"))), eq(schema.mailContacts.userId, a.user.id)))
      .returning({ id: schema.mailContacts.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  .delete("/contacts/:cid", async (c) => {
    const a = auth(c);
    const rows = await db()
      .delete(schema.mailContacts)
      .where(and(eq(schema.mailContacts.id, zUuid.parse(c.req.param("cid"))), eq(schema.mailContacts.userId, a.user.id)))
      .returning({ id: schema.mailContacts.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  /**
   * Link an AKAB mailbox:
   * - one's own, through one's Microsoft sign-in (set up on their side);
   * - a mailbox shared with them in Exchange (e.g. support@), also through
   *   their own sign-in: Microsoft checks their access, now and on every
   *   call — a mailbox they cannot open in Outlook is refused here too;
   * - any mailbox with outlook.anyMailbox (the organisation access, master admins).
   */
  .post("/accounts", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ address: zEmail }));
    const address = p.address.toLowerCase();
    const conn = await signInOf(a.user.id);
    const mine = conn?.email.toLowerCase() === address;
    const anyMailbox = a.permissions.includes("outlook.anyMailbox");
    if (!conn && !anyMailbox) throw new HTTPException(403, { message: "outlook_sign_in_first" });
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
    let via: "user" | "app" = "user";
    let displayName: string | null = null;
    if (conn && (mine || conn.scopes.split(" ").includes(SHARED_MAIL_SCOPE))) {
      // as the technician: Exchange says whether they may open this mailbox
      try {
        ({ displayName } = await asConnection(a.user.id, () => testMailbox(address)));
      } catch (e) {
        const denied = e instanceof O365Error && (e.code === "forbidden" || e.code === "not_found");
        if (!denied || mine) throw outlookHttp(e);
        if (!anyMailbox) {
          await audit(a.realUser.id, "outlook.link_refused", null, { address });
          throw new HTTPException(403, { message: "outlook_no_access" });
        }
        via = "app";
      }
    } else if (anyMailbox) {
      via = "app";
    } else {
      // signed in before shared mailboxes existed: one more sign-in grants it
      throw new HTTPException(403, { message: "outlook_reconnect_shared" });
    }
    if (via === "app") ({ displayName } = await run(() => asConnection(null, () => testMailbox(address))));
    const [row] = await db().insert(schema.mailAccounts).values({ userId: a.user.id, address, displayName, via }).onConflictDoNothing().returning();
    if (!row) throw new HTTPException(409, { message: "outlook_already_linked" });
    await audit(a.realUser.id, "outlook.linked", row.id, { address, via: row.via });
    return c.json({ id: row.id, address: row.address, displayName: row.displayName, via: row.via }, 201);
  })

  .delete("/accounts/:id", async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"), { unlinking: true });
    await db().delete(schema.mailAccounts).where(eq(schema.mailAccounts.id, acc.id));
    await audit(a.realUser.id, "outlook.unlinked", acc.id, { address: acc.address });
    return c.json({ ok: true });
  })

  /** The technician's folder layout for this mailbox (favourites in order, hidden folders). */
  .put("/accounts/:id/folder-prefs", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const zId = z.string().min(1).max(400);
    const p = await body(
      c,
      z.object({
        pinned: z.array(z.object({ id: zId, name: z.string().trim().min(1).max(200) })).max(50),
        hidden: z.array(zId).max(300),
        /** The technician's folder order (ids; folders not listed keep Outlook's order, after) */
        order: z.array(zId).max(500).default([]),
      }),
    );
    const prefs = {
      pinned: p.pinned.filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i),
      hidden: [...new Set(p.hidden)],
      order: [...new Set(p.order)],
    };
    await db().update(schema.mailAccounts).set({ folderPrefs: prefs }).where(eq(schema.mailAccounts.id, acc.id));
    return c.json(prefs);
  })

  /** Folder options: create (top level or inside a folder), rename, delete, mark all read. */
  .post("/accounts/:id/folders", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const p = await body(c, z.object({ name: zFolderName, parentId: zMessageId.optional() }));
    return c.json(await run(() => createFolder(acc.address, p.name, p.parentId)), 201);
  })
  .patch("/accounts/:id/folders/:fid", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    const p = await body(c, z.object({ name: zFolderName }));
    await run(() => renameFolder(acc.address, zMessageId.parse(c.req.param("fid")), p.name));
    return c.json({ ok: true });
  })
  .delete("/accounts/:id/folders/:fid", async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const fid = zMessageId.parse(c.req.param("fid"));
    await run(() => deleteFolder(acc.address, fid));
    await audit(a.realUser.id, "outlook.folder_deleted", acc.id, { folderId: fid });
    return c.json({ ok: true });
  })
  .post("/accounts/:id/folders/:fid/empty", async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    if (!rateLimit(`outlook-empty:${acc.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const fid = zMessageId.parse(c.req.param("fid"));
    const n = await run(() => emptyFolder(acc.address, fid));
    await audit(a.realUser.id, "outlook.folder_emptied", acc.id, { folderId: fid, count: n });
    return c.json({ ok: true, removed: n });
  })
  /** Drag and drop: a folder inside another one, or back to the top ("root"). */
  .post("/accounts/:id/folders/:fid/move", async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const fid = zMessageId.parse(c.req.param("fid"));
    const p = await body(c, z.object({ destination: zMessageId }));
    const id = await run(() => moveFolder(acc.address, fid, p.destination));
    await audit(a.realUser.id, "outlook.folder_moved", acc.id, { folderId: fid, destination: p.destination });
    return c.json({ ok: true, id });
  })
  .post("/accounts/:id/folders/:fid/read", async (c) => {
    const acc = await account(auth(c), c.req.param("id"));
    if (!rateLimit(`outlook-readall:${acc.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const n = await run(() => markFolderRead(acc.address, zMessageId.parse(c.req.param("fid"))));
    return c.json({ ok: true, marked: n });
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
    return c.json(
      await run(() => listMessages(acc.address, folder, { search: c.req.query("q") ?? "", cursor: cursor ? z.string().max(4000).parse(cursor) : undefined })),
    );
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
    const p = await body(c, z.object({ ...zOutgoing, to: z.array(zEmail).min(1).max(100) }));
    checkAttachments(p.attachments);
    if (!rateLimit(`outlook-send:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    await run(() => sendMail(acc.address, { ...p, html: sanitizeMailHtml(p.html) }));
    await rememberRecipients(a.user.id, [...p.to, ...p.cc, ...p.bcc]);
    await audit(a.realUser.id, "outlook.sent", acc.id, { from: acc.address, to: p.to.length + p.cc.length + p.bcc.length, files: p.attachments.length });
    return c.json({ ok: true }, 201);
  })

  .post("/accounts/:id/messages/:mid/respond", requirePermission("outlook.send"), async (c) => {
    const a = auth(c);
    const acc = await account(a, c.req.param("id"));
    const p = await body(c, z.object({ ...zOutgoing, mode: z.enum(["reply", "replyAll", "forward"]) }));
    if (!p.to.length) throw new HTTPException(400, { message: "outlook_no_recipient" });
    checkAttachments(p.attachments);
    if (!rateLimit(`outlook-send:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    await run(() => respond(acc.address, zMessageId.parse(c.req.param("mid")), p.mode, { ...p, html: sanitizeMailHtml(p.html) }));
    await rememberRecipients(a.user.id, [...p.to, ...p.cc, ...p.bcc]);
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
    // the sender, when they are a contact of a client: the ticket is opened for them
    // their email, their name, a phone number in the email, else the client their domain belongs to; the technician decides when nothing matches
    const found = m.from?.address ? await matchSender(m.from.address, m.from.name, m.text).catch(() => null) : null;
    const contact = found?.contact ?? null;
    const company = !contact && found && found.how !== "akab" ? found.company : null;
    return c.json({ subject: m.subject, from: m.from, receivedAt: m.receivedAt, text: m.text.slice(0, 7000), contact, company });
  });

/** The technician's email signature (sanitized HTML), if any. */
async function signatureOf(userId: string) {
  const [p] = await db().select({ s: schema.userPreferences.emailSignature }).from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
  return p?.s ?? null;
}
