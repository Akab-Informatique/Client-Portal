import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { contractCharges, type ChargeLine } from "../../shared/contractCharges.ts";
import { profitLevel } from "../../shared/profitability.ts";

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const dayBack = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** How profitable a client is over the last `days` days (formula in shared/profitability.ts). Administrators only: the caller checks. */
export async function clientProfitability(client: { id: string; autotaskId: number | null }, days: number) {
  const from = dayBack(days);
  const today = todayQc();
  // money in: the work to bill that is not set aside
  const items = await db()
    .select({ kind: schema.billingItems.kind, cents: schema.billingItems.amountCents })
    .from(schema.billingItems)
    .where(and(eq(schema.billingItems.clientId, client.id), gte(schema.billingItems.date, from), ne(schema.billingItems.status, "excluded")));
  const by = { recurring: 0, labour: 0, other: 0 };
  for (const i of items) by[i.kind === "contract" ? "recurring" : i.kind === "labour" ? "labour" : "other"] += Number(i.cents);
  const revenueCents = by.recurring + by.labour + by.other;

  // cost of the hours spent on the client's tickets, at each technician's wage
  let hours = 0;
  let billedHours = 0;
  let labourCostCents = 0;
  const noWage = new Set<string>();
  let goodsCostCents = 0;
  if (client.autotaskId != null) {
    const start = new Date(`${from}T00:00:00-05:00`);
    const times = await db()
      .select({ minutes: schema.ticketTimeEntries.minutes, billed: schema.ticketTimeEntries.billedMinutes, offset: schema.ticketTimeEntries.offsetMinutes, billable: schema.ticketTimeEntries.billable, userId: schema.ticketTimeEntries.userId })
      .from(schema.ticketTimeEntries)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketTimeEntries.ticketId))
      .where(and(eq(schema.tickets.companyId, client.autotaskId), gte(schema.ticketTimeEntries.startedAt, start)));
    const ids = [...new Set(times.map((t) => t.userId).filter((x): x is string => Boolean(x)))];
    const wages = new Map((ids.length ? await db().select().from(schema.hrProfiles).where(inArray(schema.hrProfiles.userId, ids)) : []).map((p) => [p.userId, p.hourlyWageCents]));
    for (const t of times) {
      hours += t.minutes / 60;
      if (t.billable) billedHours += Math.max(0, t.billed ?? t.minutes - t.offset) / 60;
      const wage = t.userId ? wages.get(t.userId) : null;
      if (wage) labourCostCents += Math.round((t.minutes / 60) * wage);
      else noWage.add(t.userId ?? "?");
    }
    // what the charges sold cost us
    const charges = await db()
      .select({ qty: schema.ticketCharges.quantityX100, cost: schema.ticketCharges.unitCostCents })
      .from(schema.ticketCharges)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketCharges.ticketId))
      .where(and(eq(schema.tickets.companyId, client.autotaskId), gte(schema.ticketCharges.date, from)));
    goodsCostCents = charges.reduce((n, c) => n + Math.round(((c.qty ?? 100) / 100) * Number(c.cost ?? 0)), 0);
  }

  // what the recurring services cost us (the vendors' prices) on the charge dates of the period
  let serviceCostCents = 0;
  const contracts = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.clientId, client.id));
  if (contracts.length) {
    const lines = await db().select().from(schema.contractServices).where(inArray(schema.contractServices.contractId, contracts.map((k) => k.id)));
    for (const k of contracts) {
      const mine = lines.filter((l) => l.contractId === k.id);
      if (!mine.length) continue;
      const ch = contractCharges(
        { startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: k.billingPeriod === "yearly" ? "yearly" : "monthly" },
        mine.map((s): ChargeLine => ({ id: s.id, name: s.name, kind: s.kind === "recurring_yearly" ? "recurring_yearly" : "recurring", priceCents: s.costCents, quantity: s.quantity, addedOn: s.addedOn })),
      );
      serviceCostCents += ch.entries.filter((e) => e.date >= from && e.date <= today).reduce((n, e) => n + e.amountCents, 0);
    }
  }

  const costCents = labourCostCents + goodsCostCents + serviceCostCents;
  const profitCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? Math.round((profitCents / revenueCents) * 1000) / 10 : null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    days,
    from,
    to: today,
    revenueCents,
    revenueBy: by,
    labourCostCents,
    goodsCostCents,
    serviceCostCents,
    costCents,
    profitCents,
    marginPct,
    hours: r2(hours),
    billedHours: r2(billedHours),
    revenuePerHourCents: hours > 0 ? Math.round(revenueCents / hours) : null,
    costPerHourCents: hours > 0 ? Math.round(labourCostCents / hours) : null,
    missingWages: noWage.size,
    level: profitLevel(marginPct, costCents),
  };
}
