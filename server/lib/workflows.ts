import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { isAlert, lookup } from "../routes/tickets.ts";
import { renderTemplate, templateDef, type Locale, type TemplateKey } from "./emailTemplates.ts";
import { sendMail, smtpSettings } from "./mail.ts";
import { ticketSource, type NTicket } from "./ticketSource.ts";

/**
 * Automatic workflows (Admin › Flux de travail). Each one is switched on or
 * off by an administrator and starts OFF. A workflow only acts on what happens
 * after it was switched on, and never twice for the same ticket.
 *
 * "new-ticket-reply": every new ticket (made in the portal, by email, by text,
 * by the client portal… anything the ticket source shows) gets an email to its
 * contact — the "Billet reçu" template, editable in Admin › Courriel.
 */
export type WorkflowKey = "new-ticket-reply";
export const WORKFLOWS: { key: WorkflowKey; template: TemplateKey }[] = [{ key: "new-ticket-reply", template: "ticketReceived" }];
export const isWorkflowKey = (k: string): k is WorkflowKey => WORKFLOWS.some((w) => w.key === k);

/** A ticket older than this when the workflow looks at it is left alone (after an outage, nobody gets a "we received it" days late) */
const MAX_AGE_MS = 24 * 3_600_000;
const PER_TICK = 25;
const provider = (key: WorkflowKey) => `workflow:${key}`;

export async function workflowState(key: WorkflowKey): Promise<{ enabled: boolean; enabledAt: string | null }> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, provider(key)));
  return { enabled: row?.enabled ?? false, enabledAt: ((row?.config ?? {}) as { enabledAt?: string | null }).enabledAt ?? null };
}

/** Switch on (from now on: nothing before) or off. */
export async function setWorkflow(key: WorkflowKey, enabled: boolean, actorId: string | null) {
  const cur = await workflowState(key);
  if (enabled === cur.enabled) return cur;
  const config = { enabledAt: enabled ? new Date().toISOString() : null };
  await db()
    .insert(schema.integrations)
    .values({ provider: provider(key), enabled, config, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled, config, updatedBy: actorId, updatedAt: new Date() } });
  return { enabled, enabledAt: config.enabledAt };
}

/** Whether emails can leave (a mail server in production; the console in development) */
export async function mailReady(): Promise<boolean> {
  return !config.production || (await smtpSettings()).source !== "none";
}

export async function recentRuns(key: WorkflowKey, limit = 30) {
  const r = schema.workflowRuns;
  return db().select().from(r).where(eq(r.workflow, key)).orderBy(desc(r.createdAt)).limit(limit);
}

/** How many of each in the last 30 days */
export async function runCounts(key: WorkflowKey): Promise<Record<string, number>> {
  const r = schema.workflowRuns;
  const rows = await db()
    .select({ status: r.status, n: sql<number>`count(*)::int` })
    .from(r)
    .where(and(eq(r.workflow, key), gte(r.createdAt, new Date(Date.now() - 30 * 86_400_000))))
    .groupBy(r.status);
  return Object.fromEntries(rows.map((x) => [x.status, x.n]));
}

/** The message as it would go (sample data), to the administrator's own address. */
export async function sendTest(key: WorkflowKey, to: { email: string; locale: string }): Promise<boolean> {
  const def = WORKFLOWS.find((w) => w.key === key)!;
  const locale: Locale = to.locale === "en" ? "en" : "fr";
  const rendered = await renderTemplate(def.template, locale, templateDef(def.template)!.sample[locale]);
  return sendMail({ to: to.email, ...rendered, subject: `[TEST] ${rendered.subject}` });
}

let ticking = false;
/** Every minute: the switched-on workflows look at the tickets made since. Returns how many emails went out. */
export async function workflowTick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    return await newTicketReply();
  } finally {
    ticking = false;
  }
}

async function newTicketReply(): Promise<number> {
  const key: WorkflowKey = "new-ticket-reply";
  const st = await workflowState(key);
  if (!st.enabled || !st.enabledAt) return 0;
  const since = Math.max(Date.parse(st.enabledAt), Date.now() - MAX_AGE_MS);
  const src = await ticketSource();
  const [all, options] = await Promise.all([src.list(), src.options()]);
  const L = lookup(options);
  const alert = isAlert(L);
  // new since the switch, still open, not a monitoring alert
  const fresh = all.filter((t) => Date.parse(t.createdAt) >= since && L.statusKind(t.status) !== "complete" && !alert(t));
  if (!fresh.length) return 0;
  const done = new Set(
    (
      await db()
        .select({ id: schema.workflowRuns.ticketId })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.workflow, key),
            inArray(
              schema.workflowRuns.ticketId,
              fresh.map((t) => t.id),
            ),
          ),
        )
    ).map((x) => x.id),
  );
  const todo = fresh
    .filter((t) => !done.has(t.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, PER_TICK);
  let sent = 0;
  for (const t of todo) if (await replyTo(key, t)) sent++;
  return sent;
}

/** One ticket: claim it (so it is never answered twice), find who to write to, send. */
async function replyTo(key: WorkflowKey, t: NTicket): Promise<boolean> {
  const r = schema.workflowRuns;
  const [claim] = await db()
    .insert(r)
    .values({ workflow: key, ticketId: t.id, ticketNumber: t.number, ticketTitle: t.title.slice(0, 250), status: "pending" })
    .onConflictDoNothing()
    .returning({ id: r.id });
  if (!claim) return false;
  const finish = (status: "sent" | "failed" | "skipped", extra: { toEmail?: string | null; reason?: string } = {}) =>
    db()
      .update(r)
      .set({ status, toEmail: extra.toEmail ?? null, reason: extra.reason ?? null })
      .where(eq(r.id, claim.id));
  try {
    const src = await ticketSource();
    const contact = t.contactId ? ((await src.contacts(t.company.id).catch(() => [])).find((c) => c.id === t.contactId) ?? null) : null;
    const email = contact?.email?.trim().toLowerCase() || null;
    if (!email) {
      await finish("skipped", { reason: contact ? "no_email" : "no_contact" });
      return false;
    }
    // a colleague's own address (a ticket made for the team): nothing to acknowledge
    const [staff] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.kind, "staff"), sql`lower(${schema.users.email}) = ${email}`));
    if (staff) {
      await finish("skipped", { toEmail: email, reason: "internal" });
      return false;
    }
    // their language, and a link to the ticket when they have an account in the client portal
    const [account] = await db()
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.users.clientId))
      // only when their company's portal is open: otherwise the link would lead nowhere
      .where(and(eq(schema.users.kind, "client"), eq(schema.users.active, true), eq(schema.clients.portalEnabled, true), sql`lower(${schema.users.email}) = ${email}`));
    const locale: Locale = account?.locale === "en" ? "en" : "fr";
    const base = config.publicUrl;
    const vars = {
      name: contact!.name,
      number: t.number,
      title: t.title,
      company: t.company.name,
      portalUrl: base,
      ticketUrl: account && base ? `${base}/tickets?t=${t.id}` : "",
    };
    const ok = await sendMail({ to: email, ...(await renderTemplate("ticketReceived", locale, vars)) });
    await finish(ok ? "sent" : "failed", { toEmail: email, ...(ok ? {} : { reason: "mail_failed" }) });
    return ok;
  } catch (e) {
    console.warn("[workflow] new-ticket-reply:", e instanceof Error ? e.message : e);
    await finish("failed", { reason: "error" });
    return false;
  }
}
