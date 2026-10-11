import type { Context } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { sendTemplate } from "./mail.ts";

/**
 * One-time links to choose a password: "reset" (forgotten password, 60 min)
 * and "welcome" (new account, 72 h). The link carries a random token; only
 * its SHA-256 is stored. A new link replaces the previous unused ones.
 */
export type Purpose = "reset" | "welcome";
const TTL_MINUTES: Record<Purpose, number> = { reset: 60, welcome: 72 * 60 };

type UserLike = { id: string; email: string; name: string; locale: string };

/** Public address of the portal (PUBLIC_URL, else the request's own origin). */
export function portalUrl(c?: Context): string {
  if (config.publicUrl) return config.publicUrl;
  return c ? new URL(c.req.url).origin : "";
}

const expiresText = (p: Purpose, locale: string) =>
  p === "reset" ? "60 minutes" : locale === "en" ? "72 hours" : "72 heures";

export async function issuePasswordLink(user: UserLike, purpose: Purpose): Promise<string> {
  const token = randomToken(32);
  await db()
    .delete(schema.passwordTokens)
    .where(and(eq(schema.passwordTokens.userId, user.id), isNull(schema.passwordTokens.usedAt)));
  await db()
    .insert(schema.passwordTokens)
    .values({ userId: user.id, tokenHash: sha256(token), purpose, expiresAt: new Date(Date.now() + TTL_MINUTES[purpose] * 60_000) });
  return token;
}

/** Create a link and email it (welcome or reset template). */
export async function sendPasswordLink(user: UserLike, purpose: Purpose, c?: Context): Promise<boolean> {
  const token = await issuePasswordLink(user, purpose);
  const base = portalUrl(c);
  return sendTemplate(purpose === "reset" ? "passwordReset" : "welcome", user, {
    name: user.name,
    email: user.email,
    link: `${base}/reset-password?token=${token}`,
    expires: expiresText(purpose, user.locale),
    portalUrl: base,
  });
}

/** The valid (unused, not expired) token row, if any. */
export async function findPasswordLink(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db()
    .select()
    .from(schema.passwordTokens)
    .where(
      and(eq(schema.passwordTokens.tokenHash, sha256(token)), isNull(schema.passwordTokens.usedAt), gt(schema.passwordTokens.expiresAt, new Date())),
    );
  return row ?? null;
}

/** Mark the token used; false if it was already used (atomic). */
export async function consumePasswordLink(id: string): Promise<boolean> {
  const done = await db()
    .update(schema.passwordTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.passwordTokens.id, id), isNull(schema.passwordTokens.usedAt)))
    .returning({ id: schema.passwordTokens.id });
  return done.length === 1;
}

export async function sendPasswordChanged(user: UserLike, c?: Context): Promise<void> {
  const locale = user.locale === "en" ? "en-CA" : "fr-CA";
  await sendTemplate("passwordChanged", user, {
    name: user.name,
    email: user.email,
    date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date()),
    portalUrl: portalUrl(c),
  });
}
