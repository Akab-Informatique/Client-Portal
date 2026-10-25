import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { mailSettings } from "./invoiceMail.ts";
import { sendMail } from "./mail.ts";
import { expenseReportModel, renderHtml, renderPdf, renderText, timesheetModel, type Model } from "./timePdf.ts";

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

/** The report in the body of the email (figures and tables) and as a PDF attachment. */
async function send(subject: string, model: Model, actorId: string, entity: string, id: string) {
  const to = await toWhom();
  const pdf = await renderPdf(model);
  const text = renderText(model);
  const html = renderHtml(model);
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
    const model = await expenseReportModel(reportId);
    if (!model) return 0;
    return await send(`Rapport de dépenses — ${model.employee} — ${model.lines[0] ?? ""}`, model, actorId, "expense_report", reportId);
  } catch (e) {
    console.warn("[time reports] expense report not sent:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** The week's timesheet as a PDF to accounting. Never throws. */
export async function mailTimesheet(userId: string, weekStart: string, actorId: string, sheetId: string): Promise<number> {
  try {
    const model = await timesheetModel(userId, weekStart);
    if (!model) return 0;
    return await send(`Feuille de temps — ${model.employee} — semaine du ${weekStart}`, model, actorId, "timesheet", sheetId);
  } catch (e) {
    console.warn("[time reports] timesheet not sent:", e instanceof Error ? e.message : e);
    return 0;
  }
}
