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
