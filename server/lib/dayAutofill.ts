import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { assignedTo } from "./pipelineAssign.ts";
import { buildPlan } from "./pipeline.ts";
import { ticketSource } from "./ticketSource.ts";

/**
 * "Remplir ma journée avec l'IA": looks at everything the technician has open — tickets, then project tasks, then
 * projects, then internal tasks — and puts on today's plan what fits, even as a short sprint of a long job, so the
 * work keeps moving and nothing waits for the last minute. The candidates and the sprint lengths are chosen here;
 * the order, the minutes and the summary are then asked of the AI by `buildPlan` (the portal's rules when it is off).
 */
export type Cand = { key: string; cat: 0 | 1 | 2 | 3; rank: string; need: number };

/** Longest sprint given to one item in a day (minutes): a long job is advanced, not swallowed whole */
const SPRINT = 120;
/** Share of the free time kept for each kind (tickets, project tasks, projects, internal tasks); what one does not use goes to the next */
const SHARE = [0.5, 0.2, 0.15, 0.15];
const PRI: Record<string, string> = { urgent: "0", high: "1", medium: "2", normal: "2", low: "3" };
const rank = (due: string | null, pri: string) => `${due ?? "9999-99-99"} ${PRI[pri] ?? "2"}`;

/** Empties the day: what was added, the times given, the plan. Outlook events and the slots blocked by hand stay. */
export async function resetDay(userId: string, date: string) {
  const d = db();
  await d.delete(schema.ticketDayAdds).where(and(eq(schema.ticketDayAdds.userId, userId), eq(schema.ticketDayAdds.forDate, date)));
  await d.delete(schema.pipelineDayAlloc).where(and(eq(schema.pipelineDayAlloc.userId, userId), eq(schema.pipelineDayAlloc.date, date)));
  await d.delete(schema.pipelineDayPlans).where(and(eq(schema.pipelineDayPlans.userId, userId), eq(schema.pipelineDayPlans.date, date)));
  return (await buildPlan(userId, date, { ai: false })).plan;
}

async function candidates(userId: string, date: string): Promise<Cand[]> {
  const d = db();
  const out: Cand[] = [];
  // 1. tickets assigned to the technician, not complete
  const src = await ticketSource();
  const [all, o] = await Promise.all([src.list().catch(() => []), src.options()]);
  const kindOf = new Map(o.statuses.map((s) => [s.value, s.kind]));
  const prio = new Map(o.priorities.map((p) => [p.value, p.kind]));
  const mine = all.filter((t) => t.assignee?.id === userId && kindOf.get(t.status) !== "complete");
  const est = mine.length ? await d.select({ id: schema.ticketMeta.ticketId, m: schema.ticketMeta.estimateMinutes }).from(schema.ticketMeta).where(inArray(schema.ticketMeta.ticketId, mine.map((t) => t.id))) : [];
  const estimate = new Map(est.map((r) => [r.id, r.m]));
  for (const t of mine) {
    const k = prio.get(t.priority) ?? "medium";
    out.push({ key: `ticket:${t.id}`, cat: 0, rank: rank(t.dueAt.slice(0, 10), k === "critical" ? "urgent" : k), need: estimate.get(t.id) ?? 45 });
  }
  // 2. project tasks: the archive's own, and the tasks of the new-format projects (one item per project, which opens)
  const open = ["planning", "active"] as const;
  const ptasks = await d
    .select({ t: schema.projectTasks })
    .from(schema.projectTasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTasks.projectId))
    .where(and(eq(schema.projectTasks.assigneeId, userId), ne(schema.projectTasks.status, "done"), ne(schema.projectTasks.status, "blocked"), inArray(schema.projects.status, [...open])));
  for (const { t } of ptasks) out.push({ key: `ptask:${t.id}`, cat: 1, rank: rank(t.dueDate, t.priority), need: t.estimateMinutes ?? 60 });
  const newTasks = await d
    .select({ t: schema.projTasks })
    .from(schema.projTasks)
    .innerJoin(schema.projProjects, eq(schema.projProjects.id, schema.projTasks.projectId))
    .where(and(eq(schema.projTasks.assigneeId, userId), ne(schema.projTasks.status, "done"), inArray(schema.projProjects.status, [...open])));
  const byProject = new Map<string, Cand>();
  for (const { t } of newTasks) {
    const key = `pproject:${t.projectId}`;
    const cur = byProject.get(key);
    const r = rank(t.dueDate, t.priority);
    if (!cur) byProject.set(key, { key, cat: 1, rank: r, need: 60 });
    else {
      if (r < cur.rank) cur.rank = r;
      cur.need = Math.min(SPRINT, cur.need + 30);
    }
  }
  out.push(...byProject.values());
  // 3. projects the technician leads or belongs to (the ones with no task of theirs are not already listed)
  const mem = await d.select({ id: schema.projMembers.projectId }).from(schema.projMembers).where(eq(schema.projMembers.userId, userId));
  const projs = await d
    .select({ id: schema.projProjects.id, due: schema.projProjects.dueDate })
    .from(schema.projProjects)
    .where(and(inArray(schema.projProjects.status, [...open]), or(eq(schema.projProjects.leadId, userId), mem.length ? inArray(schema.projProjects.id, mem.map((m) => m.id)) : sql`false`)));
  for (const p of projs) if (!byProject.has(`pproject:${p.id}`)) out.push({ key: `pproject:${p.id}`, cat: 2, rank: rank(p.due, "medium"), need: 45 });
  // 4. internal tasks: not done, not waiting, not to start later, not a parent with open subtasks
  const children = await d.select({ parentId: schema.pipelineTasks.parentId }).from(schema.pipelineTasks).where(and(ne(schema.pipelineTasks.status, "done"), sql`${schema.pipelineTasks.parentId} is not null`));
  const parents = new Set(children.map((c) => c.parentId));
  const tasks = await d.select().from(schema.pipelineTasks).where(and(assignedTo(userId), ne(schema.pipelineTasks.status, "done"), ne(schema.pipelineTasks.status, "blocked")));
  for (const t of tasks) {
    if (parents.has(t.id) || t.blockedById) continue;
    if (t.startDate && t.startDate > date) continue;
    out.push({ key: `task:${t.id}`, cat: 3, rank: rank(t.dueDate, t.priority), need: t.estimateMinutes ?? 30 });
  }
  return out;
}

/** What to put on the day: kind by kind (tickets, project tasks, projects, tasks), the most urgent first, each given a sprint. */
export function pick(cands: Cand[], capacity: number): { key: string; minutes: number }[] {
  const chosen: { key: string; minutes: number; cat: number }[] = [];
  let left = capacity;
  let carry = 0;
  for (const cat of [0, 1, 2, 3] as const) {
    let budget = Math.round(capacity * SHARE[cat]) + carry;
    for (const c of cands.filter((x) => x.cat === cat).sort((a, b) => a.rank.localeCompare(b.rank))) {
      if (budget < 15 || left < 15) break;
      const m = Math.min(Math.max(15, Math.ceil(c.need / 15) * 15), SPRINT, Math.floor(budget / 15) * 15, Math.floor(left / 15) * 15);
      if (m < 15) break;
      chosen.push({ key: c.key, minutes: m, cat });
      budget -= m;
      left -= m;
    }
    carry = Math.max(0, budget);
  }
  // what is still free goes to the leftovers, in the same order
  if (left >= 15) {
    for (const c of cands.filter((x) => !chosen.some((k) => k.key === x.key)).sort((a, b) => a.cat - b.cat || a.rank.localeCompare(b.rank))) {
      if (left < 15) break;
      const m = Math.min(Math.max(15, Math.ceil(c.need / 15) * 15), SPRINT, Math.floor(left / 15) * 15);
      chosen.push({ key: c.key, minutes: m, cat: c.cat });
      left -= m;
    }
  }
  return chosen.map(({ key, minutes }) => ({ key, minutes }));
}

const DIRECTION = (en: boolean) =>
  en
    ? "Order of importance: tickets first, then project tasks, then projects, then internal tasks. Spread the day so every kind advances: a long job gets only a sprint today (the rest is for another day), nothing must be left until the last minute. Keep the order tickets, project tasks, projects, tasks when times allow."
    : "Ordre d'importance : les billets d'abord, puis les tâches de projet, puis les projets, puis les tâches internes. Répartis la journée pour que tout avance : un long travail n'obtient qu'un sprint aujourd'hui (la suite sera pour un autre jour), rien ne doit rester pour la dernière minute. Garde l'ordre billets, tâches de projet, projets, tâches quand l'horaire le permet.";

export async function autofillDay(userId: string, by: string, date: string, opts: { locale: "fr" | "en"; direction?: string }) {
  const d = db();
  await resetDay(userId, date);
  // the free time left today (events and the hours already gone are off) comes from an empty plan
  const empty = (await buildPlan(userId, date, { ai: false, fromNow: true })).plan;
  const capacity = Math.max(0, empty.capacityMinutes);
  const chosen = pick(await candidates(userId, date), capacity);
  if (!chosen.length) return { added: 0, plan: empty, aiError: null as string | null, capacity };
  const adds = chosen.map((c) => {
    const [kind, id] = c.key.split(":");
    return { userId, addedBy: by, forDate: date, ...(kind === "ticket" ? { ticketId: Number(id) } : kind === "task" ? { taskId: id } : kind === "ptask" ? { projectTaskId: id } : { projectId: id }) };
  });
  await d.insert(schema.ticketDayAdds).values(adds).onConflictDoNothing();
  // the sprint given to each one is the fallback when the AI does not answer; its own minutes replace them when it does
  await d.insert(schema.pipelineDayAlloc).values(chosen.map((c, i) => ({ userId, date, key: c.key, minutes: c.minutes, source: "ai" as const, position: i })));
  const direction = [DIRECTION(opts.locale === "en"), opts.direction ?? ""].filter(Boolean).join(" ");
  const out = await buildPlan(userId, date, { ai: true, locale: opts.locale, by, fromNow: true, direction });
  return { added: chosen.length, plan: out.plan, aiError: out.aiError, capacity };
}
