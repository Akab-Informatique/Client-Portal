import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { contractCharges, type ChargeLine } from "../../shared/contractCharges.ts";

/** Labour cost of the hours worked under a contract (all time up to now), at each technician's hourly wage */
async function labourSoFar(autotaskId: string | null) {
  if (!autotaskId) return { hours: 0, costCents: 0, missingWages: 0 };
  const times = await db().select({ minutes: schema.ticketTimeEntries.minutes, userId: schema.ticketTimeEntries.userId }).from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.contractId, autotaskId));
  const ids = [...new Set(times.map((t) => t.userId).filter((x): x is string => Boolean(x)))];
  const wages = new Map((ids.length ? await db().select().from(schema.hrProfiles).where(inArray(schema.hrProfiles.userId, ids)) : []).map((p) => [p.userId, p.hourlyWageCents]));
  let hours = 0;
  let costCents = 0;
  const noWage = new Set<string>();
  for (const t of times) {
    hours += t.minutes / 60;
    const wage = t.userId ? wages.get(t.userId) : null;
    if (wage) costCents += Math.round((t.minutes / 60) * wage);
    else noWage.add(t.userId ?? "?");
  }
  return { hours: Math.round(hours * 100) / 100, costCents, missingWages: noWage.size };
}

/**
 * The profit a contract can still make over its whole term (administrators only): everything it will charge over the term
 * (`revenueCents`, after rebates) less what its services cost over the same term and the labour already worked under it
 * (hours × each technician's wage). The hours still to come are not guessed.
 */
export async function potentialProfit(k: { id: string; autotaskId: string | null; startDate: string | null; endDate: string | null; endedOn: string | null; billingPeriod: string }, services: { id: string; name: string; kind: string; costCents: number; quantity: number; addedOn: string }[], revenueCents: number) {
  const period = k.billingPeriod === "yearly" ? "yearly" : "monthly";
  const costs = contractCharges(
    { startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: period },
    services.map((s): ChargeLine => ({ id: s.id, name: s.name, kind: s.kind === "recurring_yearly" ? "recurring_yearly" : "recurring", priceCents: s.costCents, quantity: s.quantity, addedOn: s.addedOn })),
  );
  const labour = await labourSoFar(k.autotaskId);
  const profitCents = revenueCents - costs.revenueCents - labour.costCents;
  return { revenueCents, serviceCostCents: costs.revenueCents, labourCostCents: labour.costCents, hours: labour.hours, missingWages: labour.missingWages, profitCents, marginPct: revenueCents > 0 ? Math.round((profitCents / revenueCents) * 1000) / 10 : null };
}
