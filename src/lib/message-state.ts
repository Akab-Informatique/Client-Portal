import { and, eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import type {
  BoardMessage,
  BoardMessageWithState,
  MessageReadStatus,
  MessageUserState,
} from "@/lib/types";

function nowIso() {
  return new Date().toISOString();
}

export async function getStatesForUser(
  userId: number,
  messageIds: number[],
): Promise<Map<number, MessageUserState>> {
  await dbReady;
  if (messageIds.length === 0) return new Map();
  const rows = (await db
    .select()
    .from(schema.message_user_states)
    .where(eq(schema.message_user_states.user_id, userId))) as MessageUserState[];

  const idSet = new Set(messageIds);
  const map = new Map<number, MessageUserState>();
  for (const row of rows) {
    if (idSet.has(row.message_id)) map.set(row.message_id, row);
  }
  return map;
}

export function attachStates(
  messages: BoardMessage[],
  states: Map<number, MessageUserState>,
): BoardMessageWithState[] {
  return messages.map((m) => {
    const s = states.get(m.id);
    return {
      ...m,
      readStatus: (s?.status as MessageReadStatus) ?? "unread",
      customLabel: s?.custom_label ?? null,
      stateId: s?.id ?? null,
    };
  });
}

export async function loadMessagesWithState(
  companyId: number,
  userId: number,
): Promise<BoardMessageWithState[]> {
  await dbReady;
  const msgs = (await db
    .select()
    .from(schema.board_messages)
    .where(eq(schema.board_messages.company_id, companyId))) as BoardMessage[];

  // Newest on top, oldest at bottom. Pinned posts stay above unpinned.
  const sorted = [...msgs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const states = await getStatesForUser(
    userId,
    sorted.map((m) => m.id),
  );
  return attachStates(sorted, states);
}

export async function countUnreadForUser(
  companyId: number,
  userId: number,
): Promise<number> {
  await dbReady;
  const msgs = (await db
    .select()
    .from(schema.board_messages)
    .where(eq(schema.board_messages.company_id, companyId))) as BoardMessage[];
  if (msgs.length === 0) return 0;
  const states = await getStatesForUser(
    userId,
    msgs.map((m) => m.id),
  );
  return msgs.filter((m) => {
    const s = states.get(m.id);
    return !s || s.status === "unread";
  }).length;
}

async function upsertState(
  messageId: number,
  userId: number,
  patch: { status?: MessageReadStatus; custom_label?: string | null },
): Promise<MessageUserState> {
  await dbReady;
  const existing = (await db
    .select()
    .from(schema.message_user_states)
    .where(
      and(
        eq(schema.message_user_states.message_id, messageId),
        eq(schema.message_user_states.user_id, userId),
      ),
    )
    .limit(1)) as MessageUserState[];

  const current = existing[0];
  if (current) {
    const nextStatus = patch.status ?? current.status;
    const nextLabel =
      patch.custom_label !== undefined ? patch.custom_label : current.custom_label;
    const [updated] = (await db
      .update(schema.message_user_states)
      .set({
        status: nextStatus,
        custom_label: nextLabel,
        updated_at: nowIso(),
      })
      .where(eq(schema.message_user_states.id, current.id))
      .returning()) as MessageUserState[];
    return updated;
  }

  const [created] = (await db
    .insert(schema.message_user_states)
    .values({
      message_id: messageId,
      user_id: userId,
      status: patch.status ?? "unread",
      custom_label: patch.custom_label ?? null,
      updated_at: nowIso(),
    })
    .returning()) as MessageUserState[];
  return created;
}

export async function setMessageReadStatus(
  messageId: number,
  userId: number,
  status: MessageReadStatus,
) {
  return upsertState(messageId, userId, { status });
}

export async function setMessageCustomLabel(
  messageId: number,
  userId: number,
  label: string | null,
) {
  const trimmed = label?.trim() || null;
  // Setting a custom label also marks as read by default (user engaged with it)
  return upsertState(messageId, userId, {
    custom_label: trimmed,
    status: "read",
  });
}

export async function markAllReadForUser(companyId: number, userId: number) {
  await dbReady;
  const msgs = (await db
    .select()
    .from(schema.board_messages)
    .where(eq(schema.board_messages.company_id, companyId))) as BoardMessage[];
  for (const m of msgs) {
    await upsertState(m.id, userId, { status: "read" });
  }
}
