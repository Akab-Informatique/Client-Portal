import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * POST /api/smtp/send-mfa-code — DISABLED.
 * MFA email codes are sent only via POST /api/auth/mfa { action: "send_email" }
 * after a valid MFA-pending session cookie is established by /api/auth/login.
 * This prevents unauthenticated callers from mailing arbitrary OTP codes.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Allow", "POST");
  return res.status(410).json({
    ok: false,
    error: "Use POST /api/auth/mfa with action send_email after login.",
  });
}
