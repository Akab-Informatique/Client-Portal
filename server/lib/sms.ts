import { and, desc, eq, lte, ne, sql, gte, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify, usersWith } from "./notify.ts";
import { ticketSource } from "./ticketSource.ts";
import { formatDelay, formatPhone, normalizePhone, sendSms, SmsError, smsSettings } from "./voipms.ts";

/**
 * Text conversations with clients (one VoIP.ms number), seen by every
 * technician with sms.view.
 *
 * A new conversation gets an automatic reply: answer 1 to open a ticket now,
 * or wait for a technician. With no technician reply before the deadline,
 * the conversation becomes a ticket by itself and the client is told its
 * number. Once linked to a ticket, the client's texts are added to it.
 */
export type Conversation = typeof schema.smsConversations.$inferSelect;
const WANTS_TICKET = /^\s*(1|billet|ticket)\s*[.!]?\s*$/i;

async function addMessage(conv: Conversation, m: { direction: "in" | "out"; body: string; providerId?: string | null; userId?: string | null; auto?: boolean; groupKey?: string | null; status: "received" | "sent" | "failed"; error?: string | null }) {
  await db()
    .insert(schema.smsMessages)
    .values({ conversationId: conv.id, direction: m.direction, body: m.body, providerId: m.providerId ?? null, userId: m.userId ?? null, auto: m.auto ?? false, groupKey: m.groupKey ?? null, status: m.status, error: m.error ?? null });
  // automatic messages do not change the list (preview, order)
  if (m.auto) return;
  await db()
    .update(schema.smsConversations)
    .set({
      lastMessageAt: new Date(),
      lastPreview: m.body.slice(0, 140),
      ...(m.direction === "in" ? { unread: sql`${schema.smsConversations.unread} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.smsConversations.id, conv.id));
}

/** A text of a conversation linked to a ticket, copied as an internal note. */
async function noteInTicket(conv: Conversation, title: string, body: string) {
  if (!conv.ticketId) return;
  const src = await ticketSource();
  await src.addSmsNote(conv.ticketId, title, body).catch((e) => console.warn("[sms] note:", e instanceof Error ? e.message : e));
}

/** A text from the portal to the client, kept in the conversation (failed ones too). */
async function sendTo(conv: Conversation, body: string, by: { userId?: string | null; auto?: boolean; author?: string; groupKey?: string | null }) {
  try {
    await sendSms(conv.phone, body);
    await addMessage(conv, { direction: "out", body, userId: by.userId, auto: by.auto, groupKey: by.groupKey, status: "sent" });
    await noteInTicket(conv, by.auto ? `Texto automatique envoyé à ${formatPhone(conv.phone)}` : `Texto envoyé par ${by.author ?? "AKAB"} à ${formatPhone(conv.phone)}`, body);
  } catch (e) {
    const error = e instanceof SmsError ? e.code + (e.detail ? `: ${e.detail}` : "") : String(e);
    await addMessage(conv, { direction: "out", body, userId: by.userId, auto: by.auto, groupKey: by.groupKey, status: "failed", error });
    throw e;
  }
}

const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
const who = (c: Conversation) => c.contactName || formatPhone(c.phone);

async function tellTechnicians(conv: Conversation, body: string) {
  const techs = await usersWith("staff", "sms.view");
  await notify(techs, {
    type: "sms.received",
    data: { from: who(conv), company: conv.companyName ?? "", preview: body.slice(0, 140), ticket: conv.ticketNumber ?? "" },
    link: `/tickets?sms=${conv.id}`,
  });
}

/** Texts received are handled one at a time, in the order they came (two at once never open two conversations). */
let received: Promise<void> = Promise.resolve();
export function queueReceived(p: { from: string; message: string; id?: string | null }): Promise<void> {
  received = received.then(() => receiveSms(p)).catch((e) => console.error("[sms] callback:", e));
  return received;
}
/** For tests: once every text received so far is handled */
export const receivedSettled = () => received;

/** A text received (VoIP.ms callback). */
export async function receiveSms(p: { from: string; message: string; id?: string | null }): Promise<void> {
  const phone = normalizePhone(p.from);
  const body = p.message.trim().slice(0, 2000);
  if (!phone || !body) return;
  // the same callback twice: kept once
  if (p.id) {
    const [dup] = await db().select({ id: schema.smsMessages.id }).from(schema.smsMessages).where(eq(schema.smsMessages.providerId, p.id));
    if (dup) return;
  }
  const s = await smsSettings();
  let [conv] = await db()
    .select()
    .from(schema.smsConversations)
    .where(and(eq(schema.smsConversations.phone, phone), ne(schema.smsConversations.status, "closed")))
    .orderBy(desc(schema.smsConversations.lastMessageAt))
    .limit(1);
  const isNew = !conv;
  if (!conv) {
    const src = await ticketSource();
    const contact = await src.contactByPhone(phone).catch(() => null);
    [conv] = await db()
      .insert(schema.smsConversations)
      .values({
        phone,
        contactName: contact?.contactName ?? null,
        contactId: contact?.contactId ?? null,
        companyId: contact?.companyId ?? null,
        companyName: contact?.companyName ?? null,
        status: "waiting",
        autoTicketAt: new Date(Date.now() + s.autoTicketMinutes * 60_000),
      })
      .returning();
  }
  await addMessage(conv, { direction: "in", body, providerId: p.id ?? null, status: "received" });
  await tellTechnicians(conv, body);

  if (isNew) {
    // what happens next, for the client — once per number in the cool-down (24 h by default)
    const since = new Date(Date.now() - s.autoReplyCooldownHours * 3_600_000);
    const [recent] = s.autoReplyCooldownHours
      ? await db()
          .select({ id: schema.smsConversations.id })
          .from(schema.smsConversations)
          .where(and(eq(schema.smsConversations.phone, phone), gte(schema.smsConversations.autoRepliedAt, since)))
          .limit(1)
      : [];
    if (!recent) {
      await db().update(schema.smsConversations).set({ autoRepliedAt: new Date() }).where(eq(schema.smsConversations.id, conv.id));
      await sendTo(conv, fill(s.autoReply, { minutes: String(s.autoTicketMinutes), delay: formatDelay(s.autoTicketMinutes) }), { auto: true }).catch((e) =>
        console.warn("[sms] auto reply:", e instanceof Error ? e.message : e),
      );
    }
    return;
  }
  if (conv.status === "waiting" && WANTS_TICKET.test(body)) {
    // a ticket asked for: first, what it is about (the ticket opens with the answer, or after the delay)
    const [next] = await db()
      .update(schema.smsConversations)
      .set({ status: "details", autoTicketAt: new Date(Date.now() + s.detailsMinutes * 60_000), updatedAt: new Date() })
      .where(eq(schema.smsConversations.id, conv.id))
      .returning();
    await sendTo(next, s.askDetails, { auto: true }).catch((e) => console.warn("[sms] details question:", e instanceof Error ? e.message : e));
    return;
  }
  if (conv.status === "details") {
    // the answer: the ticket, with every text so far
    await openTicket(conv, null, "client").catch((e) => console.warn("[sms] ticket on request:", e instanceof Error ? e.message : e));
    return;
  }
  // linked to a ticket: the client's text goes in it, and the ticket needs attention (like a new client reply)
  if (conv.status === "ticket" && conv.ticketId) {
    await noteInTicket(conv, `Texto reçu de ${who(conv)} (${formatPhone(conv.phone)})`, body);
    await needsAttention(conv.ticketId);
  }
}

/** The ticket goes to "needs attention" because of a text; a failure here never loses the text. */
async function needsAttention(ticketId: number) {
  try {
    await (await ticketSource()).markNeedsAttention(ticketId);
  } catch (e) {
    console.warn("[sms] needs attention:", e instanceof Error ? e.message : e);
  }
}

/** A technician answers: the client no longer waits (no automatic ticket). */
export async function replyAsTechnician(conv: Conversation, body: string, a: AuthContext, groupKey?: string | null): Promise<void> {
  await sendTo(conv, body, { userId: a.realUser.id, author: a.realUser.name, groupKey });
  await db()
    .update(schema.smsConversations)
    .set({ status: conv.status === "waiting" || conv.status === "details" ? "open" : conv.status, autoTicketAt: null, unread: 0, updatedAt: new Date() })
    .where(eq(schema.smsConversations.id, conv.id));
  await audit(a.realUser.id, "sms.sent", conv.id, { phone: conv.phone, ticketId: conv.ticketId });
}

export class SmsTicketError extends Error {
  constructor(public code: "no_company" | "needs_client" | "unknown_client" | "unknown_contact") {
    super(code);
  }
}

/** Our own client (AKAB): the tickets of numbers nobody knows go there when no default client is set */
async function ownCompanyId(): Promise<number | null> {
  const list = await (await ticketSource()).companies().catch(() => []);
  return (list.find((c) => c.id === 0) ?? list.find((c) => /\bakab\b/i.test(c.name)))?.id ?? null;
}

/**
 * A technician opens the ticket of a number nobody knows: they say first which
 * client (and contact) it is; the conversation keeps it.
 */
export async function mapConversation(conv: Conversation, p: { companyId: number; contactId: string | null }): Promise<Conversation> {
  const src = await ticketSource();
  const company = (await src.companies()).find((c) => c.id === p.companyId);
  if (!company) throw new SmsTicketError("unknown_client");
  let contactName: string | null = null;
  if (p.contactId) {
    const contact = (await src.contacts(company.id)).find((c) => c.id === p.contactId);
    if (!contact) throw new SmsTicketError("unknown_contact");
    contactName = contact.name;
  }
  const [next] = await db()
    .update(schema.smsConversations)
    .set({ companyId: company.id, companyName: company.name, contactId: p.contactId, contactName, updatedAt: new Date() })
    .where(eq(schema.smsConversations.id, conv.id))
    .returning();
  return next;
}

/**
 * The conversation becomes a ticket (asked by the client, by a technician, or
 * no reply in time). The client is told its number.
 */
const opening = new Map<string, Promise<{ id: number; number: string }>>();

export function openTicket(conv: Conversation, a: AuthContext | null, reason: "client" | "technician" | "timeout" = a ? "technician" : "client"): Promise<{ id: number; number: string }> {
  // a ticket being opened for this conversation: the same one
  const busy = opening.get(conv.id);
  if (busy) return busy;
  const run = openTicketNow(conv, a, reason).finally(() => opening.delete(conv.id));
  opening.set(conv.id, run);
  return run;
}

async function openTicketNow(conv: Conversation, a: AuthContext | null, reason: "client" | "technician" | "timeout"): Promise<{ id: number; number: string }> {
  // read again: it may have become a ticket since this copy was taken
  const [fresh] = await db().select().from(schema.smsConversations).where(eq(schema.smsConversations.id, conv.id));
  if (fresh?.ticketId && fresh.ticketNumber) return { id: fresh.ticketId, number: fresh.ticketNumber };
  if (conv.ticketId && conv.ticketNumber) return { id: conv.ticketId, number: conv.ticketNumber };
  const s = await smsSettings();
  // a technician says which client first, when the number is nobody's
  if (a && conv.companyId == null) throw new SmsTicketError("needs_client");
  const companyId = conv.companyId ?? s.defaultCompanyId ?? (await ownCompanyId());
  if (companyId == null) throw new SmsTicketError("no_company");
  const src = await ticketSource();
  const o = await src.options();
  const messages = await db().select().from(schema.smsMessages).where(eq(schema.smsMessages.conversationId, conv.id)).orderBy(schema.smsMessages.createdAt);
  const fromClient = messages.filter((m) => m.direction === "in");
  const first = fromClient[0]?.body ?? "";
  // what the client asks: their answer to our question (after "1"), or their first text
  const said = fromClient.map((m) => m.body).filter((b) => !WANTS_TICKET.test(b));
  const request = (conv.status === "details" && said.length > 1 ? said[said.length - 1] : (said[0] ?? first)).replace(/\s+/g, " ").trim();
  const when = (d: Date) => new Intl.DateTimeFormat("fr-CA", { timeZone: "America/Toronto", dateStyle: "short", timeStyle: "short" }).format(d);
  const description = [
    `Demande reçue par texto de ${who(conv)} (${formatPhone(conv.phone)}).`,
    "",
    ...messages.filter((m) => !m.auto).map((m) => `[${when(m.createdAt)}] ${m.direction === "in" ? "Client" : "AKAB"} : ${m.body}`),
  ].join("\n");
  const priority = s.priority && o.priorities.some((p) => p.value === s.priority) ? s.priority : (o.priorities.find((p) => p.kind === "medium") ?? o.priorities[0]).value;
  const queue = s.queue && o.queues.some((q) => q.value === s.queue) ? s.queue : (o.queues[0]?.value ?? "");
  const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const p = {
    title: `Texto de ${who(conv)} : ${request.slice(0, 80)}`.slice(0, 250),
    description: description.slice(0, 8000),
    companyId,
    contactId: conv.companyId != null ? conv.contactId : null,
    priority,
    queue,
    assigneeId: null,
    dueDate: due,
  };
  let ticket: { id: number; number: string };
  if (a) {
    const id = await src.create(p, a);
    ticket = { id, number: (await src.list()).find((t) => t.id === id)?.number ?? String(id) };
  } else {
    ticket = await src.createSystem(p);
  }
  const [next] = await db()
    .update(schema.smsConversations)
    .set({ status: "ticket", ticketId: ticket.id, ticketNumber: ticket.number, autoTicketAt: null, updatedAt: new Date() })
    .where(eq(schema.smsConversations.id, conv.id))
    .returning();
  // no technician in time: the client is told so; otherwise, the ticket number
  const short = request.length > 60 ? `${request.slice(0, 57)}…` : request;
  await sendTo(next, fill(reason === "timeout" ? s.ticketTimeout : s.ticketOpened, { number: ticket.number, request: short }), { auto: true }).catch((e) =>
    console.warn("[sms] ticket message:", e instanceof Error ? e.message : e),
  );
  // made a ticket by itself (nobody answered in time, or the client asked with 1): the conversation ends there
  // (kept with the ticket), so the next text from this number starts a new one
  if (!a) await db().update(schema.smsConversations).set({ status: "closed", updatedAt: new Date() }).where(eq(schema.smsConversations.id, conv.id));
  await audit(a?.realUser.id ?? null, "sms.ticket_opened", conv.id, { ticketId: ticket.id, reason });
  return ticket;
}

/** No technician reply in time: those conversations become tickets (one run at a time). */
let autoRunning = false;
export async function autoTickets(now = new Date()): Promise<number> {
  if (autoRunning) return 0;
  autoRunning = true;
  try {
    return await autoTicketsNow(now);
  } finally {
    autoRunning = false;
  }
}
async function autoTicketsNow(now: Date): Promise<number> {
  const due = await db()
    .select()
    .from(schema.smsConversations)
    .where(and(inArray(schema.smsConversations.status, ["waiting", "details"]), lte(schema.smsConversations.autoTicketAt, now)));
  let n = 0;
  for (const c of due) {
    try {
      // asked for a ticket but said nothing more: it opens anyway, as asked
      await openTicket(c, null, c.status === "details" ? "client" : "timeout");
      n++;
    } catch (e) {
      console.warn("[sms] automatic ticket:", e instanceof Error ? e.message : e);
      // not possible now (no default client…): technicians handle it
      await db().update(schema.smsConversations).set({ status: "open", autoTicketAt: null }).where(eq(schema.smsConversations.id, c.id));
    }
  }
  return n;
}

/** The conversation of a ticket's contact (new if none), for a text from the ticket. */
export async function conversationForTicket(t: { id: number; number: string; phone: string; contactName: string | null; contactId: string | null; companyId: number; companyName: string }): Promise<Conversation> {
  const [open] = await db()
    .select()
    .from(schema.smsConversations)
    .where(and(eq(schema.smsConversations.phone, t.phone), ne(schema.smsConversations.status, "closed")))
    .orderBy(desc(schema.smsConversations.lastMessageAt))
    .limit(1);
  if (open) {
    if (open.ticketId === t.id) return open;
    const [linked] = await db()
      .update(schema.smsConversations)
      .set({ status: "ticket", ticketId: t.id, ticketNumber: t.number, autoTicketAt: null, updatedAt: new Date() })
      .where(eq(schema.smsConversations.id, open.id))
      .returning();
    return linked;
  }
  const [conv] = await db()
    .insert(schema.smsConversations)
    .values({ phone: t.phone, contactName: t.contactName, contactId: t.contactId, companyId: t.companyId, companyName: t.companyName, status: "ticket", ticketId: t.id, ticketNumber: t.number })
    .returning();
  return conv;
}
