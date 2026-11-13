import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings } from "./billing.ts";
import { netCents } from "../../shared/rebate.ts";
import { bankMonths, bankNow, bankRollover, type BankMonth, type BankRollover } from "../../shared/bank.ts";

/**
 * A client's contracts as the ticket view and the time entry see them.
 *
 * Each client has a default support contract (the one picked in the portal,
 * else the source's, else its only active one); a ticket is billed on its own
 * contract, or that default. How the work is billed depends on the contract:
 * Every contract carries a default hourly rate (made with the usual rate of Admin › Facturation, changeable): the time
 * entered under it is billed at that rate, and a rate of 0 means the hours are included. The billing mode adds what else
 * the contract charges:
 *  - hourly: the hours at the rate;
 *  - monthly: a flat monthly rate;
 *  - per_ticket: a flat rate per ticket;
 *  - banked: a block of hours bought; the hours worked are drawn from it;
 *  - fixed: a fixed price;
 *  - none: support is included.
 * The contract types of Admin › Types de contrats each carry one of four kinds (recurring service,
 * hourly, banked hours, fixed price) which sets the billing mode.
 */
export const BILLING_MODES = ["hourly", "monthly", "per_ticket", "none", "banked", "fixed"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const CONTRACT_KINDS = ["recurring", "hourly", "banked", "fixed"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
/** The billing mode a contract of this kind gets */
export const KIND_MODE: Record<ContractKind, BillingMode> = { recurring: "monthly", hourly: "hourly", banked: "banked", fixed: "fixed" };

const STARTER_TYPES: { key: string; name: string; kind: ContractKind }[] = [
  { key: "recurring", name: "Service récurrent", kind: "recurring" },
  { key: "hourly", name: "Taux horaire", kind: "hourly" },
  { key: "banked", name: "Banque d'heures", kind: "banked" },
  { key: "fixed", name: "Prix fixe", kind: "fixed" },
];
/** The contract types in order; the four starter ones are made the first time. */
export async function contractTypes(): Promise<(typeof schema.contractTypes.$inferSelect)[]> {
  const d = db();
  const rows = await d.select().from(schema.contractTypes).orderBy(asc(schema.contractTypes.position), asc(schema.contractTypes.name));
  if (rows.length) return rows;
  await d.insert(schema.contractTypes).values(STARTER_TYPES.map((x, position) => ({ ...x, position }))).onConflictDoNothing();
  return d.select().from(schema.contractTypes).orderBy(asc(schema.contractTypes.position), asc(schema.contractTypes.name));
}

type DefaultRow = { id: string; clientId: string; active: boolean; supportDefault: boolean; isDefault: boolean; sharedWithChildren: boolean };
/**
 * A client's default support contract among every contract row: a child company can point to one of its parent's shared
 * contracts (`clients.support_contract_id`); otherwise the one picked in the portal, the source's, or its only active one.
 */
export function defaultSupport<T extends DefaultRow>(client: { id: string; parentId: string | null; supportContractId: string | null }, all: T[]): T | null {
  const shared = client.supportContractId ? all.find((k) => k.id === client.supportContractId && k.active && k.sharedWithChildren && k.clientId === client.parentId) : undefined;
  if (shared) return shared;
  const own = all.filter((k) => k.clientId === client.id && k.active);
  return own.find((k) => k.supportDefault) ?? own.find((k) => k.isDefault) ?? (own.length === 1 ? own[0]! : null);
}

/**
 * Who is invoiced for work done under a contract when that is not the client it is for (null: the client itself):
 * the parent company owning a contract it shares with its children, or the parent of a child whose contract the parent pays.
 */
export function payerOf(clientId: string, contract: { clientId: string; sharedWithChildren: boolean; billedToParent: boolean } | null | undefined, parentOf: (id: string) => string | null | undefined): string | null {
  if (!contract) return null;
  const parent = parentOf(clientId) ?? null;
  if (!parent) return null;
  if (contract.clientId === parent && contract.sharedWithChildren) return parent;
  if (contract.clientId === clientId && contract.billedToParent) return parent;
  return null;
}

export type ContractView = {
  id: string;
  /** The contract's id in the source, when it has one */
  sourceId: string | null;
  name: string;
  type: string | null;
  mode: BillingMode;
  /** The rate typed on the contract (none: the usual rate applies) */
  hourlyRateCents: number | null;
  /** The contract's rebate (percent × 100): rateCents is already after it */
  rebateBps: number;
  /** What an hour is billed at under this contract: null when hours are not billed */
  rateCents: number | null;
  monthlyRateCents: number | null;
  ticketRateCents: number | null;
  /** The client's default support contract */
  isDefault: boolean;
  /** One of the parent company's contracts, shared with its children (billed to the parent) */
  shared: boolean;
  /** The company that owns the contract (when it is not the client itself) */
  ownerName: string | null;
  /** A child's own contract that the parent company pays */
  billedToParent: boolean;
  /** A parent's contract its children can use */
  sharedWithChildren: boolean;
  /** Hours worked under it are billed */
  billed: boolean;
  /** The contract type (Admin › Types de contrats) */
  typeKey: string | null;
  /** Banked hours: hours bought and hours worked under the contract */
  bankedHours: number | null;
  usedHours: number;
  /** Hours bank: what the portal works out for the current month (hours available incl. carried, used, left) */
  bank?: { hours: number; rateCents: number | null; rollover: BankRollover; available: number; used: number; left: number; over: number } | null;
  fixedPriceCents: number | null;
};

/** What an hour is billed at when the work is under no contract at all (the client has none, or none by default): 100 $ */
export const NO_CONTRACT_HOURLY_CENTS = 10_000;

const modeOf = (v: string): BillingMode => ((BILLING_MODES as readonly string[]).includes(v) ? (v as BillingMode) : "hourly");

/**
 * What an hour costs under a contract (null: hours are not billed under it, they are included).
 * The rate typed on the contract decides: above 0 the hours are billed at it, **0 means no hourly rate: included**.
 * A contract with no rate typed (made before every contract had one) keeps its old rule: an hourly one bills the usual
 * rate of Admin › Facturation, any other does not bill hours.
 */
export function hourlyRateOf(k: { billingMode: string; hourlyRateCents: number | null; rebateBps?: number | null }, usualHourlyDollars: number): number | null {
  // an hours bank is bought up front: the hours worked are drawn from it, never billed one by one
  if (modeOf(k.billingMode) === "banked") return null;
  // the rebate of the contract is taken off the hourly rate
  if (k.hourlyRateCents != null) return k.hourlyRateCents > 0 ? netCents(k.hourlyRateCents, k.rebateBps) : null;
  return modeOf(k.billingMode) === "hourly" ? netCents(Math.round(usualHourlyDollars * 100), k.rebateBps) : null;
}

/** The client's active contracts (by the ticket-side company id), the default one flagged. */
export async function contractsOfCompany(companyAt: number): Promise<ContractView[]> {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id, parentId: schema.clients.parentId, supportContractId: schema.clients.supportContractId }).from(schema.clients).where(eq(schema.clients.autotaskId, companyAt));
  if (!client) return [];
  // its own active contracts, and the ones its parent company shares with its children
  const rows = await d
    .select()
    .from(schema.clientContracts)
    .where(and(eq(schema.clientContracts.active, true), client.parentId ? or(eq(schema.clientContracts.clientId, client.id), and(eq(schema.clientContracts.clientId, client.parentId), eq(schema.clientContracts.sharedWithChildren, true))) : eq(schema.clientContracts.clientId, client.id)))
    .orderBy(asc(schema.clientContracts.name));
  if (!rows.length) return [];
  const owners = new Map((await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, [...new Set(rows.map((k) => k.clientId))]))).map((o) => [o.id, o.name]));
  const usual = (await billingSettings()).rates.hourly;
  const chosen = defaultSupport(client, rows);
  const used = await usedHoursOf(rows);
  const bank = await banksOf(rows);
  return rows.map((k) => {
    const mode = modeOf(k.billingMode);
    return {
      id: k.id,
      sourceId: k.autotaskId,
      name: k.name,
      type: k.type,
      mode,
      hourlyRateCents: k.hourlyRateCents,
      rebateBps: k.rebateBps,
      rateCents: hourlyRateOf(k, usual),
      monthlyRateCents: k.monthlyRateCents,
      ticketRateCents: k.ticketRateCents,
      isDefault: chosen?.id === k.id,
      shared: k.clientId !== client.id,
      ownerName: k.clientId !== client.id ? (owners.get(k.clientId) ?? null) : null,
      billedToParent: k.billedToParent,
      sharedWithChildren: k.sharedWithChildren,
      billed: hourlyRateOf(k, usual) != null,
      typeKey: k.typeKey,
      bankedHours: bank.get(k.id)?.available ?? (k.bankedHoursX100 == null ? null : k.bankedHoursX100 / 100),
      usedHours: bank.get(k.id)?.used ?? used.get(k.id) ?? 0,
      bank: bank.get(k.id) ?? null,
      fixedPriceCents: k.fixedPriceCents,
    };
  });
}

/** Hours worked on project tasks under these contracts (by contract, day and client); ticket time shown in a project is counted through its ticket */
async function projectTimeOf(contractIds: string[]): Promise<{ id: string; date: string; hours: number; company: string }[]> {
  if (!contractIds.length) return [];
  const rows = await db()
    .select({ id: schema.timesheetEntries.contractId, date: schema.timesheetEntries.date, h: schema.timesheetEntries.hoursX100, company: schema.clients.name })
    .from(schema.timesheetEntries)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.timesheetEntries.clientId))
    .where(and(inArray(schema.timesheetEntries.contractId, contractIds), eq(schema.timesheetEntries.source, "project"), isNull(schema.timesheetEntries.ticketTimeId)));
  return rows.filter((r) => r.id).map((r) => ({ id: r.id!, date: r.date, hours: r.h / 100, company: r.company ?? "" }));
}

/** Hours worked under each contract (ticket time entries, which carry the contract's source id). Keyed by the contract's id. */
export async function usedHoursOf(contracts: { id: string; autotaskId: string | null }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bySource = new Map(contracts.filter((k) => k.autotaskId).map((k) => [k.autotaskId!, k.id]));
  // hours worked on project tasks under the contract count like a ticket's
  for (const r of await projectTimeOf(contracts.map((k) => k.id))) out.set(r.id, Math.round(((out.get(r.id) ?? 0) + r.hours) * 100) / 100);
  if (!bySource.size) return out;
  const rows = await db().select({ id: schema.ticketTimeEntries.contractId, minutes: schema.ticketTimeEntries.minutes }).from(schema.ticketTimeEntries).where(inArray(schema.ticketTimeEntries.contractId, [...bySource.keys()]));
  for (const r of rows) {
    const id = r.id ? bySource.get(r.id) : undefined;
    if (id) out.set(id, Math.round(((out.get(id) ?? 0) + r.minutes / 60) * 100) / 100);
  }
  return out;
}

/** Hours worked under each contract, month by month (YYYY-MM, Québec time). Keyed by the contract's id. */
export async function usedByMonthOf(contracts: { id: string; autotaskId: string | null }[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const bySource = new Map(contracts.filter((k) => k.autotaskId).map((k) => [k.autotaskId!, k.id]));
  // time worked on project tasks under the contract is drawn from the bank too, like a ticket's
  for (const r of await projectTimeOf(contracts.map((k) => k.id))) {
    const m = out.get(r.id) ?? new Map<string, number>();
    m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) ?? 0) + r.hours);
    out.set(r.id, m);
  }
  if (!bySource.size) return out;
  const rows = await db().select({ id: schema.ticketTimeEntries.contractId, minutes: schema.ticketTimeEntries.minutes, at: schema.ticketTimeEntries.startedAt, overMinutes: schema.ticketTimeEntries.bankOverMinutes, overMode: schema.ticketTimeEntries.bankOverMode }).from(schema.ticketTimeEntries).where(inArray(schema.ticketTimeEntries.contractId, [...bySource.keys()]));
  for (const r of rows) {
    const id = r.id ? bySource.get(r.id) : undefined;
    if (!id) continue;
    // minutes past the bank that were billed, bought as extra hours or given are not drawn from it (only "debt" ones are)
    const counted = r.minutes - (r.overMode && r.overMode !== "debt" ? Math.min(r.minutes, r.overMinutes) : 0);
    const month = r.at.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).slice(0, 7);
    const m = out.get(id) ?? new Map<string, number>();
    m.set(month, (m.get(month) ?? 0) + counted / 60);
    out.set(id, m);
  }
  return out;
}

/** Who used a contract's hours: hours by company and month (a parent company and its children can share one hours bank). Keyed by the contract's id. */
export async function usageByCompanyOf(contracts: { id: string; autotaskId: string | null }[]): Promise<Map<string, { company: string; month: string; hours: number }[]>> {
  const out = new Map<string, Map<string, number>>();
  const bySource = new Map(contracts.filter((k) => k.autotaskId).map((k) => [k.autotaskId!, k.id]));
  for (const r of await projectTimeOf(contracts.map((k) => k.id))) {
    const m = out.get(r.id) ?? new Map<string, number>();
    const key = `${r.date.slice(0, 7)}|${r.company}`;
    m.set(key, (m.get(key) ?? 0) + r.hours);
    out.set(r.id, m);
  }
  if (!bySource.size && !out.size) return new Map();
  const rows = await db()
    .select({ id: schema.ticketTimeEntries.contractId, minutes: schema.ticketTimeEntries.minutes, at: schema.ticketTimeEntries.startedAt, overMinutes: schema.ticketTimeEntries.bankOverMinutes, overMode: schema.ticketTimeEntries.bankOverMode, company: schema.tickets.companyName })
    .from(schema.ticketTimeEntries)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketTimeEntries.ticketId))
    .where(inArray(schema.ticketTimeEntries.contractId, [...bySource.keys()]));
  for (const r of rows) {
    const id = r.id ? bySource.get(r.id) : undefined;
    if (!id) continue;
    // the same hours the bank counts: minutes past it that were billed, bought or given are not drawn from it
    const counted = r.minutes - (r.overMode && r.overMode !== "debt" ? Math.min(r.minutes, r.overMinutes) : 0);
    const month = r.at.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).slice(0, 7);
    const m = out.get(id) ?? new Map<string, number>();
    const key = `${month}|${r.company}`;
    m.set(key, (m.get(key) ?? 0) + counted / 60);
    out.set(id, m);
  }
  return new Map([...out].map(([id, m]) => [id, [...m].map(([key, hours]) => ({ month: key.slice(0, 7), company: key.slice(8), hours: Math.round(hours * 100) / 100 })).sort((x, y) => (x.month < y.month ? 1 : x.month > y.month ? -1 : x.company.localeCompare(y.company)))]));
}

type BankRow = { rebateBps?: number; id: string; autotaskId: string | null; billingMode: string; bankedHoursX100: number | null; bankRateCents: number | null; bankRollover: string; startDate: string | null; endDate: string | null; endedOn: string | null };
const todayQuebec = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
/** The month-by-month bank of one contract (empty when it is not an hours bank) */
export function bankRowsOf(k: BankRow, used: Map<string, number> | undefined, today = todayQuebec(), adjust?: Map<string, number>, project = false): BankMonth[] {
  if (modeOf(k.billingMode) !== "banked" || !k.bankedHoursX100) return [];
  return bankMonths({ hours: k.bankedHoursX100 / 100, rollover: bankRollover(k.bankRollover), start: k.startDate, end: k.endDate, endedOn: k.endedOn, today, used: used ?? new Map(), adjust, project });
}
/** Hours put on or taken off each hours bank by hand, month by month (YYYY-MM). Keyed by the contract's id. */
export async function adjustmentsOf(contractIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!contractIds.length) return out;
  const rows = await db().select({ id: schema.contractBankAdjustments.contractId, day: schema.contractBankAdjustments.day, h: schema.contractBankAdjustments.hoursX100 }).from(schema.contractBankAdjustments).where(inArray(schema.contractBankAdjustments.contractId, contractIds));
  for (const r of rows) {
    const m = out.get(r.id) ?? new Map<string, number>();
    m.set(r.day.slice(0, 7), (m.get(r.day.slice(0, 7)) ?? 0) + r.h / 100);
    out.set(r.id, m);
  }
  return out;
}
/** Where each hours bank stands this month (only the banked contracts are in the map) */
export async function banksOf(contracts: BankRow[], today = todayQuebec()): Promise<Map<string, NonNullable<ContractView["bank"]>>> {
  const out = new Map<string, NonNullable<ContractView["bank"]>>();
  const banked = contracts.filter((k) => modeOf(k.billingMode) === "banked" && k.bankedHoursX100);
  if (!banked.length) return out;
  const used = await usedByMonthOf(banked);
  const adjust = await adjustmentsOf(banked.map((k) => k.id));
  for (const k of banked) {
    const now = bankNow(bankRowsOf(k, used.get(k.id), today, adjust.get(k.id)), today);
    out.set(k.id, { hours: k.bankedHoursX100! / 100, rateCents: k.bankRateCents == null ? null : netCents(k.bankRateCents, k.rebateBps), rollover: bankRollover(k.bankRollover), ...(now ?? { available: k.bankedHoursX100! / 100, used: 0, left: k.bankedHoursX100! / 100, over: 0 }) });
  }
  return out;
}

/** A ticket's contract: the one stored on it, else the client's default. `chosen`: set on the ticket itself. */
export async function contractOfTicket(ticketId: number, companyAt: number): Promise<{ contract: ContractView | null; contracts: ContractView[]; chosen: boolean }> {
  const [list, [meta]] = await Promise.all([
    contractsOfCompany(companyAt),
    db().select({ id: schema.ticketMeta.contractId }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, ticketId)),
  ]);
  const own = meta?.id ? list.find((k) => k.id === meta.id) : undefined;
  return { contract: own ?? list.find((k) => k.isDefault) ?? null, contracts: list, chosen: Boolean(own) };
}

/** Remember a ticket's contract (null: back to the client's default). */
export async function setTicketContract(ticketId: number, contractId: string | null, userId: string | null) {
  await db()
    .insert(schema.ticketMeta)
    .values({ ticketId, contractId, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { contractId, updatedBy: userId, updatedAt: new Date() } });
}

/** For hours banks that top up: the hours each month will buy (this month and the next ones, foreseen with no more work), by contract id */
export async function topupHoursOf(contracts: BankRow[], today = todayQuebec()): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const mine = contracts.filter((k) => modeOf(k.billingMode) === "banked" && k.bankedHoursX100 && bankRollover(k.bankRollover) === "topup");
  if (!mine.length) return out;
  const used = await usedByMonthOf(mine);
  const adjust = await adjustmentsOf(mine.map((k) => k.id));
  for (const k of mine) out.set(k.id, new Map(bankRowsOf(k, used.get(k.id), today, adjust.get(k.id), true).map((r) => [r.month, r.charge])));
  return out;
}
