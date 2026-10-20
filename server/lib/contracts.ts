import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings } from "./billing.ts";

/**
 * A client's contracts as the ticket view and the time entry see them.
 *
 * Each client has a default support contract (the one picked in the portal,
 * else the source's, else its only active one); a ticket is billed on its own
 * contract, or that default. How the work is billed depends on the contract:
 *  - hourly: the contract's hourly rate, else the usual rate of Admin › Facturation;
 *  - monthly: a flat monthly rate, the hours are not billed;
 *  - per_ticket: a flat rate per ticket, the hours are not billed;
 *  - none: support is included, never billed.
 */
export const BILLING_MODES = ["hourly", "monthly", "per_ticket", "none"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export type ContractView = {
  id: string;
  /** The contract's id in the source (Autotask), when it has one */
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
};

const modeOf = (v: string): BillingMode => ((BILLING_MODES as readonly string[]).includes(v) ? (v as BillingMode) : "hourly");

/** What an hour costs under a contract (null: hours are not billed under it). */
export function hourlyRateOf(k: { billingMode: string; hourlyRateCents: number | null }, usualHourlyDollars: number): number | null {
  return modeOf(k.billingMode) === "hourly" ? (k.hourlyRateCents ?? Math.round(usualHourlyDollars * 100)) : null;
}

/** The client's active contracts (by Autotask company id), the default one flagged. */
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
      billed: mode === "hourly",
    };
  });
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
