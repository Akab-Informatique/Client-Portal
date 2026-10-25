import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { addDays, linkDefaultAccounts, typesById, weekByDayAndType } from "./timesheets.ts";
import { syncAll } from "./qbSync.ts";
import { billingSettings, saveBillingSettings, ledger, qbApi, qbToken, quickbooksSettings, saveQuickBooksSettings, type LedgerType, type QuickBooksSettings } from "./billing.ts";

/**
 * QuickBooks Online, through its API: clients ↔ customers (no doubles),
 * the chart of accounts and the items (categories, SKUs) copied to match,
 * invoices sent, payments brought back onto the invoices.
 */
export class QuickBooksError extends Error {
  constructor(
    public code: "not_connected" | "not_mapped" | "no_item" | "customer_exists" | "voided" | "no_tax_code" | "api" | "no_employee" | "no_account",
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// ── access ──
let token: { value: string; until: number; realmId: string } | null = null;
/** Forget the access token (after a new connection or a disconnection). */
export const forgetQuickBooksToken = () => {
  token = null;
};

async function connected(): Promise<QuickBooksSettings & { realmId: string; refreshToken: string }> {
  const s = await quickbooksSettings();
  if (!s.refreshToken || !s.realmId) throw new QuickBooksError("not_connected");
  return s as QuickBooksSettings & { realmId: string; refreshToken: string };
}

async function accessToken(s: QuickBooksSettings & { realmId: string; refreshToken: string }) {
  if (token && token.realmId === s.realmId && token.until > Date.now() + 60_000) return token.value;
  const t = await qbToken(s, { grant_type: "refresh_token", refresh_token: s.refreshToken }).catch((e) => {
    throw new QuickBooksError("not_connected", e instanceof Error ? e.message : undefined);
  });
  // Intuit rotates refresh tokens: keep the new one
  if (t.refresh_token && t.refresh_token !== s.refreshToken) await saveQuickBooksSettings(null, { refreshToken: t.refresh_token });
  token = { value: t.access_token, until: Date.now() + 50 * 60_000, realmId: s.realmId };
  return token.value;
}

type Fault = { Fault?: { Error?: { Message?: string; Detail?: string }[] } };

export async function qb<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const s = await connected();
  const url = `${qbApi(s.environment)}/v3/company/${encodeURIComponent(s.realmId)}/${path}${path.includes("?") ? "&" : "?"}minorversion=70`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken(s)}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as T & Fault;
  if (!res.ok || j.Fault) {
    if (res.status === 401) forgetQuickBooksToken();
    const e = j.Fault?.Error?.[0];
    throw new QuickBooksError("api", (e?.Detail || e?.Message || `HTTP ${res.status}`).slice(0, 300));
  }
  return j;
}

/** QuickBooks idempotency key: the same creation sent twice (a retry after a timeout) is made once. */
export const requestId = (key: string, body?: unknown) =>
  createHash("sha256")
    .update(key + (body === undefined ? "" : JSON.stringify(body)))
    .digest("hex")
    .slice(0, 36);

/** One push per record at a time (the approval and the background job never send the same thing together). */
const inFlight = new Set<string>();
async function once<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

/** Every row of a query, 1000 at a time. */
export async function query<T>(entity: string, where = ""): Promise<T[]> {
  const out: T[] = [];
  for (let start = 1; ; start += 1000) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults 1000`;
    const r = await qb<{ QueryResponse?: Record<string, T[]> }>("GET", `query?query=${encodeURIComponent(sql)}`);
    const rows = r.QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(inc|ltee|ltd|llc|enr|senc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ── customers ↔ clients ──
export type QbCustomer = { id: string; name: string; email: string | null; phone: string | null; active: boolean };
type RawCustomer = { Id: string; DisplayName: string; CompanyName?: string; PrimaryEmailAddr?: { Address?: string }; PrimaryPhone?: { FreeFormNumber?: string }; Active?: boolean };
const customerOf = (c: RawCustomer): QbCustomer => ({ id: c.Id, name: c.DisplayName, email: c.PrimaryEmailAddr?.Address ?? null, phone: c.PrimaryPhone?.FreeFormNumber ?? null, active: c.Active !== false });

export async function quickbooksCustomers(): Promise<QbCustomer[]> {
  return (await query<RawCustomer>("Customer", "Active = true")).map(customerOf).sort((x, y) => x.name.localeCompare(y.name));
}

/** The likely customer for each unmapped client: same name (or same email), and only one. */
export function suggestions(clients: { id: string; name: string; email: string | null; quickbooksId: string | null }[], customers: QbCustomer[]) {
  const taken = new Set(clients.map((c) => c.quickbooksId).filter(Boolean));
  const out = new Map<string, string>();
  for (const c of clients) {
    if (c.quickbooksId) continue;
    const hits = customers.filter((q) => !taken.has(q.id) && (norm(q.name) === norm(c.name) || (c.email && q.email && q.email.toLowerCase() === c.email.toLowerCase())));
    if (hits.length === 1) out.set(c.id, hits[0].id);
  }
  // never the same customer for two clients
  const count = new Map<string, number>();
  for (const v of out.values()) count.set(v, (count.get(v) ?? 0) + 1);
  for (const [k, v] of out) if ((count.get(v) ?? 0) > 1) out.delete(k);
  return out;
}

/** Why a customer is proposed for a client: the same name, or the same email. */
export const matchReason = (c: { name: string; email: string | null }, q: QbCustomer): "name" | "email" => (norm(q.name) === norm(c.name) ? "name" : "email");

/** The client as a new QuickBooks customer (refused if one has the same name). */
export async function createCustomer(clientId: string): Promise<QbCustomer> {
  const [c] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!c) throw new QuickBooksError("api", "client");
  const same = (await quickbooksCustomers()).find((q) => norm(q.name) === norm(c.name));
  if (same) throw new QuickBooksError("customer_exists", same.id);
  const email = c.invoice?.billingEmail || c.email;
  const r = await qb<{ Customer: RawCustomer }>("POST", `customer?requestid=${requestId(`customer:${clientId}`)}`, {
    DisplayName: c.name.slice(0, 100),
    CompanyName: c.name.slice(0, 100),
    ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    ...(c.address || c.city ? { BillAddr: { Line1: c.address ?? undefined, City: c.city ?? undefined, CountrySubDivisionCode: c.province ?? undefined, PostalCode: c.postalCode ?? undefined, Country: "CA" } } : {}),
  });
  await db().update(schema.clients).set({ quickbooksId: r.Customer.Id, updatedAt: new Date() }).where(eq(schema.clients.id, clientId));
  return customerOf(r.Customer);
}

// ── chart of accounts: proposed, reviewed, then applied ──
type RawAccount = { Id: string; Name: string; AcctNum?: string; Classification?: string; Active?: boolean };
const TYPE_OF: Record<string, LedgerType> = { Asset: "asset", Liability: "liability", Equity: "equity", Revenue: "revenue", Expense: "expense" };

type Change<T> = { from: T; to: T };
export type AccountProposal = {
  /** "qb:<QuickBooks id>" or "local:<portal id>" */
  key: string;
  /** same: nothing to do · link: same account, to tie together · update: tied, but differs · create: only in QuickBooks · deactivate: only in the portal */
  action: "same" | "link" | "update" | "create" | "deactivate";
  reason?: "linked" | "number" | "name";
  qb?: { id: string; number: string | null; name: string; type: LedgerType };
  local?: { id: string; number: string; name: string; type: string; active: boolean };
  changes: { name?: Change<string>; number?: Change<string>; type?: Change<string>; active?: Change<boolean> };
  /** Cannot be applied: an account used by default cannot be turned off */
  blocked?: "in_use";
};

/** What would make the portal's chart the same as QuickBooks' (nothing is changed here). */
export async function planAccounts(actorId: string): Promise<AccountProposal[]> {
  const qbAccounts = (await query<RawAccount>("Account")).filter((a) => a.Active !== false);
  const local = await ledger(actorId);
  const defaults = new Set(Object.values((await billingSettings()).accounts).filter(Boolean));
  const pool = new Set(local.map((l) => l.id));
  const take = (f: (l: (typeof local)[number]) => boolean) => {
    const hit = local.find((l) => pool.has(l.id) && f(l));
    if (hit) pool.delete(hit.id);
    return hit;
  };
  const out: AccountProposal[] = [];
  // first the ones already tied, so a number or a name never steals them
  const tied = new Map(qbAccounts.map((a) => [a.Id, take((l) => l.quickbooksId === a.Id)]));
  for (const a of qbAccounts) {
    const type = TYPE_OF[a.Classification ?? ""] ?? "expense";
    const qb = { id: a.Id, number: a.AcctNum ?? null, name: a.Name, type };
    let reason: AccountProposal["reason"] = "linked";
    let hit = tied.get(a.Id);
    if (!hit && a.AcctNum) ((hit = take((l) => !l.quickbooksId && l.number === a.AcctNum)), (reason = "number"));
    if (!hit) ((hit = take((l) => !l.quickbooksId && norm(l.name) === norm(a.Name))), (reason = "name"));
    if (!hit) {
      const number = a.AcctNum && !local.some((l) => l.number === a.AcctNum) ? a.AcctNum : `QB-${a.Id}`;
      out.push({ key: `qb:${a.Id}`, action: "create", qb, changes: { number: { from: "", to: number } } });
      continue;
    }
    const changes: AccountProposal["changes"] = {};
    if (hit.name !== a.Name) changes.name = { from: hit.name, to: a.Name };
    // QuickBooks' number, unless another account here already has it
    if (a.AcctNum && hit.number !== a.AcctNum && !local.some((l) => l.id !== hit!.id && l.number === a.AcctNum)) changes.number = { from: hit.number, to: a.AcctNum };
    if (hit.type !== type) changes.type = { from: hit.type, to: type };
    if (!hit.active) changes.active = { from: false, to: true };
    const local1 = { id: hit.id, number: hit.number, name: hit.name, type: hit.type, active: hit.active };
    const action = hit.quickbooksId !== a.Id ? "link" : Object.keys(changes).length ? "update" : "same";
    out.push({ key: `qb:${a.Id}`, action, reason, qb, local: local1, changes });
  }
  // only in the portal: turned off (never deleted), unless used by default
  for (const l of local) {
    if (!pool.has(l.id) || !l.active) continue;
    out.push({
      key: `local:${l.id}`,
      action: "deactivate",
      local: { id: l.id, number: l.number, name: l.name, type: l.type, active: l.active },
      changes: { active: { from: true, to: false } },
      ...(defaults.has(l.id) ? { blocked: "in_use" as const } : {}),
    });
  }
  return out;
}

/** Apply the accepted proposals (worked out again now, so nothing stale is applied). */
export async function applyAccounts(actorId: string, accept: string[]) {
  const plan = await planAccounts(actorId);
  const wanted = new Set(accept);
  const d = db();
  const now = new Date();
  const done = { linked: 0, updated: 0, created: 0, deactivated: 0 };
  for (const p of plan) {
    if (!wanted.has(p.key) || p.blocked || p.action === "same") continue;
    if (p.action === "create" && p.qb) {
      const [row] = await d
        .insert(schema.ledgerAccounts)
        .values({ number: p.changes.number!.to, name: p.qb.name, type: p.qb.type, quickbooksId: p.qb.id })
        .onConflictDoNothing()
        .returning({ id: schema.ledgerAccounts.id });
      if (row) done.created++;
    } else if ((p.action === "link" || p.action === "update") && p.qb && p.local) {
      await d
        .update(schema.ledgerAccounts)
        .set({
          quickbooksId: p.qb.id,
          ...(p.changes.name ? { name: p.changes.name.to } : {}),
          ...(p.changes.number ? { number: p.changes.number.to } : {}),
          ...(p.changes.type ? { type: p.changes.type.to } : {}),
          active: true,
          updatedAt: now,
        })
        .where(eq(schema.ledgerAccounts.id, p.local.id));
      if (p.action === "link") done.linked++;
      else done.updated++;
    } else if (p.action === "deactivate" && p.local) {
      await d.update(schema.ledgerAccounts).set({ active: false, updatedAt: now }).where(eq(schema.ledgerAccounts.id, p.local.id));
      done.deactivated++;
    }
  }
  const s = await quickbooksSettings();
  const result = { at: now.toISOString(), matched: plan.filter((p) => p.qb && p.local).length, ...done };
  await saveQuickBooksSettings(actorId, { imports: { ...s.imports, accounts: result } });
  return done;
}

// ── items: categories, products and services (SKU) ──
type RawItem = { Id: string; Name: string; FullyQualifiedName?: string; Sku?: string; Type: string; ParentRef?: { value: string }; IncomeAccountRef?: { value: string }; UnitPrice?: number; Active?: boolean };
const skuKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type ItemProposal = {
  /** "product:<inventory product id>" */
  key: string;
  action: "same" | "link" | "update";
  product: { id: string; sku: string; name: string; category: string | null };
  item: { id: string; name: string; sku: string; category: string | null };
  changes: { category?: Change<string | null>; link?: Change<string | null> };
};
export type ItemsPlan = {
  categories: { id: string; name: string; isNew: boolean; products: number }[];
  items: { total: number; isNew: number };
  products: ItemProposal[];
};

/** QuickBooks categories and items, and the inventory products to tie to them by SKU (nothing changed here). */
export async function planItems(): Promise<ItemsPlan> {
  const items = (await query<RawItem>("Item")).filter((i) => i.Active !== false);
  const known = new Set((await db().select({ id: schema.quickbooksItems.quickbooksId }).from(schema.quickbooksItems)).map((x) => x.id));
  const cats = items.filter((i) => i.Type === "Category");
  const catName = new Map(cats.map((c) => [c.Id, c.FullyQualifiedName || c.Name]));
  const bySku = new Map(items.filter((i) => i.Sku && i.Type !== "Category").map((i) => [skuKey(i.Sku), i]));
  const products = await db()
    .select({ id: schema.storeProducts.id, sku: schema.storeProducts.sku, name: schema.storeProducts.name, category: schema.storeProducts.category, qb: schema.storeProducts.quickbooksItemId })
    .from(schema.storeProducts)
    .where(isNotNull(schema.storeProducts.sku));
  const out: ItemProposal[] = [];
  for (const p of products) {
    const i = bySku.get(skuKey(p.sku));
    if (!i) continue;
    const category = i.ParentRef ? (catName.get(i.ParentRef.value) ?? null) : null;
    const changes: ItemProposal["changes"] = {};
    if (p.qb !== i.Id) changes.link = { from: p.qb, to: i.Id };
    if (category && category !== p.category) changes.category = { from: p.category, to: category };
    out.push({
      key: `product:${p.id}`,
      action: changes.link ? "link" : changes.category ? "update" : "same",
      product: { id: p.id, sku: p.sku!, name: p.name, category: p.category },
      item: { id: i.Id, name: i.FullyQualifiedName || i.Name, sku: i.Sku!, category },
      changes,
    });
  }
  const noncat = items.filter((i) => i.Type !== "Category");
  return {
    categories: cats.map((c) => ({ id: c.Id, name: catName.get(c.Id)!, isNew: !known.has(c.Id), products: noncat.filter((i) => i.ParentRef?.value === c.Id).length })),
    items: { total: noncat.length, isNew: noncat.filter((i) => !known.has(i.Id)).length },
    products: out,
  };
}

/** Copy QuickBooks' categories and items (by their QuickBooks id: never twice), then apply the accepted product changes. */
/** Keep QuickBooks' items in our copy, by their QuickBooks id (never twice). */
async function copyItems(items: RawItem[]) {
  const d = db();
  const now = new Date();
  const known = new Set((await d.select({ id: schema.quickbooksItems.quickbooksId }).from(schema.quickbooksItems)).map((x) => x.id));
  for (const i of items) {
    const values = {
      name: i.FullyQualifiedName || i.Name,
      sku: i.Sku?.trim() || null,
      type: i.Type,
      parentId: i.ParentRef?.value ?? null,
      incomeAccountId: i.IncomeAccountRef?.value ?? null,
      unitPriceCents: i.UnitPrice != null ? Math.round(i.UnitPrice * 100) : null,
      active: i.Active !== false,
      syncedAt: now,
    };
    if (known.has(i.Id)) await d.update(schema.quickbooksItems).set(values).where(eq(schema.quickbooksItems.quickbooksId, i.Id));
    else await d.insert(schema.quickbooksItems).values({ quickbooksId: i.Id, ...values });
  }
}

export async function applyItems(actorId: string, accept: string[]) {
  const items = await query<RawItem>("Item");
  const d = db();
  const now = new Date();
  await copyItems(items);
  const wanted = new Set(accept);
  const plan = await planItems();
  let products = 0;
  for (const p of plan.products) {
    if (!wanted.has(p.key) || p.action === "same") continue;
    await d
      .update(schema.storeProducts)
      .set({ quickbooksItemId: p.item.id, ...(p.changes.category ? { category: p.changes.category.to } : {}), updatedAt: now })
      .where(eq(schema.storeProducts.id, p.product.id));
    products++;
  }
  const result = { at: now.toISOString(), items: items.filter((i) => i.Type !== "Category").length, categories: items.filter((i) => i.Type === "Category").length, products };
  const s = await quickbooksSettings();
  await saveQuickBooksSettings(actorId, { imports: { ...s.imports, items: result } });
  return result;
}

/** Items and tax codes to choose from for the invoices sent. */
export async function invoiceChoices() {
  type RawTax = { Id: string; Name: string; Description?: string; Active?: boolean };
  // the items are read from QuickBooks when the copy is empty or more than 10 minutes old (so a new item shows up)
  const [latest] = await db().select({ at: schema.quickbooksItems.syncedAt }).from(schema.quickbooksItems).orderBy(desc(schema.quickbooksItems.syncedAt)).limit(1);
  if (!latest || Date.now() - latest.at.getTime() > 10 * 60_000) await copyItems(await query<RawItem>("Item")).catch(() => undefined);
  const [items, taxes] = await Promise.all([
    db().select().from(schema.quickbooksItems).where(and(eq(schema.quickbooksItems.active, true), inArray(schema.quickbooksItems.type, ["Service", "NonInventory", "Inventory"]))),
    query<RawTax>("TaxCode").catch(() => [] as RawTax[]),
  ]);
  return {
    items: items.map((i) => ({ id: i.quickbooksId, name: i.name, sku: i.sku, type: i.type })).sort((x, y) => x.name.localeCompare(y.name)),
    taxCodes: taxes.filter((x) => x.Active !== false).map((x) => ({ id: x.Id, name: x.Name, description: x.Description ?? null })),
  };
}

/**
 * The GST/QST and the exempt tax code of the company, found in QuickBooks by their names when the settings of
 * Admin › Intégrations › QuickBooks have none (QuickBooks Canada refuses a line with no code). Read at most every 10 minutes.
 */
let autoCodes: { at: number; taxable: string | null; exempt: string | null } | null = null;
export async function autoTaxCodes(): Promise<{ taxable: string | null; exempt: string | null }> {
  if (autoCodes && Date.now() - autoCodes.at < 10 * 60_000) return autoCodes;
  const all = (await query<{ Id: string; Name: string; Active?: boolean; Taxable?: boolean }>("TaxCode").catch(() => [])).filter((x) => x.Active !== false);
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const hit = all.find((x) => re.test(x.Name));
      if (hit) return hit.Id;
    }
    return null;
  };
  autoCodes = {
    at: Date.now(),
    taxable: find(/(tps|gst).*(tvq|qst)/i, /tps|gst/i),
    exempt: find(/exon|exempt/i, /d[ée]tax|zero|z[ée]ro/i, /^non$/i, /aucune|out of scope/i),
  };
  return autoCodes;
}

/**
 * A new item for invoice lines: made as a service in the portal (Inventory › Services, one time) and in QuickBooks
 * (a Service item on the income account of the default charges account), and kept in our copy of the items.
 * One that already exists (same name) is used, never doubled.
 */
export async function createQbItem(p: { name: string; sku?: string | null; priceCents?: number | null }): Promise<{ id: string; name: string; created: boolean }> {
  const d = db();
  const name = p.name.replace(/[:\t\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!name) throw new QuickBooksError("api", "name");
  const sku = p.sku?.trim() || null;
  const [have] = await d.select().from(schema.quickbooksItems).where(and(eq(schema.quickbooksItems.active, true), ilike(schema.quickbooksItems.name, name))).limit(1);
  let qbId = have?.quickbooksId ?? null;
  let created = false;
  if (!qbId) {
    await linkDefaultAccounts();
    const bs = await billingSettings();
    const accounts = await d.select().from(schema.ledgerAccounts);
    // the income account: the default charges account, else labour, else any revenue account tied to QuickBooks
    const income =
      [bs.accounts.charges, bs.accounts.labour].map((id) => accounts.find((a) => a.id === id)?.quickbooksId).find(Boolean) ?? accounts.find((a) => a.type === "revenue" && a.active && a.quickbooksId)?.quickbooksId;
    if (!income) throw new QuickBooksError("no_account", "income");
    const body = { Name: name, Type: "Service", IncomeAccountRef: { value: income }, Taxable: true, ...(sku ? { Sku: sku } : {}), ...(p.priceCents ? { UnitPrice: dollars(p.priceCents) } : {}) };
    try {
      const r = await qb<{ Item: RawItem }>("POST", `item?requestid=${requestId(`item:${name.toLowerCase()}`, body)}`, body);
      await copyItems([r.Item]);
      qbId = r.Item.Id;
      created = true;
    } catch (e) {
      // the name is already taken in QuickBooks (an inactive or not yet copied item): that one is used
      const again = (await query<RawItem>("Item", `Name = '${name.replace(/'/g, "\\'")}'`))[0];
      if (!again) throw e;
      await copyItems([again]);
      qbId = again.Id;
    }
  }
  // the same item in the portal's services (no doubles by name)
  const [svc] = await d.select({ id: schema.services.id, q: schema.services.quickbooksItemId }).from(schema.services).where(ilike(schema.services.name, name)).limit(1);
  if (!svc) await d.insert(schema.services).values({ name, kind: "one_time", priceCents: p.priceCents ?? 0, sku: sku && !(await d.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.sku, sku)).limit(1)).length ? sku : null, quickbooksItemId: qbId });
  else if (!svc.q) await d.update(schema.services).set({ quickbooksItemId: qbId, updatedAt: new Date() }).where(eq(schema.services.id, svc.id));
  return { id: qbId, name, created };
}

/**
 * The QuickBooks item each line of work goes on, line by line: the item tied to its **portal service** (the service of
 * a contract line; made in QuickBooks, with the same name, when it does not exist yet) or to its **inventory product**
 * (a charge). A line with no service or product gets none here (the invoice's or the default item is used). Nothing
 * happens when QuickBooks is not connected. Returns billing item id → QuickBooks item id.
 */
export async function qbItemsForBillingItems(items: { id: string; sourceId: string | null; description?: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const s = await quickbooksSettings();
  if (!s.refreshToken || !s.realmId || !items.length) return out;
  const d = db();
  // our copy of QuickBooks' items is looked at fresh (a new item shows up)
  await invoiceChoices().catch(() => undefined);
  const copy = await d.select().from(schema.quickbooksItems).where(and(eq(schema.quickbooksItems.active, true), inArray(schema.quickbooksItems.type, ["Service", "NonInventory", "Inventory"])));
  const byName = new Map(copy.map((i) => [norm(i.name), i.quickbooksId]));
  const bySku = new Map(copy.filter((i) => i.sku).map((i) => [skuKey(i.sku), i.quickbooksId]));
  for (const it of items) {
    try {
      const src = it.sourceId ?? "";
      // a recurring contract line: its service
      if (src.startsWith("contract:")) {
        const serviceRowId = src.split(":")[2];
        const [row] = serviceRowId ? await d.select().from(schema.contractServices).where(eq(schema.contractServices.id, serviceRowId)) : [];
        if (!row) continue;
        const [svc] = row.serviceId ? await d.select().from(schema.services).where(eq(schema.services.id, row.serviceId)) : [];
        let id = svc?.quickbooksItemId ?? bySku.get(skuKey(svc?.sku)) ?? byName.get(norm(row.name)) ?? null;
        if (!id) id = (await createQbItem({ name: row.name, sku: svc?.sku ?? null, priceCents: row.priceCents })).id;
        if (svc && svc.quickbooksItemId !== id) await d.update(schema.services).set({ quickbooksItemId: id, updatedAt: new Date() }).where(eq(schema.services.id, svc.id));
        out.set(it.id, id);
        continue;
      }
      // a charge on a ticket: its inventory product
      if (src.startsWith("pcharge:")) {
        const [charge] = await d.select({ productId: schema.ticketCharges.productId }).from(schema.ticketCharges).where(eq(schema.ticketCharges.id, src.slice("pcharge:".length)));
        if (!charge?.productId || !/^[0-9a-f-]{36}$/.test(charge.productId)) continue;
        const [p] = await d.select().from(schema.storeProducts).where(eq(schema.storeProducts.id, charge.productId));
        if (!p) continue;
        const id = p.quickbooksItemId ?? bySku.get(skuKey(p.sku)) ?? null;
        if (id) {
          if (p.quickbooksItemId !== id) await d.update(schema.storeProducts).set({ quickbooksItemId: id, updatedAt: new Date() }).where(eq(schema.storeProducts.id, p.id));
          out.set(it.id, id);
        }
      }
    } catch (e) {
      console.warn("[quickbooks] item for a line:", e instanceof Error ? e.message : e);
    }
  }
  return out;
}

// ── invoices ──
const dollars = (cents: number) => Math.round(cents) / 100;

/**
 * Void an invoice in QuickBooks (its amounts go to 0, it stays on record, marked voided). One already voided, or gone, is
 * fine. Any other answer of QuickBooks is an error: the portal then leaves the invoice as it is.
 */
export async function voidInvoiceInQb(quickbooksId: string): Promise<void> {
  let cur: { Invoice: { Id: string; SyncToken: string; PrivateNote?: string } };
  try {
    cur = await qb("GET", `invoice/${encodeURIComponent(quickbooksId)}`);
  } catch (e) {
    // no longer there: nothing to void
    if (e instanceof QuickBooksError && /not found|object not found|stale|does not exist/i.test(e.detail ?? "")) return;
    throw e;
  }
  if (/^voided/i.test(cur.Invoice.PrivateNote ?? "")) return;
  await qb("POST", "invoice?operation=void", { Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken });
}

/** Send one invoice (or its changes) to QuickBooks. The client must be mapped to a customer. */
export async function pushInvoice(invoiceId: string): Promise<{ quickbooksId: string; warning?: string }> {
  const r = await once(`invoice:${invoiceId}`, () => pushInvoiceNow(invoiceId));
  if (!r) throw new QuickBooksError("api", "busy");
  return r;
}
async function pushInvoiceNow(invoiceId: string): Promise<{ quickbooksId: string; warning?: string }> {
  const d = db();
  const [inv] = await d.select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv) throw new QuickBooksError("api", "invoice");
  const fail = async (e: unknown) => {
    const msg = e instanceof QuickBooksError ? (e.detail ? `${e.code}: ${e.detail}` : e.code) : e instanceof Error ? e.message : String(e);
    await d.update(schema.clientInvoices).set({ quickbooksError: msg.slice(0, 300) }).where(eq(schema.clientInvoices.id, inv.id));
    throw e;
  };
  try {
    // a voided invoice is not sent (void it in QuickBooks too if it was sent before)
    if (inv.voided) throw new QuickBooksError("voided");
    const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, inv.clientId));
    if (!client?.quickbooksId) throw new QuickBooksError("not_mapped", client?.name);
    const s = await quickbooksSettings();
    // the item and tax code chosen on this invoice, else the defaults
    const itemId = inv.qbItemId || s.invoice.itemId;
    const exempt = client.invoice?.taxes === false;
    // a code the settings do not give is looked for in QuickBooks by its name
    const auto = !s.invoice.taxCodeId || !s.invoice.exemptTaxCodeId ? await autoTaxCodes() : { taxable: null, exempt: null };
    const exemptCode = s.invoice.exemptTaxCodeId || auto.exempt;
    const taxCode = exempt ? exemptCode : inv.qbTaxCodeId || s.invoice.taxCodeId || auto.taxable;
    const subtotal = dollars(inv.totalCents - inv.taxCents);
    const own = await d.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.position));
    // a line with no item yet (the invoice was made before one was chosen): the item of its portal service or product, made if needed
    const missing = own.filter((l) => !l.qbItemId && l.billingItemId);
    if (missing.length) {
      const found = await qbItemsForBillingItems((await d.select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId }).from(schema.billingItems).where(inArray(schema.billingItems.id, missing.map((l) => l.billingItemId!)))));
      for (const l of missing) {
        const id = found.get(l.billingItemId!);
        if (id) {
          l.qbItemId = id;
          await d.update(schema.invoiceLines).set({ qbItemId: id }).where(eq(schema.invoiceLines.id, l.id));
        }
      }
    }
    // every line needs an item: its own, else the invoice's, else the default; the error says which line has none
    const noItem = own.find((l) => !l.qbItemId && !itemId);
    if (noItem) throw new QuickBooksError("no_item", noItem.description.slice(0, 120));
    if (!own.length && !itemId) throw new QuickBooksError("no_item");
    // QuickBooks Canada refuses a line with no GST/HST code: say which one before asking
    const noCode = own.find((l) => !(exempt || !l.taxable ? exemptCode : l.qbTaxCodeId || taxCode));
    if (noCode) throw new QuickBooksError("no_tax_code", noCode.description.slice(0, 120));
    if (!own.length && !taxCode) throw new QuickBooksError("no_tax_code");
    // each line: its own item and tax code, else the invoice's, else the defaults
    const lineOf = (description: string, amount: number, qty: number, unit: number, taxed: boolean, own?: { qbItemId: string | null; qbTaxCodeId: string | null }) => {
      const code = taxed ? (exempt ? exemptCode : own?.qbTaxCodeId || taxCode) : exemptCode;
      return {
        DetailType: "SalesItemLineDetail",
        Amount: amount,
        Description: description.slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: (own?.qbItemId || itemId)! }, Qty: qty, UnitPrice: unit, ...(code ? { TaxCodeRef: { value: code } } : {}) },
      };
    };
    const body = {
      DocNumber: inv.number.slice(0, 21),
      TxnDate: inv.issuedOn,
      ...(inv.dueOn ? { DueDate: inv.dueOn } : {}),
      CustomerRef: { value: client.quickbooksId },
      GlobalTaxCalculation: "TaxExcluded",
      ...(inv.notes ? { CustomerMemo: { value: inv.notes.slice(0, 1000) } } : {}),
      ...(inv.poNumber ? { PrivateNote: `PO ${inv.poNumber}` } : {}),
      ...(client.invoice?.billingEmail ? { BillEmail: { Address: client.invoice.billingEmail } } : {}),
      Line: own.length
        ? own.map((l) => lineOf(l.description, dollars(l.amountCents), l.quantityX100 / 100, dollars(l.unitPriceCents), l.taxable, l))
        : [lineOf(`Facture ${inv.number}`, subtotal, 1, subtotal, true)],
    };
    type Saved = { Invoice: { Id: string; TotalAmt?: number; TxnTaxDetail?: { TotalTax?: number } } };
    let saved: Saved | null = null;
    let id = inv.quickbooksId;
    if (id) {
      // changes: the current version (SyncToken) is required
      const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(id)}`);
      saved = await qb<Saved>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true });
      id = saved.Invoice.Id;
    } else {
      // already in QuickBooks under the same number (sent by hand before): linked, not doubled
      const docNumber = inv.number.slice(0, 21).replace(/[^A-Za-z0-9.-]/g, "");
      const same = docNumber ? await query<{ Id: string; CustomerRef?: { value: string } }>("Invoice", `DocNumber = '${docNumber}'`) : [];
      const mine = same.find((x) => x.CustomerRef?.value === client.quickbooksId);
      if (mine) {
        const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(mine.Id)}`);
        saved = await qb<Saved>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true });
        id = saved.Invoice.Id;
      } else {
        saved = await qb<Saved>("POST", `invoice?requestid=${requestId(`invoice:${inv.id}`, body)}`, body);
        id = saved.Invoice.Id;
      }
    }
    // the total (and the tax) QuickBooks worked out must be the portal's: a difference is shown on the invoice, never silent
    const sent = saved?.Invoice;
    const diff = sent?.TotalAmt != null ? Math.round(sent.TotalAmt * 100) - inv.totalCents : 0;
    const taxDiff = sent?.TxnTaxDetail?.TotalTax != null ? Math.round(sent.TxnTaxDetail.TotalTax * 100) - inv.taxCents : 0;
    const mismatch = diff !== 0 || taxDiff !== 0 ? `total_mismatch: portail ${(inv.totalCents / 100).toFixed(2)} $ (taxes ${(inv.taxCents / 100).toFixed(2)} $), QuickBooks ${(sent!.TotalAmt ?? 0).toFixed(2)} $ (taxes ${(sent?.TxnTaxDetail?.TotalTax ?? 0).toFixed(2)} $) — vérifier le code de taxe` : null;
    await d.update(schema.clientInvoices).set({ quickbooksId: id, quickbooksSyncedAt: new Date(), quickbooksError: mismatch }).where(eq(schema.clientInvoices.id, inv.id));
    return { quickbooksId: id, ...(mismatch ? { warning: mismatch } : {}) };
  } catch (e) {
    return fail(e);
  }
}

// ── payments: QuickBooks → portal ──
type RawPayment = { Id: string; TxnDate: string; PaymentRefNum?: string; PaymentMethodRef?: { name?: string }; PrivateNote?: string; Line?: { Amount: number; LinkedTxn?: { TxnId: string; TxnType: string }[] }[]; MetaData?: { LastUpdatedTime?: string } };

/** Payments made or changed in QuickBooks since the last time, put on their invoices. */
export async function pullPayments(actorId: string | null, from?: string) {
  const s = await quickbooksSettings();
  const since = from ?? s.paymentsPulledAt ?? new Date(Date.now() - 365 * 86_400_000).toISOString();
  const started = new Date().toISOString();
  const rows = await query<RawPayment>("Payment", `MetaData.LastUpdatedTime >= '${since}'`);
  const d = db();
  const invoices = new Map(
    (await d.select({ id: schema.clientInvoices.id, qb: schema.clientInvoices.quickbooksId }).from(schema.clientInvoices).where(isNotNull(schema.clientInvoices.quickbooksId))).map((x) => [x.qb!, x.id]),
  );
  let added = 0;
  let updated = 0;
  for (const p of rows) {
    for (const line of p.Line ?? []) {
      for (const link of line.LinkedTxn ?? []) {
        if (link.TxnType !== "Invoice") continue;
        const invoiceId = invoices.get(link.TxnId);
        if (!invoiceId) continue;
        const externalId = `${p.Id}:${link.TxnId}`;
        const values = {
          invoiceId,
          amountCents: Math.round(line.Amount * 100),
          paidOn: p.TxnDate,
          method: /ch[eè]que|check/i.test(p.PaymentMethodRef?.name ?? "") ? "cheque" : /visa|master|card|carte/i.test(p.PaymentMethodRef?.name ?? "") ? "card" : /cash|comptant/i.test(p.PaymentMethodRef?.name ?? "") ? "cash" : "transfer",
          reference: p.PaymentRefNum ?? null,
          note: p.PrivateNote?.slice(0, 500) ?? null,
          source: "quickbooks",
        };
        const [hit] = await d.select({ id: schema.invoicePayments.id, a: schema.invoicePayments.amountCents, on: schema.invoicePayments.paidOn }).from(schema.invoicePayments).where(eq(schema.invoicePayments.externalId, externalId));
        if (!hit) {
          await d.insert(schema.invoicePayments).values({ ...values, externalId });
          added++;
        } else if (hit.a !== values.amountCents || hit.on !== values.paidOn) {
          await d.update(schema.invoicePayments).set(values).where(eq(schema.invoicePayments.id, hit.id));
          updated++;
        }
      }
    }
  }
  await saveQuickBooksSettings(actorId, { paymentsPulledAt: started });
  return { added, updated, at: started };
}

// ── invoices: QuickBooks → portal ──
type RawInvoice = {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  CustomerRef?: { value: string };
  TxnTaxDetail?: { TotalTax?: number };
  Line?: { Amount?: number; Description?: string; DetailType?: string; SalesItemLineDetail?: { Qty?: number; UnitPrice?: number; TaxCodeRef?: { value?: string }; ItemRef?: { name?: string } } }[];
  MetaData?: { LastUpdatedTime?: string };
};
const cents0 = (v: number | undefined) => Math.round((v ?? 0) * 100);
/** QuickBooks keeps a voided invoice with its amount at zero and "Voided" in its note. */
const isVoided = (r: RawInvoice) => /^voided/i.test(r.PrivateNote ?? "") || (cents0(r.TotalAmt) === 0 && cents0(r.Balance) === 0 && (r.Line ?? []).some((l) => l.DetailType === "SalesItemLineDetail" && (l.Description ?? "").toLowerCase().includes("voided")));
const numberOf = (doc: string | undefined) => {
  const n = Number((doc ?? "").replace(/\D/g, ""));
  return (doc ?? "").replace(/\D/g, "") !== "" && Number.isFinite(n) ? n : null;
};

/**
 * The invoices of QuickBooks from the chosen number on (10000 by default), with their status (balance, paid,
 * voided), for the clients mapped to a customer. One invoice = one row, found by its QuickBooks id (or, for one
 * the portal sent, by its number). What QuickBooks says is paid and not yet seen as a payment is recorded as a
 * payment of source quickbooks (`bal:<id>`), so the portal's status is the same as QuickBooks'.
 */
/** The QuickBooks invoices the chosen start brings in: from an invoice number on, or from a day on */
async function invoicesToPull(s: QuickBooksSettings): Promise<RawInvoice[]> {
  if (s.invoicesMode === "date" && s.invoicesFromDate) return query<RawInvoice>("Invoice", `TxnDate >= '${s.invoicesFromDate}'`);
  return (await query<RawInvoice>("Invoice")).filter((r) => (numberOf(r.DocNumber) ?? -1) >= s.invoicesFromNumber);
}

/** What the chosen start would bring in (nothing is copied): how many, from which number to which, how many for clients not mapped yet */
export async function previewInvoices() {
  const s = await quickbooksSettings();
  const rows = await invoicesToPull(s);
  const mapped = new Set((await db().select({ qb: schema.clients.quickbooksId }).from(schema.clients).where(isNotNull(schema.clients.quickbooksId))).map((x) => x.qb));
  const numbers = rows.map((r) => numberOf(r.DocNumber)).filter((n): n is number => n !== null);
  return {
    total: rows.length,
    unmapped: rows.filter((r) => !mapped.has(r.CustomerRef?.value ?? "")).length,
    firstNumber: numbers.length ? Math.min(...numbers) : null,
    lastNumber: numbers.length ? Math.max(...numbers) : null,
    firstDate: rows.map((r) => r.TxnDate).sort()[0] ?? null,
  };
}

/**
 * The invoice number QuickBooks will give next (its highest number + 1) and the portal's. The portal's numbering is
 * raised to QuickBooks' when it is behind (never lowered), so an invoice made here never takes a number QuickBooks
 * already has. Looked at again at most every 2 minutes unless forced.
 */
let numberingSeen: { at: number; qbNext: number } | null = null;
export async function alignNumbering(force = false, actorId: string | null = null): Promise<{ portalNext: number; qbNext: number; qbHighest: number; raised: boolean }> {
  const bs = await billingSettings();
  if (!force && numberingSeen && Date.now() - numberingSeen.at < 120_000) return { portalNext: bs.numbering.next, qbNext: numberingSeen.qbNext, qbHighest: numberingSeen.qbNext - 1, raised: false };
  const all = await query<RawInvoice>("Invoice");
  const highest = all.reduce((m, r) => Math.max(m, numberOf(r.DocNumber) ?? 0), 0);
  numberingSeen = { at: Date.now(), qbNext: highest + 1 };
  let raised = false;
  let next = bs.numbering.next;
  if (highest + 1 > next) {
    await saveBillingSettings(actorId, { numbering: { next: highest + 1 } });
    next = highest + 1;
    raised = true;
  }
  return { portalNext: next, qbNext: highest + 1, qbHighest: highest, raised };
}

/** Where the two numberings stand (nothing is changed): equal, the portal behind (it will be raised) or ahead (invoices not sent yet) */
export async function numberingStatus() {
  const bs = await billingSettings();
  const all = await query<RawInvoice>("Invoice");
  const highest = all.reduce((m, r) => Math.max(m, numberOf(r.DocNumber) ?? 0), 0);
  const portalNext = bs.numbering.next;
  return { portalNext, qbNext: highest + 1, qbHighest: highest, status: portalNext === highest + 1 ? "aligned" : portalNext < highest + 1 ? "behind" : "ahead" } as const;
}

export async function pullInvoices(actorId: string | null) {
  const s = await quickbooksSettings();
  const rows = await invoicesToPull(s);
  const d = db();
  const clients = new Map((await d.select({ id: schema.clients.id, qb: schema.clients.quickbooksId }).from(schema.clients).where(isNotNull(schema.clients.quickbooksId))).map((x) => [x.qb!, x.id]));
  const existing = await d.select().from(schema.clientInvoices);
  const byQb = new Map(existing.filter((v) => v.quickbooksId).map((v) => [v.quickbooksId!, v]));
  const byNumber = new Map(existing.filter((v) => !v.quickbooksId).map((v) => [`${v.clientId}|${v.number}`, v]));
  const now = new Date();
  let added = 0;
  let updated = 0;
  let unmapped = 0;
  for (const r of rows) {
    const clientId = clients.get(r.CustomerRef?.value ?? "");
    if (!clientId) {
      unmapped++;
      continue;
    }
    const voided = isVoided(r);
    const total = cents0(r.TotalAmt);
    const balance = voided ? 0 : cents0(r.Balance);
    const number = r.DocNumber ?? r.Id;
    const updatedOn = (r.MetaData?.LastUpdatedTime ?? now.toISOString()).slice(0, 10);
    let hit = byQb.get(r.Id) ?? byNumber.get(`${clientId}|${number}`);
    let id: string;
    if (!hit) {
      const [row] = await d
        .insert(schema.clientInvoices)
        .values({
          clientId,
          number,
          issuedOn: r.TxnDate,
          dueOn: r.DueDate ?? null,
          totalCents: total,
          taxCents: cents0(r.TxnTaxDetail?.TotalTax),
          paidOn: !voided && total > 0 && balance === 0 ? updatedOn : null,
          voided,
          source: "quickbooks",
          quickbooksId: r.Id,
          quickbooksSyncedAt: now,
          syncedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.clientInvoices.id });
      if (!row) continue;
      id = row.id;
      added++;
    } else {
      id = hit.id;
      const own = hit.source === "portal";
      // an invoice the portal made keeps its own lines and totals; the rest follows QuickBooks
      await d
        .update(schema.clientInvoices)
        .set({
          quickbooksId: r.Id,
          quickbooksSyncedAt: now,
          quickbooksError: null,
          voided,
          paidOn: !voided && total > 0 && balance === 0 ? (hit.paidOn ?? updatedOn) : null,
          ...(own ? {} : { number, issuedOn: r.TxnDate, dueOn: r.DueDate ?? null, totalCents: total, taxCents: cents0(r.TxnTaxDetail?.TotalTax) }),
          updatedAt: now,
        })
        .where(eq(schema.clientInvoices.id, id));
      updated++;
    }
    // the lines of an invoice that comes from QuickBooks
    if (!hit || hit.source !== "portal") {
      const lines = (r.Line ?? []).filter((l) => l.DetailType === "SalesItemLineDetail");
      await d.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id));
      if (lines.length) {
        await d.insert(schema.invoiceLines).values(
          lines.map((l, position) => {
            const qty = l.SalesItemLineDetail?.Qty ?? 1;
            return {
              invoiceId: id,
              kind: "charge",
              description: (l.Description || l.SalesItemLineDetail?.ItemRef?.name || "—").slice(0, 2000),
              quantityX100: Math.round(qty * 100),
              unitPriceCents: cents0(l.SalesItemLineDetail?.UnitPrice),
              amountCents: cents0(l.Amount),
              taxable: Boolean(l.SalesItemLineDetail?.TaxCodeRef?.value && l.SalesItemLineDetail.TaxCodeRef.value !== "NON"),
              position,
            };
          }),
        );
      }
    }
    // the status: what QuickBooks says is paid, minus the payments already known, as one adjusting payment
    const synthetic = `bal:${r.Id}`;
    const payments = await d.select().from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, id));
    const others = payments.filter((p) => p.externalId !== synthetic).reduce((x, p) => x + p.amountCents, 0);
    const missing = voided ? 0 : total - balance - others;
    const mine = payments.find((p) => p.externalId === synthetic);
    if (missing > 0) {
      if (!mine) await d.insert(schema.invoicePayments).values({ invoiceId: id, amountCents: missing, paidOn: updatedOn, method: "transfer", note: "QuickBooks", source: "quickbooks", externalId: synthetic });
      else if (mine.amountCents !== missing) await d.update(schema.invoicePayments).set({ amountCents: missing }).where(eq(schema.invoicePayments.id, mine.id));
    } else if (mine) {
      await d.delete(schema.invoicePayments).where(eq(schema.invoicePayments.id, mine.id));
    }
  }
  const result = { at: now.toISOString(), added, updated, unmapped, total: rows.length };
  await saveQuickBooksSettings(actorId, { imports: { ...s.imports, invoices: result } });
  // the next number here is never behind QuickBooks'
  await alignNumbering(true, actorId).catch((e) => console.warn("[quickbooks] numbering:", errText(e)));
  return result;
}

// ── vendors (read-only: the portal's vendors are mapped to them by hand, never synced) ──
export type QbVendor = { id: string; name: string; email: string | null; phone: string | null };
export async function quickbooksVendors(): Promise<QbVendor[]> {
  const rows = await query<{ Id: string; DisplayName: string; PrimaryEmailAddr?: { Address?: string }; PrimaryPhone?: { FreeFormNumber?: string } }>("Vendor", "Active = true");
  return rows.map((v) => ({ id: v.Id, name: v.DisplayName, email: v.PrimaryEmailAddr?.Address ?? null, phone: v.PrimaryPhone?.FreeFormNumber ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}

// ── employees (timesheets, expenses) ──
type RawEmployee = { Id: string; DisplayName?: string; GivenName?: string; FamilyName?: string; PrimaryEmailAddr?: { Address?: string }; Active?: boolean };

/** The QuickBooks employee of a portal user: kept once found (same email, else same name). */
async function employeeOf(userId: string): Promise<string> {
  const d = db();
  const [u] = await d.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new QuickBooksError("no_employee");
  if (u.quickbooksEmployeeId) return u.quickbooksEmployeeId;
  const all = (await query<RawEmployee>("Employee")).filter((e) => e.Active !== false);
  const emails = [u.email, u.o365Email].filter(Boolean).map((x) => x!.toLowerCase());
  const hit =
    all.find((e) => e.PrimaryEmailAddr?.Address && emails.includes(e.PrimaryEmailAddr.Address.toLowerCase())) ??
    all.filter((e) => norm(e.DisplayName ?? `${e.GivenName ?? ""} ${e.FamilyName ?? ""}`) === norm(u.name)).at(0);
  if (!hit) throw new QuickBooksError("no_employee", u.name);
  await d.update(schema.users).set({ quickbooksEmployeeId: hit.Id }).where(eq(schema.users.id, u.id));
  return hit.Id;
}

/** An approved week as QuickBooks time activities (one per day and type). Sent once. */
export async function pushTimesheet(id: string) {
  await once(`timesheet:${id}`, () => pushTimesheetNow(id));
}
async function pushTimesheetNow(id: string) {
  const d = db();
  const [sheet] = await d.select().from(schema.timesheets).where(eq(schema.timesheets.id, id));
  if (!sheet || sheet.status !== "approved" || sheet.quickbooksSyncedAt) return;
  try {
    const employee = await employeeOf(sheet.userId);
    const s = await quickbooksSettings();
    const rows = await weekByDayAndType(sheet.userId, sheet.weekStart);
    const types = await typesById([...new Set(rows.map((r) => r.typeId))]);
    for (const r of rows) {
      const minutes = Math.round(r.hoursX100 * 0.6);
      const item = types.get(r.typeId)?.quickbooksItemId ?? s.invoice.itemId;
      // the same day and kind is never sent twice, even after a partial failure
      await qb("POST", `timeactivity?requestid=${requestId(`timesheet:${id}:${r.date}:${r.typeId}`)}`, {
        NameOf: "Employee",
        EmployeeRef: { value: employee },
        TxnDate: r.date,
        Hours: Math.floor(minutes / 60),
        Minutes: minutes % 60,
        BillableStatus: "NotBillable",
        Description: `Feuille de temps ${sheet.weekStart} → ${addDays(sheet.weekStart, 6)} — ${r.type}`,
        ...(item ? { ItemRef: { value: item } } : {}),
      });
    }
    await d.update(schema.timesheets).set({ quickbooksSyncedAt: new Date(), quickbooksError: null }).where(eq(schema.timesheets.id, id));
  } catch (e) {
    await d.update(schema.timesheets).set({ quickbooksError: errText(e) }).where(eq(schema.timesheets.id, id));
    throw e;
  }
}

/** An approved expense as a QuickBooks purchase (its type's account; the client when billable). */
export async function pushExpense(id: string) {
  await once(`expense:${id}`, () => pushExpenseNow(id));
}
async function pushExpenseNow(id: string) {
  const d = db();
  const [x] = await d.select().from(schema.expenses).where(eq(schema.expenses.id, id));
  if (!x || x.status !== "approved" || x.quickbooksId) return;
  try {
    await linkDefaultAccounts();
    const [type] = await d.select().from(schema.expenseTypes).where(eq(schema.expenseTypes.id, x.typeId));
    const accounts = await d.select().from(schema.ledgerAccounts);
    const qbAccount = (id: string | null | undefined) => accounts.find((a) => a.id === id)?.quickbooksId ?? null;
    const expenseAccount = qbAccount(type?.ledgerAccountId);
    const bank = qbAccount((await billingSettings()).accounts.bank);
    if (!expenseAccount || !bank) throw new QuickBooksError("no_account", !expenseAccount ? type?.name : "bank");
    const [u] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, x.userId));
    const [client] = x.clientId ? await d.select({ qb: schema.clients.quickbooksId }).from(schema.clients).where(eq(schema.clients.id, x.clientId)) : [];
    const employee = await employeeOf(x.userId).catch(() => null);
    const r = await qb<{ Purchase: { Id: string } }>("POST", `purchase?requestid=${requestId(`expense:${id}`)}`, {
      PaymentType: "Cash",
      AccountRef: { value: bank },
      TxnDate: x.date,
      ...(employee ? { EntityRef: { value: employee, type: "Employee" } } : {}),
      PrivateNote: `Dépense de ${u?.name ?? ""} — ${type?.name ?? ""}`.slice(0, 4000),
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: x.amountCents / 100,
          Description: x.description.slice(0, 4000),
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: expenseAccount },
            ...(x.billable && client?.qb ? { BillableStatus: "Billable", CustomerRef: { value: client.qb } } : { BillableStatus: "NotBillable" }),
          },
        },
      ],
    });
    await d.update(schema.expenses).set({ quickbooksId: r.Purchase.Id, quickbooksSyncedAt: new Date(), quickbooksError: null }).where(eq(schema.expenses.id, id));
  } catch (e) {
    await d.update(schema.expenses).set({ quickbooksError: errText(e) }).where(eq(schema.expenses.id, id));
    throw e;
  }
}

export const errText = (e: unknown) => (e instanceof QuickBooksError ? (e.detail ? `${e.code}: ${e.detail}` : e.code) : e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Timesheets and expenses are not sent to QuickBooks for now: accounting pays them and marks them paid in the portal. */
export const QUICKBOOKS_PAUSED = new Set<string>(["timesheets", "expenses"]);

/** Is QuickBooks on for this part (connected, sync on, the part checked)? */
async function syncOn(part: "invoices" | "timesheets" | "expenses" | "payments") {
  if (QUICKBOOKS_PAUSED.has(part)) return false;
  const s = await quickbooksSettings();
  return Boolean(s.enabled && s.refreshToken && s.realmId && s.sync[part]);
}

/** Send now, when the sync is on; a failure stays on the record and is tried again later. */
export async function autoSync(part: "invoices" | "timesheets" | "expenses", id: string) {
  if (!(await syncOn(part))) return;
  const push = part === "invoices" ? pushInvoice : part === "timesheets" ? pushTimesheet : pushExpense;
  await push(id).catch((e) => console.warn(`[quickbooks] ${part} ${id}:`, errText(e)));
}

/** Every 15 minutes while the sync is on: payments back, and what was not sent yet. */
let ticking = false;
export async function quickbooksTick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickNow();
  } finally {
    ticking = false;
  }
}
async function tickNow() {
  const s = await quickbooksSettings();
  if (!s.enabled || !s.refreshToken || !s.realmId) return;
  const warn = (what: string) => (e: unknown) => console.warn(`[quickbooks] ${what}:`, errText(e));
  // clients, chart of accounts and chosen vendors, both ways
  await syncAll(null).catch(warn("sync"));
  if (s.sync.invoicesIn) await pullInvoices(null).catch(warn("invoices in"));
  if (s.sync.payments) await pullPayments(null).catch(warn("payments"));
  const d = db();
  if (s.sync.invoices) {
    const rows = await d.select({ id: schema.clientInvoices.id }).from(schema.clientInvoices).where(and(eq(schema.clientInvoices.source, "portal"), isNull(schema.clientInvoices.quickbooksId), eq(schema.clientInvoices.voided, false)));
    for (const r of rows) await pushInvoice(r.id).catch(warn("invoice"));
  }
  if (s.sync.timesheets && !QUICKBOOKS_PAUSED.has("timesheets")) {
    const rows = await d.select({ id: schema.timesheets.id }).from(schema.timesheets).where(and(eq(schema.timesheets.status, "approved"), isNull(schema.timesheets.quickbooksSyncedAt)));
    for (const r of rows) await pushTimesheet(r.id).catch(warn("timesheet"));
  }
  if (s.sync.expenses && !QUICKBOOKS_PAUSED.has("expenses")) {
    const rows = await d.select({ id: schema.expenses.id }).from(schema.expenses).where(and(eq(schema.expenses.status, "approved"), isNull(schema.expenses.quickbooksId)));
    for (const r of rows) await pushExpense(r.id).catch(warn("expense"));
  }
}

/** Clients not mapped yet (for the count on the QuickBooks tab). */
export const unmappedClients = () => db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.active, true), isNull(schema.clients.quickbooksId)));
