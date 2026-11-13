import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";

/**
 * The two spaces of Opérations:
 *  - **Tâches**: tasks on a **shared list** (a team list, for everyone or only for chosen people). They have a timer and a time entry.
 *  - **À faire** (to do): private to the person — a task on its own, or grouped on one of their **personal lists**. No timer, never assigned to others.
 * A list id from the browser is always checked here: it must be one the person may use for that space.
 */
export const TEAM_LIST_NAME = "Liste d'équipe";
export const PERSONAL_LIST_NAME = "Ma liste";
export type Space = "tasks" | "todo";

const L = schema.pipelineLists;

/** The people a shared list is for: everyone, or its owner and the members chosen */
const audience = (userId: string) => sql<boolean>`(${L.shared} and (${L.everyone} or ${L.ownerId} = ${userId} or exists (select 1 from pipeline_list_members m where m.list_id = ${L.id} and m.user_id = ${userId})))`;
/** A shared list the person is in, or one of their own personal lists */
const reachable = (userId: string) => or(audience(userId), and(eq(L.shared, false), eq(L.ownerId, userId)));
export const visibleLists = (userId: string) => reachable(userId);

/** The usual shared list (the first shared one for everyone), made when there is none */
export async function teamListId(): Promise<string> {
  const [row] = await db().select({ id: L.id }).from(L).where(and(eq(L.shared, true), eq(L.everyone, true))).orderBy(asc(L.position), asc(L.createdAt)).limit(1);
  if (row) return row.id;
  const [made] = await db().insert(L).values({ name: TEAM_LIST_NAME, shared: true, position: 0 }).returning({ id: L.id });
  return made.id;
}

export type ResolvedList = { id: string | null; shared: boolean; everyone: boolean };

/**
 * The list a task goes on. For the shared space a shared list the person is in (else the team list); for the to-do space nothing
 * (a task on its own) or one of their own personal lists. 400 `list_invalid` for anything else.
 */
export async function resolveList(userId: string, listId: string | null | undefined, space: Space = "tasks"): Promise<ResolvedList> {
  if (!listId) return space === "todo" ? { id: null, shared: false, everyone: false } : { id: await teamListId(), shared: true, everyone: true };
  const [l] = await db().select({ id: L.id, shared: L.shared, everyone: L.everyone }).from(L).where(and(eq(L.id, listId), reachable(userId)));
  if (!l || l.shared !== (space === "tasks")) throw new HTTPException(400, { message: "list_invalid" });
  return l;
}

/** Who sees a task follows its list: the team's only on a list for everyone; private on a personal list, on no list, or on a list for chosen people (they see it through the list). People chosen by hand stay chosen. */
export const visibilityOf = (list: { shared: boolean; everyone: boolean }, wanted: "team" | "private" | "selected" = "team"): "team" | "private" | "selected" => (!list.shared || !list.everyone ? (wanted === "selected" ? "selected" : "private") : wanted);

/** The to-do space: a task on no list, or on a personal list */
export const isTodoSql = sql<boolean>`(${schema.pipelineTasks.listId} is null or exists (select 1 from pipeline_lists pl where pl.id = ${schema.pipelineTasks.listId} and not pl.shared))`;

/** The lists a person can reach, with the open tasks of each they can see and who a shared list is for */
export async function listsFor(userId: string, seen: SQL) {
  const rows = await db()
    .select({ id: L.id, name: L.name, shared: L.shared, everyone: L.everyone, ownerId: L.ownerId, position: L.position, owner: schema.users.name })
    .from(L)
    .leftJoin(schema.users, eq(schema.users.id, L.ownerId))
    .where(reachable(userId))
    .orderBy(asc(L.position), asc(L.createdAt));
  const counts = await db()
    .select({ listId: schema.pipelineTasks.listId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.pipelineTasks)
    .where(and(sql`${schema.pipelineTasks.status} <> 'done'`, seen))
    .groupBy(schema.pipelineTasks.listId);
  const n = new Map(counts.map((c) => [c.listId, c.n]));
  const members = await db()
    .select({ listId: schema.pipelineListMembers.listId, id: schema.users.id, name: schema.users.name })
    .from(schema.pipelineListMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.pipelineListMembers.userId));
  return rows.map((r) => ({ id: r.id, name: r.name, shared: r.shared, everyone: r.everyone, ownerId: r.ownerId, owner: r.owner ?? null, mine: r.ownerId === userId, open: n.get(r.id) ?? 0, members: members.filter((m) => m.listId === r.id).map((m) => ({ id: m.id, name: m.name })) }));
}

/** Replace the people a list is shared with, and put the stored visibility of its tasks back in step */
export async function setListAudience(listId: string, everyone: boolean, memberIds: string[]) {
  await db().update(L).set({ everyone }).where(eq(L.id, listId));
  await db().delete(schema.pipelineListMembers).where(eq(schema.pipelineListMembers.listId, listId));
  if (!everyone && memberIds.length) await db().insert(schema.pipelineListMembers).values([...new Set(memberIds)].map((userId) => ({ listId, userId })));
  await db()
    .update(schema.pipelineTasks)
    .set({ visibility: everyone ? "team" : "private" })
    .where(and(eq(schema.pipelineTasks.listId, listId), sql`${schema.pipelineTasks.visibility} <> 'selected'`));
}
