import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { billingSettings } from "./billing.ts";
import { reminderKey, renderTemplate, REMINDER_LEVELS, type Locale, type TemplateKey } from "./emailTemplates.ts";
import { mailConfigured, sendMail, smtpSettings, type Mail } from "./mail.ts";
import { invoicePdf } from "./invoicePdf.ts";
import { payOnlineFor, payUrlOf } from "./payLink.ts";
import { config } from "../config.ts";

/**
 * Invoicing emails: the invoice itself, past due notices and reminders (5, 15, 20, 30, 60 and 90 days past due), and the
 * account statement. Texts are the templates of Admin › Facturation › Courriels. Nothing is attached (the invoice is in
 * the email as figures); the client's billing email is used, else its main email.
 */
export class InvoiceMailError extends Error {
  constructor(public code: "not_found" | "no_email" | "nothing_due" | "mail_not_configured" | "mail_failed") {
    super(code);
  }
}

// ── settings ──
const PROVIDER = "invoice.mail";
export type MailSettings = {
  /** Email each invoice to its client as soon as it is made (off: sent by hand) */
  autoSend: boolean;
  /** Send the past due reminders by themselves, every weekday morning */
  remindersAuto: boolean;
  /** The levels (days past due) that are sent */
  levels: number[];
  /** Automatic reminders only for invoices dated on or after this day (YYYY-MM-DD); none: every invoice */
  remindersFrom: string | null;
  /** The address every invoicing email is sent from, and answered to */
  fromEmail: string;
  /** Its name (none: the mail server's sender name) */
  fromName: string | null;
  /** The day of the last automatic pass (YYYY-MM-DD) */
  lastRun: string | null;
};
export const DEFAULT_MAIL_SETTINGS: MailSettings = { autoSend: false, remindersAuto: false, levels: [...REMINDER_LEVELS], remindersFrom: "2026-11-01", fromEmail: "comptabilite@akab.ca", fromName: null, lastRun: null };

export async function mailSettings(): Promise<MailSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  const c = (row?.config ?? {}) as Partial<MailSettings>;
  return { ...DEFAULT_MAIL_SETTINGS, ...c, levels: Array.isArray(c.levels) ? c.levels.filter((n) => (REMINDER_LEVELS as readonly number[]).includes(n)) : DEFAULT_MAIL_SETTINGS.levels };
}
export async function saveMailSettings(p: Partial<MailSettings>): Promise<MailSettings> {
  const next = { ...(await mailSettings()), ...p };
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled: true, config: next })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: next, updatedAt: new Date() } });
  return next;
}

// ── figures ──
const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const money = (cents: number, l: Locale) => new Intl.NumberFormat(l === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
const longDay = (ymd: string, l: Locale) => new Intl.DateTimeFormat(l === "en" ? "en-CA" : "fr-CA", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

type Invoice = typeof schema.clientInvoices.$inferSelect;
type Client = typeof schema.clients.$inferSelect;
export type Owed = { invoice: Invoice; balanceCents: number; daysLate: number };

/** What is left to pay on each of these invoices, and how late (same rule as the invoice lists). */
async function owedOn(rows: Invoice[]): Promise<Owed[]> {
  const ids = rows.map((r) => r.id);
  const pays = ids.length ? await db().select({ id: schema.invoicePayments.invoiceId, a: schema.invoicePayments.amountCents }).from(schema.invoicePayments).where(inArray(schema.invoicePayments.invoiceId, ids)) : [];
  const today = todayQc();
  return rows
    .filter((v) => !v.voided)
    .map((v) => {
      const received = pays.filter((p) => p.id === v.id).reduce((n, p) => n + p.a, 0);
      const paid = v.paidOn && received < v.totalCents ? v.totalCents : received;
      const balanceCents = Math.max(0, v.totalCents - paid);
      return { invoice: v, balanceCents, daysLate: balanceCents > 0 && v.dueOn && v.dueOn < today ? daysBetween(v.dueOn, today) : 0 };
    })
    .filter((o) => o.balanceCents > 0);
}

/** The unpaid invoices of some clients (every client when none is given), oldest due day first. */
export async function unpaidInvoices(clientIds?: string[]): Promise<Owed[]> {
  const v = schema.clientInvoices;
  const rows = await db()
    .select()
    .from(v)
    .where(and(eq(v.voided, false), clientIds ? inArray(v.clientId, clientIds) : undefined))
    .orderBy(asc(v.dueOn), asc(v.number));
  return owedOn(rows);
}

const recipientOf = (c: Client) => (c.invoice?.billingEmail || c.email || "").trim() || null;
const languageOf = async (): Promise<Locale> => ((await billingSettings()).template.language === "en" ? "en" : "fr");

/** Who invoicing emails come from (and are answered by): the accounting address, through the same mail server. */
export async function invoiceSender(): Promise<{ from: { name: string; address: string }; replyTo: string }> {
  const s = await mailSettings();
  const smtp = await smtpSettings();
  return { from: { name: s.fromName || smtp.fromName || "AKAB Informatique", address: s.fromEmail }, replyTo: s.fromEmail };
}

/** The PDF copy of an invoice and, when paying online is on for its client, the link to pay (in the email and in the PDF). */
async function invoiceExtras(inv: Invoice, client: Client, balanceCents: number): Promise<{ payUrl: string; attachments: NonNullable<Mail["attachments"]> }> {
  const payUrl = balanceCents > 0 && (await payOnlineFor(client)) ? payUrlOf(inv.id) : "";
  const pdf = await invoicePdf(inv.id, payUrl || null).catch((e) => {
    console.warn("[invoice mail] PDF not made:", e instanceof Error ? e.message : e);
    return null;
  });
  return { payUrl, attachments: pdf ? [{ filename: pdf.filename, content: pdf.content, contentType: "application/pdf" }] : [] };
}

async function deliver(key: TemplateKey, c: Client, vars: Record<string, string>, locale: Locale, attachments?: Mail["attachments"]) {
  const to = recipientOf(c);
  if (!to) throw new InvoiceMailError("no_email");
  // without a mail server production sends nothing (development keeps the message in memory)
  if (config.production && !(await mailConfigured())) throw new InvoiceMailError("mail_not_configured");
  const r = await renderTemplate(key, locale, vars);
  if (!(await sendMail({ to, ...r, ...(await invoiceSender()), ...(attachments?.length ? { attachments } : {}) }))) throw new InvoiceMailError("mail_failed");
  return to;
}

// ── one invoice ──
/** The template a reminder uses: a plain past due notice under 5 days, else the highest level reached. */
export const templateFor = (daysLate: number): TemplateKey => {
  const level = [...REMINDER_LEVELS].reverse().find((n) => daysLate >= n);
  return level ? reminderKey(level) : "invoicePastDue";
};

async function invoiceMail(invoiceId: string) {
  const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv) throw new InvoiceMailError("not_found");
  const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, inv.clientId));
  if (!client) throw new InvoiceMailError("not_found");
  const owed = (await owedOn([inv]))[0];
  return { inv, client, balanceCents: owed?.balanceCents ?? 0, daysLate: owed?.daysLate ?? 0 };
}

function invoiceVars(inv: Invoice, client: Client, balanceCents: number, daysLate: number, l: Locale, payUrl = ""): Record<string, string> {
  return {
    name: client.name,
    company: client.name,
    number: inv.number,
    issuedOn: longDay(inv.issuedOn, l),
    dueOn: inv.dueOn ? longDay(inv.dueOn, l) : "—",
    total: money(inv.totalCents, l),
    balance: money(balanceCents, l),
    daysLate: String(daysLate),
    poNumber: inv.poNumber ?? "",
    portalUrl: config.publicUrl,
    payUrl,
  };
}

/** Email an invoice: the invoice itself ("sent"), or a reminder (the template follows how late it is). */
export async function sendInvoiceMail(invoiceId: string, kind: "sent" | "reminder", actorId: string | null): Promise<{ to: string; template: TemplateKey }> {
  const { inv, client, balanceCents, daysLate } = await invoiceMail(invoiceId);
  if (inv.voided) throw new InvoiceMailError("nothing_due");
  // a reminder is for an invoice that is past due and not paid
  if (kind === "reminder" && (balanceCents <= 0 || daysLate <= 0)) throw new InvoiceMailError("nothing_due");
  const locale = await languageOf();
  const template: TemplateKey = kind === "sent" ? "invoiceSent" : templateFor(daysLate);
  const extras = await invoiceExtras(inv, client, balanceCents);
  const to = await deliver(template, client, invoiceVars(inv, client, balanceCents, daysLate, locale, extras.payUrl), locale, extras.attachments);
  if (kind === "sent" && !inv.emailedAt) await db().update(schema.clientInvoices).set({ emailedAt: new Date(), updatedAt: new Date() }).where(eq(schema.clientInvoices.id, inv.id));
  await audit(actorId, kind === "sent" ? "billing.invoice_mailed" : "billing.invoice_reminded", inv.id, { number: inv.number, to, template });
  return { to, template };
}

/** After an invoice is made: emailed to the client when "send each invoice by email" is on. Never fails the invoice. */
export async function autoSendInvoice(invoiceId: string, actorId: string | null) {
  if (!(await mailSettings()).autoSend) return null;
  return sendInvoiceMail(invoiceId, "sent", actorId).catch((e) => {
    console.warn("[invoice mail] not sent:", e instanceof Error ? e.message : e);
    return null;
  });
}

// ── account statement ──
export type Statement = {
  client: { id: string; name: string; email: string | null };
  date: string;
  count: number;
  totalDueCents: number;
  overdueCents: number;
  /** Past due, by how late: not yet due, 1–30, 31–60, 61–90, over 90 days */
  buckets: { current: number; d30: number; d60: number; d90: number; over90: number };
  items: { id: string; number: string; issuedOn: string; dueOn: string | null; totalCents: number; balanceCents: number; daysLate: number; poNumber: string | null }[];
};

export async function statementOf(clientId: string): Promise<Statement> {
  const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new InvoiceMailError("not_found");
  const owed = await unpaidInvoices([clientId]);
  const sum = (f: (o: Owed) => boolean) => owed.filter(f).reduce((n, o) => n + o.balanceCents, 0);
  return {
    client: { id: client.id, name: client.name, email: recipientOf(client) },
    date: todayQc(),
    count: owed.length,
    totalDueCents: sum(() => true),
    overdueCents: sum((o) => o.daysLate > 0),
    buckets: { current: sum((o) => o.daysLate === 0), d30: sum((o) => o.daysLate >= 1 && o.daysLate <= 30), d60: sum((o) => o.daysLate >= 31 && o.daysLate <= 60), d90: sum((o) => o.daysLate >= 61 && o.daysLate <= 90), over90: sum((o) => o.daysLate > 90) },
    items: owed.map((o) => ({ id: o.invoice.id, number: o.invoice.number, issuedOn: o.invoice.issuedOn, dueOn: o.invoice.dueOn, totalCents: o.invoice.totalCents, balanceCents: o.balanceCents, daysLate: o.daysLate, poNumber: o.invoice.poNumber })),
  };
}

/** Email a client its statement (its unpaid invoices). */
export async function sendStatement(clientId: string, actorId: string | null): Promise<{ to: string; count: number; totalDueCents: number }> {
  const st = await statementOf(clientId);
  if (!st.count) throw new InvoiceMailError("nothing_due");
  const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, clientId));
  const l = await languageOf();
  const late = (n: number) => (n > 0 ? ` (${l === "en" ? `${n} days past due` : `${n} jours de retard`})` : "");
  const lines = st.items
    .map((i) =>
      l === "en"
        ? `${i.number} · dated ${longDay(i.issuedOn, l)} · due ${i.dueOn ? longDay(i.dueOn, l) : "—"} · balance ${money(i.balanceCents, l)}${late(i.daysLate)}`
        : `${i.number} · du ${longDay(i.issuedOn, l)} · échéance ${i.dueOn ? longDay(i.dueOn, l) : "—"} · solde ${money(i.balanceCents, l)}${late(i.daysLate)}`,
    )
    .join("\n");
  const to = await deliver(
    "accountStatement",
    client!,
    { name: client!.name, company: client!.name, date: longDay(st.date, l), count: String(st.count), totalDue: money(st.totalDueCents, l), overdueDue: money(st.overdueCents, l), statementLines: lines, portalUrl: config.publicUrl },
    l,
  );
  await audit(actorId, "billing.statement_sent", clientId, { to, count: st.count, totalDueCents: st.totalDueCents });
  return { to, count: st.count, totalDueCents: st.totalDueCents };
}

/** The clients that owe something, with where a statement would go (for choosing who gets one). */
export async function statementTargets() {
  const owed = await unpaidInvoices();
  const byClient = new Map<string, { count: number; totalDueCents: number; overdueCents: number; maxDaysLate: number }>();
  for (const o of owed) {
    const g = byClient.get(o.invoice.clientId) ?? { count: 0, totalDueCents: 0, overdueCents: 0, maxDaysLate: 0 };
    g.count++;
    g.totalDueCents += o.balanceCents;
    if (o.daysLate > 0) g.overdueCents += o.balanceCents;
    g.maxDaysLate = Math.max(g.maxDaysLate, o.daysLate);
    byClient.set(o.invoice.clientId, g);
  }
  const ids = [...byClient.keys()];
  const clients = ids.length ? await db().select().from(schema.clients).where(inArray(schema.clients.id, ids)) : [];
  return clients.map((c) => ({ id: c.id, name: c.name, email: recipientOf(c), ...byClient.get(c.id)! })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Statements for some clients (or every client that owes something): one email each; the result says what happened to each. */
export async function sendStatements(clientIds: string[] | null, actorId: string | null) {
  const targets = await statementTargets();
  const wanted = clientIds ? targets.filter((t) => clientIds.includes(t.id)) : targets;
  const results: { id: string; name: string; status: "sent" | "no_email" | "failed" | "mail_not_configured"; to?: string }[] = [];
  for (const t of wanted) {
    try {
      const r = await sendStatement(t.id, actorId);
      results.push({ id: t.id, name: t.name, status: "sent", to: r.to });
    } catch (e) {
      const code = e instanceof InvoiceMailError ? e.code : "mail_failed";
      results.push({ id: t.id, name: t.name, status: code === "no_email" ? "no_email" : code === "mail_not_configured" ? "mail_not_configured" : "failed" });
      if (code === "mail_not_configured") break;
    }
  }
  return results;
}

// ── automatic reminders ──
/** The highest enabled level an overdue invoice has reached (none: nothing to send) */
export const levelFor = (daysLate: number, enabled: number[]) => [...REMINDER_LEVELS].reverse().find((n) => enabled.includes(n) && daysLate >= n) ?? null;

/** One pass: every overdue invoice that reached a level not sent yet gets that level's reminder, once. */
export async function runReminders(): Promise<{ sent: number; skipped: number }> {
  const s = await mailSettings();
  // nothing is sent for an invoice dated before the chosen day (the older ones are followed up by hand)
  const owed = (await unpaidInvoices()).filter((o) => o.daysLate > 0 && (!s.remindersFrom || o.invoice.issuedOn >= s.remindersFrom));
  let sent = 0;
  let skipped = 0;
  for (const o of owed) {
    const level = levelFor(o.daysLate, s.levels);
    if (!level) continue;
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, o.invoice.clientId));
    if (!client || !client.active || !recipientOf(client)) {
      skipped++;
      continue;
    }
    // a level is claimed before anything is sent: never twice, and never a lower one after a higher one
    const done = await db().select({ level: schema.invoiceReminders.level }).from(schema.invoiceReminders).where(eq(schema.invoiceReminders.invoiceId, o.invoice.id));
    if (done.some((d) => d.level >= level)) continue;
    const [claimed] = await db().insert(schema.invoiceReminders).values({ invoiceId: o.invoice.id, level }).onConflictDoNothing().returning({ id: schema.invoiceReminders.id });
    if (!claimed) continue;
    try {
      const l = await languageOf();
      const extras = await invoiceExtras(o.invoice, client, o.balanceCents);
      const to = await deliver(reminderKey(level), client, invoiceVars(o.invoice, client, o.balanceCents, o.daysLate, l, extras.payUrl), l, extras.attachments);
      await db().update(schema.invoiceReminders).set({ toEmail: to, ok: true }).where(eq(schema.invoiceReminders.id, claimed.id));
      await audit(null, "billing.reminder_sent", o.invoice.id, { number: o.invoice.number, level, to });
      sent++;
    } catch (e) {
      await db().update(schema.invoiceReminders).set({ ok: false }).where(eq(schema.invoiceReminders.id, claimed.id));
      console.warn("[invoice reminders]", o.invoice.number, e instanceof Error ? e.message : e);
      skipped++;
    }
  }
  return { sent, skipped };
}

let ticking = false;
/** Every minute (from server/index.ts): on weekday mornings, after 8:30 Québec time, once a day, when the reminders are on. */
export async function reminderTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const s = await mailSettings();
    if (!s.remindersAuto) return;
    const now = new Date();
    const day = todayQc();
    const clock = now.toLocaleTimeString("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit" });
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (s.lastRun === day || clock < "08:30" || weekday === 0 || weekday === 6) return;
    await saveMailSettings({ lastRun: day });
    const r = await runReminders();
    await audit(null, "billing.reminders_run", null, r);
  } finally {
    ticking = false;
  }
}

