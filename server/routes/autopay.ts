import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { acceptAutopay, autopayOfContract, autopayOfToken, autopayReady, autopaySummary, AutopayError, autopayUrl, requestAutopay, revokeAutopay } from "../lib/cardAutopay.ts";
import { InvoiceMailError, sendAutopayRequest } from "../lib/invoiceMail.ts";
import { StripeError } from "../lib/stripe.ts";

const fail = (e: unknown): never => {
  if (e instanceof AutopayError) throw new HTTPException(e.message === "not_found" ? 404 : 409, { message: e.message });
  if (e instanceof StripeError) throw new HTTPException(502, { message: e.code === "not_configured" ? "stripe_not_ready" : "stripe_failed" });
  if (e instanceof InvoiceMailError) throw new HTTPException(409, { message: e.message });
  throw e;
};

/**
 * Automatic card payment of a contract. Public (signed link, no sign-in): what the client sees and accepts.
 * Staff: the state of a contract's authorization, send the link, take it off.
 */
export const autopayRoutes = new Hono<AppEnv>()
  .get("/public/:token", async (c) => {
    if (!rateLimit(`autopay-view:${clientIp(c)}`, 60, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const id = autopayOfToken(c.req.param("token"));
    const s = id ? await autopaySummary(id) : null;
    if (!s) throw new HTTPException(404, { message: "not_found" });
    return c.json(s);
  })
  .post("/public/:token/accept", async (c) => {
    if (!rateLimit(`autopay-accept:${clientIp(c)}`, 10, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const id = autopayOfToken(c.req.param("token"));
    if (!id) throw new HTTPException(404, { message: "not_found" });
    const p = await body(c, z.object({ name: z.string().trim().min(2).max(120), agree: z.literal(true) }));
    try {
      return c.json({ url: await acceptAutopay(id, p.name, clientIp(c)) });
    } catch (e) {
      return fail(e);
    }
  })

  .use("/contracts/*", requireStaff)
  .get("/contracts/:contractId", requirePermission("crm.view"), async (c) => {
    const row = await autopayOfContract(zUuid.parse(c.req.param("contractId")));
    return c.json({
      ready: await autopayReady(),
      autopay: row
        ? {
            id: row.id,
            status: row.status,
            email: row.email,
            requestedAt: row.requestedAt,
            acceptedName: row.acceptedName,
            acceptedAt: row.acceptedAt,
            card: row.cardLast4 ? { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth, expYear: row.cardExpYear, funding: row.cardFunding } : null,
            live: row.live,
            lastChargeAt: row.lastChargeAt,
            lastError: row.lastError,
            url: row.status === "pending" ? autopayUrl(row.id) : null,
          }
        : null,
    });
  })
  .post("/contracts/:contractId/send", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ email: zEmail.optional(), send: z.boolean().default(true) }));
    if (!(await autopayReady())) throw new HTTPException(409, { message: "stripe_not_ready" });
    try {
      const r = await requestAutopay(a.user.id, zUuid.parse(c.req.param("contractId")), p.email ?? null);
      let emailed: string | null = null;
      if (p.send) {
        if (!r.row.email) throw new HTTPException(409, { message: "no_email" });
        emailed = await sendAutopayRequest({ to: r.row.email, client: r.client, contract: r.contract.name, link: r.url });
        await db().update(schema.contractAutopay).set({ requestedAt: new Date() }).where(eq(schema.contractAutopay.id, r.row.id));
      }
      return c.json({ url: r.url, emailed }, 201);
    } catch (e) {
      return fail(e);
    }
  })
  .delete("/contracts/:contractId", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    return c.json({ revoked: await revokeAutopay(a.user.id, zUuid.parse(c.req.param("contractId"))) });
  });
