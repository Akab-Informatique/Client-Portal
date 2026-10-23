import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { audit } from "../lib/audit.ts";
import { auth, isFullySignedIn, type AppEnv } from "../lib/auth.ts";
import { verifyPassword } from "../lib/crypto.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
import { body } from "../lib/validate.ts";
import { pushDetailed } from "../lib/pushAuth.ts";
import { pushEndpointOk, deviceChallenge, deviceDeny, deviceRefresh, deviceRespond, enrollOptions, enrollVerify, PushError, revokeDevices, sessionChallenge, startChallenge, vapid } from "../lib/pushAuth.ts";

/**
 * Approving a sign-in on the phone (see lib/pushAuth.ts). Three groups of routes:
 *  - a signed-in person enrolling or removing their phones (password asked again),
 *  - the browser that is waiting after the password (start, status) — only the session that asked is ever unlocked,
 *  - the phone itself (device token + passkey), which has no session.
 */
const http = (e: unknown): never => {
  if (e instanceof PushError) {
    const status = e.code === "rate_limited" || e.code === "too_soon" ? 429 : e.code === "bad_device" ? 401 : e.code === "not_found" ? 404 : e.code === "no_device" || e.code === "already_answered" || e.code === "expired" ? 409 : 400;
    throw new HTTPException(status, { message: `push_${e.code}` });
  }
  throw e;
};

const zResponse = z.looseObject({ id: z.string().max(1000), rawId: z.string().max(1000), type: z.literal("public-key"), response: z.looseObject({}) });
const zSubscription = z.object({ endpoint: z.string().url().max(1000).refine(pushEndpointOk, "push_endpoint"), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
const zDevice = z.object({ deviceId: z.uuid(), token: z.string().min(20).max(200) });

const ready = (c: Parameters<typeof auth>[0]) => {
  const a = auth(c);
  if (!isFullySignedIn(a)) throw new HTTPException(401, { message: "Authentication required" });
  return a;
};

export const pushAuthRoutes = new Hono<AppEnv>()
  // ── enrolling a phone (fully signed in) ──
  .get("/devices", async (c) => {
    const a = ready(c);
    const rows = await db().select().from(schema.pushDevices).where(and(eq(schema.pushDevices.userId, a.user.id), isNull(schema.pushDevices.revokedAt))).orderBy(asc(schema.pushDevices.createdAt));
    return c.json({ vapidPublicKey: (await vapid()).publicKey, devices: rows.map((d) => ({ id: d.id, label: d.label, notify: d.notify, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, userAgent: d.userAgent })) });
  })

  /** The passkey options for this phone — the password is asked again (adding a phone is as sensitive as changing it) */
  .post("/enroll/options", async (c) => {
    const a = ready(c);
    const lim = rateLimit(`push:enroll:${a.user.id}`, 6, 15 * 60_000);
    if (!lim.ok) throw new HTTPException(429, { message: "rate_limited" });
    if (a.viewAs) throw new HTTPException(403, { message: "read_only_view" });
    const { password } = await body(c, z.object({ password: z.string().min(1).max(200) }));
    if (!(await verifyPassword(password, a.user.passwordHash))) throw new HTTPException(401, { message: "wrong_password" });
    return c.json(await enrollOptions(c, a.user, a.sessionId).catch(http));
  })

  .post("/enroll/verify", async (c) => {
    const a = ready(c);
    const p = await body(c, z.object({ label: z.string().trim().max(60).default(""), subscription: zSubscription, response: zResponse }));
    const r = await enrollVerify(c, a.user, a.sessionId, { label: p.label, subscription: p.subscription, response: p.response as never }).catch(http);
    return c.json({ id: r.device.id, label: r.device.label, token: r.token }, 201);
  })

  /** This phone takes the portal's notifications, or not */
  .patch("/devices/:id", async (c) => {
    const a = ready(c);
    if (a.viewAs) throw new HTTPException(403, { message: "read_only_view" });
    const id = z.uuid().parse(c.req.param("id"));
    const p = await body(c, z.object({ notify: z.boolean() }));
    const [row] = await db()
      .update(schema.pushDevices)
      .set({ notify: p.notify })
      .where(and(eq(schema.pushDevices.id, id), eq(schema.pushDevices.userId, a.user.id), isNull(schema.pushDevices.revokedAt)))
      .returning({ id: schema.pushDevices.id });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, p.notify ? "push.notifications_on" : "push.notifications_off", id, {});
    return c.json({ ok: true });
  })

  /** A test notification to this phone (what a real one looks like, with the person's lock screen choice) */
  .post("/devices/:id/test", async (c) => {
    const a = ready(c);
    const id = z.uuid().parse(c.req.param("id"));
    if (!rateLimit(`push:test:${a.user.id}`, 6, 5 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const [d] = await db().select().from(schema.pushDevices).where(and(eq(schema.pushDevices.id, id), eq(schema.pushDevices.userId, a.user.id), isNull(schema.pushDevices.revokedAt)));
    if (!d) throw new HTTPException(404, { message: "not_found" });
    const [pref] = await db().select({ details: schema.userPreferences.pushDetails }).from(schema.userPreferences).where(eq(schema.userPreferences.userId, a.user.id));
    const fr = a.user.locale !== "en";
    const outcome = await pushDetailed(d, {
      type: "notify",
      notifType: "test",
      title: fr ? "Portail AKAB" : "AKAB portal",
      body: pref?.details ? (fr ? "Notification de test : tout fonctionne." : "Test notification: everything works.") : fr ? "Touchez pour ouvrir le portail." : "Tap to open the portal.",
      url: "/",
    });
    return c.json({ sent: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason, status: outcome.status }) });
  })

  .delete("/devices/:id", async (c) => {
    const a = ready(c);
    if (a.viewAs) throw new HTTPException(403, { message: "read_only_view" });
    const id = z.uuid().parse(c.req.param("id"));
    const n = await revokeDevices(a.user.id, id);
    if (!n) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "push.device_removed", id, {});
    return c.json({ ok: true });
  })

  // ── the browser waiting for the approval (after the password) ──
  .post("/start", async (c) => {
    const a = auth(c);
    // only a session that gave the password and still needs its second step
    if (!config.requireMfa || a.mfaVerified) throw new HTTPException(409, { message: "push_not_needed" });
    const lim = rateLimit(`push:start:ip:${clientIp(c)}`, 30, 15 * 60_000);
    if (!lim.ok) throw new HTTPException(429, { message: "rate_limited" });
    const r = await startChallenge(c, { user: a.user, sessionId: a.sessionId }).catch(http);
    return c.json({ id: r.id, number: r.number, expiresAt: r.expiresAt, sent: r.sent, devices: r.devices, failures: r.failures });
  })

  .get("/status", async (c) => {
    const a = auth(c);
    if (a.mfaVerified) return c.json({ status: "approved" });
    return c.json(await sessionChallenge(a.sessionId));
  })

  // ── the phone (device token + passkey) ──
  .post("/device/challenge", async (c) => {
    const p = await body(c, zDevice.extend({ challengeId: z.uuid().optional() }));
    if (!rateLimit(`push:dev:ip:${clientIp(c)}`, 60, 15 * 60_000).ok || !rateLimit(`push:dev:${p.deviceId}`, 40, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    return c.json(await deviceChallenge(c, p).catch(http));
  })

  .post("/device/respond", async (c) => {
    const p = await body(c, zDevice.extend({ challengeId: z.uuid(), number: z.number().int().min(10).max(99), response: zResponse }));
    if (!rateLimit(`push:dev:ip:${clientIp(c)}`, 60, 15 * 60_000).ok || !rateLimit(`push:dev:${p.deviceId}`, 40, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    return c.json(await deviceRespond(c, { ...p, response: p.response as never }).catch(http));
  })

  .post("/device/deny", async (c) => {
    const p = await body(c, zDevice.extend({ challengeId: z.uuid() }));
    if (!rateLimit(`push:dev:ip:${clientIp(c)}`, 60, 15 * 60_000).ok || !rateLimit(`push:dev:${p.deviceId}`, 40, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    return c.json(await deviceDeny(p).catch(http));
  })

  .post("/device/refresh", async (c) => {
    const p = await body(c, zDevice.extend({ subscription: zSubscription }));
    if (!rateLimit(`push:dev:${p.deviceId}`, 40, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    await deviceRefresh(p).catch(http);
    return c.json({ ok: true });
  });

