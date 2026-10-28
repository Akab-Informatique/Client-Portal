import type { Context } from "hono";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";import { db, schema } from "../db/index.ts";
import { hashPassword, temporaryPassword } from "./crypto.ts";
import { sendPasswordLink } from "./passwordLinks.ts";
import { clientRoleId } from "./clientRoles.ts";

/**
 * Client portal accounts follow the contacts: every active contact with an
 * email has a client account (role "Usager client", a random password nobody
 * knows, no email sent). Nobody of a company can sign in until its portal is
 * switched on (`clients.portal_enabled`, see `accountUsable`); switching it on
 * is what sends the welcome emails.
 *
 * Idempotent: it only makes what is missing and never touches an account that
 * exists (a person turned off by hand stays off).
 */
export async function provisionPortalUsers(clientId?: string): Promise<number> {
  const d = db();
  // each client has its own "Usager client" role
  const roleOf = new Map<string, string | null>();
  const roleFor = async (id: string) => {
    if (!roleOf.has(id)) roleOf.set(id, await clientRoleId(id, "client-user"));
    return roleOf.get(id) ?? null;
  };
  const contacts = await d
    .select({ c: schema.clientContacts })
    .from(schema.clientContacts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
    .where(and(eq(schema.clients.active, true), eq(schema.clientContacts.active, true), isNull(schema.clientContacts.userId), isNotNull(schema.clientContacts.email), clientId ? eq(schema.clientContacts.clientId, clientId) : undefined));
  if (!contacts.length) return 0;

  // one random hash for the whole run: nobody knows the password, the welcome link sets a real one
  const passwordHash = await hashPassword(temporaryPassword());
  let made = 0;
  for (const { c } of contacts) {
    const email = c.email?.trim().toLowerCase();
    if (!email) continue;
    const [same] = await d.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
    let userId: string;
    if (same) {
      // an account of this same client that no contact holds yet is theirs; anything else is someone else's
      const [held] = await d.select({ id: schema.clientContacts.id }).from(schema.clientContacts).where(eq(schema.clientContacts.userId, same.id));
      if (same.kind !== "client" || same.clientId !== c.clientId || held) continue;
      userId = same.id;
    } else {
      const name = `${c.firstName} ${c.lastName}`.trim() || email;
      const [u] = await d
        .insert(schema.users)
        .values({ email, name, kind: "client", clientId: c.clientId, roleId: await roleFor(c.clientId), title: c.title, phone: c.mobile ?? c.phone, passwordHash, mustChangePassword: true })
        .returning({ id: schema.users.id });
      userId = u.id;
      made++;
    }
    await d.update(schema.clientContacts).set({ userId, updatedAt: new Date() }).where(eq(schema.clientContacts.id, c.id));
  }
  return made;
}

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
