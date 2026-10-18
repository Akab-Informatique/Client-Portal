import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { addDays, linkDefaultAccounts, typesById, weekByDayAndType } from "./timesheets.ts";
import { billingSettings, ledger, qbApi, qbToken, quickbooksSettings, saveQuickBooksSettings, type LedgerType, type QuickBooksSettings } from "./billing.ts";

/**
 * QuickBooks Online, through its API: clients ↔ customers (no doubles),
 * the chart of accounts and the items (categories, SKUs) copied to match,
 * invoices sent, payments brought back onto the invoices.
 */
export class QuickBooksError extends Error {
  constructor(
    public code: "not_connected" | "not_mapped" | "no_item" | "customer_exists" | "voided" | "api" | "no_employee" | "no_account",
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

async function qb<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
const requestId = (key: string, body?: unknown) =>
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
async function query<T>(entity: string, where = ""): Promise<T[]> {
  const out: T[] = [];
  for (let start = 1; ; start += 1000) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults 1000`;
    const r = await qb<{ QueryResponse?: Record<string, T[]> }>("GET", `query?query=${encodeURIComponent(sql)}`);
    const rows = r.QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const norm = (s: string | null | undefined) =>
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
export async function applyItems(actorId: string, accept: string[]) {
  const items = await query<RawItem>("Item");
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
  const [items, taxes] = await Promise.all([
    db().select().from(schema.quickbooksItems).where(and(eq(schema.quickbooksItems.active, true), inArray(schema.quickbooksItems.type, ["Service", "NonInventory", "Inventory"]))),
    query<RawTax>("TaxCode").catch(() => [] as RawTax[]),
  ]);
  return {
    items: items.map((i) => ({ id: i.quickbooksId, name: i.name, sku: i.sku, type: i.type })).sort((x, y) => x.name.localeCompare(y.name)),
    taxCodes: taxes.filter((x) => x.Active !== false).map((x) => ({ id: x.Id, name: x.Name, description: x.Description ?? null })),
  };
}

// ── invoices ──
const dollars = (cents: number) => Math.round(cents) / 100;

/** Send one invoice (or its changes) to QuickBooks. The client must be mapped to a customer. */
export async function pushInvoice(invoiceId: string): Promise<{ quickbooksId: string }> {
  const r = await once(`invoice:${invoiceId}`, () => pushInvoiceNow(invoiceId));
  if (!r) throw new QuickBooksError("api", "busy");
  return r;
}
async function pushInvoiceNow(invoiceId: string): Promise<{ quickbooksId: string }> {
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
    if (!s.invoice.itemId) throw new QuickBooksError("no_item");
    const exempt = client.invoice?.taxes === false;
    const taxCode = exempt ? s.invoice.exemptTaxCodeId : s.invoice.taxCodeId;
    const subtotal = dollars(inv.totalCents - inv.taxCents);
    const own = await d.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.position));
    const lineOf = (description: string, amount: number, qty: number, unit: number, taxed: boolean) => ({
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      Description: description.slice(0, 4000),
      SalesItemLineDetail: { ItemRef: { value: s.invoice.itemId! }, Qty: qty, UnitPrice: unit, ...((taxed ? taxCode : s.invoice.exemptTaxCodeId) ? { TaxCodeRef: { value: (taxed ? taxCode : s.invoice.exemptTaxCodeId)! } } : {}) },
    });
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
        ? own.map((l) => lineOf(l.description, dollars(l.amountCents), l.quantityX100 / 100, dollars(l.unitPriceCents), l.taxable))
        : [lineOf(`Facture ${inv.number}`, subtotal, 1, subtotal, true)],
    };
    let id = inv.quickbooksId;
    if (id) {
      // changes: the current version (SyncToken) is required
      const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(id)}`);
      const r = await qb<{ Invoice: { Id: string } }>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true });
      id = r.Invoice.Id;
    } else {
      // already in QuickBooks under the same number (sent by hand before): linked, not doubled
      const docNumber = inv.number.slice(0, 21).replace(/[^A-Za-z0-9.-]/g, "");
      const same = docNumber ? await query<{ Id: string; CustomerRef?: { value: string } }>("Invoice", `DocNumber = '${docNumber}'`) : [];
      const mine = same.find((x) => x.CustomerRef?.value === client.quickbooksId);
      if (mine) {
        const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(mine.Id)}`);
        id = (await qb<{ Invoice: { Id: string } }>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true })).Invoice.Id;
      } else {
        id = (await qb<{ Invoice: { Id: string } }>("POST", `invoice?requestid=${requestId(`invoice:${inv.id}`, body)}`, body)).Invoice.Id;
      }
    }
    await d.update(schema.clientInvoices).set({ quickbooksId: id, quickbooksSyncedAt: new Date(), quickbooksError: null }).where(eq(schema.clientInvoices.id, inv.id));
    return { quickbooksId: id };
  } catch (e) {
    return fail(e);
  }
}

// ── payments: QuickBooks → portal ──
type RawPayment = { Id: string; TxnDate: string; PaymentRefNum?: string; PaymentMethodRef?: { name?: string }; PrivateNote?: string; Line?: { Amount: number; LinkedTxn?: { TxnId: string; TxnType: string }[] }[]; MetaData?: { LastUpdatedTime?: string } };

/** Payments made or changed in QuickBooks since the last time, put on their invoices. */
export async function pullPayments(actorId: string | null) {
  const s = await quickbooksSettings();
  const since = s.paymentsPulledAt ?? new Date(Date.now() - 365 * 86_400_000).toISOString();
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

const errText = (e: unknown) => (e instanceof QuickBooksError ? (e.detail ? `${e.code}: ${e.detail}` : e.code) : e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Is QuickBooks on for this part (connected, sync on, the part checked)? */
async function syncOn(part: "invoices" | "timesheets" | "expenses" | "payments") {
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
  if (s.sync.payments) await pullPayments(null).catch(warn("payments"));
  const d = db();
  if (s.sync.invoices) {
    const rows = await d.select({ id: schema.clientInvoices.id }).from(schema.clientInvoices).where(and(eq(schema.clientInvoices.source, "portal"), isNull(schema.clientInvoices.quickbooksId), eq(schema.clientInvoices.voided, false)));
    for (const r of rows) await pushInvoice(r.id).catch(warn("invoice"));
  }
  if (s.sync.timesheets) {
    const rows = await d.select({ id: schema.timesheets.id }).from(schema.timesheets).where(and(eq(schema.timesheets.status, "approved"), isNull(schema.timesheets.quickbooksSyncedAt)));
    for (const r of rows) await pushTimesheet(r.id).catch(warn("timesheet"));
  }
  if (s.sync.expenses) {
    const rows = await d.select({ id: schema.expenses.id }).from(schema.expenses).where(and(eq(schema.expenses.status, "approved"), isNull(schema.expenses.quickbooksId)));
    for (const r of rows) await pushExpense(r.id).catch(warn("expense"));
  }
}

/** Clients not mapped yet (for the count on the QuickBooks tab). */
export const unmappedClients = () => db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.active, true), isNull(schema.clients.quickbooksId)));
