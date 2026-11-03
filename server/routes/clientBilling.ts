import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { notify, usersWith } from "../lib/notify.ts";
import { body, zUuid } from "../lib/validate.ts";
import { balanceOf, cardFeeFor } from "../lib/stripe.ts";
import { payUrlOf, stripePayReady } from "../lib/payLink.ts";
import { invoicePdfFor } from "../lib/invoiceMail.ts";
import { autopayOfContract, autopayReady, autopayToken, AutopayError, contractTerms, requestAutopays, revokeAutopay } from "../lib/cardAutopay.ts";

/**
 * The client portal's invoices and contracts (Comptabilité): always the signed-in person's own company
 * (auth.user.clientId), never an id the browser chose — an invoice or contract of another company answers 404.
 */
const companyOf = (a: AuthContext) => {
  if (a.user.kind !== "client" || !a.user.clientId) throw new HTTPException(403, { message: "Forbidden" });
  return a.user.clientId;
};
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** The company's contracts the person may act on (active ones, of their own company only) */
async function ownContracts(clientId: string, ids: string[]) {
  const rows = ids.length ? await db().select().from(schema.clientContracts).where(and(inArray(schema.clientContracts.id, ids), eq(schema.clientContracts.clientId, clientId), eq(schema.clientContracts.active, true))) : [];
  if (rows.length !== new Set(ids).size) throw new HTTPException(404, { message: "not_found" });
  return rows;
}

export const clientBillingRoutes = new Hono<AppEnv>()
  .get("/invoices", requirePermission("clientInvoices.view"), async (c) => {
    const clientId = companyOf(auth(c));
    // paying by card from the portal: whenever Stripe takes payments (the invoice email's own link follows the client's setting)
    const canPay = await stripePayReady();
    const rows = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.clientId, clientId)).orderBy(desc(schema.clientInvoices.issuedOn), desc(schema.clientInvoices.number)).limit(200);
    const out = [];
    for (const v of rows) {
      const balanceCents = await balanceOf(v);
      const late = !v.voided && balanceCents > 0 && Boolean(v.dueOn && v.dueOn < today());
      const status = v.voided ? "voided" : balanceCents === 0 ? "paid" : balanceCents < v.totalCents ? "partial" : late ? "overdue" : "due";
      out.push({
        id: v.id,
        number: v.number,
        issuedOn: v.issuedOn,
        dueOn: v.dueOn,
        totalCents: v.totalCents,
        balanceCents,
        status,
        paidByCard: v.cardChargeStatus === "charged",
        payUrl: balanceCents > 0 && canPay ? payUrlOf(v.id) : null,
        // the credit card fee that would be added (said before paying)
        cardFee: balanceCents > 0 && canPay ? await cardFeeFor(clientId, balanceCents) : null,
      });
    }
    return c.json(out);
  })
  /** The invoice as a PDF (the one sent by email): only one of the person's own company */
  .get("/invoices/:id/pdf", requirePermission("clientInvoices.view"), async (c) => {
    const clientId = companyOf(auth(c));
    const id = zUuid.parse(c.req.param("id"));
    const [inv] = await db().select({ id: schema.clientInvoices.id }).from(schema.clientInvoices).where(and(eq(schema.clientInvoices.id, id), eq(schema.clientInvoices.clientId, clientId)));
    if (!inv) throw new HTTPException(404, { message: "not_found" });
    const pdf = await invoicePdfFor(inv.id).catch(() => null);
    if (!pdf) throw new HTTPException(500, { message: "pdf_failed" });
    const download = c.req.query("download") === "1";
    return new Response(new Uint8Array(pdf.content), { headers: { "content-type": "application/pdf", "content-disposition": `${download ? "attachment" : "inline"}; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
  })

  /** The company's running contracts: what each charges and when, and its automatic card payment */
  .get("/contracts", requirePermission("clientContracts.view"), async (c) => {
    const clientId = companyOf(auth(c));
    const rows = await db().select().from(schema.clientContracts).where(and(eq(schema.clientContracts.clientId, clientId), eq(schema.clientContracts.active, true)));
    const contracts = [];
    for (const k of rows.sort((x, y) => x.name.localeCompare(y.name))) {
      const a = await autopayOfContract(k.id);
      contracts.push({
        ...(await contractTerms(k)),
        autopay: a
          ? {
              status: a.status,
              card: a.status === "active" && a.cardLast4 ? { brand: a.cardBrand, last4: a.cardLast4, expMonth: a.cardExpMonth, expYear: a.cardExpYear } : null,
              acceptedName: a.acceptedName,
              acceptedAt: a.acceptedAt,
              lastChargeAt: a.lastChargeAt,
              declined: Boolean(a.lastError),
            }
          : null,
      });
    }
    return c.json({ ready: await autopayReady(), contracts });
  })
  /** Turn on (or replace the card of) automatic payment for some of the company's contracts: the page to accept and save a card */
  .post("/contracts/autopay", requirePermission("clientContracts.autopay"), async (c) => {
    const a = auth(c);
    const clientId = companyOf(a);
    if (!rateLimit(`client-autopay:${a.user.id}`, 20, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, z.object({ contractIds: z.array(zUuid).min(1).max(50) }));
    const ks = await ownContracts(clientId, p.contractIds);
    if (!(await autopayReady())) throw new HTTPException(409, { message: "stripe_not_ready" });
    try {
      const [r] = await requestAutopays(a.user.id, ks.map((k) => k.id), a.user.email);
      if (!r) throw new HTTPException(404, { message: "not_found" });
      return c.json({ path: `/carte/${autopayToken(r.lead.id)}` }, 201);
    } catch (e) {
      if (e instanceof AutopayError) throw new HTTPException(409, { message: e.message });
      throw e;
    }
  })
  /** Turn off automatic payment of one of the company's contracts; accounting is told on the bell */
  .delete("/contracts/:id/autopay", requirePermission("clientContracts.autopay"), async (c) => {
    const a = auth(c);
    const clientId = companyOf(a);
    const [k] = await ownContracts(clientId, [zUuid.parse(c.req.param("id"))]);
    const revoked = await revokeAutopay(a.user.id, k.id);
    if (revoked) {
      const [client] = await db().select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId));
      await notify(await usersWith("staff", "accounting.manage"), { type: "billing.autopay_client_off", data: { client: client?.name ?? "", contract: k.name, by: a.user.name }, link: "/accounting/contracts?tab=cards" });
      await audit(a.user.id, "billing.autopay_client_off", k.id, { contract: k.name });
    }
    return c.json({ revoked });
  });
