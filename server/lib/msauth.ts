import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal } from "./crypto.ts";
import { asUser, DELEGATED_SCOPES, forgetUserToken, graph, O365Error, o365Settings, tokenRequest } from "./o365.ts";

/**
 * A technician signs in with their own Microsoft 365 account (OAuth
 * authorization code + PKCE, AKAB's tenant only) to link their own things:
 * their mailbox in the Outlook module, their calendar, later To Do.
 * Nothing of anyone else is reachable this way.
 */
const STATE_TTL_MS = 10 * 60_000;
const pending = new Map<string, { userId: string; verifier: string; redirectUri: string; until: number }>();

const b64url = (b: Buffer) => b.toString("base64url");

/** Where Microsoft sends the person back (to register in the app registration). */
export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/microsoft/callback`;
}

/** The Microsoft sign-in address for this person (valid 10 minutes, once). */
export async function signInUrl(userId: string, redirectUri: string, loginHint?: string | null): Promise<string> {
  const s = await o365Settings();
  if (!s.enabled || !s.tenantId || !s.clientId || !s.secret) throw new O365Error("not_configured");
  const now = Date.now();
  for (const [k, v] of pending) if (v.until < now) pending.delete(k);
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { userId, verifier, redirectUri, until: now + STATE_TTL_MS });
  const q = new URLSearchParams({
    client_id: s.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: DELEGATED_SCOPES.join(" "),
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(s.tenantId)}/oauth2/v2.0/authorize?${q}`;
}

export type SignInResult = { email: string; displayName: string | null };

/**
 * Back from Microsoft: the state must be the one given to this same person
 * (signed in to the portal), used once. The code becomes tokens, kept sealed.
 */
export async function completeSignIn(userId: string, state: string, code: string): Promise<SignInResult> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.until < Date.now() || p.userId !== userId) throw new O365Error("auth", "state");
  const s = await o365Settings();
  const j = await tokenRequest(s, { grant_type: "authorization_code", code, redirect_uri: p.redirectUri, code_verifier: p.verifier, scope: DELEGATED_SCOPES.join(" ") });
  if (!j.access_token || !j.refresh_token) throw new O365Error("auth", j.error_description?.split("\r\n")[0]?.slice(0, 200) ?? j.error);
  const access = j.access_token;
  // who signed in (with the token just received, not a stored one)
  const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
    headers: { authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => {
    throw new O365Error("network", e.name);
  });
  const me = (await meRes.json().catch(() => null)) as { id?: string; displayName?: string; mail?: string | null; userPrincipalName?: string } | null;
  const email = (me?.mail || me?.userPrincipalName || "").toLowerCase();
  if (!meRes.ok || !me?.id || !email) throw new O365Error("api", "me");
  const values = {
    msUserId: me.id,
    email,
    displayName: me.displayName ?? null,
    refreshToken: seal(j.refresh_token),
    scopes: j.scope ? [...new Set([...j.scope.split(" "), "offline_access"])].join(" ") : DELEGATED_SCOPES.join(" "),
    lastError: null,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.msConnections)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: schema.msConnections.userId, set: values });
  forgetUserToken(userId);
  return { email, displayName: me.displayName ?? null };
}

/** The person's mailbox in the Outlook module, through their own sign-in. */
export async function linkOwnMailbox(userId: string, r: SignInResult) {
  const [hit] = await db()
    .select({ id: schema.mailAccounts.id })
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.userId, userId), sql`lower(${schema.mailAccounts.address}) = ${r.email}`));
  if (hit) await db().update(schema.mailAccounts).set({ via: "user", displayName: r.displayName }).where(eq(schema.mailAccounts.id, hit.id));
  else await db().insert(schema.mailAccounts).values({ userId, address: r.email, displayName: r.displayName, via: "user" });
}

/** Forget the sign-in: its mailbox leaves the Outlook module, calendars linked through it stop. */
export async function signOutMicrosoft(userId: string) {
  await db().delete(schema.mailAccounts).where(and(eq(schema.mailAccounts.userId, userId), eq(schema.mailAccounts.via, "user")));
  await db().delete(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  forgetUserToken(userId);
}

/** A quick check that the sign-in still works (reads the person's own profile). */
export async function checkSignIn(userId: string, email: string): Promise<void> {
  await asUser({ userId, self: email.toLowerCase() }, () => graph("GET", "me?$select=id"));
}
