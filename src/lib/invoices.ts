import { formatApiError } from "@/lib/autotask";

/** Fixed payment portal login (SOLU TI). */
export const PAYMENT_PORTAL_URL =
  "https://soluti.connectboosterportal.com/platform/login";

export type ClientInvoice = {
  id: number;
  number: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  paidDate: string | null;
  total: number | null;
  tax: number | null;
  isVoided: boolean;
  status: "open" | "paid" | "voided";
  fromDate: string | null;
  toDate: string | null;
};

export type InvoicesResponse = {
  configured: boolean;
  invoices: ClientInvoice[];
  error?: string | null;
  companyId?: string;
};

export async function fetchClientInvoices(
  autotaskCompanyId: string,
): Promise<InvoicesResponse> {
  const q = new URLSearchParams({ autotaskCompanyId });
  const r = await fetch(`/api/autotask/invoices?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as InvoicesResponse;
  if (!r.ok) {
    return {
      configured: Boolean(d.configured),
      invoices: [],
      error: formatApiError(d.error, `Invoices failed (${r.status})`),
    };
  }
  return {
    ...d,
    invoices: Array.isArray(d.invoices) ? d.invoices : [],
    error: d.error ? formatApiError(d.error) : null,
  };
}

export function formatMoney(
  amount: number | null | undefined,
  currency = "CAD",
): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

export function formatInvoiceDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
