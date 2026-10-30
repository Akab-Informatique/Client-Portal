import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "../db/index.ts";
import { billingSettings, DEFAULT_BILLING } from "./billing.ts";
import { quoteTotals, type QuoteRecurrence } from "../../shared/quotes.ts";

export const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** The next number: "S-" and the highest used + 1 (1001 for the first). */
export async function nextQuoteNumber(): Promise<string> {
  const rows = await db().select({ number: schema.quotes.number }).from(schema.quotes).where(like(schema.quotes.number, "S-%"));
  const max = rows.reduce((n, r) => Math.max(n, Number(r.number.slice(2)) || 0), 1000);
  return `S-${max + 1}`;
}

export type QuoteLineInput = {
  productId: string | null;
  serviceId: string | null;
  sku: string | null;
  description: string;
  details: string | null;
  quantityX100: number;
  unitPriceCents: number;
  unitCostCents: number;
  discountX100: number;
  taxable: boolean;
  optional: boolean;
  recurrence: QuoteRecurrence;
};

/** Replace the lines of a quote, in the order given. */
export async function saveLines(tx: Pick<ReturnType<typeof db>, "delete" | "insert">, quoteId: string, lines: QuoteLineInput[]) {
  await tx.delete(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quoteId));
  if (lines.length) await tx.insert(schema.quoteLines).values(lines.map((l, position) => ({ ...l, quoteId, position })));
}

/** The lines of some quotes, by quote, in order. */
async function linesOf(ids: string[]) {
  if (!ids.length) return new Map<string, (typeof schema.quoteLines.$inferSelect)[]>();
  const rows = await db().select().from(schema.quoteLines).where(inArray(schema.quoteLines.quoteId, ids)).orderBy(schema.quoteLines.position);
  const m = new Map<string, typeof rows>();
  for (const l of rows) m.set(l.quoteId, [...(m.get(l.quoteId) ?? []), l]);
  return m;
}

const preparer = alias(schema.users, "preparer");

const quoteColumns = {
  id: schema.quotes.id,
  number: schema.quotes.number,
  clientId: schema.quotes.clientId,
  clientName: schema.clients.name,
  clientTaxes: sql<boolean | null>`(${schema.clients.invoice}->>'taxes')::boolean`,
  prospectName: schema.quotes.prospectName,
  contactName: schema.quotes.contactName,
  contactEmail: schema.quotes.contactEmail,
  title: schema.quotes.title,
  status: schema.quotes.status,
  kind: schema.quotes.kind,
  survey: schema.quotes.survey,
  issuedOn: schema.quotes.issuedOn,
  validUntil: schema.quotes.validUntil,
  taxes: schema.quotes.taxes,
  notes: schema.quotes.notes,
  internalNotes: schema.quotes.internalNotes,
  createdBy: schema.users.name,
  preparedById: schema.quotes.preparedBy,
  preparedBy: preparer.name,
  projectTicketId: schema.quotes.projectTicketId,
  projectTicketNumber: schema.quotes.projectTicketNumber,
  projectAt: schema.quotes.projectAt,
  opportunityId: schema.quotes.opportunityId,
  sentAt: schema.quotes.sentAt,
  decidedAt: schema.quotes.decidedAt,
  createdAt: schema.quotes.createdAt,
  updatedAt: schema.quotes.updatedAt,
};

type Row = { [K in keyof typeof quoteColumns]: any } & { status: string };

async function shape(rows: Row[], withLines: boolean) {
  const [s, lines] = await Promise.all([billingSettings(), linesOf(rows.map((r) => r.id))]);
  const rates = { gstRate: s.taxes.gstRate, qstRate: s.taxes.qstRate };
  const today = todayQc();
  return rows.map((r) => {
    const ls = lines.get(r.id) ?? [];
    // the answers of the checklist are only sent with the quote itself
    const { survey, ...head } = r;
    return {
      ...head,
      ...(withLines ? { survey } : {}),
      expired: r.status === "sent" && Boolean(r.validUntil) && r.validUntil < today,
      lineCount: ls.length,
      totals: quoteTotals(ls, r.taxes, rates),
      ...(withLines ? { lines: ls, rates, company: { ...s.company, address: s.company.address || DEFAULT_BILLING.company.address, phone: s.company.phone || DEFAULT_BILLING.company.phone }, taxNumbers: { gst: s.taxes.gstNumber, qst: s.taxes.qstNumber }, footer: s.template.footer } : {}),
    };
  });
}

export async function listQuotes(filter: { status?: string; clientId?: string; q?: string }) {
  const rows = await db()
    .select(quoteColumns)
    .from(schema.quotes)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.quotes.clientId))
    .leftJoin(schema.users, eq(schema.users.id, schema.quotes.createdBy))
    .leftJoin(preparer, eq(preparer.id, schema.quotes.preparedBy))
    .where(and(filter.status ? eq(schema.quotes.status, filter.status) : undefined, filter.clientId ? eq(schema.quotes.clientId, filter.clientId) : undefined))
    .orderBy(desc(schema.quotes.createdAt));
  const words = filter.q?.trim().toLowerCase();
  const shown = words ? rows.filter((r) => `${r.number} ${r.title} ${r.clientName ?? ""} ${r.prospectName ?? ""} ${r.contactName ?? ""}`.toLowerCase().includes(words)) : rows;
  return shape(shown, false);
}

export async function getQuote(id: string) {
  const rows = await db()
    .select(quoteColumns)
    .from(schema.quotes)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.quotes.clientId))
    .leftJoin(schema.users, eq(schema.users.id, schema.quotes.createdBy))
    .leftJoin(preparer, eq(preparer.id, schema.quotes.preparedBy))
    .where(eq(schema.quotes.id, id));
  return (await shape(rows, true))[0] ?? null;
}
