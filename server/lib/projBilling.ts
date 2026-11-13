import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";
import { projectSaleOf } from "../../shared/quotes.ts";
import { depositOfProject } from "./projectLinks.ts";
import { insertProject, snapshotOf } from "./proj.ts";
import { addDays, todayQc } from "./timesheets.ts";
import { getQuote } from "./quotes.ts";

/**
 * New-format projects: billing (the price sold of a fixed-price / bank project goes to Approbation once), bringing the
 * archive projects over, and making a project from a ticket or from a quote.
 */

export class ProjBillError extends Error {}

/** A fixed price or a bank of hours is sold as a package: one line in Approbation (less the quote's deposit), once */
export async function billProj(projectId: string) {
  const d = db();
  const [p] = await d.select().from(schema.projProjects).where(eq(schema.projProjects.id, projectId));
  if (!p) throw new ProjBillError("not_found");
  if (p.billingMode !== "fixed" && p.billingMode !== "bank") throw new ProjBillError("project_not_sold");
  if (!p.clientId) throw new ProjBillError("project_no_client");
  if (!p.fixedPriceCents || p.fixedPriceCents <= 0) throw new ProjBillError("project_no_price");
  const [already] = await d.select({ id: schema.billingItems.id }).from(schema.billingItems).where(like(schema.billingItems.sourceId, `project:${p.id}%`));
  if (already || p.invoicedAt) throw new ProjBillError("project_billed");
  const hours = (p.soldHoursX100 ?? 0) / 100;
  const qty = hours > 0 ? Math.round(hours * 100) : 100;
  const unit = Math.round((p.fixedPriceCents * 100) / qty);
  const day = todayQc();
  const now = new Date();
  const name = `Projet ${p.number} — ${p.name}${hours > 0 ? ` — ${hours.toLocaleString("fr-CA")} h` : ""}`;
  // a bank of hours is paid in full when sold; a fixed price takes off the deposit taken on the quote's hours
  const dep = p.billingMode === "fixed" ? await depositOfProject(p) : null;
  const values = [
    { clientId: p.clientId, kind: "project", source: "portal", sourceId: `project:${p.id}`, date: day, description: name.slice(0, 2000), ticketNumber: p.number, quantityX100: qty, unitPriceCents: unit, amountCents: p.fixedPriceCents, taxable: true, status: "pending", edited: true },
    ...(dep?.lines ?? [])
      .filter((l) => l.amountCents > 0)
      .map((l, i) => ({
        clientId: p.clientId!,
        kind: "project",
        source: "portal",
        sourceId: `project:${p.id}:deposit:${i}`,
        date: day,
        description: `Moins le dépôt déjà facturé sur ces heures (facture ${dep!.number}, soumission ${dep!.quoteNumber})${dep!.lines.length > 1 && !l.taxable ? " — non taxable" : ""}`,
        ticketNumber: p.number,
        quantityX100: 100,
        unitPriceCents: -l.amountCents,
        amountCents: -l.amountCents,
        taxable: l.taxable,
        status: "pending",
        edited: true,
      })),
  ];
  if (values.reduce((n, v) => n + v.amountCents, 0) <= 0) throw new ProjBillError("project_nothing_to_bill");
  await d.insert(schema.billingItems).values(values.map((v) => ({ ...v, syncedAt: now })));
  await d.update(schema.projProjects).set({ invoicedAt: now, updatedAt: now }).where(eq(schema.projProjects.id, p.id));
  return { lines: values.length, totalCents: values.reduce((n, v) => n + v.amountCents, 0), deposit: dep ? { number: dep.number, subtotalCents: dep.subtotalCents } : null };
}

/** What the project's sale stands at: its lines in Approbation / on an invoice */
export async function projBilling(projectId: string) {
  return db()
    .select({ id: schema.billingItems.id, description: schema.billingItems.description, amountCents: schema.billingItems.amountCents, status: schema.billingItems.status, invoiceId: schema.billingItems.invoiceId, number: schema.clientInvoices.number })
    .from(schema.billingItems)
    .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.billingItems.invoiceId))
    .where(like(schema.billingItems.sourceId, `project:${projectId}%`));
}

// ── files ────────────────────────────────────────────────────────────────

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A file waiting to go with a note: the ids must be this project's files not yet on a note */
export async function takeFiles(projectId: string, ids: string[], noteId: string): Promise<void> {
  if (!ids.length) return;
  const rows = await db()
    .update(schema.projFiles)
    .set({ noteId })
    .where(and(inArray(schema.projFiles.id, ids), eq(schema.projFiles.projectId, projectId), sql`${schema.projFiles.noteId} is null`))
    .returning({ id: schema.projFiles.id });
  if (rows.length !== new Set(ids).size) throw new HTTPException(400, { message: "file_invalid" });
}

/** The files to send with a reply (checked to be this project's, not on a note yet) */
export async function pendingFiles(projectId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db()
    .select()
    .from(schema.projFiles)
    .where(and(inArray(schema.projFiles.id, ids), eq(schema.projFiles.projectId, projectId), sql`${schema.projFiles.noteId} is null`));
  if (rows.length !== new Set(ids).size) throw new HTTPException(400, { message: "file_invalid" });
  return rows;
}

// ── the archive, brought over ────────────────────────────────────────────

/** The archive projects (projects) and whether each is already in the new format */
export async function archiveProjects() {
  const d = db();
  const rows = await d.select().from(schema.projects).orderBy(asc(schema.projects.number));
  const done = new Map((await d.select({ legacy: schema.projProjects.legacyId, id: schema.projProjects.id }).from(schema.projProjects)).filter((r) => r.legacy).map((r) => [r.legacy!, r.id]));
  const [tasks, notes, taskNotes, phaseNotes, files, entries] = await Promise.all([
    d.select({ projectId: schema.projectTasks.projectId }).from(schema.projectTasks),
    d.select({ projectId: schema.projectNotes.projectId }).from(schema.projectNotes),
    d.select({ projectId: schema.projectTasks.projectId }).from(schema.projectTaskNotes).innerJoin(schema.projectTasks, eq(schema.projectTasks.id, schema.projectTaskNotes.taskId)),
    d.select({ projectId: schema.projectMilestones.projectId }).from(schema.projectMilestoneNotes).innerJoin(schema.projectMilestones, eq(schema.projectMilestones.id, schema.projectMilestoneNotes.milestoneId)),
    d.select({ projectId: schema.projectFiles.projectId }).from(schema.projectFiles),
    d.select({ projectId: schema.timesheetEntries.projectId }).from(schema.timesheetEntries).where(sql`${schema.timesheetEntries.projectId} is not null and ${schema.timesheetEntries.projId} is null`),
  ]);
  const count = (list: { projectId: string | null }[], id: string) => list.filter((x) => x.projectId === id).length;
  return rows.map((p) => ({
    id: p.id,
    number: p.number,
    name: p.name,
    status: p.status,
    billingMode: p.billingMode,
    tasks: count(tasks, p.id),
    notes: count(notes, p.id) + count(taskNotes, p.id) + count(phaseNotes, p.id),
    files: count(files, p.id),
    entries: count(entries, p.id),
    imported: done.has(p.id),
    newId: done.get(p.id) ?? null,
  }));
}

/**
 * Brings one archive project into the new format, once (`legacy_id`): the number, name, client, lead, team, dates, status, hours
 * sold, billing, the quote; the tasks (phases dropped), every note (project, task and phase notes — replies stay public, tagged to their
 * task) and the files (on one note); the time entered on it, with the tasks each entry covered; and the lines already in Approbation.
 */
export async function importArchiveProject(archiveId: string, actorId: string) {
  const d = db();
  const [old] = await d.select().from(schema.projects).where(eq(schema.projects.id, archiveId));
  if (!old) throw new HTTPException(404, { message: "not_found" });
  const [dup] = await d.select({ id: schema.projProjects.id }).from(schema.projProjects).where(eq(schema.projProjects.legacyId, old.id));
  if (dup) throw new HTTPException(409, { message: "already_imported" });
  const [taken] = await d.select({ id: schema.projProjects.id }).from(schema.projProjects).where(eq(schema.projProjects.number, old.number));
  if (taken) throw new HTTPException(409, { message: "number_taken" });
  // on hold has no place in the new format: it waits as "active"
  const status = old.status === "on_hold" ? "active" : old.status;
  const [row] = await d
    .insert(schema.projProjects)
    .values({
      number: old.number,
      name: old.name,
      clientId: old.clientId,
      leadId: old.leadId,
      status,
      startDate: old.startDate,
      dueDate: old.dueDate,
      soldHoursX100: old.budgetHoursX100,
      description: old.description,
      quoteId: old.quoteId,
      billingMode: old.billingMode,
      contractId: old.contractId,
      hourlyRateCents: old.hourlyRateCents,
      fixedPriceCents: old.fixedPriceCents,
      bankExpiresOn: old.bankExpiresOn,
      invoicedAt: old.invoicedAt,
      legacyId: old.id,
      createdBy: old.createdBy,
      createdAt: old.createdAt,
      doneAt: old.closedAt,
    })
    .returning();
  try {
    if (old.quoteId) {
      const snap = await snapshotOf(old.quoteId).catch(() => null);
      if (snap) await d.update(schema.projProjects).set({ quoteSnapshot: snap.snapshot, salesNotes: snap.internalNotes ?? "" }).where(eq(schema.projProjects.id, row.id));
    }
    const members = await d.select({ userId: schema.projectMembers.userId }).from(schema.projectMembers).where(eq(schema.projectMembers.projectId, old.id));
    const team = [...new Set([...members.map((m) => m.userId), ...(old.leadId ? [old.leadId] : [])])];
    if (team.length) await d.insert(schema.projMembers).values(team.map((userId) => ({ projectId: row.id, userId })));
    // the tasks, phases dropped: in the old order (phase, then place)
    const phases = await d.select().from(schema.projectMilestones).where(eq(schema.projectMilestones.projectId, old.id)).orderBy(asc(schema.projectMilestones.position));
    const oldTasks = await d.select().from(schema.projectTasks).where(eq(schema.projectTasks.projectId, old.id));
    const phaseOrder = new Map(phases.map((m, i) => [m.id, i]));
    oldTasks.sort((a, b) => (phaseOrder.get(a.milestoneId) ?? 0) - (phaseOrder.get(b.milestoneId) ?? 0) || a.position - b.position);
    const taskMap = new Map<string, string>();
    let position = 0;
    for (const t of oldTasks) {
      const [nt] = await d
        .insert(schema.projTasks)
        .values({
          projectId: row.id,
          title: t.title,
          description: [t.status === "blocked" ? "[Bloqué]" : "", t.description].filter(Boolean).join(" "),
          priority: t.priority === "normal" ? "medium" : t.priority,
          status: t.status === "done" ? "done" : t.status === "doing" ? "doing" : "todo",
          assigneeId: t.assigneeId,
          dueDate: t.dueDate,
          position: position++,
          doneAt: t.doneAt,
          createdBy: old.createdBy,
          createdAt: t.createdAt,
        })
        .returning({ id: schema.projTasks.id });
      taskMap.set(t.id, nt.id);
    }
    // notes: the project's, then each task's and each phase's (replies are public, with the addresses they went to)
    const noteRows: (typeof schema.projNotes.$inferInsert & { task?: string })[] = [];
    for (const n of await d.select().from(schema.projectNotes).where(eq(schema.projectNotes.projectId, old.id))) noteRows.push({ projectId: row.id, authorId: n.authorId, text: n.text, internal: n.internal, createdAt: n.createdAt });
    if (oldTasks.length) {
      for (const n of await d.select().from(schema.projectTaskNotes).where(inArray(schema.projectTaskNotes.taskId, oldTasks.map((t) => t.id)))) {
        noteRows.push({ projectId: row.id, authorId: n.authorId, text: n.text, internal: n.kind !== "reply", emailedTo: n.emailedTo ?? [], createdAt: n.createdAt, task: taskMap.get(n.taskId) });
      }
    }
    if (phases.length) {
      for (const n of await d.select().from(schema.projectMilestoneNotes).where(inArray(schema.projectMilestoneNotes.milestoneId, phases.map((m) => m.id)))) {
        noteRows.push({ projectId: row.id, authorId: n.authorId, text: n.text, internal: n.kind !== "reply", emailedTo: n.emailedTo ?? [], createdAt: n.createdAt });
      }
    }
    for (const { task, ...v } of noteRows) {
      const [n] = await d.insert(schema.projNotes).values(v).returning({ id: schema.projNotes.id });
      if (task) await d.insert(schema.projNoteTasks).values({ noteId: n.id, taskId: task });
    }
    // the files, kept like a ticket's: on one note
    const files = await d.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, old.id));
    if (files.length) {
      const [n] = await d
        .insert(schema.projNotes)
        .values({ projectId: row.id, authorId: null, text: `Fichiers importés de l'archive (${files.length}).`, internal: true })
        .returning({ id: schema.projNotes.id });
      await d.insert(schema.projFiles).values(files.map((f) => ({ projectId: row.id, noteId: n.id, name: f.name, contentType: f.contentType, size: f.size, data: f.data, author: f.author, createdAt: f.createdAt })));
    }
    // the time: counted on the new project, with the tasks each entry covered (the entries stay readable in the archive)
    const entries = await d
      .update(schema.timesheetEntries)
      .set({ projId: row.id })
      .where(and(eq(schema.timesheetEntries.projectId, old.id), sql`${schema.timesheetEntries.projId} is null`))
      .returning({ id: schema.timesheetEntries.id, oldTask: schema.timesheetEntries.taskId });
    if (entries.length) {
      const covered = await d.select().from(schema.timesheetEntryTasks).where(inArray(schema.timesheetEntryTasks.entryId, entries.map((e) => e.id)));
      const links = new Map<string, { entryId: string; taskId: string; done: boolean }>();
      for (const c of covered) {
        const taskId = taskMap.get(c.taskId);
        if (taskId) links.set(`${c.entryId}|${taskId}`, { entryId: c.entryId, taskId, done: c.statusAfter === "done" });
      }
      for (const e of entries) {
        const taskId = e.oldTask ? taskMap.get(e.oldTask) : undefined;
        if (taskId && !links.has(`${e.id}|${taskId}`)) links.set(`${e.id}|${taskId}`, { entryId: e.id, taskId, done: false });
      }
      if (links.size) await d.insert(schema.projTimeTasks).values([...links.values()]).onConflictDoNothing();
      // the lines already in Approbation follow their entries (never billed twice)
      for (const e of entries) {
        await d.update(schema.billingItems).set({ sourceId: `projtime:${e.id}`, kind: "project" }).where(eq(schema.billingItems.sourceId, `prtime:${e.id}`));
      }
    }
    // the price sold already in Approbation follows the project
    const sale = await d.select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId }).from(schema.billingItems).where(like(schema.billingItems.sourceId, `project:${old.id}%`));
    for (const s of sale) await d.update(schema.billingItems).set({ sourceId: s.sourceId!.replace(old.id, row.id) }).where(eq(schema.billingItems.id, s.id));
  } catch (e) {
    // nothing half-brought: the project goes (its children with it) and the entries go back
    await d.update(schema.timesheetEntries).set({ projId: null }).where(eq(schema.timesheetEntries.projId, row.id));
    await d.delete(schema.projProjects).where(eq(schema.projProjects.id, row.id));
    throw e;
  }
  void actorId;
  return row;
}

// ── a project made from a quote ──────────────────────────────────────────

/** The quote's sale: hours and price of its hour lines, billed the way it was sold (fixed price, bank of hours, by the hour) */
export async function projectFromQuote(quoteId: string, actorId: string) {
  const d = db();
  const q = await getQuote(quoteId);
  if (!q) throw new HTTPException(404, { message: "not_found" });
  if (!q.clientId) throw new HTTPException(409, { message: "project_needs_client" });
  const [exists] = await d.select({ id: schema.projProjects.id }).from(schema.projProjects).where(eq(schema.projProjects.quoteId, quoteId));
  if (exists) throw new HTTPException(409, { message: "quote_has_project" });
  const snap = await snapshotOf(quoteId);
  const sale = projectSaleOf((q.lines ?? []) as Parameters<typeof projectSaleOf>[0]);
  const hours = sale.hours;
  const [raw] = await d.select({ saleType: schema.quotes.saleType, preparedBy: schema.quotes.preparedBy, createdBy: schema.quotes.createdBy }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  const saleType = raw?.saleType ?? "fixed";
  const mode = saleType === "bank" ? "bank" : saleType === "hourly" ? "hourly" : "fixed";
  const today = todayQc();
  // the technician who prepared the quote leads the project when they are active staff, else the one who clicks
  const preparer = raw?.preparedBy ?? raw?.createdBy ?? null;
  const [lead] = preparer ? await d.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, preparer), eq(schema.users.kind, "staff"), eq(schema.users.active, true))) : [];
  const leadId = lead?.id ?? actorId;
  const row = await insertProject({
    name: q.title || `Projet ${q.number}`,
    clientId: q.clientId,
    leadId,
    status: "planning",
    soldHoursX100: hours == null ? null : Math.round(hours * 100),
    description: "",
    salesNotes: snap.internalNotes ?? "",
    quoteId,
    quoteSnapshot: snap.snapshot,
    billingMode: mode,
    fixedPriceCents: mode === "hourly" ? null : sale.priceCents,
    // a bank of hours: the hour is the price sold ÷ the hours, and it runs a year
    hourlyRateCents: mode === "bank" && hours ? Math.round(sale.priceCents / hours) : mode === "hourly" && hours ? Math.round(sale.priceCents / hours) : null,
    bankExpiresOn: mode === "bank" ? addDays(today, 365) : null,
    createdBy: actorId,
  });
  const team = [...new Set([leadId, actorId])];
  await d.insert(schema.projMembers).values(team.map((userId) => ({ projectId: row.id, userId }))).onConflictDoNothing();
  await d.update(schema.quotes).set({ projectAt: new Date() }).where(eq(schema.quotes.id, quoteId));
  return { project: row, sale: { hours, priceCents: sale.priceCents, mode } };
}

// ── a project made from a ticket ─────────────────────────────────────────

const isUuid = (s: string | null | undefined): s is string => Boolean(s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));

/**
 * Turns a ticket into a project: the client, contact, people, due day, estimate, contract (when it is an active one of the client),
 * the description, the checklist (as tasks), every note (oldest first, each headed with the ticket and the author) and the files
 * (on one note). The ticket is closed as "transformed" with a note; time and charges already on it stay on it and bill themselves.
 */
export async function projectFromTicket(ticketId: number, actorId: string) {
  const d = db();
  const [t] = await d.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (!t) throw new HTTPException(404, { message: "not_found" });
  if (t.mergedIntoId != null) throw new HTTPException(409, { message: "ticket_merged" });
  if (t.completedAt) throw new HTTPException(409, { message: "ticket_complete" });
  const [client] = await d.select().from(schema.clients).where(eq(schema.clients.autotaskId, t.companyId));
  if (!client) throw new HTTPException(409, { message: "project_needs_client" });
  const [contact] = t.contactId ? await d.select({ id: schema.clientContacts.id }).from(schema.clientContacts).where(and(eq(schema.clientContacts.clientId, client.id), eq(schema.clientContacts.autotaskId, t.contactId))) : [];
  const [meta] = await d.select().from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, t.id));
  // the people: the technician (when a staff account) and the ones helping; the one who clicks is the lead when the ticket has nobody
  const wanted = [t.assigneeId, ...(t.secondary ?? []).map((s) => s.id), actorId].filter(isUuid);
  const staff = new Set(
    (await d.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, wanted), eq(schema.users.kind, "staff"), eq(schema.users.active, true)))).map((u) => u.id),
  );
  const leadId = isUuid(t.assigneeId) && staff.has(t.assigneeId) ? t.assigneeId : actorId;
  const team = [...new Set([leadId, ...wanted.filter((id) => staff.has(id))])];
  // the ticket's contract, when it is an active one of this client
  const [contract] = meta?.contractId
    ? await d.select().from(schema.clientContracts).where(and(eq(schema.clientContracts.id, meta.contractId), eq(schema.clientContracts.clientId, client.id), eq(schema.clientContracts.active, true)))
    : [];
  const row = await insertProject({
    name: t.title.slice(0, 200),
    clientId: client.id,
    leadId,
    contactId: contact?.id ?? null,
    status: "active",
    startDate: todayQc(),
    dueDate: t.dueAt.toISOString().slice(0, 10),
    soldHoursX100: meta?.estimateMinutes ? Math.round((meta.estimateMinutes / 60) * 100) : null,
    description: t.description.slice(0, 8000),
    billingMode: contract ? "contract" : "hourly",
    contractId: contract?.id ?? null,
    createdBy: actorId,
  });
  try {
    await d.insert(schema.projMembers).values(team.map((userId) => ({ projectId: row.id, userId })));
    const items = await d.select().from(schema.ticketChecklist).where(eq(schema.ticketChecklist.ticketId, t.id)).orderBy(asc(schema.ticketChecklist.position));
    if (items.length) {
      await d.insert(schema.projTasks).values(items.map((i, n) => ({ projectId: row.id, title: i.text.slice(0, 300), status: i.done ? ("done" as const) : ("todo" as const), position: n, doneAt: i.doneAt, createdBy: actorId })));
    }
    const notes = await d.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t.id), eq(schema.ticketNotes.system, false))).orderBy(asc(schema.ticketNotes.createdAt));
    for (const n of notes) {
      const head = `[${t.number} · ${n.createdAt.toISOString().slice(0, 10)} · ${n.author || "—"} · ${n.internal ? "note interne" : "discussion"}]`;
      await d.insert(schema.projNotes).values({ projectId: row.id, authorId: n.userId, text: `${head}\n${n.text}`.slice(0, 8000), internal: n.internal, createdAt: n.createdAt });
    }
    const files = await d.select().from(schema.ticketAttachments).where(and(eq(schema.ticketAttachments.ticketId, t.id), sql`${schema.ticketAttachments.data} is not null`));
    if (files.length) {
      const [n] = await d.insert(schema.projNotes).values({ projectId: row.id, authorId: actorId, text: `Fichiers du billet ${t.number} (${files.length}).`, internal: true }).returning({ id: schema.projNotes.id });
      await d.insert(schema.projFiles).values(files.map((f) => ({ projectId: row.id, noteId: n.id, name: f.name, contentType: f.contentType, size: f.size, data: f.data!, author: f.author, createdAt: f.createdAt })));
    }
  } catch (e) {
    await d.delete(schema.projProjects).where(eq(schema.projProjects.id, row.id));
    throw e;
  }
  // the ticket is closed, with a note that says where it went; its running timers are thrown away
  const now = new Date();
  await d.update(schema.tickets).set({ status: "transformed", completedAt: now, updatedAt: now }).where(eq(schema.tickets.id, t.id));
  await d.insert(schema.ticketNotes).values({ ticketId: t.id, author: "", userId: actorId, text: `Transformé en projet ${row.number} — ${row.name}`, internal: true, system: false });
  await d.delete(schema.ticketTimers).where(eq(schema.ticketTimers.ticketId, t.id));
  return { project: row, ticketNumber: t.number };
}
