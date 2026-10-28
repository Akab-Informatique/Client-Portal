import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { QuoteKind, QuoteRecurrence, QuoteStatus, quoteTotals } from "@shared/quotes";

/** The implementation (one-time lines) at the top level; monthly and yearly lines apart. */
export type QuoteTotals = ReturnType<typeof quoteTotals>;

export type QuoteListItem = {
  id: string;
  number: string;
  clientId: string | null;
  clientName: string | null;
  prospectName: string | null;
  contactName: string | null;
  title: string;
  status: QuoteStatus;
  kind: QuoteKind;
  expired: boolean;
  issuedOn: string;
  validUntil: string | null;
  taxes: boolean;
  createdBy: string | null;
  preparedById: string | null;
  preparedBy: string | null;
  projectTicketId: number | null;
  projectTicketNumber: string | null;
  projectAt: string | null;
  lineCount: number;
  totals: QuoteTotals;
};

export type QuoteLine = {
  id: string;
  productId: string | null;
  sku: string | null;
  description: string;
  details: string | null;
  recurrence: QuoteRecurrence;
  quantityX100: number;
  unitPriceCents: number;
  unitCostCents: number;
  taxable: boolean;
  optional: boolean;
};

export type Quote = QuoteListItem & {
  contactEmail: string | null;
  survey: Record<string, string>;
  notes: string | null;
  internalNotes: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  lines: QuoteLine[];
  rates: { gstRate: number; qstRate: number };
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  taxNumbers: { gst: string; qst: string };
  footer: string;
};

export type QuoteProduct = {
  id: string;
  sku: string | null;
  name: string;
  description: string;
  manufacturer: string | null;
  category: string | null;
  priceCents: number;
  costCents: number;
  stock: number;
  uses: number;
};

export type QuoteStaff = { id: string; name: string; title: string | null };
export const useQuoteStaff = () => useQuery({ queryKey: ["quotes", "staff"], queryFn: () => api.get<QuoteStaff[]>("/quotes/staff"), staleTime: 5 * 60_000 });

export type QuoteClient = { id: string; name: string; email: string | null; taxes: boolean };

export const useQuoteClients = () => useQuery({ queryKey: ["quotes", "clients"], queryFn: () => api.get<QuoteClient[]>("/quotes/clients"), staleTime: 60_000 });

/** "1149,75" or "1 149.75 $" as a number (NaN when it is not one) */
export const parseNum = (v: string) => Number(v.replace(/[\s$]/g, "").replace(",", "."));
export const toCents = (v: string) => {
  const n = parseNum(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};
export const toQtyX100 = (v: string) => {
  const n = parseNum(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 100;
};
export const fromCents = (c: number) => (c / 100).toFixed(2).replace(".", ",");
export const fromQty = (x: number) => String(x / 100).replace(".", ",");

export const STATUS_STYLE: Record<QuoteStatus | "expired", string> = {
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  sent: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  declined: "border-red-500/50 bg-red-500/15 text-red-300",
  expired: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};
