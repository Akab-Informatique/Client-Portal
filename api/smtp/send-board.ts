import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isSmtpConfigured,
  sendBoardEmailsIndividually,
  type BoardEmailRecipient,
} from "../_lib/smtp-client.js";

/**
 * POST /api/smtp/send-board
 *
 * Body:
 * {
 *   title, body, authorName,
 *   portalUrl?,
 *   recipients: [{ email, name, companyName? }, ...]
 * }
 *
 * Sends ONE private email per recipient (To: single address).
 * Recipients never see each other's addresses.
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
          "SMTP is not configured. An admin must set SMTP settings under Settings (app secrets).",
        sent: 0,
        failed: 0,
      });
    }

    const body = (req.body ?? {}) as {
      title?: string;
      body?: string;
      authorName?: string;
      portalUrl?: string | null;
      recipients?: BoardEmailRecipient[];
    };

    const title = String(body.title ?? "").trim();
    const messageBody = String(body.body ?? "").trim();
    const authorName = String(body.authorName ?? "AKAB").trim() || "AKAB";
    const portalUrl = body.portalUrl ? String(body.portalUrl).trim() : null;
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    if (!title || !messageBody) {
      return res.status(400).json({
        ok: false,
        error: "Title and body are required.",
        sent: 0,
        failed: 0,
      });
    }

    if (recipients.length === 0) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        skipped: true,
        message: "No recipients opted in for board emails.",
      });
    }

    // Dedupe by email (case-insensitive)
    const seen = new Set<string>();
    const unique: BoardEmailRecipient[] = [];
    for (const r of recipients) {
      const email = String(r?.email ?? "")
        .trim()
        .toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      unique.push({
        email,
        name: String(r?.name ?? email).trim() || email,
        companyName: r?.companyName ? String(r.companyName) : undefined,
      });
    }

    // Cap bulk sends to protect SMTP providers
    if (unique.length > 200) {
      return res.status(400).json({
        ok: false,
        error: "Too many recipients in one post (max 200). Split the send.",
        sent: 0,
        failed: 0,
      });
    }

    const result = await sendBoardEmailsIndividually({
      recipients: unique,
      payload: {
        title,
        body: messageBody,
        authorName,
        portalUrl,
      },
    });

    return res.status(200).json({
      ok: result.failed === 0,
      sent: result.sent,
      failed: result.failed,
      errors: result.errors.slice(0, 10),
      // Do not return full recipient list with secrets; emails only for audit UI
      recipientCount: unique.length,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
      sent: 0,
      failed: 0,
    });
  }
}
