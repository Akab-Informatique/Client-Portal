import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { QuickBooksError, qb, query, requestId } from "./quickbooks.ts";

/**
 * Credit on a customer's account in QuickBooks: a payment received for more than the invoices (an unapplied payment,
 * `UnappliedAmt`) or a credit memo not used up (`Balance`). The portal copies them (`qb_credits`, read only), shows what
 * a client has when it is invoiced, and takes it off the new invoice: it becomes a payment of the invoice (method
 * `credit`, source `qbcredit`) and is applied to the invoice in QuickBooks too. Never more than the invoice's total,
 * never more than the credit, oldest first; a credit used here is held back from the copy until QuickBooks has it applied.
 */
type RawPayment = { Id: string; TxnDate: string; PaymentRefNum?: string; TotalAmt?: number; UnappliedAmt?: number; CustomerRef?: { value: string }; SyncToken?: string; Line?: { Amount: number; LinkedTxn?: { TxnId: string; TxnType: string }[] }[] };
type RawMemo = { Id: string; TxnDate: string; DocNumber?: string; TotalAmt?: number; Balance?: number; CustomerRef?: { value: string } };
const cents = (v: number | undefined) => Math.round((v ?? 0) * 100);
const dollars = (c: number) => Math.round(c) / 100;

/** Copy the credits of the customers mapped to a client. What QuickBooks no longer shows as open is closed here. */
export async function pullCredits(): Promise<{ clients: number; credits: number; cents: number }> {
  const d = db();
  const clients = new Map((await d.select({ id: schema.clients.id, qb: schema.clients.quickbooksId }).from(schema.clients).where(isNotNull(schema.clients.quickbooksId))).map((c) => [c.qb!, c.id]));
  // the filter is asked of QuickBooks and checked again here (a filter it does not take just brings more rows)
  const payments = (await query<RawPayment>("Payment", "UnappliedAmt > '0'")).filter((p) => cents(p.UnappliedAmt) > 0);
  const memos = (await query<RawMemo>("CreditMemo", "Balance > '0'")).filter((m) => cents(m.Balance) > 0);
  // credits taken by an invoice here that QuickBooks has not applied yet stay held back
  const held = new Map<string, number>();
  for (const a of await d.select().from(schema.invoiceCreditApplications).where(isNull(schema.invoiceCreditApplications.quickbooksApplyId))) held.set(`${a.kind}:${a.qbId}`, (held.get(`${a.kind}:${a.qbId}`) ?? 0) + a.amountCents);
  const seen = new Set<string>();
  let total = 0;
  const rows: { kind: "payment" | "creditmemo"; qbId: string; customer: string; ref: string | null; on: string; totalCents: number; open: number }[] = [
    ...payments.map((p) => ({ kind: "payment" as const, qbId: p.Id, customer: p.CustomerRef?.value ?? "", ref: p.PaymentRefNum ?? null, on: p.TxnDate, totalCents: cents(p.TotalAmt), open: cents(p.UnappliedAmt) })),
    ...memos.map((m) => ({ kind: "creditmemo" as const, qbId: m.Id, customer: m.CustomerRef?.value ?? "", ref: m.DocNumber ?? null, on: m.TxnDate, totalCents: cents(m.TotalAmt), open: cents(m.Balance) })),
  ];
  for (const r of rows) {
    const clientId = clients.get(r.customer);
    if (!clientId) continue;
    const key = `${r.kind}:${r.qbId}`;
    seen.add(key);
    const remaining = Math.max(0, r.open - (held.get(key) ?? 0));
    total += remaining;
    const [hit] = await d.select({ id: schema.qbCredits.id }).from(schema.qbCredits).where(and(eq(schema.qbCredits.kind, r.kind), eq(schema.qbCredits.qbId, r.qbId)));
    const values = { clientId, kind: r.kind, qbId: r.qbId, ref: r.ref, txnDate: r.on, totalCents: r.totalCents, remainingCents: remaining, syncedAt: new Date() };
    if (hit) await d.update(schema.qbCredits).set(values).where(eq(schema.qbCredits.id, hit.id));
    else await d.insert(schema.qbCredits).values(values);
  }
  // no longer open in QuickBooks: nothing left here either
  const all = await d.select({ id: schema.qbCredits.id, kind: schema.qbCredits.kind, qbId: schema.qbCredits.qbId, remaining: schema.qbCredits.remainingCents }).from(schema.qbCredits);
  const gone = all.filter((c) => c.remaining > 0 && !seen.has(`${c.kind}:${c.qbId}`)).map((c) => c.id);
  if (gone.length) await d.update(schema.qbCredits).set({ remainingCents: 0, syncedAt: new Date() }).where(inArray(schema.qbCredits.id, gone));
  return { clients: new Set(rows.map((r) => clients.get(r.customer)).filter(Boolean)).size, credits: seen.size, cents: total };
}

/** What a client has on account (cents) and where it comes from */
export async function creditOf(clientId: string): Promise<{ cents: number; credits: { id: string; kind: string; ref: string | null; txnDate: string; remainingCents: number }[]; syncedAt: Date | null }> {
  const rows = await db()
    .select()
    .from(schema.qbCredits)
    .where(and(eq(schema.qbCredits.clientId, clientId), sql`${schema.qbCredits.remainingCents} > 0`))
    .orderBy(asc(schema.qbCredits.txnDate));
  return { cents: rows.reduce((n, r) => n + r.remainingCents, 0), credits: rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, txnDate: r.txnDate, remainingCents: r.remainingCents })), syncedAt: rows.reduce<Date | null>((m, r) => (!m || r.syncedAt > m ? r.syncedAt : m), null) };
}

/**
 * Take what the client has on account off an invoice just made: one payment of the invoice per credit used (method
 * `credit`, source `qbcredit`), the credit lowered, the application kept to be sent to QuickBooks. `upTo` caps it
 * (the invoice's total). Returns what was applied (cents).
 */
export async function applyCreditsToInvoice(invoiceId: string, clientId: string, upTo: number, paidOn: string): Promise<number> {
  const d = db();
  let left = upTo;
  let applied = 0;
  const rows = await d
    .select()
    .from(schema.qbCredits)
    .where(and(eq(schema.qbCredits.clientId, clientId), sql`${schema.qbCredits.remainingCents} > 0`))
    .orderBy(asc(schema.qbCredits.txnDate));
  for (const c of rows) {
    if (left <= 0) break;
    const take = Math.min(left, c.remainingCents);
    await d.transaction(async (tx) => {
      const [pay] = await tx
        .insert(schema.invoicePayments)
        .values({ invoiceId, amountCents: take, paidOn, method: "credit", reference: c.ref, note: `Crédit au compte QuickBooks (${c.kind === "creditmemo" ? "note de crédit" : "paiement"}${c.ref ? ` ${c.ref}` : ""})`, source: "qbcredit" })
        .returning({ id: schema.invoicePayments.id });
      await tx.update(schema.qbCredits).set({ remainingCents: c.remainingCents - take }).where(eq(schema.qbCredits.id, c.id));
      await tx.insert(schema.invoiceCreditApplications).values({ invoiceId, creditId: c.id, kind: c.kind, qbId: c.qbId, amountCents: take, paymentId: pay.id });
    });
    left -= take;
    applied += take;
  }
  return applied;
}

/** The credits applied to an invoice here that QuickBooks does not have applied yet: applied there now (the invoice must be in QuickBooks) */
export async function pushInvoiceCredits(invoiceId: string): Promise<number> {
  const d = db();
  const [inv] = await d.select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv?.quickbooksId) return 0;
  const todo = await d.select().from(schema.invoiceCreditApplications).where(and(eq(schema.invoiceCreditApplications.invoiceId, invoiceId), isNull(schema.invoiceCreditApplications.quickbooksApplyId)));
  if (!todo.length) return 0;
  const [client] = await d.select({ qb: schema.clients.quickbooksId }).from(schema.clients).where(eq(schema.clients.id, inv.clientId));
  let done = 0;
  for (const a of todo) {
    try {
      if (!client?.qb) throw new QuickBooksError("not_mapped");
      let applyId: string;
      if (a.kind === "creditmemo") {
        // a credit memo is applied by a payment of 0 that links it to the invoice (as for a credit note made here)
        const body = {
          CustomerRef: { value: client.qb },
          TotalAmt: 0,
          TxnDate: inv.issuedOn,
          PrivateNote: `Crédit au compte appliqué à la facture ${inv.number} — portail AKAB`,
          Line: [
            { Amount: dollars(a.amountCents), LinkedTxn: [{ TxnId: inv.quickbooksId, TxnType: "Invoice" }] },
            { Amount: dollars(a.amountCents), LinkedTxn: [{ TxnId: a.qbId, TxnType: "CreditMemo" }] },
          ],
        };
        const r = await qb<{ Payment: { Id: string } }>("POST", `payment?requestid=${requestId(`qbcredit:${a.id}`, body)}`, body);
        applyId = r.Payment.Id;
      } else {
        // an unapplied payment gets one more line: this invoice (its lines already there are sent back with it)
        const cur = await qb<{ Payment: RawPayment }>("GET", `payment/${encodeURIComponent(a.qbId)}`);
        const lines = (cur.Payment.Line ?? []).map((l) => ({ Amount: l.Amount, LinkedTxn: l.LinkedTxn }));
        lines.push({ Amount: dollars(a.amountCents), LinkedTxn: [{ TxnId: inv.quickbooksId, TxnType: "Invoice" }] });
        const r = await qb<{ Payment: { Id: string } }>("POST", "payment", { Id: cur.Payment.Id, SyncToken: cur.Payment.SyncToken, sparse: true, Line: lines });
        applyId = r.Payment.Id;
      }
      await d.update(schema.invoiceCreditApplications).set({ quickbooksApplyId: applyId, quickbooksError: null }).where(eq(schema.invoiceCreditApplications.id, a.id));
      // the pull of payments skips it (the portal already has this credit as a payment of the invoice)
      if (a.paymentId) await d.update(schema.invoicePayments).set({ quickbooksId: applyId, quickbooksError: null }).where(eq(schema.invoicePayments.id, a.paymentId));
      done++;
    } catch (e) {
      const msg = e instanceof QuickBooksError ? (e.detail ? `${e.code}: ${e.detail}` : e.code) : e instanceof Error ? e.message : String(e);
      await d.update(schema.invoiceCreditApplications).set({ quickbooksError: msg.slice(0, 300) }).where(eq(schema.invoiceCreditApplications.id, a.id));
    }
  }
  return done;
}

/** Credits waiting to be applied in QuickBooks, for the 15-minute run */
export async function creditsToPush(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ id: schema.invoiceCreditApplications.invoiceId })
    .from(schema.invoiceCreditApplications)
    .innerJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.invoiceCreditApplications.invoiceId))
    .where(and(isNull(schema.invoiceCreditApplications.quickbooksApplyId), isNotNull(schema.clientInvoices.quickbooksId)));
  return rows.map((r) => r.id);
}
