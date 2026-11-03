import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { billingSettings } from "../lib/billing.ts";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { acceptAutopay, autopayOfContract, autopayOfToken, autopayReady, autopaySummary, AutopayError, autopayUrl, contractNames, requestAutopay, requestAutopays, revokeAutopay } from "../lib/cardAutopay.ts";
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
    const contractId = zUuid.parse(c.req.param("contractId"));
    const row = await autopayOfContract(contractId);
    // where the link goes when no address is typed: the client's billing email, else its own
    const [client] = await db().select({ email: schema.clients.email, invoice: schema.clients.invoice }).from(schema.clients).innerJoin(schema.clientContracts, eq(schema.clientContracts.clientId, schema.clients.id)).where(eq(schema.clientContracts.id, contractId));
    const defaultEmail = (client?.invoice?.billingEmail || client?.email || "").trim() || null;
    return c.json({
      ready: await autopayReady(),
      defaultEmail,
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
  /**
   * Every card authorization (Accounting › Contrats › Paiements par carte): one row per link (the contracts it covers
   * together), its state, who accepted and when (with the IP and the exact text: the proof), the card, the last charge.
   */
  .get("/overview", requireStaff, requirePermission("accounting.view"), async (c) => {
    const rows = await db()
      .select({ a: schema.contractAutopay, contract: schema.clientContracts.name, client: schema.clients.name })
      .from(schema.contractAutopay)
      .innerJoin(schema.clientContracts, eq(schema.clientContracts.id, schema.contractAutopay.contractId))
      .innerJoin(schema.clients, eq(schema.clients.id, schema.contractAutopay.clientId))
      .orderBy(desc(schema.contractAutopay.requestedAt));
    const groups = new Map<string, { lead: (typeof rows)[number]; contracts: { id: string; name: string }[] }>();
    for (const r of rows) {
      const key = r.a.batchId ?? r.a.id;
      const g = groups.get(key);
      if (g) g.contracts.push({ id: r.a.contractId, name: r.contract });
      else groups.set(key, { lead: r, contracts: [{ id: r.a.contractId, name: r.contract }] });
    }
    return c.json(
      [...groups.values()].map(({ lead: { a, client }, contracts }) => ({
        id: a.id,
        clientId: a.clientId,
        client,
        contracts,
        // a card that was refused at its last charge is shown as such until a charge goes through
        status: a.status === "active" && a.lastError ? "failed" : a.status,
        email: a.email,
        requestedAt: a.requestedAt,
        revokedAt: a.revokedAt,
        accepted: a.acceptedAt ? { name: a.acceptedName, at: a.acceptedAt, ip: a.acceptedIp, text: a.acceptedText } : null,
        card: a.cardLast4 ? { brand: a.cardBrand, last4: a.cardLast4, expMonth: a.cardExpMonth, expYear: a.cardExpYear, funding: a.cardFunding } : null,
        live: a.live,
        lastChargeAt: a.lastChargeAt,
        lastError: a.lastError,
        url: a.status === "pending" ? autopayUrl(a.id) : null,
      })),
    );
  })
  /** Several contracts at once (Accounting › Contrats): one link and one email per client, for all its contracts picked */
  .post("/send-many", requireStaff, requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ contractIds: z.array(zUuid).min(1).max(300), send: z.boolean().default(true) }));
    if (!(await autopayReady())) throw new HTTPException(409, { message: "stripe_not_ready" });
    const out: { client: string; contracts: string[]; url: string | null; emailed: string | null; error: string | null }[] = [];
    // each client on its own: one client's problem never stops the others
    const ks = await db().select({ id: schema.clientContracts.id, clientId: schema.clientContracts.clientId }).from(schema.clientContracts).where(inArray(schema.clientContracts.id, p.contractIds));
    const byClient = new Map<string, string[]>();
    for (const k of ks) byClient.set(k.clientId, [...(byClient.get(k.clientId) ?? []), k.id]);
    for (const ids of byClient.values()) {
      try {
        const [r] = await requestAutopays(a.user.id, ids, null);
        if (!r) continue;
        const names = r.contracts.map((k) => k.name);
        let emailed: string | null = null;
        let error: string | null = null;
        if (p.send) {
          if (!r.lead.email) error = "no_email";
          else {
            try {
              emailed = await sendAutopayRequest({ to: r.lead.email, client: r.client, contract: contractNames(names, (await billingSettings()).template.language), link: r.url });
            } catch (e) {
              error = e instanceof InvoiceMailError ? e.message : "mail_failed";
            }
          }
        }
        out.push({ client: r.client.name, contracts: names, url: r.url, emailed, error });
      } catch (e) {
        const [k] = await db().select({ name: schema.clients.name }).from(schema.clients).innerJoin(schema.clientContracts, eq(schema.clientContracts.clientId, schema.clients.id)).where(eq(schema.clientContracts.id, ids[0]!));
        out.push({ client: k?.name ?? "", contracts: [], url: null, emailed: null, error: e instanceof AutopayError ? e.message : "failed" });
      }
    }
    return c.json({ results: out }, 201);
  })
  .delete("/contracts/:contractId", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    return c.json({ revoked: await revokeAutopay(a.user.id, zUuid.parse(c.req.param("contractId"))) });
  });
