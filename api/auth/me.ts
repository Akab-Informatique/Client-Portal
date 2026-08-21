import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isMfaEnabled,
  loadUserById,
  toSessionUserDto,
} from "../_lib/auth-server.js";
import {
  clearSessionCookie,
  readMfaPending,
  readSession,
  setMfaPendingCookie,
} from "../_lib/session.js";
import { isPostgresConfigured } from "../_lib/pg.js";

/**
 * GET /api/auth/me
 * Returns current session user (no secrets) or MFA-pending state.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (!isPostgresConfigured()) {
      return res.status(503).json({ ok: false, error: "Database not configured" });
    }

    const session = readSession(req);
    if (session) {
      const user = await loadUserById(session.uid);
      if (!user || !user.active) {
        clearSessionCookie(res);
        return res.status(401).json({ ok: false, user: null });
      }
      if (!isMfaEnabled(user)) {
        // Force re-enroll — clear full session
        clearSessionCookie(res);
        setMfaPendingCookie(res, {
          uid: user.id,
          email: user.email,
          name: user.name,
          kind: "enroll",
        });
        return res.status(200).json({
          ok: true,
          user: null,
          mfaPending: {
            kind: "enroll",
            email: user.email,
            name: user.name,
          },
        });
      }
      const dto = await toSessionUserDto(user);
      return res.status(200).json({ ok: true, user: dto, mfaPending: null });
    }

    const pending = readMfaPending(req);
    if (pending) {
      return res.status(200).json({
        ok: true,
        user: null,
        mfaPending: {
          kind: pending.kind,
          email: pending.email,
          name: pending.name,
        },
      });
    }

    return res.status(200).json({ ok: true, user: null, mfaPending: null });
  } catch (err) {
    console.error("[auth/me]", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
