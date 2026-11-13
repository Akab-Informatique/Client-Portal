import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";

/**
 * Lists of to-do tasks. Every task is on one: a **shared** list (the whole team that sees Opérations) or a **personal** one
 * (its owner only; whoever a task is assigned to still sees that task). The routes never trust a list id from the browser:
 * it must be a shared list or one's own.
 */
export const TEAM_LIST_NAME = "Liste d'équipe";
export const PERSONAL_LIST_NAME = "Ma liste";

/** The usual shared list (the first shared one), made when there is none */
export async function teamListId(): Promise<string> {
  const [row] = await db().select({ id: schema.pipelineLists.id }).from(schema.pipelineLists).where(eq(schema.pipelineLists.shared, true)).orderBy(asc(schema.pipelineLists.position), asc(schema.pipelineLists.createdAt)).limit(1);
  if (row) return row.id;
  const [made] = await db().insert(schema.pipelineLists).values({ name: TEAM_LIST_NAME, shared: true, position: 0 }).returning({ id: schema.pipelineLists.id });
  return made.id;
}

/** A shared list or one's own */
const reachable = (userId: string) => or(eq(schema.pipelineLists.shared, true), eq(schema.pipelineLists.ownerId, userId));
export const visibleLists = (userId: string) => reachable(userId);

/** The list a task goes on: the one asked for (400 `list_invalid` unless it is shared or the person's own), else the team list */
export async function resolveList(userId: string, listId?: string | null): Promise<{ id: string; shared: boolean }> {
  if (!listId) return { id: await teamListId(), shared: true };
  const [l] = await db().select({ id: schema.pipelineLists.id, shared: schema.pipelineLists.shared }).from(schema.pipelineLists).where(and(eq(schema.pipelineLists.id, listId), reachable(userId)));
  if (!l) throw new HTTPException(400, { message: "list_invalid" });
  return l;
}

/** A personal list's tasks are never the team's (a "team" one becomes private); a shared list keeps what was asked, people chosen by hand stay chosen */
export const visibilityFor = (shared: boolean, wanted: "team" | "private" | "selected"): "team" | "private" | "selected" => (shared ? wanted : wanted === "team" ? "private" : wanted);

/** The lists a person can reach, with their open tasks they can see */
export async function listsFor(userId: string, seen: SQL) {
  const rows = await db()
    .select({ id: schema.pipelineLists.id, name: schema.pipelineLists.name, shared: schema.pipelineLists.shared, ownerId: schema.pipelineLists.ownerId, position: schema.pipelineLists.position, owner: schema.users.name })
    .from(schema.pipelineLists)
    .leftJoin(schema.users, eq(schema.users.id, schema.pipelineLists.ownerId))
    .where(reachable(userId))
    .orderBy(asc(schema.pipelineLists.position), asc(schema.pipelineLists.createdAt));
  const counts = await db()
    .select({ listId: schema.pipelineTasks.listId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.pipelineTasks)
    .where(and(sql`${schema.pipelineTasks.status} <> 'done'`, seen))
    .groupBy(schema.pipelineTasks.listId);
  const n = new Map(counts.map((c) => [c.listId, c.n]));
  return rows.map((r) => ({ id: r.id, name: r.name, shared: r.shared, ownerId: r.ownerId, owner: r.owner ?? null, mine: r.ownerId === userId, open: n.get(r.id) ?? 0 }));
}
