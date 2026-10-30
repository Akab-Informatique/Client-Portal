import path from "node:path";
import PDFDocument from "pdfkit";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { isMileageUnit } from "../../shared/mileage.ts";
import { weekEntries, addDays } from "./timesheets.ts";
import { balances, moneyOf, weekPay } from "./hr.ts";

/**
 * The one-page reports accounting gets when a timesheet or an expense report is sent: the figures to pay come first, big
 * and plain (what to pay back, the kilometres, the total), the details under them. Letter size, built-in fonts.
 */
const LOGO = path.join(import.meta.dirname, "..", "assets", "akab-logo-pill.png");
const LEFT = 48;
const RIGHT = 564;
const BOTTOM = 730;

export type Pdf = { filename: string; content: Buffer };

const dmy = (ymd: string) => {
  const [y, m, d] = ymd.split("-");
  return y && m && d ? `${d}/${m}/${y}` : ymd;
};
const cad = (cents: number) => new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
const num = (n: number) => n.toLocaleString("fr-CA", { maximumFractionDigits: 2 });
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "rapport";

/** A document with the page furniture: the logo, a title, who and when, and a page number at the foot. */
function start(title: string, employee: string, lines: string[]) {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 40, bottom: 40, left: LEFT, right: 612 - RIGHT }, bufferPages: true, info: { Title: title, Author: "AKAB Informatique" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  // the built-in font only knows Windows-1252: an arrow becomes a dash, anything else outside it is dropped
  const WIN = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
  const clean = (v: string) =>
    v
      .replace(/\s*[→➜➔⟶]\s*/g, " – ")
      .split("")
      .filter((ch) => ch.charCodeAt(0) < 256 || WIN.has(ch))
      .join("");
  const rawText = doc.text.bind(doc) as (...a: unknown[]) => PDFKit.PDFDocument;
  (doc as unknown as { text: (...a: unknown[]) => unknown }).text = (t: unknown, ...rest: unknown[]) => rawText(typeof t === "string" ? clean(t) : t, ...rest);
  const rawHeight = doc.heightOfString.bind(doc);
  doc.heightOfString = (t: string, o?: PDFKit.Mixins.TextOptions) => rawHeight(clean(t), o);
  const font = (bold = false, size = 9, color = "#000000") => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);

  doc.image(LOGO, LEFT, 40, { width: 130 });
  font(true, 18).text(title, LEFT, 40, { width: RIGHT - LEFT, align: "right" });
  let y = 66;
  font(false, 10, "#444444");
  for (const l of lines) {
    doc.text(l, LEFT, y, { width: RIGHT - LEFT, align: "right" });
    y += 13;
  }
  // the employee, boxed and big: accounting reads the name first
  y = Math.max(y, 96) + 4;
  doc.lineWidth(1.5).strokeColor("#000000").rect(LEFT, y, RIGHT - LEFT, 44).fillAndStroke("#f3f3f3", "#000000");
  font(false, 8.5, "#555555").text("EMPLOYÉ", LEFT + 12, y + 7, { width: 200 });
  font(true, 20).text(employee || "—", LEFT + 12, y + 18, { width: RIGHT - LEFT - 24, lineBreak: false, ellipsis: true });
  return { doc, font, done, employee, y: y + 44 + 14 };
}

/** The big figures, side by side: label small on top, the number large. The last one is the one to pay. */
function figures(doc: PDFKit.PDFDocument, font: ReturnType<typeof start>["font"], y: number, items: { label: string; value: string; strong?: boolean }[]) {
  const gap = 8;
  const w = (RIGHT - LEFT - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = LEFT + i * (w + gap);
    doc.lineWidth(it.strong ? 2 : 0.8).strokeColor(it.strong ? "#000000" : "#888888").rect(x, y, w, 58).stroke();
    font(false, 8.5, "#555555").text(it.label.toUpperCase(), x + 8, y + 8, { width: w - 16 });
    font(true, it.strong ? 20 : 17).text(it.value, x + 8, y + 26, { width: w - 16 });
  });
  return y + 58 + 18;
}

type Col = { w: number; align?: "left" | "right" };
/** A ruled table: header row, then rows; breaks to a new page (with the header again) when full. */
function table(doc: PDFKit.PDFDocument, font: ReturnType<typeof start>["font"], y: number, head: string[], cols: Col[], rows: string[][], opts: { bold?: (r: number) => boolean } = {}) {
  const draw = (cells: string[], at: number, bold: boolean, size: number, fill?: string) => {
    let x = LEFT;
    let h = 0;
    font(bold, size);
    cells.forEach((c, i) => {
      h = Math.max(h, doc.heightOfString(c, { width: cols[i].w - 6 }));
    });
    if (fill) doc.rect(LEFT, at - 2, RIGHT - LEFT, h + 5).fill(fill);
    font(bold, size);
    cells.forEach((c, i) => {
      doc.text(c, x + 3, at, { width: cols[i].w - 6, align: cols[i].align ?? "left" });
      x += cols[i].w;
    });
    return h + 5;
  };
  const header = (at: number) => {
    const h = draw(head, at, true, 8.5, "#eeeeee");
    doc.lineWidth(0.6).strokeColor("#000000").moveTo(LEFT, at + h - 2).lineTo(RIGHT, at + h - 2).stroke();
    return at + h + 1;
  };
  y = header(y);
  rows.forEach((r, i) => {
    const probe = Math.max(...r.map((c, k) => doc.heightOfString(c, { width: cols[k].w - 6 }))) + 5;
    if (y + probe > BOTTOM) {
      doc.addPage();
      y = header(40);
    }
    y += draw(r, y, opts.bold?.(i) ?? false, 8.5);
    doc.lineWidth(0.3).strokeColor("#cccccc").moveTo(LEFT, y - 2).lineTo(RIGHT, y - 2).stroke();
  });
  return y + 10;
}

/** A small heading above a block. */
function heading(doc: PDFKit.PDFDocument, font: ReturnType<typeof start>["font"], y: number, t: string) {
  if (y > BOTTOM - 60) {
    doc.addPage();
    y = 40;
  }
  font(true, 11).text(t, LEFT, y, { width: RIGHT - LEFT });
  return y + 17;
}

async function finish(doc: PDFKit.PDFDocument, font: ReturnType<typeof start>["font"], done: Promise<Buffer>, employee: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    // the name on every page, so a loose page is never anonymous
    font(true, 8, "#333333").text(employee, LEFT, 752, { width: 300, lineBreak: false });
    font(false, 8, "#777777").text(`${i + 1} / ${range.count}`, LEFT, 752, { width: RIGHT - LEFT, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

/**
 * A report as data — the same figures and tables feed the PDF and the email body, so they never differ.
 */
export type Model = {
  /** The document title ("Rapport de dépenses") and the file name */
  title: string;
  filename: string;
  employee: string;
  /** Small lines under the title: the report, the period, when it was sent */
  lines: string[];
  figures: { label: string; value: string; strong?: boolean }[];
  /** A sentence under the figures, when there is something more to say */
  note?: string;
  sections: { heading: string; head: string[]; cols: Col[]; rows: string[][]; boldLast?: boolean }[];
};

/** An expense report: what to pay back to the person, the kilometres and what they come to, by classification, then every line. */
export async function expenseReportModel(reportId: string): Promise<Model | null> {
  const d = db();
  const [rep] = await d.select().from(schema.expenseReports).where(eq(schema.expenseReports.id, reportId));
  if (!rep) return null;
  const [who] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, rep.userId));
  const rows = await d
    .select({ x: schema.expenses, type: schema.expenseTypes.name, unit: schema.expenseTypes.unit, client: schema.clients.name })
    .from(schema.expenses)
    .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
    .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
    .where(and(eq(schema.expenses.reportId, rep.id)))
    .orderBy(asc(schema.expenses.date), asc(schema.expenses.createdAt));
  const items = rows.map((r) => ({ ...r.x, type: r.type, mileage: isMileageUnit(r.unit), clientName: r.client }));
  const kmItems = items.filter((i) => i.mileage);
  const otherItems = items.filter((i) => !i.mileage);
  const km = kmItems.reduce((n, i) => n + i.quantityX100, 0) / 100;
  const kmCents = kmItems.reduce((n, i) => n + i.amountCents, 0);
  const otherCents = otherItems.reduce((n, i) => n + i.amountCents, 0);
  const total = otherCents + kmCents;
  const dates = items.map((i) => i.date).sort();
  const period = rep.periodStart && rep.periodEnd ? `${dmy(rep.periodStart)} – ${dmy(rep.periodEnd)}` : dates.length ? `${dmy(dates[0])} – ${dmy(dates.at(-1)!)}` : "";

  const groups = new Map<string, { mileage: boolean; count: number; qty: number; cents: number; rate: number }>();
  for (const i of items) {
    const g = groups.get(i.type) ?? { mileage: i.mileage, count: 0, qty: 0, cents: 0, rate: i.unitPriceCents };
    g.count += 1;
    g.qty += i.quantityX100 / 100;
    g.cents += i.amountCents;
    groups.set(i.type, g);
  }
  return {
    title: "Rapport de dépenses",
    filename: `Depenses_${slug(who?.name ?? "")}_${slug(rep.title)}.pdf`,
    employee: who?.name ?? "",
    lines: [rep.title, period, rep.submittedAt ? `Envoyé le ${dmy(rep.submittedAt.toISOString().slice(0, 10))}` : ""].filter(Boolean),
    figures: [
      { label: "Dépenses (hors km)", value: cad(otherCents) },
      { label: "Kilométrage", value: `${num(km)} km` },
      { label: "Kilométrage en $", value: cad(kmCents) },
      { label: "Total à rembourser", value: cad(total), strong: true },
    ],
    sections: [
      {
        heading: "Par classification",
        head: ["Classification", "Lignes", "Détail", "Montant"],
        cols: [{ w: 230 }, { w: 60, align: "right" }, { w: 120, align: "right" }, { w: 106, align: "right" }],
        rows: [...groups.entries()].map(([name, g]) => [name, String(g.count), g.mileage ? `${num(g.qty)} km × ${cad(g.rate)}/km` : "", cad(g.cents)]).concat([["Total", String(items.length), "", cad(total)]]),
        boldLast: true,
      },
      {
        heading: "Détail des dépenses",
        head: ["Date", "Description", "Classification", "Client", "Montant"],
        cols: [{ w: 54 }, { w: 190 }, { w: 96 }, { w: 90 }, { w: 86, align: "right" }],
        rows: items.map((i) => [dmy(i.date), i.description, i.type, i.clientName ?? "", i.mileage ? `${num(i.quantityX100 / 100)} km · ${cad(i.amountCents)}` : cad(i.amountCents)]),
      },
    ],
  };
}

/**
 * A week's timesheet, for accounting: the hours PAID first (work days less what is put in the hours bank, vacation, sick days,
 * holidays, hours paid out of the bank), what they come to, the 4 % put aside for vacation, the accounts, then day by day (types
 * and hours only: no ticket, no note). Billable and non billable time are not in it: they are kept per client, shown nowhere yet.
 */
export async function timesheetModel(userId: string, weekStart: string): Promise<Model | null> {
  const d = db();
  const [who] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
  if (!who) return null;
  const [sheet] = await d.select().from(schema.timesheets).where(and(eq(schema.timesheets.userId, userId), eq(schema.timesheets.weekStart, weekStart)));
  const pay = await weekPay(userId, weekStart);
  const bal = await balances(userId);
  const entries = await weekEntries(userId, weekStart);
  const end = addDays(weekStart, 6);
  const wage = pay.wageCents;
  const money = (h: number) => (wage == null ? "—" : cad(moneyOf(Math.round(h * 100), wage)));
  const others = Math.round((pay.vacationHours + pay.sickHours + pay.holidayHours + pay.bankPaidHours) * 100) / 100;
  const warnings: string[] = [];
  if (bal.bankCents < 0) warnings.push(`la banque d'heures est négative (${cad(bal.bankCents)})`);
  if (bal.vacationCents < 0) warnings.push(`la banque de vacances est négative (${cad(bal.vacationCents)})`);
  if (bal.sickHoursX100 < 0) warnings.push(`les jours de maladie sont négatifs (${num(bal.sickHoursX100 / 100)} h)`);
  if (wage == null) warnings.push("aucun salaire horaire dans le dossier RH : les montants ne peuvent pas être calculés");

  const byDay = new Map<string, { paid: number; banked: number; parts: Map<string, number> }>();
  for (let i = 0; i < 7; i++) byDay.set(addDays(weekStart, i), { paid: 0, banked: 0, parts: new Map() });
  for (const r of entries) {
    const day = byDay.get(r.e.date);
    if (!day) continue;
    const h = r.e.hoursX100 / 100;
    if (r.kind === "workday") {
      day.paid += Math.max(0, r.e.hoursX100 - r.e.bankX100) / 100;
      day.banked += r.e.bankX100 / 100;
    } else if (["vacation", "sick", "holiday", "bankpay"].includes(r.kind)) day.paid += h;
    const label = r.kind === "workday" && r.e.startTime && r.e.endTime ? `${r.type} ${r.e.startTime}–${r.e.endTime}` : r.kind === "bankpay" ? `${r.type} (banque)` : r.type;
    day.parts.set(label, (day.parts.get(label) ?? 0) + h);
  }
  const loc = new Intl.DateTimeFormat("fr-CA", { weekday: "long", timeZone: "UTC" });
  const line = (label: string, h: number, amount?: string): string[] => [label, `${num(h)} h`, amount ?? money(h)];
  return {
    title: "Feuille de temps",
    filename: `Feuille_de_temps_${slug(who.name)}_${weekStart}.pdf`,
    employee: who.name,
    lines: [`Semaine du ${dmy(weekStart)} au ${dmy(end)}`, sheet?.submittedAt ? `Envoyée le ${dmy(sheet.submittedAt.toISOString().slice(0, 10))}` : ""].filter(Boolean),
    figures: [
      { label: "Journées de travail", value: `${num(pay.workdayHours)} h` },
      { label: "Mises en banque", value: `${num(pay.bankedHours)} h` },
      { label: "Congés et banque payée", value: `${num(others)} h` },
      { label: "Heures à payer", value: `${num(pay.paidHours)} h`, strong: true },
    ],
    ...(warnings.length ? { note: `À régler : ${warnings.join(" ; ")}.` } : {}),
    sections: [
      {
        heading: "Heures payées",
        head: ["Type", "Heures", "Montant"],
        cols: [{ w: 296 }, { w: 110, align: "right" }, { w: 110, align: "right" }],
        rows: [
          line("Journées de travail (moins les heures mises en banque)", pay.workdayPaidHours),
          line("Vacances", pay.vacationHours),
          line("Maladie", pay.sickHours),
          line("Jours fériés (1/20 des 4 dernières semaines)", pay.holidayHours, pay.holidayHours ? cad(pay.holidayCents) : money(0)),
          line("Paiement de banque d'heures", pay.bankPaidHours),
          ["Total à payer", `${num(pay.paidHours)} h`, pay.paidCents == null ? "—" : cad(pay.paidCents)],
        ],
        boldLast: true,
      },
      {
        heading: "Vacances et banques",
        head: ["", "Cette semaine", "Solde"],
        cols: [{ w: 296 }, { w: 110, align: "right" }, { w: 110, align: "right" }],
        rows: [
          ["Vacances accumulées (4 % du brut)", pay.vacationAccrualCents == null ? "—" : cad(pay.vacationAccrualCents), cad(bal.vacationCents)],
          ["Banque d'heures", pay.bankedHours || pay.bankPaidHours ? `${num(pay.bankedHours - pay.bankPaidHours)} h` : "", cad(bal.bankCents)],
          ["Jours de maladie", pay.sickHours ? `-${num(pay.sickHours)} h` : "", `${num(bal.sickHoursX100 / 100)} h`],
        ],
      },
      {
        heading: "Jour par jour",
        head: ["Jour", "Payées", "En banque", "Détail"],
        cols: [{ w: 110 }, { w: 60, align: "right" }, { w: 70, align: "right" }, { w: 276 }],
        rows: [...byDay.entries()]
          .filter(([, v]) => v.parts.size)
          .map(([date, v]) => [`${loc.format(new Date(`${date}T12:00:00Z`))} ${dmy(date)}`, `${num(v.paid)} h`, v.banked ? `${num(v.banked)} h` : "", [...v.parts.entries()].map(([k, h]) => `${k} ${num(h)} h`).join(" · ")]),
      },
    ],
  };
}

/** The model as a PDF file. */
export async function renderPdf(m: Model): Promise<Pdf> {
  const p = start(m.title, m.employee, m.lines);
  const { doc, font } = p;
  let y = figures(doc, font, p.y, m.figures);
  if (m.note) {
    font(false, 9, "#444444").text(m.note, LEFT, y - 8, { width: RIGHT - LEFT });
    y += 8;
  }
  for (const sec of m.sections) {
    y = heading(doc, font, y, sec.heading);
    y = table(doc, font, y, sec.head, sec.cols, sec.rows, sec.boldLast ? { bold: (r) => r === sec.rows.length - 1 } : {});
  }
  return { filename: m.filename, content: await finish(doc, font, p.done, m.employee) };
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The model as an email body: the employee, the big figures, the same tables (inline styles, as mail programs need). */
export function renderHtml(m: Model): string {
  const td = (v: string, right: boolean, bold: boolean, head = false) =>
    `<${head ? "th" : "td"} style="padding:5px 8px;border-bottom:1px solid ${head ? "#000" : "#ddd"};text-align:${right ? "right" : "left"};${bold || head ? "font-weight:bold;" : ""}${head ? "background:#eee;font-size:12px;" : "font-size:13px;"}">${esc(v)}</${head ? "th" : "td"}>`;
  const figs = m.figures
    .map((f) => `<td style="padding:10px 12px;border:${f.strong ? "2px solid #000" : "1px solid #999"};vertical-align:top;width:25%"><div style="font-size:11px;color:#555;text-transform:uppercase">${esc(f.label)}</div><div style="font-size:${f.strong ? 22 : 18}px;font-weight:bold">${esc(f.value)}</div></td>`)
    .join('<td style="width:6px"></td>');
  const sections = m.sections
    .map(
      (sec) =>
        `<h3 style="margin:22px 0 6px;font-size:15px">${esc(sec.heading)}</h3><table style="border-collapse:collapse;width:100%"><tr>${sec.head.map((h, i) => td(h, sec.cols[i].align === "right", true, true)).join("")}</tr>${sec.rows
          .map((r, ri) => `<tr>${r.map((v, i) => td(v, sec.cols[i].align === "right", Boolean(sec.boldLast) && ri === sec.rows.length - 1)).join("")}</tr>`)
          .join("")}</table>`,
    )
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#000;max-width:720px">
<h2 style="margin:0 0 4px;font-size:20px">${esc(m.title)}</h2>
<div style="font-size:13px;color:#444">${m.lines.map(esc).join(" · ")}</div>
<div style="margin:14px 0;padding:10px 14px;border:2px solid #000;background:#f3f3f3"><div style="font-size:11px;color:#555">EMPLOYÉ</div><div style="font-size:24px;font-weight:bold">${esc(m.employee || "—")}</div></div>
<table style="border-collapse:separate;width:100%"><tr>${figs}</tr></table>
${m.note ? `<p style="font-size:13px;color:#444">${esc(m.note)}</p>` : ""}
${sections}
<p style="margin-top:20px;font-size:12px;color:#666">Le même rapport est en pièce jointe (PDF).</p>
</div>`;
}

/** The model as plain text (the other half of the email). */
export function renderText(m: Model): string {
  const out = [m.title.toUpperCase(), `Employé : ${m.employee}`, ...m.lines, "", ...m.figures.map((f) => `${f.label} : ${f.value}`)];
  if (m.note) out.push(m.note);
  for (const sec of m.sections) out.push("", sec.heading.toUpperCase(), ...sec.rows.map((r) => r.filter(Boolean).join(" | ")));
  return out.join("\n");
}

/** Kept for the screens that open the PDF. */
export async function expenseReportPdf(reportId: string): Promise<Pdf | null> {
  const m = await expenseReportModel(reportId);
  return m ? renderPdf(m) : null;
}
export async function timesheetPdf(userId: string, weekStart: string): Promise<Pdf | null> {
  const m = await timesheetModel(userId, weekStart);
  return m ? renderPdf(m) : null;
}
