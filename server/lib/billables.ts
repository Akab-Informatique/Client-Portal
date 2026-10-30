import { and, asc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { alignNumbering, autoTaxCodes, qbItemsForBillingItems, voidInvoiceInQb } from "./quickbooks.ts";
import { dueAfterSent } from "../../shared/invoiceDue.ts";
import { taxesOfLines } from "../../shared/invoiceTax.ts";
import { hourlyRateOf } from "./contracts.ts";
import { billingSettings, formatInvoiceNumber, quickbooksSettings, saveBillingSettings, type BillingSettings } from "./billing.ts";
import { ensureCrm } from "./crm.ts";
import { ticketSource, type BillableKind } from "./ticketSource.ts";

/**
 * Work to bill (Accounting › Approbation): the portal's own work (ticket time and charges, expenses…),
 * approved by hand or by rules (per client: kinds; per contract: everything
 * under it), then invoiced: a client, the kinds or lines to bill, dates,
 * terms, notes; or every client at once.
 */
export const BILLABLE_KINDS: BillableKind[] = ["labour", "charge", "expense", "contract", "milestone", "project"];
const STATE_KEY = "autotask.billables";
export type BillablesState = { at: string | null; counts: Partial<Record<BillableKind, number>>; errors: Partial<Record<BillableKind, string>>; skipped: number };
type Item = typeof schema.billingItems.$inferSelect;
type Client = typeof schema.clients.$inferSelect;

export async function billablesState(): Promise<BillablesState> {
  const [row] = await db().select().from(schema.syncState).where(eq(schema.syncState.key, STATE_KEY));
  return (row?.data as BillablesState | undefined) ?? { at: null, counts: {}, errors: {}, skipped: 0 };
}

const amountOf = (quantityX100: number, unitPriceCents: number) => Math.round((quantityX100 * unitPriceCents) / 100);

/** Approved by a rule: the client approves this kind, or the contract approves everything under it. */
const ruled = (item: { kind: string; contractId: string | null }, client: { invoice: Client["invoice"] | null }, autoContracts: Set<string>) =>
  Boolean(client.invoice?.autoApprove?.includes(item.kind)) || Boolean(item.contractId && autoContracts.has(item.contractId));

async function autoContracts() {
  return new Set((await db().select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(eq(schema.clientContracts.autoApprove, true))).map((r) => r.id));
}

/** Apply the rules to the items waiting (after a rule is set). Returns how many were approved. */
export async function applyAutoApprove(clientId?: string) {
  const d = db();
  const contracts = await autoContracts();
  const clients = new Map((await d.select({ id: schema.clients.id, invoice: schema.clients.invoice }).from(schema.clients)).map((c) => [c.id, c]));
  const pending = await d
    .select()
    .from(schema.billingItems)
    .where(and(eq(schema.billingItems.status, "pending"), clientId ? eq(schema.billingItems.clientId, clientId) : undefined));
  const ids = pending.filter((i) => ruled(i, clients.get(i.clientId) ?? { invoice: null }, contracts)).map((i) => i.id);
  if (ids.length) await d.update(schema.billingItems).set({ status: "approved", approvedAt: new Date(), approvedBy: null, updatedAt: new Date() }).where(inArray(schema.billingItems.id, ids));
  return ids.length;
}

let running: Promise<BillablesState> | null = null;

/** Copy the work to bill from the source. Items changed or decided in the portal are left as they are. */
export function syncBillables(): Promise<BillablesState> {
  running ??= (async () => {
    await ensureCrm();
    const s = await billingSettings();
    const src = await ticketSource();
    const data = await src.billables(s.autotask.itemsSince);
    // the portal's own work only is read (no source of billable work besides the portal): what was copied before is never taken for "gone"
    const alone = await (await import("./localTickets.ts")).ticketsLocal();
    const d = db();
    const now = new Date();
    const clients = new Map(
      (await d.select({ id: schema.clients.id, at: schema.clients.autotaskId, invoice: schema.clients.invoice }).from(schema.clients)).filter((c) => c.at != null).map((c) => [c.at!, c]),
    );
    const contractRows = await d.select().from(schema.clientContracts).where(isNotNull(schema.clientContracts.autotaskId));
    const contractIds = new Map(contractRows.map((k) => [k.autotaskId!, k.id]));
    const contractsById = new Map(contractRows.map((k) => [k.id, k]));
    const autoK = await autoContracts();
    const existing = new Map((await d.select().from(schema.billingItems).where(eq(schema.billingItems.source, "autotask"))).map((x) => [x.sourceId!, x]));
    const counts: BillablesState["counts"] = {};
    let skipped = 0;
    const seen = new Set<string>();
    for (const it of data.items) {
      const client = clients.get(it.companyId);
      if (!client) {
        skipped++;
        continue;
      }
      seen.add(it.id);
      counts[it.kind] = (counts[it.kind] ?? 0) + 1;
      // the contract the work is under: an hourly rate typed on it wins, then the source's rate, then the client's, then the usual one;
      // under a monthly / per ticket / included contract the hours are not billed (left out, never billed by the hour)
      const contract = it.contractSourceId ? contractsById.get(contractIds.get(it.contractSourceId) ?? "") : undefined;
      // the contract's own rate bills the hours (above 0); a rate of 0 means they are included, never billed
      const contractRate = contract ? hourlyRateOf(contract, s.rates.hourly) : null;
      const notBilled = it.kind === "labour" && contract != null && contractRate == null;
      const rate = notBilled
        ? 0
        : it.kind === "labour" && contractRate != null
          ? contractRate
          : (it.unitPriceCents ?? (it.kind === "labour" ? Math.round((client.invoice?.hourlyRate ?? s.rates.hourly) * 100) : 0));
      const quantityX100 = Math.round(it.quantity * 100);
      const values = {
        clientId: client.id,
        kind: it.kind,
        date: it.date,
        dateEnd: it.dateEnd ?? null,
        description: it.description,
        ticketNumber: it.ticketNumber ?? null,
        contractName: it.contractName ?? null,
        contractId: it.contractSourceId ? (contractIds.get(it.contractSourceId) ?? null) : null,
        resourceName: it.resourceName ?? null,
        quantityX100,
        unitPriceCents: rate,
        amountCents: amountOf(quantityX100, rate),
        taxable: it.taxable,
        syncedAt: now,
      };
      const hit = existing.get(it.id);
      if (!hit) {
        // new: approved right away when a rule says so
        const auto = !notBilled && ruled(values, client, autoK);
        await d.insert(schema.billingItems).values({ ...values, source: "autotask", sourceId: it.id, status: notBilled ? "excluded" : auto ? "approved" : "pending", approvedAt: auto ? now : null });
      } else if ((hit.status === "pending" || (notBilled && hit.status === "excluded")) && !hit.edited)
        await d.update(schema.billingItems).set({ ...values, ...(notBilled ? { status: "excluded" } : {}), updatedAt: now }).where(eq(schema.billingItems.id, hit.id));
    }
    // gone from the source: untouched ones go too — only for kinds read without error. On its own the portal drops the lines
    // of its own tickets and contracts that are no longer due, and the unapproved contract lines imported long ago (not made by the portal)
    const gone = [...existing.values()]
      .filter((x) => !seen.has(x.sourceId!) && (!alone || /^(p(r?time|charge|travel):|contract:)/.test(x.sourceId!) || (x.kind === "contract" && !x.sourceId!.startsWith("contract:"))) && (x.status === "pending" || (x.status === "approved" && !x.approvedBy)) && !x.edited && !data.errors[x.kind as BillableKind])
      .map((x) => x.id);
    if (gone.length) await d.delete(schema.billingItems).where(inArray(schema.billingItems.id, gone));
    const state: BillablesState = { at: now.toISOString(), counts, errors: data.errors, skipped };
    await d
      .insert(schema.syncState)
      .values({ key: STATE_KEY, data: state })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { data: state, updatedAt: now } });
    return state;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** A time frame (YYYY-MM-DD, both days included): only the work of those days is listed, counted and invoiced. */
export type Period = { from?: string | null; to?: string | null };
const inPeriod = (p?: Period) =>
  and(p?.from ? gte(schema.billingItems.date, p.from) : undefined, p?.to ? lte(schema.billingItems.date, p.to) : undefined);

/** The items of a kind (and status), with their client. */
export async function listBillables(kind: BillableKind | null, status: string | null, clientId?: string | null, period?: Period) {
  const rows = await db()
    .select({ b: schema.billingItems, client: schema.clients.name, invoice: schema.clientInvoices.number, auto: schema.clientContracts.autoApprove })
    .from(schema.billingItems)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.billingItems.clientId))
    .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.billingItems.invoiceId))
    .leftJoin(schema.clientContracts, eq(schema.clientContracts.id, schema.billingItems.contractId))
    .where(
      and(
        kind ? eq(schema.billingItems.kind, kind) : undefined,
        status ? eq(schema.billingItems.status, status) : undefined,
        clientId ? eq(schema.billingItems.clientId, clientId) : undefined,
        inPeriod(period),
      ),
    )
    .orderBy(asc(schema.clients.name), asc(schema.billingItems.date));
  return rows.map(({ b, client, invoice }) => ({ ...b, clientName: client, invoiceNumber: invoice, autoApproved: b.status !== "pending" && b.approvedAt != null && !b.approvedBy && b.status !== "excluded" }));
}

/**
 * Put the right hourly rate on the labour lines of a time frame (not invoiced yet): the rate of the contract of the time
 * entry; none: the client's default support contract; none: the client's own hourly rate, else the usual one of Admin ›
 * Facturation. A contract with a rate of 0 includes the hours: the line becomes 0 $ and is set aside (excluded, "included");
 * a line set aside that way comes back to approve when its rate is above 0 again. Lines edited by hand are left alone.
 */
export async function refreshLabourRates(period?: Period) {
  const d = db();
  const s = await billingSettings();
  const usualCents = Math.round(s.rates.hourly * 100);
  const b = schema.billingItems;
  const items = await d
    .select()
    .from(b)
    .where(and(eq(b.kind, "labour"), or(inArray(b.status, ["pending", "approved"]), and(eq(b.status, "excluded"), eq(b.excludedReason, "included"))), inPeriod(period)));
  const clients = new Map((await d.select({ id: schema.clients.id, invoice: schema.clients.invoice }).from(schema.clients)).map((c) => [c.id, c]));
  const contracts = await d.select().from(schema.clientContracts);
  const byId = new Map(contracts.map((k) => [k.id, k]));
  // each client's default support contract: the one picked, else the source's, else its only active one
  const defaults = new Map<string, (typeof contracts)[number]>();
  for (const [clientId] of clients) {
    const active = contracts.filter((k) => k.clientId === clientId && k.active);
    const pick = active.find((k) => k.supportDefault) ?? active.find((k) => k.isDefault) ?? (active.length === 1 ? active[0] : null);
    if (pick) defaults.set(clientId, pick);
  }
  const out = { updated: 0, unchanged: 0, skipped: 0, included: 0, billedAgain: 0 };
  for (const it of items) {
    if (it.edited) {
      out.skipped++;
      continue;
    }
    const own = it.contractId ? byId.get(it.contractId) : undefined;
    const contract = own ?? defaults.get(it.clientId) ?? null;
    const clientRate = clients.get(it.clientId)?.invoice?.hourlyRate;
    const rate = contract ? hourlyRateOf(contract, s.rates.hourly) : clientRate != null ? Math.round(clientRate * 100) : usualCents;
    const included = rate == null;
    const unit = rate ?? 0;
    const wasIncluded = it.status === "excluded";
    const next: { unitPriceCents: number; amountCents: number; contractId?: string; contractName?: string; status?: string; excludedReason?: string | null; approvedBy?: null; approvedAt?: null } = {
      unitPriceCents: unit,
      amountCents: amountOf(it.quantityX100, unit),
      ...(contract && !own ? { contractId: contract.id, contractName: contract.name } : {}),
      ...(included ? { status: "excluded", excludedReason: "included", approvedBy: null, approvedAt: null } : wasIncluded ? { status: "pending", excludedReason: null } : {}),
    };
    const same = it.unitPriceCents === next.unitPriceCents && it.amountCents === next.amountCents && (next.status ?? it.status) === it.status && (!("contractId" in next) || next.contractId === it.contractId);
    if (same) {
      out.unchanged++;
      continue;
    }
    await d.update(b).set({ ...next, updatedAt: new Date() }).where(eq(b.id, it.id));
    out.updated++;
    if (included && !wasIncluded) out.included++;
    if (!included && wasIncluded) out.billedAgain++;
  }
  // what comes back to approve follows the client / contract rules
  if (out.billedAgain) await applyAutoApprove();
  return out;
}

/** How many items wait, by kind and status (for the tab counts). */
export async function billableCounts(period?: Period) {
  const rows = await db()
    .select({ kind: schema.billingItems.kind, status: schema.billingItems.status, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${schema.billingItems.amountCents}), 0)::bigint` })
    .from(schema.billingItems)
    .where(inPeriod(period))
    .groupBy(schema.billingItems.kind, schema.billingItems.status);
  return rows.map((r) => ({ ...r, cents: Number(r.cents) }));
}

/** Approve, send back, exclude or bring back items (never posted ones). */
export async function setBillableStatus(actorId: string, ids: string[], status: "pending" | "approved" | "excluded", reason: "billed" | null = null) {
  if (!ids.length) return 0;
  const rows = await db()
    .update(schema.billingItems)
    .set({ status, excludedReason: status === "excluded" ? reason : null, approvedBy: status === "approved" ? actorId : null, approvedAt: status === "approved" ? new Date() : null, updatedAt: new Date() })
    .where(and(inArray(schema.billingItems.id, ids), sql`${schema.billingItems.status} <> 'posted'`))
    .returning({ id: schema.billingItems.id });
  return rows.length;
}

/** Change an item before it is posted (the next syncs keep the change). */
export async function editBillable(id: string, p: { quantity?: number; unitPriceCents?: number; description?: string; taxable?: boolean; qbItemId?: string | null; qbTaxCodeId?: string | null }) {
  const [cur] = await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, id));
  if (!cur || cur.status === "posted") return null;
  const quantityX100 = p.quantity !== undefined ? Math.round(p.quantity * 100) : cur.quantityX100;
  const unitPriceCents = p.unitPriceCents ?? cur.unitPriceCents;
  const [row] = await db()
    .update(schema.billingItems)
    .set({ quantityX100, unitPriceCents, amountCents: amountOf(quantityX100, unitPriceCents), description: p.description ?? cur.description, taxable: p.taxable ?? cur.taxable,
      ...(p.qbItemId !== undefined ? { qbItemId: p.qbItemId || null } : {}),
      ...(p.qbTaxCodeId !== undefined ? { qbTaxCodeId: p.qbTaxCodeId || null } : {}),
      // choosing the QuickBooks codes alone is not a change of the work itself
      ...(p.quantity !== undefined || p.unitPriceCents !== undefined || p.description !== undefined || p.taxable !== undefined ? { edited: true } : {}),
      updatedAt: new Date() })
    .where(eq(schema.billingItems.id, id))
    .returning();
  return row;
}

// ── invoicing: approved items → an invoice ──
const ACCOUNT_OF: Record<BillableKind, keyof BillingSettings["accounts"]> = { labour: "labour", charge: "charges", expense: "charges", contract: "contracts", milestone: "contracts", project: "labour" };

/** The taxes of an invoice, line by line (the way QuickBooks rounds them) */
function taxesOf(s: BillingSettings, taxableLinesCents: number[], exempt: boolean) {
  if (exempt) return { gst: 0, qst: 0 };
  return taxesOfLines(taxableLinesCents, s.taxes.gstRate, s.taxes.qstRate);
}

/** Per client: the approved items of the time frame, by kind (what can be invoiced). */
export async function invoiceableClients(period?: Period) {
  const rows = await db()
    .select({ clientId: schema.billingItems.clientId, name: schema.clients.name, kind: schema.billingItems.kind, n: sql<number>`count(*)::int`, cents: sql<number>`sum(${schema.billingItems.amountCents})::bigint` })
    .from(schema.billingItems)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.billingItems.clientId))
    .where(and(eq(schema.billingItems.status, "approved"), inPeriod(period)))
    .groupBy(schema.billingItems.clientId, schema.clients.name, schema.billingItems.kind);
  const m = new Map<string, { client: { id: string; name: string }; kinds: { kind: string; count: number; cents: number }[]; cents: number }>();
  for (const r of rows) {
    const g = m.get(r.clientId) ?? { client: { id: r.clientId, name: r.name }, kinds: [], cents: 0 };
    g.kinds.push({ kind: r.kind, count: r.n, cents: Number(r.cents) });
    g.cents += Number(r.cents);
    m.set(r.clientId, g);
  }
  return [...m.values()].sort((x, y) => x.client.name.localeCompare(y.client.name));
}

export type InvoiceDraft = {
  clientId: string;
  /** The items to bill (approved, of this client); none: every approved item of the kinds given */
  itemIds?: string[];
  kinds?: BillableKind[];
  issuedOn?: string;
  /** Terms in days, or an exact due date */
  termsDays?: number;
  dueOn?: string;
  notes?: string | null;
  poNumber?: string | null;
  /** The QuickBooks item and tax code sent on every line (none: the defaults) */
  qbItemId?: string | null;
  qbTaxCodeId?: string | null;
  /** Only the work of these days (an item outside makes the draft invalid) */
  from?: string | null;
  to?: string | null;
};

export class DraftError extends Error {}

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** What the taxes of an invoice made by the portal come to line by line (the way QuickBooks rounds them); 0 for a tax-exempt one. */
export async function taxesByLine(invoiceId: string): Promise<number> {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv || inv.taxCents === 0) return 0;
  const lines = await db().select({ a: schema.invoiceLines.amountCents, t: schema.invoiceLines.taxable }).from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  if (!lines.length) return inv.taxCents;
  const s = await billingSettings();
  const t = taxesOfLines(lines.filter((l) => l.t).map((l) => l.a), s.taxes.gstRate, s.taxes.qstRate);
  return t.gst + t.qst;
}

/**
 * Put an invoice made by the portal on the line-by-line taxes (when it was made the taxes were rounded on the total and
 * were a cent out of QuickBooks). Refused once money was received or for a voided / copied invoice.
 */
export async function recalcInvoiceTaxes(invoiceId: string): Promise<{ before: { taxCents: number; totalCents: number }; after: { taxCents: number; totalCents: number } }> {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv) throw new DraftError("not_found");
  if (inv.source !== "portal") throw new DraftError("invoice_not_portal");
  if (inv.voided) throw new DraftError("invoice_voided");
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, invoiceId));
  if (n > 0) throw new DraftError("invoice_has_payments");
  const taxCents = await taxesByLine(invoiceId);
  const totalCents = inv.totalCents - inv.taxCents + taxCents;
  await db().update(schema.clientInvoices).set({ taxCents, totalCents, updatedAt: new Date() }).where(eq(schema.clientInvoices.id, invoiceId));
  return { before: { taxCents: inv.taxCents, totalCents: inv.totalCents }, after: { taxCents, totalCents } };
}

/** The invoice the draft would make (nothing saved): its lines, taxes, dates, the number it would get. */
export async function draftInvoice(p: InvoiceDraft) {
  const s = await billingSettings();
  const d = db();
  const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, p.clientId));
  if (!client) throw new DraftError("not_found");
  const approved = await d
    .select()
    .from(schema.billingItems)
    .where(and(eq(schema.billingItems.clientId, client.id), eq(schema.billingItems.status, "approved"), inPeriod(p)))
    .orderBy(asc(schema.billingItems.kind), asc(schema.billingItems.date));
  let items: Item[];
  if (p.itemIds) {
    const wanted = new Set(p.itemIds);
    items = approved.filter((i) => wanted.has(i.id));
    // only this client's approved items
    if (items.length !== wanted.size) throw new DraftError("billing_items_invalid");
  } else items = approved.filter((i) => !p.kinds || p.kinds.includes(i.kind as BillableKind));
  if (!items.length) throw new DraftError("billing_nothing");
  const issuedOn = p.issuedOn ?? todayQc();
  const termsDays = p.termsDays ?? client.invoice?.termsDays ?? s.template.termsDays;
  let dueOn = p.dueOn;
  // counted from the day it is sent (an invoice goes out when it is made), not from the date written on it
  if (!dueOn) dueOn = dueAfterSent(todayQc(), termsDays);
  const subtotal = items.reduce((x, i) => x + i.amountCents, 0);
  const exempt = client.invoice?.taxes === false;
  const { gst, qst } = taxesOf(s, items.filter((i) => i.taxable).map((i) => i.amountCents), exempt);
  return {
    client: { id: client.id, name: client.name, address: client.address, city: client.city, province: client.province, postalCode: client.postalCode, email: client.invoice?.billingEmail || client.email },
    number: await peekNumber(),
    issuedOn,
    dueOn,
    termsDays: p.dueOn ? null : termsDays,
    poNumber: p.poNumber ?? null,
    notes: p.notes ?? null,
    poRequired: Boolean(client.invoice?.poRequired),
    exempt,
    items,
    lines: items.map((i) => ({
      itemId: i.id,
      date: i.date,
      contractName: i.contractName ?? null,
      kind: i.kind,
      description: [i.ticketNumber && `[${i.ticketNumber}]`, i.description, i.resourceName && `(${i.resourceName})`].filter(Boolean).join(" "),
      quantity: i.quantityX100 / 100,
      unitPriceCents: i.unitPriceCents,
      amountCents: i.amountCents,
      taxable: i.taxable,
      qbItemId: i.qbItemId ?? null,
      qbTaxCodeId: i.qbTaxCodeId ?? null,
    })),
    subtotalCents: subtotal,
    gstCents: gst,
    qstCents: qst,
    totalCents: subtotal + gst + qst,
    company: s.company,
    taxes: s.taxes,
    // the pay button shows only when this client pays online (its own choice, else the template default)
    template: { ...s.template, showPaymentLink: client.invoice?.payOnline ?? s.template.showPaymentLink },
  };
}

let numbering: Promise<unknown> = Promise.resolve();

/** The number the next invoice would get: the setting, after the highest one used (the copied ones included). */
async function peekNumber(): Promise<string> {
  // with QuickBooks connected, its numbering is looked at first (at most every 2 minutes): never a number it already has
  await alignNumbering().catch(() => undefined);
  const s = await billingSettings();
  const all = await db().select({ number: schema.clientInvoices.number }).from(schema.clientInvoices);
  const used = new Set(all.map((x) => x.number));
  const highest = all.reduce((m, x) => {
    const digits = x.number.startsWith(s.numbering.prefix) ? x.number.slice(s.numbering.prefix.length) : "";
    return /^\d+$/.test(digits) ? Math.max(m, Number(digits)) : m;
  }, 0);
  let value = Math.max(s.numbering.next, highest + 1);
  while (used.has(formatInvoiceNumber(s.numbering, value))) value++;
  return formatInvoiceNumber(s.numbering, value);
}

/** Make the invoice of a draft: the number, the lines; the items are posted. One at a time (numbers never repeat). */
export function createInvoice(actorId: string, p: InvoiceDraft) {
  const run = numbering.then(async () => {
    const draft = await draftInvoice(p);
    const s = await billingSettings();
    // what goes to QuickBooks is settled here, line by line: the line's own, else the invoice's, else the defaults
    const qbDefaults = (await quickbooksSettings()).invoice;
    const invoiceItem = p.qbItemId || qbDefaults.itemId || null;
    const invoiceTax = p.qbTaxCodeId || qbDefaults.taxCodeId || (qbDefaults.itemId || p.qbItemId ? (await autoTaxCodes().catch(() => null))?.taxable : null) || null;
    // the QuickBooks item of each line, from its portal service or product (made in QuickBooks when missing): outside the transaction (it talks to QuickBooks)
    const autoItems = await qbItemsForBillingItems(draft.items.map((i) => ({ id: i.id, sourceId: i.sourceId, kind: i.kind })), { kindFallback: !invoiceItem }).catch(() => new Map<string, string>());
    const number = draft.number;
    // all or nothing: the invoice, its lines and the items posted (a crash never leaves items to bill twice)
    const inv = await db().transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.clientInvoices)
        .values({
          clientId: draft.client.id,
          number,
          issuedOn: draft.issuedOn,
          dueOn: draft.dueOn,
          totalCents: draft.totalCents,
          taxCents: draft.gstCents + draft.qstCents,
          source: "portal",
          notes: draft.notes,
          poNumber: draft.poNumber,
          qbItemId: invoiceItem,
          qbTaxCodeId: invoiceTax,
        })
        .returning();
      await tx.insert(schema.invoiceLines).values(
        draft.lines.map((l, n) => ({
          invoiceId: row.id,
          billingItemId: l.itemId,
          kind: l.kind,
          description: l.description,
          quantityX100: Math.round(l.quantity * 100),
          unitPriceCents: l.unitPriceCents,
          amountCents: l.amountCents,
          taxable: l.taxable,
          // its own pick, else its portal service or product, else the invoice's item (the default)
          qbItemId: l.qbItemId || autoItems.get(l.itemId) || invoiceItem,
          qbTaxCodeId: l.qbTaxCodeId || invoiceTax,
          ledgerAccountId: s.accounts[ACCOUNT_OF[l.kind as BillableKind] ?? "labour"] ?? null,
          position: n,
        })),
      );
      // only items still approved (one sent back meanwhile stops the invoice)
      const posted = await tx
        .update(schema.billingItems)
        .set({ status: "posted", invoiceId: row.id, postedAt: new Date(), updatedAt: new Date() })
        .where(and(inArray(schema.billingItems.id, draft.items.map((i) => i.id)), eq(schema.billingItems.status, "approved")))
        .returning({ id: schema.billingItems.id });
      if (posted.length !== draft.items.length) throw new DraftError("billing_items_changed");
      return row;
    });
    const digits = number.slice(s.numbering.prefix.length);
    if (/^\d+$/.test(digits)) await saveBillingSettings(actorId, { numbering: { next: Number(digits) + 1 } });
    return { id: inv.id, number, client: draft.client.name, totalCents: draft.totalCents };
  });
  numbering = run.catch(() => undefined);
  return run;
}

/**
 * Take back an invoice made by the portal: it is voided (its number stays, shown as voided) and its items are
 * approved again, ready for another invoice. Refused once money was received, or the invoice is in QuickBooks.
 */
export async function unpostInvoice(actorId: string, invoiceId: string): Promise<{ number: string; items: number; quickbooks: boolean }> {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv) throw new DraftError("not_found");
  if (inv.source !== "portal") throw new DraftError("invoice_not_portal");
  if (inv.voided) throw new DraftError("invoice_voided");
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, invoiceId));
  if (n > 0) throw new DraftError("invoice_has_payments");
  // an invoice already in QuickBooks is voided there first: when QuickBooks refuses, nothing changes here
  if (inv.quickbooksId) {
    try {
      await voidInvoiceInQb(inv.quickbooksId);
    } catch {
      throw new DraftError("quickbooks_void_failed");
    }
  }
  const now = new Date();
  const items = await db().transaction(async (tx) => {
    await tx.update(schema.clientInvoices).set({ voided: true, quickbooksError: null, quickbooksSyncedAt: inv.quickbooksId ? now : null, updatedAt: now }).where(eq(schema.clientInvoices.id, invoiceId));
    const back = await tx
      .update(schema.billingItems)
      .set({ status: "approved", invoiceId: null, postedAt: null, approvedBy: actorId, approvedAt: now, updatedAt: now })
      .where(and(eq(schema.billingItems.invoiceId, invoiceId), eq(schema.billingItems.status, "posted")))
      .returning({ id: schema.billingItems.id });
    return back.length;
  });
  return { number: inv.number, items, quickbooks: Boolean(inv.quickbooksId) };
}

/** What invoicing every client at once would make (their defaults). */
export async function postPreview(clientIds?: string[], period?: Period) {
  const groups = await invoiceableClients(period);
  const out = [];
  for (const g of groups.filter((x) => !clientIds?.length || clientIds.includes(x.client.id))) {
    const dr = await draftInvoice({ clientId: g.client.id, ...period });
    out.push({ client: g.client, items: dr.items, count: dr.items.length, subtotalCents: dr.subtotalCents, gstCents: dr.gstCents, qstCents: dr.qstCents, totalCents: dr.totalCents, exempt: dr.exempt, termsDays: dr.termsDays ?? 0 });
  }
  return out;
}

/** Invoice every approved item: one invoice per client (all clients, or the ones given), their defaults. */
export async function postInvoices(actorId: string, clientIds?: string[], period?: Period) {
  const groups = await invoiceableClients(period);
  const made = [];
  for (const g of groups.filter((x) => !clientIds?.length || clientIds.includes(x.client.id))) made.push(await createInvoice(actorId, { clientId: g.client.id, ...period }));
  return made;
}
