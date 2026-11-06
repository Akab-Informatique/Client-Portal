import { asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";

/** Why a charge cannot be moved (the code is the message of the HTTP error) */
export class ChargeMoveError extends HTTPException {
  constructor(code: string, status: 400 | 404 | 409 = 409) {
    super(status, { message: code });
  }
}

export type ChargeTarget = { ticketId: number } | { projectId: string };

/** Where a charge is now: a ticket or a project, with its number and the client's company id */
async function placeOf(t: ChargeTarget) {
  const d = db();
  if ("ticketId" in t) {
    const [row] = await d.select({ number: schema.tickets.number, companyId: schema.tickets.companyId, merged: schema.tickets.mergedIntoId }).from(schema.tickets).where(eq(schema.tickets.id, t.ticketId));
    if (!row) throw new ChargeMoveError("not_found", 404);
    if (row.merged != null) throw new ChargeMoveError("target_merged");
    return { number: row.number, companyId: row.companyId as number | null, kind: "ticket" as const };
  }
  const [p] = await d
    .select({ number: schema.projects.number, status: schema.projects.status, clientId: schema.projects.clientId, companyId: schema.clients.autotaskId })
    .from(schema.projects)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.projects.clientId))
    .where(eq(schema.projects.id, t.projectId));
  if (!p) throw new ChargeMoveError("not_found", 404);
  if (p.status === "done" || p.status === "cancelled") throw new ChargeMoveError("project_closed");
  if (!p.clientId || p.companyId == null) throw new ChargeMoveError("project_needs_client");
  return { number: p.number, companyId: p.companyId as number | null, kind: "project" as const };
}

/**
 * Puts a charge on another ticket or on a project. Only while it is not approved: once its work to bill is approved
 * (or on an invoice, or set aside) it stays where it is. The work to bill follows (number, client), and a contract
 * of the old client no longer applies when the client changes.
 */
export async function moveCharge(chargeId: string, from: ChargeTarget, to: ChargeTarget) {
  const d = db();
  if (!/^[0-9a-f-]{36}$/i.test(chargeId)) throw new ChargeMoveError("not_found", 404);
  const [charge] = await d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.id, chargeId));
  if (!charge) throw new ChargeMoveError("not_found", 404);
  const here = "ticketId" in from ? charge.ticketId === from.ticketId : charge.projectId === from.projectId;
  if (!here) throw new ChargeMoveError("not_found", 404);
  const same = "ticketId" in to ? charge.ticketId === to.ticketId : charge.projectId === to.projectId;
  if (same) throw new ChargeMoveError("same_target", 400);
  if (charge.billed) throw new ChargeMoveError("charge_approved");
  const sourceId = charge.externalId ?? `pcharge:${charge.id}`;
  const [line] = await d.select().from(schema.billingItems).where(eq(schema.billingItems.sourceId, sourceId));
  if (line && line.status !== "pending") throw new ChargeMoveError("charge_approved");
  const [oldPlace, place] = await Promise.all([placeOf(from).catch(() => null), placeOf(to)]);
  const otherClient = oldPlace?.companyId !== place.companyId;

  await d.transaction(async (tx) => {
    await tx
      .update(schema.ticketCharges)
      .set({ ticketId: "ticketId" in to ? to.ticketId : null, projectId: "projectId" in to ? to.projectId : null, ...(otherClient ? { contractId: null } : {}) })
      .where(eq(schema.ticketCharges.id, charge.id));
    if (line) {
      const [client] = place.companyId == null ? [] : await tx.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, place.companyId));
      await tx
        .update(schema.billingItems)
        .set({ ticketNumber: place.number, ...(otherClient && client ? { clientId: client.id, contractId: null, contractName: null, payerClientId: null } : {}), updatedAt: new Date() })
        .where(eq(schema.billingItems.id, line.id));
    }
  });
  return { number: place.number, kind: place.kind, otherClient };
}

/** The charges that were put on a project, with where each stands in billing */
export async function chargesOfProject(projectId: string) {
  const d = db();
  const list = await d.select().from(schema.ticketCharges).where(eq(schema.ticketCharges.projectId, projectId)).orderBy(asc(schema.ticketCharges.createdAt));
  const keys = list.map((c) => c.externalId ?? `pcharge:${c.id}`);
  const lines = keys.length ? await d.select({ sourceId: schema.billingItems.sourceId, status: schema.billingItems.status }).from(schema.billingItems).where(inArray(schema.billingItems.sourceId, keys)) : [];
  const status = new Map(lines.map((l) => [l.sourceId!, l.status]));
  return list.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    quantity: c.quantityX100 / 100,
    unitPrice: c.unitPriceCents == null ? null : c.unitPriceCents / 100,
    rebate: c.rebateBps / 100,
    billable: c.billable,
    date: c.date,
    author: c.author,
    billing: c.billed ? "posted" : (status.get(c.externalId ?? `pcharge:${c.id}`) ?? null),
    /** only a charge not approved yet can be moved */
    movable: !c.billed && (status.get(c.externalId ?? `pcharge:${c.id}`) ?? "pending") === "pending",
  }));
}
