import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings, quickbooksSettings } from "./billing.ts";
import { withNextNumber } from "./billables.ts";
import { balanceOf } from "./stripe.ts";
import { todayQc } from "./timesheets.ts";
import { autoTaxCodes, fallbackItemId, pushInvoice, qb, QuickBooksError, requestId } from "./quickbooks.ts";
import { taxesOfLines } from "../../shared/invoiceTax.ts";

/**
 * Credit notes (notes de crédit) on an invoice, made in the portal and sent to QuickBooks as a CreditMemo.
 * The credit is taken off the invoice's balance (an invoice payment, method "credit") up to what is still owed; the
 * rest stays a credit of the client in QuickBooks. Numbers come from the invoices' sequence.
 */
export class CreditNoteError extends Error {}

export type CreditLineInput = { invoiceLineId?: string | null; description: string; quantity: number; unitPriceCents: number; taxable?: boolean };

export async function createCreditNote(actorId: string, p: { invoiceId: string; issuedOn?: string; reason?: string | null; lines: CreditLineInput[] }) {
  const d = db();
  const [inv] = await d.select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, p.invoiceId));
  if (!inv) throw new CreditNoteError("not_found");
  if (inv.voided) throw new CreditNoteError("invoice_voided");
  if (!p.lines.length) throw new CreditNoteError("credit_empty");
  const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, inv.clientId));
  const own = await d.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
  const lines = p.lines.map((l, i) => {
    const from = l.invoiceLineId ? own.find((x) => x.id === l.invoiceLineId) : undefined;
    if (l.invoiceLineId && !from) throw new CreditNoteError("credit_line_invalid");
    const quantityX100 = Math.round(l.quantity * 100);
    const amountCents = Math.round((quantityX100 * l.unitPriceCents) / 100);
    if (quantityX100 <= 0 || l.unitPriceCents <= 0 || amountCents <= 0) throw new CreditNoteError("credit_amount_invalid");
    return {
      position: i,
      description: l.description.trim().slice(0, 2000),
      quantityX100,
      unitPriceCents: l.unitPriceCents,
      amountCents,
      // a line taken from the invoice keeps its tax treatment and QuickBooks codes
      taxable: from ? from.taxable : (l.taxable ?? true),
      qbItemId: from?.qbItemId ?? inv.qbItemId ?? null,
      qbTaxCodeId: from?.qbTaxCodeId ?? null,
    };
  });
  const s = await billingSettings();
  const exempt = client?.invoice?.taxes === false;
  const subtotalCents = lines.reduce((n, l) => n + l.amountCents, 0);
  const tax = exempt ? { gst: 0, qst: 0 } : taxesOfLines(lines.filter((l) => l.taxable).map((l) => l.amountCents), s.taxes.gstRate, s.taxes.qstRate);
  const totalCents = subtotalCents + tax.gst + tax.qst;
  // never more than what the invoice still has to credit (its total less the credits already made)
  const before = await d.select({ t: schema.creditNotes.totalCents }).from(schema.creditNotes).where(eq(schema.creditNotes.invoiceId, inv.id));
  const room = inv.totalCents - before.reduce((n, x) => n + x.t, 0);
  if (totalCents > room) throw new CreditNoteError("credit_over_invoice");
  const issuedOn = p.issuedOn ?? todayQc();
  const balance = await balanceOf(inv);
  const appliedCents = Math.min(totalCents, balance);

  const note = await withNextNumber(actorId, async (number) =>
    d.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.creditNotes)
        .values({ number, clientId: inv.clientId, invoiceId: inv.id, issuedOn, reason: p.reason?.trim() || null, subtotalCents, gstCents: tax.gst, qstCents: tax.qst, totalCents, appliedCents, createdBy: actorId })
        .returning();
      await tx.insert(schema.creditNoteLines).values(lines.map((l) => ({ ...l, creditNoteId: row.id })));
      if (appliedCents > 0) {
        const [pay] = await tx
          .insert(schema.invoicePayments)
          .values({ invoiceId: inv.id, amountCents: appliedCents, paidOn: issuedOn, method: "credit", reference: number, note: p.reason?.trim()?.slice(0, 500) || null, source: "credit", createdBy: actorId })
          .returning({ id: schema.invoicePayments.id });
        await tx.update(schema.creditNotes).set({ paymentId: pay.id }).where(eq(schema.creditNotes.id, row.id));
        row.paymentId = pay.id;
      }
      return row;
    }),
  );
  return note;
}

/** Sent to QuickBooks right away when it is connected and on; a failure is kept on the credit note (sent again by hand or by the 15-minute run) */
export async function autoSyncCreditNote(id: string) {
  const s = await quickbooksSettings();
  if (!s.enabled || !s.refreshToken || !s.realmId) return;
  await pushCreditNote(id).catch((e) => console.warn(`[quickbooks] credit note ${id}:`, e instanceof Error ? e.message : e));
}

const dollars = (cents: number) => Math.round(cents) / 100;
const inFlight = new Set<string>();

/** The credit note as a CreditMemo of the client's customer, then applied to its invoice by a zero payment */
export async function pushCreditNote(id: string): Promise<{ quickbooksId: string; applyId: string | null }> {
  if (inFlight.has(id)) throw new QuickBooksError("api", "busy");
  inFlight.add(id);
  const d = db();
  const [cn] = await d.select().from(schema.creditNotes).where(eq(schema.creditNotes.id, id));
  if (!cn) throw new QuickBooksError("api", "credit_note");
  try {
    const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, cn.clientId));
    if (!client?.quickbooksId) throw new QuickBooksError("not_mapped", client?.name);
    const s = await quickbooksSettings();
    const exempt = client.invoice?.taxes === false;
    const auto = !s.invoice.taxCodeId || !s.invoice.exemptTaxCodeId ? await autoTaxCodes() : { taxable: null, exempt: null };
    const exemptCode = s.invoice.exemptTaxCodeId || auto.exempt;
    const taxCode = s.invoice.taxCodeId || auto.taxable;
    const lines = await d.select().from(schema.creditNoteLines).where(eq(schema.creditNoteLines.creditNoteId, cn.id)).orderBy(asc(schema.creditNoteLines.position));
    const defaultItem = s.invoice.itemId || (lines.some((l) => !l.qbItemId) ? await fallbackItemId().catch(() => null) : null);
    const noItem = lines.find((l) => !l.qbItemId && !defaultItem);
    if (noItem) throw new QuickBooksError("no_item", noItem.description.slice(0, 120));
    const codeOf = (l: (typeof lines)[number]) => (l.taxable && !exempt ? l.qbTaxCodeId || taxCode : exemptCode);
    const noCode = lines.find((l) => !codeOf(l));
    if (noCode) throw new QuickBooksError("no_tax_code", noCode.description.slice(0, 120));
    // its invoice is in QuickBooks first (a portal invoice not sent yet is sent now)
    const [inv] = cn.invoiceId ? await d.select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, cn.invoiceId)) : [];
    let invQb = inv?.quickbooksId ?? null;
    if (inv && !invQb && inv.source === "portal") invQb = (await pushInvoice(inv.id)).quickbooksId;

    let cmId = cn.quickbooksId;
    if (!cmId) {
      const body = {
        DocNumber: cn.number.slice(0, 21),
        TxnDate: cn.issuedOn,
        CustomerRef: { value: client.quickbooksId },
        GlobalTaxCalculation: "TaxExcluded",
        ...(cn.reason ? { CustomerMemo: { value: cn.reason.slice(0, 1000) } } : {}),
        PrivateNote: `Note de crédit du portail AKAB${inv ? ` sur la facture ${inv.number}` : ""}`.slice(0, 4000),
        Line: lines.map((l) => ({
          DetailType: "SalesItemLineDetail",
          Amount: dollars(l.amountCents),
          Description: l.description.slice(0, 4000),
          SalesItemLineDetail: { ItemRef: { value: (l.qbItemId || defaultItem)! }, Qty: l.quantityX100 / 100, UnitPrice: dollars(l.unitPriceCents), TaxCodeRef: { value: codeOf(l)! } },
        })),
      };
      const r = await qb<{ CreditMemo: { Id: string } }>("POST", `creditmemo?requestid=${requestId(`creditmemo:${cn.id}`, body)}`, body);
      cmId = r.CreditMemo.Id;
      await d.update(schema.creditNotes).set({ quickbooksId: cmId, quickbooksSyncedAt: new Date(), quickbooksError: null }).where(eq(schema.creditNotes.id, cn.id));
    }
    // applied to the invoice there too: a payment of 0 that links the invoice and the credit memo
    let applyId = cn.quickbooksApplyId;
    if (!applyId && cn.appliedCents > 0 && invQb) {
      const amount = dollars(cn.appliedCents);
      const body = {
        CustomerRef: { value: client.quickbooksId },
        TotalAmt: 0,
        TxnDate: cn.issuedOn,
        PrivateNote: `Note de crédit ${cn.number} appliquée à la facture ${inv!.number} — portail AKAB`,
        Line: [
          { Amount: amount, LinkedTxn: [{ TxnId: invQb, TxnType: "Invoice" }] },
          { Amount: amount, LinkedTxn: [{ TxnId: cmId, TxnType: "CreditMemo" }] },
        ],
      };
      const r = await qb<{ Payment: { Id: string } }>("POST", `payment?requestid=${requestId(`creditapply:${cn.id}`, body)}`, body);
      applyId = r.Payment.Id;
      await d.update(schema.creditNotes).set({ quickbooksApplyId: applyId, quickbooksError: null }).where(eq(schema.creditNotes.id, cn.id));
      // the payment pull skips it (the portal already has the credit on the invoice)
      if (cn.paymentId) await d.update(schema.invoicePayments).set({ quickbooksId: applyId, quickbooksError: null }).where(eq(schema.invoicePayments.id, cn.paymentId));
    }
    return { quickbooksId: cmId, applyId };
  } catch (e) {
    const msg = e instanceof QuickBooksError ? (e.detail ? `${e.code}: ${e.detail}` : e.code) : e instanceof Error ? e.message : String(e);
    await d.update(schema.creditNotes).set({ quickbooksError: msg.slice(0, 300) }).where(eq(schema.creditNotes.id, cn.id));
    throw e;
  } finally {
    inFlight.delete(id);
  }
}

/** Credit notes for the screens: of one invoice, of one client, or all (newest first) */
export async function creditNotesOf(filter: { invoiceId?: string; clientId?: string }) {
  const d = db();
  const rows = await d
    .select({ cn: schema.creditNotes, invoiceNumber: schema.clientInvoices.number, client: schema.clients.name })
    .from(schema.creditNotes)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.creditNotes.clientId))
    .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.creditNotes.invoiceId))
    .where(and(filter.invoiceId ? eq(schema.creditNotes.invoiceId, filter.invoiceId) : undefined, filter.clientId ? eq(schema.creditNotes.clientId, filter.clientId) : undefined))
    .orderBy(desc(schema.creditNotes.createdAt))
    .limit(500);
  return rows.map(({ cn, invoiceNumber, client }) => ({
    id: cn.id,
    number: cn.number,
    clientId: cn.clientId,
    client,
    invoiceId: cn.invoiceId,
    invoiceNumber,
    issuedOn: cn.issuedOn,
    reason: cn.reason,
    subtotalCents: cn.subtotalCents,
    taxCents: cn.gstCents + cn.qstCents,
    totalCents: cn.totalCents,
    appliedCents: cn.appliedCents,
    quickbooks: { id: cn.quickbooksId, applied: Boolean(cn.quickbooksApplyId), error: cn.quickbooksError },
  }));
}
