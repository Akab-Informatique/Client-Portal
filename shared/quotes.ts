/** Quote totals, shared so the editor shows what the server will save. Money in cents, quantities ×100. */
export const QUOTE_RECURRENCES = ["once", "monthly", "yearly"] as const;
export type QuoteRecurrence = (typeof QUOTE_RECURRENCES)[number];

export type QuoteLineMoney = { quantityX100: number; unitPriceCents: number; unitCostCents?: number; taxable: boolean; optional: boolean; recurrence?: QuoteRecurrence | string; /** percent ×100 (10 % = 1000) */ discountX100?: number };

export const QUOTE_KINDS = ["standard", "site_visit"] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Quantity × unit price, before the discount */
export const lineGross = (l: Pick<QuoteLineMoney, "quantityX100" | "unitPriceCents">) => Math.round((l.quantityX100 * l.unitPriceCents) / 100);
/** What the line comes to: quantity × unit price, less its discount (in percent) */
export const lineAmount = (l: Pick<QuoteLineMoney, "quantityX100" | "unitPriceCents" | "discountX100">) => {
  const gross = lineGross(l);
  const d = Math.min(Math.max(l.discountX100 ?? 0, 0), 10_000);
  return d ? gross - Math.round((gross * d) / 10_000) : gross;
};

export const recurrenceOf = (l: Pick<QuoteLineMoney, "recurrence">): QuoteRecurrence => (l.recurrence === "monthly" || l.recurrence === "yearly" ? l.recurrence : "once");

export type QuotePart = { subtotalCents: number; gstCents: number; qstCents: number; totalCents: number; costCents: number; marginCents: number };

/** The total of some counted lines (no options), taxes on the taxable ones. */
function part(lines: QuoteLineMoney[], taxes: boolean, rates: { gstRate: number; qstRate: number }): QuotePart {
  const subtotalCents = lines.reduce((n, l) => n + lineAmount(l), 0);
  const taxableCents = taxes ? lines.filter((l) => l.taxable).reduce((n, l) => n + lineAmount(l), 0) : 0;
  const gstCents = Math.round((taxableCents * rates.gstRate) / 100);
  const qstCents = Math.round((taxableCents * rates.qstRate) / 100);
  const costCents = lines.reduce((n, l) => n + Math.round((l.quantityX100 * (l.unitCostCents ?? 0)) / 100), 0);
  return { subtotalCents, gstCents, qstCents, totalCents: subtotalCents + gstCents + qstCents, costCents, marginCents: subtotalCents - costCents };
}

/**
 * The main figures are the implementation (one-time lines, paid now); monthly and yearly lines
 * have their own totals, never added to it. Optional lines are shown but not counted.
 */
export function quoteTotals(lines: QuoteLineMoney[], taxes: boolean, rates: { gstRate: number; qstRate: number }) {
  const counted = lines.filter((l) => !l.optional);
  const once = part(counted.filter((l) => recurrenceOf(l) === "once"), taxes, rates);
  const monthly = part(counted.filter((l) => recurrenceOf(l) === "monthly"), taxes, rates);
  const yearly = part(counted.filter((l) => recurrenceOf(l) === "yearly"), taxes, rates);
  const optionalCents = lines.filter((l) => l.optional).reduce((n, l) => n + lineAmount(l), 0);
  return { ...once, monthly, yearly, optionalCents };
}

/**
 * The deposit asked when a quote is accepted: a share (percent ×100; 50 % = 5000) of the implementation
 * (one-time lines, options left out — or only the lines ticked), before taxes, split into its taxable and non-taxable parts so the
 * invoice taxes exactly what the quote taxes. Monthly and yearly lines are never part of it.
 */
export function depositOf(lines: (QuoteLineMoney & { id?: string })[], percentX100: number, lineIds?: string[] | null) {
  // only the lines ticked (e.g. the equipment): the rest is invoiced later, at delivery
  const once = lines.filter((l) => !l.optional && recurrenceOf(l) === "once" && (!lineIds || (l.id != null && lineIds.includes(l.id))));
  const share = (cents: number) => Math.round((cents * Math.min(Math.max(percentX100, 0), 10_000)) / 10_000);
  const taxableCents = share(once.filter((l) => l.taxable).reduce((n, l) => n + lineAmount(l), 0));
  const exemptCents = share(once.filter((l) => !l.taxable).reduce((n, l) => n + lineAmount(l), 0));
  return { taxableCents, exemptCents, subtotalCents: taxableCents + exemptCents };
}

/** A line that sells hours of work (by its words: heures, h, main-d'œuvre, labour, hours) */
export const isHourLine = (l: { description: string; details?: string | null }) => /\b(heures?|hrs?|h|main[- ]d['’]?\s*(oe|œ)uvre|labou?r|hours?)\b/i.test(`${l.description} ${l.details ?? ""}`);

/**
 * What a quote sells as a project: the hours of its one-time hour lines and their price (after discounts);
 * no hour line: no hours, and the price of the whole implementation.
 */
export function soldOfQuote(lines: (QuoteLineMoney & { description: string; details?: string | null })[]) {
  const once = lines.filter((l) => !l.optional && recurrenceOf(l) === "once");
  const hourLines = once.filter(isHourLine);
  if (!hourLines.length) return { hours: null as number | null, priceCents: once.reduce((n, l) => n + lineAmount(l), 0) };
  return { hours: hourLines.reduce((n, l) => n + l.quantityX100, 0) / 100, priceCents: hourLines.reduce((n, l) => n + lineAmount(l), 0) };
}
