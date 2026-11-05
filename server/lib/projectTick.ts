import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { notify } from "./notify.ts";
import { todayQc } from "./timesheets.ts";

/**
 * Every minute: the bell rings for the project reminders whose day has come (the person it is for, else the lead),
 * and once for each project whose follow-up (checkpoint) day has come — the lead and the team are told. A reminder
 * rings once; a follow-up rings once per checkpoint day (`checkpoint_notified_for`) until it is marked done.
 */
export async function projectTick(): Promise<number> {
  const today = todayQc();
  let sent = 0;
  const due = await db()
    .select({ r: schema.projectReminders, number: schema.projects.number, name: schema.projects.name, lead: schema.projects.leadId })
    .from(schema.projectReminders)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectReminders.projectId))
    .where(and(lte(schema.projectReminders.remindOn, today), isNull(schema.projectReminders.doneAt), isNull(schema.projectReminders.notifiedAt)));
  for (const { r, number, name, lead } of due) {
    // claimed before sending: a restart never rings it twice
    const claimed = await db().update(schema.projectReminders).set({ notifiedAt: new Date() }).where(and(eq(schema.projectReminders.id, r.id), isNull(schema.projectReminders.notifiedAt))).returning({ id: schema.projectReminders.id });
    if (!claimed.length) continue;
    const to = r.userId ?? lead;
    if (to) {
      await notify([to], { type: "project.reminder", data: { number, name, text: r.text, kind: "reminder" }, link: `/projects?project=${r.projectId}` });
      sent++;
    }
  }
  const follow = await db()
    .select()
    .from(schema.projects)
    .where(and(isNotNull(schema.projects.checkpointEveryDays), isNotNull(schema.projects.checkpointDate), lte(schema.projects.checkpointDate, today), sql`${schema.projects.status} not in ('done','cancelled')`, sql`${schema.projects.checkpointNotifiedFor} is distinct from ${schema.projects.checkpointDate}`));
  for (const p of follow) {
    const claimed = await db().update(schema.projects).set({ checkpointNotifiedFor: p.checkpointDate }).where(and(eq(schema.projects.id, p.id), sql`${schema.projects.checkpointNotifiedFor} is distinct from ${schema.projects.checkpointDate}`)).returning({ id: schema.projects.id });
    if (!claimed.length) continue;
    const team = (await db().select({ u: schema.projectMembers.userId }).from(schema.projectMembers).where(eq(schema.projectMembers.projectId, p.id))).map((m) => m.u);
    const to = [...new Set([...(p.leadId ? [p.leadId] : []), ...team])];
    if (to.length) {
      await notify(to, { type: "project.reminder", data: { number: p.number, name: p.name, kind: "followup" }, link: `/projects?project=${p.id}` });
      sent += to.length;
    }
  }
  return sent;
}
