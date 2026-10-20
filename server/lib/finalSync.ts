import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { autotask, AutotaskError, listResources } from "./autotask.ts";
import { atChunks, atPicklist, atSafeFields, autotaskLinked } from "./ticketSource.ts";
import { importFromSource, startTicketImport, ticketImportSettled, ticketMode, ticketsLocal } from "./localTickets.ts";

/**
 * The last sync with Autotask, before its connection is closed (Admin ›
 * Integrations › Autotask): every ticket since a date (into the portal's own
 * tickets), every expense report since that date with its status (into the
 * portal's expense reports), and the time sheets as CSV files kept in the
 * portal. Safe to run again: tickets and expense reports are updated, not
 * doubled. Autotask's version wins.
 */
export type PartKey = "tickets" | "expenses" | "timesheets";
export const PARTS: PartKey[] = ["tickets", "expenses", "timesheets"];
export type PartState = { state: "pending" | "running" | "done" | "failed" | "skipped"; counts?: Record<string, number>; lists?: Record<string, string[]>; note?: string; error?: string };
export type FinalSyncState = {
  since: string;
  parts: PartKey[];
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  results: Record<PartKey, PartState>;
};

const PROVIDER = "autotask.finalsync";
let live: Promise<void> | null = null;

export async function finalSyncState(): Promise<(FinalSyncState & { files: { id: string; kind: string; filename: string; rows: number; createdAt: string }[] }) | null> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  const state = (row?.config ?? null) as FinalSyncState | null;
  if (!state?.since) return null;
  const files = await db()
    .select({ id: schema.autotaskExports.id, kind: schema.autotaskExports.kind, filename: schema.autotaskExports.filename, rows: schema.autotaskExports.rows, createdAt: schema.autotaskExports.createdAt })
    .from(schema.autotaskExports)
    .orderBy(desc(schema.autotaskExports.createdAt));
  // a state left "running" by a restart is not running any more
  const running = state.running && live !== null;
  return { ...state, running, files: files.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })) };
}
async function save(state: FinalSyncState, actorId: string | null) {
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled: true, config: state as unknown as Record<string, unknown>, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { config: state as unknown as Record<string, unknown>, updatedBy: actorId, updatedAt: new Date() } });
}

export class FinalSyncError extends Error {
  constructor(public code: "running" | "invalid") {
    super(code);
  }
}

/** Start the pass in the background; the page polls `finalSyncState`. */
export async function startFinalSync(p: { since: string; parts?: PartKey[] }, actorId: string): Promise<void> {
  if (live) throw new FinalSyncError("running");
  const parts = PARTS.filter((k) => (p.parts ?? PARTS).includes(k));
  if (!parts.length || !/^\d{4}-\d{2}-\d{2}$/.test(p.since)) throw new FinalSyncError("invalid");
  const state: FinalSyncState = {
    since: p.since,
    parts,
    running: true,
    startedAt: new Date().toISOString(),
    results: { tickets: { state: parts.includes("tickets") ? "pending" : "skipped" }, expenses: { state: parts.includes("expenses") ? "pending" : "skipped" }, timesheets: { state: parts.includes("timesheets") ? "pending" : "skipped" } },
  };
  await save(state, actorId);
  live = run(state, actorId).finally(() => {
    live = null;
  });
}
/** For the tests: once the pass started is over */
export const finalSyncSettled = () => live ?? Promise.resolve();

const FUNCTIONS: Record<PartKey, (since: string, actorId: string) => Promise<{ counts?: Record<string, number>; lists?: Record<string, string[]>; note?: string; skipped?: boolean }>> = {
  tickets: syncTickets,
  expenses: syncExpenses,
  timesheets: exportTimesheets,
};

async function run(state: FinalSyncState, actorId: string) {
  for (const key of state.parts) {
    state.results[key] = { state: "running" };
    await save(state, actorId);
    try {
      const r = await FUNCTIONS[key](state.since, actorId);
      state.results[key] = r.skipped ? { state: "skipped", note: r.note } : { state: "done", counts: r.counts, lists: r.lists, note: r.note };
    } catch (e) {
      const text = e instanceof AutotaskError ? (e.detail ?? e.code) : e instanceof Error ? e.message : String(e);
      state.results[key] = { state: "failed", error: text.slice(0, 300) };
      console.error(`[final sync] ${key}:`, e);
    }
    await save(state, actorId);
  }
  state.running = false;
  state.finishedAt = new Date().toISOString();
  await save(state, actorId);
  await audit(actorId, "autotask.final_sync", null, { since: state.since, results: Object.fromEntries(Object.entries(state.results).map(([k, v]) => [k, v.state])) });
}

// ── Tickets ──
type PartResult = { counts?: Record<string, number>; lists?: Record<string, string[]>; note?: string; skipped?: boolean };
async function syncTickets(since: string, actorId: string): Promise<PartResult> {
  if (!(await autotaskLinked())) return { skipped: true, note: "not_linked" };
  if (await ticketsLocal()) {
    const r = await importFromSource({ since }, actorId);
    return {
      counts: { tickets: r.imported, skippedDeleted: r.skippedDeleted, keptPortal: r.keptPortal, renumbered: r.renumbered, possibleDuplicates: r.possible.length },
      lists: r.possible.length ? { possibleDuplicates: r.possible } : undefined,
    };
  }
  // not in the portal yet: the move is made with this date (one way, as in Admin › Billets)
  await startTicketImport(actorId, since);
  await ticketImportSettled();
  const mode = await ticketMode();
  if (mode.mode !== "local") throw new Error(mode.import?.error ?? "copy_failed");
  return { counts: { tickets: mode.import?.done ?? 0 }, note: "switched" };
}

// ── Expense reports with their status ──
/** Autotask's report status (a fixed list: In Progress, Awaiting Approval, Approved for Payment, Rejected, Paid, Transferred to QuickBooks) → the portal's */
export function expenseStatusOf(label: string): "draft" | "submitted" | "approved" | "rejected" | "paid" {
  const l = label.toLowerCase();
  if (/reject|rejet|refus/.test(l)) return "rejected";
  if (/\bpaid\b|pay[ée]|transferred|transf[ée]r|quickbooks/.test(l)) return "paid";
  if (/await|attente|submit|soumis/.test(l)) return "submitted";
  if (/approv|approuv/.test(l)) return "approved";
  return "draft";
}

const day = (x?: string | null) => (x ? x.slice(0, 10) : null);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);

type AtReport = { id: number; name?: string; submitterID?: number | null; status?: number; submitDate?: string | null; weekEnding?: string | null; approvedDate?: string | null; approverID?: number | null; rejectionReason?: string | null };
type AtItem = {
  id: number;
  expenseReportID: number;
  expenseDate?: string | null;
  description?: string | null;
  expenseCategory?: number | null;
  expenseCurrencyExpenseAmount?: number | null;
  internalCurrencyExpenseAmount?: number | null;
  companyID?: number | null;
  ticketID?: number | null;
  isBillableToCompany?: boolean;
  miles?: number | null;
};

async function syncExpenses(since: string, _actorId: string): Promise<PartResult> {
  if (!(await autotaskLinked())) return { skipped: true, note: "not_linked" };
  const at = await autotask();
  const [reportFields, itemFields, statusLabels, categoryLabels] = await Promise.all([
    atSafeFields(at, "ExpenseReports", ["id", "name", "submitterID", "status", "submitDate", "weekEnding", "approvedDate", "approverID", "rejectionReason"]),
    atSafeFields(at, "ExpenseItems", ["id", "expenseReportID", "expenseDate", "description", "expenseCategory", "expenseCurrencyExpenseAmount", "internalCurrencyExpenseAmount", "companyID", "ticketID", "isBillableToCompany", "miles"]),
    atPicklist(at, "ExpenseReports", "status"),
    atPicklist(at, "ExpenseItems", "expenseCategory"),
  ]);
  const reports = await at.query<AtReport>("ExpenseReports", [{ op: "gte", field: "weekEnding", value: `${since}T00:00:00.000Z` }] as never, { fields: reportFields, max: 20_000, complete: true });
  const items: AtItem[] = [];
  for (const part of atChunks(reports.map((r) => r.id), 200)) {
    items.push(...(await at.query<AtItem>("ExpenseItems", [{ op: "in", field: "expenseReportID", value: part }] as never, { fields: itemFields, max: 50_000, complete: true })));
  }

  const [users, clients, types] = await Promise.all([
    db().select({ id: schema.users.id, resource: schema.users.autotaskResourceId }).from(schema.users).where(isNotNull(schema.users.autotaskResourceId)),
    db().select({ id: schema.clients.id, at: schema.clients.autotaskId }).from(schema.clients).where(isNotNull(schema.clients.autotaskId)),
    db().select().from(schema.expenseTypes),
  ]);
  const userOf = new Map(users.map((u) => [u.resource!, u.id]));
  const clientOf = new Map(clients.map((c) => [c.at!, c.id]));
  const typeByName = new Map(types.map((x) => [x.name.trim().toLowerCase(), x.id]));
  /** The portal's expense type for an Autotask category (made, hidden from new expenses, when the portal has none of that name) */
  const typeFor = async (categoryId: number | null | undefined): Promise<string> => {
    const label = ((categoryId != null ? categoryClean(categoryLabels.get(String(categoryId))) : null) ?? "Autotask").trim();
    const key = label.toLowerCase();
    const known = typeByName.get(key);
    if (known) return known;
    const [row] = await db().insert(schema.expenseTypes).values({ name: label, active: false, billable: false, position: 900 }).returning({ id: schema.expenseTypes.id });
    typeByName.set(key, row.id);
    return row.id;
  };

  const byReport = new Map<number, AtItem[]>();
  for (const it of items) byReport.set(it.expenseReportID, [...(byReport.get(it.expenseReportID) ?? []), it]);
  let importedReports = 0;
  let importedItems = 0;
  let noAccount = 0;
  let keptPortal = 0;
  const byStatus: Record<string, number> = {};
  // changed in the portal since the last copy (approved, paid, edited…): the portal's version stays
  const EDIT_MS = 5_000;
  const edited = (row: { updatedAt: Date; autotaskSyncedAt: Date | null } | undefined) => Boolean(row?.autotaskSyncedAt && row.updatedAt.getTime() > row.autotaskSyncedAt.getTime() + EDIT_MS);
  const [knownReports, knownItems, ownItems] = await Promise.all([
    db().select({ id: schema.expenseReports.id, at: schema.expenseReports.autotaskId, updatedAt: schema.expenseReports.updatedAt, autotaskSyncedAt: schema.expenseReports.autotaskSyncedAt }).from(schema.expenseReports).where(isNotNull(schema.expenseReports.autotaskId)),
    db().select({ at: schema.expenses.autotaskId, updatedAt: schema.expenses.updatedAt, autotaskSyncedAt: schema.expenses.autotaskSyncedAt }).from(schema.expenses).where(isNotNull(schema.expenses.autotaskId)),
    // what technicians typed in the portal themselves: a look-alike is reported, never skipped
    db().select({ userId: schema.expenses.userId, date: schema.expenses.date, amount: schema.expenses.amountCents }).from(schema.expenses).where(and(isNull(schema.expenses.autotaskId), gte(schema.expenses.date, since))),
  ]);
  const reportRow = new Map(knownReports.map((r) => [r.at!, r]));
  const itemRow = new Map(knownItems.map((r) => [r.at!, r]));
  const own = new Set(ownItems.map((x) => `${x.userId}|${x.date}|${Number(x.amount)}`));
  const possible: string[] = [];
  for (const r of reports) {
    const userId = r.submitterID ? userOf.get(r.submitterID) : undefined;
    if (!userId) {
      noAccount++;
      continue;
    }
    const kind = expenseStatusOf(statusLabels.get(String(r.status)) ?? "");
    const mine = byReport.get(r.id) ?? [];
    const dates = mine.map((i) => day(i.expenseDate)).filter((d): d is string => Boolean(d));
    const end = day(r.weekEnding) ?? (dates.length ? dates.sort().at(-1)! : since);
    const periodStart = [addDays(end, -6), ...dates].sort()[0];
    const periodEnd = [end, ...dates].sort().at(-1)!;
    const submittedAt = kind === "draft" ? null : new Date(r.submitDate ?? r.approvedDate ?? `${end}T12:00:00Z`);
    const approver = r.approverID ? (userOf.get(r.approverID) ?? null) : null;
    const decidedAt = r.approvedDate ? new Date(r.approvedDate) : null;
    // the types first (a new one is made outside the transaction)
    const typeIds = new Map<number | null | undefined, string>();
    for (const it of mine) if (!typeIds.has(it.expenseCategory)) typeIds.set(it.expenseCategory, await typeFor(it.expenseCategory));
    await db().transaction(async (tx) => {
      const now = new Date();
      const base = { userId, title: (r.name ?? "").trim() || `Autotask #${r.id}`, periodStart, periodEnd, submittedAt, autotaskId: r.id, autotaskSyncedAt: now, updatedAt: now };
      const known = reportRow.get(r.id);
      const [report] = edited(known)
        ? [{ id: known!.id }]
        : await tx.insert(schema.expenseReports).values(base).onConflictDoUpdate({ target: schema.expenseReports.autotaskId, set: base }).returning({ id: schema.expenseReports.id });
      for (const it of mine) {
        if (edited(itemRow.get(it.id))) {
          keptPortal++;
          continue;
        }
        const amount = cents(it.expenseCurrencyExpenseAmount ?? it.internalCurrencyExpenseAmount);
        const miles = it.miles && it.miles > 0 ? it.miles : null;
        const values = {
          userId,
          reportId: report.id,
          date: day(it.expenseDate) ?? end,
          typeId: typeIds.get(it.expenseCategory)!,
          description: (it.description ?? "").trim(),
          quantityX100: miles ? Math.round(miles * 100) : 100,
          unitPriceCents: miles ? Math.round(amount / miles) : amount,
          amountCents: amount,
          clientId: it.companyID ? (clientOf.get(it.companyID) ?? null) : null,
          billable: it.isBillableToCompany === true,
          status: kind,
          submittedAt,
          decidedBy: kind === "approved" || kind === "paid" || kind === "rejected" ? approver : null,
          decidedAt: kind === "approved" || kind === "paid" ? decidedAt : null,
          comment: kind === "rejected" ? (r.rejectionReason ?? null) : null,
          paidAt: kind === "paid" ? (decidedAt ?? submittedAt) : null,
          autotaskId: it.id,
          autotaskSyncedAt: now,
          updatedAt: now,
        };
        // new here, and the same day, amount and person as something typed in the portal: reported
        if (!itemRow.has(it.id) && own.has(`${userId}|${values.date}|${amount}`) && possible.length < 30) possible.push(`${values.date} · ${(amount / 100).toFixed(2)} $ · ${values.description || "—"}`);
        await tx.insert(schema.expenses).values(values).onConflictDoUpdate({ target: schema.expenses.autotaskId, set: values });
        importedItems++;
      }
    });
    importedReports++;
    byStatus[kind] = (byStatus[kind] ?? 0) + 1;
  }
  return {
    counts: { reports: importedReports, items: importedItems, noAccount, keptPortal, possibleDuplicates: possible.length, ...Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [`status_${k}`, v])) },
    lists: possible.length ? { possibleDuplicates: possible } : undefined,
  };
}
/** A category label without the "(Mileage)"-style leftovers the picklist may carry */
const categoryClean = (s?: string) => s?.replace(/\s+/g, " ").trim() || null;

// ── Time sheets, as CSV files ──
/** CSV for a French Excel (the UTF-8 mark is added when downloaded): ";" between cells, "," for decimals, text always quoted, nothing read as a formula */
function csv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    if (typeof v === "number") return String(Math.round(v * 10_000) / 10_000).replace(".", ",");
    const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}
const mondayOf = (d: string) => {
  const date = new Date(`${d}T12:00:00Z`);
  return addDays(d, -((date.getUTCDay() + 6) % 7));
};

type AtTime = {
  id: number;
  resourceID?: number | null;
  ticketID?: number | null;
  taskID?: number | null;
  dateWorked?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  hoursWorked?: number | null;
  hoursToBill?: number | null;
  offsetHours?: number | null;
  isNonBillable?: boolean | null;
  billingCodeID?: number | null;
  contractID?: number | null;
  summaryNotes?: string | null;
  internalNotes?: string | null;
  billingApprovalDateTime?: string | null;
};

async function exportTimesheets(since: string, actorId: string) {
  if (!(await autotaskLinked())) return { skipped: true, note: "not_linked" };
  const at = await autotask();
  const fields = await atSafeFields(at, "TimeEntries", [
    "id", "resourceID", "ticketID", "taskID", "dateWorked", "startDateTime", "endDateTime", "hoursWorked", "hoursToBill", "offsetHours", "isNonBillable", "billingCodeID", "contractID", "summaryNotes", "internalNotes", "billingApprovalDateTime",
  ]);
  const entries = (await at.query<AtTime>("TimeEntries", [{ op: "gte", field: "dateWorked", value: `${since}T00:00:00.000Z` }] as never, { fields, max: 100_000, complete: true })).sort((a, b) =>
    (a.dateWorked ?? "").localeCompare(b.dateWorked ?? "") || a.id - b.id,
  );

  // names: technicians (the inactive ones too), tickets, work types
  const resources = new Map((await listResources().catch(() => [])).map((r) => [r.id, r.name]));
  const lost = [...new Set(entries.map((e) => e.resourceID).filter((x): x is number => Boolean(x) && !resources.has(x as number)))];
  for (const part of atChunks(lost, 200)) {
    const rows = await at.query<{ id: number; firstName?: string; lastName?: string }>("Resources", [{ op: "in", field: "id", value: part }] as never, { fields: ["id", "firstName", "lastName"] }).catch(() => []);
    for (const r of rows) resources.set(r.id, [r.firstName, r.lastName].filter(Boolean).join(" ") || `#${r.id}`);
  }
  const tickets = new Map<number, { number: string; title: string }>();
  for (const part of atChunks([...new Set(entries.map((e) => e.ticketID).filter((x): x is number => Boolean(x)))], 200)) {
    const rows = await at.query<{ id: number; ticketNumber: string; title: string }>("Tickets", [{ op: "in", field: "id", value: part }] as never, { fields: ["id", "ticketNumber", "title"] }).catch(() => []);
    for (const r of rows) tickets.set(r.id, { number: r.ticketNumber, title: r.title });
  }
  const workTypes = new Map<number, string>();
  for (const part of atChunks([...new Set(entries.map((e) => e.billingCodeID).filter((x): x is number => Boolean(x)))], 200)) {
    const rows = await at.query<{ id: number; name: string }>("BillingCodes", [{ op: "in", field: "id", value: part }] as never, { fields: ["id", "name"] }).catch(() => []);
    for (const r of rows) workTypes.set(r.id, r.name);
  }

  const who = (id?: number | null) => (id ? (resources.get(id) ?? `#${id}`) : "");
  const worked = (e: AtTime) => e.hoursWorked ?? 0;
  const detail: (string | number | null)[][] = [
    ["Semaine (lundi)", "Technicien", "Date", "Début", "Fin", "Heures travaillées", "Heures à facturer", "Décalage (h)", "Facturable", "Billet", "Titre du billet", "Tâche", "Type de travail", "Contrat (id Autotask)", "Résumé", "Note interne", "Approbation de facturation", "Approuvé le"],
  ];
  type Week = { week: string; resource: string; entries: number; hours: number; billable: number; nonBillable: number; approved: number };
  const weeks = new Map<string, Week>();
  for (const e of entries) {
    const date = day(e.dateWorked) ?? day(e.startDateTime) ?? since;
    const week = mondayOf(date);
    const tk = e.ticketID ? tickets.get(e.ticketID) : null;
    const approved = Boolean(e.billingApprovalDateTime);
    detail.push([
      week,
      who(e.resourceID),
      date,
      e.startDateTime ? e.startDateTime.slice(11, 16) : null,
      e.endDateTime ? e.endDateTime.slice(11, 16) : null,
      worked(e),
      e.hoursToBill ?? null,
      e.offsetHours ?? null,
      e.isNonBillable ? "non" : "oui",
      tk?.number ?? (e.ticketID ? `#${e.ticketID}` : ""),
      tk?.title ?? "",
      e.taskID ? `#${e.taskID}` : "",
      e.billingCodeID ? (workTypes.get(e.billingCodeID) ?? `#${e.billingCodeID}`) : "",
      e.contractID ? String(e.contractID) : "",
      (e.summaryNotes ?? "").trim(),
      (e.internalNotes ?? "").trim(),
      approved ? "approuvé" : "non approuvé",
      approved ? day(e.billingApprovalDateTime) : null,
    ]);
    const key = `${week}|${e.resourceID ?? 0}`;
    const w = weeks.get(key) ?? { week, resource: who(e.resourceID), entries: 0, hours: 0, billable: 0, nonBillable: 0, approved: 0 };
    w.entries++;
    w.hours += worked(e);
    if (e.isNonBillable) w.nonBillable += worked(e);
    else w.billable += worked(e);
    if (approved) w.approved++;
    weeks.set(key, w);
  }
  const summary: (string | number | null)[][] = [["Semaine (lundi)", "Technicien", "Entrées", "Heures", "Heures facturables", "Heures non facturables", "Entrées approuvées (facturation)", "Statut"]];
  for (const w of [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week) || a.resource.localeCompare(b.resource))) {
    summary.push([w.week, w.resource, w.entries, w.hours, w.billable, w.nonBillable, w.approved, w.approved === w.entries ? "approuvé" : w.approved === 0 ? "non approuvé" : "partiellement approuvé"]);
  }

  // the latest files replace the earlier ones
  const stamp = new Date().toISOString().slice(0, 10);
  const files: [string, string, string, number][] = [
    ["timesheets-detail", `feuilles-de-temps-detail-${since}-au-${stamp}.csv`, csv(detail), detail.length - 1],
    ["timesheets-weeks", `feuilles-de-temps-semaines-${since}-au-${stamp}.csv`, csv(summary), summary.length - 1],
  ];
  await db().transaction(async (tx) => {
    await tx.delete(schema.autotaskExports).where(and(inArray(schema.autotaskExports.kind, files.map((f) => f[0]))));
    for (const [kind, filename, content, rows] of files) await tx.insert(schema.autotaskExports).values({ kind, filename, since, content, rows, createdBy: actorId });
  });
  return {
    counts: { entries: detail.length - 1, weeks: summary.length - 1 },
    note: "Autotask ne donne pas l'état des feuilles de temps par son API : le statut est l'approbation de facturation de chaque entrée.",
  };
}

/** A kept file, to download */
export async function exportFile(id: string) {
  const [f] = await db().select().from(schema.autotaskExports).where(eq(schema.autotaskExports.id, id));
  return f ?? null;
}
