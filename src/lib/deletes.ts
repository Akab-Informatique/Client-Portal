/**
 * Cascade-safe deletes for portal users and client companies.
 * Order matters: child rows first, then parent.
 */
import { eq, inArray } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import type { BoardMessage, Company, User } from "@/lib/types";

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Permanently delete a user and their personal message state.
 * Board messages they authored are kept (author_name remains as history).
 * Refuses to delete the last active admin.
 */
export async function deleteUserById(
  userId: number,
  opts?: { actorId?: number | null },
): Promise<DeleteResult> {
  await dbReady;

  const rows = (await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)) as User[];
  const user = rows[0];
  if (!user) return { ok: false, error: "User not found." };

  if (opts?.actorId != null && opts.actorId === userId) {
    return {
      ok: false,
      error: "You cannot delete your own account while signed in.",
    };
  }

  if (user.role === "admin") {
    const allUsers = (await db.select().from(schema.users)) as User[];
    const otherActiveAdmins = allUsers.filter(
      (u: User) => u.role === "admin" && u.active && u.id !== userId,
    );
    if (otherActiveAdmins.length === 0) {
      return {
        ok: false,
        error: "Cannot delete the last active admin account.",
      };
    }
  }

  // Personal message state
  await db
    .delete(schema.message_user_states)
    .where(eq(schema.message_user_states.user_id, userId));

  await db.delete(schema.users).where(eq(schema.users.id, userId));
  return { ok: true };
}

/**
 * Permanently delete a client company and everything in its zone:
 * - portal users of that company (+ their message state)
 * - board messages (+ all message_user_states for those messages)
 * - the company row itself
 * Internal (MSP) company cannot be deleted this way.
 */
export async function deleteClientCompanyById(
  companyId: number,
): Promise<DeleteResult> {
  await dbReady;

  const rows = (await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1)) as Company[];
  const company = rows[0];
  if (!company) return { ok: false, error: "Client not found." };
  if (company.type !== "client") {
    return { ok: false, error: "Only client companies can be deleted here." };
  }

  // Users belonging to this company
  const allUsers = (await db.select().from(schema.users)) as User[];
  const companyUsers = allUsers.filter(
    (u: User) => u.company_id === companyId,
  );
  const userIds = companyUsers.map((u: User) => u.id);

  if (userIds.length > 0) {
    await db
      .delete(schema.message_user_states)
      .where(inArray(schema.message_user_states.user_id, userIds));
  }

  // Board messages for this company + their per-user states
  const allMessages = (await db
    .select()
    .from(schema.board_messages)) as BoardMessage[];
  const messages = allMessages.filter(
    (m: BoardMessage) => m.company_id === companyId,
  );
  const messageIds = messages.map((m: BoardMessage) => m.id);

  if (messageIds.length > 0) {
    await db
      .delete(schema.message_user_states)
      .where(inArray(schema.message_user_states.message_id, messageIds));
    await db
      .delete(schema.board_messages)
      .where(inArray(schema.board_messages.id, messageIds));
  }

  if (userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }

  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  return { ok: true };
}
