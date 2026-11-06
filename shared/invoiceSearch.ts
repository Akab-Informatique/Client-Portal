/**
 * The search box of Accounting › Factures › Toutes les factures: a client's name, an invoice
 * or PO number, or an amount — and everything that looks like it.
 *  - Words: each one must be found in the number, the PO or the client's name (accents, case and
 *    punctuation ignored); a word of 4 letters or more also finds a name with one typo (two from 8).
 *  - An amount ("150", "150,25", "1 035,16 $", "1,035.16"): the invoices whose total or balance is
 *    within 1 $ (or 1 % of the amount, when larger) of it, plus the numbers / POs holding those digits.
 *  - A number inside words ("icodev 1035"): that word matches the number, the PO or an amount near it.
 */

export type SearchableInvoice = { number: string; poNumber: string | null; clientName: string; totalCents: number; balanceCents: number };

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "1 035,16 $" → 103516 cents; null when it is not an amount */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s  $]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    // the last separator followed by 1–2 digits is the decimal one; the others group thousands
    s = s.slice(0, lastSep).replace(/[.,]/g, "") + "." + s.slice(lastSep + 1);
  } else s = s.replace(/[.,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const near = (cents: number, target: number) => Math.abs(cents - target) <= Math.max(100, Math.round(target * 0.01));

/** Edit distance with swapped letters counted as one typo (optimal string alignment), at most `max` */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= max;
}

function amountMatch(inv: SearchableInvoice, cents: number, digits: string) {
  if (near(inv.totalCents, cents) || (inv.balanceCents > 0 && near(inv.balanceCents, cents))) return true;
  return Boolean(digits) && (fold(inv.number).replace(/ /g, "").includes(digits) || fold(inv.poNumber ?? "").replace(/ /g, "").includes(digits));
}

/** A matcher for one query (built once, used on every invoice) */
export function invoiceMatcher(query: string): (inv: SearchableInvoice) => boolean {
  const q = query.trim();
  if (!q) return () => true;
  const whole = parseAmount(q);
  if (whole !== null) {
    const digits = q.replace(/\D/g, "");
    return (inv) => amountMatch(inv, whole, digits);
  }
  // a piece with letters and digits ("T-9002", "BC-778") is a number or a PO, read as typed
  const pieces = q.split(/\s+/);
  const codes = pieces.filter((p) => /\d/.test(p) && /[a-z]/i.test(p)).map((p) => fold(p).replace(/ /g, ""));
  const words = fold(pieces.filter((p) => !(/\d/.test(p) && /[a-z]/i.test(p))).join(" ")).split(" ").filter(Boolean);
  if (!codes.length && !words.length) return () => false;
  const compact = (s: string | null) => fold(s ?? "").replace(/ /g, "");
  return (inv) => {
    if (!codes.every((c) => compact(inv.number).includes(c) || compact(inv.poNumber).includes(c))) return false;
    const hay = fold(`${inv.number} ${inv.poNumber ?? ""} ${inv.clientName}`);
    const tokens = hay.split(" ");
    return words.every((w) => {
      if (hay.includes(w)) return true;
      if (/^\d+$/.test(w)) return amountMatch(inv, Number(w) * 100, w);
      if (w.length < 4) return false;
      const max = w.length >= 8 ? 2 : 1;
      // a typo: against each word of the name, or the start of a longer one
      return tokens.some((t) => within(w, t, max) || (t.length > w.length && within(w, t.slice(0, w.length), max)));
    });
  };
}
