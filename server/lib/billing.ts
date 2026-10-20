import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * Invoicing set-up (Admin › Facturation): numbering, taxes, the invoice
 * template, the chart of accounts, and the QuickBooks / Stripe connections.
 * Settings live in `integrations` (provider "billing", "quickbooks",
 * "stripe"); keys and tokens are sealed with APP_SECRET.
 */

// ── General settings ──
export type BillingSettings = {
  numbering: { prefix: string; next: number; digits: number };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  template: { language: "fr" | "en"; termsDays: number; footer: string; paymentInstructions: string; showPaymentLink: boolean };
  /** The usual hourly rate when neither the source nor the client gives one ($) */
  rates: { hourly: number };
  /** What is copied from Autotask: invoices from this date and number on, work to bill from this date */
  autotask: { invoicesSince: string; invoiceMinNumber: number | null; itemsSince: string };
  /** Default accounts (ledger account ids) used for invoice lines and payments */
  accounts: { receivable: string | null; bank: string | null; labour: string | null; charges: string | null; contracts: string | null; gst: string | null; qst: string | null };
};

export const DEFAULT_BILLING: BillingSettings = {
  // the Autotask invoices start at 10000: the portal carries on after the highest one
  numbering: { prefix: "", next: 10000, digits: 5 },
  taxes: { gstNumber: "", qstNumber: "", gstRate: 5, qstRate: 9.975 },
  company: { legalName: "AKAB Informatique", address: "", phone: "", email: "", website: "akab.ca" },
  template: { language: "fr", termsDays: 30, footer: "Merci de votre confiance !", paymentInstructions: "", showPaymentLink: true },
  accounts: { receivable: null, bank: null, labour: null, charges: null, contracts: null, gst: null, qst: null },
  autotask: { invoicesSince: "2026-09-01", invoiceMinNumber: 10000, itemsSince: "2026-09-01" },
  rates: { hourly: 115 },
};

async function row(provider: string) {
  const [r] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, provider));
  return r ?? null;
}
async function save(provider: string, actorId: string | null, values: { enabled?: boolean; config: Record<string, unknown>; secret?: string | null }) {
  const set = { ...values, updatedBy: actorId, updatedAt: new Date() };
  await db()
    .insert(schema.integrations)
    .values({ provider, enabled: values.enabled ?? false, ...set })
    .onConflictDoUpdate({ target: schema.integrations.provider, set });
}

export async function billingSettings(): Promise<BillingSettings> {
  const c = ((await row("billing"))?.config ?? {}) as Partial<BillingSettings>;
  return {
    numbering: { ...DEFAULT_BILLING.numbering, ...c.numbering },
    taxes: { ...DEFAULT_BILLING.taxes, ...c.taxes },
    company: { ...DEFAULT_BILLING.company, ...c.company },
    template: { ...DEFAULT_BILLING.template, ...c.template },
    accounts: { ...DEFAULT_BILLING.accounts, ...c.accounts },
    autotask: { ...DEFAULT_BILLING.autotask, ...c.autotask },
    rates: { ...DEFAULT_BILLING.rates, ...c.rates },
  };
}

/** Each part may be given in part (the rest is kept). */
export type BillingPatch = { [K in keyof BillingSettings]?: Partial<BillingSettings[K]> };

export async function saveBillingSettings(actorId: string, p: BillingPatch) {
  const cur = await billingSettings();
  const next: BillingSettings = {
    numbering: { ...cur.numbering, ...p.numbering },
    taxes: { ...cur.taxes, ...p.taxes },
    company: { ...cur.company, ...p.company },
    template: { ...cur.template, ...p.template },
    accounts: { ...cur.accounts, ...p.accounts },
    autotask: { ...cur.autotask, ...p.autotask },
    rates: { ...cur.rates, ...p.rates },
  };
  await save("billing", actorId, { enabled: true, config: next as unknown as Record<string, unknown> });
  return next;
}

/** "F01001" from the numbering settings. */
export const formatInvoiceNumber = (n: BillingSettings["numbering"], value = n.next) => `${n.prefix}${String(value).padStart(n.digits, "0")}`;

// ── Chart of accounts ──
export type LedgerType = "asset" | "liability" | "equity" | "revenue" | "expense";
export const LEDGER_TYPES: LedgerType[] = ["asset", "liability", "equity", "revenue", "expense"];

/** A small starting chart for an MSP in Québec (changeable, or replaced by QuickBooks'). */
const STARTER: { number: string; name: string; type: LedgerType; use?: keyof BillingSettings["accounts"] }[] = [
  { number: "1000", name: "Encaisse — compte bancaire", type: "asset", use: "bank" },
  { number: "1200", name: "Comptes clients", type: "asset", use: "receivable" },
  { number: "1300", name: "Inventaire", type: "asset" },
  { number: "2100", name: "Comptes fournisseurs", type: "liability" },
  { number: "2310", name: "TPS à payer", type: "liability", use: "gst" },
  { number: "2320", name: "TVQ à payer", type: "liability", use: "qst" },
  { number: "3000", name: "Capital", type: "equity" },
  { number: "4000", name: "Revenus — main-d'œuvre", type: "revenue", use: "labour" },
  { number: "4100", name: "Revenus — matériel et frais", type: "revenue", use: "charges" },
  { number: "4200", name: "Revenus — contrats récurrents", type: "revenue", use: "contracts" },
  { number: "5000", name: "Coût des marchandises vendues", type: "expense" },
  { number: "5100", name: "Frais de déplacement", type: "expense" },
  { number: "5200", name: "Licences et abonnements", type: "expense" },
];

/** The chart; the starter one is put in the first time (and the defaults pointed at it). */
export async function ledger(actorId?: string) {
  const d = db();
  let rows = await d.select().from(schema.ledgerAccounts).orderBy(asc(schema.ledgerAccounts.number));
  if (!rows.length && actorId) {
    rows = await d
      .insert(schema.ledgerAccounts)
      .values(STARTER.map(({ number, name, type }) => ({ number, name, type })))
      .onConflictDoNothing()
      .returning();
    const accounts = Object.fromEntries(STARTER.filter((s) => s.use).map((s) => [s.use, rows.find((r) => r.number === s.number)?.id ?? null]));
    await saveBillingSettings(actorId, { accounts: accounts as BillingSettings["accounts"] });
    rows.sort((x, y) => x.number.localeCompare(y.number));
  }
  return rows;
}

// ── Stripe (payment links on invoices) ──
/** The Stripe account a key belongs to (read when the key is tested) */
export type StripeAccount = { id: string; name: string | null; country: string | null };
export type StripeSettings = { enabled: boolean; publishableKey: string; paymentLinks: boolean; secretKey: string | null; webhookSecret: string | null; lastTest?: { ok: boolean; at: string; error?: string; account?: StripeAccount | null } };

export async function stripeSettings(): Promise<StripeSettings> {
  const r = await row("stripe");
  const c = (r?.config ?? {}) as Partial<StripeSettings>;
  let secrets: { secretKey?: string; webhookSecret?: string } = {};
  try {
    secrets = JSON.parse(unseal(r?.secret) ?? "{}");
  } catch {
    secrets = {};
  }
  return { enabled: r?.enabled ?? false, publishableKey: c.publishableKey ?? "", paymentLinks: c.paymentLinks ?? true, secretKey: secrets.secretKey ?? null, webhookSecret: secrets.webhookSecret ?? null, lastTest: c.lastTest };
}

export async function saveStripeSettings(actorId: string, p: Partial<Omit<StripeSettings, "secretKey" | "webhookSecret">> & { secretKey?: string; webhookSecret?: string }) {
  const cur = await stripeSettings();
  const keyChanged = p.secretKey !== undefined && p.secretKey !== cur.secretKey;
  await save("stripe", actorId, {
    enabled: p.enabled ?? cur.enabled,
    config: { publishableKey: p.publishableKey ?? cur.publishableKey, paymentLinks: p.paymentLinks ?? cur.paymentLinks, lastTest: keyChanged ? undefined : (p.lastTest ?? cur.lastTest) },
    secret: seal(JSON.stringify({ secretKey: p.secretKey ?? cur.secretKey ?? undefined, webhookSecret: p.webhookSecret ?? cur.webhookSecret ?? undefined })),
  });
}

/** "test" or "live", from the key itself */
export const stripeMode = (key: string | null) => (key?.startsWith("sk_live_") || key?.startsWith("rk_live_") ? "live" : key ? "test" : null);

/** Ask Stripe for the account balance with this key: proves the key works; the account's name and id come with it when the key may read them. */
export async function testStripe(secretKey: string): Promise<{ ok: true; mode: "test" | "live"; account: StripeAccount | null } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { ok: true, mode: stripeMode(secretKey) === "live" ? "live" : "test", account: await stripeAccount(secretKey) };
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, error: res.status === 401 ? "invalid_key" : (j.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
  } catch {
    return { ok: false, error: "network" };
  }
}

/** Who the key belongs to; a restricted key without that right gives none (the key still works). */
async function stripeAccount(secretKey: string): Promise<StripeAccount | null> {
  try {
    const res = await fetch("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const a = (await res.json()) as { id?: string; country?: string; business_profile?: { name?: string | null }; settings?: { dashboard?: { display_name?: string | null } } };
    if (!a.id) return null;
    return { id: a.id, name: a.business_profile?.name || a.settings?.dashboard?.display_name || null, country: a.country ?? null };
  } catch {
    return null;
  }
}

// ── QuickBooks Online (OAuth 2, accounting scope) ──
export type QuickBooksSettings = {
  enabled: boolean;
  environment: "sandbox" | "production";
  clientId: string;
  realmId: string | null;
  companyName: string | null;
  connectedAt: string | null;
  sync: { invoices: boolean; payments: boolean; customers: boolean; timesheets: boolean; expenses: boolean };
  /** QuickBooks item and tax codes used for the invoices sent */
  invoice: { itemId: string | null; taxCodeId: string | null; exemptTaxCodeId: string | null };
  /** Payments brought back from QuickBooks up to this time */
  paymentsPulledAt: string | null;
  /** Last imports from QuickBooks (accounts, items) */
  imports: { accounts?: { at: string; matched: number; created: number }; items?: { at: string; items: number; categories: number; products: number } };
  clientSecret: string | null;
  refreshToken: string | null;
  lastTest?: { ok: boolean; at: string; error?: string };
};

export async function quickbooksSettings(): Promise<QuickBooksSettings> {
  const r = await row("quickbooks");
  const c = (r?.config ?? {}) as Partial<QuickBooksSettings>;
  let secrets: { clientSecret?: string; refreshToken?: string } = {};
  try {
    secrets = JSON.parse(unseal(r?.secret) ?? "{}");
  } catch {
    secrets = {};
  }
  return {
    enabled: r?.enabled ?? false,
    environment: c.environment === "production" ? "production" : "sandbox",
    clientId: c.clientId ?? "",
    realmId: c.realmId ?? null,
    companyName: c.companyName ?? null,
    connectedAt: c.connectedAt ?? null,
    sync: { invoices: true, payments: true, customers: true, timesheets: true, expenses: true, ...c.sync },
    invoice: { itemId: null, taxCodeId: null, exemptTaxCodeId: null, ...c.invoice },
    paymentsPulledAt: c.paymentsPulledAt ?? null,
    imports: c.imports ?? {},
    clientSecret: secrets.clientSecret ?? null,
    refreshToken: secrets.refreshToken ?? null,
    lastTest: c.lastTest,
  };
}

export async function saveQuickBooksSettings(actorId: string | null, p: Partial<QuickBooksSettings>) {
  const cur = await quickbooksSettings();
  // another app or company: the connection made with the old one no longer counts
  const reset = (p.clientId !== undefined && p.clientId !== cur.clientId) || (p.environment !== undefined && p.environment !== cur.environment);
  const n = { ...cur, ...p, ...(reset ? { realmId: null, companyName: null, connectedAt: null, refreshToken: null, lastTest: undefined } : {}) };
  await save("quickbooks", actorId, {
    enabled: n.enabled,
    config: {
      environment: n.environment,
      clientId: n.clientId,
      realmId: n.realmId,
      companyName: n.companyName,
      connectedAt: n.connectedAt,
      sync: n.sync,
      lastTest: n.lastTest,
      invoice: n.invoice,
      paymentsPulledAt: n.paymentsPulledAt,
      imports: n.imports,
    },
    secret: seal(JSON.stringify({ clientSecret: n.clientSecret ?? undefined, refreshToken: n.refreshToken ?? undefined })),
  });
}

const QB_AUTH = "https://appcenter.intuit.com/connect/oauth2";
const QB_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const qbApi = (env: QuickBooksSettings["environment"]) => (env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com");

const pending = new Map<string, { userId: string; redirectUri: string; until: number }>();

/** Where Intuit sends the admin back (to register in the Intuit app). */
export const quickbooksRedirectUri = (origin: string) => `${origin.replace(/\/+$/, "")}/api/billing/quickbooks/callback`;

export async function quickbooksConnectUrl(userId: string, redirectUri: string): Promise<string> {
  const s = await quickbooksSettings();
  if (!s.clientId || !s.clientSecret) throw new Error("quickbooks_incomplete");
  const now = Date.now();
  for (const [k, v] of pending) if (v.until < now) pending.delete(k);
  const state = randomBytes(32).toString("base64url");
  pending.set(state, { userId, redirectUri, until: now + 10 * 60_000 });
  const q = new URLSearchParams({ client_id: s.clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state });
  return `${QB_AUTH}?${q}`;
}

export async function qbToken(s: QuickBooksSettings, params: Record<string, string>) {
  const res = await fetch(QB_TOKEN, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${s.clientId}:${s.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as { access_token: string; refresh_token?: string };
}

/** Back from Intuit: same admin, same state, once. The refresh token is kept sealed. */
export async function completeQuickBooks(userId: string, state: string, code: string, realmId: string) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.until < Date.now() || p.userId !== userId) throw new Error("state");
  const s = await quickbooksSettings();
  const t = await qbToken(s, { grant_type: "authorization_code", code, redirect_uri: p.redirectUri });
  const name = await companyName({ ...s, realmId }, t.access_token).catch(() => null);
  await saveQuickBooksSettings(userId, { realmId, refreshToken: t.refresh_token ?? null, companyName: name, connectedAt: new Date().toISOString(), lastTest: { ok: true, at: new Date().toISOString() } });
}

async function companyName(s: QuickBooksSettings, access: string) {
  const res = await fetch(`${qbApi(s.environment)}/v3/company/${encodeURIComponent(s.realmId!)}/companyinfo/${encodeURIComponent(s.realmId!)}?minorversion=70`, {
    headers: { authorization: `Bearer ${access}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { CompanyInfo?: { CompanyName?: string } };
  return j.CompanyInfo?.CompanyName ?? null;
}

/** A fresh access token from the stored refresh token, then the company name: proves the link works. */
export async function testQuickBooks(actorId: string): Promise<{ ok: boolean; error?: string; companyName?: string | null }> {
  const s = await quickbooksSettings();
  if (!s.refreshToken || !s.realmId) return { ok: false, error: "not_connected" };
  const at = new Date().toISOString();
  try {
    const t = await qbToken(s, { grant_type: "refresh_token", refresh_token: s.refreshToken });
    const name = await companyName(s, t.access_token);
    // Intuit rotates refresh tokens: keep the new one
    await saveQuickBooksSettings(actorId, { refreshToken: t.refresh_token ?? s.refreshToken, companyName: name, lastTest: { ok: true, at } });
    return { ok: true, companyName: name };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 200) : "error";
    await saveQuickBooksSettings(actorId, { lastTest: { ok: false, at, error } });
    return { ok: false, error };
  }
}
