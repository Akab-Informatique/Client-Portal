import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { sendPasswordLink } from "./passwordLinks.ts";

/**
 * Client portal accounts are made by hand, one contact at a time (CRM › client › Contacts: "Inviter" sends the
 * welcome email, "Créer sans courriel" makes the account quietly). Nothing is made automatically for a contact, and
 * opening a company's portal (`clients.portal_enabled`, see `accountUsable`) makes no account either.
 */

/** Welcome emails (a link to choose a password) to the company's accounts that have not signed in yet. */
export async function sendPortalWelcomes(clientId: string, c?: Context): Promise<{ sent: number; failed: number }> {
  const users = await db()
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
    .from(schema.users)
    .innerJoin(schema.clientContacts, eq(schema.clientContacts.userId, schema.users.id))
    .where(and(eq(schema.users.clientId, clientId), eq(schema.users.kind, "client"), eq(schema.users.active, true), eq(schema.users.mustChangePassword, true), eq(schema.clientContacts.active, true)));
  let sent = 0;
  let failed = 0;
  for (const u of users) (await sendPasswordLink(u, "welcome", c)) ? sent++ : failed++;
  return { sent, failed };
}
