import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { rateLimit } from "./http.ts";
import { pushTo } from "./pushAuth.ts";
import type { NotificationType } from "./notify.ts";

/**
 * The portal's notifications (the bell) also reach the phones that were enrolled in the profile, as web push: encrypted
 * end to end between the portal and the phone (RFC 8291; the push service only carries it). By default the lock
 * screen shows only what kind of notification it is; "Afficher le détail" in the profile adds the ticket number, the
 * title or the text. A tap opens the page it is about (a path of the portal, never another site).
 */
type Text = { title: string; body: string };

const TITLES: Record<NotificationType, { fr: string; en: string }> = {
  "message.new": { fr: "Nouveau message", en: "New message" },
  "user.locked": { fr: "Compte verrouillé", en: "Account locked" },
  "timer.pending": { fr: "Minuterie en attente", en: "Timer waiting" },
  "ticket.pinned": { fr: "Priorité pour vous", en: "Priority for you" },
  "calendar.reminder": { fr: "Rappel", en: "Reminder" },
  "sms.received": { fr: "Nouveau texto", en: "New text" },
  "ticket.client": { fr: "Message d'un client", en: "Client message" },
  "ticket.work": { fr: "Travail sur votre billet", en: "Work on your ticket" },
  "ticket.notify": { fr: "On vous signale un billet", en: "A ticket for you" },
  "pipeline.assigned": { fr: "Tâche pour vous", en: "Task for you" },
  "security.alert": { fr: "Alerte de sécurité", en: "Security alert" },
  "breakroom.invite": { fr: "Invitation à jouer", en: "Game invitation" },
  "breakroom.complots": { fr: "Invitation à jouer", en: "Game invitation" },
  "hr.negative": { fr: "Solde RH négatif", en: "Negative HR balance" },
};
const GENERIC = { fr: "Touchez pour ouvrir le portail.", en: "Tap to open the portal." };

const s = (v: unknown, max = 110) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const join = (...parts: unknown[]) => parts.map((p) => s(p)).filter(Boolean).join(" · ").slice(0, 160);

/** What the notification says: the kind only, or with the detail when the person asked for it */
export function pushText(type: NotificationType, data: Record<string, unknown>, locale: "fr" | "en", details: boolean): Text {
  const title = (TITLES[type] ?? { fr: "Notification", en: "Notification" })[locale];
  if (!details) return { title, body: GENERIC[locale] };
  let body = "";
  switch (type) {
    case "sms.received":
      body = join(data.company || data.from, data.preview);
      break;
    case "ticket.pinned":
    case "ticket.work":
    case "ticket.notify":
    case "ticket.client":
      body = join(data.number, data.title, data.preview ?? data.note ?? data.message);
      break;
    case "calendar.reminder":
      body = join(data.number, data.title, data.company);
      break;
    case "pipeline.assigned":
      body = join(data.by, data.title);
      break;
    case "message.new":
      body = join(data.author, data.title);
      break;
    case "timer.pending":
      body = join(data.number, data.title);
      break;
    case "security.alert":
      body = join(data.label, data.agent, data.ip);
      break;
    case "user.locked":
      body = join(data.name);
      break;
    default:
      body = join(data.from);
  }
  return { title, body: body || GENERIC[locale] };
}

/** Only a path of this portal: nothing that could send the phone to another site */
export const safePath = (link: string) => (link.startsWith("/") && !link.startsWith("//") && !link.startsWith("/\\") && link.length < 300 ? link : "/");

/** One push per phone that takes the portal's notifications, for each of these people (never throws) */
export async function pushOut(userIds: string[], n: { type: NotificationType; data: Record<string, unknown>; link: string }): Promise<void> {
  try {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const devices = await db()
      .select()
      .from(schema.pushDevices)
      .where(and(inArray(schema.pushDevices.userId, ids), eq(schema.pushDevices.notify, true), isNull(schema.pushDevices.revokedAt)));
    if (!devices.length) return;
    const who = [...new Set(devices.map((d) => d.userId))];
    const [users, prefs] = await Promise.all([
      db().select({ id: schema.users.id, locale: schema.users.locale }).from(schema.users).where(inArray(schema.users.id, who)),
      db().select({ id: schema.userPreferences.userId, details: schema.userPreferences.pushDetails }).from(schema.userPreferences).where(inArray(schema.userPreferences.userId, who)),
    ]);
    const locale = new Map(users.map((u) => [u.id, u.locale]));
    const details = new Map(prefs.map((p) => [p.id, p.details]));
    for (const userId of who) {
      // a flood (a loop, a noisy night) is not sent to the phone
      if (!rateLimit(`push:notify:${userId}`, 30, 10 * 60_000).ok) continue;
      const text = pushText(n.type, n.data, locale.get(userId) ?? "fr", details.get(userId) ?? false);
      const payload = { type: "notify", notifType: n.type, title: text.title, body: text.body, url: safePath(n.link) };
      for (const d of devices.filter((x) => x.userId === userId)) void pushTo(d, payload);
    }
  } catch (e) {
    console.warn("[push] notification failed:", e instanceof Error ? e.message : e);
  }
}
