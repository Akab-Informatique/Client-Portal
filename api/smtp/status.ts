import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSmtpPublicStatus,
  isSmtpConfigured,
  testSmtpConnection,
} from "../_lib/smtp-client.js";

/**
 * GET /api/smtp/status?verify=1
 * Returns SMTP configuration presence (never the password).
 * Optional verify=1 runs transporter.verify().
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const publicStatus = getSmtpPublicStatus();
    if (!publicStatus.configured) {
      return res.status(200).json({
        ...publicStatus,
        ok: false,
        error:
          "SMTP not configured. Set SMTP_HOST, SMTP_FROM_EMAIL, and usually SMTP_USER + SMTP_PASS in app secrets.",
      });
    }

    const wantVerify =
      String(req.query.verify ?? "") === "1" ||
      String(req.query.verify ?? "").toLowerCase() === "true";

    if (!wantVerify) {
      return res.status(200).json({
        ...publicStatus,
        ok: true,
        verified: false,
        hint: "Add ?verify=1 to test the SMTP connection.",
      });
    }

    const result = await testSmtpConnection();
    return res.status(200).json({
      ...publicStatus,
      ok: result.ok,
      verified: result.ok,
      error: result.error ?? null,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isSmtpConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
