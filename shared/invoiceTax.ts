/**
 * GST and QST of an invoice, worked out **line by line** and added up: each taxable line's tax is rounded to the cent
 * on its own (half up), the way QuickBooks Online does it, so the invoice, its PDF and QuickBooks show the same cents.
 * (Taken once on the total, 1 035,16 $ of lines gave a QST of 103,26 $ where QuickBooks says 103,27 $.)
 * Rates are percentages (5, 9.975); the work is in whole cents and thousandths of a percent, no floating point drift.
 */
const milli = (rate: number) => Math.round(rate * 1000);
const lineTax = (cents: number, rate: number) => Math.round((cents * milli(rate)) / 100_000);

export function taxesOfLines(taxableLinesCents: number[], gstRate: number, qstRate: number): { gst: number; qst: number } {
  let gst = 0;
  let qst = 0;
  for (const c of taxableLinesCents) {
    gst += lineTax(c, gstRate);
    qst += lineTax(c, qstRate);
  }
  return { gst, qst };
}
