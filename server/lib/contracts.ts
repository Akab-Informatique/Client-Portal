import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings } from "./billing.ts";

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

export type ContractView = {
  id: string;
  /** The contract's id in the source, when it has one */
  sourceId: string | null;
  name: string;
  type: string | null;
  mode: BillingMode;
  /** The rate typed on the contract (none: the usual rate applies) */
  hourlyRateCents: number | null;
  /** What an hour is billed at under this contract: null when hours are not billed */
  rateCents: number | null;
  monthlyRateCents: number | null;
  ticketRateCents: number | null;
  /** The client's default support contract */
  isDefault: boolean;
  /** Hours worked under it are billed */
  billed: boolean;
  /** The contract type (Admin › Types de contrats) */
  typeKey: string | null;
  /** Banked hours: hours bought and hours worked under the contract */
  bankedHours: number | null;
  usedHours: number;
  fixedPriceCents: number | null;
};

const modeOf = (v: string): BillingMode => ((BILLING_MODES as readonly string[]).includes(v) ? (v as BillingMode) : "hourly");

/**
 * What an hour costs under a contract (null: hours are not billed under it, they are included).
 * The rate typed on the contract decides: above 0 the hours are billed at it, **0 means no hourly rate: included**.
 * A contract with no rate typed (made before every contract had one) keeps its old rule: an hourly one bills the usual
 * rate of Admin › Facturation, any other does not bill hours.
 */
export function hourlyRateOf(k: { billingMode: string; hourlyRateCents: number | null }, usualHourlyDollars: number): number | null {
  if (k.hourlyRateCents != null) return k.hourlyRateCents > 0 ? k.hourlyRateCents : null;
  return modeOf(k.billingMode) === "hourly" ? Math.round(usualHourlyDollars * 100) : null;
}

/** The client's active contracts (by the ticket-side company id), the default one flagged. */
export async function contractsOfCompany(companyAt: number): Promise<ContractView[]> {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, companyAt));
  if (!client) return [];
  const rows = await d
    .select()
    .from(schema.clientContracts)
    .where(and(eq(schema.clientContracts.clientId, client.id), eq(schema.clientContracts.active, true)))
    .orderBy(asc(schema.clientContracts.name));
  if (!rows.length) return [];
  const usual = (await billingSettings()).rates.hourly;
  const chosen = rows.find((k) => k.supportDefault) ?? rows.find((k) => k.isDefault) ?? (rows.length === 1 ? rows[0] : null);
  const used = await usedHoursOf(rows);
  return rows.map((k) => {
    const mode = modeOf(k.billingMode);
    return {
      id: k.id,
      sourceId: k.autotaskId,
      name: k.name,
      type: k.type,
      mode,
      hourlyRateCents: k.hourlyRateCents,
      rateCents: hourlyRateOf(k, usual),
      monthlyRateCents: k.monthlyRateCents,
      ticketRateCents: k.ticketRateCents,
      isDefault: chosen?.id === k.id,
      billed: hourlyRateOf(k, usual) != null,
      typeKey: k.typeKey,
      bankedHours: k.bankedHoursX100 == null ? null : k.bankedHoursX100 / 100,
      usedHours: used.get(k.id) ?? 0,
      fixedPriceCents: k.fixedPriceCents,
    };
  });
}

/** Hours worked under each contract (ticket time entries, which carry the contract's source id). Keyed by the contract's id. */
export async function usedHoursOf(contracts: { id: string; autotaskId: string | null }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bySource = new Map(contracts.filter((k) => k.autotaskId).map((k) => [k.autotaskId!, k.id]));
  if (!bySource.size) return out;
  const rows = await db().select({ id: schema.ticketTimeEntries.contractId, minutes: schema.ticketTimeEntries.minutes }).from(schema.ticketTimeEntries).where(inArray(schema.ticketTimeEntries.contractId, [...bySource.keys()]));
  for (const r of rows) {
    const id = r.id ? bySource.get(r.id) : undefined;
    if (id) out.set(id, Math.round(((out.get(id) ?? 0) + r.minutes / 60) * 100) / 100);
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
