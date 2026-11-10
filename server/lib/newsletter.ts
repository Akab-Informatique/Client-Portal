import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";

/**
 * The newsletter list = the active contacts (with an email) of the active clients, one line per address, minus the
 * addresses that unsubscribed. Each contact has its own unsubscribe link (signed, so it cannot be guessed for someone
 * else); the link opens a page that asks for a click before unsubscribing (mail scanners open links on their own).
 */
const sign = (contactId: string) => crypto.createHmac("sha256", config.appSecret).update(`newsletter:${contactId}`).digest("base64url").slice(0, 24);

export const unsubscribeToken = (contactId: string) => `${contactId}.${sign(contactId)}`;
export const unsubscribeUrl = (contactId: string) => `${config.publicUrl}/desinscription/${unsubscribeToken(contactId)}`;

export function contactOfToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const good = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return got.length === good.length && crypto.timingSafeEqual(got, good) ? id : null;
}

const norm = (e: string) => e.trim().toLowerCase();

export async function emailOfContact(contactId: string): Promise<string | null> {
  const [r] = await db().select({ email: schema.clientContacts.email }).from(schema.clientContacts).where(eq(schema.clientContacts.id, contactId));
  return r?.email ? norm(r.email) : null;
}

export const generalUnsubscribeUrl = () => `${config.publicUrl}/desinscription`;

/** Is this address one of ours (a contact with that email, any client)? */
export async function knownAddress(email: string): Promise<boolean> {
  const [r] = await db().select({ id: schema.clientContacts.id }).from(schema.clientContacts).where(sql`lower(trim(${schema.clientContacts.email})) = ${norm(email)}`).limit(1);
  return Boolean(r);
}

export async function isUnsubscribed(email: string): Promise<boolean> {
  const [r] = await db().select().from(schema.newsletterOptouts).where(eq(schema.newsletterOptouts.email, norm(email)));
  return Boolean(r);
}

export async function unsubscribe(email: string, via: "link" | "staff"): Promise<void> {
  await db().insert(schema.newsletterOptouts).values({ email: norm(email), via }).onConflictDoNothing();
}

export async function resubscribe(email: string): Promise<void> {
  await db().delete(schema.newsletterOptouts).where(eq(schema.newsletterOptouts.email, norm(email)));
}

export type Contact = { email: string; firstName: string; lastName: string; client: string; contactId: string; unsubscribeUrl: string; subscribed: boolean };
export type Subscriber = Omit<Contact, "subscribed">;

/** Every active contact with an email of an active client, one line per address (the main contact wins when an address repeats), with whether it is subscribed */
export async function contactsList(): Promise<Contact[]> {
  const rows = await db()
    .select({ c: schema.clientContacts, client: schema.clients.name })
    .from(schema.clientContacts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
    .where(sql`${schema.clientContacts.active} and ${schema.clients.active} and coalesce(trim(${schema.clientContacts.email}), '') <> ''`);
  const out = new Set((await db().select().from(schema.newsletterOptouts)).map((r) => r.email));
  const byEmail = new Map<string, Contact & { primary: boolean }>();
  for (const { c, client } of rows) {
    const email = norm(c.email!);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    const prev = byEmail.get(email);
    if (prev && (prev.primary || !c.isPrimary)) continue;
    byEmail.set(email, { email, firstName: c.firstName, lastName: c.lastName, client, contactId: c.id, unsubscribeUrl: unsubscribeUrl(c.id), subscribed: !out.has(email), primary: c.isPrimary });
  }
  return [...byEmail.values()].map(({ primary: _p, ...x }) => x).sort((a, b) => a.client.localeCompare(b.client) || a.email.localeCompare(b.email));
}

/** Everyone who should receive the newsletter */
export async function subscribers(): Promise<{ list: Subscriber[]; unsubscribed: number }> {
  const all = await contactsList();
  return { list: all.filter((x) => x.subscribed).map(({ subscribed: _s, ...x }) => x), unsubscribed: all.filter((x) => !x.subscribed).length };
}
