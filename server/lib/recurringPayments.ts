/**
 * Recurring payments (Accounting › Paiements fournisseurs › Paiements récurrents): rent, insurance, subscriptions,
 * payroll… Typed by hand or pasted from the spreadsheet the accounting follows them in, then counted as money out in
 * the cash forecast on the days they fall.
 */
export type Frequency = "weekly" | "monthly" | "yearly";

export type RecurringRow = {
  name: string;
  amountCents: number | null;
  frequency: Frequency;
  dayOfMonth: number | null;
  weekday: number | null;
  month: number | null;
  account: string | null;
  method: string | null;
  notes: string | null;
};

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** "1 234,56 $", "1234.56", "?" → cents, or null when there is no figure */
export function parseAmount(raw: string): number | null {
  const t = raw.replace(/[\s$ ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const FREQ: Record<string, Frequency> = { hebdomadaire: "weekly", hebdo: "weekly", semaine: "weekly", weekly: "weekly", mensuel: "monthly", monthly: "monthly", annuel: "yearly", annuelle: "yearly", yearly: "yearly" };

/**
 * Reads what is copied from the spreadsheet (tab separated when pasted from Excel, or ";" / "," from a CSV file):
 * Date de facture · Fournisseur · Montant · Compte · Payé par · Fréquence · Notes. A line with no day is the day of
 * the line above ("1er", "8ie", "20ie"); a line with no frequency is monthly; "Annuel" in the day column is a
 * yearly payment whose day is not known. Lines with no name, and the totals, are left out.
 */
export function parseSheet(text: string): { rows: RecurringRow[]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.some((l) => l.includes(";")) ? ";" : ",";
  const cells = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "").trim()));
  const head = cells.findIndex((r) => r.some((c) => strip(c) === "fournisseur"));
  const body = head >= 0 ? cells.slice(head + 1) : cells;
  // the columns of the header when there is one, else the order above
  const col = (name: string, fallback: number) => (head >= 0 ? cells[head].findIndex((c) => strip(c).startsWith(name)) : fallback);
  const at = { day: col("date", 0), name: col("fournisseur", 1), amount: col("montant", 2), account: col("compte", 3), method: col("paye", 4), freq: col("frequence", 5), notes: col("notes", 6) };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");

  const rows: RecurringRow[] = [];
  let skipped = 0;
  let day: number | null = null;
  for (const r of body) {
    const name = get(r, at.name);
    if (!name || /^total$/i.test(name) || name.startsWith("#")) {
      skipped++;
      continue;
    }
    const dayText = get(r, at.day);
    let frequency: Frequency = FREQ[strip(get(r, at.freq))] ?? "monthly";
    if (/^annuel/i.test(dayText)) {
      frequency = "yearly";
      day = null;
    } else if (/^\d{1,2}/.test(dayText)) {
      const n = Number(dayText.match(/^\d{1,2}/)![0]);
      day = n >= 1 && n <= 31 ? n : day;
    }
    rows.push({
      name: name.slice(0, 200),
      amountCents: parseAmount(get(r, at.amount)),
      frequency,
      dayOfMonth: frequency === "weekly" ? null : /^annuel/i.test(dayText) ? null : day,
      weekday: frequency === "weekly" ? 5 : null,
      month: null,
      account: get(r, at.account).slice(0, 80) || null,
      method: get(r, at.method).slice(0, 80) || null,
      notes: get(r, at.notes).slice(0, 1000) || null,
    });
  }
  return { rows, skipped };
}

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/** The days an item falls on between `from` and `to` (both included, YYYY-MM-DD). None when what it needs is not known yet. */
export function occurrences(p: Pick<RecurringRow, "frequency" | "dayOfMonth" | "weekday" | "month">, from: string, to: string): string[] {
  const out: string[] = [];
  if (p.frequency === "weekly") {
    if (!p.weekday) return out;
    for (let d = from; d <= to; d = addDay(d, 1)) {
      const iso = ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      if (iso === p.weekday) out.push(d);
    }
    return out;
  }
  if (!p.dayOfMonth || (p.frequency === "yearly" && !p.month)) return out;
  const [y0, m0] = from.split("-").map(Number);
  const [y1, m1] = to.split("-").map(Number);
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, (m = 1)) : m++) {
    if (p.frequency === "yearly" && m !== p.month) continue;
    const d = `${y}-${pad(m)}-${pad(Math.min(p.dayOfMonth, lastDay(y, m)))}`;
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}
