import crypto from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";
import { audit } from "./audit.ts";

/**
 * ITCloud (zone.itcloud.ca), the partner API: customers, products and the services report. ITCloud is a vendor:
 * its recurring products become services of the portal (SKU `ITC-<product id>`, cost = what ITCloud charges us),
 * its customers are matched to the portal's clients, and every active service a matched customer has there
 * is kept as a line of that client's contract (quantity included) so the billing follows what is really sold.
 * Nothing is ever written to ITCloud.
 *
 * Authentication: a JWT signed RS256 with the partner's RSA private key (sealed here, never sent back), the
 * integration key (a GUID) as `iss`, valid 10 minutes, scopes customer.read product.read report.read.
 */
export const ITCLOUD_PROVIDER = "itcloud";
export const ITCLOUD_URL = "https://zone.itcloud.ca";
const AUDIENCE = `${ITCLOUD_URL}/api/partner`;
const SCOPES = "customer.read product.read report.read";
export const VENDOR_NAME = "ITCloud";

export class ItcloudError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type SyncResult = {
  at: string;
  ok: boolean;
  error?: string;
  counts?: { services: number; active: number; created: number; updated: number; removed: number; clientUnlinked: number; productUnmatched: number; noContract: number };
};
export type ItcloudSettings = {
  enabled: boolean;
  integrationKey: string | null;
  privateKey: string | null;
  /** The sync runs every 15 minutes by itself (on by default) */
  autoSync: boolean;
  vendorId: string | null;
  lastTest?: { ok: boolean; at: string; error?: string; customers?: number; products?: number };
  lastSync?: SyncResult;
};

export async function itcloudSettings(): Promise<ItcloudSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, ITCLOUD_PROVIDER));
  const c = (row?.config ?? {}) as Partial<ItcloudSettings>;
  return { enabled: row?.enabled ?? false, integrationKey: c.integrationKey ?? null, privateKey: unseal(row?.secret), autoSync: c.autoSync ?? true, vendorId: c.vendorId ?? null, lastTest: c.lastTest, lastSync: c.lastSync };
}

export async function saveItcloudSettings(actorId: string | null, p: Partial<ItcloudSettings>) {
  const next = { ...(await itcloudSettings()), ...p };
  const values = {
    enabled: next.enabled,
    config: { integrationKey: next.integrationKey, autoSync: next.autoSync, vendorId: next.vendorId, lastTest: next.lastTest, lastSync: next.lastSync },
    secret: next.privateKey ? seal(next.privateKey) : null,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: ITCLOUD_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

export const itcloudReady = (s: ItcloudSettings) => s.enabled && Boolean(s.integrationKey && s.privateKey);

/** A PEM that is an RSA private key (PKCS#1 or PKCS#8) */
export function validPrivateKey(pem: string): boolean {
  try {
    return crypto.createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}
export const validIntegrationKey = (k: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k.trim());

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** The bearer token: RS256, iss = integration key, aud = the partner API, 10 minutes */
export function signToken(integrationKey: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: integrationKey, aud: AUDIENCE, iat, exp: iat + 600, scope: SCOPES })}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url");
  return `${head}.${sig}`;
}

async function call<T>(s: ItcloudSettings, path: string): Promise<T> {
  if (!s.integrationKey || !s.privateKey) throw new ItcloudError("itcloud_incomplete");
  const res = await fetch(`${ITCLOUD_URL}${path}`, {
    headers: { authorization: `Bearer ${signToken(s.integrationKey, s.privateKey)}`, "accept-version": "1", accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new ItcloudError("itcloud_rate_limited");
  if (res.status === 401 || res.status === 403) throw new ItcloudError("itcloud_unauthorized");
  if (!res.ok) throw new ItcloudError(`itcloud_http_${res.status}`);
  return (await res.json()) as T;
}

// ── what the API says ──
export type ItCustomer = { clientId: number; clientCode: string; companyName: string; fullName: string; email: string; status: string };
export type ItProduct = {
  productId: number;
  productGroupId: number;
  productGroup: string;
  name: string;
  payType: string;
  isUsageBasedBilling: boolean;
  monthlyUnitPrice: number | null;
  annuallyUnitPrice: number | null;
  billingCycles: string[];
};
export type ItServiceRow = {
  clientId: number;
  clientCompany: string;
  productGroup: string;
  product: string;
  serviceId: number;
  status: string;
  billingCycle: string;
  registrationDate: string;
  nextInvoiceDate: string;
  quantity: number;
  amount: number;
};
export const itcloudCustomers = async (s: ItcloudSettings) => (await call<{ items?: ItCustomer[] }>(s, "/api/partner/customers")).items ?? [];
export const itcloudProducts = async (s: ItcloudSettings) => (await call<{ items?: ItProduct[] }>(s, "/api/partner/products")).items ?? [];
/** One invoiced line: the MSRP ITCloud shows for a product (the only place the API gives it) */
export type ItInvoiceItem = { productId: number; billingCycle: string; unitMsrp: number; invoiceDate: string };
export const itcloudInvoiceItems = async (s: ItcloudSettings, from: string, to: string) => (await call<{ items?: ItInvoiceItem[] }>(s, `/api/partner/invoice-items-report?from=${from}&to=${to}`)).items ?? [];
export const itcloudServicesReport = async (s: ItcloudSettings) => (await call<{ items?: ItServiceRow[] }>(s, "/api/partner/services-report")).items ?? [];

export async function testItcloud(s: ItcloudSettings) {
  try {
    const [customers, products] = [await itcloudCustomers(s), await itcloudProducts(s)];
    return { ok: true as const, customers: customers.length, products: products.length };
  } catch (e) {
    return { ok: false as const, error: e instanceof ItcloudError ? e.code : "itcloud_error" };
  }
}

// ── matching helpers ──
/** "Les Entreprises Tremblay inc." → "entreprises tremblay": accents, case, punctuation and company suffixes ignored */
export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["inc", "ltee", "ltd", "enr", "senc", "sencrl", "cie", "co", "corp", "llc", "le", "la", "les", "l", "the"].includes(w))
    .join(" ");
}
const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
/** Our price when ITCloud gives no MSRP for a product: the cost plus 20 % */
export const MARKUP = 1.2;
/**
 * The MSRP per unit and period of each product, from the latest invoice line that carries one (the last 12
 * months of the invoice items report): the line of the product's own period first (monthly or yearly).
 */
export async function msrpByProduct(s: ItcloudSettings, now = new Date()): Promise<{ map: Map<string, { monthly?: number; yearly?: number }>; error: string | null }> {
  const map = new Map<string, { monthly?: number; yearly?: number }>();
  try {
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
    const items = (await itcloudInvoiceItems(s, from, to)).filter((i) => i.productId && i.unitMsrp > 0).sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : 1));
    // oldest first, so the latest line wins
    for (const i of items) {
      const cur = map.get(String(i.productId)) ?? {};
      if (/^month/i.test(i.billingCycle)) cur.monthly = i.unitMsrp;
      else if (/^(annual|year)/i.test(i.billingCycle)) cur.yearly = i.unitMsrp;
      map.set(String(i.productId), cur);
    }
    return { map, error: null };
  } catch (e) {
    return { map, error: e instanceof ItcloudError ? e.code : "itcloud_error" };
  }
}
/** Portal service kind from the ITCloud product's billing cycles */
export const kindOf = (p: ItProduct): "recurring" | "recurring_yearly" => (p.billingCycles.includes("Monthly") || p.monthlyUnitPrice != null ? "recurring" : "recurring_yearly");
const cents = (n: number | null | undefined) => Math.max(0, Math.round((n ?? 0) * 100));
const isRecurringProduct = (p: ItProduct) => p.payType === "recurring" && !p.isUsageBasedBilling;
const productKey = (group: string, name: string) => `${normName(group)}|${normName(name)}`;

/** The ITCloud vendor of the portal (made the first time it is needed) */
export async function ensureVendor(): Promise<string> {
  const s = await itcloudSettings();
  if (s.vendorId) {
    const [v] = await db().select({ id: schema.vendors.id }).from(schema.vendors).where(eq(schema.vendors.id, s.vendorId));
    if (v) return v.id;
  }
  const [existing] = await db().select({ id: schema.vendors.id }).from(schema.vendors).where(sql`lower(${schema.vendors.name}) = ${VENDOR_NAME.toLowerCase()}`);
  const id = existing?.id ?? (await db().insert(schema.vendors).values({ name: VENDOR_NAME, email: "support@itcloud.ca", phone: "1-877-374-0228", notes: "Fournisseur synchronisé par l'intégration ITCloud." }).returning({ id: schema.vendors.id }))[0].id;
  await saveItcloudSettings(null, { vendorId: id });
  return id;
}

// ── client matching ──
export type ClientRow = {
  itcloudId: number;
  code: string;
  company: string;
  email: string;
  status: string;
  /** The portal client it is tied to */
  clientId: string | null;
  clientName: string | null;
  /** A match to review (only when not tied yet) */
  suggestion: { clientId: string; name: string; reason: "name" | "email" } | null;
};

export async function clientPlan(s: ItcloudSettings): Promise<ClientRow[]> {
  const [customers, clients, contacts, links] = await Promise.all([
    itcloudCustomers(s),
    db().select({ id: schema.clients.id, name: schema.clients.name, email: schema.clients.email, invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.active, true)),
    db().select({ clientId: schema.clientContacts.clientId, email: schema.clientContacts.email }).from(schema.clientContacts).where(eq(schema.clientContacts.active, true)),
    db().select().from(schema.itcloudClients),
  ]);
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const c of clients) byName.set(normName(c.name), [...(byName.get(normName(c.name)) ?? []), { id: c.id, name: c.name }]);
  const byEmail = new Map<string, { id: string; name: string }[]>();
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const addEmail = (e: string | null | undefined, id: string) => {
    const k = normEmail(e);
    if (!k) return;
    const list = byEmail.get(k) ?? [];
    if (!list.some((x) => x.id === id)) byEmail.set(k, [...list, { id, name: nameOf.get(id) ?? "" }]);
  };
  for (const c of clients) {
    addEmail(c.email, c.id);
    addEmail((c.invoice as { billingEmail?: string } | null)?.billingEmail, c.id);
  }
  for (const x of contacts) addEmail(x.email, x.clientId);
  const linked = new Map(links.map((l) => [l.itcloudId, l.clientId]));
  return customers
    .map((c) => {
      const clientId = linked.get(c.clientId) ?? null;
      let suggestion: ClientRow["suggestion"] = null;
      if (!clientId) {
        // only a single, unambiguous match is proposed
        const n = byName.get(normName(c.companyName)) ?? [];
        const e = byEmail.get(normEmail(c.email)) ?? [];
        if (n.length === 1) suggestion = { clientId: n[0].id, name: n[0].name, reason: "name" };
        else if (e.length === 1) suggestion = { clientId: e[0].id, name: e[0].name, reason: "email" };
      }
      return { itcloudId: c.clientId, code: c.clientCode, company: c.companyName, email: c.email, status: c.status, clientId, clientName: clientId ? (nameOf.get(clientId) ?? null) : null, suggestion };
    })
    .sort((a, b) => Number(Boolean(a.clientId)) - Number(Boolean(b.clientId)) || a.company.localeCompare(b.company));
}

/** Tie (or untie, clientId null) ITCloud customers to clients. Returns how many changed. */
export async function applyClientLinks(links: { itcloudId: number; clientId: string | null }[]): Promise<number> {
  let n = 0;
  for (const l of links) {
    if (l.clientId === null) {
      n += (await db().delete(schema.itcloudClients).where(eq(schema.itcloudClients.itcloudId, l.itcloudId)).returning()).length;
      continue;
    }
    const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, l.clientId));
    if (!c) throw new ItcloudError("client_not_found");
    await db().insert(schema.itcloudClients).values({ itcloudId: l.itcloudId, clientId: l.clientId }).onConflictDoUpdate({ target: schema.itcloudClients.itcloudId, set: { clientId: l.clientId } });
    n++;
  }
  return n;
}

// ── product → service matching ──
export type ServiceRowPlan = {
  /** The ITCloud product id, as text: the key to accept */
  key: string;
  productGroup: string;
  name: string;
  kind: "recurring" | "recurring_yearly";
  /** What ITCloud charges us per unit and period */
  costCents: number;
  state: "new" | "update" | "same";
  /** The portal service it is tied to or would be tied to (by SKU, or by the same name) */
  serviceId: string | null;
  serviceName: string | null;
  /** The price of the portal service tied to it, if any */
  priceCents: number | null;
  /** The price a new service would start at: ITCloud's MSRP, else the cost plus 20 % */
  suggestedPriceCents: number;
  priceSource: "msrp" | "markup";
  change: string[];
};

export async function servicePlan(s: ItcloudSettings): Promise<{ rows: ServiceRowPlan[]; ignored: number; msrpError: string | null }> {
  const vendorId = await ensureVendor();
  const products = await itcloudProducts(s);
  const msrp = await msrpByProduct(s);
  const services = await db().select().from(schema.services);
  const byVendorSku = new Map(services.filter((x) => x.vendorId === vendorId && x.vendorSku).map((x) => [x.vendorSku!, x]));
  const byName = new Map<string, typeof services>();
  for (const x of services) if (!x.vendorSku) byName.set(normName(x.name), [...(byName.get(normName(x.name)) ?? []), x]);
  const recurring = products.filter(isRecurringProduct);
  const rows = recurring.map((p) => {
    const key = String(p.productId);
    const kind = kindOf(p);
    const cost = cents(kind === "recurring" ? p.monthlyUnitPrice : p.annuallyUnitPrice);
    const name = p.name;
    let svc = byVendorSku.get(key);
    if (!svc) {
      const same = byName.get(normName(name)) ?? [];
      if (same.length === 1) svc = same[0];
    }
    const change: string[] = [];
    let state: ServiceRowPlan["state"] = "same";
    if (!svc) state = "new";
    else {
      if (svc.vendorSku !== key || svc.vendorId !== vendorId) change.push("link");
      if (svc.costCents !== cost) change.push("cost");
      if (svc.kind !== kind) change.push("kind");
      if (change.length) state = "update";
    }
    const m = msrp.map.get(key);
    const listed = cents(kind === "recurring" ? m?.monthly : m?.yearly);
    const suggestedPriceCents = listed > 0 ? listed : Math.round(cost * MARKUP);
    return { key, productGroup: p.productGroup, name, kind, costCents: cost, state, serviceId: svc?.id ?? null, serviceName: svc?.name ?? null, priceCents: svc?.priceCents ?? null, suggestedPriceCents, priceSource: listed > 0 ? ("msrp" as const) : ("markup" as const), change };
  });
  return { rows: rows.sort((a, b) => a.productGroup.localeCompare(b.productGroup) || a.name.localeCompare(b.name)), ignored: products.length - recurring.length, msrpError: msrp.error };
}

/** Make / update the portal services of the accepted ITCloud products (keys). A new service starts at ITCloud's MSRP (else cost + 20 %); the price is ours to change afterwards and is never overwritten. */
export async function applyServicePlan(s: ItcloudSettings, keys: string[], actorId: string | null): Promise<{ created: number; updated: number }> {
  const { rows } = await servicePlan(s);
  const vendorId = await ensureVendor();
  const want = new Set(keys);
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    if (!want.has(r.key) || r.state === "same") continue;
    if (r.serviceId) {
      const [cur] = await db().select().from(schema.services).where(eq(schema.services.id, r.serviceId));
      const sku = cur.sku ?? `ITC-${r.key}`;
      await db().update(schema.services).set({ vendorId, vendorSku: r.key, sku, costCents: r.costCents, kind: r.kind, updatedAt: new Date() }).where(eq(schema.services.id, r.serviceId));
      updated++;
    } else {
      await db().insert(schema.services).values({ name: r.name, description: r.productGroup, kind: r.kind, priceCents: r.suggestedPriceCents, costCents: r.costCents, sku: `ITC-${r.key}`, vendorId, vendorSku: r.key });
      created++;
    }
  }
  await audit(actorId, "itcloud.services_applied", null, { created, updated });
  return { created, updated };
}

// ── the sync: services report → contract lines ──
const day = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const clamp = (d: string, from: string | null, to: string | null) => (from && d < from ? from : to && d > to ? to : d);

/** The contract that carries a client's vendor services: a monthly one, else the support default, else the first active one */
async function contractFor(clientId: string): Promise<typeof schema.clientContracts.$inferSelect | null> {
  const list = await db().select().from(schema.clientContracts).where(and(eq(schema.clientContracts.clientId, clientId), eq(schema.clientContracts.active, true))).orderBy(asc(schema.clientContracts.name));
  if (!list.length) return null;
  return list.find((k) => k.billingMode === "monthly") ?? list.find((k) => k.supportDefault) ?? list[0];
}

let syncing = false;
export async function syncItcloud(actorId: string | null = null): Promise<SyncResult> {
  const s = await itcloudSettings();
  const at = new Date().toISOString();
  if (!itcloudReady(s)) return { at, ok: false, error: "itcloud_incomplete" };
  if (syncing) return { at, ok: false, error: "itcloud_busy" };
  syncing = true;
  try {
    const vendorId = await ensureVendor();
    const [report, products] = [await itcloudServicesReport(s), await itcloudProducts(s)];
    const now = new Date();
    // the report, kept as is (with what each row is matched to, below)
    const rows = report.map((r) => ({
      serviceId: r.serviceId,
      itcloudClientId: r.clientId,
      clientName: r.clientCompany ?? "",
      productGroup: r.productGroup ?? "",
      product: r.product ?? "",
      status: r.status ?? "",
      billingCycle: r.billingCycle ?? "",
      quantity: Math.max(1, Math.round(r.quantity ?? 1)),
      amountCents: cents(r.amount),
      registrationDate: day(r.registrationDate),
      nextInvoiceDate: day(r.nextInvoiceDate),
      state: "inactive" as string,
      contractName: null as string | null,
      seenAt: now,
    }));
    const [links, svcs] = await Promise.all([db().select().from(schema.itcloudClients), db().select().from(schema.services).where(eq(schema.services.vendorId, vendorId))]);
    const clientOf = new Map(links.map((l) => [l.itcloudId, l.clientId]));
    const svcBySku = new Map(svcs.filter((x) => x.vendorSku).map((x) => [x.vendorSku!, x]));
    const productId = new Map<string, number>();
    const byName = new Map<string, number[]>();
    for (const p of products) {
      productId.set(productKey(p.productGroup, p.name), p.productId);
      byName.set(normName(p.name), [...(byName.get(normName(p.name)) ?? []), p.productId]);
    }
    const counts = { services: rows.length, active: 0, created: 0, updated: 0, removed: 0, clientUnlinked: 0, productUnmatched: 0, noContract: 0 };
    const keep = new Set<string>();
    for (const r of rows) {
      if (r.status.toLowerCase() !== "active") continue;
      counts.active++;
      const clientId = clientOf.get(r.itcloudClientId);
      if (!clientId) {
        counts.clientUnlinked++;
        r.state = "client_unlinked";
        continue;
      }
      const pid = productId.get(productKey(r.productGroup, r.product)) ?? (byName.get(normName(r.product))?.length === 1 ? byName.get(normName(r.product))![0] : undefined);
      const svc = pid !== undefined ? svcBySku.get(String(pid)) : undefined;
      if (!svc) {
        counts.productUnmatched++;
        r.state = "product_unmatched";
        continue;
      }
      const contract = await contractFor(clientId);
      if (!contract) {
        counts.noContract++;
        r.state = "no_contract";
        continue;
      }
      r.state = "synced";
      r.contractName = contract.name;
      const external = String(r.serviceId);
      keep.add(external);
      // what ITCloud charges us per unit
      const unitCost = Math.round(r.amountCents / r.quantity);
      const addedOn = clamp(r.registrationDate ?? now.toISOString().slice(0, 10), contract.startDate, contract.endDate);
      const [cur] = await db().select().from(schema.contractServices).where(and(eq(schema.contractServices.source, "itcloud"), eq(schema.contractServices.externalId, external)));
      if (!cur) {
        await db().insert(schema.contractServices).values({ contractId: contract.id, serviceId: svc.id, name: svc.name, kind: svc.kind, priceCents: svc.priceCents, costCents: unitCost, addedOn, quantity: r.quantity, source: "itcloud", externalId: external });
        counts.created++;
      } else if (cur.contractId !== contract.id || cur.serviceId !== svc.id || cur.quantity !== r.quantity || cur.costCents !== unitCost || cur.kind !== svc.kind) {
        await db().update(schema.contractServices).set({ contractId: contract.id, serviceId: svc.id, name: svc.name, kind: svc.kind, quantity: r.quantity, costCents: unitCost }).where(eq(schema.contractServices.id, cur.id));
        counts.updated++;
      }
    }
    // a service that is no longer active (or no longer matched) at ITCloud leaves the contract
    const gone = await db()
      .select({ id: schema.contractServices.id, externalId: schema.contractServices.externalId })
      .from(schema.contractServices)
      .where(eq(schema.contractServices.source, "itcloud"));
    const goneIds = gone.filter((g) => g.externalId && !keep.has(g.externalId)).map((g) => g.id);
    if (goneIds.length) {
      await db().delete(schema.contractServices).where(inArray(schema.contractServices.id, goneIds));
      counts.removed = goneIds.length;
    }
    // the report, with its states, replaces the last one
    await db().transaction(async (tx) => {
      await tx.delete(schema.itcloudServices);
      if (rows.length) await tx.insert(schema.itcloudServices).values(rows);
    });
    const result: SyncResult = { at, ok: true, counts };
    await saveItcloudSettings(actorId, { lastSync: result });
    await audit(actorId, "itcloud.synced", null, counts);
    return result;
  } catch (e) {
    const result: SyncResult = { at, ok: false, error: e instanceof ItcloudError ? e.code : "itcloud_error" };
    if (!(e instanceof ItcloudError)) console.warn("[itcloud] sync:", e instanceof Error ? e.message : e);
    await saveItcloudSettings(actorId, { lastSync: result }).catch(() => undefined);
    return result;
  } finally {
    syncing = false;
  }
}

/** The services of the last report with what each is matched to (for the review screen) */
export async function serviceStates() {
  const rows = await db().select().from(schema.itcloudServices).orderBy(asc(schema.itcloudServices.clientName), asc(schema.itcloudServices.product));
  return rows.map((r) => ({ ...r, seenAt: r.seenAt.toISOString() }));
}

export async function itcloudTick(): Promise<void> {
  const s = await itcloudSettings();
  if (!itcloudReady(s) || !s.autoSync) return;
  await syncItcloud(null);
}
