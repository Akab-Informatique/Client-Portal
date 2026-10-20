import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { PriorityKind, StatusKind } from "@/pages/tickets/shared";

/** The CRM: the portal's own copy of the clients (synced with Autotask while it is linked). */
export type CrmClient = {
  id: string;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  website: string | null;
  notes: string | null;
  active: boolean;
  autotaskId: number | null;
  parentId: string | null;
  classKey: string | null;
  syncedAt: string | null;
};
export type CrmListItem = CrmClient & { parentName: string | null; children: number; contacts: number; openTickets: number };
export type InvoiceSettings = {
  billingEmail?: string;
  termsDays?: number;
  delivery?: "email" | "mail";
  taxes?: boolean;
  taxNumber?: string;
  poRequired?: boolean;
  hourlyRate?: number | null;
  notes?: string;
  /** Kinds of work approved automatically when imported */
  autoApprove?: string[];
};
export type CrmDetail = CrmClient & {
  parent: { id: string; name: string } | null;
  children: { id: string; name: string; active: boolean }[];
  /** null: no right to see it */
  invoice: InvoiceSettings | null;
};
export type CrmContact = {
  id: string;
  clientId: string;
  autotaskId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  active: boolean;
  userId: string | null;
  /** Client portal access (null: none) */
  portal: { lastLoginAt: string | null; pending: boolean; role: string | null } | null;
};
export type InvoiceStatus = "paid" | "partial" | "due" | "overdue" | "voided";
export type InvoicePayment = { id: string; amountCents: number; paidOn: string; method: string; reference: string | null; note: string | null; source: string; by: string | null };
export type CrmInvoice = {
  id: string;
  number: string;
  company: string;
  issuedOn: string;
  dueOn: string | null;
  totalCents: number;
  taxCents: number;
  paidCents: number;
  balanceCents: number;
  paidOn: string | null;
  status: InvoiceStatus;
  late: boolean;
  daysLate: number;
  payments: InvoicePayment[];
  /** autotask: copied from Autotask · portal: made here (with its lines) */
  source: "autotask" | "portal";
  notes: string | null;
  poNumber: string | null;
  lines: { id: string; kind: string; description: string; quantity: number; unitPriceCents: number; amountCents: number; taxable: boolean }[];
  /** In QuickBooks: its id once sent, the last send, its error */
  quickbooks: { id: string | null; syncedAt: string | null; error: string | null } | null;
};
export type CrmInvoices = { summary: { dueCents: number; overdueCents: number; overdueCount: number; partialCount: number; paidYearCents: number }; items: CrmInvoice[] };
/** 1 234,56 $ */
export const money = (cents: number, lang: string) => new Intl.NumberFormat(lang === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);

export type CrmContract = {
  id: string;
  name: string;
  type: string | null;
  active: boolean;
  isDefault: boolean;
  autoApprove: boolean;
  startDate: string | null;
  endDate: string | null;
  /** hourly | monthly | per_ticket | none */
  billingMode: "hourly" | "monthly" | "per_ticket" | "none";
  hourlyRateCents: number | null;
  monthlyRateCents: number | null;
  ticketRateCents: number | null;
  /** The client's default support contract */
  isSupportDefault: boolean;
  /** The usual hourly rate of Admin › Facturation, in cents */
  usualRateCents: number;
};
export type CrmTicket = {
  id: number;
  number: string;
  title: string;
  company: string;
  contact: string;
  statusLabel: string | null;
  statusKind: StatusKind;
  priorityLabel: string | null;
  priorityKind: PriorityKind;
  assignee: string | null;
  dueAt: string;
  updatedAt: string;
};
export type SyncStatus = {
  mode: "autotask" | "sample";
  lastSync: string | null;
  ok: boolean | null;
  error: string | null;
  counts: { clients: number; contacts: number; contracts: number } | null;
  every: number;
};

export const useCrmClients = () => useQuery({ queryKey: ["crm", "clients"], queryFn: () => api.get<CrmListItem[]>("/crm/clients"), staleTime: 30_000 });
export const useSyncStatus = () => useQuery({ queryKey: ["crm", "status"], queryFn: () => api.get<SyncStatus>("/crm/status"), refetchInterval: 60_000 });

/** A message for an API error of the CRM. */
export function crmErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown) {
  if (e instanceof ApiError && (e.code === "parent_loop" || e.code === "company_exists")) return t(`crm.errors.${e.code}`);
  return null;
}

/** "3 min", "2 h", "4 j" */
export function since(iso: string, lang: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === "en" ? "en-CA" : "fr-CA", { numeric: "auto", style: "short" });
  if (s < 60) return rtf.format(0, "minute");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86_400), "day");
}
