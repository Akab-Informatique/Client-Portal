import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { permissionsOf } from "./auth.ts";
import type { PermissionKey } from "../../shared/permissions.ts";
import { notify } from "./notify.ts";
import { selfManagedCompanyIds } from "./selfManaged.ts";

/**
 * The delegated technicians of a self-managed company: the active client users
 * who hold clientTickets.delegate in that company, either as their home role or
 * through a grant on it (their role there). Only while the company's portal is open.
 */
export const DELEGATE_PERMISSION: PermissionKey = "clientTickets.delegate";

export async function delegatesOf(clientId: string): Promise<string[]> {
  const d = db();
  const [co] = await d.select({ active: schema.clients.active, portal: schema.clients.portalEnabled }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!co?.active || !co.portal) return [];
  const out = new Set<string>();
  const homes = await d
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.kind, "client"), eq(schema.users.clientId, clientId), eq(schema.users.active, true)));
  for (const u of homes) if ((await permissionsOf(u)).includes(DELEGATE_PERMISSION)) out.add(u.id);
  const grants = await d.select({ userId: schema.clientUserGrants.userId, roleId: schema.clientUserGrants.roleId }).from(schema.clientUserGrants).where(eq(schema.clientUserGrants.clientId, clientId));
  for (const g of grants) {
    if (out.has(g.userId)) continue;
    const [role] = await d.select().from(schema.roles).where(eq(schema.roles.id, g.roleId));
    if (!role || role.audience !== "client" || role.clientId !== clientId || !(role.permissions ?? []).includes(DELEGATE_PERMISSION)) continue;
    const [u] = await d.select({ id: schema.users.id, active: schema.users.active, kind: schema.users.kind }).from(schema.users).where(eq(schema.users.id, g.userId));
    if (u?.active && u.kind === "client") out.add(u.id);
  }
  return [...out];
}

/** The delegates of the active clients tied to a ticket company (its Autotask-style company id). */
export async function delegatesOfCompany(companyId: number): Promise<string[]> {
  const rows = await db().select({ id: schema.clients.id }).from(schema.clients).where(and(eq(schema.clients.autotaskId, companyId), eq(schema.clients.active, true)));
  const out = new Set<string>();
  for (const r of rows) for (const id of await delegatesOf(r.id)) out.add(id);
  return [...out];
}

/** Tell the delegates of a company (never `except`, the person who did it). Never throws. */
export async function notifyDelegates(companyId: number, n: Parameters<typeof notify>[1], except?: string): Promise<void> {
  const ids = (await delegatesOfCompany(companyId)).filter((id) => id !== except);
  await notify(ids, n);
}

/** Whether a ticket is hidden from its company's delegates (staff set it): nothing is told to them about it */
export async function hiddenFromDelegatesOf(ticketId: number): Promise<boolean> {
  const [r] = await db().select({ h: schema.tickets.hiddenFromDelegates }).from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  return Boolean(r?.h);
}

/**
 * The delegate and the hidden flag of the tickets of self-managed companies, for the staff lists and detail.
 * One query; the other tickets are not in the map.
 */
export async function delegateInfoOf(ids: number[]): Promise<Map<number, { delegate: { id: string; name: string } | null; hiddenFromDelegates: boolean }>> {
  const out = new Map<number, { delegate: { id: string; name: string } | null; hiddenFromDelegates: boolean }>();
  if (!ids.length) return out;
  const companies = await selfManagedCompanyIds();
  if (!companies.size) return out;
  const rows = await db()
    .select({ id: schema.tickets.id, delegateUserId: schema.tickets.delegateUserId, hidden: schema.tickets.hiddenFromDelegates })
    .from(schema.tickets)
    .where(and(inArray(schema.tickets.id, ids), inArray(schema.tickets.companyId, [...companies])));
  const dIds = [...new Set(rows.map((r) => r.delegateUserId).filter((x): x is string => Boolean(x)))];
  const names = new Map(dIds.length ? (await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, dIds))).map((u) => [u.id, u.name]) : []);
  for (const r of rows) {
    const name = r.delegateUserId ? names.get(r.delegateUserId) : undefined;
    out.set(r.id, { delegate: r.delegateUserId && name !== undefined ? { id: r.delegateUserId, name } : null, hiddenFromDelegates: r.hidden });
  }
  return out;
}
