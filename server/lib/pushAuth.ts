import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { audit } from "./audit.ts";
import { markSessionMfaVerified } from "./auth.ts";
import { randomToken, seal, sha256, unseal } from "./crypto.ts";
import { notify, notifyUserLocked } from "./notify.ts";

/**
 * Signing in with a push notification on the phone.
 *
 * The phone is enrolled once, from a session that is fully signed in and after the password is given again: it makes a
 * passkey (a key pair in the phone's secure hardware, unlocked by its fingerprint / face / PIN — the private key never
 * leaves it), subscribes to web push, and keeps a random device token (only its hash is kept here).
 *
 * To sign in, the person gives their password; that opens a session that is not yet allowed to do anything. The browser
 * asks for an approval: a challenge bound to THAT session, single use, valid two minutes, with a number shown on the
 * computer. The phone gets a push (nothing secret in it), shows where the request comes from and three numbers, and the
 * person picks the one on the computer (number matching: approving by reflex does not work), then unlocks the passkey,
 * which signs the challenge. Only a valid signature from that phone's key, with the person verified on the phone,
 * from the right device token, with the right number, in time, unlocks that session.
 */
const CHALLENGE_SECONDS = 120;
const PUSH_PROVIDER = "push";

// ── where we are: the relying party of the passkeys ──
export function relyingParty(c: Context): { rpID: string; origin: string; rpName: string } {
  const rpName = "Portail AKAB";
  if (config.publicUrl) {
    const u = new URL(config.publicUrl);
    return { rpID: u.hostname, origin: u.origin, rpName };
  }
  // development and tests only (production requires PUBLIC_URL for every link anyway)
  const host = (c.req.header("host") ?? "localhost").replace(/:\d+$/, "");
  const origin = c.req.header("origin") ?? `${new URL(c.req.url).protocol}//${c.req.header("host") ?? "localhost"}`;
  return { rpID: host, origin, rpName };
}

// ── web push keys (VAPID), made once and kept sealed ──
let vapidReady: { publicKey: string } | null = null;
export async function vapid(): Promise<{ publicKey: string }> {
  if (vapidReady) return vapidReady;
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PUSH_PROVIDER));
  let publicKey = (row?.config as { publicKey?: string } | undefined)?.publicKey;
  let privateKey = unseal(row?.secret);
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    await db()
      .insert(schema.integrations)
      .values({ provider: PUSH_PROVIDER, enabled: true, config: { publicKey }, secret: seal(privateKey) })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { config: { publicKey }, secret: seal(privateKey), updatedAt: new Date() } });
  }
  webpush.setVapidDetails(process.env.PUSH_CONTACT ? `mailto:${process.env.PUSH_CONTACT}` : "mailto:portal@akab.ca", publicKey, privateKey);
  vapidReady = { publicKey };
  return vapidReady;
}
/** For the tests: forget the keys kept in memory */
export const resetVapid = () => {
  vapidReady = null;
};

// ── helpers ──
const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** "Chrome sur Windows" from a user agent, for the request shown on the phone */
export function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navigateur";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} / ${os}` : browser;
}

type Device = typeof schema.pushDevices.$inferSelect;
export type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
const zSubscriptionOk = (s: unknown): s is PushSubscriptionJSON => {
  const x = s as PushSubscriptionJSON;
  return Boolean(x && typeof x.endpoint === "string" && x.endpoint.startsWith("https://") && x.endpoint.length < 1000 && typeof x.keys?.p256dh === "string" && typeof x.keys?.auth === "string");
};
export const validSubscription = zSubscriptionOk;

export async function activeDevices(userId: string): Promise<Device[]> {
  return db()
    .select()
    .from(schema.pushDevices)
    .where(and(eq(schema.pushDevices.userId, userId), isNull(schema.pushDevices.revokedAt)));
}
export async function countDevices(userId: string): Promise<number> {
  return (await activeDevices(userId)).length;
}

export async function revokeDevices(userId: string, only?: string): Promise<number> {
  const rows = await db()
    .update(schema.pushDevices)
    .set({ revokedAt: new Date(), subscription: seal("{}") })
    .where(and(eq(schema.pushDevices.userId, userId), isNull(schema.pushDevices.revokedAt), only ? eq(schema.pushDevices.id, only) : undefined))
    .returning({ id: schema.pushDevices.id });
  return rows.length;
}

/** One push to a phone. A subscription the push service says is gone (404 / 410) revokes the phone. */
export async function pushTo(d: Device, payload: Record<string, unknown>): Promise<boolean> {
  await vapid();
  try {
    const sub = JSON.parse(unseal(d.subscription) ?? "{}") as PushSubscriptionJSON;
    if (!validSubscription(sub)) return false;
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: CHALLENGE_SECONDS, urgency: "high" });
    return true;
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await revokeDevices(d.userId, d.id);
      await audit(d.userId, "push.device_gone", d.id, { label: d.label });
    } else console.warn("[push] send failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

// ── enrolling a phone ──
const enrolling = new Map<string, { challenge: string; until: number }>();

export async function enrollOptions(c: Context, user: { id: string; email: string; name: string }, sessionId: string) {
  const rp = relyingParty(c);
  const existing = await activeDevices(user.id);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    timeout: 120_000,
    excludeCredentials: existing.map((d) => ({ id: d.credentialId, transports: d.transports as never })),
    // the phone's own secure hardware, unlocked by the person (fingerprint, face or PIN)
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "discouraged", userVerification: "required" },
  });
  enrolling.set(sessionId, { challenge: options.challenge, until: Date.now() + 5 * 60_000 });
  return options;
}

export async function enrollVerify(c: Context, user: { id: string; email: string; name: string }, sessionId: string, p: { label: string; subscription: unknown; response: RegistrationResponseJSON }) {
  const rp = relyingParty(c);
  const pending = enrolling.get(sessionId);
  enrolling.delete(sessionId);
  if (!pending || pending.until < Date.now()) throw new PushError("enroll_expired");
  if (!validSubscription(p.subscription)) throw new PushError("bad_subscription");
  let verified;
  try {
    verified = await verifyRegistrationResponse({ response: p.response, expectedChallenge: pending.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch (e) {
    console.warn("[push] enrollment refused:", e instanceof Error ? e.message : e);
    throw new PushError("bad_attestation");
  }
  if (!verified.verified || !verified.registrationInfo) throw new PushError("bad_attestation");
  const cred = verified.registrationInfo.credential;
  const token = randomToken();
  const [row] = await db()
    .insert(schema.pushDevices)
    .values({
      userId: user.id,
      label: p.label.trim().slice(0, 60) || describeAgent(c.req.header("user-agent") ?? ""),
      credentialId: cred.id,
      publicKey: b64url(cred.publicKey),
      counter: cred.counter,
      transports: (cred.transports ?? []) as string[],
      subscription: seal(JSON.stringify(p.subscription)),
      tokenHash: hashToken(token),
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
    })
    .returning();
  await audit(user.id, "push.device_added", row.id, { label: row.label });
  await notify([user.id], { type: "security.alert", data: { kind: "device_added", label: row.label }, link: "/?profile=security" });
  // the phone proves it receives them
  void pushTo(row, { type: "test", title: "Portail AKAB", body: "Ce téléphone approuvera vos connexions." });
  return { device: row, token };
}

// ── the request to approve ──
export class PushError extends Error {
  constructor(
    public code: "enroll_expired" | "bad_subscription" | "bad_attestation" | "no_device" | "too_soon" | "rate_limited" | "not_found" | "expired" | "bad_device" | "wrong_number" | "bad_assertion" | "already_answered",
    public retryAfter?: number,
  ) {
    super(code);
  }
}

export async function startChallenge(c: Context, a: { user: { id: string; name: string }; sessionId: string }) {
  const devices = await activeDevices(a.user.id);
  if (!devices.length) throw new PushError("no_device");
  const now = new Date();
  // one request at a time per sign-in, not more often than every 15 s, 6 an hour per person
  const [last] = await db().select().from(schema.pushChallenges).where(eq(schema.pushChallenges.sessionId, a.sessionId)).orderBy(desc(schema.pushChallenges.createdAt)).limit(1);
  if (last && last.status === "pending" && last.expiresAt > now && now.getTime() - last.createdAt.getTime() < 15_000) throw new PushError("too_soon", 15);
  const [{ n }] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.pushChallenges)
    .where(and(eq(schema.pushChallenges.userId, a.user.id), gt(schema.pushChallenges.createdAt, new Date(now.getTime() - 3_600_000))));
  if (n >= 6) throw new PushError("rate_limited", 600);
  // an earlier request of this sign-in is closed
  await db().update(schema.pushChallenges).set({ status: "failed", answeredAt: now }).where(and(eq(schema.pushChallenges.sessionId, a.sessionId), eq(schema.pushChallenges.status, "pending")));
  const number = randomInt(10, 100);
  const decoys = new Set<number>();
  while (decoys.size < 2) {
    const d = randomInt(10, 100);
    if (d !== number) decoys.add(d);
  }
  const [row] = await db()
    .insert(schema.pushChallenges)
    .values({
      userId: a.user.id,
      sessionId: a.sessionId,
      nonce: randomToken().slice(0, 43),
      number,
      decoys: [...decoys],
      ip: (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "").slice(0, 60),
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
      expiresAt: new Date(now.getTime() + CHALLENGE_SECONDS * 1000),
    })
    .returning();
  // nothing secret in the push: the phone asks for the details with its own token
  let sent = 0;
  for (const d of devices) if (await pushTo(d, { type: "signin", challengeId: row.id, deviceId: d.id, title: "Connexion au portail", body: "Touchez pour approuver ou refuser." })) sent++;
  await audit(a.user.id, "push.challenge_sent", row.id, { devices: devices.length, sent });
  return { id: row.id, number, expiresAt: row.expiresAt, sent, devices: devices.length };
}

/** The state of the waiting browser's latest request */
export async function sessionChallenge(sessionId: string) {
  const [row] = await db().select().from(schema.pushChallenges).where(eq(schema.pushChallenges.sessionId, sessionId)).orderBy(desc(schema.pushChallenges.createdAt)).limit(1);
  if (!row) return { status: "none" as const };
  const status = row.status === "pending" && row.expiresAt <= new Date() ? ("expired" as const) : row.status;
  return { status, id: row.id, number: status === "pending" ? row.number : undefined, expiresAt: row.expiresAt };
}

// ── what the phone does ──
async function deviceOf(deviceId: string, token: string): Promise<Device> {
  const [d] = await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.id, deviceId));
  // the same answer for an unknown phone, a revoked one and a wrong token
  if (!d || d.revokedAt || !sameHash(d.tokenHash, hashToken(token))) throw new PushError("bad_device");
  return d;
}

async function pendingFor(d: Device, challengeId?: string) {
  const now = new Date();
  const rows = await db()
    .select()
    .from(schema.pushChallenges)
    .where(and(eq(schema.pushChallenges.userId, d.userId), eq(schema.pushChallenges.status, "pending"), gt(schema.pushChallenges.expiresAt, now), challengeId ? eq(schema.pushChallenges.id, challengeId) : undefined))
    .orderBy(desc(schema.pushChallenges.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** What the phone shows: where the request comes from, three numbers, and the options for the passkey */
export async function deviceChallenge(c: Context, p: { deviceId: string; token: string; challengeId?: string }) {
  const d = await deviceOf(p.deviceId, p.token);
  const ch = await pendingFor(d, p.challengeId);
  if (!ch) return { pending: false as const };
  const rp = relyingParty(c);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    // the nonce as bytes: the phone gets it back as the same base64url text
    challenge: fromB64url(ch.nonce),
    timeout: 90_000,
    userVerification: "required",
    allowCredentials: [{ id: d.credentialId, transports: d.transports as never }],
  });
  // the three numbers in a random order
  const numbers = [ch.number, ...ch.decoys].map((n) => ({ n, k: randomInt(0, 1_000_000) })).sort((x, y) => x.k - y.k).map((x) => x.n);
  return {
    pending: true as const,
    challengeId: ch.id,
    numbers,
    where: { ip: ch.ip, agent: describeAgent(ch.userAgent), at: ch.createdAt, expiresAt: ch.expiresAt },
    options,
  };
}

export async function deviceRespond(c: Context, p: { deviceId: string; token: string; challengeId: string; number: number; response: AuthenticationResponseJSON }) {
  const d = await deviceOf(p.deviceId, p.token);
  const ch = await pendingFor(d, p.challengeId);
  if (!ch) throw new PushError("expired");
  // the number: a wrong one twice closes the request (someone guessing, or approving by reflex)
  if (p.number !== ch.number) {
    const wrong = ch.wrongTries + 1;
    await db()
      .update(schema.pushChallenges)
      .set(wrong >= 2 ? { wrongTries: wrong, status: "failed", answeredAt: new Date(), deviceId: d.id } : { wrongTries: wrong })
      .where(and(eq(schema.pushChallenges.id, ch.id), eq(schema.pushChallenges.status, "pending")));
    await audit(d.userId, "push.wrong_number", ch.id, { tries: wrong });
    throw new PushError("wrong_number");
  }
  const rp = relyingParty(c);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: p.response,
      expectedChallenge: ch.nonce,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: { id: d.credentialId, publicKey: fromB64url(d.publicKey) as Uint8Array<ArrayBuffer>, counter: d.counter, transports: d.transports as never },
    });
  } catch (e) {
    console.warn("[push] assertion refused:", e instanceof Error ? e.message : e);
    await audit(d.userId, "push.bad_assertion", ch.id, {});
    throw new PushError("bad_assertion");
  }
  if (!result.verified) throw new PushError("bad_assertion");
  // approved: once, and only if still pending (two answers at once cannot both win)
  const won = await db()
    .update(schema.pushChallenges)
    .set({ status: "approved", answeredAt: new Date(), deviceId: d.id })
    .where(and(eq(schema.pushChallenges.id, ch.id), eq(schema.pushChallenges.status, "pending"), gt(schema.pushChallenges.expiresAt, new Date())))
    .returning({ id: schema.pushChallenges.id });
  if (won.length !== 1) throw new PushError("already_answered");
  await db().update(schema.pushDevices).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(schema.pushDevices.id, d.id));
  // the one session that asked, and no other
  await markSessionMfaVerified(ch.sessionId);
  await audit(d.userId, "push.signin_approved", ch.id, { device: d.label, ip: ch.ip });
  return { ok: true as const };
}

/** "Ce n'est pas moi": the request is refused and the session that asked is closed; the account rests 15 minutes and the admins are told */
export async function deviceDeny(p: { deviceId: string; token: string; challengeId: string }) {
  const d = await deviceOf(p.deviceId, p.token);
  const ch = await pendingFor(d, p.challengeId);
  if (!ch) throw new PushError("expired");
  const done = await db()
    .update(schema.pushChallenges)
    .set({ status: "denied", answeredAt: new Date(), deviceId: d.id })
    .where(and(eq(schema.pushChallenges.id, ch.id), eq(schema.pushChallenges.status, "pending")))
    .returning({ id: schema.pushChallenges.id });
  if (done.length !== 1) throw new PushError("already_answered");
  await db().delete(schema.sessions).where(eq(schema.sessions.id, ch.sessionId));
  const [user] = await db().update(schema.users).set({ lockedUntil: new Date(Date.now() + 15 * 60_000) }).where(eq(schema.users.id, d.userId)).returning();
  await audit(d.userId, "push.signin_denied", ch.id, { device: d.label, ip: ch.ip });
  await notify([d.userId], { type: "security.alert", data: { kind: "signin_denied", ip: ch.ip, agent: describeAgent(ch.userAgent) }, link: "/?profile=security" });
  if (user) await notifyUserLocked(user);
  return { ok: true as const };
}

/** The browser of the phone renewed its push subscription */
export async function deviceRefresh(p: { deviceId: string; token: string; subscription: unknown }) {
  const d = await deviceOf(p.deviceId, p.token);
  if (!validSubscription(p.subscription)) throw new PushError("bad_subscription");
  await db().update(schema.pushDevices).set({ subscription: seal(JSON.stringify(p.subscription)) }).where(eq(schema.pushDevices.id, d.id));
}

/** The first 8 characters of a hash, for the logs only */
export const short = (t: string) => sha256(t).slice(0, 8);
