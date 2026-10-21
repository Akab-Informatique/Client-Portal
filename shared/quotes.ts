/** Quote totals, shared so the editor shows what the server will save. Money in cents, quantities ×100. */
export type QuoteLineMoney = { quantityX100: number; unitPriceCents: number; unitCostCents?: number; taxable: boolean; optional: boolean };

export const QUOTE_KINDS = ["standard", "site_visit"] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const lineAmount = (l: Pick<QuoteLineMoney, "quantityX100" | "unitPriceCents">) => Math.round((l.quantityX100 * l.unitPriceCents) / 100);

export function quoteTotals(lines: QuoteLineMoney[], taxes: boolean, rates: { gstRate: number; qstRate: number }) {
  const counted = lines.filter((l) => !l.optional);
  const subtotalCents = counted.reduce((n, l) => n + lineAmount(l), 0);
  const taxableCents = taxes ? counted.filter((l) => l.taxable).reduce((n, l) => n + lineAmount(l), 0) : 0;
  const gstCents = Math.round((taxableCents * rates.gstRate) / 100);
  const qstCents = Math.round((taxableCents * rates.qstRate) / 100);
  const costCents = counted.reduce((n, l) => n + Math.round(((l.quantityX100 * (l.unitCostCents ?? 0)) / 100)), 0);
  const optionalCents = lines.filter((l) => l.optional).reduce((n, l) => n + lineAmount(l), 0);
  return { subtotalCents, gstCents, qstCents, totalCents: subtotalCents + gstCents + qstCents, costCents, marginCents: subtotalCents - costCents, optionalCents };
}
