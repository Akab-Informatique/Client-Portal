import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * A to-do task has one or several people. The first is `pipeline_tasks.assignee_id` (the main one, kept for every older
 * place that reads it); the others are in `pipeline_task_assignees`. Anything that asks "is this task mine?" uses
 * `assignedTo`, which counts both.
 */
export const assignedTo = (userId: string) =>
  sql<boolean>`(${schema.pipelineTasks.assigneeId} = ${userId} or exists (select 1 from pipeline_task_assignees x where x.task_id = ${schema.pipelineTasks.id} and x.user_id = ${userId}))`;

/**
 * Who sees a task: everyone when it is a team task; otherwise the one who made it, the one it is assigned to,
 * and (when "selected") the people chosen. Not even a manager sees a private one. Shared by the task routes
 * and the portal assistant, so both apply the same rule.
 */
export const seenBy = (userId: string) =>
  sql<boolean>`(${schema.pipelineTasks.visibility} = 'team' or ${schema.pipelineTasks.createdBy} = ${userId} or ${assignedTo(userId)} or (${schema.pipelineTasks.visibility} = 'selected' and exists (select 1 from pipeline_task_viewers v where v.task_id = ${schema.pipelineTasks.id} and v.user_id = ${userId})))`;

/** The other people of each task (not the main one) */
export async function coAssignees(taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!taskIds.length) return out;
  const rows = await db().select().from(schema.pipelineTaskAssignees).where(inArray(schema.pipelineTaskAssignees.taskId, taskIds));
  for (const r of rows) out.set(r.taskId, [...(out.get(r.taskId) ?? []), r.userId]);
  return out;
}

/** Whether a person has the task (as the main one or one of the others) */
export async function isAssigned(taskId: string, userId: string): Promise<boolean> {
  const [t] = await db().select({ id: schema.pipelineTasks.id }).from(schema.pipelineTasks).where(and(eq(schema.pipelineTasks.id, taskId), assignedTo(userId)));
  return Boolean(t);
}

/** Put the task on these people (active staff, in the order given, the first one the main one); returns the main one and the others */
export async function setAssignees(taskId: string, ids: string[]): Promise<{ main: string | null; others: string[] }> {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db().select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, unique), eq(schema.users.kind, "staff"), eq(schema.users.active, true))) : [];
  const keep = unique.filter((id) => rows.some((r) => r.id === id));
  const [main = null, ...others] = keep;
  await db().update(schema.pipelineTasks).set({ assigneeId: main }).where(eq(schema.pipelineTasks.id, taskId));
  await db().delete(schema.pipelineTaskAssignees).where(eq(schema.pipelineTaskAssignees.taskId, taskId));
  if (others.length) await db().insert(schema.pipelineTaskAssignees).values(others.map((userId) => ({ taskId, userId }))).onConflictDoNothing();
  return { main, others };
}
