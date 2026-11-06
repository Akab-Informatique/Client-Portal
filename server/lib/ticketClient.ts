import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { contractsOfCompany } from "./contracts.ts";

/**
 * A ticket moved to another client (a mistake fixed in the ticket window): what was tied to the old
 * client follows the new one, except what is already invoiced.
 *  - the ticket's contract (chosen, or stored on the ticket) and its portal device are dropped: the new
 *    client's default contract applies until another one is picked;
 *  - its time entries and charges not billed yet lose a contract the new client cannot use;
 *  - the timesheet rows of its time count for the new client (billable hours per client);
 *  - its work to bill not on an invoice (pending, approved or set aside) goes to the new client, under
 *    no contract, back to "pending" to be looked at again (the next copy gives it the new client's contract
 *    and rate); invoiced lines stay where they are (`invoiced` says how many).
 */
export async function moveTicketClient(ticketId: number, newCompanyId: number): Promise<{ moved: number; invoiced: number }> {
  const d = db();
  const [client] = await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, newCompanyId));
  const usable = new Set((await contractsOfCompany(newCompanyId)).map((k) => k.id));
  const keep = (id: string | null) => (id && usable.has(id) ? id : null);

  await d.update(schema.ticketMeta).set({ contractId: null, localAsset: null, updatedAt: new Date() }).where(eq(schema.ticketMeta.ticketId, ticketId));
  await d.update(schema.tickets).set({ contractId: null }).where(eq(schema.tickets.id, ticketId));

  const times = await d.select({ id: schema.ticketTimeEntries.id, contractId: schema.ticketTimeEntries.contractId, billed: schema.ticketTimeEntries.billed }).from(schema.ticketTimeEntries).where(eq(schema.ticketTimeEntries.ticketId, ticketId));
  for (const e of times.filter((x) => !x.billed && x.contractId && !usable.has(x.contractId))) await d.update(schema.ticketTimeEntries).set({ contractId: null }).where(eq(schema.ticketTimeEntries.id, e.id));
  const charges = await d.select({ id: schema.ticketCharges.id, contractId: schema.ticketCharges.contractId, billed: schema.ticketCharges.billed }).from(schema.ticketCharges).where(eq(schema.ticketCharges.ticketId, ticketId));
  for (const ch of charges.filter((x) => !x.billed && x.contractId && !usable.has(x.contractId))) await d.update(schema.ticketCharges).set({ contractId: null }).where(eq(schema.ticketCharges.id, ch.id));

  // the timesheet rows of this ticket's time
  if (client && times.length) {
    const rows = await d.select({ id: schema.timesheetEntries.id, contractId: schema.timesheetEntries.contractId }).from(schema.timesheetEntries).where(inArray(schema.timesheetEntries.ticketTimeId, times.map((x) => x.id)));
    for (const r of rows) await d.update(schema.timesheetEntries).set({ clientId: client.id, contractId: keep(r.contractId) }).where(eq(schema.timesheetEntries.id, r.id));
  }

  // the work to bill made from this ticket
  const sourceIds = [...times.map((x) => `ptime:${x.id}`), ...charges.map((x) => `pcharge:${x.id}`)];
  if (!client || !sourceIds.length) return { moved: 0, invoiced: 0 };
  const items = await d.select({ id: schema.billingItems.id, invoiceId: schema.billingItems.invoiceId, status: schema.billingItems.status, reason: schema.billingItems.excludedReason }).from(schema.billingItems).where(inArray(schema.billingItems.sourceId, sourceIds));
  const invoiced = items.filter((x) => x.invoiceId || x.status === "posted").length;
  // "already billed" set aside by hand stays set aside; the rest is looked at again
  const open = items.filter((x) => !x.invoiceId && x.status !== "posted");
  for (const it of open) {
    const stayAside = it.status === "excluded" && it.reason === "billed";
    await d
      .update(schema.billingItems)
      .set({ clientId: client.id, contractId: null, contractName: null, payerClientId: null, ...(stayAside ? {} : { status: "pending", excludedReason: null, approvedAt: null, approvedBy: null }), updatedAt: new Date() })
      .where(and(eq(schema.billingItems.id, it.id), isNull(schema.billingItems.invoiceId)));
  }
  return { moved: open.length, invoiced };
}
