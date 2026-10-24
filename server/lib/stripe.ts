import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { stripeSettings } from "./billing.ts";

/**
 * Card payments on invoices with Stripe Checkout (Accounting › Paiements).
 * A Checkout Session carries the exact amount; Stripe tells the portal when it
 * is paid (webhook, signed) and the payment is then recorded on the invoice.
 * Sessions last at most 24 h: a new link is made when one runs out.
 */
export class StripeError extends Error {
  constructor(
    public code: "not_configured" | "no_webhook_secret" | "invoice_not_found" | "invoice_voided" | "nothing_to_pay" | "amount" | "api",
    public detail?: string,
  ) {
    super(code);
  }
}

/** Stripe's minimum charge in CAD */
export const MIN_CENTS = 50;
const LINK_HOURS = 23;

/** Form-encoded call to the Stripe API with the account's secret key. */
async function stripeCall<T>(key: string, method: "GET" | "POST", path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StripeError("api", "network");
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
  if (!res.ok) throw new StripeError("api", (res.status === 401 ? "invalid_key" : (j.error?.message ?? `HTTP ${res.status}`)).slice(0, 200));
  return j as T;
}

/** What is left to pay on an invoice (cents): same rule as the invoice lists. */
export async function balanceOf(inv: typeof schema.clientInvoices.$inferSelect): Promise<number> {
  if (inv.voided) return 0;
  const rows = await db().select({ a: schema.invoicePayments.amountCents }).from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, inv.id));
  const received = rows.reduce((s, x) => s + x.a, 0);
  const paid = inv.paidOn && received < inv.totalCents ? inv.totalCents : received;
  return Math.max(0, inv.totalCents - paid);
}

type Session = {
  id: string;
  url?: string | null;
  livemode?: boolean;
  expires_at?: number;
  amount_total?: number | null;
  currency?: string | null;
  payment_status?: string;
  payment_intent?: string | null;
  metadata?: Record<string, string>;
};

/** A payment link for an invoice: the whole balance, or part of it. */
export async function createCheckout(p: { invoiceId: string; amountCents?: number; actorId: string | null; baseUrl: string }) {
  const s = await stripeSettings();
  if (!s.enabled || !s.secretKey || !s.paymentLinks) throw new StripeError("not_configured");
  // without the webhook, a payment would reach Stripe but never the invoice
  if (!s.webhookSecret) throw new StripeError("no_webhook_secret");
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, p.invoiceId));
  if (!inv) throw new StripeError("invoice_not_found");
  if (inv.voided) throw new StripeError("invoice_voided");
  const balance = await balanceOf(inv);
  if (balance <= 0) throw new StripeError("nothing_to_pay");
  const amount = p.amountCents ?? balance;
  if (!Number.isInteger(amount) || amount > balance || amount < Math.min(MIN_CENTS, balance)) throw new StripeError("amount", String(balance));
  const [client] = await db().select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, inv.clientId));

  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + LINK_HOURS * 3600;
  const session = await stripeCall<Session>(
    s.secretKey,
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      "line_items[0][price_data][currency]": "cad",
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][product_data][name]": `Facture ${inv.number} - AKAB Informatique`.slice(0, 250),
      "line_items[0][price_data][product_data][description]": (client?.name ?? "").slice(0, 250) || "AKAB Informatique",
      "line_items[0][quantity]": "1",
      client_reference_id: inv.id,
      "metadata[invoice_id]": inv.id,
      "metadata[invoice_number]": inv.number,
      "metadata[checkout_id]": id,
      "payment_intent_data[description]": `Facture ${inv.number}`.slice(0, 250),
      "payment_intent_data[metadata][invoice_number]": inv.number,
      expires_at: String(expiresAt),
      success_url: `${p.baseUrl}/paiement-recu`,
      cancel_url: `${p.baseUrl}/paiement-recu?annule=1`,
    },
    `portal-checkout-${id}`,
  );
  if (!session.url) throw new StripeError("api", "no_url");
  const [row] = await db()
    .insert(schema.stripeCheckouts)
    .values({ id, invoiceId: inv.id, sessionId: session.id, url: session.url, amountCents: amount, live: Boolean(session.livemode), expiresAt: new Date((session.expires_at ?? expiresAt) * 1000), createdBy: p.actorId })
    .returning();
  await audit(p.actorId, "billing.stripe.checkout_created", inv.id, { number: inv.number, amountCents: amount, live: row.live });
  return row;
}

/** Close a link that is not wanted any more (Stripe refuses new payments on it). */
export async function expireCheckout(id: string, actorId: string) {
  const [row] = await db().select().from(schema.stripeCheckouts).where(eq(schema.stripeCheckouts.id, id));
  if (!row || row.status !== "open") return row ?? null;
  const s = await stripeSettings();
  if (s.secretKey) {
    try {
      await stripeCall(s.secretKey, "POST", `/checkout/sessions/${encodeURIComponent(row.sessionId)}/expire`, {});
    } catch (e) {
      // already expired or completed on Stripe's side: its webhook will say which
      if (!(e instanceof StripeError)) throw e;
    }
  }
  const [updated] = await db().update(schema.stripeCheckouts).set({ status: "expired" }).where(and(eq(schema.stripeCheckouts.id, id), eq(schema.stripeCheckouts.status, "open"))).returning();
  await audit(actorId, "billing.stripe.checkout_expired", row.invoiceId, {});
  return updated ?? row;
}

// ── Webhook ──

/** Stripe-Signature: t=<time>,v1=<hmac of "<time>.<raw body>"> with the endpoint secret; 5 minutes of tolerance. */
export function verifySignature(raw: string, header: string | undefined, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((x) => x.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return sigs.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

type StripeEvent = { id: string; type: string; data: { object: Session } };

/** A paid session becomes a payment on its invoice (once: the session id is the key). */
async function recordPaid(session: Session) {
  const [row] = await db().select().from(schema.stripeCheckouts).where(eq(schema.stripeCheckouts.sessionId, session.id));
  // a session this portal did not create is not ours
  if (!row || row.status === "paid") return "ignored";
  const amount = session.amount_total ?? row.amountCents;
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, row.invoiceId));
  if (!inv) return "ignored";
  const balance = await balanceOf(inv);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  // the money is received whatever happened meanwhile: kept, and flagged when it exceeds the balance
  await db()
    .insert(schema.invoicePayments)
    .values({
      invoiceId: inv.id,
      amountCents: amount,
      paidOn: today,
      method: "stripe",
      reference: (session.payment_intent ?? session.id).slice(0, 100),
      note: amount > balance ? "Stripe: dépasse le solde de la facture" : null,
      source: "stripe",
      externalId: `stripe:${session.id}`,
    })
    .onConflictDoNothing();
  await db().update(schema.stripeCheckouts).set({ status: "paid", paidAt: new Date() }).where(eq(schema.stripeCheckouts.id, row.id));
  await audit(null, "billing.stripe.payment_received", inv.id, { number: inv.number, amountCents: amount, live: Boolean(session.livemode) });
  return "paid";
}

async function setStatus(sessionId: string, status: "expired" | "failed") {
  await db()
    .update(schema.stripeCheckouts)
    .set({ status })
    .where(and(eq(schema.stripeCheckouts.sessionId, sessionId), inArray(schema.stripeCheckouts.status, ["open"])));
}

/** React to a verified event. Returns what was done (for the log and the tests). */
export async function handleEvent(ev: StripeEvent): Promise<string> {
  const o = ev.data?.object;
  if (!o?.id) return "ignored";
  switch (ev.type) {
    case "checkout.session.completed":
      // cards are paid at once; bank debits come later (async_payment_succeeded)
      return o.payment_status === "paid" ? recordPaid(o) : "waiting";
    case "checkout.session.async_payment_succeeded":
      return recordPaid(o);
    case "checkout.session.async_payment_failed":
      await setStatus(o.id, "failed");
      return "failed";
    case "checkout.session.expired":
      await setStatus(o.id, "expired");
      return "expired";
    default:
      return "ignored";
  }
}
