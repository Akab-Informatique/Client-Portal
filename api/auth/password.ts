import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  bumpSessionEpoch,
  isMfaEnabled,
  requireSessionUser,
} from "../_lib/auth-server.js";
import { hashPassword, verifyPassword } from "../_lib/passwords.js";
import { getPool, isPostgresConfigured } from "../_lib/pg.js";
import { clientIp, rateLimit } from "../_lib/rate-limit.js";
import { assertSameOrigin } from "../_lib/request-guard.js";
import { readSession, setSessionCookie } from "../_lib/session.js";

export const MIN_PASSWORD_LENGTH = 10;

/**
 * POST /api/auth/password
 * Body: { currentPassword, newPassword }
 * Self-service password change. The current password is verified server-side
 * (bcrypt), the policy is enforced here, and every other session is revoked.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (assertSameOrigin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    if (!isPostgresConfigured()) {
      return res.status(503).json({ ok: false, error: "server_error" });
    }

    const user = await requireSessionUser(readSession(req));
    if (!user || !isMfaEnabled(user)) {
      return res.status(401).json({ ok: false, error: "not_signed_in" });
    }

    const lim = rateLimit({
      key: `password:uid:${user.id}`,
      limit: 5,
      windowMs: 15 * 60_000,
    });
    const ipLim = rateLimit({
      key: `password:ip:${clientIp(req)}`,
      limit: 20,
      windowMs: 15 * 60_000,
    });
    if (!lim.allowed || !ipLim.allowed) {
      res.setHeader(
        "Retry-After",
        String(Math.max(lim.retryAfterSec, ipLim.retryAfterSec)),
      );
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const body = (req.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    const current = String(body.currentPassword ?? "");
    const next = String(body.newPassword ?? "");

    if (next.trim().length < MIN_PASSWORD_LENGTH || next.length > 200) {
      return res.status(400).json({ ok: false, error: "short" });
    }
    const check = await verifyPassword(current, user.password);
    if (!check.ok) {
      return res.status(401).json({ ok: false, error: "wrong_current" });
    }
    if (current === next) {
      return res.status(400).json({ ok: false, error: "same" });
    }

    await getPool().query(`UPDATE users SET password = $1 WHERE id = $2`, [
      await hashPassword(next),
      user.id,
    ]);
    // Revoke every other device, then keep this browser signed in.
    const epoch = await bumpSessionEpoch(user.id);
    setSessionCookie(res, user.id, req, epoch);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[auth/password]", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
