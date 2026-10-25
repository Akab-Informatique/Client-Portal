import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { mailSettings } from "./invoiceMail.ts";
import { escapeHtml, sendMail } from "./mail.ts";
import { expenseReportPdf, timesheetPdf, type Pdf } from "./timePdf.ts";

/**
 * What happens when a timesheet week or an expense report is sent: for now nothing is approved by hand (`autoApprove`,
 * on) and accounting gets a one-page PDF of it by email (`recipients`; none set: the invoicing address of Admin ›
 * Facturation › Courriels). Both are set in Admin › PSA › Temps et dépenses.
 */
const PROVIDER = "time.reports";
export type TimeReportSettings = {
  /** A week or report is approved as soon as it is sent (no approver) */
  autoApprove: boolean;
  /** Who gets the PDF (emails); none: the accounting address */
  recipients: string[];
};
export const DEFAULT_TIME_REPORTS: TimeReportSettings = { autoApprove: true, recipients: [] };

export async function timeReportSettings(): Promise<TimeReportSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  const c = (row?.config ?? {}) as Partial<TimeReportSettings>;
  return { autoApprove: c.autoApprove ?? DEFAULT_TIME_REPORTS.autoApprove, recipients: Array.isArray(c.recipients) ? c.recipients.filter((e) => typeof e === "string" && e.includes("@")) : [] };
}
export async function saveTimeReportSettings(p: Partial<TimeReportSettings>): Promise<TimeReportSettings> {
  const next = { ...(await timeReportSettings()), ...p };
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, enabled: true, config: next })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: next, updatedAt: new Date() } });
  return next;
}

/** Who the PDF goes to: the addresses set, else the accounting address. */
async function toWhom(): Promise<string[]> {
  const s = await timeReportSettings();
  if (s.recipients.length) return s.recipients;
  return [(await mailSettings()).fromEmail].filter(Boolean);
}

async function send(subject: string, lines: string[], pdf: Pdf, actorId: string, entity: string, id: string) {
  const to = await toWhom();
  const text = lines.join("\n");
  const html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  let sent = 0;
  for (const address of to) {
    if (await sendMail({ to: address, subject, text, html, attachments: [{ filename: pdf.filename, content: pdf.content, contentType: "application/pdf" }] })) sent++;
  }
  await audit(actorId, sent ? "time.report_sent" : "time.report_send_failed", id, { entity, to, sent });
  return sent;
}

/** The expense report as a PDF to accounting. Never throws: sending a report must not fail because the email did. */
export async function mailExpenseReport(reportId: string, actorId: string): Promise<number> {
  try {
    const pdf = await expenseReportPdf(reportId);
    if (!pdf) return 0;
    const [rep] = await db().select().from(schema.expenseReports).where(eq(schema.expenseReports.id, reportId));
    const [who] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, rep.userId));
    return await send(`Rapport de dépenses — ${who?.name ?? ""} — ${rep.title}`, [`Rapport de dépenses de ${who?.name ?? ""} : ${rep.title}.`, "Le total à rembourser est en haut du PDF ci-joint."], pdf, actorId, "expense_report", reportId);
  } catch (e) {
    console.warn("[time reports] expense report not sent:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** The week's timesheet as a PDF to accounting. Never throws. */
export async function mailTimesheet(userId: string, weekStart: string, actorId: string, sheetId: string): Promise<number> {
  try {
    const pdf = await timesheetPdf(userId, weekStart);
    if (!pdf) return 0;
    const [who] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
    return await send(`Feuille de temps — ${who?.name ?? ""} — semaine du ${weekStart}`, [`Feuille de temps de ${who?.name ?? ""} pour la semaine du ${weekStart}.`, "Les heures à payer sont en haut du PDF ci-joint."], pdf, actorId, "timesheet", sheetId);
  } catch (e) {
    console.warn("[time reports] timesheet not sent:", e instanceof Error ? e.message : e);
    return 0;
  }
}
