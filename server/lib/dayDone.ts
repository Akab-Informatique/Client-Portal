import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { ticketSource } from "./ticketSource.ts";

/**
 * Ma journée: what happened to a block of the stored plan whose work is no longer on the day's list.
 * - finished (ticket complete, task / project task / phase done, project done or cancelled): the block stays, greyed;
 * - taken off the day by hand: the block is simply gone.
 * A block is also greyed when the person set it aside for the rest of the day ("continue another day").
 */
export async function finishedKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  const d = db();
  const ids = (kind: string) => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
  const uuids = (kind: string) => ids(kind).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const tasks = uuids("task");
  if (tasks.length) for (const r of await d.select({ id: schema.pipelineTasks.id }).from(schema.pipelineTasks).where(and(inArray(schema.pipelineTasks.id, tasks), eq(schema.pipelineTasks.status, "done")))) out.add(`task:${r.id}`);
  const ptasks = uuids("ptask");
  if (ptasks.length) for (const r of await d.select({ id: schema.projectTasks.id }).from(schema.projectTasks).where(and(inArray(schema.projectTasks.id, ptasks), eq(schema.projectTasks.status, "done")))) out.add(`ptask:${r.id}`);
  const miles = uuids("pmilestone");
  if (miles.length) for (const r of await d.select({ id: schema.projectMilestones.id }).from(schema.projectMilestones).where(and(inArray(schema.projectMilestones.id, miles), eq(schema.projectMilestones.status, "done")))) out.add(`pmilestone:${r.id}`);
  const projects = uuids("pproject");
  if (projects.length) {
    for (const r of await d.select({ id: schema.projects.id }).from(schema.projects).where(and(inArray(schema.projects.id, projects), inArray(schema.projects.status, ["done", "cancelled"])))) out.add(`pproject:${r.id}`);
    for (const r of await d.select({ id: schema.projProjects.id }).from(schema.projProjects).where(and(inArray(schema.projProjects.id, projects), inArray(schema.projProjects.status, ["done", "cancelled"])))) out.add(`pproject:${r.id}`);
  }
  const tickets = ids("ticket").map(Number).filter(Number.isInteger);
  if (tickets.length) {
    try {
      const src = await ticketSource({ all: true });
      const o = await src.options();
      const complete = new Set(o.statuses.filter((s) => s.kind === "complete").map((s) => s.value));
      for (const id of tickets) {
        const t = await src.get(id).catch(() => null);
        if (t && complete.has(t.status)) out.add(`ticket:${id}`);
      }
    } catch {
      /* a ticket source that does not answer: those blocks are treated as taken off */
    }
  }
  return out;
}

/** The items set aside for the rest of this day. */
export async function continuedKeys(userId: string, date: string): Promise<Set<string>> {
  const rows = await db().select({ key: schema.pipelineDayContinued.key }).from(schema.pipelineDayContinued).where(and(eq(schema.pipelineDayContinued.userId, userId), eq(schema.pipelineDayContinued.date, date)));
  return new Set(rows.map((r) => r.key));
}
