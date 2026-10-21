import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { errText, norm, qb, query, QuickBooksError, requestId } from "./quickbooks.ts";
import { quickbooksSettings, saveQuickBooksSettings, type LedgerType } from "./billing.ts";

/**
 * QuickBooks, both ways, once connected: the clients mapped to a customer, the chart of accounts, and the
 * vendors you chose are kept in step. For a record changed on one side only, the change goes to the other;
 * changed on both, the latest change wins. Only what differs is written, so a record never goes back and
 * forth. A change made here is sent right away (a failure is tried again every 15 minutes); a change made
 * in QuickBooks comes in at the next pass (every 15 minutes, or "Synchroniser maintenant").
 */
export type Direction = "none" | "push" | "pull";

/**
 * Which way a record that differs goes: only the portal changed since the last sync → push; only QuickBooks →
 * pull; both (or never synced) → the latest change.
 */
export function decide(p: { portalAt: Date; qbAt: Date | null; syncedAt: Date | null; differs: boolean }): Direction {
  if (!p.differs) return "none";
  const qbAt = p.qbAt ?? new Date(0);
  if (!p.syncedAt) return p.portalAt.getTime() > qbAt.getTime() ? "push" : "pull";
  const portalChanged = p.portalAt.getTime() > p.syncedAt.getTime();
  const qbChanged = qbAt.getTime() > p.syncedAt.getTime();
  if (portalChanged && qbChanged) return p.portalAt.getTime() >= qbAt.getTime() ? "push" : "pull";
  if (portalChanged) return "push";
  if (qbChanged) return "pull";
  // differing with no change on either side since the last sync (edited in a way not seen): QuickBooks is the book of record
  return "pull";
}

const clean = (v: string | null | undefined) => (v ?? "").trim();
const lower = (v: string | null | undefined) => clean(v).toLowerCase();
const time = (s: string | undefined) => (s ? new Date(s) : null);
const when = (s: { MetaData?: { LastUpdatedTime?: string } }) => time(s.MetaData?.LastUpdatedTime);

export type PartResult = { at: string; pulled: number; pushed: number; created: number; linked: number; failed: number; errors: string[] };
const blank = (): PartResult => ({ at: new Date().toISOString(), pulled: 0, pushed: 0, created: 0, linked: 0, failed: 0, errors: [] });
const fail = (r: PartResult, what: string, e: unknown) => {
  r.failed++;
  if (r.errors.length < 5) r.errors.push(`${what}: ${errText(e)}`);
};

// ── clients ↔ customers ──
type Addr = { Line1?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string };
type RawCustomer = { Id: string; SyncToken: string; DisplayName: string; CompanyName?: string; PrimaryEmailAddr?: { Address?: string }; PrimaryPhone?: { FreeFormNumber?: string }; BillAddr?: Addr; Active?: boolean; MetaData?: { LastUpdatedTime?: string } };
type Client = typeof schema.clients.$inferSelect;

const clientFields = (c: Client) => ({
  name: clean(c.name).slice(0, 100),
  email: lower(c.invoice?.billingEmail || c.email),
  phone: clean(c.phone),
  address: clean(c.address),
  city: clean(c.city),
  province: clean(c.province),
  postalCode: clean(c.postalCode),
  active: c.active,
});
const customerFields = (q: RawCustomer) => ({
  name: clean(q.DisplayName).slice(0, 100),
  email: lower(q.PrimaryEmailAddr?.Address),
  phone: clean(q.PrimaryPhone?.FreeFormNumber),
  address: clean(q.BillAddr?.Line1),
  city: clean(q.BillAddr?.City),
  province: clean(q.BillAddr?.CountrySubDivisionCode),
  postalCode: clean(q.BillAddr?.PostalCode),
  active: q.Active !== false,
});
const differs = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).some((k) => a[k] !== b[k]);

async function reconcileClient(c: Client, q: RawCustomer, r: PartResult): Promise<void> {
  const mine = clientFields(c);
  const theirs = customerFields(q);
  const way = decide({ portalAt: c.updatedAt, qbAt: when(q), syncedAt: c.qbSyncedAt, differs: differs(mine, theirs) });
  const d = db();
  if (way === "none") {
    if (!c.qbSyncedAt) await d.update(schema.clients).set({ qbSyncedAt: new Date() }).where(eq(schema.clients.id, c.id));
    return;
  }
  if (way === "pull") {
    const now = new Date();
    // the email goes where the portal keeps it: the billing email when one is set, else the client's
    const billing = c.invoice?.billingEmail ? { invoice: { ...c.invoice, billingEmail: q.PrimaryEmailAddr?.Address ?? "" } } : { email: q.PrimaryEmailAddr?.Address ?? null };
    await d
      .update(schema.clients)
      .set({
        name: theirs.name || c.name,
        ...billing,
        phone: theirs.phone || null,
        address: theirs.address || null,
        city: theirs.city || null,
        province: theirs.province || null,
        postalCode: theirs.postalCode || null,
        active: theirs.active,
        updatedAt: now,
        qbSyncedAt: now,
      })
      .where(eq(schema.clients.id, c.id));
    r.pulled++;
    return;
  }
  const res = await qb<{ Customer: RawCustomer }>("POST", "customer", {
    Id: q.Id,
    SyncToken: q.SyncToken,
    sparse: true,
    DisplayName: mine.name,
    CompanyName: mine.name,
    PrimaryEmailAddr: { Address: mine.email },
    PrimaryPhone: { FreeFormNumber: mine.phone },
    BillAddr: { Line1: mine.address, City: mine.city, CountrySubDivisionCode: mine.province, PostalCode: mine.postalCode, Country: "CA" },
    Active: mine.active,
  });
  await d
    .update(schema.clients)
    .set({ qbSyncedAt: new Date(Math.max(Date.now(), when(res.Customer)?.getTime() ?? 0)) })
    .where(eq(schema.clients.id, c.id));
  r.pushed++;
}

export async function syncClients(): Promise<PartResult> {
  const r = blank();
  const mapped = await db().select().from(schema.clients).where(isNotNull(schema.clients.quickbooksId));
  if (!mapped.length) return r;
  const customers = new Map((await query<RawCustomer>("Customer", "Active in (true, false)")).map((q) => [q.Id, q]));
  for (const c of mapped) {
    const q = customers.get(c.quickbooksId!);
    if (!q) continue;
    await reconcileClient(c, q, r).catch((e) => fail(r, c.name, e));
  }
  return r;
}

/** Send one client's change now (after an edit in the portal) */
export async function pushClient(id: string): Promise<void> {
  const [c] = await db().select().from(schema.clients).where(eq(schema.clients.id, id));
  if (!c?.quickbooksId) return;
  const res = await qb<{ Customer: RawCustomer }>("GET", `customer/${encodeURIComponent(c.quickbooksId)}`);
  await reconcileClient(c, res.Customer, blank());
}

// ── chart of accounts ──
type RawAccount = { Id: string; SyncToken: string; Name: string; AcctNum?: string; Classification?: string; AccountType?: string; Active?: boolean; MetaData?: { LastUpdatedTime?: string } };
type Account = typeof schema.ledgerAccounts.$inferSelect;
const TYPE_OF: Record<string, LedgerType> = { Asset: "asset", Liability: "liability", Equity: "equity", Revenue: "revenue", Expense: "expense" };
const QB_TYPE: Record<LedgerType, string> = { asset: "Other Current Asset", liability: "Other Current Liability", equity: "Equity", revenue: "Income", expense: "Expense" };

async function reconcileAccount(a: Account, q: RawAccount, numbersOn: boolean, r: PartResult): Promise<void> {
  const type = TYPE_OF[q.Classification ?? ""] ?? (a.type as LedgerType);
  const mine = { name: clean(a.name), number: numbersOn ? clean(a.number) : "", active: a.active };
  const theirs = { name: clean(q.Name), number: numbersOn ? clean(q.AcctNum) : "", active: q.Active !== false };
  // a type is never pushed (QuickBooks does not let it change); when it differs it comes in
  const typeDiffers = a.type !== type;
  const way = decide({ portalAt: a.updatedAt, qbAt: when(q), syncedAt: a.qbSyncedAt, differs: differs(mine, theirs) || typeDiffers });
  const d = db();
  if (way === "none") {
    if (!a.qbSyncedAt) await d.update(schema.ledgerAccounts).set({ qbSyncedAt: new Date() }).where(eq(schema.ledgerAccounts.id, a.id));
    return;
  }
  if (way === "pull" || (way === "push" && typeDiffers && !differs(mine, theirs))) {
    const now = new Date();
    // QuickBooks' number, unless another account here already has it
    let number = a.number;
    if (numbersOn && theirs.number && theirs.number !== a.number) {
      const [taken] = await d.select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.number, theirs.number));
      if (!taken || taken.id === a.id) number = theirs.number;
    }
    await d.update(schema.ledgerAccounts).set({ name: theirs.name || a.name, number, type, active: theirs.active, updatedAt: now, qbSyncedAt: now }).where(eq(schema.ledgerAccounts.id, a.id));
    r.pulled++;
    return;
  }
  const res = await qb<{ Account: RawAccount }>("POST", "account", {
    Id: q.Id,
    SyncToken: q.SyncToken,
    sparse: true,
    Name: mine.name,
    ...(numbersOn ? { AcctNum: mine.number } : {}),
    Active: mine.active,
  });
  await d.update(schema.ledgerAccounts).set({ qbSyncedAt: new Date(Math.max(Date.now(), when(res.Account)?.getTime() ?? 0)) }).where(eq(schema.ledgerAccounts.id, a.id));
  r.pushed++;
}

export async function syncAccounts(since: Date | null): Promise<PartResult> {
  const r = blank();
  const d = db();
  const all = await query<RawAccount>("Account", "Active in (true, false)");
  // numbers on the accounts is a QuickBooks option: it is on when any account has one
  const numbersOn = all.some((q) => q.AcctNum);
  const local = await d.select().from(schema.ledgerAccounts).orderBy(asc(schema.ledgerAccounts.number));
  const byQb = new Map(local.filter((a) => a.quickbooksId).map((a) => [a.quickbooksId!, a]));
  const free = new Set(local.filter((a) => !a.quickbooksId).map((a) => a.id));
  for (const q of all) {
    try {
      const tied = byQb.get(q.Id);
      if (tied) {
        await reconcileAccount(tied, q, numbersOn, r);
        continue;
      }
      // not tied yet: the same number, else the same name, ties; else it comes in as a new account
      const same = local.find((a) => free.has(a.id) && ((numbersOn && q.AcctNum && a.number === q.AcctNum) || norm(a.name) === norm(q.Name)));
      if (same) {
        free.delete(same.id);
        const [linked] = await d.update(schema.ledgerAccounts).set({ quickbooksId: q.Id }).where(eq(schema.ledgerAccounts.id, same.id)).returning();
        r.linked++;
        await reconcileAccount({ ...linked, quickbooksId: q.Id }, q, numbersOn, r);
        continue;
      }
      if (q.Active === false) continue;
      const number = q.AcctNum && !local.some((a) => a.number === q.AcctNum) ? q.AcctNum : `QB-${q.Id}`;
      const now = new Date();
      const [row] = await d
        .insert(schema.ledgerAccounts)
        .values({ number, name: q.Name, type: TYPE_OF[q.Classification ?? ""] ?? "expense", quickbooksId: q.Id, qbSyncedAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.ledgerAccounts.id });
      if (row) r.created++;
    } catch (e) {
      fail(r, q.Name, e);
    }
  }
  // accounts made here since the sync started are made in QuickBooks too (the ones that were here before are matched, never copied)
  if (since) {
    const mine = await d
      .select()
      .from(schema.ledgerAccounts)
      .where(and(isNull(schema.ledgerAccounts.quickbooksId), eq(schema.ledgerAccounts.active, true)));
    for (const a of mine) {
      if (a.createdAt <= since) continue;
      try {
        const res = await qb<{ Account: RawAccount }>("POST", `account?requestid=${requestId(`account:${a.id}`)}`, { Name: a.name.slice(0, 100), ...(numbersOn ? { AcctNum: a.number.slice(0, 7) } : {}), AccountType: QB_TYPE[a.type as LedgerType] ?? "Expense" });
        await d.update(schema.ledgerAccounts).set({ quickbooksId: res.Account.Id, qbSyncedAt: new Date() }).where(eq(schema.ledgerAccounts.id, a.id));
        r.created++;
      } catch (e) {
        fail(r, a.name, e);
      }
    }
  }
  return r;
}

export async function pushAccount(id: string): Promise<void> {
  const [a] = await db().select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, id));
  if (!a?.quickbooksId) return;
  const res = await qb<{ Account: RawAccount }>("GET", `account/${encodeURIComponent(a.quickbooksId)}`);
  // numbers are on when the account has one in QuickBooks
  await reconcileAccount(a, res.Account, Boolean(res.Account.AcctNum), blank());
}

// ── vendors ──
type RawVendor = { Id: string; SyncToken: string; DisplayName: string; CompanyName?: string; PrimaryEmailAddr?: { Address?: string }; PrimaryPhone?: { FreeFormNumber?: string }; Active?: boolean; MetaData?: { LastUpdatedTime?: string } };
type Vendor = typeof schema.vendors.$inferSelect;
const vendorFields = (v: Vendor) => ({ name: clean(v.name).slice(0, 100), email: lower(v.email), phone: clean(v.phone), active: v.active });
const rawVendorFields = (q: RawVendor) => ({ name: clean(q.DisplayName).slice(0, 100), email: lower(q.PrimaryEmailAddr?.Address), phone: clean(q.PrimaryPhone?.FreeFormNumber), active: q.Active !== false });

async function reconcileVendor(v: Vendor, q: RawVendor, r: PartResult): Promise<void> {
  const mine = vendorFields(v);
  const theirs = rawVendorFields(q);
  const way = decide({ portalAt: v.updatedAt, qbAt: when(q), syncedAt: v.qbSyncedAt, differs: differs(mine, theirs) });
  const d = db();
  if (way === "none") {
    if (!v.qbSyncedAt) await d.update(schema.vendors).set({ qbSyncedAt: new Date() }).where(eq(schema.vendors.id, v.id));
    return;
  }
  if (way === "pull") {
    const now = new Date();
    await d
      .update(schema.vendors)
      .set({ name: theirs.name || v.name, email: q.PrimaryEmailAddr?.Address ?? null, phone: theirs.phone || null, active: theirs.active, updatedAt: now, qbSyncedAt: now })
      .where(eq(schema.vendors.id, v.id));
    r.pulled++;
    return;
  }
  const res = await qb<{ Vendor: RawVendor }>("POST", "vendor", {
    Id: q.Id,
    SyncToken: q.SyncToken,
    sparse: true,
    DisplayName: mine.name,
    CompanyName: mine.name,
    PrimaryEmailAddr: { Address: mine.email },
    PrimaryPhone: { FreeFormNumber: mine.phone },
    Active: mine.active,
  });
  await d.update(schema.vendors).set({ qbSyncedAt: new Date(Math.max(Date.now(), when(res.Vendor)?.getTime() ?? 0)) }).where(eq(schema.vendors.id, v.id));
  r.pushed++;
}

export async function syncVendors(): Promise<PartResult> {
  const r = blank();
  const tied = await db().select().from(schema.vendors).where(isNotNull(schema.vendors.quickbooksId));
  if (!tied.length) return r;
  const all = new Map((await query<RawVendor>("Vendor", "Active in (true, false)")).map((q) => [q.Id, q]));
  for (const v of tied) {
    const q = all.get(v.quickbooksId!);
    if (q) await reconcileVendor(v, q, r).catch((e) => fail(r, v.name, e));
  }
  return r;
}

export async function pushVendor(id: string): Promise<void> {
  const [v] = await db().select().from(schema.vendors).where(eq(schema.vendors.id, id));
  if (!v?.quickbooksId) return;
  const res = await qb<{ Vendor: RawVendor }>("GET", `vendor/${encodeURIComponent(v.quickbooksId)}`);
  await reconcileVendor(v, res.Vendor, blank());
}

export type VendorChoice = { id: string; name: string; email: string | null; phone: string | null; active: boolean; selected: boolean; portalId: string | null };
/** The QuickBooks vendors with whether each is kept in step with a vendor here, and the portal vendors QuickBooks does not know */
export async function vendorChoices(): Promise<{ vendors: VendorChoice[]; portalOnly: { id: string; name: string }[] }> {
  const [all, mine] = await Promise.all([query<RawVendor>("Vendor", "Active in (true, false)"), db().select().from(schema.vendors).orderBy(asc(schema.vendors.name))]);
  const byQb = new Map(mine.filter((v) => v.quickbooksId).map((v) => [v.quickbooksId!, v]));
  const vendors = all
    .map((q) => ({ id: q.Id, name: q.DisplayName, email: q.PrimaryEmailAddr?.Address ?? null, phone: q.PrimaryPhone?.FreeFormNumber ?? null, active: q.Active !== false, selected: byQb.has(q.Id), portalId: byQb.get(q.Id)?.id ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { vendors, portalOnly: mine.filter((v) => !v.quickbooksId).map((v) => ({ id: v.id, name: v.name })) };
}

/**
 * The vendors kept in step with QuickBooks are exactly the ones chosen: a chosen QuickBooks vendor is tied to the
 * portal vendor of the same name, or comes in as a new one; one no longer chosen is untied (and kept here).
 */
export async function selectVendors(ids: string[], actorId: string): Promise<{ tied: number; created: number; untied: number }> {
  const d = db();
  const want = new Set(ids);
  const all = new Map((await query<RawVendor>("Vendor", "Active in (true, false)")).map((q) => [q.Id, q]));
  const mine = await d.select().from(schema.vendors);
  const out = { tied: 0, created: 0, untied: 0 };
  for (const v of mine) {
    if (v.quickbooksId && !want.has(v.quickbooksId)) {
      await d.update(schema.vendors).set({ quickbooksId: null, qbSyncedAt: null, updatedAt: new Date() }).where(eq(schema.vendors.id, v.id));
      out.untied++;
    }
  }
  const taken = new Set(mine.filter((v) => v.quickbooksId && want.has(v.quickbooksId)).map((v) => v.quickbooksId!));
  const free = mine.filter((v) => !v.quickbooksId);
  for (const id of want) {
    const q = all.get(id);
    if (!q || taken.has(id)) continue;
    const same = free.find((v) => norm(v.name) === norm(q.DisplayName));
    if (same) {
      free.splice(free.indexOf(same), 1);
      await d.update(schema.vendors).set({ quickbooksId: id, qbSyncedAt: null }).where(eq(schema.vendors.id, same.id));
      out.tied++;
    } else {
      await d.insert(schema.vendors).values({ name: q.DisplayName, email: q.PrimaryEmailAddr?.Address ?? null, phone: q.PrimaryPhone?.FreeFormNumber ?? null, active: q.Active !== false, quickbooksId: id, qbSyncedAt: new Date() });
      out.created++;
    }
  }
  await audit(actorId, "billing.quickbooks.vendors_selected", null, { selected: ids.length, ...out });
  return out;
}

/** A vendor made here, made in QuickBooks too and kept in step from then on */
export async function createVendorInQb(vendorId: string): Promise<void> {
  const [v] = await db().select().from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  if (!v) throw new QuickBooksError("api", "vendor");
  if (v.quickbooksId) return;
  const taken = (await query<RawVendor>("Vendor", "Active in (true, false)")).find((q) => norm(q.DisplayName) === norm(v.name));
  if (taken) throw new QuickBooksError("customer_exists", taken.Id);
  const res = await qb<{ Vendor: RawVendor }>("POST", `vendor?requestid=${requestId(`vendor:${v.id}`)}`, {
    DisplayName: v.name.slice(0, 100),
    CompanyName: v.name.slice(0, 100),
    ...(v.email ? { PrimaryEmailAddr: { Address: v.email } } : {}),
    ...(v.phone ? { PrimaryPhone: { FreeFormNumber: v.phone } } : {}),
  });
  await db().update(schema.vendors).set({ quickbooksId: res.Vendor.Id, qbSyncedAt: new Date() }).where(eq(schema.vendors.id, v.id));
}

// ── one pass, for the background job and the button ──
export type SyncPart = "clients" | "accounts" | "vendors";
let running = false;
/** Every part that is on (or only `parts`), once; the results are kept for the screen. One pass at a time. */
export async function syncAll(actorId: string | null, parts?: SyncPart[]): Promise<Partial<Record<SyncPart, PartResult>> | null> {
  if (running) return null;
  running = true;
  try {
    const s = await quickbooksSettings();
    if (!s.refreshToken || !s.realmId) throw new QuickBooksError("not_connected");
    const out: Partial<Record<SyncPart, PartResult>> = {};
    const on = (p: SyncPart) => (parts ? parts.includes(p) : s.enabled && s.sync[p === "clients" ? "customers" : p]);
    const runs = { ...s.runs };
    if (on("clients")) out.clients = await syncClients().catch((e) => ({ ...blank(), failed: 1, errors: [errText(e)] }));
    if (on("accounts")) {
      const since = runs.accounts?.since ?? new Date().toISOString();
      const res = await syncAccounts(new Date(since)).catch((e) => ({ ...blank(), failed: 1, errors: [errText(e)] }));
      out.accounts = res;
      runs.accounts = { ...res, since };
    }
    if (on("vendors")) out.vendors = await syncVendors().catch((e) => ({ ...blank(), failed: 1, errors: [errText(e)] }));
    if (out.clients) runs.clients = out.clients;
    if (out.vendors) runs.vendors = out.vendors;
    await saveQuickBooksSettings(actorId, { runs });
    return out;
  } finally {
    running = false;
  }
}

/** After a change here: send that record to QuickBooks now when the sync is on; a failure waits for the next pass */
export async function pushSoon(kind: SyncPart, id: string): Promise<void> {
  try {
    const s = await quickbooksSettings();
    if (!s.enabled || !s.refreshToken || !s.realmId || !s.sync[kind === "clients" ? "customers" : kind]) return;
    if (kind === "clients") await pushClient(id);
    else if (kind === "accounts") await pushAccount(id);
    else await pushVendor(id);
  } catch (e) {
    console.warn(`[quickbooks] push ${kind} ${id}:`, errText(e));
  }
}
