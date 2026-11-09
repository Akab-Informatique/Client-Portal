import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { todayQc } from "./timesheets.ts";
import { isHourLine, lineAmount, recurrenceOf } from "../../shared/quotes.ts";

/**
 * Tickets tied to a project (Projets): a support ticket of the project counts its time in the project.
 * The link is `ticket_meta.project_id`; the timesheet rows of the ticket's time carry the project too
 * (`timesheet_entries.project_id`), so every figure of the project (hours, by person, by phase) counts them.
 * Their work to bill stays the ticket's (`ptime:`) — except under a project sold as a package (`fixed`),
 * whose hours are all in the price sold: nothing of them is billed on its own.
 */
export async function projectOfTicket(ticketId: number): Promise<string | null> {
  const [m] = await db().select({ p: schema.ticketMeta.projectId }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, ticketId));
  return m?.p ?? null;
}

/** Ties a ticket to a project (null: unties it); its time already on timesheets follows */
export async function linkTicket(ticketId: number, projectId: string | null) {
  const d = db();
  await d.insert(schema.ticketMeta).values({ ticketId, projectId }).onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { projectId, updatedAt: new Date() } });
  await d
    .update(schema.timesheetEntries)
    .set({ projectId, milestoneId: null, taskId: null })
    .where(and(eq(schema.timesheetEntries.ticketId, ticketId), isNotNull(schema.timesheetEntries.ticketTimeId)));
}

/** The tickets of a project, with the hours logged on each */
export async function ticketsOfProject(projectId: string) {
  const d = db();
  const metas = await d.select({ ticketId: schema.ticketMeta.ticketId }).from(schema.ticketMeta).where(eq(schema.ticketMeta.projectId, projectId));
  if (!metas.length) return [];
  const ids = metas.map((m) => m.ticketId);
  const [rows, hours] = await Promise.all([
    d.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, status: schema.tickets.status, completedAt: schema.tickets.completedAt }).from(schema.tickets).where(inArray(schema.tickets.id, ids)),
    d
      .select({ ticketId: schema.timesheetEntries.ticketId, h: sql<number>`sum(${schema.timesheetEntries.hoursX100})::int` })
      .from(schema.timesheetEntries)
      .where(and(eq(schema.timesheetEntries.projectId, projectId), inArray(schema.timesheetEntries.ticketId, ids)))
      .groupBy(schema.timesheetEntries.ticketId),
  ]);
  return rows
    .map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, done: Boolean(r.completedAt), hours: (hours.find((h) => h.ticketId === r.id)?.h ?? 0) / 100 }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

/** A project's deposit (the deposit invoice of the quote it came from), when there is one not voided */
export async function depositOfProject(p: { quoteId: string | null }) {
  if (!p.quoteId) return null;
  const [q] = await db().select({ number: schema.quotes.number, invoiceId: schema.quotes.depositInvoiceId, lineIds: schema.quotes.depositLineIds }).from(schema.quotes).where(eq(schema.quotes.id, p.quoteId));
  if (!q?.invoiceId) return null;
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, q.invoiceId));
  if (!inv || inv.voided) return null;
  const lines = await db().select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
  // the share of the deposit taken on the hours the project sells (the deposit on equipment is settled with the equipment)
  const quoteLines = await db().select().from(schema.quoteLines).where(eq(schema.quoteLines.quoteId, p.quoteId));
  const covered = quoteLines.filter((l) => !l.optional && recurrenceOf(l) === "once" && (!q.lineIds || q.lineIds.includes(l.id)));
  const all = covered.reduce((n, l) => n + lineAmount(l), 0);
  const hours = covered.filter(isHourLine).reduce((n, l) => n + lineAmount(l), 0);
  const share = all > 0 ? hours / all : 0;
  const scaled = lines.map((l) => ({ amountCents: Math.round(l.amountCents * share), taxable: l.taxable })).filter((l) => l.amountCents > 0);
  return { quoteNumber: q.number, invoiceId: inv.id, number: inv.number, subtotalCents: scaled.reduce((n, l) => n + l.amountCents, 0), depositCents: lines.reduce((n, l) => n + l.amountCents, 0), lines: scaled };
}

/** P-1001, P-1002… (the highest + 1) */
export async function nextProjectNumber(): Promise<string> {
  const rows = await db().select({ n: schema.projects.number }).from(schema.projects);
  const highest = rows.reduce((m, r) => Math.max(m, Number(r.n.replace(/\D/g, "")) || 0), 1000);
  return `P-${highest + 1}`;
}

export class ProjectBillError extends Error {}

/**
 * The price sold goes to Approbation as the client will see it: one line "Projet P-1001 — name — 30 h"
 * (quantity = hours sold, the price shared over them), less the quote's deposit (one negative line per tax
 * treatment, so taxes come off as they were charged). Pending, like any work to bill; once only.
 */
export async function billProject(actorId: string, projectId: string) {
  const d = db();
  const [p] = await d.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) throw new ProjectBillError("not_found");
  if (p.billingMode !== "fixed" && p.billingMode !== "bank") throw new ProjectBillError("project_not_sold");
  if (!p.clientId) throw new ProjectBillError("project_no_client");
  if (!p.fixedPriceCents || p.fixedPriceCents <= 0) throw new ProjectBillError("project_no_price");
  const [already] = await d.select({ id: schema.billingItems.id }).from(schema.billingItems).where(like(schema.billingItems.sourceId, `project:${p.id}%`));
  if (already || p.invoicedAt) throw new ProjectBillError("project_billed");
  const hours = (p.budgetHoursX100 ?? 0) / 100;
  const qty = hours > 0 ? Math.round(hours * 100) : 100;
  const unit = Math.round((p.fixedPriceCents * 100) / qty);
  const day = todayQc();
  const now = new Date();
  const name = `Projet ${p.number} — ${p.name}${hours > 0 ? ` — ${hours.toLocaleString("fr-CA")} h` : ""}`;
  const dep = await depositOfProject(p);
  const values = [
    {
      clientId: p.clientId,
      kind: "project",
      source: "portal",
      sourceId: `project:${p.id}`,
      date: day,
      description: name.slice(0, 2000),
      ticketNumber: p.number,
      quantityX100: qty,
      unitPriceCents: unit,
      // the line is the price sold, to the cent (the unit price is rounded)
      amountCents: p.fixedPriceCents,
      taxable: true,
      status: "pending",
      edited: true,
    },
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
  // a deposit that already paid everything (a bank of hours is paid in full) leaves nothing to bill
  if (values.reduce((n, v) => n + v.amountCents, 0) <= 0) throw new ProjectBillError("project_nothing_to_bill");
  await d.insert(schema.billingItems).values(values.map((v) => ({ ...v, syncedAt: now })));
  await d.update(schema.projects).set({ invoicedAt: now, updatedAt: now }).where(eq(schema.projects.id, p.id));
  return { lines: values.length, totalCents: values.reduce((n, v) => n + v.amountCents, 0), deposit: dep ? { number: dep.number, subtotalCents: dep.subtotalCents } : null, actorId };
}

/** What the project's billing stands at: its lines in Approbation / on an invoice */
export async function projectBilling(projectId: string) {
  const rows = await db()
    .select({ id: schema.billingItems.id, description: schema.billingItems.description, amountCents: schema.billingItems.amountCents, status: schema.billingItems.status, invoiceId: schema.billingItems.invoiceId, number: schema.clientInvoices.number })
    .from(schema.billingItems)
    .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.billingItems.invoiceId))
    .where(like(schema.billingItems.sourceId, `project:${projectId}%`));
  return rows;
}
