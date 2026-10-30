import { eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { quickbooksSettings, saveQuickBooksSettings } from "./billing.ts";
import { query } from "./quickbooks.ts";

/**
 * Bills of the company's vendors (QuickBooks "Bill"), copied into `vendor_bills` so the portal can show what has to
 * be paid and when. Read only: nothing is ever written to QuickBooks. A bill is found by its QuickBooks id.
 */
type RawBill = {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  VendorRef?: { value: string; name?: string };
  MetaData?: { LastUpdatedTime?: string };
};

const cents = (v: number | undefined) => Math.round((v ?? 0) * 100);
const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Brings the bills in: the ones still open (so a payment made in QuickBooks closes them here), the ones changed
 * since the last pull (a year back the first time), and the open ones we hold that QuickBooks no longer lists
 * (looked up one by one: paid, or deleted in QuickBooks → removed here).
 */
export async function pullBills(actorId: string | null) {
  const s = await quickbooksSettings();
  const started = new Date().toISOString();
  const since = s.imports.bills?.at;
  const firstFrom = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const open = await query<RawBill>("Bill", "Balance > '0'");
  const changed = await query<RawBill>("Bill", since ? `MetaData.LastUpdatedTime >= '${since}'` : `TxnDate >= '${firstFrom}'`);
  const rows = new Map<string, RawBill>([...open, ...changed].map((b) => [b.Id, b]));

  const d = db();
  const held = await d.select({ id: schema.vendorBills.id, qb: schema.vendorBills.quickbooksId }).from(schema.vendorBills).where(gt(schema.vendorBills.balanceCents, 0));
  const missing = held.filter((h) => !rows.has(h.qb)).map((h) => h.qb);
  const found = new Set<string>();
  for (const part of chunks(missing, 40)) {
    for (const b of await query<RawBill>("Bill", `Id IN (${part.map((x) => `'${x}'`).join(",")})`)) {
      rows.set(b.Id, b);
      found.add(b.Id);
    }
  }

  const vendors = new Map((await d.select({ id: schema.vendors.id, qb: schema.vendors.quickbooksId }).from(schema.vendors).where(isNotNull(schema.vendors.quickbooksId))).map((v) => [v.qb!, v.id]));
  const existing = new Map((await d.select().from(schema.vendorBills)).map((b) => [b.quickbooksId, b]));
  const now = new Date();
  let added = 0;
  let updated = 0;
  for (const b of rows.values()) {
    const values = {
      quickbooksId: b.Id,
      vendorId: vendors.get(b.VendorRef?.value ?? "") ?? null,
      qbVendorId: b.VendorRef?.value ?? null,
      vendorName: (b.VendorRef?.name || "—").slice(0, 200),
      docNumber: b.DocNumber?.slice(0, 80) ?? null,
      issuedOn: b.TxnDate,
      dueOn: b.DueDate ?? null,
      totalCents: cents(b.TotalAmt),
      balanceCents: cents(b.Balance),
      memo: b.PrivateNote?.slice(0, 1000) ?? null,
      qbUpdatedAt: b.MetaData?.LastUpdatedTime ? new Date(b.MetaData.LastUpdatedTime) : null,
      syncedAt: now,
    };
    const hit = existing.get(b.Id);
    if (!hit) {
      await d.insert(schema.vendorBills).values(values).onConflictDoNothing();
      added++;
    } else if (hit.balanceCents !== values.balanceCents || hit.totalCents !== values.totalCents || hit.dueOn !== values.dueOn || hit.vendorName !== values.vendorName || hit.vendorId !== values.vendorId || hit.docNumber !== values.docNumber) {
      await d.update(schema.vendorBills).set({ ...values, updatedAt: now }).where(eq(schema.vendorBills.id, hit.id));
      updated++;
    }
  }
  // an open bill we held that QuickBooks no longer has at all: deleted there
  const gone = held.filter((h) => missing.includes(h.qb) && !found.has(h.qb)).map((h) => h.id);
  if (gone.length) await d.delete(schema.vendorBills).where(inArray(schema.vendorBills.id, gone));

  const result = { at: started, added, updated, removed: gone.length, total: rows.size };
  await saveQuickBooksSettings(actorId, { imports: { ...s.imports, bills: result } });
  return result;
}

export type BillView = {
  id: string;
  vendor: string;
  vendorId: string | null;
  number: string | null;
  issuedOn: string;
  dueOn: string | null;
  totalCents: number;
  balanceCents: number;
  memo: string | null;
  status: "open" | "overdue" | "paid";
  daysLate: number;
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export function billView(b: typeof schema.vendorBills.$inferSelect, today = todayQc()): BillView {
  const paid = b.balanceCents <= 0;
  const late = !paid && b.dueOn !== null && b.dueOn < today;
  return {
    id: b.id,
    vendor: b.vendorName,
    vendorId: b.vendorId,
    number: b.docNumber,
    issuedOn: b.issuedOn,
    dueOn: b.dueOn,
    totalCents: b.totalCents,
    balanceCents: b.balanceCents,
    memo: b.memo,
    status: paid ? "paid" : late ? "overdue" : "open",
    daysLate: late ? daysBetween(b.dueOn!, today) : 0,
  };
}

/** What has to be paid: late, today, the next 7 and 30 days, later, and bills with no due date. Only unpaid bills count. */
export async function billsSummary(today = todayQc()) {
  const rows = await db().select().from(schema.vendorBills).where(gt(schema.vendorBills.balanceCents, 0));
  const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const sum = (f: (b: (typeof rows)[number]) => boolean) => {
    const l = rows.filter(f);
    return { count: l.length, cents: l.reduce((x, b) => x + b.balanceCents, 0) };
  };
  return {
    today,
    overdue: sum((b) => b.dueOn !== null && b.dueOn < today),
    dueToday: sum((b) => b.dueOn === today),
    next7: sum((b) => b.dueOn !== null && b.dueOn >= today && b.dueOn <= plus(7)),
    next30: sum((b) => b.dueOn !== null && b.dueOn >= today && b.dueOn <= plus(30)),
    noDue: sum((b) => b.dueOn === null),
    totalOpen: sum(() => true),
  };
}
