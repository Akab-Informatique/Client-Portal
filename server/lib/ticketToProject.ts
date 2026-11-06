import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings } from "./billing.ts";
import { moveCharge } from "./chargeMove.ts";
import { nextProjectNumber } from "./projectLinks.ts";

export class TransformError extends Error {
  constructor(
    public code: string,
    public status: 400 | 404 | 409 = 409,
  ) {
    super(code);
  }
}

/** What turning a ticket into a project would move and what stays on the ticket (the dialog shows it before) */
export async function transformPreview(ticketId: number) {
  const d = db();
  const [notes, times, charges] = await Promise.all([
    d.select({ id: schema.ticketNotes.id, system: schema.ticketNotes.system }).from(schema.ticketNotes).where(eq(schema.ticketNotes.ticketId, ticketId)),
    d.select().from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.ticketId, ticketId)),
    d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, ticketId)),
  ]);
  const settled = await settledSources([...times.map((e) => e.externalId ?? `ptime:${e.id}`), ...charges.map((c) => c.externalId ?? `pcharge:${c.id}`)]);
  const timeRows = times.length ? await d.select({ t: schema.timesheetEntries.ticketTimeId }).from(schema.timesheetEntries).where(inArray(schema.timesheetEntries.ticketTimeId, times.map((e) => e.id))) : [];
  const withRow = new Set(timeRows.map((r) => r.t));
  const movableTime = times.filter((e) => !e.billed && !settled.has(e.externalId ?? `ptime:${e.id}`) && withRow.has(e.id));
  const movableCharges = charges.filter((c) => !c.billed && !settled.has(c.externalId ?? `pcharge:${c.id}`));
  return {
    notes: notes.filter((n) => !n.system).length,
    time: { moved: movableTime.length, stays: times.length - movableTime.length },
    charges: { moved: movableCharges.length, stays: charges.length - movableCharges.length },
  };
}

/** The work to bill that is already approved, set aside or invoiced (those stay where they are) */
async function settledSources(sourceIds: string[]) {
  if (!sourceIds.length) return new Set<string>();
  const rows = await db().select({ sourceId: schema.billingItems.sourceId, status: schema.billingItems.status }).from(schema.billingItems).where(inArray(schema.billingItems.sourceId, sourceIds));
  return new Set(rows.filter((r) => r.status !== "pending").map((r) => r.sourceId!));
}

/**
 * A ticket becomes a project. The project takes the ticket's name, description and client; every note and discussion is
 * copied to its notes; the time not yet approved or billed moves to the project (and is marked not billable on the
 * ticket, so it is never billed twice) and so do the charges not yet approved. What is approved or invoiced stays on the
 * ticket. The ticket is then closed with a note naming the project.
 */
export async function transformTicket(ticketId: number, actor: { id: string; name: string }, opts: { name?: string } = {}) {
  const d = db();
  const [tk] = await d.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (!tk) throw new TransformError("not_found", 404);
  if (tk.mergedIntoId != null) throw new TransformError("ticket_merged");
  if (tk.completedAt) throw new TransformError("ticket_complete");
  const [meta] = await d.select({ p: schema.ticketMeta.projectId }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, ticketId));
  if (tk.status === "transformed" || meta?.p) throw new TransformError("ticket_already_project");
  const [client] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, tk.companyId));
  if (!client) throw new TransformError("project_needs_client", 400);

  const number = await nextProjectNumber();
  const rate = (await billingSettings()).rates.hourly;
  const [project] = await d
    .insert(schema.projects)
    .values({
      number,
      name: (opts.name?.trim() || tk.title).slice(0, 200),
      clientId: client.id,
      description: `${tk.description ?? ""}`.slice(0, 8000),
      status: "planning",
      leadId: actor.id,
      billingMode: "hourly",
      hourlyRateCents: Math.round(rate),
      createdBy: actor.id,
    })
    .returning();
  await d.insert(schema.projectMembers).values({ projectId: project.id, userId: actor.id });

  // notes and discussions: copied, oldest first, each saying where it came from
  const notes = await d.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, ticketId), eq(schema.ticketNotes.system, false))).orderBy(asc(schema.ticketNotes.createdAt));
  const day = (x: Date) => x.toISOString().slice(0, 10);
  if (notes.length)
    await d.insert(schema.projectNotes).values(
      notes.map((n) => ({ projectId: project.id, authorId: n.userId, text: `[${tk.number} · ${day(n.createdAt)} · ${n.author || "—"} · ${n.internal ? "note interne" : "discussion"}]\n${n.text}`.slice(0, 8000), createdAt: n.createdAt })),
    );

  // time not approved or billed yet: the project's; the ticket's copy is not billable any more
  const times = await d.select().from(schema.ticketTimeEntries).where(and(eq(schema.ticketTimeEntries.ticketId, ticketId), eq(schema.ticketTimeEntries.billed, false)));
  const settled = await settledSources([...times.map((e) => e.externalId ?? `ptime:${e.id}`)]);
  const mine = times.filter((e) => !settled.has(e.externalId ?? `ptime:${e.id}`));
  const rows = mine.length ? await d.select().from(schema.timesheetEntries).where(inArray(schema.timesheetEntries.ticketTimeId, mine.map((e) => e.id))) : [];
  const moved = mine.filter((e) => rows.some((r) => r.ticketTimeId === e.id));
  for (const r of rows) {
    await d
      .update(schema.timesheetEntries)
      .set({ projectId: project.id, milestoneId: null, taskId: null, ticketTimeId: null, ticketId: null, ticketNumber: project.number, ticketTitle: `${project.name} · ${tk.number}`.slice(0, 250), source: "project", clientId: client.id })
      .where(eq(schema.timesheetEntries.id, r.id));
  }
  for (const e of moved) {
    await d
      .update(schema.ticketTimeEntries)
      .set({ billable: false, internalText: `${e.internalText ? `${e.internalText}\n` : ""}[Transféré au projet ${project.number}]` })
      .where(eq(schema.ticketTimeEntries.id, e.id));
  }
  if (moved.length) await d.delete(schema.billingItems).where(and(inArray(schema.billingItems.sourceId, moved.map((e) => e.externalId ?? `ptime:${e.id}`)), eq(schema.billingItems.status, "pending")));

  // charges not approved yet follow the same way
  const charges = await d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, ticketId));
  let chargesMoved = 0;
  for (const c of charges) {
    try {
      await moveCharge(c.id, { ticketId }, { projectId: project.id });
      chargesMoved++;
    } catch {
      // approved, set aside or invoiced: it stays on the ticket
    }
  }

  // the ticket: tied to the project, closed, with a note anyone reads
  await d.insert(schema.ticketMeta).values({ ticketId, projectId: project.id }).onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { projectId: project.id, updatedAt: new Date() } });
  await d.insert(schema.ticketNotes).values({ ticketId, author: actor.name, userId: actor.id, internal: true, system: false, text: `Transformé en projet ${project.number} — ${project.name}` });
  await d.update(schema.tickets).set({ status: "transformed", completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.tickets.id, ticketId));
  await d.delete(schema.ticketTimers).where(eq(schema.ticketTimers.ticketId, ticketId));

  return { project: { id: project.id, number: project.number, name: project.name }, notes: notes.length, time: { moved: moved.length, stays: times.length - moved.length }, charges: { moved: chargesMoved, stays: charges.length - chargesMoved } };
}
