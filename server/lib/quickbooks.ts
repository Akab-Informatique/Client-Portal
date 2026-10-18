import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { ledger, qbApi, qbToken, quickbooksSettings, saveQuickBooksSettings, type LedgerType, type QuickBooksSettings } from "./billing.ts";

/**
 * QuickBooks Online, through its API: clients ↔ customers (no doubles),
 * the chart of accounts and the items (categories, SKUs) copied to match,
 * invoices sent, payments brought back onto the invoices.
 */
export class QuickBooksError extends Error {
  constructor(
    public code: "not_connected" | "not_mapped" | "no_item" | "customer_exists" | "voided" | "api",
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

/** The client as a new QuickBooks customer (refused if one has the same name). */
export async function createCustomer(clientId: string): Promise<QbCustomer> {
  const [c] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!c) throw new QuickBooksError("api", "client");
  const same = (await quickbooksCustomers()).find((q) => norm(q.name) === norm(c.name));
  if (same) throw new QuickBooksError("customer_exists", same.id);
  const email = c.invoice?.billingEmail || c.email;
  const r = await qb<{ Customer: RawCustomer }>("POST", "customer", {
    DisplayName: c.name.slice(0, 100),
    CompanyName: c.name.slice(0, 100),
    ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    ...(c.address || c.city ? { BillAddr: { Line1: c.address ?? undefined, City: c.city ?? undefined, CountrySubDivisionCode: c.province ?? undefined, PostalCode: c.postalCode ?? undefined, Country: "CA" } } : {}),
  });
  await db().update(schema.clients).set({ quickbooksId: r.Customer.Id, updatedAt: new Date() }).where(eq(schema.clients.id, clientId));
  return customerOf(r.Customer);
}

// ── chart of accounts ──
type RawAccount = { Id: string; Name: string; AcctNum?: string; Classification?: string; Active?: boolean };
const TYPE_OF: Record<string, LedgerType> = { Asset: "asset", Liability: "liability", Equity: "equity", Revenue: "revenue", Expense: "expense" };

/** QuickBooks accounts into the chart: matched by number, then by name; the others added. */
export async function importAccounts(actorId: string) {
  const accounts = await query<RawAccount>("Account");
  const d = db();
  const local = await ledger(actorId);
  let matched = 0;
  let created = 0;
  const used = new Set(local.map((a) => a.quickbooksId).filter(Boolean));
  for (const a of accounts) {
    if (a.Active === false) continue;
    const hit = local.find((l) => l.quickbooksId === a.Id) ?? local.find((l) => !l.quickbooksId && a.AcctNum && l.number === a.AcctNum) ?? local.find((l) => !l.quickbooksId && norm(l.name) === norm(a.Name));
    if (hit) {
      if (hit.quickbooksId !== a.Id) {
        await d.update(schema.ledgerAccounts).set({ quickbooksId: a.Id, updatedAt: new Date() }).where(eq(schema.ledgerAccounts.id, hit.id));
        hit.quickbooksId = a.Id;
      }
      matched++;
      continue;
    }
    if (used.has(a.Id)) continue;
    const number = a.AcctNum || `QB-${a.Id}`;
    const [row] = await d
      .insert(schema.ledgerAccounts)
      .values({ number, name: a.Name, type: TYPE_OF[a.Classification ?? ""] ?? "expense", quickbooksId: a.Id })
      .onConflictDoNothing()
      .returning();
    if (row) {
      created++;
      local.push(row);
    }
  }
  const result = { at: new Date().toISOString(), matched, created };
  const s = await quickbooksSettings();
  await saveQuickBooksSettings(actorId, { imports: { ...s.imports, accounts: result } });
  return result;
}

// ── items: products, services, categories (SKU) ──
type RawItem = { Id: string; Name: string; FullyQualifiedName?: string; Sku?: string; Type: string; ParentRef?: { value: string }; IncomeAccountRef?: { value: string }; UnitPrice?: number; Active?: boolean };

/** QuickBooks items into the portal; inventory products with the same SKU are linked to them. */
export async function importItems(actorId: string) {
  const items = await query<RawItem>("Item");
  const d = db();
  const now = new Date();
  const known = new Map((await d.select().from(schema.quickbooksItems)).map((x) => [x.quickbooksId, x]));
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
  // same SKU (letters and digits only, any case): the same product
  const key = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const bySku = new Map(items.filter((i) => i.Sku && i.Type !== "Category").map((i) => [key(i.Sku!), i.Id]));
  const products = await d.select({ id: schema.storeProducts.id, sku: schema.storeProducts.sku, qb: schema.storeProducts.quickbooksItemId }).from(schema.storeProducts).where(isNotNull(schema.storeProducts.sku));
  let linked = 0;
  for (const p of products) {
    const qbId = bySku.get(key(p.sku));
    if (qbId) {
      linked++;
      if (p.qb !== qbId) await d.update(schema.storeProducts).set({ quickbooksItemId: qbId, updatedAt: now }).where(eq(schema.storeProducts.id, p.id));
    }
  }
  const result = { at: now.toISOString(), items: items.filter((i) => i.Type !== "Category").length, categories: items.filter((i) => i.Type === "Category").length, products: linked };
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
    const body = {
      DocNumber: inv.number.slice(0, 21),
      TxnDate: inv.issuedOn,
      ...(inv.dueOn ? { DueDate: inv.dueOn } : {}),
      CustomerRef: { value: client.quickbooksId },
      GlobalTaxCalculation: "TaxExcluded",
      ...(client.invoice?.billingEmail ? { BillEmail: { Address: client.invoice.billingEmail } } : {}),
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: subtotal,
          Description: `Facture ${inv.number}`,
          SalesItemLineDetail: { ItemRef: { value: s.invoice.itemId }, Qty: 1, UnitPrice: subtotal, ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}) },
        },
      ],
    };
    let id = inv.quickbooksId;
    if (id) {
      // changes: the current version (SyncToken) is required
      const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(id)}`);
      const r = await qb<{ Invoice: { Id: string } }>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true });
      id = r.Invoice.Id;
    } else {
      // already in QuickBooks under the same number (sent by hand before): linked, not doubled
      const same = await query<{ Id: string; CustomerRef?: { value: string } }>("Invoice", `DocNumber = '${inv.number.replace(/'/g, "\\'").slice(0, 21)}'`);
      const mine = same.find((x) => x.CustomerRef?.value === client.quickbooksId);
      if (mine) {
        const cur = await qb<{ Invoice: { Id: string; SyncToken: string } }>("GET", `invoice/${encodeURIComponent(mine.Id)}`);
        id = (await qb<{ Invoice: { Id: string } }>("POST", "invoice", { ...body, Id: cur.Invoice.Id, SyncToken: cur.Invoice.SyncToken, sparse: true })).Invoice.Id;
      } else {
        id = (await qb<{ Invoice: { Id: string } }>("POST", "invoice", body)).Invoice.Id;
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

/** Every 15 minutes while the sync is on (and payments are part of it). */
export async function quickbooksTick() {
  const s = await quickbooksSettings();
  if (!s.enabled || !s.sync.payments || !s.refreshToken || !s.realmId) return;
  await pullPayments(null).catch((e) => console.warn("[quickbooks] payments:", e instanceof Error ? e.message : e));
}

/** Clients not mapped yet (for the count on the QuickBooks tab). */
export const unmappedClients = () => db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.active, true), isNull(schema.clients.quickbooksId)));
