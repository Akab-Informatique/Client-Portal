/** Client helpers for SMTP status + board email send */

export type SmtpStatusResponse = {
  configured: boolean;
  ok: boolean;
  verified?: boolean;
  host?: string | null;
  port?: number | null;
  secure?: boolean | null;
  fromEmail?: string | null;
  fromName?: string | null;
  /** SMTP_USER+SMTP_PASS set (not portal login). */
  smtpUserConfigured?: boolean;
  error?: string | null;
  hint?: string;
};

export type BoardEmailRecipient = {
  email: string;
  name: string;
  companyName?: string;
};

export type SendBoardEmailResponse = {
  ok: boolean;
  sent: number;
  failed: number;
  skipped?: boolean;
  message?: string;
  errors?: string[];
  recipientCount?: number;
  error?: string;
};

function formatErr(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; error?: unknown };
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") return o.message;
  }
  return fallback;
}

export async function fetchSmtpStatus(
  verify = false,
): Promise<SmtpStatusResponse> {
  try {
    const q = verify ? "?verify=1" : "";
    const res = await fetch(`/api/smtp/status${q}`, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json().catch(() => ({}))) as SmtpStatusResponse;
    return {
      configured: Boolean(data.configured),
      ok: Boolean(data.ok),
      verified: data.verified,
      host: data.host ?? null,
      port: data.port ?? null,
      secure: data.secure ?? null,
      fromEmail: data.fromEmail ?? null,
      fromName: data.fromName ?? null,
      smtpUserConfigured: Boolean(
        (data as { smtpUserConfigured?: boolean }).smtpUserConfigured,
      ),
      error: data.error ?? null,
      hint: data.hint,
    };
  } catch (e) {
    return {
      configured: false,
      ok: false,
      error: e instanceof Error ? e.message : "Failed to reach SMTP status",
    };
  }
}

export async function sendBoardEmails(opts: {
  title: string;
  body: string;
  authorName: string;
  portalUrl?: string | null;
  recipients: BoardEmailRecipient[];
}): Promise<SendBoardEmailResponse> {
  try {
    const res = await fetch("/api/smtp/send-board", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        authorName: opts.authorName,
        portalUrl: opts.portalUrl ?? null,
        recipients: opts.recipients,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as SendBoardEmailResponse & {
      error?: unknown;
    };
    if (!res.ok) {
      return {
        ok: false,
        sent: data.sent ?? 0,
        failed: data.failed ?? opts.recipients.length,
        error: formatErr(data.error, `Email send failed (${res.status})`),
        errors: data.errors,
      };
    }
    return {
      ok: Boolean(data.ok),
      sent: Number(data.sent) || 0,
      failed: Number(data.failed) || 0,
      skipped: data.skipped,
      message: data.message,
      errors: data.errors,
      recipientCount: data.recipientCount,
      error:
        data.error != null
          ? formatErr(data.error, "Email send reported an error")
          : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      sent: 0,
      failed: opts.recipients.length,
      error: e instanceof Error ? e.message : "Network error sending emails",
    };
  }
}

/** Treat null/undefined as opted-in (legacy users). */
export function isBoardEmailOptedIn(
  value: boolean | null | undefined,
): boolean {
  return value !== false;
}
