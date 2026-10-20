import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { Company, TicketSource } from "./ticketSource.ts";

/**
 * Client portal ↔ ticket system: which ticket company is a portal client,
 * and which contact is a client user.
 */

/**
 * The ticket-system company of a portal client: its id. With the
 * sample data (development), the sample company of the same name, created
 * if needed (`create`).
 */
export async function ticketCompanyOf(clientId: string, src: TicketSource, opts: { create?: boolean } = {}): Promise<Company | null> {
  const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) return null;
  const companies = await src.companies();
  if (client.autotaskId != null) {
    const hit = companies.find((x) => x.id === client.autotaskId);
    if (hit || !src.demo) return hit ?? null;
  }
  if (!src.demo) return null;
  const same = companies.find((x) => x.name.trim().toLowerCase() === client.name.trim().toLowerCase());
  if (same || !opts.create) return same ?? null;
  return src.addCompany({ name: client.name, phone: client.phone ?? "" }, undefined as never);
}

/** The ticket-system contact of a client user: the linked contact, else the one with their email. */
export async function contactOfUser(user: { id: string; email: string }, companyId: number, src: TicketSource): Promise<string | null> {
  const contacts = await src.contacts(companyId).catch(() => []);
  const [link] = await db().select({ at: schema.clientContacts.autotaskId }).from(schema.clientContacts).where(eq(schema.clientContacts.userId, user.id));
  if (link?.at && contacts.some((x) => x.id === link.at)) return link.at;
  return contacts.find((x) => x.email?.toLowerCase() === user.email.toLowerCase())?.id ?? null;
}
