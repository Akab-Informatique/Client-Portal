import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { config } from "../config.ts";
import {
  billingSettings,
  completeQuickBooks,
  formatInvoiceNumber,
  LEDGER_TYPES,
  ledger,
  quickbooksConnectUrl,
  quickbooksRedirectUri,
  quickbooksSettings,
  saveBillingSettings,
  saveQuickBooksSettings,
  saveStripeSettings,
  stripeMode,
  stripeSettings,
  testQuickBooks,
  testStripe,
} from "../lib/billing.ts";

/**
 * Admin › Facturation. Numbering, taxes, template and chart of accounts:
 * admin.billing. QuickBooks and Stripe hold keys that move money: also
 * admin.integrations (master administrators).
 */
const zText = (max: number) => z.string().trim().max(max);
const zAccount = zUuid.nullable();

const quickbooksView = async (origin?: string | null) => {
  const s = await quickbooksSettings();
  const base = config.publicUrl || origin || "";
  return {
    enabled: s.enabled,
    environment: s.environment,
    clientId: s.clientId,
    hasSecret: Boolean(s.clientSecret),
    connected: Boolean(s.refreshToken && s.realmId),
    realmId: s.realmId,
    companyName: s.companyName,
    connectedAt: s.connectedAt,
    sync: s.sync,
    lastTest: s.lastTest ?? null,
    redirectUri: base ? quickbooksRedirectUri(base) : null,
  };
};
const stripeView = async () => {
  const s = await stripeSettings();
  return { enabled: s.enabled, publishableKey: s.publishableKey, paymentLinks: s.paymentLinks, hasSecretKey: Boolean(s.secretKey), hasWebhookSecret: Boolean(s.webhookSecret), mode: stripeMode(s.secretKey), lastTest: s.lastTest ?? null };
};

export const billingRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** Back from Intuit (a browser redirect: no JSON, the session says who). */
  .get("/quickbooks/callback", requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const { state, code, realmId, error } = c.req.query();
    if (error || !state || !code || !realmId) return c.redirect("/?admin=billing&tab=quickbooks&quickbooks=cancelled");
    try {
      await completeQuickBooks(a.realUser.id, state, code, realmId);
      await audit(a.realUser.id, "billing.quickbooks.connected", null, { realmId });
      return c.redirect("/?admin=billing&tab=quickbooks&quickbooks=connected");
    } catch (e) {
      console.warn("[quickbooks] connect failed:", e instanceof Error ? e.message : e);
      return c.redirect("/?admin=billing&tab=quickbooks&quickbooks=error");
    }
  })

  // ── General: numbering, taxes, company, template, default accounts ──
  .get("/settings", requirePermission("admin.billing"), async (c) => {
    const s = await billingSettings();
    return c.json({ ...s, preview: formatInvoiceNumber(s.numbering) });
  })
  .put("/settings", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        numbering: z.object({ prefix: zText(10).regex(/^[A-Za-z0-9-]*$/), next: z.number().int().min(1).max(99_999_999), digits: z.number().int().min(1).max(10) }).partial().optional(),
        taxes: z
          .object({ gstNumber: zText(40), qstNumber: zText(40), gstRate: z.number().min(0).max(30), qstRate: z.number().min(0).max(30) })
          .partial()
          .optional(),
        company: z
          .object({ legalName: zText(120), address: zText(300), phone: zText(40), email: z.union([zEmail, z.literal("")]), website: zText(120) })
          .partial()
          .optional(),
        template: z
          .object({ language: z.enum(["fr", "en"]), termsDays: z.number().int().min(0).max(120), footer: zText(1000), paymentInstructions: zText(1000), showPaymentLink: z.boolean() })
          .partial()
          .optional(),
        accounts: z
          .object({ receivable: zAccount, bank: zAccount, labour: zAccount, charges: zAccount, contracts: zAccount, gst: zAccount, qst: zAccount })
          .partial()
          .optional(),
      }),
    );
    // the default accounts must exist in the chart
    const ids = Object.values(p.accounts ?? {}).filter((x): x is string => Boolean(x));
    if (ids.length) {
      const known = new Set((await ledger()).map((r) => r.id));
      if (ids.some((id) => !known.has(id))) throw new HTTPException(400, { message: "billing_unknown_account" });
    }
    const s = await saveBillingSettings(a.user.id, p);
    await audit(a.user.id, "billing.settings_updated", null, { parts: Object.keys(p) });
    return c.json({ ...s, preview: formatInvoiceNumber(s.numbering) });
  })

  // ── Chart of accounts (plan comptable) ──
  .get("/ledger", requirePermission("admin.billing"), async (c) => c.json(await ledger(auth(c).user.id)))
  .post("/ledger", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ number: zText(20).min(1).regex(/^[A-Za-z0-9.-]+$/), name: zText(120).min(1), type: z.enum(LEDGER_TYPES) }));
    const [row] = await db().insert(schema.ledgerAccounts).values(p).onConflictDoNothing().returning();
    if (!row) throw new HTTPException(409, { message: "billing_account_exists" });
    await audit(a.user.id, "billing.account_created", row.id, { number: p.number });
    return c.json(row, 201);
  })
  .patch("/ledger/:id", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ number: zText(20).min(1).regex(/^[A-Za-z0-9.-]+$/), name: zText(120).min(1), type: z.enum(LEDGER_TYPES), active: z.boolean() }).partial());
    if (p.number) {
      const [same] = await db().select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.number, p.number));
      if (same && same.id !== id) throw new HTTPException(409, { message: "billing_account_exists" });
    }
    // an account used by default cannot be turned off
    if (p.active === false && Object.values((await billingSettings()).accounts).includes(id)) throw new HTTPException(409, { message: "billing_account_in_use" });
    const [row] = await db().update(schema.ledgerAccounts).set({ ...p, updatedAt: new Date() }).where(eq(schema.ledgerAccounts.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "billing.account_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  // ── Stripe (master administrators) ──
  .get("/stripe", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => c.json(await stripeView()))
  .put("/stripe", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean().optional(),
        paymentLinks: z.boolean().optional(),
        publishableKey: z.union([z.string().trim().regex(/^pk_(test|live)_[A-Za-z0-9]+$/), z.literal("")]).optional(),
        secretKey: z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/).optional(),
        webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]+$/).optional(),
      }),
    );
    const s = await stripeSettings();
    const secret = p.secretKey ?? s.secretKey;
    if (p.enabled && !secret) throw new HTTPException(400, { message: "stripe_incomplete" });
    // test and live keys are not mixed
    const pub = p.publishableKey ?? s.publishableKey;
    if (pub && secret && pub.includes("_live_") !== (stripeMode(secret) === "live")) throw new HTTPException(400, { message: "stripe_mode_mismatch" });
    await saveStripeSettings(a.user.id, p);
    await audit(a.user.id, "billing.stripe.updated", null, { enabled: p.enabled, keyChanged: p.secretKey !== undefined || undefined, webhookChanged: p.webhookSecret !== undefined || undefined });
    return c.json(await stripeView());
  })
  .post("/stripe/test", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`stripe-test:${a.user.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await stripeSettings();
    if (!s.secretKey) throw new HTTPException(400, { message: "stripe_incomplete" });
    const r = await testStripe(s.secretKey);
    await saveStripeSettings(a.user.id, { lastTest: { ok: r.ok, at: new Date().toISOString(), ...(r.ok ? {} : { error: r.error }) } });
    return c.json(r);
  })

  // ── QuickBooks Online (master administrators) ──
  .get("/quickbooks", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => c.json(await quickbooksView(c.req.header("origin") ?? new URL(c.req.url).origin)))
  .put("/quickbooks", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean().optional(),
        environment: z.enum(["sandbox", "production"]).optional(),
        clientId: z.string().trim().max(200).optional(),
        clientSecret: z.string().trim().min(1).max(200).optional(),
        sync: z.object({ invoices: z.boolean(), payments: z.boolean(), customers: z.boolean() }).partial().optional(),
      }),
    );
    const s = await quickbooksSettings();
    await saveQuickBooksSettings(a.user.id, { ...p, sync: p.sync ? { ...s.sync, ...p.sync } : undefined });
    await audit(a.user.id, "billing.quickbooks.updated", null, { enabled: p.enabled, environment: p.environment, secretChanged: p.clientSecret !== undefined || undefined });
    return c.json(await quickbooksView(c.req.header("origin") ?? new URL(c.req.url).origin));
  })
  .post("/quickbooks/connect", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const base = config.publicUrl || c.req.header("origin");
    if (!base) throw new HTTPException(409, { message: "quickbooks_no_public_url" });
    try {
      return c.json({ url: await quickbooksConnectUrl(a.realUser.id, quickbooksRedirectUri(base)) });
    } catch {
      throw new HTTPException(400, { message: "quickbooks_incomplete" });
    }
  })
  .post("/quickbooks/test", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`quickbooks-test:${a.user.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    return c.json(await testQuickBooks(a.user.id));
  })
  .delete("/quickbooks/connection", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    await saveQuickBooksSettings(a.user.id, { realmId: null, companyName: null, connectedAt: null, refreshToken: null, lastTest: undefined, enabled: false });
    await audit(a.user.id, "billing.quickbooks.disconnected", null);
    return c.json(await quickbooksView(c.req.header("origin") ?? new URL(c.req.url).origin));
  });
