import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { asConnection, graph, o365Ready, O365Error } from "../lib/o365.ts";

/**
 * Chat (My tools): the person's own Microsoft Teams chats, shown and answered in the portal. Everything goes through
 * the person's OWN Microsoft sign-in (delegated, `Chat.ReadWrite`): nobody reads or writes with anyone else's account, never
 * with the organisation access. A message written here is a real Teams message, so a colleague answers from Teams
 * (and the other way round). Chats are Teams' own — the portal keeps nothing of them.
 */
const CHAT_SCOPE = "Chat.ReadWrite";
const CHAT_ID = /^19:[A-Za-z0-9_=@.\-]{5,200}$/;

type GraphChat = {
  id: string;
  topic: string | null;
  chatType: "oneOnOne" | "group" | "meeting";
  lastUpdatedDateTime?: string;
  members?: { displayName?: string; email?: string; userId?: string }[];
  lastMessagePreview?: { createdDateTime?: string; body?: { content?: string; contentType?: string }; from?: { user?: { displayName?: string } } } | null;
};
type GraphMessage = {
  id: string;
  createdDateTime: string;
  messageType: string;
  deletedDateTime?: string | null;
  from?: { user?: { id?: string; displayName?: string } } | null;
  body?: { content?: string; contentType?: string };
  attachments?: { name?: string }[];
};

/** Teams sends HTML: shown as plain text (React escapes it), never as markup */
export function plain(content: string | undefined, type?: string): string {
  let s = content ?? "";
  if (type === "html") {
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<attachment[^>]*><\/attachment>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

/** The person's own Microsoft sign-in, with the chat right (a sign-in made before chat existed has to be done once more) */
async function own(userId: string) {
  const [conn] = await db().select({ email: schema.msConnections.email, scopes: schema.msConnections.scopes }).from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  if (!conn) throw new HTTPException(403, { message: "chat_sign_in_first" });
  if (!conn.scopes.split(" ").includes(CHAT_SCOPE)) throw new HTTPException(403, { message: "chat_reconnect" });
  return conn;
}
const asMe = <T>(userId: string, fn: () => Promise<T>) =>
  asConnection(userId, fn).catch((e) => {
    if (e instanceof O365Error) throw new HTTPException(e.code === "auth" ? 403 : e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 502, { message: e.code === "auth" ? "chat_reconnect" : `chat_${e.code}` });
    throw e;
  });
const limit = (userId: string, what: string, n: number) => {
  if (!rateLimit(`chat:${what}:${userId}`, n, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
};
/** My Microsoft id (to tell my messages from the others), kept a while */
const meIds = new Map<string, string>();
async function myMicrosoftId(userId: string) {
  const hit = meIds.get(userId);
  if (hit) return hit;
  const me = await asMe(userId, () => graph<{ id: string }>("GET", "/me?$select=id"));
  meIds.set(userId, me.id);
  return me.id;
}

export const chatRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("chat.use"))

  /** Whether the chat can be used: the organisation's Microsoft set up, the person signed in, with the chat right */
  .get("/status", async (c) => {
    const a = auth(c);
    const [conn] = await db().select({ email: schema.msConnections.email, scopes: schema.msConnections.scopes }).from(schema.msConnections).where(eq(schema.msConnections.userId, a.user.id));
    return c.json({ ready: await o365Ready(), signedIn: Boolean(conn), email: conn?.email ?? null, needsReconnect: Boolean(conn) && !conn!.scopes.split(" ").includes(CHAT_SCOPE) });
  })

  /** The colleagues one can chat with: the other active staff of the portal (their Microsoft address is their portal email) */
  .get("/colleagues", async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true), ne(schema.users.id, a.user.id)))
      .orderBy(asc(schema.users.name));
    return c.json(rows);
  })

  /** My Teams chats, the latest first */
  .get("/chats", async (c) => {
    const a = auth(c);
    await own(a.user.id);
    limit(a.user.id, "list", 60);
    const r = await asMe(a.user.id, () => graph<{ value: GraphChat[] }>("GET", "/me/chats?$expand=members,lastMessagePreview&$top=50"));
    const mine = (await own(a.user.id)).email.toLowerCase();
    const chats = (r.value ?? []).map((x) => {
      const others = (x.members ?? []).filter((m) => (m.email ?? "").toLowerCase() !== mine);
      return {
        id: x.id,
        type: x.chatType,
        title: x.topic || others.map((m) => m.displayName).filter(Boolean).join(", ") || "Chat",
        members: others.map((m) => ({ name: m.displayName ?? "", email: m.email ?? null })),
        lastAt: x.lastMessagePreview?.createdDateTime ?? x.lastUpdatedDateTime ?? null,
        preview: plain(x.lastMessagePreview?.body?.content, x.lastMessagePreview?.body?.contentType).slice(0, 140),
        previewFrom: x.lastMessagePreview?.from?.user?.displayName ?? null,
      };
    });
    chats.sort((x, y) => (y.lastAt ?? "").localeCompare(x.lastAt ?? ""));
    return c.json(chats);
  })

  /** A one-to-one chat with a colleague (Teams returns the existing one when there is one) */
  .post("/chats", async (c) => {
    const a = auth(c);
    const conn = await own(a.user.id);
    limit(a.user.id, "open", 20);
    const p = await body(c, z.object({ colleagueId: zUuid }));
    const [other] = await db().select({ email: schema.users.email, name: schema.users.name }).from(schema.users).where(and(eq(schema.users.id, p.colleagueId), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
    if (!other || p.colleagueId === a.user.id) throw new HTTPException(404, { message: "not_found" });
    const member = (email: string) => ({ "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${email}')` });
    const made = await asMe(a.user.id, () => graph<{ id: string }>("POST", "/chats", { chatType: "oneOnOne", members: [member(conn.email), member(other.email)] }));
    await audit(a.user.id, "chat.opened", p.colleagueId, {});
    return c.json({ id: made.id, title: other.name }, 201);
  })

  /** The latest messages of a chat, oldest first */
  .get("/chats/:id/messages", async (c) => {
    const a = auth(c);
    await own(a.user.id);
    const id = c.req.param("id");
    if (!CHAT_ID.test(id)) throw new HTTPException(400, { message: "invalid_id" });
    limit(a.user.id, "read", 120);
    const r = await asMe(a.user.id, () => graph<{ value: GraphMessage[] }>("GET", `/me/chats/${encodeURIComponent(id)}/messages?$top=40`));
    const me = await myMicrosoftId(a.user.id);
    const messages = (r.value ?? [])
      .filter((m) => m.messageType === "message" && !m.deletedDateTime)
      .map((m) => ({ id: m.id, at: m.createdDateTime, from: m.from?.user?.displayName ?? "", mine: m.from?.user?.id === me, text: plain(m.body?.content, m.body?.contentType), files: (m.attachments ?? []).map((x) => x.name).filter(Boolean) as string[] }))
      .filter((m) => m.text || m.files.length)
      .sort((x, y) => x.at.localeCompare(y.at));
    return c.json(messages);
  })

  /** A message written in the portal: a real Teams message sent as the person */
  .post("/chats/:id/messages", async (c) => {
    const a = auth(c);
    await own(a.user.id);
    const id = c.req.param("id");
    if (!CHAT_ID.test(id)) throw new HTTPException(400, { message: "invalid_id" });
    limit(a.user.id, "send", 40);
    const p = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    await asMe(a.user.id, () => graph("POST", `/me/chats/${encodeURIComponent(id)}/messages`, { body: { contentType: "text", content: p.text } }));
    return c.json({ ok: true }, 201);
  });
