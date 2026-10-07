import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";

export type Mail = { to: string; subject: string; text: string; html: string };

let transporter: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.from);
}

function transport(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

/**
 * Sends one message per recipient (never a shared To/CC list).
 * Without SMTP settings (development) the message is printed to the console.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!mailConfigured()) {
    console.log(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}\n`);
    return true;
  }
  try {
    await transport().sendMail({
      from: { name: config.smtp.fromName, address: config.smtp.from },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return true;
  } catch (e) {
    console.error(`[mail] send to ${mail.to} failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
