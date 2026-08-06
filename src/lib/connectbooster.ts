import { formatApiError } from "@/lib/autotask";

export type ConnectBoosterInvoice = {
  id: string;
  number: string | null;
  status: string | null;
  statusKind: "open" | "paid" | "partial" | "void" | "unknown";
  issueDate: string | null;
  dueDate: string | null;
  balance: number | null;
  total: number | null;
  currency: string | null;
  payUrl: string | null;
  viewUrl: string | null;
};

export type ConnectBoosterInvoicesResponse = {
  configured: boolean;
  apiConfigured?: boolean;
  source?: "api" | "portal_only" | "none";
  customerId?: string;
  invoices: ConnectBoosterInvoice[];
  portalUrl: string | null;
  payUrl: string | null;
  error?: string | null;
};

export type ConnectBoosterStatusResponse = {
  ok?: boolean;
  configured?: boolean;
  portalConfigured?: boolean;
  apiConfigured?: boolean;
  portalBaseUrl?: string | null;
  message?: string;
  issues?: string[];
  fix?: string[];
  error?: string;
};

export async function fetchConnectBoosterStatus(): Promise<ConnectBoosterStatusResponse> {
  const r = await fetch("/api/connectbooster/status", {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as ConnectBoosterStatusResponse;
  if (!r.ok && !d.message) {
    d.error = formatApiError(d.error, `Status failed (${r.status})`);
  }
  return d;
}

export async function fetchConnectBoosterInvoices(
  customerId: string,
): Promise<ConnectBoosterInvoicesResponse> {
  const q = new URLSearchParams({ customerId });
  const r = await fetch(`/api/connectbooster/invoices?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as ConnectBoosterInvoicesResponse;
  if (!r.ok) {
    return {
      configured: false,
      invoices: [],
      portalUrl: d.portalUrl ?? null,
      payUrl: d.payUrl ?? null,
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
  currency = "USD",
): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ""}`.trim();
  }
}
