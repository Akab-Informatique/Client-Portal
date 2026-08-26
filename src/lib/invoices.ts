import { formatApiError } from "@/lib/autotask";
import { downloadBlob } from "@/lib/download";

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
  paymentTermId?: number | null;
  paymentTerms?: string | null;
};

export type InvoicesResponse = {
  configured: boolean;
  invoices: ClientInvoice[];
  error?: string | null;
  companyId?: string;
  search?: string | null;
  count?: number;
};

export async function fetchClientInvoices(
  autotaskCompanyId: string,
  opts?: { search?: string | null },
): Promise<InvoicesResponse> {
  const q = new URLSearchParams({ autotaskCompanyId });
  const search = String(opts?.search ?? "").trim();
  if (search) q.set("search", search);
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

/** PDF URL for iframe preview / new-tab open (inline disposition). */
export function invoicePdfUrl(
  invoiceId: number,
  disposition: "inline" | "attachment" = "inline",
): string {
  const q = new URLSearchParams({ disposition });
  return `/api/autotask/invoices/${invoiceId}/pdf?${q}`;
}

/**
 * Fetch invoice PDF as Blob (for print / download).
 */
export async function fetchInvoicePdfBlob(
  invoiceId: number,
): Promise<{ blob: Blob; fileName: string }> {
  const r = await fetch(invoicePdfUrl(invoiceId, "inline"), {
    headers: { Accept: "application/pdf" },
  });
  if (!r.ok) {
    let msg = `PDF failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: unknown };
      msg = formatApiError(j.error, msg);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await r.blob();
  const cd = r.headers.get("Content-Disposition") || "";
  // Parse Content-Disposition header value only (String.match — header field parse only)
  const dispositionMatch = cd.match(/filename="?([^";]+)"?/i);
  const fileName = dispositionMatch?.[1]?.trim() || `invoice-${invoiceId}.pdf`;
  return { blob, fileName };
}

export async function downloadInvoicePdf(invoiceId: number): Promise<void> {
  const { blob, fileName } = await fetchInvoicePdfBlob(invoiceId);
  downloadBlob(blob, fileName);
}

/**
 * Open a hidden iframe with the PDF and trigger the browser print dialog.
 */
export async function printInvoicePdf(invoiceId: number): Promise<void> {
  const { blob } = await fetchInvoicePdfBlob(invoiceId);
  const url = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.src = url;
    const cleanup = () => {
      try {
        document.body.removeChild(iframe);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    };
    iframe.onload = () => {
      try {
        const w = iframe.contentWindow;
        if (!w) throw new Error("Could not open print view");
        const done = () => {
          cleanup();
          resolve();
        };
        w.addEventListener?.("afterprint", done);
        // Fallback if afterprint never fires
        setTimeout(done, 60_000);
        w.focus();
        w.print();
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error("Print failed"));
      }
    };
    iframe.onerror = () => {
      cleanup();
      reject(new Error("Could not load invoice PDF for printing"));
    };
    document.body.appendChild(iframe);
  });
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
