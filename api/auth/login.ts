import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isMfaEnabled,
  loadUserByEmail,
} from "../_lib/auth-server.js";
import {
  clearSessionCookie,
  setMfaPendingCookie,
} from "../_lib/session.js";
import { isPostgresConfigured } from "../_lib/pg.js";

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Verifies credentials server-side and sets HttpOnly MFA-pending cookie.
 * Never returns password hashes or MFA secrets.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
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

    const found = await loadUserByEmail(email);
    // Constant-ish failure path
    if (!found || found.password !== password) {
      return res.status(401).json({ ok: false, error: "invalid" });
    }
    if (!found.active) {
      return res.status(403).json({ ok: false, error: "deactivated" });
    }

    clearSessionCookie(res);
    const kind = isMfaEnabled(found) ? "challenge" : "enroll";
    setMfaPendingCookie(res, {
      uid: found.id,
      email: found.email,
      name: found.name,
      kind,
    });

    return res.status(200).json({
      ok: true,
      needsMfa: true,
      kind,
      email: found.email,
      name: found.name,
    });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
