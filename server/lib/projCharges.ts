import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { netCents } from "../../shared/rebate.ts";

/**
 * The charges (equipment sold, fees) of a new-format project. They are `ticket_charges` rows with `proj_id` set (and no ticket, no
 * archive project): a billable one is work to bill at once (`pcharge:<id>`, see localTickets.billables).
 */
export type ProjChargeBilling = { status: string; invoice: { id: string; number: string } | null } | null;

export async function chargesOfProj(projId: string, withInvoice: boolean) {
  const d = db();
  const list = await d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.projId, projId)).orderBy(asc(schema.ticketCharges.createdAt));
  const keys = list.map((c) => c.externalId ?? `pcharge:${c.id}`);
  const lines = keys.length
    ? await d
        .select({ sourceId: schema.billingItems.sourceId, status: schema.billingItems.status, invoiceId: schema.billingItems.invoiceId, number: schema.clientInvoices.number })
        .from(schema.billingItems)
        .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.billingItems.invoiceId))
        .where(inArray(schema.billingItems.sourceId, keys))
    : [];
  const by = new Map(lines.map((l) => [l.sourceId!, l]));
  const items = list.map((c) => {
    const l = by.get(c.externalId ?? `pcharge:${c.id}`);
    const unitNet = c.unitPriceCents == null ? 0 : netCents(c.unitPriceCents, c.rebateBps);
    const totalCents = Math.round((c.quantityX100 * unitNet) / 100);
    const billing: ProjChargeBilling = l
      ? { status: l.status, invoice: l.invoiceId && l.number && withInvoice ? { id: l.invoiceId, number: l.number } : null }
      : c.billed
        ? { status: "billed_before", invoice: null }
        : null;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      quantity: c.quantityX100 / 100,
      unitPrice: c.unitPriceCents == null ? null : c.unitPriceCents / 100,
      rebate: c.rebateBps / 100,
      unitCost: c.unitCostCents == null ? null : c.unitCostCents / 100,
      billable: c.billable,
      date: c.date,
      author: c.author,
      supply: c.supply as "ordered" | "received" | null,
      billing,
      /** after the rebate, quantity included */
      total: totalCents / 100,
      /** only a charge not approved yet can be deleted */
      removable: !c.billed && (!l || l.status === "pending" || l.status === "excluded"),
    };
  });
  const billable = items.filter((i) => i.billable);
  return { items, totals: { count: items.length, billable: Math.round(billable.reduce((n, i) => n + i.total * 100, 0)) / 100 } };
}
