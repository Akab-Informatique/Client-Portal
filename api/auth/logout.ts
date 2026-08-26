import type { VercelRequest, VercelResponse } from "@vercel/node";
import { assertSameOrigin } from "../_lib/request-guard.js";
import {
  clearMfaPendingCookie,
  clearSessionCookie,
} from "../_lib/session.js";

/**
 * POST /api/auth/logout — clear HttpOnly session + MFA pending cookies.
 * Always drops both cookies so a half-finished MFA login cannot be resumed
 * on a shared browser after "cancel" / "sign out".
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
  // Explicitly clear both — clearSessionCookie also clears MFA pending, but
  // call both so the contract stays obvious and survives refactors.
  clearSessionCookie(res, req);
  clearMfaPendingCookie(res, req);
  return res.status(200).json({ ok: true });
}
