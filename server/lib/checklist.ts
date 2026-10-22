import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * The checklist of a ticket (Liste de contrôle): tasks to complete, in order. An item may wait for another
 * item of the same ticket (it cannot be ticked before that one). A ticket with an open item cannot be
 * completed (enforced where a ticket's status changes, lib/queues.ts).
 */
export class ChecklistError extends Error {
  constructor(public code: "item_not_found" | "item_blocked" | "item_cycle" | "item_dependency_invalid" | "item_has_done_dependents") {
    super(code);
  }
}

export type ChecklistItem = {
  id: string;
  text: string;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  dependsOnId: string | null;
  /** Waiting for this item (not done yet): it cannot be ticked */
  blockedBy: { id: string; text: string } | null;
};

type Row = typeof schema.ticketChecklist.$inferSelect;

const view = (rows: Row[], names: Map<string, string>): ChecklistItem[] => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...rows]
    .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => {
      const dep = r.dependsOnId ? byId.get(r.dependsOnId) : undefined;
      return {
        id: r.id,
        text: r.text,
        position: r.position,
        done: r.done,
        doneAt: r.doneAt?.toISOString() ?? null,
        doneBy: r.doneBy ? (names.get(r.doneBy) ?? null) : null,
        dependsOnId: dep ? dep.id : null,
        blockedBy: dep && !dep.done ? { id: dep.id, text: dep.text } : null,
      };
    });
};

export async function checklistOf(ticketId: number): Promise<ChecklistItem[]> {
  const rows = await db().select().from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId));
  const ids = [...new Set(rows.map((r) => r.doneBy).filter((x): x is string => Boolean(x)))];
  const names = new Map(ids.length ? (await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.name]) : []);
  return view(rows, names);
}

/** Open items of a ticket (a ticket with one cannot be completed) */
export async function openItems(ticketId: number): Promise<number> {
  const [r] = await db().select({ n: count() }).from(schema.ticketChecklist).where(and(eq(schema.ticketChecklist.ticketId, ticketId), eq(schema.ticketChecklist.done, false)));
  return r?.n ?? 0;
}

/** done / total for a set of tickets (the list shows a small badge) */
export async function checklistCounts(ticketIds: number[]): Promise<Map<number, { done: number; total: number }>> {
  const out = new Map<number, { done: number; total: number }>();
  if (!ticketIds.length) return out;
  const rows = await db()
    .select({ id: schema.ticketChecklist.ticketId, total: count(), done: sql<number>`count(*) filter (where ${schema.ticketChecklist.done})::int` })
    .from(schema.ticketChecklist)
    .where(inArray(schema.ticketChecklist.ticketId, ticketIds))
    .groupBy(schema.ticketChecklist.ticketId);
  for (const r of rows) out.set(r.id, { done: Number(r.done), total: Number(r.total) });
  return out;
}

async function one(ticketId: number, id: string): Promise<Row> {
  const [r] = await db().select().from(schema.ticketChecklist).where(and(eq(schema.ticketChecklist.id, id), eq(schema.ticketChecklist.ticketId, ticketId)));
  if (!r) throw new ChecklistError("item_not_found");
  return r;
}

/** Following the dependencies from `from`, do we meet `target`? (a loop) */
async function leadsTo(ticketId: number, from: string, target: string): Promise<boolean> {
  const rows = await db().select({ id: schema.ticketChecklist.id, dep: schema.ticketChecklist.dependsOnId }).from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId));
  const dep = new Map(rows.map((r) => [r.id, r.dep]));
  let cur: string | null | undefined = from;
  for (let i = 0; cur && i < rows.length + 1; i++) {
    if (cur === target) return true;
    cur = dep.get(cur);
  }
  return false;
}

export async function addItem(ticketId: number, p: { text: string; dependsOnId?: string | null }, userId: string): Promise<void> {
  if (p.dependsOnId) await one(ticketId, p.dependsOnId).catch(() => Promise.reject(new ChecklistError("item_dependency_invalid")));
  const [{ m }] = await db().select({ m: sql<number>`coalesce(max(${schema.ticketChecklist.position}), -1)::int` }).from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId));
  await db().insert(schema.ticketChecklist).values({ ticketId, text: p.text, position: m + 1, dependsOnId: p.dependsOnId ?? null, createdBy: userId });
}

/** The items typed when the ticket is made, in order; "dependsOn" is the index of an EARLIER item. */
export async function createItems(ticketId: number, items: { text: string; dependsOn?: number | null }[], userId: string): Promise<void> {
  if (!items.length) return;
  const rows = await db()
    .insert(schema.ticketChecklist)
    .values(items.map((x, position) => ({ ticketId, text: x.text, position, createdBy: userId })))
    .returning({ id: schema.ticketChecklist.id, position: schema.ticketChecklist.position });
  const byPos = new Map(rows.map((r) => [r.position, r.id]));
  for (const [i, x] of items.entries()) {
    if (x.dependsOn == null) continue;
    const dep = byPos.get(x.dependsOn);
    if (dep) await db().update(schema.ticketChecklist).set({ dependsOnId: dep }).where(eq(schema.ticketChecklist.id, byPos.get(i)!));
  }
}

export async function updateItem(ticketId: number, id: string, p: { text?: string; done?: boolean; dependsOnId?: string | null }, userId: string): Promise<void> {
  const cur = await one(ticketId, id);
  const set: Partial<Row> = { updatedAt: new Date() };
  if (p.text !== undefined) set.text = p.text;
  if (p.dependsOnId !== undefined) {
    if (p.dependsOnId === id) throw new ChecklistError("item_cycle");
    if (p.dependsOnId) {
      await one(ticketId, p.dependsOnId).catch(() => Promise.reject(new ChecklistError("item_dependency_invalid")));
      // the other item must not (even through others) wait for this one
      if (await leadsTo(ticketId, p.dependsOnId, id)) throw new ChecklistError("item_cycle");
    }
    set.dependsOnId = p.dependsOnId;
  }
  if (p.done !== undefined && p.done !== cur.done) {
    if (p.done) {
      // cannot be ticked before the item it waits for
      const depId = set.dependsOnId !== undefined ? set.dependsOnId : cur.dependsOnId;
      const dep = depId ? await one(ticketId, depId).catch(() => null) : null;
      if (dep && !dep.done) throw new ChecklistError("item_blocked");
      Object.assign(set, { done: true, doneAt: new Date(), doneBy: userId });
    } else {
      // cannot be un-ticked while an item that waited for it is done
      const [dependent] = await db()
        .select({ id: schema.ticketChecklist.id })
        .from(schema.ticketChecklist)
        .where(and(eq(schema.ticketChecklist.dependsOnId, id), eq(schema.ticketChecklist.done, true)))
        .limit(1);
      if (dependent) throw new ChecklistError("item_has_done_dependents");
      Object.assign(set, { done: false, doneAt: null, doneBy: null });
    }
  }
  await db().update(schema.ticketChecklist).set(set).where(eq(schema.ticketChecklist.id, id));
}

/** Deleting an item frees the ones that waited for it (the database clears their link). */
export async function deleteItem(ticketId: number, id: string): Promise<void> {
  await one(ticketId, id);
  await db().delete(schema.ticketChecklist).where(eq(schema.ticketChecklist.id, id));
}

export async function reorderItems(ticketId: number, ids: string[]): Promise<void> {
  const rows = await db().select({ id: schema.ticketChecklist.id }).from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId)).orderBy(asc(schema.ticketChecklist.position));
  const known = new Set(rows.map((r) => r.id));
  const order = [...ids.filter((x) => known.has(x)), ...rows.map((r) => r.id).filter((x) => !ids.includes(x))];
  await db().transaction(async (tx) => {
    for (const [position, id] of order.entries()) await tx.update(schema.ticketChecklist).set({ position }).where(eq(schema.ticketChecklist.id, id));
  });
}

export async function deleteChecklist(ticketId: number): Promise<void> {
  await db().delete(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId));
}
