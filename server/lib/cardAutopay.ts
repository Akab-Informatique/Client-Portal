import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { audit } from "./audit.ts";
import { billingSettings, stripeSettings } from "./billing.ts";
import { notify, usersWith } from "./notify.ts";
import { balanceOf, stripeCall, StripeError } from "./stripe.ts";
import { combineBps, netCents } from "../../shared/rebate.ts";

/**
 * A client contract paid automatically by card (Clients › contract › Paiement automatique):
 * 1. a signed link (no sign-in) shows the client the contract and what it charges; they type their name and accept;
 * 2. Stripe saves their card (Checkout in setup mode: the card numbers never reach the portal);
 * 3. every time lines of that contract are approved, they become an invoice of their own and the card is charged at once
 *    (with the card fee of Admin › Facturation when it is on, the card is a credit card and the client is not a consumer).
 * Anything else of the client (hourly time, charges…) is invoiced apart, as usual.
 */
export class AutopayError extends Error {}

const sign = (id: string) => crypto.createHmac("sha256", config.appSecret).update(`contract-autopay:${id}`).digest("base64url").slice(0, 24);
export const autopayToken = (id: string) => `${id}.${sign(id)}`;
export const autopayUrl = (id: string) => `${config.publicUrl}/carte/${autopayToken(id)}`;
/** The authorization a link names, when its signature is good */
export function autopayOfToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const good = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return got.length === good.length && crypto.timingSafeEqual(got, good) ? id : null;
}

type Row = typeof schema.contractAutopay.$inferSelect;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** The words the client agrees to (kept as they were, with the acceptance) */
export function authorizationText(lang: "fr" | "en", contract: string, client: string, count = 1) {
  return lang === "en"
    ? `I authorize AKAB Informatique to charge to the card I save the invoices of the ${count > 1 ? "contracts" : "contract"} "${contract}" of ${client}, on the day each one is made. The amount follows the contract and may change when services are added or removed. Each invoice is emailed to us. This authorization can be cancelled at any time by writing to AKAB Informatique.`
    : `J'autorise AKAB Informatique à prélever sur la carte que j'enregistre les factures ${count > 1 ? "des contrats" : "du contrat"} « ${contract} » de ${client}, le jour où chacune est faite. Le montant suit le contrat et peut changer si des services sont ajoutés ou retirés. Chaque facture nous est envoyée par courriel. Cette autorisation peut être annulée en tout temps en écrivant à AKAB Informatique.`;
}

/** Stripe can save a card and charge it (no payment links or webhook needed: the result is read back from Stripe) */
export async function autopayReady() {
  const s = await stripeSettings();
  return Boolean(s.enabled && s.secretKey && config.publicUrl);
}
async function stripeKey() {
  const s = await stripeSettings();
  if (!s.enabled || !s.secretKey) throw new StripeError("not_configured");
  return s.secretKey;
}

/** The authorization of a contract that counts: the active one, else the last one waiting */
export async function autopayOfContract(contractId: string): Promise<Row | null> {
  const rows = await db()
    .select()
    .from(schema.contractAutopay)
    .where(and(eq(schema.contractAutopay.contractId, contractId), ne(schema.contractAutopay.status, "revoked")))
    .orderBy(asc(schema.contractAutopay.createdAt));
  return rows.find((r) => r.status === "active") ?? rows.at(-1) ?? null;
}

async function contractOf(contractId: string) {
  const [k] = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.id, contractId));
  if (!k) throw new AutopayError("not_found");
  const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, k.clientId));
  if (!client) throw new AutopayError("not_found");
  return { k, client };
}

/** "A", "A et B", "A, B et C" */
const listOf = (names: string[], lang: "fr" | "en") => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${lang === "en" ? "and" : "et"} ${names.at(-1)}`);

/** The authorizations sent together with this one (one link, one acceptance, one card), this one first */
async function batchOf(row: Row): Promise<Row[]> {
  if (!row.batchId) return [row];
  const rows = await db()
    .select()
    .from(schema.contractAutopay)
    .where(and(eq(schema.contractAutopay.batchId, row.batchId), ne(schema.contractAutopay.status, "revoked")))
    .orderBy(asc(schema.contractAutopay.createdAt));
  return [row, ...rows.filter((r) => r.id !== row.id)];
}

/**
 * Links to send: one per client, for all of that client's contracts given (one acceptance and one card cover them).
 * An older link waiting for the same contract is dropped; an active card stays until the new one is saved.
 */
export async function requestAutopays(actorId: string, contractIds: string[], email: string | null) {
  const contracts = contractIds.length ? await db().select().from(schema.clientContracts).where(inArray(schema.clientContracts.id, contractIds)) : [];
  if (contracts.length !== new Set(contractIds).size) throw new AutopayError("not_found");
  const byClient = new Map<string, typeof contracts>();
  for (const k of contracts) byClient.set(k.clientId, [...(byClient.get(k.clientId) ?? []), k]);
  const out: { client: typeof schema.clients.$inferSelect; contracts: typeof contracts; lead: Row; url: string; skipped: string[] }[] = [];
  for (const [clientId, ks] of byClient) {
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
    if (!client) continue;
    const live = ks.filter((k) => k.active);
    if (!live.length) throw new AutopayError("contract_inactive");
    const to = (email || client.invoice?.billingEmail || client.email || "").trim() || null;
    await db()
      .update(schema.contractAutopay)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(inArray(schema.contractAutopay.contractId, live.map((k) => k.id)), eq(schema.contractAutopay.status, "pending")));
    const batchId = live.length > 1 ? crypto.randomUUID() : null;
    const rows = await db()
      .insert(schema.contractAutopay)
      .values(live.map((k) => ({ clientId, contractId: k.id, email: to, requestedBy: actorId, batchId })))
      .returning();
    const lead = rows.find((r) => r.contractId === live[0]!.id)!;
    await audit(actorId, "billing.autopay_requested", live[0]!.id, { client: client.name, contracts: live.map((k) => k.name), to });
    out.push({ client, contracts: live, lead, url: autopayUrl(lead.id), skipped: ks.filter((k) => !k.active).map((k) => k.name) });
  }
  return out;
}

/** A link for one contract */
export async function requestAutopay(actorId: string, contractId: string, email: string | null) {
  const [r] = await requestAutopays(actorId, [contractId], email);
  if (!r) throw new AutopayError("not_found");
  return { row: r.lead, url: r.url, client: r.client, contract: r.contracts[0]! };
}

/** The names of the contracts a link covers, as the client reads them */
export const contractNames = (names: string[], lang: "fr" | "en") => listOf(names, lang);

export async function revokeAutopay(actorId: string, contractId: string) {
  const rows = await db()
    .update(schema.contractAutopay)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(schema.contractAutopay.contractId, contractId), ne(schema.contractAutopay.status, "revoked")))
    .returning({ id: schema.contractAutopay.id });
  if (rows.length) await audit(actorId, "billing.autopay_revoked", contractId, { count: rows.length });
  return rows.length;
}

/** What the client sees before accepting: each contract, its lines after rebates, what it charges, and the card fee */
export async function autopaySummary(id: string) {
  await refreshFromStripe(id).catch(() => undefined);
  const [row] = await db().select().from(schema.contractAutopay).where(eq(schema.contractAutopay.id, id));
  if (!row || row.status === "revoked") return null;
  const rows = await batchOf(row);
  const { client } = await contractOf(row.contractId);
  const s = await billingSettings();
  const contracts = [];
  for (const r of rows) {
    const { k } = await contractOf(r.contractId);
    const lines = (await db().select().from(schema.contractServices).where(eq(schema.contractServices.contractId, k.id)).orderBy(asc(schema.contractServices.name)))
      .map((l) => ({ name: l.name, quantity: l.quantity, yearly: l.kind === "recurring_yearly", unitCents: netCents(l.priceCents, combineBps(l.rebateBps, k.rebateBps)) }));
    const bundle = k.bundlePriceCents != null ? { quantity: k.bundleQuantity ?? 1, unitCents: netCents(k.bundlePriceCents, k.rebateBps) } : null;
    contracts.push({ name: k.name, period: k.billingPeriod === "yearly" ? "yearly" : "monthly", startDate: k.startDate, endDate: k.endDate, monthlyCents: k.monthlyRateCents ?? null, bundle, lines: bundle ? [] : lines });
  }
  const lang = s.template.language;
  const names = contractNames(contracts.map((x) => x.name), lang);
  return {
    status: row.status,
    client: client.name,
    contract: names,
    contracts,
    taxes: client.invoice?.taxes === false ? null : { gst: s.taxes.gstRate, qst: s.taxes.qstRate },
    cardFee: s.cardFee.enabled && !client.invoice?.consumer ? s.cardFee.percent : null,
    text: authorizationText(lang, names, client.name, contracts.length),
    card: row.status === "active" ? { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth, expYear: row.cardExpYear } : null,
    accepted: Boolean(row.acceptedAt),
  };
}

type SetupSession = { id: string; url?: string | null; status?: string; customer?: string | null; livemode?: boolean; setup_intent?: string | { id: string; status?: string; payment_method?: string | PaymentMethod } | null };
type PaymentMethod = { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number; funding?: string } };

/** The client accepts: the acceptance is kept on every contract of the link, then Stripe's page to save the card (its address is returned) */
export async function acceptAutopay(id: string, name: string, ip: string | null) {
  const [row] = await db().select().from(schema.contractAutopay).where(eq(schema.contractAutopay.id, id));
  if (!row || row.status === "revoked") throw new AutopayError("not_found");
  if (row.status === "active") throw new AutopayError("already_active");
  if (!(await autopayReady())) throw new AutopayError("stripe_not_ready");
  const key = await stripeKey();
  const rows = await batchOf(row);
  const { client } = await contractOf(row.contractId);
  const ks = await db().select().from(schema.clientContracts).where(inArray(schema.clientContracts.id, rows.map((r) => r.contractId)));
  const s = await billingSettings();
  const names = contractNames(rows.map((r) => ks.find((k) => k.id === r.contractId)?.name ?? ""), s.template.language);
  let customer = row.stripeCustomerId;
  if (!customer) {
    const c = await stripeCall<{ id: string }>(key, "POST", "/customers", {
      name: client.name.slice(0, 250),
      ...(row.email ? { email: row.email } : {}),
      "metadata[client_id]": client.id,
    }, `autopay-customer-${row.id}`);
    customer = c.id;
  }
  const base = config.publicUrl;
  const token = autopayToken(row.id);
  const session = await stripeCall<SetupSession>(key, "POST", "/checkout/sessions", {
    mode: "setup",
    customer,
    currency: "cad",
    "payment_method_types[0]": "card",
    "metadata[autopay_id]": row.id,
    "setup_intent_data[metadata][autopay_id]": row.id,
    "setup_intent_data[description]": `Paiement automatique - ${names}`.slice(0, 250),
    success_url: `${base}/carte/${token}?ok=1`,
    cancel_url: `${base}/carte/${token}?annule=1`,
  });
  if (!session.url) throw new StripeError("api", "no_url");
  await db()
    .update(schema.contractAutopay)
    .set({ acceptedName: name, acceptedAt: new Date(), acceptedIp: ip, acceptedText: authorizationText(s.template.language, names, client.name, rows.length), stripeCustomerId: customer, setupSessionId: session.id, live: Boolean(session.livemode) })
    .where(inArray(schema.contractAutopay.id, rows.map((r) => r.id)));
  await audit(null, "billing.autopay_accepted", row.contractId, { client: client.name, contracts: names, name, ip });
  return session.url;
}

/** A setup session that is done: the card is read back (brand, last 4, expiry, credit or debit) and made the active one on every contract of the link */
export async function completeSetup(sessionId: string) {
  const rows = await db()
    .select()
    .from(schema.contractAutopay)
    .where(and(eq(schema.contractAutopay.setupSessionId, sessionId), eq(schema.contractAutopay.status, "pending")));
  if (!rows.length) return "ignored";
  const key = await stripeKey();
  const session = await stripeCall<SetupSession>(key, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=setup_intent.payment_method`);
  const si = typeof session.setup_intent === "object" ? session.setup_intent : null;
  const pm = si && typeof si.payment_method === "object" ? si.payment_method : null;
  if (session.status !== "complete" || !pm?.card) return "waiting";
  const customer = session.customer ?? rows[0]!.stripeCustomerId;
  if (customer) await stripeCall(key, "POST", `/customers/${encodeURIComponent(customer)}`, { "invoice_settings[default_payment_method]": pm.id }).catch(() => undefined);
  // the new card replaces the one that was active on these contracts
  await db()
    .update(schema.contractAutopay)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(inArray(schema.contractAutopay.contractId, rows.map((r) => r.contractId)), eq(schema.contractAutopay.status, "active")));
  await db()
    .update(schema.contractAutopay)
    .set({
      status: "active",
      stripeCustomerId: customer,
      stripePaymentMethodId: pm.id,
      cardBrand: pm.card.brand ?? null,
      cardLast4: pm.card.last4 ?? null,
      cardExpMonth: pm.card.exp_month ?? null,
      cardExpYear: pm.card.exp_year ?? null,
      cardFunding: pm.card.funding ?? "unknown",
      live: Boolean(session.livemode),
      lastError: null,
    })
    .where(inArray(schema.contractAutopay.id, rows.map((r) => r.id)));
  for (const r of rows) await audit(null, "billing.autopay_card_saved", r.contractId, { brand: pm.card.brand, last4: pm.card.last4, funding: pm.card.funding });
  // what was already approved for these contracts is charged now
  await runContractAutopay(null).catch(() => undefined);
  return "active";
}

/** The page comes back from Stripe before (or without) the webhook: look at the session ourselves */
async function refreshFromStripe(id: string) {
  const [row] = await db().select().from(schema.contractAutopay).where(eq(schema.contractAutopay.id, id));
  if (row?.status === "pending" && row.setupSessionId) await completeSetup(row.setupSessionId);
}

// ── approved contract lines → an invoice → the card ──
let chain: Promise<unknown> = Promise.resolve();

/**
 * Every approved, not yet invoiced line of a contract on autopay becomes an invoice of that contract alone (one per
 * contract), with the card fee when it applies, and the card is charged at once. One run at a time.
 */
export function runContractAutopay(actorId: string | null): Promise<{ invoices: number; charged: number; failed: number }> {
  const run = chain.then(async () => {
    const out = { invoices: 0, charged: 0, failed: 0 };
    const active = await db().select().from(schema.contractAutopay).where(eq(schema.contractAutopay.status, "active"));
    if (!active.length || !(await autopayReady())) return out;
    const { createInvoice } = await import("./billables.ts");
    const s = await billingSettings();
    for (const a of active) {
      const b = schema.billingItems;
      const items = await db()
        .select()
        .from(b)
        .where(and(eq(b.contractId, a.contractId), eq(b.status, "approved"), isNull(b.invoiceId), sql`coalesce(${b.payerClientId}, ${b.clientId}) = ${a.clientId}`));
      if (!items.length) continue;
      const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, a.clientId));
      const ids = items.map((i) => i.id);
      // the card fee: a line of its own, on what the contract charges before taxes
      const feeOn = s.cardFee.enabled && s.cardFee.percent > 0 && a.cardFunding === "credit" && !client?.invoice?.consumer;
      if (feeOn) {
        const base = items.reduce((n, i) => n + i.amountCents, 0);
        const fee = Math.round((base * Math.min(s.cardFee.percent, 2.4)) / 100);
        if (fee > 0) {
          const pct = Math.min(s.cardFee.percent, 2.4).toLocaleString("fr-CA", { maximumFractionDigits: 2 });
          const [f] = await db()
            .insert(b)
            .values({ clientId: a.clientId, kind: "charge", source: "manual", sourceId: `cardfee:${crypto.randomUUID()}`, date: today(), description: `Frais de carte de crédit (${pct} %)`, contractId: a.contractId, quantityX100: 100, unitPriceCents: fee, amountCents: fee, taxable: s.cardFee.taxable, status: "approved", approvedAt: new Date(), edited: true })
            .returning({ id: b.id });
          ids.push(f.id);
        }
      }
      let made: { id: string; number: string };
      try {
        made = await createInvoice(actorId ?? a.requestedBy, { clientId: a.clientId, itemIds: ids, termsDays: 0 });
      } catch (e) {
        await db().delete(b).where(and(inArray(b.id, ids), eq(b.source, "manual")));
        await db().update(schema.contractAutopay).set({ lastError: `invoice: ${e instanceof Error ? e.message : "failed"}` }).where(eq(schema.contractAutopay.id, a.id));
        continue;
      }
      out.invoices++;
      await db().update(schema.clientInvoices).set({ autopayId: a.id }).where(eq(schema.clientInvoices.id, made.id));
      await (await import("./quickbooks.ts")).autoSync("invoices", made.id).catch(() => undefined);
      (await chargeInvoice(made.id, a)) ? out.charged++ : out.failed++;
    }
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Charge the saved card for what is left on the invoice, then email it (paid, or the usual email with the pay link) */
export async function chargeInvoice(invoiceId: string, a: Row): Promise<boolean> {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv || inv.voided) return false;
  const balance = await balanceOf(inv);
  const mail = await import("./invoiceMail.ts");
  if (balance <= 0) return true;
  try {
    if (!a.stripeCustomerId || !a.stripePaymentMethodId) throw new StripeError("api", "no_card");
    const key = await stripeKey();
    const pi = await stripeCall<{ id: string; status: string; last_payment_error?: { message?: string } }>(
      key,
      "POST",
      "/payment_intents",
      {
        amount: String(balance),
        currency: "cad",
        customer: a.stripeCustomerId,
        payment_method: a.stripePaymentMethodId,
        off_session: "true",
        confirm: "true",
        description: `Facture ${inv.number}`.slice(0, 250),
        "metadata[invoice_id]": inv.id,
        "metadata[invoice_number]": inv.number,
        "metadata[autopay_id]": a.id,
      },
      `autopay-charge-${inv.id}`,
    );
    if (pi.status !== "succeeded") throw new StripeError("api", pi.last_payment_error?.message ?? pi.status);
    await db()
      .insert(schema.invoicePayments)
      .values({ invoiceId: inv.id, amountCents: balance, paidOn: today(), method: "stripe", reference: pi.id.slice(0, 100), note: `Carte ${a.cardBrand ?? ""} •••• ${a.cardLast4 ?? ""}`.trim(), source: "stripe", externalId: `stripe:${pi.id}` })
      .onConflictDoNothing();
    await db().update(schema.clientInvoices).set({ cardChargeStatus: "charged", cardChargeError: null, updatedAt: new Date() }).where(eq(schema.clientInvoices.id, inv.id));
    await db().update(schema.contractAutopay).set({ lastChargeAt: new Date(), lastError: null }).where(eq(schema.contractAutopay.id, a.id));
    await audit(null, "billing.autopay_charged", inv.id, { number: inv.number, amountCents: balance });
    await mail.sendInvoiceMail(inv.id, "sent", null).catch(() => null);
    return true;
  } catch (e) {
    const why = (e instanceof StripeError ? (e.detail ?? e.code) : e instanceof Error ? e.message : "failed").slice(0, 200);
    await db().update(schema.clientInvoices).set({ cardChargeStatus: "failed", cardChargeError: why, updatedAt: new Date() }).where(eq(schema.clientInvoices.id, inv.id));
    await db().update(schema.contractAutopay).set({ lastError: why }).where(eq(schema.contractAutopay.id, a.id));
    await audit(null, "billing.autopay_failed", inv.id, { number: inv.number, why });
    const [client] = await db().select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, inv.clientId));
    await notify(await usersWith("staff", "accounting.manage"), { type: "billing.card_failed", data: { number: inv.number, client: client?.name ?? "", why }, link: `/accounting/invoices?istatus=all&iq=${encodeURIComponent(inv.number)}` });
    // the client still gets the invoice, with the pay link
    await mail.sendInvoiceMail(inv.id, "sent", null).catch(() => null);
    return false;
  }
}

/** The card shown in an email: "Visa •••• 4242" */
export async function cardOfInvoice(inv: { autopayId: string | null }) {
  if (!inv.autopayId) return "";
  const [a] = await db().select().from(schema.contractAutopay).where(eq(schema.contractAutopay.id, inv.autopayId));
  if (!a) return "";
  const brand = a.cardBrand ? a.cardBrand.charAt(0).toUpperCase() + a.cardBrand.slice(1) : "";
  return `${brand} •••• ${a.cardLast4 ?? ""}`.trim();
}
