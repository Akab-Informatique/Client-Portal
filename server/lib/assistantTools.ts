import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { assignedTo, seenBy } from "./pipelineAssign.ts";
import { ticketSource } from "./ticketSource.ts";
import type { PermissionKey } from "../../shared/permissions.ts";

/**
 * Read-only tools the portal assistant may call, as the signed-in person and never through an elevated path.
 * Each tool names the right it needs; the list sent to the model holds only the tools the person has, and the
 * executor checks the right again before running one. Their results are DATA (ticket and task text is written by
 * people): the assistant never follows an instruction found in them.
 */
export class ToolError extends Error {}

export type ToolCtx = { auth: AuthContext };
type ToolDef = {
  name: string;
  permission: PermissionKey;
  description: string;
  run: (ctx: ToolCtx) => Promise<unknown>;
};

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;
const LIMIT = 30;

/** The open to-do tasks the person may see and is assigned to (same rule as GET /api/pipeline/tasks). */
async function myTasks({ auth }: ToolCtx) {
  const me = auth.user.id;
  const rows = await db()
    .select({
      title: schema.pipelineTasks.title,
      status: schema.pipelineTasks.status,
      priority: schema.pipelineTasks.priority,
      kind: schema.pipelineTasks.kind,
      dueDate: schema.pipelineTasks.dueDate,
      checkpointDate: schema.pipelineTasks.checkpointDate,
      checkpointTime: schema.pipelineTasks.checkpointTime,
    })
    .from(schema.pipelineTasks)
    .where(and(seenBy(me), assignedTo(me), ne(schema.pipelineTasks.status, "done")))
    .orderBy(asc(sql`coalesce(${schema.pipelineTasks.dueDate}, '9999-12-31')`), asc(schema.pipelineTasks.createdAt))
    .limit(LIMIT);
  return {
    count: rows.length,
    tasks: rows.map((r) => ({
      title: r.title,
      status: r.status,
      priority: r.priority,
      type: r.kind,
      dueDate: r.dueDate,
      checkpoint: r.checkpointDate ? `${r.checkpointDate} ${r.checkpointTime ?? "17:00"}` : null,
    })),
  };
}

/** The open tickets the person is on (main or secondary technician), scoped as the tickets list is. */
async function myTickets({ auth }: ToolCtx) {
  const scope = auth.permissions.includes("tickets.selfManaged") ? { right: true, include: [] as number[] } : {};
  const src = await ticketSource(scope);
  const me = await src.meId(auth);
  const [all, opts] = await Promise.all([src.list(), src.options()]);
  const kind = new Map(opts.statuses.map((s) => [s.value, s.kind]));
  const statusLabel = new Map(opts.statuses.map((s) => [s.value, s.label ?? s.value]));
  const priorityLabel = new Map(opts.priorities.map((p) => [p.value, p.label ?? p.value]));
  const mine = all
    .filter((t) => Boolean(me) && (t.assignee?.id === me || t.secondary.some((p) => p.id === me)) && kind.get(t.status) !== "complete")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const shown = mine.slice(0, LIMIT);
  const meta = shown.length
    ? await db()
        .select({ id: schema.ticketMeta.ticketId, day: schema.ticketMeta.milestoneDate, time: schema.ticketMeta.milestoneTime })
        .from(schema.ticketMeta)
        .where(inArray(schema.ticketMeta.ticketId, shown.map((t) => t.id)))
    : [];
  const checkpoint = new Map(meta.filter((m) => m.day).map((m) => [m.id, `${m.day} ${m.time ?? "17:00"}`]));
  return {
    count: mine.length,
    tickets: shown.map((t) => ({
      number: t.number,
      title: t.title,
      status: statusLabel.get(t.status) ?? t.status,
      priority: priorityLabel.get(t.priority) ?? t.priority,
      dueAt: t.dueAt.slice(0, 16),
      checkpoint: checkpoint.get(t.id) ?? null,
      client: t.company.name,
    })),
  };
}

/** The open projects the person leads or is in the team of (same people as the projects list's "mine"). */
async function myProjects({ auth }: ToolCtx) {
  const me = auth.user.id;
  const p = schema.projects;
  const rows = await db()
    .select({ id: p.id, number: p.number, name: p.name, status: p.status, dueDate: p.dueDate, clientId: p.clientId, leadId: p.leadId })
    .from(p)
    .where(
      and(
        sql`${p.status} not in ('done','cancelled')`,
        or(eq(p.leadId, me), sql`exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = ${me})`),
      ),
    )
    .orderBy(asc(sql`coalesce(${p.dueDate}, '9999-12-31')`), asc(p.number))
    .limit(LIMIT);
  const ids = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => Boolean(x)))];
  const clients = ids.length ? await db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, ids)) : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  return {
    count: rows.length,
    projects: rows.map((r) => ({
      number: r.number,
      name: r.name,
      status: r.status,
      dueDate: r.dueDate,
      client: r.clientId ? (clientName.get(r.clientId) ?? null) : null,
      lead: r.leadId === me,
    })),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "my_tasks",
    permission: "pipeline.view",
    description: "List the signed-in person's open to-do tasks (not done), those assigned to them and visible to them, with status, priority, due day and checkpoint. Use it for \"what do I have to do\" questions about tasks.",
    run: myTasks,
  },
  {
    name: "my_tickets",
    permission: "tickets.view",
    description: "List the open tickets the signed-in person is on (main or secondary technician): number, title, status, priority, due date, checkpoint and client. Use it for questions about their own tickets.",
    run: myTickets,
  },
  {
    name: "my_projects",
    permission: "projects.view",
    description: "List the open projects the signed-in person leads or is part of the team of: number, name, status, due day and client.",
    run: myProjects,
  },
];

/** The tool definitions this person may use (the only ones the model is told about). */
export function toolsFor(perms: readonly string[]) {
  return TOOLS.filter((t) => perms.includes(t.permission)).map((t) => ({ name: t.name, description: t.description, input_schema: NO_INPUT }));
}

/** Runs a tool for this person. Refused unless they hold its right. */
export async function runTool(name: string, ctx: ToolCtx): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError("unknown_tool");
  if (!ctx.auth.permissions.includes(tool.permission)) throw new ToolError("forbidden");
  return tool.run(ctx);
}
