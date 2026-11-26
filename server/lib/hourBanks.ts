import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { billingSettings } from "./billing.ts";
import { contractTypes, setTicketContract } from "./contracts.ts";
import { recordContractEvent } from "./contractEvents.ts";
import { ticketSource } from "./ticketSource.ts";
import type { TicketScope } from "./selfManaged.ts";
import { NO_EXPIRY } from "../../shared/bank.ts";
import { isBankLine, lineAmount } from "../../shared/quotes.ts";

/**
 * Prepaid hours banks: hours bought ONCE (unlike the monthly "Banque d'heures" contracts), kept on the client and drawn down by
 * the time worked under them until empty. A bank is a client contract of the banked kind flagged `bank_prepaid`, with the hours,
 * the price of an hour, an optional expiry day (`end_date`) and an optional scope: one portal ticket or one new-format project
 * (never both), where it is the one offered. Selling one = the contract + ONE billing item for its price (`hourbank:<contract>`).
 */
const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const money = (cents: number, lang: string) => (cents / 100).toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" });
const hoursText = (h: number, lang: string) => h.toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { maximumFractionDigits: 2 });

export type SellBank = {
  clientId: string;
  /** Hours bought and the price of an hour (cents) */
  hours: number;
  rateCents: number;
  name?: string | null;
  ticketId?: number | null;
  projId?: string | null;
  /** YYYY-MM-DD; none = never */
  expiresOn?: string | null;
  /** Make the billing item (approved: it goes straight to Éléments à facturer) — false: a bank given or paid elsewhere */
  invoice: boolean;
  /** Items made by someone without the accounting right wait to be approved */
  approved?: boolean;
  quoteId?: string | null;
  /** Taxable, and an amount that is not hours × rate (a quote line after its discount) */
  taxable?: boolean;
  amountCents?: number;
  ticketScope?: TicketScope;
};

/** The client's open tickets and open new-format projects a bank can be tied to (the tickets the caller may see) */
export async function bankTargets(clientId: string, scope: TicketScope = {}) {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id, autotaskId: schema.clients.autotaskId }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new HTTPException(404, { message: "not_found" });
  const projects = await d
    .select({ id: schema.projProjects.id, number: schema.projProjects.number, name: schema.projProjects.name, billingMode: schema.projProjects.billingMode })
    .from(schema.projProjects)
    .where(and(eq(schema.projProjects.clientId, client.id), notInArray(schema.projProjects.status, ["done", "cancelled"])))
    .orderBy(desc(schema.projProjects.createdAt))
    .limit(100);
  const tickets: { id: number; number: string; title: string }[] = [];
  if (client.autotaskId != null) {
    const rows = await d
      .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.companyId, client.autotaskId), isNull(schema.tickets.completedAt), isNull(schema.tickets.mergedIntoId)))
      .orderBy(desc(schema.tickets.createdAt))
      .limit(60);
    const src = await ticketSource(scope);
    for (const r of rows) if (await src.get(r.id).catch(() => null)) tickets.push(r);
  }
  return { tickets, projects: projects.map((p) => ({ id: p.id, number: p.number, name: p.name })) };
}

/** The scope typed by the browser, checked against the client: a ticket of the client the caller can see, or one of its open projects */
async function checkScope(client: { id: string; autotaskId: number | null }, p: { ticketId?: number | null; projId?: string | null }, scope: TicketScope) {
  if (p.ticketId && p.projId) throw new HTTPException(400, { message: "bank_scope_both" });
  let ticket: { id: number; number: string } | null = null;
  let project: typeof schema.projProjects.$inferSelect | null = null;
  if (p.ticketId) {
    const t = await (await ticketSource(scope)).get(p.ticketId).catch(() => null);
    if (!t || client.autotaskId == null || t.company.id !== client.autotaskId) throw new HTTPException(400, { message: "bank_scope_invalid" });
    ticket = { id: t.id, number: t.number };
  }
  if (p.projId) {
    const [pr] = await db().select().from(schema.projProjects).where(and(eq(schema.projProjects.id, p.projId), eq(schema.projProjects.clientId, client.id)));
    if (!pr || pr.status === "done" || pr.status === "cancelled") throw new HTTPException(400, { message: "bank_scope_invalid" });
    // a project sold at a fixed price, as a bank or at a typed rate bills its time its own way: it cannot be moved under a bank
    if (pr.billingMode !== "hourly" && pr.billingMode !== "contract") throw new HTTPException(409, { message: "bank_project_billing" });
    project = pr;
  }
  return { ticket, project };
}

/** Make a prepaid hours bank for a client (and its billing item when asked). The caller checked the rights. */
export async function sellHourBank(actorId: string | null, p: SellBank) {
  const d = db();
  if (!(p.hours > 0) || p.hours > 100_000) throw new HTTPException(400, { message: "bank_hours_required" });
  if (!(p.rateCents >= 0)) throw new HTTPException(400, { message: "bank_rate_required" });
  const today = todayQc();
  if (p.expiresOn && p.expiresOn < today) throw new HTTPException(400, { message: "bank_expiry_invalid" });
  const [client] = await d.select().from(schema.clients).where(and(eq(schema.clients.id, p.clientId), eq(schema.clients.active, true)));
  if (!client) throw new HTTPException(404, { message: "not_found" });
  const { ticket, project } = await checkScope(client, p, p.ticketScope ?? {});
  const type = (await contractTypes()).find((t) => t.kind === "banked" && t.active);
  const lang = (await billingSettings()).template.language;
  const scopeText = ticket ? ` — ${ticket.number}` : project ? ` — ${project.number}` : "";
  const name = (p.name?.trim() || `${lang === "en" ? "Prepaid hours bank" : "Banque d'heures prépayée"} (${hoursText(p.hours, lang)} h)${scopeText}`).slice(0, 200);
  const contract = await d.transaction(async (tx) => {
    const [k] = await tx
      .insert(schema.clientContracts)
      .values({
        clientId: client.id,
        autotaskId: `local-${crypto.randomUUID()}`,
        name,
        type: type?.name ?? "Banque d'heures",
        typeKey: type?.key ?? "banked",
        billingMode: "banked",
        billingPeriod: "monthly",
        startDate: today,
        endDate: p.expiresOn ?? NO_EXPIRY,
        bankedHoursX100: Math.round(p.hours * 100),
        bankRateCents: p.rateCents,
        bankRollover: "lose",
        bankPrepaid: true,
        scopeTicketId: ticket?.id ?? null,
        scopeProjId: project?.id ?? null,
        quoteId: p.quoteId ?? null,
        syncedAt: new Date(),
      })
      .returning();
    // a bank tied to a project: the project bills its time under it
    if (project) await tx.update(schema.projProjects).set({ billingMode: "contract", contractId: k!.id, hourlyRateCents: null, updatedAt: new Date() }).where(eq(schema.projProjects.id, project.id));
    return k!;
  });
  // a bank tied to a ticket is that ticket's contract
  if (ticket) await setTicketContract(ticket.id, contract.id, actorId);
  await recordContractEvent(contract.id, "created", { name, type: contract.type, prepaid: true, hours: p.hours, rateCents: p.rateCents, ...(ticket ? { ticket: ticket.number } : {}), ...(project ? { project: project.number } : {}) }, { userId: actorId });
  let itemId: string | null = null;
  if (p.invoice) {
    const amountCents = p.amountCents ?? Math.round(p.hours * p.rateCents);
    const quantityX100 = Math.round(p.hours * 100);
    const [it] = await d
      .insert(schema.billingItems)
      .values({
        clientId: client.id,
        kind: "charge",
        source: "portal",
        sourceId: `hourbank:${contract.id}`,
        date: today,
        description: `${lang === "en" ? "Prepaid hours bank" : "Banque d'heures prépayée"} — ${hoursText(p.hours, lang)} h × ${money(p.rateCents, lang)}${scopeText}`.slice(0, 480),
        contractName: name,
        quantityX100,
        unitPriceCents: quantityX100 ? Math.round((amountCents * 100) / quantityX100) : amountCents,
        amountCents,
        taxable: p.taxable ?? true,
        status: p.approved === false ? "pending" : "approved",
        approvedBy: p.approved === false ? null : actorId,
        approvedAt: p.approved === false ? null : new Date(),
        edited: true,
      })
      .returning({ id: schema.billingItems.id });
    itemId = it!.id;
  }
  await audit(actorId, "crm.hour_bank_created", contract.id, { client: client.name, hours: p.hours, rateCents: p.rateCents, ticket: ticket?.number ?? null, project: project?.number ?? null, invoiced: p.invoice, ...(p.quoteId ? { quote: p.quoteId } : {}) });
  return { contract, itemId };
}

/** Tie a bank to another ticket / project, or to none (crm.billing). The bank must be a prepaid one of the client. */
export async function linkHourBank(actorId: string | null, clientId: string, contractId: string, p: { ticketId?: number | null; projId?: string | null }, scope: TicketScope = {}) {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id, autotaskId: schema.clients.autotaskId }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new HTTPException(404, { message: "not_found" });
  const [k] = await d.select().from(schema.clientContracts).where(and(eq(schema.clientContracts.id, contractId), eq(schema.clientContracts.clientId, client.id)));
  if (!k) throw new HTTPException(404, { message: "not_found" });
  if (!k.bankPrepaid) throw new HTTPException(400, { message: "not_prepaid" });
  const { ticket, project } = await checkScope(client, p, scope);
  await d.transaction(async (tx) => {
    // the project that billed under it goes back to the client's usual rule
    await tx.update(schema.projProjects).set({ billingMode: "hourly", contractId: null, updatedAt: new Date() }).where(and(eq(schema.projProjects.contractId, k.id), eq(schema.projProjects.billingMode, "contract")));
    await tx.update(schema.clientContracts).set({ scopeTicketId: ticket?.id ?? null, scopeProjId: project?.id ?? null, updatedAt: new Date() }).where(eq(schema.clientContracts.id, k.id));
    if (project) await tx.update(schema.projProjects).set({ billingMode: "contract", contractId: k.id, hourlyRateCents: null, updatedAt: new Date() }).where(eq(schema.projProjects.id, project.id));
  });
  if (ticket) await setTicketContract(ticket.id, k.id, actorId);
  await audit(actorId, "crm.hour_bank_linked", k.id, { ticket: ticket?.number ?? null, project: project?.number ?? null });
  return { scopeTicketId: ticket?.id ?? null, scopeProjId: project?.id ?? null };
}

/**
 * A quote that was accepted sells the banks on its lines (sku BANQUE-HEURES): each makes its bank and billing item once (the
 * line keeps the contract it made, so accepting again never doubles it). Returns how many were made.
 */
export async function makeQuoteBanks(actorId: string | null, quoteId: string, approved: boolean, scope: TicketScope = {}): Promise<number> {
  const d = db();
  const [q] = await d.select({ id: schema.quotes.id, clientId: schema.quotes.clientId }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q) return 0;
  const lines = (await d.select().from(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quoteId)).orderBy(asc(schema.quoteLines.position))).filter((l) => !l.optional && l.recurrence === "once" && isBankLine(l) && !l.bankContractId);
  if (!lines.length) return 0;
  if (!q.clientId) throw new HTTPException(409, { message: "bank_needs_client" });
  let made = 0;
  for (const l of lines) {
    const hours = l.quantityX100 / 100;
    if (hours <= 0) continue;
    const amountCents = lineAmount(l);
    const { contract } = await sellHourBank(actorId, { clientId: q.clientId, hours, rateCents: Math.round((amountCents * 100) / l.quantityX100), amountCents, taxable: l.taxable, ticketId: l.bankScopeTicketId, projId: l.bankScopeProjId, expiresOn: l.bankExpiresOn && l.bankExpiresOn >= todayQc() ? l.bankExpiresOn : null, invoice: true, approved, quoteId, ticketScope: scope });
    await d.update(schema.quoteLines).set({ bankContractId: contract.id }).where(eq(schema.quoteLines.id, l.id));
    made++;
  }
  return made;
}

/** Of these ids, the banks this quote made (a line keeps its bank only when the quote really made it) */
export async function banksMadeBy(quoteId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db().select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(and(eq(schema.clientContracts.quoteId, quoteId), inArray(schema.clientContracts.id, ids), isNotNull(schema.clientContracts.quoteId)));
  return new Set(rows.map((r) => r.id));
}
