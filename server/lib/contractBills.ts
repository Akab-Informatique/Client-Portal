import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { contractCharges, hasBundle, linesForCharges, type ChargeLine } from "../../shared/contractCharges.ts";
import type { Billable } from "./ticketSource.ts";

/**
 * The recurring charges of the contracts as work to bill: one line per service and per charge date (what the contract
 * window shows under "Facturation"), ready to approve in Accounting › Approbation. A line is quantity × unit price, so
 * 10 units at $45 is 10 × $45 = $450 (never the total as the unit price); a part period (a service starting mid-month,
 * a contract that ends) is one line with quantity 1 and the prorated total. Only the charge dates that have come, from
 * `since` on, and after the day the contract was invoiced through in the old system.
 */
const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const dmy = (ymd: string) => ymd.split("-").reverse().join("/");

export async function contractBillables(since: string): Promise<Billable[]> {
  const d = db();
  const today = todayQc();
  const contracts = await d
    .select({ k: schema.clientContracts, companyId: schema.clients.autotaskId })
    .from(schema.clientContracts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContracts.clientId))
    .where(and(isNotNull(schema.clients.autotaskId), isNotNull(schema.clientContracts.startDate), isNotNull(schema.clientContracts.endDate)));
  if (!contracts.length) return [];
  const rows = await d
    .select({ s: schema.contractServices, taxable: schema.services.taxable })
    .from(schema.contractServices)
    .leftJoin(schema.services, eq(schema.services.id, schema.contractServices.serviceId))
    .orderBy(asc(schema.contractServices.addedOn), asc(schema.contractServices.name));
  const out: Billable[] = [];
  for (const { k, companyId } of contracts) {
    const mine = rows.filter((r) => r.s.contractId === k.id);
    // a bundle is charged even with no service listed under it
    if (!mine.length && !hasBundle(k)) continue;
    const byId = new Map(mine.map((r) => [r.s.id, r]));
    const period = k.billingPeriod === "yearly" ? "yearly" : "monthly";
    const services: ChargeLine[] = mine.map(({ s }) => ({ id: s.id, name: s.name, kind: s.kind === "recurring_yearly" ? "recurring_yearly" : "recurring", priceCents: s.priceCents, quantity: s.quantity, addedOn: s.addedOn }));
    // a bundle replaces the services' own prices: one line for the package, its price and quantity
    const lines = linesForCharges({ name: k.name, startDate: k.startDate, billingPeriod: period, bundlePriceCents: k.bundlePriceCents, bundleQuantity: k.bundleQuantity }, services);
    const charges = contractCharges({ startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: period }, lines);
    for (const e of charges.entries) {
      if (e.date > today || e.date < since || (k.billedThrough && e.date <= k.billedThrough)) continue;
      for (const p of e.pieces) {
        const svc = byId.get(p.lineId);
        const bundled = p.lineId === "bundle";
        if (!svc && !bundled) continue;
        const qty = Math.max(1, bundled ? k.bundleQuantity : svc!.s.quantity);
        // a whole period: quantity × unit price; a part period: one line, quantity 1, the prorated total
        const whole = !p.prorated && p.amountCents % qty === 0;
        out.push({
          id: `contract:${k.id}:${bundled ? "bundle" : svc!.s.id}:${e.date}`,
          kind: "contract",
          companyId: companyId!,
          date: e.date,
          dateEnd: p.to,
          description: `${p.name}${p.prorated ? ` (prorata ${p.days}/${p.periodDays} j)` : ""} — ${dmy(p.from)} – ${dmy(p.to)}`,
          contractName: k.name,
          contractSourceId: k.autotaskId,
          quantity: whole ? qty : 1,
          unitPriceCents: whole ? p.amountCents / qty : p.amountCents,
          taxable: bundled ? true : (svc!.taxable ?? true),
        });
      }
    }
  }
  return out;
}
