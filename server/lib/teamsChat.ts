import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { asConnection, graph } from "./o365.ts";

/**
 * A Teams message to one colleague, written with the SENDER's own Microsoft sign-in (delegated `Chat.ReadWrite`, never the
 * organisation access): it lands in their one-to-one chat, so Teams itself notifies them. Nothing is read back or kept here.
 */
export type ChatOutcome = "sent" | "failed" | "not_ready";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendChatNotice(fromUserId: string, toEmail: string, lines: string[], link?: string): Promise<ChatOutcome> {
  const [conn] = await db().select({ email: schema.msConnections.email, scopes: schema.msConnections.scopes }).from(schema.msConnections).where(eq(schema.msConnections.userId, fromUserId));
  if (!conn || !conn.scopes.split(" ").includes("Chat.ReadWrite")) return "not_ready";
  const member = (email: string) => ({ "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${email}')` });
  const html = lines.map((l) => `<p>${esc(l).replace(/\n/g, "<br>")}</p>`).join("") + (link ? `<p><a href="${esc(link)}">Ouvrir le billet</a></p>` : "");
  try {
    await asConnection(fromUserId, async () => {
      const chat = await graph<{ id: string }>("POST", "/chats", { chatType: "oneOnOne", members: [member(conn.email), member(toEmail)] });
      await graph("POST", `/chats/${encodeURIComponent(chat.id)}/messages`, { body: { contentType: "html", content: html } });
    });
    return "sent";
  } catch {
    return "failed";
  }
}
