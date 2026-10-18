import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { ticketSource, type CrmExport } from "./ticketSource.ts";
import { billingSettings } from "./billing.ts";
import { revokeUserSessions } from "./auth.ts";
import { forgetPasswordLinks } from "./passwordLinks.ts";

/**
 * The CRM: the portal's own copy of the clients, their contacts and their
 * contracts. While Autotask is linked, a sync copies everything from it
 * (Autotask is the reference) and the portal's own changes are sent to it
 * first; the day it is unlinked, the portal already has everything.
 *
 * Portal-only fields (notes, invoice settings, code, email) are never
 * overwritten by a sync.
 */
const STATE_KEY = "autotask.crm";
/** A full copy every 15 minutes (a few calls: 500 rows per page) */
export const CRM_SYNC_EVERY = 15 * 60_000;

export type CrmState = {
  source: "autotask" | "sample";
  at: string | null;
  ok: boolean;
  error: string | null;
  counts: { clients: number; contacts: number; contracts: number; invoices?: number };
};

export async function crmState(): Promise<CrmState | null> {
  const [row] = await db().select().from(schema.syncState).where(eq(schema.syncState.key, STATE_KEY));
  return (row?.data as CrmState | undefined) ?? null;
}

async function saveState(s: CrmState) {
  await db()
    .insert(schema.syncState)
    .values({ key: STATE_KEY, data: s })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { data: s, updatedAt: new Date() } });
}

let running: Promise<CrmState> | null = null;

/** Copy every client, contact and contract from the source (one at a time). */
export function syncCrm(): Promise<CrmState> {
  running ??= (async () => {
    const src = await ticketSource();
    const source = src.demo ? "sample" : "autotask";
    const before = await crmState();
    try {
      const data = await src.crmExport();
      const counts = await apply(data);
      const s: CrmState = { source, at: new Date().toISOString(), ok: true, error: null, counts };
      await saveState(s);
      return s;
    } catch (e) {
      const s: CrmState = { source, at: before?.at ?? null, ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e), counts: before?.counts ?? { clients: 0, contacts: 0, contracts: 0 } };
      await saveState(s);
      console.warn("[crm] sync failed:", s.error);
      return s;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** The first copy, when there is none yet (e.g. a fresh database). */
export async function ensureCrm() {
  const s = await crmState();
  if (!s?.at) await syncCrm();
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

async function apply(data: CrmExport) {
  const d = db();
  const now = new Date();

  // ── clients: by Autotask id, else a portal client of the same name (linked then)
  const local = await d.select().from(schema.clients);
  const byAt = new Map(local.filter((c) => c.autotaskId != null).map((c) => [c.autotaskId!, c]));
  const byName = new Map(local.filter((c) => c.autotaskId == null).map((c) => [c.name.trim().toLowerCase(), c]));
  const idOf = new Map<number, string>();
  for (const c of data.companies) {
    const fields = { name: c.name, phone: c.phone, address: c.address, city: c.city, province: c.province, postalCode: c.postalCode, website: c.website };
    const hit = byAt.get(c.id) ?? byName.get(c.name.trim().toLowerCase());
    if (!hit) {
      const [row] = await d
        .insert(schema.clients)
        .values({ ...fields, autotaskId: c.id, syncedAt: now })
        .returning({ id: schema.clients.id });
      idOf.set(c.id, row.id);
      continue;
    }
    idOf.set(c.id, hit.id);
    byName.delete(hit.name.trim().toLowerCase());
    const changed = hit.autotaskId !== c.id || !hit.active || (Object.keys(fields) as (keyof typeof fields)[]).some((k) => !same(hit[k], fields[k]));
    if (changed) await d.update(schema.clients).set({ ...fields, autotaskId: c.id, active: true, syncedAt: now, updatedAt: now }).where(eq(schema.clients.id, hit.id));
  }
  // parent companies (Autotask is the reference while linked)
  const parents = new Map((await d.select({ id: schema.clients.id, parentId: schema.clients.parentId }).from(schema.clients)).map((r) => [r.id, r.parentId]));
  for (const c of data.companies) {
    const id = idOf.get(c.id)!;
    const parent = c.parentId != null ? (idOf.get(c.parentId) ?? null) : null;
    if (parent !== id && !same(parents.get(id), parent)) await d.update(schema.clients).set({ parentId: parent, updatedAt: now }).where(eq(schema.clients.id, id));
  }
  // gone from the source (deactivated there): kept, marked inactive
  const seen = new Set(data.companies.map((c) => c.id));
  const gone = local.filter((c) => c.autotaskId != null && c.active && !seen.has(c.autotaskId)).map((c) => c.id);
  if (gone.length) await d.update(schema.clients).set({ active: false, updatedAt: now }).where(inArray(schema.clients.id, gone));

  // ── contacts
  const contacts = new Map((await d.select().from(schema.clientContacts).where(isNotNull(schema.clientContacts.autotaskId))).map((c) => [c.autotaskId!, c]));
  let nContacts = 0;
  for (const c of data.contacts) {
    const clientId = idOf.get(c.companyId);
    if (!clientId) continue;
    nContacts++;
    const fields = { clientId, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, mobile: c.mobile, title: c.title };
    const hit = contacts.get(c.id);
    if (!hit) await d.insert(schema.clientContacts).values({ ...fields, autotaskId: c.id, syncedAt: now });
    else if (!hit.active || (Object.keys(fields) as (keyof typeof fields)[]).some((k) => !same(hit[k], fields[k])))
      await d.update(schema.clientContacts).set({ ...fields, active: true, syncedAt: now, updatedAt: now }).where(eq(schema.clientContacts.id, hit.id));
  }
  const seenContacts = new Set(data.contacts.map((c) => c.id));
  const goneRows = [...contacts.values()].filter((c) => c.active && !seenContacts.has(c.autotaskId!));
  const goneContacts = goneRows.map((c) => c.id);
  if (goneContacts.length) await d.update(schema.clientContacts).set({ active: false, updatedAt: now }).where(inArray(schema.clientContacts.id, goneContacts));
  // their client portal account goes too (someone who left the client company)
  for (const c of goneRows.filter((x) => x.userId)) {
    await d.update(schema.users).set({ active: false, updatedAt: now }).where(eq(schema.users.id, c.userId!));
    await revokeUserSessions(c.userId!);
    await forgetPasswordLinks(c.userId!);
  }

  // ── contracts
  const contracts = new Map((await d.select().from(schema.clientContracts).where(isNotNull(schema.clientContracts.autotaskId))).map((k) => [k.autotaskId!, k]));
  let nContracts = 0;
  for (const k of data.contracts) {
    const clientId = idOf.get(k.companyId);
    if (!clientId) continue;
    nContracts++;
    const fields = { clientId, name: k.name, type: k.type, isDefault: k.isDefault, startDate: k.startDate, endDate: k.endDate };
    const hit = contracts.get(k.id);
    if (!hit) await d.insert(schema.clientContracts).values({ ...fields, autotaskId: k.id, syncedAt: now });
    else if (!hit.active || (Object.keys(fields) as (keyof typeof fields)[]).some((x) => !same(hit[x], fields[x])))
      await d.update(schema.clientContracts).set({ ...fields, active: true, syncedAt: now, updatedAt: now }).where(eq(schema.clientContracts.id, hit.id));
  }
  const seenContracts = new Set(data.contracts.map((k) => k.id));
  const goneContracts = [...contracts.values()].filter((k) => k.active && !seenContracts.has(k.autotaskId!)).map((k) => k.id);
  if (goneContracts.length) await d.update(schema.clientContracts).set({ active: false, updatedAt: now }).where(inArray(schema.clientContracts.id, goneContracts));

  // ── invoices (never removed: a voided invoice says so)
  let nInvoices = 0;
  if (data.invoicesRead !== false) {
    // only the invoices from the date and number set in Admin › Facturation
    const w = (await billingSettings()).autotask;
    const inWindow = (v: { issuedOn: string; number: string }) => {
      if (v.issuedOn < w.invoicesSince) return false;
      if (w.invoiceMinNumber == null) return true;
      const n = Number(v.number.replace(/\D/g, ""));
      return Number.isFinite(n) && v.number.replace(/\D/g, "") !== "" && n >= w.invoiceMinNumber;
    };
    const wanted = data.invoices.filter(inWindow);
    const invoices = new Map((await d.select().from(schema.clientInvoices).where(isNotNull(schema.clientInvoices.autotaskId))).map((v) => [v.autotaskId!, v]));
    // copies made before (outside the window): removed, unless they carry payments or went to QuickBooks
    const keep = new Set(wanted.map((v) => v.id));
    const outside = [...invoices.values()].filter((v) => v.source === "autotask" && !keep.has(v.autotaskId!) && !v.quickbooksId);
    if (outside.length) {
      const paid = new Set((await d.select({ id: schema.invoicePayments.invoiceId }).from(schema.invoicePayments).where(inArray(schema.invoicePayments.invoiceId, outside.map((v) => v.id)))).map((x) => x.id));
      const drop = outside.filter((v) => !paid.has(v.id)).map((v) => v.id);
      if (drop.length) await d.delete(schema.clientInvoices).where(inArray(schema.clientInvoices.id, drop));
    }
    for (const v of wanted) {
      const clientId = idOf.get(v.companyId);
      if (!clientId) continue;
      nInvoices++;
      const fields = { clientId, number: v.number, issuedOn: v.issuedOn, dueOn: v.dueOn, totalCents: v.totalCents, taxCents: v.taxCents, paidOn: v.paidOn, voided: v.voided };
      const hit = invoices.get(v.id);
      if (!hit) await d.insert(schema.clientInvoices).values({ ...fields, autotaskId: v.id, syncedAt: now });
      else if ((Object.keys(fields) as (keyof typeof fields)[]).some((k) => !same(hit[k], fields[k])))
        await d.update(schema.clientInvoices).set({ ...fields, syncedAt: now, updatedAt: now }).where(eq(schema.clientInvoices.id, hit.id));
    }
  }

  return { clients: data.companies.length, contacts: nContacts, contracts: nContracts, invoices: nInvoices };
}

// ── Portal writes, kept in the copy right away (no wait for the next sync) ──

/** A client just created in the source (e.g. from the new ticket form). */
export async function rememberCompany(c: { id: number; name: string; phone?: string | null }) {
  const d = db();
  const [hit] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, c.id));
  if (hit) return hit.id;
  const [row] = await d
    .insert(schema.clients)
    .values({ name: c.name, phone: c.phone ?? null, autotaskId: c.id, syncedAt: new Date() })
    .returning({ id: schema.clients.id });
  return row.id;
}

/** A contact just created in the source, for the client with that source id. */
export async function rememberContact(companyId: number, c: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null; mobile?: string | null; title?: string | null }) {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, companyId));
  if (!client) return;
  await d
    .insert(schema.clientContacts)
    .values({ clientId: client.id, autotaskId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, mobile: c.mobile ?? null, title: c.title ?? null, syncedAt: new Date() })
    .onConflictDoNothing();
}

// ── Reads for the tickets (clients, contacts, contracts by source id) ──

/** Clients known to the source, from the portal's copy (null: no copy yet). */
export async function localCompanies(): Promise<{ id: number; name: string }[] | null> {
  if (!(await crmState())?.at) return null;
  const rows = await db()
    .select({ id: schema.clients.autotaskId, name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.active, true), isNotNull(schema.clients.autotaskId)))
    .orderBy(asc(schema.clients.name));
  return rows.map((r) => ({ id: r.id!, name: r.name }));
}

export async function localContacts(companyId: number) {
  if (!(await crmState())?.at) return null;
  const rows = await db()
    .select({ c: schema.clientContacts })
    .from(schema.clientContacts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
    .where(and(eq(schema.clients.autotaskId, companyId), eq(schema.clientContacts.active, true), isNotNull(schema.clientContacts.autotaskId)));
  return rows
    .map(({ c }) => ({ id: c.autotaskId!, companyId, name: `${c.firstName} ${c.lastName}`.trim(), email: c.email, phone: c.phone ?? c.mobile }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

export async function localContracts(companyId: number) {
  if (!(await crmState())?.at) return null;
  const rows = await db()
    .select({ k: schema.clientContracts })
    .from(schema.clientContracts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContracts.clientId))
    .where(and(eq(schema.clients.autotaskId, companyId), eq(schema.clientContracts.active, true), isNotNull(schema.clientContracts.autotaskId)));
  return rows
    .map(({ k }) => ({ id: k.autotaskId!, name: k.name, isDefault: k.isDefault, endDate: k.endDate }))
    .sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name));
}

/** Children of a client, any depth (to refuse a loop when choosing a parent). */
export async function descendantsOf(id: string): Promise<Set<string>> {
  const rows = await db().select({ id: schema.clients.id, parentId: schema.clients.parentId }).from(schema.clients).where(isNotNull(schema.clients.parentId));
  const out = new Set<string>();
  const walk = (p: string) => {
    for (const r of rows) if (r.parentId === p && !out.has(r.id)) (out.add(r.id), walk(r.id));
  };
  walk(id);
  return out;
}
