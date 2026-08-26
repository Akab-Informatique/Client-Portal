import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isMfaEnabled,
  loadUserByEmail,
} from "../_lib/auth-server.js";
import { hashPassword, verifyPassword } from "../_lib/passwords.js";
import { getPool, isPostgresConfigured } from "../_lib/pg.js";
import {
  clientIp,
  rateLimit,
  rateLimitReset,
} from "../_lib/rate-limit.js";
import { assertSameOrigin } from "../_lib/request-guard.js";
import {
  clearSessionCookie,
  setMfaPendingCookie,
} from "../_lib/session.js";

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Verifies credentials server-side (bcrypt) and sets HttpOnly MFA-pending cookie.
 * Never returns password hashes or MFA secrets.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const originErr = assertSameOrigin(req);
    if (originErr) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    if (!isPostgresConfigured()) {
      return res.status(503).json({ error: "Database not configured" });
    }

    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "invalid" });
    }

    const ip = clientIp(req);
    const ipLimit = rateLimit({
      key: `login:ip:${ip}`,
      limit: 30,
      windowMs: 15 * 60_000,
    });
    const emailLimit = rateLimit({
      key: `login:email:${email}`,
      limit: 10,
      windowMs: 15 * 60_000,
    });
    if (!ipLimit.allowed || !emailLimit.allowed) {
      res.setHeader(
        "Retry-After",
        String(Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec)),
      );
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const found = await loadUserByEmail(email);
    const check = await verifyPassword(password, found?.password);
    // Generic failure for wrong password, missing user, AND deactivated —
    // do not reveal which emails exist or which accounts are disabled.
    if (!found || !check.ok || !found.active) {
      return res.status(401).json({ ok: false, error: "invalid" });
    }

    if (check.needsRehash) {
      try {
        const hashed = await hashPassword(password);
        await getPool().query(`UPDATE users SET password = $1 WHERE id = $2`, [
          hashed,
          found.id,
        ]);
      } catch (e) {
        console.warn("[auth/login] password rehash failed", e);
      }
    }

    rateLimitReset(`login:email:${email}`);
    clearSessionCookie(res, req);
    const kind = isMfaEnabled(found) ? "challenge" : "enroll";
    setMfaPendingCookie(
      res,
      {
        uid: found.id,
        email: found.email,
        name: found.name,
        kind,
      },
      req,
    );

    // Do not echo name/email until MFA completes (me endpoint after session).
    return res.status(200).json({
      ok: true,
      needsMfa: true,
      kind,
    });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
