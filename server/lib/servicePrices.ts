import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { recordContractEvent, syncMonthlyRate } from "./contractEvents.ts";

/**
 * A price (or cost) of a service and the contract lines made from it. Changing one never moves the others silently: the
 * person is asked ("scope") whether the other contracts that are still running follow, or only future additions do.
 */
export type MoneyChange = { priceCents?: number; costCents?: number };

/** The lines of a service on contracts that are still running (active), optionally without one line */
export async function runningLinesOf(serviceId: string, exceptLineId?: string) {
  return db()
    .select({ id: schema.contractServices.id, contractId: schema.contractServices.contractId, name: schema.contractServices.name, priceCents: schema.contractServices.priceCents, costCents: schema.contractServices.costCents })
    .from(schema.contractServices)
    .innerJoin(schema.clientContracts, eq(schema.clientContracts.id, schema.contractServices.contractId))
    .where(and(eq(schema.contractServices.serviceId, serviceId), eq(schema.clientContracts.active, true), exceptLineId ? ne(schema.contractServices.id, exceptLineId) : undefined));
}

/** How many contracts these lines are in */
export const contractsIn = (lines: { contractId: string }[]) => new Set(lines.map((l) => l.contractId)).size;

/** Put a new price and / or cost on these lines, one event on each contract, and keep their monthly figure right. */
export async function applyToLines(lines: { id: string; contractId: string; name: string; priceCents: number; costCents: number }[], change: MoneyChange, by: { userId?: string | null; source?: "user" | "itcloud" }) {
  if (!lines.length) return;
  const d = db();
  const set = { ...(change.priceCents !== undefined ? { priceCents: change.priceCents } : {}), ...(change.costCents !== undefined ? { costCents: change.costCents } : {}) };
  if (!Object.keys(set).length) return;
  await d.update(schema.contractServices).set(set).where(inArray(schema.contractServices.id, lines.map((l) => l.id)));
  for (const l of lines) {
    const changes: Record<string, [unknown, unknown]> = {};
    if (change.priceCents !== undefined && change.priceCents !== l.priceCents) changes.priceCents = [l.priceCents, change.priceCents];
    if (change.costCents !== undefined && change.costCents !== l.costCents) changes.costCents = [l.costCents, change.costCents];
    if (Object.keys(changes).length) await recordContractEvent(l.contractId, "service_changed", { name: l.name, changes }, by);
  }
  for (const id of new Set(lines.map((l) => l.contractId))) await syncMonthlyRate(id);
}
