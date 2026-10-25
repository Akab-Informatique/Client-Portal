import path from "node:path";
import PDFDocument from "pdfkit";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings } from "./billing.ts";
import { taxesOfLines } from "../../shared/invoiceTax.ts";

/**
 * The PDF copy of an invoice, drawn like the sheet of Admin › Facturation › Modèle de facture: the logo in its pill, the
 * company and the boxed date, the bill-to box, the ruled table of lines, the totals with the payment instructions
 * beside them, the conditions at the foot and a page number. Letter size, built-in fonts (no file to install).
 */
const LOGO = path.join(import.meta.dirname, "..", "assets", "akab-logo-pill.png");
const LEFT = 48;
const RIGHT = 564;
const BOTTOM = 742;

const dmy = (ymd: string) => {
  const [y, m, d] = ymd.split("-");
  return y && m && d ? `${d}/${m}/${y}` : ymd;
};

type Line = { date: string | null; description: string; contractName: string | null; kind: string; quantity: number; unitPriceCents: number; amountCents: number };

const text = {
  fr: { date: "Date", billTo: "Facturer à", invoiceNo: "# facture", terms: "Modalités", net: (d: number) => `Net ${d} jours`, receipt: "Payable sur réception", dueOn: "Paiement dû", lineDate: "Date", description: "Description", hours: "Heures facturables", quantity: "Quantité", rate: "Taux", amount: "Montant facturable", contract: (n: string) => `contrat : ${n}`, totalHours: "Total des heures facturables", totalBilled: "Montant total à facturer", taxes: "Total Taxes", exempt: "Client exempté de taxes", grandTotal: "Grand Total", payOnline: "Payer en ligne", paid: "PAYÉE" },
  en: { date: "Date", billTo: "Bill to", invoiceNo: "# invoice", terms: "Terms", net: (d: number) => `Net ${d} days`, receipt: "Due on receipt", dueOn: "Payment due", lineDate: "Date", description: "Description", hours: "Billable hours", quantity: "Quantity", rate: "Rate", amount: "Billable amount", contract: (n: string) => `contract: ${n}`, totalHours: "Total billable hours", totalBilled: "Total amount to bill", taxes: "Total Taxes", exempt: "Client exempt from taxes", grandTotal: "Grand Total", payOnline: "Pay online", paid: "PAID" },
} as const;

export type InvoicePdf = { filename: string; content: Buffer };

/** The invoice as a PDF file, ready to attach. `payUrl` adds a "Pay online" link. */
export async function invoicePdf(invoiceId: string, payUrl: string | null = null): Promise<InvoicePdf | null> {
  const d = db();
  const [inv] = await d.select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, invoiceId));
  if (!inv) return null;
  const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, inv.clientId));
  const s = await billingSettings();
  const T = text[s.template.language === "en" ? "en" : "fr"];
  const lng = s.template.language === "en" ? "en-CA" : "fr-CA";
  const money = (cents: number) => new Intl.NumberFormat(lng, { style: "currency", currency: "CAD" }).format(cents / 100);

  const rows = await d
    .select({ l: schema.invoiceLines, date: schema.billingItems.date, contract: schema.billingItems.contractName })
    .from(schema.invoiceLines)
    .leftJoin(schema.billingItems, eq(schema.billingItems.id, schema.invoiceLines.billingItemId))
    .where(eq(schema.invoiceLines.invoiceId, inv.id))
    .orderBy(asc(schema.invoiceLines.position));
  const subtotal = inv.totalCents - inv.taxCents;
  const lines: Line[] = rows.length
    ? rows.map(({ l, date, contract }) => ({ date: date ?? null, description: l.description, contractName: contract ?? null, kind: l.kind, quantity: l.quantityX100 / 100, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents }))
    : [{ date: inv.issuedOn, description: `Facture ${inv.number}`, contractName: null, kind: "other", quantity: 1, unitPriceCents: subtotal, amountCents: subtotal }];
  const gstRate = s.taxes.gstRate;
  const qstRate = s.taxes.qstRate;
  // line by line, as when the invoice was made; when that does not give the stored tax (an older invoice), the stored tax is split by the rates
  const byLine = taxesOfLines(rows.length ? rows.filter(({ l }) => l.taxable).map(({ l }) => l.amountCents) : [subtotal], gstRate, qstRate);
  const exactSplit = inv.taxCents > 0 && byLine.gst + byLine.qst === inv.taxCents;
  const gst = exactSplit ? byLine.gst : inv.taxCents ? Math.round((inv.taxCents * gstRate) / (gstRate + qstRate)) : 0;
  const qst = inv.taxCents - gst;
  const hours = lines.filter((l) => l.kind === "labour").reduce((n, l) => n + l.quantity, 0);
  const termsDays = client?.invoice?.termsDays ?? s.template.termsDays;

  const doc = new PDFDocument({ size: "LETTER", margins: { top: 40, bottom: 40, left: LEFT, right: 612 - RIGHT }, bufferPages: true, info: { Title: `${T.invoiceNo} ${inv.number}`, Author: s.company.legalName || "AKAB Informatique" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // the built-in font only knows Windows-1252: an arrow or any other symbol outside it would print as "!" — the arrow becomes a dash, the rest is dropped
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
  const rawWidth = doc.widthOfString.bind(doc);
  doc.widthOfString = (t: string, o?: PDFKit.Mixins.TextOptions) => rawWidth(clean(t), o);

  const font = (bold = false, size = 8) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000000");

  // ── page 1: the logo, the company, the boxed date
  doc.image(LOGO, LEFT, 40, { width: 190 });
  let y = 118;
  font();
  const companyLines = [s.company.legalName || "AKAB Informatique", ...s.company.address.split("\n"), s.company.phone, s.company.email].filter(Boolean);
  for (const t of companyLines) {
    doc.text(t, LEFT, y, { width: 260 });
    y += 10.5;
  }
  doc.lineWidth(0.7).strokeColor("#000000").rect(RIGHT - 96, 118, 96, 40).stroke();
  font(true).text(T.date, RIGHT - 96, 124, { width: 96, align: "center" });
  font().text(dmy(inv.issuedOn), RIGHT - 96, 142, { width: 96, align: "center" });

  // ── the bill-to box and the invoice figures
  const boxY = 176;
  doc.rect(LEFT, boxY, 220, 62).stroke();
  doc.moveTo(LEFT, boxY + 15).lineTo(LEFT + 220, boxY + 15).stroke();
  font(true).text(T.billTo, LEFT + 6, boxY + 4);
  font();
  const place = [client?.city, client?.province].filter(Boolean).join(", ");
  const billTo = [client?.name ?? "", client?.address ?? "", [place, client?.postalCode].filter(Boolean).join(" "), "Canada"].filter(Boolean);
  let by = boxY + 21;
  for (const t of billTo.slice(0, 5)) {
    doc.text(t, LEFT + 6, by, { width: 208, height: 10, ellipsis: true });
    by += 10;
  }
  const info: [string, string][] = [
    [T.invoiceNo, inv.number],
    [T.terms, termsDays === 0 ? T.receipt : T.net(termsDays)],
    [T.dueOn, inv.dueOn ? dmy(inv.dueOn) : "—"],
    ...(inv.poNumber ? ([["PO", inv.poNumber]] as [string, string][]) : []),
  ];
  let iy = boxY + 18;
  for (const [k, v] of info) {
    const label = `${k} : `;
    font(true);
    const lw = doc.widthOfString(label);
    font();
    const vw = doc.widthOfString(v);
    const x = RIGHT - lw - vw;
    font(true).text(label, x, iy, { lineBreak: false });
    font().text(v, x + lw, iy, { lineBreak: false });
    iy += 13;
  }

  // ── the table
  const cols = [
    { k: "date", w: 54, align: "left" as const },
    { k: "description", w: 210, align: "left" as const },
    { k: "hours", w: 62, align: "right" as const },
    { k: "quantity", w: 56, align: "right" as const },
    { k: "rate", w: 48, align: "right" as const },
    { k: "amount", w: 86, align: "right" as const },
  ];
  const header = () => {
    let x = LEFT;
    font(true);
    const h = 24;
    for (const c of cols) {
      doc.rect(x, y, c.w, h).stroke();
      const label = c.k === "date" ? T.lineDate : (T as unknown as Record<string, string>)[c.k];
      doc.text(label, x + 3, y + 4, { width: c.w - 6, align: c.align });
      x += c.w;
    }
    y += h;
    font();
  };
  y = Math.max(y, boxY + 62) + 14;
  header();
  for (const l of lines) {
    const desc = `${l.description}${l.contractName ? `\n${T.contract(l.contractName)}` : ""}`;
    font();
    const h = Math.max(16, doc.heightOfString(desc, { width: cols[1].w - 6 }) + 8);
    if (y + h > BOTTOM - 20) {
      doc.addPage();
      y = 40;
      header();
    }
    const cells = [l.date ? dmy(l.date) : "", desc, l.kind === "labour" ? l.quantity.toFixed(2) : "", l.quantity.toFixed(2), (l.unitPriceCents / 100).toFixed(2), (l.amountCents / 100).toFixed(2)];
    let x = LEFT;
    cols.forEach((c, i) => {
      doc.rect(x, y, c.w, h).stroke();
      doc.text(cells[i], x + 3, y + 4, { width: c.w - 6, align: c.align });
      x += c.w;
    });
    y += h;
  }

  // ── payment instructions on the left, totals on the right
  y += 12;
  const need = 150;
  if (y + need > BOTTOM) {
    doc.addPage();
    y = 40;
  }
  const top = y;
  font().fillColor("#666666").text("=".repeat(38), LEFT, y);
  font();
  let ly = y + 12;
  const instructions = s.template.paymentInstructions.trim();
  if (instructions) {
    doc.text(instructions, LEFT, ly, { width: 270, lineGap: 1 });
    ly = doc.y + 6;
  }
  const taxNumbers = [s.taxes.gstNumber && `TPS: ${s.taxes.gstNumber}`, s.taxes.qstNumber && `TVQ: ${s.taxes.qstNumber}`].filter(Boolean).join("     ");
  if (taxNumbers) {
    doc.text(taxNumbers, LEFT, ly, { width: 270 });
    ly = doc.y + 6;
  }
  if (payUrl) {
    font(true, 9).fillColor("#0a0a0b").text(T.payOnline, LEFT, ly, { link: payUrl, underline: true });
    ly = doc.y + 6;
  }

  const tx = 330;
  const tw = RIGHT - tx;
  let ty = top;
  const pair = (label: string, value: string, bold = true, indent = 0, size = 8) => {
    font(bold, size).text(label, tx + indent, ty, { width: tw - indent - 80, lineBreak: false });
    font(false, size).text(value, tx, ty, { width: tw, align: "right", lineBreak: false });
    ty += size + 6;
  };
  pair(T.totalHours, hours.toFixed(4));
  pair(T.totalBilled, money(subtotal));
  ty += 4;
  font(true).text(T.taxes, tx, ty);
  ty += 14;
  if (inv.taxCents === 0) {
    font().text(T.exempt, tx, ty);
    ty += 12;
  } else {
    pair(`TPS (${gstRate} %)`, money(gst), false, 12);
    pair(`TVQ (${qstRate} %)`, money(qst), false, 12);
  }
  ty += 6;
  font(true, 12).text(T.grandTotal, tx, ty, { width: 140, lineBreak: false });
  font(true, 12).text(money(inv.totalCents), tx, ty, { width: tw, align: "right", lineBreak: false });
  ty += 22;

  // ── the notes and the conditions
  y = Math.max(ly, ty) + 10;
  const foot = s.template.footer.trim();
  const notes = inv.notes?.trim();
  const blocks: { text: string; size: number; color: string; rule: boolean }[] = [];
  if (notes) blocks.push({ text: notes, size: 8, color: "#000000", rule: false });
  if (foot) blocks.push({ text: foot, size: 7.5, color: "#222222", rule: true });
  for (const b of blocks) {
    font(false, b.size);
    const h = doc.heightOfString(b.text, { width: RIGHT - LEFT, lineGap: 1 });
    if (y + h + 10 > BOTTOM) {
      doc.addPage();
      y = 40;
    }
    if (b.rule) {
      doc.lineWidth(0.5).strokeColor("#999999").moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
      y += 6;
    }
    doc.fillColor(b.color).text(b.text, LEFT, y, { width: RIGHT - LEFT, lineGap: 1 });
    y = doc.y + 10;
  }

  // ── page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // writing under the bottom margin would make pdfkit add a blank page
    doc.page.margins.bottom = 0;
    font(false, 9).fillColor("#000000").text(String(i + 1), LEFT, 758, { width: RIGHT - LEFT, align: "center", lineBreak: false });
  }
  doc.end();
  return { filename: `Facture_${inv.number}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_"), content: await done };
}
