import { and, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { permissionsOf } from "./auth.ts";
import type { PermissionKey } from "../../shared/permissions.ts";

export type NotificationType = "message.new" | "user.locked" | "timer.pending" | "ticket.pinned";

type Notice = { type: NotificationType; data: Record<string, unknown>; link: string };

/** Insert one notification per recipient (deduplicated). Never throws. */
export async function notify(userIds: string[], n: Notice): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  try {
    for (let i = 0; i < ids.length; i += 500) {
      await db()
        .insert(schema.notifications)
        .values(ids.slice(i, i + 500).map((userId) => ({ userId, type: n.type, data: n.data, link: n.link })));
    }
  } catch (e) {
    console.warn("[notify] insert failed", e);
  }
}

/** Active users of a kind whose effective rights include `perm`. */
async function usersWith(kind: "staff" | "client", perm: PermissionKey, clientIds?: string[]): Promise<string[]> {
  const conds = [eq(schema.users.kind, kind), eq(schema.users.active, true)];
  if (clientIds) {
    if (!clientIds.length) return [];
    conds.push(inArray(schema.users.clientId, clientIds));
  }
  const users = await db().select().from(schema.users).where(and(...conds));
  const out: string[] = [];
  for (const u of users) if ((await permissionsOf(u)).includes(perm)) out.push(u.id);
  return out;
}

/** New board message: targeted clients' users + the other technicians. */
export async function notifyMessagePosted(
  message: { id: string; title: string; audience: "all" | "selected" },
  clientIds: string[],
  authorId: string,
  authorName: string,
): Promise<void> {
  const activeClients = await db()
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.active, true));
  const targets = message.audience === "all" ? activeClients.map((c) => c.id) : clientIds.filter((id) => activeClients.some((c) => c.id === id));
  const data = { messageId: message.id, title: message.title, author: authorName };
  const clientUsers = await usersWith("client", "board.view", targets);
  await notify(clientUsers, { type: "message.new", data, link: `/?message=${message.id}` });
  const staff = (await usersWith("staff", "messages.view")).filter((id) => id !== authorId);
  await notify(staff, { type: "message.new", data, link: `/messages?message=${message.id}` });
}

/** Account locked after repeated wrong passwords → admins who manage that kind of user. */
export async function notifyUserLocked(user: { id: string; name: string; email: string; kind: "staff" | "client"; clientId: string | null }) {
  const perm: PermissionKey = user.kind === "staff" ? "admin.staff" : "admin.clients";
  const admins = await usersWith("staff", perm);
  const link =
    user.kind === "staff"
      ? `/?admin=staff&user=${user.id}`
      : `/?admin=clients&client=${user.clientId ?? ""}&user=${user.id}`;
  await notify(admins, { type: "user.locked", data: { userId: user.id, name: user.name, email: user.email }, link });
}

export async function purgeOldNotifications(days = 90): Promise<void> {
  await db()
    .delete(schema.notifications)
    .where(lt(schema.notifications.createdAt, new Date(Date.now() - days * 86_400_000)));
}
