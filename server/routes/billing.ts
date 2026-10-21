import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
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
import { createCheckout, expireCheckout, handleEvent, MIN_CENTS, StripeError, verifySignature } from "../lib/stripe.ts";
import { createVendorInQb, pushSoon, selectVendors, syncAll, syncVendors, vendorChoices, type SyncPart } from "../lib/qbSync.ts";
import { applyAccounts, applyItems, createCustomer, forgetQuickBooksToken, invoiceChoices, matchReason, planAccounts, planItems, pullInvoices, pullPayments, quickbooksCustomers, QuickBooksError, suggestions } from "../lib/quickbooks.ts";

/** QuickBooks errors as API errors (quickbooks_not_mapped, quickbooks_api…). */
export function quickbooksHttp(e: unknown): never {
  if (e instanceof QuickBooksError) {
    const status = e.code === "api" ? 502 : 409;
    throw new HTTPException(status, { message: `quickbooks_${e.code}`, cause: e.detail ? [{ path: "quickbooks", message: e.detail }] : undefined });
  }
  throw e;
}
const qbRun = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e) {
    return quickbooksHttp(e);
  }
};

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
    invoicesFromNumber: s.invoicesFromNumber,
    lastTest: s.lastTest ?? null,
    redirectUri: base ? quickbooksRedirectUri(base) : null,
    invoice: s.invoice,
    imports: s.imports,
    runs: s.runs,
    paymentsPulledAt: s.paymentsPulledAt,
  };
};
/** The portal's public address: PUBLIC_URL, else the one the request came to */
const publicBase = (c: Context) => config.publicUrl || c.req.header("origin") || new URL(c.req.url).origin;

/** Where Stripe sends its events, and which ones the portal listens to (Stripe › Développeurs › Webhooks) */
const STRIPE_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"];
const stripeView = async (base: string) => {
  const s = await stripeSettings();
  return {
    enabled: s.enabled,
    publishableKey: s.publishableKey,
    paymentLinks: s.paymentLinks,
    hasSecretKey: Boolean(s.secretKey),
    hasWebhookSecret: Boolean(s.webhookSecret),
    mode: stripeMode(s.secretKey),
    lastTest: s.lastTest ?? null,
    webhookUrl: `${base}/api/stripe/hook`,
    events: STRIPE_EVENTS,
  };
};

/** Stripe errors as API errors (stripe_not_configured, stripe_api…). */
function stripeHttp(e: unknown): never {
  if (e instanceof StripeError) {
    const status = e.code === "api" ? 502 : e.code === "invoice_not_found" ? 404 : e.code === "amount" ? 400 : 409;
    throw new HTTPException(status, { message: `stripe_${e.code}`, cause: e.detail ? [{ path: "stripe", message: e.detail }] : undefined });
  }
  throw e;
}

/**
 * Stripe calls this when a payment link is paid or runs out (signed: nothing is
 * done without the endpoint secret). No session: it is Stripe, not a person.
 */
export const stripeHookRoutes = new Hono<AppEnv>().post("/", async (c) => {
  if (!rateLimit(`stripe-hook:${clientIp(c)}`, 300, 60_000).ok) return c.json({ error: "rate_limited" }, 429);
  const raw = await c.req.text();
  const s = await stripeSettings();
  if (!s.webhookSecret || !verifySignature(raw, c.req.header("stripe-signature"), s.webhookSecret)) {
    console.warn("[stripe] webhook refused (bad signature)");
    return c.json({ error: "bad_signature" }, 400);
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  try {
    return c.json({ received: true, result: await handleEvent(event) });
  } catch (e) {
    // an error answer makes Stripe send the event again later
    console.error("[stripe] webhook", e);
    return c.json({ error: "server_error" }, 500);
  }
});

export const billingRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** Back from Intuit (a browser redirect: no JSON, the session says who). */
  .get("/quickbooks/callback", requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const { state, code, realmId, error } = c.req.query();
    if (error || !state || !code || !realmId) return c.redirect("/?admin=integrations&integration=quickbooks&quickbooks=cancelled");
    try {
      await completeQuickBooks(a.realUser.id, state, code, realmId);
      forgetQuickBooksToken();
      await audit(a.realUser.id, "billing.quickbooks.connected", null, { realmId });
      return c.redirect("/?admin=integrations&integration=quickbooks&quickbooks=connected");
    } catch (e) {
      console.warn("[quickbooks] connect failed:", e instanceof Error ? e.message : e);
      return c.redirect("/?admin=integrations&integration=quickbooks&quickbooks=error");
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
        rates: z.object({ hourly: z.number().min(0).max(10_000) }).partial().optional(),
        autotask: z
          .object({ invoicesSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), invoiceMinNumber: z.number().int().min(0).max(999_999_999).nullable(), itemsSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
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
    void pushSoon("accounts", id);
    return c.json(row);
  })

  // ── Stripe (master administrators) ──
  .get("/stripe", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => c.json(await stripeView(publicBase(c))))
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
    return c.json(await stripeView(publicBase(c)));
  })
  .post("/stripe/test", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`stripe-test:${a.user.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await stripeSettings();
    if (!s.secretKey) throw new HTTPException(400, { message: "stripe_incomplete" });
    const r = await testStripe(s.secretKey);
    await saveStripeSettings(a.user.id, { lastTest: { ok: r.ok, at: new Date().toISOString(), ...(r.ok ? { account: r.account } : { error: r.error }) } });
    return c.json(r);
  })

  // ── Card payments on invoices (Accounting › Paiements): see accounting.view, make links with accounting.manage ──
  .get("/payments/status", requirePermission("accounting.view"), async (c) => {
    const s = await stripeSettings();
    const base = publicBase(c);
    return c.json({ ready: s.enabled && Boolean(s.secretKey) && s.paymentLinks, mode: stripeMode(s.secretKey), hasWebhookSecret: Boolean(s.webhookSecret), webhookUrl: `${base}/api/stripe/hook`, minCents: MIN_CENTS });
  })
  .get("/payments/checkouts", requirePermission("accounting.view"), async (c) => {
    const k = schema.stripeCheckouts;
    const rows = await db()
      .select({ k, number: schema.clientInvoices.number, company: schema.clients.name, by: schema.users.name })
      .from(k)
      .innerJoin(schema.clientInvoices, eq(schema.clientInvoices.id, k.invoiceId))
      .innerJoin(schema.clients, eq(schema.clients.id, schema.clientInvoices.clientId))
      .leftJoin(schema.users, eq(schema.users.id, k.createdBy))
      .orderBy(desc(k.createdAt))
      .limit(100);
    const now = Date.now();
    return c.json(
      rows.map((r) => ({
        id: r.k.id,
        invoiceId: r.k.invoiceId,
        number: r.number,
        company: r.company,
        amountCents: r.k.amountCents,
        // a link past its time is expired even if Stripe has not said so yet
        status: r.k.status === "open" && r.k.expiresAt.getTime() < now ? "expired" : r.k.status,
        live: r.k.live,
        url: r.k.status === "open" && r.k.expiresAt.getTime() >= now ? r.k.url : null,
        expiresAt: r.k.expiresAt,
        paidAt: r.k.paidAt,
        createdAt: r.k.createdAt,
        by: r.by,
      })),
    );
  })
  .post("/payments/checkouts", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`stripe-checkout:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, z.object({ invoiceId: zUuid, amountCents: z.number().int().min(1).max(100_000_000).optional() }));
    const baseUrl = config.publicUrl || c.req.header("origin");
    if (!baseUrl) throw new HTTPException(409, { message: "public_url_missing" });
    try {
      const row = await createCheckout({ invoiceId: p.invoiceId, amountCents: p.amountCents, actorId: a.user.id, baseUrl });
      return c.json({ id: row.id, url: row.url, amountCents: row.amountCents, live: row.live, expiresAt: row.expiresAt }, 201);
    } catch (e) {
      return stripeHttp(e);
    }
  })
  .post("/payments/checkouts/:id/expire", requirePermission("accounting.manage"), async (c) => {
    const row = await expireCheckout(zUuid.parse(c.req.param("id")), auth(c).user.id).catch(stripeHttp);
    if (!row) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true, status: row.status });
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
        sync: z.object({ invoices: z.boolean(), invoicesIn: z.boolean(), payments: z.boolean(), customers: z.boolean(), accounts: z.boolean(), vendors: z.boolean(), timesheets: z.boolean(), expenses: z.boolean() }).partial().optional(),
        invoicesFromNumber: z.number().int().min(0).max(100_000_000).optional(),
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
  // ── QuickBooks data (admin.billing, through the saved connection) ──
  /** Portal clients and QuickBooks customers, with the likely match of each unmapped client. */
  .get("/quickbooks/mapping", requirePermission("admin.billing"), async (c) => {
    const customers = await qbRun(() => quickbooksCustomers());
    const clients = await db()
      .select({ id: schema.clients.id, name: schema.clients.name, email: schema.clients.email, city: schema.clients.city, quickbooksId: schema.clients.quickbooksId })
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(asc(schema.clients.name));
    const suggested = suggestions(clients, customers);
    const byId = new Map(customers.map((q) => [q.id, q]));
    return c.json({
      customers,
      clients: clients.map((x) => {
        const s = suggested.get(x.id);
        return { ...x, suggestion: s ?? null, reason: s ? matchReason(x, byId.get(s)!) : null };
      }),
    });
  })
  .put("/quickbooks/mapping/:clientId", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const clientId = zUuid.parse(c.req.param("clientId"));
    const p = await body(c, z.object({ quickbooksId: z.string().trim().min(1).max(40).nullable() }));
    if (p.quickbooksId) {
      // one customer, one client: no doubles
      const [other] = await db().select({ name: schema.clients.name }).from(schema.clients).where(and(eq(schema.clients.quickbooksId, p.quickbooksId), ne(schema.clients.id, clientId)));
      if (other) throw new HTTPException(409, { message: "quickbooks_customer_taken", cause: [{ path: "quickbooks", message: other.name }] });
    }
    const [row] = await db().update(schema.clients).set({ quickbooksId: p.quickbooksId, qbSyncedAt: null, updatedAt: new Date() }).where(eq(schema.clients.id, clientId)).returning({ id: schema.clients.id });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "billing.quickbooks.mapped", clientId, { quickbooksId: p.quickbooksId });
    return c.json({ ok: true });
  })
  /** The proposed matches the admin reviewed and accepted (still checked: never two clients on one customer). */
  .post("/quickbooks/mapping/accept", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ accept: z.array(z.object({ clientId: zUuid, quickbooksId: z.string().trim().min(1).max(40) })).max(5000) }));
    const customers = new Set((await qbRun(() => quickbooksCustomers())).map((x) => x.id));
    const rows = await db().select({ id: schema.clients.id, qb: schema.clients.quickbooksId }).from(schema.clients);
    const taken = new Map(rows.filter((r) => r.qb).map((r) => [r.qb!, r.id]));
    let mapped = 0;
    const skipped: string[] = [];
    for (const m of p.accept) {
      const holder = taken.get(m.quickbooksId);
      if (!customers.has(m.quickbooksId) || (holder && holder !== m.clientId)) {
        skipped.push(m.clientId);
        continue;
      }
      const [row] = await db().update(schema.clients).set({ quickbooksId: m.quickbooksId, qbSyncedAt: null, updatedAt: new Date() }).where(eq(schema.clients.id, m.clientId)).returning({ id: schema.clients.id });
      if (!row) continue;
      taken.set(m.quickbooksId, m.clientId);
      mapped++;
    }
    await audit(a.user.id, "billing.quickbooks.mapping_accepted", null, { mapped, skipped: skipped.length });
    return c.json({ mapped, skipped });
  })
  .post("/quickbooks/mapping/:clientId/create", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const clientId = zUuid.parse(c.req.param("clientId"));
    const customer = await qbRun(() => createCustomer(clientId));
    await audit(a.user.id, "billing.quickbooks.customer_created", clientId, { quickbooksId: customer.id });
    return c.json(customer, 201);
  })
  /** Chart of accounts: what would make it the same as QuickBooks' (nothing changed until accepted). */
  .get("/quickbooks/plan/accounts", requirePermission("admin.billing"), async (c) => c.json(await qbRun(() => planAccounts(auth(c).user.id))))
  .post("/quickbooks/plan/accounts", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ accept: z.array(z.string().max(80)).max(10_000) }));
    const r = await qbRun(() => applyAccounts(a.user.id, p.accept));
    await audit(a.user.id, "billing.quickbooks.accounts_synced", null, r);
    return c.json(r);
  })
  /** Categories and items, and the inventory products to tie by SKU (nothing changed until accepted). */
  .get("/quickbooks/plan/items", requirePermission("admin.billing"), async (c) => c.json(await qbRun(() => planItems())))
  .post("/quickbooks/plan/items", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ accept: z.array(z.string().max(80)).max(10_000) }));
    const r = await qbRun(() => applyItems(a.user.id, p.accept));
    await audit(a.user.id, "billing.quickbooks.items_synced", null, r);
    return c.json(r);
  })
  /** Items and tax codes for the invoices sent, and the ones chosen. */
  .get("/quickbooks/invoice-defaults", requirePermission("admin.billing"), async (c) => {
    const choices = await qbRun(() => invoiceChoices());
    return c.json({ ...choices, chosen: (await quickbooksSettings()).invoice });
  })
  .put("/quickbooks/invoice-defaults", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ itemId: z.string().max(40).nullable(), taxCodeId: z.string().max(40).nullable(), exemptTaxCodeId: z.string().max(40).nullable() }).partial());
    const s = await quickbooksSettings();
    await saveQuickBooksSettings(a.user.id, { invoice: { ...s.invoice, ...p } });
    await audit(a.user.id, "billing.quickbooks.invoice_defaults", null, p);
    return c.json((await quickbooksSettings()).invoice);
  })
  /** Payments made in QuickBooks, now (they also come every 15 minutes while the sync is on). */
  /** Bring in the QuickBooks invoices (from the chosen number) with their status, for the clients mapped to a customer. */
  .post("/quickbooks/invoices/pull", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const r = await qbRun(() => pullInvoices(a.user.id));
    await audit(a.user.id, "billing.quickbooks.invoices_pulled", null, { added: r.added, updated: r.updated, unmapped: r.unmapped });
    return c.json(r);
  })
  .post("/quickbooks/payments/pull", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const r = await qbRun(() => pullPayments(a.user.id));
    await audit(a.user.id, "billing.quickbooks.payments_pulled", null, { added: r.added, updated: r.updated });
    return c.json(r);
  })

  // ── The two-way sync: clients (mapped), chart of accounts, vendors (chosen) ──
  /** One pass now: every part that is switched on (or the ones named) */
  .post("/quickbooks/sync", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ parts: z.array(z.enum(["clients", "accounts", "vendors"])).max(3).optional() }));
    const s = await quickbooksSettings();
    const parts = (p.parts ?? (["clients", "accounts", "vendors"] as SyncPart[])).filter((x) => s.sync[x === "clients" ? "customers" : x]);
    const r = await qbRun(() => syncAll(a.user.id, parts));
    if (!r) throw new HTTPException(409, { message: "quickbooks_sync_running" });
    await audit(a.user.id, "billing.quickbooks.sync_now", null, { parts });
    return c.json({ ...r, runs: (await quickbooksSettings()).runs });
  })
  /** The QuickBooks vendors, each with whether it is kept in step with a vendor here, and the portal vendors QuickBooks does not have */
  .get("/quickbooks/vendors", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => c.json(await qbRun(() => vendorChoices())))
  /** The vendors kept in step are exactly the ones chosen (the others are untied, never deleted); then a pass on them */
  .put("/quickbooks/vendors/selection", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ ids: z.array(z.string().trim().min(1).max(40)).max(5000) }));
    const r = await qbRun(() => selectVendors(p.ids, a.user.id));
    await qbRun(() => syncVendors()).catch(() => undefined);
    return c.json(r);
  })
  /** A vendor made here, made in QuickBooks too */
  .post("/quickbooks/vendors/:id/create", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    await qbRun(() => createVendorInQb(id));
    await audit(a.user.id, "billing.quickbooks.vendor_created", id, {});
    return c.json({ ok: true });
  })

  .delete("/quickbooks/connection", requirePermission("admin.billing"), requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    await saveQuickBooksSettings(a.user.id, { realmId: null, companyName: null, connectedAt: null, refreshToken: null, lastTest: undefined, enabled: false });
    forgetQuickBooksToken();
    await audit(a.user.id, "billing.quickbooks.disconnected", null);
    return c.json(await quickbooksView(c.req.header("origin") ?? new URL(c.req.url).origin));
  });
