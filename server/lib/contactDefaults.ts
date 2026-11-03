import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { clientRoleId } from "./clientRoles.ts";

/**
 * A client with a single (active) contact: that contact is the main one, and the billing one when the client has no
 * billing email yet. Called after a contact is made, changed or turned off; never takes over what someone picked.
 */
export async function ensureSoleContact(clientId: string): Promise<void> {
  const d = db();
  const contacts = await d.select().from(schema.clientContacts).where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.active, true)));
  // a main contact that is no longer active stops being one
  await d.update(schema.clientContacts).set({ isPrimary: false }).where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.active, false), eq(schema.clientContacts.isPrimary, true)));
  if (contacts.length !== 1) {
    await syncContactRoles(clientId);
    return;
  }
  const [only] = contacts;
  if (!only.isPrimary) await d.update(schema.clientContacts).set({ isPrimary: true, updatedAt: new Date() }).where(eq(schema.clientContacts.id, only.id));
  const [client] = await d.select({ invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (client && !client.invoice?.billingEmail?.trim() && only.email?.trim()) {
    await d.update(schema.clients).set({ invoice: { ...client.invoice, billingContactId: only.id, billingEmail: only.email.trim() }, updatedAt: new Date() }).where(eq(schema.clients.id, clientId));
  }
  await syncContactRoles(clientId);
}

/**
 * The main contact and the billing contact see the company's invoices and contracts in the client portal: their
 * account moves from the client's "Usager client" role to its "Comptabilité client" role. Only from that role:
 * someone given another role by hand (administrator, technical…) keeps it, and nobody is moved back down.
 */
export async function syncContactRoles(clientId: string): Promise<number> {
  const d = db();
  const [client] = await d.select({ invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) return 0;
  const contacts = await d
    .select({ id: schema.clientContacts.id, userId: schema.clientContacts.userId, isPrimary: schema.clientContacts.isPrimary })
    .from(schema.clientContacts)
    .where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.active, true), isNotNull(schema.clientContacts.userId)));
  const userIds = contacts.filter((c) => c.isPrimary || c.id === client.invoice?.billingContactId).map((c) => c.userId!);
  if (!userIds.length) return 0;
  const [from, to] = [await clientRoleId(clientId, "client-user"), await clientRoleId(clientId, "client-accounting")];
  if (!from || !to) return 0;
  const moved = await d
    .update(schema.users)
    .set({ roleId: to, updatedAt: new Date() })
    .where(and(inArray(schema.users.id, userIds), eq(schema.users.clientId, clientId), eq(schema.users.roleId, from)))
    .returning({ id: schema.users.id });
  return moved.length;
}
