import nodemailer, { type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";
import { renderTemplate, type Locale, type TemplateKey } from "./emailTemplates.ts";

export { escapeHtml } from "./emailTemplates.ts";
export type Mail = { to: string; subject: string; text: string; html: string };

/**
 * Outgoing mail server. Settings saved in Admin settings › Email (password
 * sealed with APP_SECRET) take precedence over the SMTP_* variables of .env.
 */
export type Security = "starttls" | "tls" | "none";
export type SmtpSettings = {
  source: "database" | "env" | "none";
  host: string;
  port: number;
  security: Security;
  user: string;
  pass: string;
  from: string;
  fromName: string;
};
export const SMTP_PROVIDER = "smtp";

function fromEnv(): SmtpSettings {
  const s = config.smtp;
  return {
    source: s.host && s.from ? "env" : "none",
    host: s.host,
    port: s.port,
    security: s.secure ? "tls" : "starttls",
    user: s.user,
    pass: s.pass,
    from: s.from,
    fromName: s.fromName,
  };
}

let cached: SmtpSettings | null = null;

export async function smtpSettings(): Promise<SmtpSettings> {
  if (cached) return cached;
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, SMTP_PROVIDER));
  const c = (row?.config ?? {}) as Partial<SmtpSettings>;
  if (row && c.host && c.from) {
    let pass = "";
    try {
      pass = (JSON.parse(unseal(row.secret) ?? "{}") as { pass?: string }).pass ?? "";
    } catch {
      pass = "";
    }
    cached = {
      source: "database",
      host: c.host,
      port: c.port ?? 587,
      security: c.security ?? "starttls",
      user: c.user ?? "",
      pass,
      from: c.from,
      fromName: c.fromName || "AKAB Informatique",
    };
  } else {
    cached = fromEnv();
  }
  return cached;
}

export async function saveSmtpSettings(
  actorId: string,
  p: Omit<SmtpSettings, "source" | "pass"> & { pass?: string },
): Promise<void> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, SMTP_PROVIDER));
  let pass = "";
  try {
    pass = (JSON.parse(unseal(row?.secret) ?? "{}") as { pass?: string }).pass ?? "";
  } catch {
    pass = "";
  }
  if (p.pass !== undefined) pass = p.pass;
  const values = {
    enabled: true,
    config: { host: p.host, port: p.port, security: p.security, user: p.user, from: p.from, fromName: p.fromName },
    secret: seal(JSON.stringify({ pass })),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: SMTP_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
  resetMailCache();
}

/** Forget the saved settings: .env is used again. */
export async function clearSmtpSettings(): Promise<void> {
  await db().delete(schema.integrations).where(eq(schema.integrations.provider, SMTP_PROVIDER));
  resetMailCache();
}

let transporter: { key: string; t: Transporter } | null = null;

export function resetMailCache() {
  cached = null;
  transporter?.t.close();
  transporter = null;
}

export function createTransport(s: SmtpSettings): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export async function mailConfigured(): Promise<boolean> {
  return (await smtpSettings()).source !== "none";
}

/** Messages kept in memory when no mail server is set (development and tests only). */
export const devOutbox: Mail[] = [];

/**
 * Sends one message per recipient (never a shared To/CC list).
 * Without a mail server: development prints it, production drops it with a
 * warning (never logs the content: it may hold a password link).
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const s = await smtpSettings();
  if (s.source === "none") {
    if (config.production) {
      console.warn(`[mail] no mail server configured — email "${mail.subject}" not sent`);
      return false;
    }
    devOutbox.push(mail);
    if (devOutbox.length > 50) devOutbox.shift();
    if (process.env.NODE_ENV !== "test") console.log(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}\n`);
    return true;
  }
  const key = JSON.stringify([s.host, s.port, s.security, s.user, s.pass]);
  if (transporter?.key !== key) {
    transporter?.t.close();
    transporter = { key, t: createTransport(s) };
  }
  try {
    await transporter.t.sendMail({ from: { name: s.fromName, address: s.from }, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    return true;
  } catch (e) {
    console.error(`[mail] send failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Render a template in the recipient's language and send it. */
export async function sendTemplate(key: TemplateKey, to: { email: string; locale: string }, vars: Record<string, string>): Promise<boolean> {
  const locale: Locale = to.locale === "en" ? "en" : "fr";
  const r = await renderTemplate(key, locale, vars);
  return sendMail({ to: to.email, ...r });
}
