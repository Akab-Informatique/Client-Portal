import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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

/** The work to bill that is already approved, set aside or invoiced (those stay where they are) */
async function settledSources(sourceIds: string[]) {
  if (!sourceIds.length) return new Set<string>();
  const rows = await db().select({ sourceId: schema.billingItems.sourceId, status: schema.billingItems.status }).from(schema.billingItems).where(inArray(schema.billingItems.sourceId, sourceIds));
  return new Set(rows.filter((r) => r.status !== "pending").map((r) => r.sourceId!));
}

/** What turning a ticket into a project would move and what stays on the ticket (the dialog shows it before) */
export async function transformPreview(ticketId: number) {
  const d = db();
  const [notes, times, charges, checklist, files] = await Promise.all([
    d.select({ id: schema.ticketNotes.id, system: schema.ticketNotes.system }).from(schema.ticketNotes).where(eq(schema.ticketNotes.ticketId, ticketId)),
    d.select().from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.ticketId, ticketId)),
    d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, ticketId)),
    d.select({ id: schema.ticketChecklist.id }).from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId)),
    d.select({ id: schema.ticketAttachments.id }).from(schema.ticketAttachments).where(and(eq(schema.ticketAttachments.ticketId, ticketId), isNotNull(schema.ticketAttachments.data))),
  ]);
  const settled = await settledSources([...times.map((e) => e.externalId ?? `ptime:${e.id}`), ...charges.map((c) => c.externalId ?? `pcharge:${c.id}`)]);
  const timeRows = times.length ? await d.select({ t: schema.timesheetEntries.ticketTimeId }).from(schema.timesheetEntries).where(inArray(schema.timesheetEntries.ticketTimeId, times.map((e) => e.id))) : [];
  const withRow = new Set(timeRows.map((r) => r.t));
  const movableTime = times.filter((e) => !e.billed && !settled.has(e.externalId ?? `ptime:${e.id}`) && withRow.has(e.id));
  const movableCharges = charges.filter((c) => !c.billed && !settled.has(c.externalId ?? `pcharge:${c.id}`));
  return {
    notes: notes.filter((n) => !n.system).length,
    checklist: checklist.length,
    files: files.length,
    time: { moved: movableTime.length, stays: times.length - movableTime.length },
    charges: { moved: movableCharges.length, stays: charges.length - movableCharges.length },
  };
}

/**
 * A ticket becomes a project. The project takes the ticket's name, description, client, dates, estimate, contract and
 * people; a first note keeps what the ticket was (contact, priority, tags…); every note and discussion is copied to its
 * notes; the checklist becomes a phase "Transfert" with a task per item; the files move; the time not yet approved or
 * billed moves (and is marked not billable on the ticket, so it is never billed twice) and so do the charges not yet
 * approved. What is approved or invoiced stays on the ticket. The ticket is then closed with a note naming the project.
 */
export async function transformTicket(ticketId: number, actor: { id: string; name: string }, opts: { name?: string } = {}) {
  const d = db();
  const [tk] = await d.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (!tk) throw new TransformError("not_found", 404);
  if (tk.mergedIntoId != null) throw new TransformError("ticket_merged");
  if (tk.completedAt) throw new TransformError("ticket_complete");
  const [tm] = await d.select().from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, ticketId));
  if (tk.status === "transformed" || tm?.projectId) throw new TransformError("ticket_already_project");
  const [client] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, tk.companyId));
  if (!client) throw new TransformError("project_needs_client", 400);

  const number = await nextProjectNumber();
  const rate = (await billingSettings()).rates.hourly;
  // the ticket's contract, when it is one of this client's active ones: the project is billed under it
  const wanted = tm?.contractId ?? (tk.contractId && /^[0-9a-f-]{36}$/i.test(tk.contractId) ? tk.contractId : null);
  const [contract] = wanted ? await d.select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(and(eq(schema.clientContracts.id, wanted), eq(schema.clientContracts.clientId, client.id), eq(schema.clientContracts.active, true))) : [];
  const dueDay = tk.dueAt ? tk.dueAt.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : null;
  const estimate = tm?.estimateMinutes && tm.estimateMinutes > 0 ? Math.round((tm.estimateMinutes / 60) * 100) : null;
  // the people of the ticket (its technician and the secondary ones) join the project team
  const ids = [tk.assigneeId, ...(tk.secondary ?? []).map((x) => x.id)].filter((x): x is string => Boolean(x && /^[0-9a-f-]{36}$/i.test(x)));
  const team = ids.length ? await d.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.kind, "staff"), eq(schema.users.active, true))) : [];

  const [project] = await d
    .insert(schema.projects)
    .values({
      number,
      name: (opts.name?.trim() || tk.title).slice(0, 200),
      clientId: client.id,
      description: `${tk.description ?? ""}`.slice(0, 8000),
      status: "planning",
      leadId: actor.id,
      startDate: tm?.startDate ?? null,
      dueDate: dueDay,
      budgetHoursX100: estimate,
      billingMode: contract ? "contract" : "hourly",
      contractId: contract?.id ?? null,
      hourlyRateCents: contract ? null : Math.round(rate),
      createdBy: actor.id,
    })
    .returning();
  await d.insert(schema.projectMembers).values([...new Set([actor.id, ...team.map((x) => x.id)])].map((userId) => ({ projectId: project.id, userId })));

  // notes and discussions: copied, oldest first, each saying where it came from
  const notes = await d.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, ticketId), eq(schema.ticketNotes.system, false))).orderBy(asc(schema.ticketNotes.createdAt));
  const day = (x: Date) => x.toISOString().slice(0, 10);
  if (notes.length)
    await d.insert(schema.projectNotes).values(
      notes.map((n) => ({ projectId: project.id, authorId: n.userId, text: `[${tk.number} · ${day(n.createdAt)} · ${n.author || "—"} · ${n.internal ? "note interne" : "discussion"}]\n${n.text}`.slice(0, 8000), createdAt: n.createdAt })),
    );

  // a first note keeps what the ticket was (the project has no such fields)
  const [{ n: texts }] = await d.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.smsConversations).where(eq(schema.smsConversations.ticketId, ticketId));
  const summary = [
    `Billet d'origine ${tk.number} — ${tk.title}`,
    `Contact : ${tk.contactName || "—"} · Priorité : ${tk.priority} · File : ${tk.queue || "—"} · Source : ${tm?.source ?? tk.source}`,
    `Technicien : ${tk.assigneeName || "—"}${tk.secondary?.length ? ` · Autres : ${tk.secondary.map((x) => x.name).join(", ")}` : ""}`,
    `Échéance du billet : ${dueDay ?? "—"}${tm?.milestoneDate ? ` · Jalon : ${tm.milestoneDate}${tm.milestoneTime ? ` ${tm.milestoneTime}` : ""}` : ""}${tm?.startDate ? ` · Début : ${tm.startDate}` : ""}`,
    tm?.tags?.length ? `Étiquettes : ${tm.tags.join(", ")}` : "",
    tk.assetId ? `Appareil : ${tk.assetId}` : "",
    texts > 0 ? `${texts} conversation(s) par texto restent liées au billet ${tk.number}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await d.insert(schema.projectNotes).values({ projectId: project.id, authorId: actor.id, text: summary, createdAt: new Date((notes[0]?.createdAt ?? new Date()).getTime() - 1000) });

  // the checklist: one phase "Transfert", a task per item, for the team to sort out later
  const items = await d.select().from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId)).orderBy(asc(schema.ticketChecklist.position), asc(schema.ticketChecklist.createdAt));
  if (items.length) {
    const doneCount = items.filter((i) => i.done).length;
    const [phase] = await d
      .insert(schema.projectMilestones)
      .values({
        projectId: project.id,
        name: `Transfert depuis ${tk.number}`.slice(0, 200),
        notes: `Liste de contrôle du billet ${tk.number}, transférée telle quelle. À organiser par l'équipe.`,
        status: doneCount === items.length ? "done" : doneCount > 0 ? "doing" : "todo",
        doneAt: doneCount === items.length ? new Date() : null,
        position: 0,
      })
      .returning();
    await d.insert(schema.projectTasks).values(
      items.map((i, idx) => ({
        projectId: project.id,
        milestoneId: phase.id,
        title: i.text.slice(0, 300),
        description: i.dependsOnId ? `À faire après : ${items.find((x) => x.id === i.dependsOnId)?.text ?? "—"}` : "",
        status: (i.done ? "done" : "todo") as "done" | "todo",
        done: i.done,
        doneAt: i.doneAt ?? null,
        position: idx,
      })),
    );
    await d.delete(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, ticketId));
  }

  // files go to the project
  const files = await d.select().from(schema.ticketAttachments).where(and(eq(schema.ticketAttachments.ticketId, ticketId), isNotNull(schema.ticketAttachments.data)));
  if (files.length) {
    await d.insert(schema.projectFiles).values(files.map((f) => ({ projectId: project.id, name: f.name, contentType: f.contentType, size: f.size, data: f.data!, author: f.author, createdAt: f.createdAt })));
    await d.delete(schema.ticketAttachments).where(inArray(schema.ticketAttachments.id, files.map((f) => f.id)));
  }

  // time not approved or billed yet: the project's; the ticket's copy is not billable any more
  const times = await d.select().from(schema.ticketTimeEntries).where(and(eq(schema.ticketTimeEntries.ticketId, ticketId), eq(schema.ticketTimeEntries.billed, false)));
  const settled = await settledSources(times.map((e) => e.externalId ?? `ptime:${e.id}`));
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
  // a closed ticket is no longer on anyone's day or priorities
  await d.delete(schema.ticketDayAdds).where(eq(schema.ticketDayAdds.ticketId, ticketId));
  await d.delete(schema.ticketPins).where(eq(schema.ticketPins.ticketId, ticketId));

  return {
    project: { id: project.id, number: project.number, name: project.name },
    notes: notes.length,
    checklist: items.length,
    files: files.length,
    team: team.length,
    time: { moved: moved.length, stays: times.length - moved.length },
    charges: { moved: chargesMoved, stays: charges.length - chargesMoved },
  };
}
