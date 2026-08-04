/**
 * SMTP helper for board-message emails (server-only).
 * Uses nodemailer. Credentials from env / secrets.
 *
 * Privacy: each recipient is sent as a separate message (To: one address only).
 * Never put multiple client addresses on the same To/Cc line.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
};

function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function getSmtpConfigFromEnv(): SmtpConfig | null {
  const host = cleanEnv(process.env.SMTP_HOST);
  const fromEmail =
    cleanEnv(process.env.SMTP_FROM_EMAIL) ||
    cleanEnv(process.env.SMTP_USER);
  const user = cleanEnv(process.env.SMTP_USER);
  const pass = cleanEnv(process.env.SMTP_PASS);

  if (!host || !fromEmail) return null;

  const portRaw = cleanEnv(process.env.SMTP_PORT) || "587";
  const port = Number(portRaw);
  const secureEnv = cleanEnv(process.env.SMTP_SECURE).toLowerCase();
  const secure =
    secureEnv === "1" ||
    secureEnv === "true" ||
    secureEnv === "yes" ||
    port === 465;

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure,
    user,
    pass,
    fromEmail,
    fromName: cleanEnv(process.env.SMTP_FROM_NAME) || "AKAB Portal",
    replyTo: cleanEnv(process.env.SMTP_REPLY_TO) || null,
  };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfigFromEnv() != null;
}

export function getSmtpPublicStatus(): {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  fromEmail: string | null;
  fromName: string | null;
  hasAuth: boolean;
} {
  const cfg = getSmtpConfigFromEnv();
  if (!cfg) {
    return {
      configured: false,
      host: null,
      port: null,
      secure: null,
      fromEmail: null,
      fromName: null,
      hasAuth: false,
    };
  }
  return {
    configured: true,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    hasAuth: Boolean(cfg.user && cfg.pass),
  };
}

function createTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user
      ? {
          user: cfg.user,
          pass: cfg.pass,
        }
      : undefined,
    tls: {
      // Many corporate SMTPs use custom CAs; keep default verification on.
      minVersion: "TLSv1.2",
    },
  });
}

export async function testSmtpConnection(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const cfg = getSmtpConfigFromEnv();
  if (!cfg) {
    return {
      ok: false,
      error:
        "SMTP is not configured. Set SMTP_HOST and SMTP_FROM_EMAIL (plus SMTP_USER / SMTP_PASS if required).",
    };
  }
  try {
    const transport = createTransport(cfg);
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "SMTP verification failed",
    };
  }
}

export type BoardEmailRecipient = {
  email: string;
  name: string;
  companyName?: string;
};

export type BoardEmailPayload = {
  title: string;
  body: string;
  authorName: string;
  companyName?: string;
  portalUrl?: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildBodies(payload: BoardEmailPayload, recipientName: string) {
  const companyLine = payload.companyName
    ? `Client zone: ${payload.companyName}`
    : "";
  const portalLine = payload.portalUrl
    ? `\nOpen the portal: ${payload.portalUrl}`
    : "";

  const text = [
    `Hello ${recipientName},`,
    "",
    `A new message was posted on your AKAB message board.`,
    companyLine,
    "",
    payload.title,
    "",
    payload.body,
    "",
    `— ${payload.authorName}`,
    portalLine,
    "",
    "You received this because you opted in to board message emails.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const htmlBody = escapeHtml(payload.body).replace(/\n/g, "<br/>");
  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Inter,Segoe UI,sans-serif;line-height:1.5;color:#0f172a;background:#f8fafc;padding:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="background:#0b1f33;color:#fff;padding:16px 20px;font-weight:700;font-size:16px;">
        AKAB · Message board
      </td>
    </tr>
    <tr>
      <td style="padding:20px;">
        <p style="margin:0 0 12px;color:#475569;font-size:14px;">Hello ${escapeHtml(recipientName)},</p>
        <p style="margin:0 0 16px;color:#475569;font-size:14px;">
          A new message was posted on your company board${
            payload.companyName
              ? ` (<strong>${escapeHtml(payload.companyName)}</strong>)`
              : ""
          }.
        </p>
        <h1 style="margin:0 0 12px;font-size:18px;color:#0b1f33;">${escapeHtml(payload.title)}</h1>
        <div style="margin:0 0 20px;padding:14px 16px;background:#f1f5f9;border-radius:8px;font-size:14px;color:#0f172a;">
          ${htmlBody}
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">— ${escapeHtml(payload.authorName)}</p>
        ${
          payload.portalUrl
            ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(payload.portalUrl)}" style="display:inline-block;background:#0b1f33;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;">Open portal</a></p>`
            : ""
        }
        <p style="margin:20px 0 0;font-size:11px;color:#94a3b8;">
          You received this because board email notifications are enabled on your profile.
          This message was sent only to you.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { text, html };
}

/**
 * Send one email per recipient (private — no shared To/Cc list).
 * Optionally uses BCC of a single address if you ever need a silent archive;
 * default is individual To only.
 */
export async function sendBoardEmailsIndividually(opts: {
  recipients: BoardEmailRecipient[];
  payload: BoardEmailPayload;
  /** If true, also BCC each mail to SMTP_ARCHIVE_BCC (ops archive only) */
  archiveBcc?: boolean;
}): Promise<{
  sent: number;
  failed: number;
  errors: string[];
  results: Array<{ email: string; ok: boolean; error?: string }>;
}> {
  const cfg = getSmtpConfigFromEnv();
  if (!cfg) {
    throw new Error("SMTP is not configured");
  }

  const transport = createTransport(cfg);
  const archiveBcc = opts.archiveBcc
    ? cleanEnv(process.env.SMTP_ARCHIVE_BCC) || null
    : null;

  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  const from =
    cfg.fromName && cfg.fromEmail
      ? `"${cfg.fromName.replace(/"/g, "")}" <${cfg.fromEmail}>`
      : cfg.fromEmail;

  for (const r of opts.recipients) {
    const email = (r.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      failed += 1;
      const msg = `Invalid email for ${r.name || "user"}`;
      errors.push(msg);
      results.push({ email: r.email || "", ok: false, error: msg });
      continue;
    }

    const { text, html } = buildBodies(
      {
        ...opts.payload,
        companyName: r.companyName || opts.payload.companyName,
      },
      r.name || email,
    );

    try {
      await transport.sendMail({
        from,
        to: email, // single recipient only — never a group list
        ...(archiveBcc ? { bcc: archiveBcc } : {}),
        ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
        subject: `[AKAB] ${opts.payload.title}`,
        text,
        html,
        headers: {
          "X-AKAB-Notification": "board-message",
          "X-Auto-Response-Suppress": "OOF, AutoReply",
        },
      });
      sent += 1;
      results.push({ email, ok: true });
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : "Send failed";
      errors.push(`${email}: ${msg}`);
      results.push({ email, ok: false, error: msg });
    }
  }

  return { sent, failed, errors, results };
}

/** Single transactional email (MFA codes, etc.). One recipient only. */
export async function sendPlainEmail(opts: {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html?: string;
  headerTag?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = getSmtpConfigFromEnv();
  if (!cfg) {
    return { ok: false, error: "SMTP is not configured" };
  }
  const email = (opts.to || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Invalid recipient email" };
  }
  try {
    const transport = createTransport(cfg);
    const from =
      cfg.fromName && cfg.fromEmail
        ? `"${cfg.fromName.replace(/"/g, "")}" <${cfg.fromEmail}>`
        : cfg.fromEmail;
    const html =
      opts.html ||
      `<!DOCTYPE html><html><body style="font-family:Inter,Segoe UI,sans-serif;line-height:1.5;color:#0f172a;padding:24px;">
  <div style="max-width:480px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    <p style="margin:0 0 12px;font-weight:700;">AKAB Portal</p>
    <pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escapeHtml(opts.text)}</pre>
  </div>
</body></html>`;
    await transport.sendMail({
      from,
      to: email,
      ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
      subject: opts.subject,
      text: opts.text,
      html,
      headers: {
        "X-AKAB-Notification": opts.headerTag || "transactional",
        "X-Auto-Response-Suppress": "OOF, AutoReply",
      },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Send failed",
    };
  }
}
