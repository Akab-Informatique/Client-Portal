import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * A client with a single (active) contact: that contact is the main one, and the billing one when the client has no
 * billing email yet. Called after a contact is made, changed or turned off; never takes over what someone picked.
 */
export async function ensureSoleContact(clientId: string): Promise<void> {
  const d = db();
  const contacts = await d.select().from(schema.clientContacts).where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.active, true)));
  // a main contact that is no longer active stops being one
  await d.update(schema.clientContacts).set({ isPrimary: false }).where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.active, false), eq(schema.clientContacts.isPrimary, true)));
  if (contacts.length !== 1) return;
  const [only] = contacts;
  if (!only.isPrimary) await d.update(schema.clientContacts).set({ isPrimary: true, updatedAt: new Date() }).where(eq(schema.clientContacts.id, only.id));
  const [client] = await d.select({ invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (client && !client.invoice?.billingEmail?.trim() && only.email?.trim()) {
    await d.update(schema.clients).set({ invoice: { ...client.invoice, billingContactId: only.id, billingEmail: only.email.trim() }, updatedAt: new Date() }).where(eq(schema.clients.id, clientId));
  }
}
