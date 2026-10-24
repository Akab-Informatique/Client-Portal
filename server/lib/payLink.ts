import crypto from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { billingSettings, stripeSettings } from "./billing.ts";
import { balanceOf, createCheckout } from "./stripe.ts";

/**
 * "Pay online" in an invoice email: a link of the portal that stays good for as long as the invoice is unpaid and opens a
 * fresh Stripe page when it is clicked (a Stripe page itself only lives a day). The link carries a signature only the
 * server can make, so it cannot be guessed for another invoice.
 */
const sign = (invoiceId: string) => crypto.createHmac("sha256", config.appSecret).update(`invoice-pay:${invoiceId}`).digest("base64url").slice(0, 24);

export const payUrlOf = (invoiceId: string) => `${config.publicUrl}/api/pay/${invoiceId}.${sign(invoiceId)}`;

/** The invoice a pay link names, when its signature is good */
export function invoiceOfToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const good = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return got.length === good.length && crypto.timingSafeEqual(got, good) ? id : null;
}

/** Is paying online on for this client: its own choice, else the default of the invoice template (and Stripe set up). */
export async function payOnlineFor(client: { invoice: { payOnline?: boolean | null } | null }): Promise<boolean> {
  const wanted = client.invoice?.payOnline ?? (await billingSettings()).template.showPaymentLink;
  if (!wanted || !config.publicUrl) return false;
  const s = await stripeSettings();
  return Boolean(s.enabled && s.secretKey && s.paymentLinks && s.webhookSecret);
}

/** Where a click on the pay link goes: a Stripe page for the balance (one still open for long enough is reused), or null. */
export async function checkoutFor(invoiceId: string): Promise<string | null> {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv || inv.voided) return null;
  const balance = await balanceOf(inv);
  if (balance <= 0) return null;
  const soon = new Date(Date.now() + 2 * 3600_000);
  const [open] = await db()
    .select()
    .from(schema.stripeCheckouts)
    .where(and(eq(schema.stripeCheckouts.invoiceId, inv.id), eq(schema.stripeCheckouts.status, "open"), eq(schema.stripeCheckouts.amountCents, balance), gt(schema.stripeCheckouts.expiresAt, soon)))
    .orderBy(desc(schema.stripeCheckouts.createdAt))
    .limit(1);
  if (open) return open.url;
  const made = await createCheckout({ invoiceId: inv.id, actorId: null, baseUrl: config.publicUrl });
  return made.url;
}
