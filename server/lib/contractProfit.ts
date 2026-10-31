import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * What a contract earns or loses in a month (Québec time), for administrators: what it billed (the work to bill made under it
 * that is not set aside) less what it cost — the recurring services at their cost and the hours worked under it at each
 * technician's hourly wage (HR file). A technician with no wage on file counts for nothing and is counted in `missingWages`.
 */
export async function contractProfit(contractId: string, month = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).slice(0, 7)) {
  const [k] = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.id, contractId));
  if (!k) return null;
  const from = `${month}-01`;
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const billed = await db()
    .select({ cents: schema.billingItems.amountCents })
    .from(schema.billingItems)
    .where(and(eq(schema.billingItems.contractId, contractId), gte(schema.billingItems.date, from), lt(schema.billingItems.date, next), ne(schema.billingItems.status, "excluded")));
  const revenueCents = billed.reduce((n, r) => n + Number(r.cents), 0);
  const services = await db().select().from(schema.contractServices).where(eq(schema.contractServices.contractId, contractId));
  const serviceCostCents = Math.round(services.filter((s) => s.addedOn < next).reduce((n, s) => n + (s.kind === "recurring_yearly" ? s.costCents / 12 : s.costCents) * s.quantity, 0));
  let hours = 0;
  let labourCostCents = 0;
  let missingWages = 0;
  if (k.autotaskId) {
    const start = new Date(`${from}T00:00:00-05:00`);
    const end = new Date(`${next}T00:00:00-05:00`);
    const times = await db()
      .select({ minutes: schema.ticketTimeEntries.minutes, userId: schema.ticketTimeEntries.userId })
      .from(schema.ticketTimeEntries)
      .where(and(eq(schema.ticketTimeEntries.contractId, k.autotaskId), gte(schema.ticketTimeEntries.startedAt, start), lt(schema.ticketTimeEntries.startedAt, end)));
    const ids = [...new Set(times.map((t) => t.userId).filter((x): x is string => Boolean(x)))];
    const wages = new Map((ids.length ? await db().select().from(schema.hrProfiles).where(inArray(schema.hrProfiles.userId, ids)) : []).map((p) => [p.userId, p.hourlyWageCents]));
    const noWage = new Set<string>();
    for (const t of times) {
      hours += t.minutes / 60;
      const wage = t.userId ? wages.get(t.userId) : null;
      if (wage) labourCostCents += Math.round((t.minutes / 60) * wage);
      else noWage.add(t.userId ?? "?");
    }
    missingWages = noWage.size;
  }
  return { contractId, name: k.name, month, revenueCents, serviceCostCents, labourCostCents, hours: Math.round(hours * 100) / 100, missingWages, profitCents: revenueCents - serviceCostCents - labourCostCents };
}
