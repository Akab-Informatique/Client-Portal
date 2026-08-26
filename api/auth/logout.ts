import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bumpSessionEpoch, loadUserById } from "../_lib/auth-server.js";
import { assertSameOrigin } from "../_lib/request-guard.js";
import {
  clearMfaPendingCookie,
  clearSessionCookie,
  readSession,
} from "../_lib/session.js";

/**
 * POST /api/auth/logout — clear HttpOnly session + MFA pending cookies
 * and bump users.session_epoch so a copied cookie cannot be reused.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const originErr = assertSameOrigin(req);
  if (originErr) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const session = readSession(req);
  if (session?.uid) {
    try {
      const user = await loadUserById(session.uid);
      if (user) await bumpSessionEpoch(user.id);
    } catch (err) {
      console.warn("[auth/logout] epoch bump failed", err);
    }
  }

  clearSessionCookie(res, req);
  clearMfaPendingCookie(res, req);
  return res.status(200).json({ ok: true });
}
