import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { sendMail } from "./mail.ts";
import { sendSms, smsReady } from "./voipms.ts";
import { sendTeams, teamsReady } from "./teams.ts";
import { askClaude } from "./ai.ts";
import { markdownToHtml, inlineHtml } from "../../shared/reportMarkdown.ts";
import { fr, en } from "../../shared/reportTexts.ts";
import type { ReportChannels, ReportConfig } from "../db/schema.ts";

/**
 * Reports: a catalogue of data sources (only aggregates, never a salary, a password or a secret), the runs (a markdown
 * text plus the small data behind it), the schedules (Québec time) and their delivery by email, text and Teams.
 * The usage report of the portal is built in: it is made at startup and runs monthly, with no notification.
 */

export type Lang = "fr" | "en";
const T = (lang: Lang) => (lang === "en" ? en : fr);
const TZ = "America/Toronto";
export const USAGE_KEY = "portal-usage";

// ---------- Québec time ----------

/** The Québec wall clock of an instant: its day (YYYY-MM-DD), hour and minute. */
export function quebecParts(d: Date): { date: string; hh: number; mm: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekdayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
/** The Monday of a day's week. */
export const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));

/** The Québec offset (ms) at an instant: Quebec wall clock as if UTC, minus the instant. */
function offsetAt(d: Date): number {
  const q = quebecParts(d);
  const [y, m, day] = q.date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, day, q.hh, q.mm);
  return wall - Math.floor(d.getTime() / 60_000) * 60_000;
}

/** The instant of a Québec wall-clock time on a day. */
export function quebecInstant(day: string, time: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetAt(new Date(guess));
  const off2 = offsetAt(new Date(guess - off1));
  return new Date(guess - off2);
}

export type Cadence = { frequency: "daily" | "weekly" | "monthly"; time: string; weekday?: number | null; dayOfMonth?: number | null };

/** The first moment after `after` that a schedule falls on, in Québec time. */
export function nextRunAfter(s: Cadence, after: Date): Date {
  const base = quebecParts(after).date;
  for (let i = 0; i < 400; i++) {
    const day = addDays(base, i);
    const ok = s.frequency === "daily" || (s.frequency === "weekly" ? weekdayOf(day) === (s.weekday ?? 1) : Number(day.slice(8, 10)) === (s.dayOfMonth ?? 1));
    if (!ok) continue;
    const at = quebecInstant(day, s.time);
    if (at.getTime() > after.getTime()) return at;
  }
  return new Date(after.getTime() + 31 * 86_400_000);
}

export function cadenceLabel(s: Cadence, lang: Lang): string {
  const t = T(lang);
  if (s.frequency === "daily") return `${t.frequency.daily}, ${s.time}`;
  if (s.frequency === "weekly") return `${t.frequency.weekly} : ${t.weekdays[s.weekday ?? 1]} ${t.at} ${s.time}`;
  return `${t.frequency.monthly} : ${t.onDay} ${s.dayOfMonth ?? 1} ${t.at} ${s.time}`;
}

// ---------- formatting ----------

const money = (cents: number, lang: Lang) =>
  lang === "en" ? `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${(cents / 100).toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const hours = (x100: number) => Math.round(x100) / 100;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const table = (columns: string[], rows: (string | number)[][]) =>
  [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`)].join("\n");

// ---------- sources ----------

export type Table = { key: string; title: string; columns: string[]; rows: (string | number)[][] };
type Range = { from: Date; to: Date; fromDay: string; toDay: string; lang: Lang };
type Source = { title: (lang: Lang) => string; run: (r: Range) => Promise<Table> };

const qcDay = (d: Date) => quebecParts(d).date;
const weekKeys = (r: Range) => {
  const out: string[] = [];
  for (let w = mondayOf(r.fromDay); w <= r.toDay; w = addDays(w, 7)) out.push(w);
  return out;
};
const inRange = (col: Parameters<typeof gte>[0], r: Range) => and(gte(col, r.from), lte(col, r.to));

const SOURCES: Record<string, Source> = {
  tickets_flow: {
    title: (l) => T(l).sources.tickets_flow.title,
    run: async (r) => {
      const opened = await db().select({ at: schema.tickets.createdAt }).from(schema.tickets).where(inRange(schema.tickets.createdAt, r));
      const closed = await db().select({ at: schema.tickets.completedAt }).from(schema.tickets).where(and(isNotNull(schema.tickets.completedAt), inRange(schema.tickets.completedAt, r)));
      const count = (rows: { at: Date | null }[]) => {
        const m = new Map<string, number>();
        for (const x of rows) if (x.at) m.set(mondayOf(qcDay(x.at)), (m.get(mondayOf(qcDay(x.at))) ?? 0) + 1);
        return m;
      };
      const o = count(opened);
      const c = count(closed);
      return { key: "tickets_flow", title: T(r.lang).sources.tickets_flow.title, columns: [...T(r.lang).sources.tickets_flow.columns], rows: weekKeys(r).map((w) => [w, o.get(w) ?? 0, c.get(w) ?? 0]) };
    },
  },
  tickets_open: {
    title: (l) => T(l).sources.tickets_open.title,
    run: async (r) => {
      const rows = await db()
        .select({ status: schema.tickets.status, n: sql<number>`count(*)::int` })
        .from(schema.tickets)
        .where(isNull(schema.tickets.completedAt))
        .groupBy(schema.tickets.status)
        .orderBy(desc(sql`count(*)`));
      return { key: "tickets_open", title: T(r.lang).sources.tickets_open.title, columns: [...T(r.lang).sources.tickets_open.columns], rows: rows.map((x) => [x.status, x.n]) };
    },
  },
  hours: {
    title: (l) => T(l).sources.hours.title,
    run: async (r) => {
      // hours only: the wages and the bank are never read here
      const rows = await db()
        .select({ date: schema.timesheetEntries.date, h: schema.timesheetEntries.hoursX100, b: schema.timesheetEntries.billableX100 })
        .from(schema.timesheetEntries)
        .where(and(gte(schema.timesheetEntries.date, r.fromDay), lte(schema.timesheetEntries.date, r.toDay)));
      const h = new Map<string, number>();
      const b = new Map<string, number>();
      for (const x of rows) {
        const w = mondayOf(x.date);
        h.set(w, (h.get(w) ?? 0) + x.h);
        b.set(w, (b.get(w) ?? 0) + (x.b ?? 0));
      }
      return { key: "hours", title: T(r.lang).sources.hours.title, columns: [...T(r.lang).sources.hours.columns], rows: weekKeys(r).map((w) => [w, hours(h.get(w) ?? 0) / 100, hours(b.get(w) ?? 0) / 100]) };
    },
  },
  invoices: {
    title: (l) => T(l).sources.invoices.title,
    run: async (r) => {
      const [inv] = await db()
        .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${schema.clientInvoices.totalCents}), 0)::float8` })
        .from(schema.clientInvoices)
        .where(and(gte(schema.clientInvoices.issuedOn, r.fromDay), lte(schema.clientInvoices.issuedOn, r.toDay), eq(schema.clientInvoices.voided, false)));
      const [pay] = await db()
        .select({ total: sql<number>`coalesce(sum(${schema.invoicePayments.amountCents}), 0)::float8` })
        .from(schema.invoicePayments)
        .where(and(gte(schema.invoicePayments.paidOn, r.fromDay), lte(schema.invoicePayments.paidOn, r.toDay)));
      const L = T(r.lang).rows;
      return {
        key: "invoices",
        title: T(r.lang).sources.invoices.title,
        columns: [...T(r.lang).sources.invoices.columns],
        rows: [
          [L.invoices, inv?.n ?? 0],
          [L.invoiced, money(inv?.total ?? 0, r.lang)],
          [L.payments, money(pay?.total ?? 0, r.lang)],
        ],
      };
    },
  },
  new_clients: {
    title: (l) => T(l).sources.new_clients.title,
    run: async (r) => {
      const rows = await db()
        .select({ name: schema.clients.name, at: schema.clients.createdAt })
        .from(schema.clients)
        .where(inRange(schema.clients.createdAt, r))
        .orderBy(desc(schema.clients.createdAt))
        .limit(100);
      return { key: "new_clients", title: T(r.lang).sources.new_clients.title, columns: [...T(r.lang).sources.new_clients.columns], rows: rows.map((x) => [x.name, qcDay(x.at)]) };
    },
  },
  projects: {
    title: (l) => T(l).sources.projects.title,
    run: async (r) => {
      const byStatus = await db().select({ status: schema.projects.status, n: sql<number>`count(*)::int` }).from(schema.projects).groupBy(schema.projects.status).orderBy(asc(schema.projects.status));
      const [created] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(inRange(schema.projects.createdAt, r));
      return {
        key: "projects",
        title: T(r.lang).sources.projects.title,
        columns: [...T(r.lang).sources.projects.columns],
        rows: [...byStatus.map((x) => [x.status, x.n] as (string | number)[]), [T(r.lang).rows.projectsCreated, created?.n ?? 0]],
      };
    },
  },
  tasks: {
    title: (l) => T(l).sources.tasks.title,
    run: async (r) => {
      const L = T(r.lang).rows;
      const [open] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.pipelineTasks).where(ne(schema.pipelineTasks.status, "done"));
      const [done] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.pipelineTasks).where(and(isNotNull(schema.pipelineTasks.completedAt), inRange(schema.pipelineTasks.completedAt, r)));
      const [made] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.pipelineTasks).where(inRange(schema.pipelineTasks.createdAt, r));
      return { key: "tasks", title: T(r.lang).sources.tasks.title, columns: [...T(r.lang).sources.tasks.columns], rows: [[L.openTasks, open?.n ?? 0], [L.doneTasks, done?.n ?? 0], [L.createdTasks, made?.n ?? 0]] };
    },
  },
  logins: {
    title: (l) => T(l).sources.logins.title,
    run: async (r) => {
      // who signed in, not what they did: counts only
      const rows = await db().select({ at: schema.sessions.createdAt, userId: schema.sessions.userId }).from(schema.sessions).where(inRange(schema.sessions.createdAt, r));
      const n = new Map<string, number>();
      const people = new Map<string, Set<string>>();
      for (const x of rows) {
        const w = mondayOf(qcDay(x.at));
        n.set(w, (n.get(w) ?? 0) + 1);
        if (!people.has(w)) people.set(w, new Set());
        people.get(w)!.add(x.userId);
      }
      return { key: "logins", title: T(r.lang).sources.logins.title, columns: [...T(r.lang).sources.logins.columns], rows: weekKeys(r).map((w) => [w, n.get(w) ?? 0, people.get(w)?.size ?? 0]) };
    },
  },
  quotes: {
    title: (l) => T(l).sources.quotes.title,
    run: async (r) => {
      const byStatus = await db()
        .select({ status: schema.quotes.status, n: sql<number>`count(*)::int` })
        .from(schema.quotes)
        .where(inRange(schema.quotes.createdAt, r))
        .groupBy(schema.quotes.status);
      const total = byStatus.reduce((s, x) => s + x.n, 0);
      return { key: "quotes", title: T(r.lang).sources.quotes.title, columns: [...T(r.lang).sources.quotes.columns], rows: [[T(r.lang).rows.quotesCreated, total], ...byStatus.map((x) => [x.status, x.n] as (string | number)[])] };
    },
  },
};

export const SOURCE_KEYS = Object.keys(SOURCES);
export const sourceList = (lang: Lang) => SOURCE_KEYS.map((key) => ({ key, title: SOURCES[key].title(lang) }));

// ---------- the portal usage (built in) ----------

type UsageModule = { key: string; prefixes: string[]; records?: (from: Date) => Promise<number> };
/** Rows of a table created since a day (a count). */
const since = async (from: Date, col: any, table: any) => {
  const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(table).where(gte(col, from));
  return r?.n ?? 0;
};

/** The modules of the sidebar, with the audit actions that show their use and the tables of what they create. */
const USAGE: UsageModule[] = [
  { key: "dashboard", prefixes: ["dashboard."] },
  { key: "messages", prefixes: ["message."], records: (f) => since(f, schema.messages.createdAt, schema.messages) },
  { key: "meetings", prefixes: ["meeting.", "meetings."] },
  { key: "breakroom", prefixes: [] },
  { key: "tickets", prefixes: ["ticket.", "ticket_source.", "ticket_statuses.", "delegate.", "board.ticket", "portal.ticket"], records: (f) => since(f, schema.tickets.createdAt, schema.tickets) },
  { key: "pipeline", prefixes: ["pipeline."], records: (f) => since(f, schema.pipelineTasks.createdAt, schema.pipelineTasks) },
  { key: "projects", prefixes: ["project."], records: (f) => since(f, schema.projects.createdAt, schema.projects) },
  { key: "sms", prefixes: ["sms."] },
  { key: "chat", prefixes: ["chat."] },
  { key: "outlook", prefixes: ["outlook."] },
  { key: "timesheets", prefixes: ["timesheet.", "time."], records: (f) => since(f, schema.timesheetEntries.createdAt, schema.timesheetEntries) },
  { key: "expenses", prefixes: ["expense."] },
  { key: "crm", prefixes: ["crm.client", "crm.contact", "crm.billing_contact", "crm.primary_contact", "crm.portal", "crm.synced", "crm.tab_order", "crm.self_managed", "crm.support_contract", "crm.invoice_updated", "client.", "client_class."], records: (f) => since(f, schema.clients.createdAt, schema.clients) },
  { key: "contracts", prefixes: ["crm.contract", "contract_type.", "crm.bank_"] },
  { key: "invoices", prefixes: ["billing.invoice", "billing.payment", "billing.reminder", "billing.statement", "billing.credit", "billing.stripe", "billing.quickbooks", "billing.card", "billing.autopay", "billing.settings", "billing.mail"], records: (f) => since(f, schema.clientInvoices.createdAt, schema.clientInvoices) },
  { key: "approvals", prefixes: ["billing.item", "billing.items", "billing.labour", "billing.cleanup"] },
  { key: "vendorPayments", prefixes: ["vendor_bills."] },
  { key: "sales", prefixes: ["sales."], records: (f) => since(f, schema.salesOpportunities.createdAt, schema.salesOpportunities) },
  { key: "quotes", prefixes: ["quote."], records: (f) => since(f, schema.quotes.createdAt, schema.quotes) },
  { key: "store", prefixes: ["store."] },
  { key: "hr", prefixes: ["hr.", "payroll_plan."] },
  { key: "newsletter", prefixes: ["newsletter."], records: (f) => since(f, schema.newsletterIssues.createdAt, schema.newsletterIssues) },
  { key: "services", prefixes: ["service."] },
  { key: "passbolt", prefixes: ["passbolt."] },
  { key: "documentation", prefixes: ["sop.", "kb."], records: async (f) => (await since(f, schema.sops.createdAt, schema.sops)) + (await since(f, schema.kbArticles.createdAt, schema.kbArticles)) },
  { key: "reports", prefixes: ["report."] },
];

type UsageRow = { module: string; label: string; actions: number; records: number | null; people: number | null; last: string | null; status: "under" | "ok" | "none" | "nm" };

/** How the portal is used over the last `days` days. Rules-based text always; the AI reading when it is configured. */
export async function portalUsage(days: number, lang: Lang) {
  const t = T(lang).builtin["portal-usage"];
  const modules = T(lang).modules as Record<string, string>;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromDay = qcDay(from);
  const toDay = qcDay(to);
  const range: Range = { from, to, fromDay, toDay, lang };

  // every action of the period, once per (action, person): counted per module below
  const acts = await db()
    .select({ action: schema.auditLog.action, actor: schema.auditLog.actorId, n: sql<number>`count(*)::int`, last: sql<Date>`max(${schema.auditLog.createdAt})` })
    .from(schema.auditLog)
    .where(gte(schema.auditLog.createdAt, from))
    .groupBy(schema.auditLog.action, schema.auditLog.actorId);

  const rows: UsageRow[] = [];
  for (const m of USAGE) {
    const label = modules[m.key] ?? m.key;
    if (m.prefixes.length === 0) {
      rows.push({ module: m.key, label, actions: 0, records: null, people: null, last: null, status: "nm" });
      continue;
    }
    let actions = 0;
    const people = new Set<string>();
    let last: Date | null = null;
    for (const a of acts) {
      if (!m.prefixes.some((p) => a.action.startsWith(p))) continue;
      actions += a.n;
      if (a.actor) people.add(a.actor);
      const at = a.last ? new Date(a.last) : null;
      if (at && (!last || at > last)) last = at;
    }
    const records = m.records ? await m.records(from) : null;
    const total = actions + (records ?? 0);
    const under = total === 0 || total < 3 || (people.size > 0 && people.size < 2);
    rows.push({
      module: m.key,
      label,
      actions,
      records,
      people: people.size,
      last: last ? last.toISOString() : null,
      status: total === 0 ? "none" : under ? "under" : "ok",
    });
  }
  rows.sort((a, b) => (b.actions + (b.records ?? 0)) - (a.actions + (a.records ?? 0)) || a.label.localeCompare(b.label));

  const measured = rows.filter((r) => r.status !== "nm");
  const active = measured.filter((r) => r.status !== "none");
  const underused = measured.filter((r) => r.status === "under");
  const notMeasured = rows.filter((r) => r.status === "nm");

  // sign-ins and presence
  const sessions = await db().select({ userId: schema.sessions.userId }).from(schema.sessions).where(gte(schema.sessions.createdAt, from));
  const seenNow = await db().select({ userId: schema.sessions.userId }).from(schema.sessions).where(gte(schema.sessions.lastSeenAt, from));
  const present = new Set([...seenNow.map((s) => s.userId), ...acts.filter((a) => a.actor && a.last && new Date(a.last) >= from).map((a) => a.actor as string)]);
  const staff = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  const dormant = staff.filter((u) => !present.has(u.id)).map((u) => u.name);
  const connPeople = new Set(sessions.map((s) => s.userId)).size;

  const logins = await SOURCES.logins.run(range);
  const sum = (x: UsageRow) => x.actions + (x.records ?? 0);

  const lines = [
    fill(t.headline, { active: active.length, measured: measured.length, days }),
    underused.length ? fill(t.underused, { list: underused.map((r) => r.label).join(", ") }) : t.noUnderused,
    notMeasured.length ? fill(t.notMeasured, { list: notMeasured.map((r) => r.label).join(", ") }) : "",
    t.rule,
    dormant.length ? fill(t.dormant, { count: dormant.length, list: dormant.join(", ") }) : t.noDormant,
    fill(t.connections, { count: sessions.length, people: connPeople }),
  ].filter(Boolean);

  const statusText = (s: UsageRow["status"]) => (s === "under" ? t.statusUnderused : s === "ok" ? t.statusOk : s === "none" ? t.statusNone : t.statusNotMeasured);
  const body = [
    `# ${t.title}`,
    t.intro,
    `## ${t.summaryTitle}`,
    lines.map((l) => `- ${l}`).join("\n"),
    `## ${t.moduleTitle}`,
    table(
      [t.tableModule, t.tableActions, t.tableRecords, t.tablePeople, t.tableLast, t.tableStatus],
      rows.map((r) => [r.label, r.status === "nm" ? "-" : r.actions, r.records ?? "-", r.people ?? "-", r.last ? qcDay(new Date(r.last)) : "-", statusText(r.status)]),
    ),
    `## ${t.connectionsTitle}`,
    table(logins.columns, logins.rows),
    ...(dormant.length ? [`## ${t.dormantTitle}`, dormant.map((n) => `- ${n}`).join("\n")] : []),
  ];
  const headline = lines[0];
  const data = { days, modules: rows.map((r) => ({ module: r.module, label: r.label, actions: r.actions, records: r.records, people: r.people, last: r.last, status: r.status, total: sum(r) })), dormant, connections: { sessions: sessions.length, people: connPeople }, tables: [logins] };
  return { markdown: body.join("\n\n"), summary: [headline, underused.length ? fill(t.underused, { list: underused.map((r) => r.label).join(", ") }) : t.noUnderused].join(" "), data, title: t.title };
}

// ---------- runs ----------

/** One AI reading of a markdown text. Its failure never fails the run (the reason is returned). */
async function aiReading(markdown: string, lang: Lang): Promise<{ text: string | null; error: string | null }> {
  const t = T(lang);
  try {
    const text = await askClaude({ system: t.ai.system, prompt: `${t.ai.intro}\n\n${markdown.slice(0, 12_000)}`, maxTokens: 600, feature: "reports.summary", userId: null });
    return { text: text.trim() || null, error: null };
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : "ai_failed" };
  }
}

type RunResult = { body: string; summary: string; data: Record<string, unknown> };

async function customRun(def: { name: string; description: string; config: ReportConfig }, lang: Lang): Promise<RunResult> {
  const t = T(lang);
  const days = def.config.period ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const range: Range = { from, to, fromDay: qcDay(from), toDay: qcDay(to), lang };
  const keys = (def.config.sources ?? []).filter((k) => SOURCES[k]);
  const tables: Table[] = [];
  for (const k of keys) tables.push(await SOURCES[k].run(range));
  const period = t.period[days as 7 | 30 | 90] ?? `${days}`;
  const parts = [`# ${def.name}`, def.description, `${t.period_label} : ${period}. ${t.generatedAt} ${qcDay(to)}.`].filter(Boolean);
  for (const tb of tables) {
    parts.push(`## ${tb.title}`);
    parts.push(tb.rows.length ? table(tb.columns, tb.rows) : t.noData);
  }
  let body = parts.join("\n\n");
  const data: Record<string, unknown> = { period: days, tables };
  if (def.config.aiSummary) {
    const ai = await aiReading(body, lang);
    if (ai.text) body += `\n\n## ${t.run.aiTitle}\n\n${ai.text}`;
    data.aiError = ai.error;
  }
  const summary = `${fill(t.run.summaryTable, { count: tables.length, period })}`;
  return { body, summary, data };
}

async function builtinRun(key: string, lang: Lang): Promise<RunResult> {
  if (key !== USAGE_KEY) throw new Error("unknown_builtin");
  const u = await portalUsage(30, lang);
  let body = u.markdown;
  const data: Record<string, unknown> = { ...u.data };
  const ai = await aiReading(body, lang);
  if (ai.text) body += `\n\n## ${T(lang).builtin["portal-usage"].aiTitle}\n\n${ai.text}`;
  data.aiError = ai.error;
  return { body, summary: u.summary, data };
}

/** Runs a report now: stores the run (running, then ok or failed). Never throws for a failing report. */
export async function runReport(reportId: string, o: { trigger: "manual" | "schedule"; scheduleId?: string | null; startedBy?: string | null; lang?: Lang }) {
  const [def] = await db().select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, reportId));
  if (!def) throw new Error("report_not_found");
  const lang: Lang = o.lang ?? "fr";
  const [run] = await db()
    .insert(schema.reportRuns)
    .values({ reportId, scheduleId: o.scheduleId ?? null, trigger: o.trigger, status: "running", startedBy: o.startedBy ?? null })
    .returning();
  try {
    const res = def.kind === "builtin" ? await builtinRun(def.key ?? "", lang) : await customRun(def, lang);
    const [done] = await db()
      .update(schema.reportRuns)
      .set({ status: "ok", finishedAt: new Date(), summary: res.summary, body: res.body, data: res.data })
      .where(eq(schema.reportRuns.id, run.id))
      .returning();
    return done;
  } catch (e) {
    const [failed] = await db()
      .update(schema.reportRuns)
      .set({ status: "failed", finishedAt: new Date(), error: e instanceof Error ? e.message.slice(0, 500) : "failed" })
      .where(eq(schema.reportRuns.id, run.id))
      .returning();
    return failed;
  }
}

// ---------- delivery ----------

export type Delivered = {
  email: { to: string; ok: boolean; error?: string }[];
  sms: { to: string; ok: boolean; error?: string }[];
  teams: { ok: boolean; error?: string } | null;
};
const MAX = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends a finished run to the channels. Each channel is recorded on its own; a failure never fails the run. */
export async function deliver(run: { id: string; reportId: string; body: string; summary: string; status: string }, name: string, channels: ReportChannels, lang: Lang): Promise<Delivered> {
  const t = T(lang).channels;
  const link = config.publicUrl ? `${config.publicUrl}/reports` : "";
  const out: Delivered = { email: [], sms: [], teams: null };
  if (run.status !== "ok") return out;
  const summary = run.summary;

  for (const to of [...new Set(channels.email.map((e) => e.trim().toLowerCase()))].slice(0, MAX)) {
    if (!EMAIL.test(to)) {
      out.email.push({ to, ok: false, error: "invalid" });
      continue;
    }
    try {
      const html = `<p>${inlineHtml(fill(t.emailIntro, { name, summary }))}</p>${markdownToHtml(run.body)}${link ? `<p><a href="${link}">${inlineHtml(t.emailOpen)}</a></p>` : ""}`;
      const ok = await sendMail({ to, subject: fill(t.emailSubject, { name }), text: `${fill(t.emailIntro, { name, summary })}\n\n${run.body}`, html });
      out.email.push({ to, ok, ...(ok ? {} : { error: "send_failed" }) });
    } catch (e) {
      out.email.push({ to, ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "failed" });
    }
  }

  const numbers = [...new Set(channels.sms.map((s) => s.replace(/[^\d+]/g, "")))].filter(Boolean).slice(0, MAX);
  if (numbers.length) {
    const ready = await smsReady().catch(() => false);
    for (const to of numbers) {
      if (!ready) {
        out.sms.push({ to, ok: false, error: "not_ready" });
        continue;
      }
      try {
        await sendSms(to, fill(t.smsText, { name, summary: summary.slice(0, 200), link }).slice(0, 320));
        out.sms.push({ to, ok: true });
      } catch (e) {
        out.sms.push({ to, ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "failed" });
      }
    }
  }

  if (channels.teams) {
    if (!(await teamsReady().catch(() => false))) out.teams = { ok: false, error: "not_ready" };
    else {
      try {
        await sendTeams({ title: fill(t.teamsTitle, { name }), text: summary, ...(link ? { link } : {}) });
        out.teams = { ok: true };
      } catch (e) {
        out.teams = { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "failed" };
      }
    }
  }
  return out;
}

export const NO_CHANNELS: ReportChannels = { email: [], sms: [], teams: false };

// ---------- scheduler ----------

/**
 * Runs the schedules that are due (Québec time). The schedule's next run is moved first, on a conditional update, so
 * a schedule runs once even if two ticks overlap. Returns how many ran.
 */
export async function reportsTick(now = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(schema.reportSchedules)
    .where(and(eq(schema.reportSchedules.enabled, true), lte(schema.reportSchedules.nextRunAt, now)));
  let ran = 0;
  for (const s of due) {
    const next = nextRunAfter(s, now);
    const claimed = await db()
      .update(schema.reportSchedules)
      .set({ nextRunAt: next, updatedAt: now })
      .where(and(eq(schema.reportSchedules.id, s.id), eq(schema.reportSchedules.enabled, true), lte(schema.reportSchedules.nextRunAt, now)))
      .returning({ id: schema.reportSchedules.id });
    if (!claimed.length) continue;
    try {
      const [def] = await db().select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, s.reportId));
      const run = await runReport(s.reportId, { trigger: "schedule", scheduleId: s.id, lang: "fr" });
      const delivered = await deliver(run, def?.name ?? "", s.channels, "fr");
      await db().update(schema.reportRuns).set({ delivered }).where(eq(schema.reportRuns.id, run.id));
      await db().update(schema.reportSchedules).set({ lastRunAt: new Date() }).where(eq(schema.reportSchedules.id, s.id));
      ran++;
    } catch (e) {
      console.warn("[reports] schedule failed:", e instanceof Error ? e.message : e);
    }
  }
  return ran;
}

// ---------- built-in reports at startup ----------

/**
 * The built-in usage report, made when missing, with its monthly schedule (day 1, 06:00 Québec) and no channels: nobody
 * is notified, the admin reads the history. Its schedule is made with the report only, so a deleted schedule stays deleted.
 */
export async function ensureBuiltinReports(): Promise<void> {
  const [existing] = await db().select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.key, USAGE_KEY));
  if (existing) return;
  const [def] = await db()
    .insert(schema.reportDefinitions)
    .values({
      key: USAGE_KEY,
      kind: "builtin",
      name: fr.builtin["portal-usage"].name,
      description: fr.builtin["portal-usage"].description,
      config: { period: 30, aiSummary: true },
    })
    .returning();
  const cadence: Cadence = { frequency: "monthly", time: "06:00", dayOfMonth: 1 };
  await db().insert(schema.reportSchedules).values({
    reportId: def.id,
    ...cadence,
    weekday: null,
    enabled: true,
    channels: NO_CHANNELS,
    nextRunAt: nextRunAfter(cadence, new Date()),
  });
}

/** Helper for the routes: the report's schedules, with their last run status. */
export async function schedulesOf(reportIds?: string[]) {
  const q = db().select().from(schema.reportSchedules).orderBy(asc(schema.reportSchedules.nextRunAt));
  return reportIds ? q.where(inArray(schema.reportSchedules.reportId, reportIds)) : q;
}
