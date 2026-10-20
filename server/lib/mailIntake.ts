import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { graph, o365Ready, O365Error, user } from "./o365.ts";
import { messageText, testMailbox, updateMessage } from "./outlook.ts";
import { ticketSource } from "./ticketSource.ts";

/**
 * Tickets from the support mailbox (Admin › Courriel entrant). The portal reads
 * the mailbox itself (the organisation's Microsoft 365 access) and opens a
 * ticket for each new email: for the sender's contact when it is one, else for
 * the client their domain belongs to; when nobody matches, the email waits in
 * "Courriels à trier" for a technician to choose the client and contact. An
 * email whose subject names an existing ticket (T20261012.0001) is added to
 * that ticket as the client's message instead. Only emails received after it
 * was switched on are read; it starts OFF.
 *
 * Careful: Autotask's own email-to-ticket on the same mailbox would open every
 * ticket twice — one of the two must be off.
 */
const PROVIDER = "mail.intake";

export type IntakeSettings = {
  enabled: boolean;
  mailbox: string;
  enabledAt: string | null;
  /** Mark the email read once it has become a ticket or a reply */
  markRead: boolean;
  /** An email naming an existing ticket is added to it (else it opens a new one) */
  replies: boolean;
  lastRun: { at: string; ok: boolean; tickets: number; replies: number; pending: number; error?: string } | null;
};

const DEFAULTS: IntakeSettings = { enabled: false, mailbox: "", enabledAt: null, markRead: true, replies: true, lastRun: null };

export async function intakeSettings(): Promise<IntakeSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  return { ...DEFAULTS, ...((row?.config ?? {}) as Partial<IntakeSettings>), enabled: row?.enabled ?? false };
}

export async function saveIntakeSettings(actorId: string, p: Partial<Pick<IntakeSettings, "enabled" | "mailbox" | "markRead" | "replies">>) {
  const cur = await intakeSettings();
  const next = { ...cur, ...p };
  // switched on now (or the mailbox changed): only what arrives from here on is read
  const enabledAt = next.enabled && (!cur.enabled || (p.mailbox !== undefined && p.mailbox.toLowerCase() !== cur.mailbox.toLowerCase())) ? new Date().toISOString() : cur.enabledAt;
  await write(actorId, { ...next, enabledAt });
}

async function write(actorId: string | null, s: IntakeSettings) {
  const { enabled, ...config } = s;
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled, config, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled, config, updatedBy: actorId, updatedAt: new Date() } });
}

/** Mailboxes anybody has: a domain says nothing about the client. */
const PUBLIC_DOMAINS = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|videotron|bell|sympatico|cgocable|eastlink|telus|rogers|shaw|cooptel|qc|gmx|mail|zoho)\./i;

/** The one client whose contacts (or own address) use the sender's domain, from the CRM copy; null when none or several. */
export async function clientByDomain(address: string): Promise<{ id: number; name: string } | null> {
  const domain = address.split("@")[1]?.toLowerCase().trim();
  if (!domain || PUBLIC_DOMAINS.test(domain)) return null;
  const d = db();
  const rows = await d
    .select({ id: schema.clients.autotaskId, name: schema.clients.name })
    .from(schema.clientContacts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
    .where(and(eq(schema.clients.active, true), sql`lower(${schema.clientContacts.email}) like ${"%@" + domain}`));
  const own = await d
    .select({ id: schema.clients.autotaskId, name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.active, true), sql`lower(${schema.clients.email}) like ${"%@" + domain}`));
  const found = new Map<number, string>();
  for (const r of [...rows, ...own]) if (r.id != null) found.set(r.id, r.name);
  return found.size === 1 ? { id: [...found.keys()][0]!, name: [...found.values()][0]! } : null;
}

/** Who sent it: their contact (and client), else the client their domain belongs to, else nobody. */
export async function matchSender(address: string) {
  const src = await ticketSource();
  const contact = await src.contactByEmail(address).catch(() => null);
  const company = contact ? { id: contact.companyId, name: contact.companyName } : await clientByDomain(address);
  return { contact, company };
}

/** Machines and loops: never a ticket. */
const AUTOMATIC_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)[+@.-]|^(no-?reply|noreply|donotreply|mailer-daemon|postmaster)@/i;
const AUTOMATIC_SUBJECT = /^(automatic reply|auto-?reply|r[ée]ponse automatique|undeliverable|non remis|delivery status|out of office|absence du bureau|accus[ée] de r[ée]ception)/i;
export const TICKET_NUMBER = /\bT\d{8}\.\d{4}\b/i;

export type Incoming = {
  id: string;
  mailbox: string;
  subject: string;
  from: { name: string | null; address: string } | null;
  receivedAt: string | null;
  text: string;
};
export type Outcome = "ticket" | "reply" | "pending" | "skipped" | "duplicate" | "error";

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const cleanSubject = (s: string) => s.replace(/^\s*((re|tr|fw|fwd|rv)\s*:\s*)+/i, "").trim();

/** One email: claimed first (never twice), then a reply, a ticket, or left for a technician. */
export async function processIncoming(m: Incoming): Promise<{ outcome: Outcome; ticket?: { id: number; number: string } }> {
  const d = db();
  const [claim] = await d
    .insert(schema.mailIntake)
    .values({
      messageId: m.id,
      mailbox: m.mailbox,
      fromAddress: m.from?.address ?? null,
      fromName: m.from?.name ?? null,
      subject: m.subject.slice(0, 500),
      body: m.text.slice(0, 8000),
      receivedAt: m.receivedAt ? new Date(m.receivedAt) : null,
    })
    .onConflictDoNothing()
    .returning();
  if (!claim) return { outcome: "duplicate" };
  const done = async (status: string, extra: Partial<typeof schema.mailIntake.$inferInsert> = {}) => {
    await d.update(schema.mailIntake).set({ status, ...extra, updatedAt: new Date() }).where(eq(schema.mailIntake.id, claim.id));
  };
  try {
    const from = m.from?.address?.toLowerCase() ?? "";
    if (!from || from === m.mailbox.toLowerCase() || AUTOMATIC_SENDER.test(from) || AUTOMATIC_SUBJECT.test(m.subject.trim())) {
      await done("skipped", { note: "automatic" });
      return { outcome: "skipped" };
    }
    const src = await ticketSource();
    const s = await intakeSettings();

    // naming a ticket: the client's message on it
    const named = TICKET_NUMBER.exec(m.subject)?.[0]?.toUpperCase();
    if (named && s.replies) {
      const t = (await src.list()).find((x) => x.number.toUpperCase() === named);
      if (t) {
        await src.addMailReply(t.id, m.from!, m.text.slice(0, 7500));
        await src.markNeedsAttention(t.id).catch(() => false);
        await done("reply", { ticketId: t.id, ticketNumber: t.number, companyId: t.company.id });
        return { outcome: "reply", ticket: { id: t.id, number: t.number } };
      }
    }

    const { contact, company } = await matchSender(from);
    if (!company) {
      // nobody to match: a technician picks the client and contact
      await done("pending");
      return { outcome: "pending" };
    }
    const o = await src.options();
    const priority = (o.priorities.find((p) => p.kind === "medium") ?? o.priorities[0])?.value ?? "";
    const made = await src.createSystem({
      title: (cleanSubject(m.subject) || "(sans objet)").slice(0, 250),
      description: m.text.slice(0, 8000),
      companyId: company.id,
      contactId: contact?.contactId ?? null,
      priority,
      queue: "",
      assigneeId: null,
      dueDate: tomorrow(),
      source: "email",
    });
    await done("ticket", { ticketId: made.id, ticketNumber: made.number, companyId: company.id, contactId: contact?.contactId ?? null });
    await audit(null, "mail_intake.ticket", String(made.id), { from, subject: m.subject.slice(0, 120) });
    return { outcome: "ticket", ticket: made };
  } catch (e) {
    await done("error", { note: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    return { outcome: "error" };
  }
}

type GMessage = { id: string; subject?: string | null; from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime?: string };

let running: Promise<IntakeSettings["lastRun"]> | null = null;

/** One pass over the mailbox: every email received since it was switched on that is not known yet. */
export function runIntake(force = false): Promise<IntakeSettings["lastRun"]> {
  running ??= pass(force).finally(() => {
    running = null;
  });
  return running;
}

async function pass(force: boolean): Promise<IntakeSettings["lastRun"]> {
  const s = await intakeSettings();
  if ((!s.enabled && !force) || !s.mailbox || !s.enabledAt) return null;
  if (!(await o365Ready())) return null;
  const run = { at: new Date().toISOString(), ok: true, tickets: 0, replies: 0, pending: 0 } as NonNullable<IntakeSettings["lastRun"]>;
  try {
    const q = new URLSearchParams({
      $filter: `receivedDateTime ge ${s.enabledAt}`,
      $orderby: "receivedDateTime asc",
      $top: "50",
      $select: "id,subject,from,receivedDateTime,isRead",
    });
    const r = await graph<{ value: GMessage[] }>("GET", `${user(s.mailbox)}/mailFolders/inbox/messages?${q}`);
    const known = new Set((await db().select({ id: schema.mailIntake.messageId }).from(schema.mailIntake)).map((x) => x.id));
    for (const g of r.value ?? []) {
      if (known.has(g.id)) continue;
      const full = await messageText(s.mailbox, g.id);
      const out = await processIncoming({ id: g.id, mailbox: s.mailbox, subject: g.subject ?? "", from: full.from, receivedAt: g.receivedDateTime ?? null, text: full.text });
      if (out.outcome === "ticket") run.tickets++;
      else if (out.outcome === "reply") run.replies++;
      else if (out.outcome === "pending") run.pending++;
      if (s.markRead && (out.outcome === "ticket" || out.outcome === "reply")) await updateMessage(s.mailbox, g.id, { isRead: true }).catch(() => undefined);
    }
  } catch (e) {
    run.ok = false;
    run.error = e instanceof O365Error ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : e instanceof Error ? e.message : String(e);
  }
  await write(null, { ...s, lastRun: run });
  return run;
}

/** The mailbox can be read (organisation access, Mail permission granted). */
export async function checkMailbox(mailbox: string) {
  return testMailbox(mailbox);
}

/** A technician has settled a waiting email (a ticket was made from it, or it is left alone). */
export async function settlePending(id: string, p: { ticketId: number; ticketNumber: string | null } | "ignored", userId: string) {
  const [row] = await db().select().from(schema.mailIntake).where(and(eq(schema.mailIntake.id, id), eq(schema.mailIntake.status, "pending")));
  if (!row) return null;
  const set = p === "ignored" ? { status: "ignored" } : { status: "ticket", ticketId: p.ticketId, ticketNumber: p.ticketNumber };
  const [r] = await db()
    .update(schema.mailIntake)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(schema.mailIntake.id, id))
    .returning();
  await audit(userId, p === "ignored" ? "mail_intake.ignored" : "mail_intake.to_ticket", id, p === "ignored" ? {} : { ticketId: p.ticketId });
  return r;
}

export async function recentIntake(limit = 20) {
  return db().select().from(schema.mailIntake).orderBy(desc(schema.mailIntake.createdAt)).limit(limit);
}
