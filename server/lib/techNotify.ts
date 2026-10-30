import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { sendMail } from "./mail.ts";
import { smsReady, sendSms, normalizePhone } from "./voipms.ts";
import { sendTeams, teamsReady } from "./teams.ts";
import { notify } from "./notify.ts";
import { sendChatNotice } from "./teamsChat.ts";

/**
 * "Notify a technician" from a ticket: always the bell in the portal, and — as ticked — an email, a text and a
 * Teams message. The channels a person ticks by default are in their profile (`user_preferences.notify_defaults`).
 */
/** `bell` is on unless said otherwise; `chat` = a message in the person's Teams chat, written with the sender's own Microsoft sign-in */
export type Channels = { email: boolean; sms: boolean; teams: boolean; bell?: boolean; chat?: boolean };
export const DEFAULT_CHANNELS: Channels = { email: true, sms: false, teams: false };
/** What happened to one channel for one person */
export type Outcome = "sent" | "failed" | "no_address" | "not_ready";
export type PersonResult = { id: string; name: string; bell: true; email?: Outcome; sms?: Outcome; teams?: Outcome; chat?: Outcome };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function notifyTechs(
  tk: { id: number; number: string; title: string; company: { name: string } },
  from: { id: string; name: string },
  userIds: string[],
  message: string,
  ch: Channels,
): Promise<PersonResult[]> {
  const ids = [...new Set(userIds)].filter((id) => id !== from.id);
  if (!ids.length) return [];
  const people = await db()
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, mobile: schema.users.mobile, phone: schema.users.phone })
    .from(schema.users)
    .where(and(inArray(schema.users.id, ids), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!people.length) return [];
  const path = `/tickets?t=${tk.id}`;
  const url = config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}${path}` : null;
  // the bell (unless the sender unticked it)
  if (ch.bell !== false)
    await notify(
      people.map((p) => p.id),
      { type: "ticket.notify", data: { number: tk.number, title: tk.title, from: from.name, company: tk.company.name, message: message.slice(0, 300) }, link: path },
    );
  const smsOn = ch.sms ? await smsReady().catch(() => false) : false;
  const teamsOn = ch.teams ? await teamsReady().catch(() => false) : false;
  const subject = `[${tk.number}] ${tk.title}`.slice(0, 250);
  const out: PersonResult[] = [];
  for (const p of people) {
    const r: PersonResult = { id: p.id, name: p.name, bell: true };
    const head = `${from.name} vous signale le billet ${tk.number} (${tk.title}, ${tk.company.name})`;
    if (ch.email) {
      const text = [`Bonjour ${p.name},`, "", `${head}.`, ...(message ? ["", message] : []), ...(url ? ["", url] : []), "", "—", "AKAB Informatique"].join("\n");
      const html = `<p>Bonjour ${esc(p.name)},</p><p>${esc(head)}.</p>${message ? `<p style="white-space:pre-wrap;border-left:3px solid #ffce1a;padding-left:10px">${esc(message)}</p>` : ""}${url ? `<p><a href="${esc(url)}">Ouvrir le billet</a></p>` : ""}<p>—<br>AKAB Informatique</p>`;
      r.email = p.email ? ((await sendMail({ to: p.email, subject, text, html }).catch(() => false)) ? "sent" : "failed") : "no_address";
    }
    if (ch.sms) {
      const to = normalizePhone(p.mobile) ?? normalizePhone(p.phone);
      if (!smsOn) r.sms = "not_ready";
      else if (!to) r.sms = "no_address";
      else {
        const text = `${from.name}: ${tk.number} ${tk.title.slice(0, 60)} (${tk.company.name.slice(0, 40)})${message ? ` — ${message.slice(0, 120)}` : ""}${url ? ` ${url}` : ""}`;
        r.sms = (await sendSms(to, text).then(() => true).catch(() => false)) ? "sent" : "failed";
      }
    }
    if (ch.teams) {
      if (!teamsOn) r.teams = "not_ready";
      else
        r.teams = (await sendTeams({ title: subject, text: `${head}.${message ? `\n\n${message}` : ""}`, link: url ?? undefined, mention: { name: p.name, email: p.email } }).then(() => true).catch(() => false)) ? "sent" : "failed";
    }
    if (ch.chat) r.chat = await sendChatNotice(from.id, p.email, [`${head}.`, ...(message ? [message] : [])], url ?? undefined);
    out.push(r);
  }
  return out;
}
