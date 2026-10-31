import { combineBps, netCents } from "../../shared/rebate.ts";
import { and, count, desc, eq, lte } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * The activity of a contract (Contracts tab › a contract › Activité): what was added, changed or removed, and by
 * whom (a person, or the ITCloud sync). Written where the change is made.
 */
export type ContractEventKind = "created" | "updated" | "service_added" | "service_changed" | "service_removed" | "stopped" | "resumed";

export async function recordContractEvent(contractId: string, kind: ContractEventKind, detail: Record<string, unknown>, by: { userId?: string | null; source?: "user" | "itcloud" } = {}): Promise<void> {
  await db()
    .insert(schema.contractEvents)
    .values({ contractId, kind, detail, actorId: by.userId ?? null, source: by.source ?? "user" });
}

export async function contractEventsOf(contractId: string, limit = 300) {
  const rows = await db()
    .select({ e: schema.contractEvents, actor: schema.users.name })
    .from(schema.contractEvents)
    .leftJoin(schema.users, eq(schema.users.id, schema.contractEvents.actorId))
    .where(eq(schema.contractEvents.contractId, contractId))
    .orderBy(desc(schema.contractEvents.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.e.id, kind: r.e.kind, source: r.e.source, detail: r.e.detail, at: r.e.createdAt.toISOString(), actor: r.actor ?? null }));
}

/**
 * Has billing started on a contract? Work to bill under it, time logged on it, or a recurring service whose
 * first day has come. A contract that has is never deleted: it is stopped (made inactive) so what was done stays.
 */
export async function contractCharged(contractId: string, today: string): Promise<{ has: boolean; billingItems: number; timeEntries: number; servicesStarted: number }> {
  const [[b], [t], [s]] = await Promise.all([
    db().select({ n: count() }).from(schema.billingItems).where(eq(schema.billingItems.contractId, contractId)),
    db().select({ n: count() }).from(schema.timesheetEntries).where(eq(schema.timesheetEntries.contractId, contractId)),
    db()
      .select({ n: count() })
      .from(schema.contractServices)
      .where(and(eq(schema.contractServices.contractId, contractId), lte(schema.contractServices.addedOn, today))),
  ]);
  const out = { billingItems: b?.n ?? 0, timeEntries: t?.n ?? 0, servicesStarted: s?.n ?? 0 };
  return { has: out.billingItems + out.timeEntries + out.servicesStarted > 0, ...out };
}

/** A recurring contract shows its monthly charge where the portal used to ask for it: the monthly services plus a twelfth of the yearly ones */
export async function syncMonthlyRate(contractId: string): Promise<void> {
  const [k] = await db().select({ mode: schema.clientContracts.billingMode, period: schema.clientContracts.billingPeriod, bundle: schema.clientContracts.bundlePriceCents, qty: schema.clientContracts.bundleQuantity, rebate: schema.clientContracts.rebateBps }).from(schema.clientContracts).where(eq(schema.clientContracts.id, contractId));
  if (!k || k.mode !== "monthly") return;
  // a bundle: its price per period, as a monthly figure
  if (k.bundle != null) {
    await db().update(schema.clientContracts).set({ monthlyRateCents: k.period === "yearly" ? Math.round((netCents(k.bundle, k.rebate) * k.qty) / 12) : netCents(k.bundle, k.rebate) * k.qty, updatedAt: new Date() }).where(eq(schema.clientContracts.id, contractId));
    return;
  }
  const rows = await db().select({ kind: schema.contractServices.kind, price: schema.contractServices.priceCents, qty: schema.contractServices.quantity, rebate: schema.contractServices.rebateBps }).from(schema.contractServices).where(eq(schema.contractServices.contractId, contractId));
  const monthly = rows.filter((r) => r.kind === "recurring").reduce((n, r) => n + netCents(r.price, combineBps(r.rebate, k.rebate)) * r.qty, 0);
  const yearly = rows.filter((r) => r.kind === "recurring_yearly").reduce((n, r) => n + netCents(r.price, combineBps(r.rebate, k.rebate)) * r.qty, 0);
  await db().update(schema.clientContracts).set({ monthlyRateCents: monthly + Math.round(yearly / 12), updatedAt: new Date() }).where(eq(schema.clientContracts.id, contractId));
}
