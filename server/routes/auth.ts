import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import {
  auth,
  createSession,
  destroySession,
  isFullySignedIn,
  markSessionMfaVerified,
  revokeUserSessions,
  type AppEnv,
  type AuthContext,
} from "../lib/auth.ts";
import { hashPassword, newTotpSecret, passwordProblem, seal, totpStep, totpUri, unseal, verifyPassword } from "../lib/crypto.ts";
import { clientIp, rateLimit, resetRateLimit } from "../lib/http.ts";
import { body, zEmail } from "../lib/validate.ts";
import { audit } from "../lib/audit.ts";
import { loadMe } from "./me.ts";

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

/** What the signed-in user must do next before using the portal. */
export function stageOf(a: AuthContext | null): "anonymous" | "mfa" | "mfa-setup" | "password" | "ready" {
  if (!a) return "anonymous";
  if (config.requireMfa && !a.mfaVerified) return a.user.mfaEnabled ? "mfa" : "mfa-setup";
  if (a.user.mustChangePassword) return "password";
  return isFullySignedIn(a) ? "ready" : "anonymous";
}

export const authRoutes = new Hono<AppEnv>()
  .get("/me", async (c) => {
    const a = c.var.auth;
    const stage = stageOf(a);
    if (!a) return c.json({ stage });
    return c.json({ stage, me: stage === "ready" ? await loadMe(a) : { name: a.user.name, email: a.user.email, locale: a.user.locale } });
  })

  .post("/login", async (c) => {
    const { email, password } = await body(c, z.object({ email: zEmail, password: z.string().min(1).max(200) }));
    const ip = clientIp(c);
    const byIp = rateLimit(`login:ip:${ip}`, 60, 15 * 60_000);
    const byEmail = rateLimit(`login:email:${email}`, 10, 15 * 60_000);
    if (!byIp.ok || !byEmail.ok) {
      c.header("Retry-After", String(Math.max(byIp.retryAfter, byEmail.retryAfter)));
      throw new HTTPException(429, { message: "rate_limited" });
    }
    const [user] = await db()
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`);
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw new HTTPException(429, { message: "rate_limited" });
    }
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!user || !ok || !user.active) {
      if (user && !ok) {
        const fails = user.failedLogins + 1;
        await db()
          .update(schema.users)
          .set(
            fails >= LOCK_AFTER
              ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
              : { failedLogins: fails },
          )
          .where(eq(schema.users.id, user.id));
      }
      throw new HTTPException(401, { message: "invalid_credentials" });
    }
    resetRateLimit(`login:email:${email}`);
    await db()
      .update(schema.users)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));
    // New session id on every login (no fixation); the cookie is overwritten below.
    await destroySession(c, { keepCookie: true });
    await createSession(c, user.id, !config.requireMfa);
    const stage = config.requireMfa ? (user.mfaEnabled ? "mfa" : "mfa-setup") : user.mustChangePassword ? "password" : "ready";
    return c.json({ stage });
  })

  /** First sign-in: create a pending TOTP secret and return the QR code. */
  .post("/mfa/setup", async (c) => {
    const a = auth(c);
    if (a.user.mfaEnabled) throw new HTTPException(409, { message: "mfa_already_enabled" });
    const secret = newTotpSecret();
    await db().update(schema.users).set({ mfaSecret: seal(secret) }).where(eq(schema.users.id, a.user.id));
    const uri = totpUri(secret, a.user.email);
    return c.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  })

  /** Verify a 6-digit code: completes setup or the sign-in challenge. Codes are single-use. */
  .post("/mfa/verify", async (c) => {
    const a = auth(c);
    const { code } = await body(c, z.object({ code: z.string().trim().min(6).max(12) }));
    const lim = rateLimit(`mfa:${a.user.id}`, 8, 15 * 60_000);
    if (!lim.ok) throw new HTTPException(429, { message: "rate_limited" });
    const secret = unseal(a.user.mfaSecret);
    if (!secret) throw new HTTPException(400, { message: "mfa_not_started" });
    const step = totpStep(secret, code);
    if (step === null) throw new HTTPException(401, { message: "invalid_code" });
    // Atomic: the same code (time-step) can never be accepted twice
    const res = await db()
      .update(schema.users)
      .set({ mfaLastStep: step, mfaEnabled: true })
      .where(
        and(
          eq(schema.users.id, a.user.id),
          or(isNull(schema.users.mfaLastStep), lt(schema.users.mfaLastStep, step)),
        ),
      )
      .returning({ id: schema.users.id });
    if (res.length !== 1) throw new HTTPException(401, { message: "invalid_code" });
    if (!a.user.mfaEnabled) await audit(a.user.id, "mfa.enabled", a.user.id);
    resetRateLimit(`mfa:${a.user.id}`);
    await markSessionMfaVerified(a.sessionId);
    return c.json({ stage: a.user.mustChangePassword ? "password" : "ready" });
  })

  .post("/password", async (c) => {
    const a = auth(c);
    if (config.requireMfa && !a.mfaVerified) throw new HTTPException(401, { message: "mfa_required" });
    const { current, next } = await body(c, z.object({ current: z.string().max(200), next: z.string().max(200) }));
    const lim = rateLimit(`password:${a.user.id}`, 6, 15 * 60_000);
    if (!lim.ok) throw new HTTPException(429, { message: "rate_limited" });
    if (!(await verifyPassword(current, a.user.passwordHash))) throw new HTTPException(401, { message: "wrong_password" });
    const problem = passwordProblem(next);
    if (problem) throw new HTTPException(400, { message: `password_${problem}` });
    if (next === current) throw new HTTPException(400, { message: "password_same" });
    await db()
      .update(schema.users)
      .set({ passwordHash: await hashPassword(next), mustChangePassword: false, updatedAt: new Date() })
      .where(eq(schema.users.id, a.user.id));
    await revokeUserSessions(a.user.id, a.sessionId);
    await audit(a.user.id, "password.changed", a.user.id);
    return c.json({ stage: "ready" });
  })

  .post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });
