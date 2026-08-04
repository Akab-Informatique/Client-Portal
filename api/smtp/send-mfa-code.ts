import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isSmtpConfigured,
  sendPlainEmail,
} from "../_lib/smtp-client.js";

/**
 * POST /api/smtp/send-mfa-code
 * Body: { email, name?, code, locale? }
 * Sends a private one-time MFA backup code. Never logs the code.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isSmtpConfigured()) {
      return res.status(503).json({
        ok: false,
        error:
          "Email is not configured on the server. Set SMTP_HOST, SMTP_FROM_EMAIL, and SMTP_USER/SMTP_PASS, then use an authenticator app code or recovery code instead.",
      });
    }

    const body = (req.body ?? {}) as {
      email?: string;
      name?: string;
      code?: string;
      locale?: string;
    };

    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const code = String(body.code ?? "").replace(/\s+/g, "");
    const name = String(body.name ?? "").trim() || email;
    const locale = String(body.locale ?? "en").toLowerCase().startsWith("fr")
      ? "fr"
      : "en";

    if (!email.includes("@") || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        ok: false,
        error: "Valid email and 6-digit code are required",
      });
    }

    const isFr = locale === "fr";
    const subject = isFr
      ? "Votre code de vérification AKAB"
      : "Your AKAB verification code";
    const text = isFr
      ? [
          `Bonjour ${name},`,
          "",
          "Voici votre code de vérification pour le portail AKAB :",
          "",
          `    ${code}`,
          "",
          "Ce code expire dans 10 minutes. Si vous n'avez pas demandé ce code, ignorez ce message et contactez votre administrateur.",
          "",
          "— Portail AKAB",
        ].join("\n")
      : [
          `Hello ${name},`,
          "",
          "Your AKAB Portal verification code is:",
          "",
          `    ${code}`,
          "",
          "This code expires in 10 minutes. If you did not request it, ignore this email and contact your administrator.",
          "",
          "— AKAB Portal",
        ].join("\n");

    const result = await sendPlainEmail({
      to: email,
      toName: name,
      subject,
      text,
      headerTag: "mfa-code",
    });

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error });
    }

    return res.status(200).json({ ok: true, sent: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
