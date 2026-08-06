/**
 * ConnectBooster helper (server-only).
 *
 * ConnectBooster (Kaseya) does not expose a stable public REST surface for
 * third-party invoice CRUD in all tenants. This module supports:
 *  1) Portal deep-links (customer profile / pay) — always available when
 *     CONNECTBOOSTER_PORTAL_BASE_URL + per-company customer id are set.
 *  2) Optional invoice list API when CONNECTBOOSTER_API_BASE_URL + API key
 *     are configured (tenant-specific; fails gracefully with a clear message).
 *
 * Secrets never leave the server.
 */

function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  return v.replace(/\r/g, "").trim();
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export type ConnectBoosterConfig = {
  /** Branded client portal base, e.g. https://pay.yourmsp.com */
  portalBaseUrl: string | null;
  /** Optional REST API base for invoice listing (tenant-specific) */
  apiBaseUrl: string | null;
  apiKey: string | null;
  /** Optional account / tenant id for some CB API shapes */
  accountId: string | null;
};

export function getConnectBoosterConfigFromEnv(): ConnectBoosterConfig {
  return {
    portalBaseUrl: cleanEnv(process.env.CONNECTBOOSTER_PORTAL_BASE_URL) || null,
    apiBaseUrl: cleanEnv(process.env.CONNECTBOOSTER_API_BASE_URL) || null,
    apiKey: cleanEnv(process.env.CONNECTBOOSTER_API_KEY) || null,
    accountId: cleanEnv(process.env.CONNECTBOOSTER_ACCOUNT_ID) || null,
  };
}

export function isConnectBoosterPortalConfigured(): boolean {
  return Boolean(getConnectBoosterConfigFromEnv().portalBaseUrl);
}

export function isConnectBoosterApiConfigured(): boolean {
  const c = getConnectBoosterConfigFromEnv();
  return Boolean(c.apiBaseUrl && c.apiKey);
}

export function diagnoseConnectBoosterEnv(): {
  portalConfigured: boolean;
  apiConfigured: boolean;
  portalBaseUrl: string | null;
  apiBaseUrl: string | null;
  hasApiKey: boolean;
  accountIdSet: boolean;
  issues: string[];
} {
  const c = getConnectBoosterConfigFromEnv();
  const issues: string[] = [];
  if (!c.portalBaseUrl) {
    issues.push(
      "CONNECTBOOSTER_PORTAL_BASE_URL is empty — set your branded payment portal URL (e.g. https://pay.yourcompany.com).",
    );
  }
  if (c.apiBaseUrl && !c.apiKey) {
    issues.push(
      "CONNECTBOOSTER_API_BASE_URL is set but CONNECTBOOSTER_API_KEY is empty.",
    );
  }
  if (!c.apiBaseUrl && c.apiKey) {
    issues.push(
      "CONNECTBOOSTER_API_KEY is set but CONNECTBOOSTER_API_BASE_URL is empty.",
    );
  }
  return {
    portalConfigured: Boolean(c.portalBaseUrl),
    apiConfigured: Boolean(c.apiBaseUrl && c.apiKey),
    portalBaseUrl: c.portalBaseUrl,
    apiBaseUrl: c.apiBaseUrl,
    hasApiKey: Boolean(c.apiKey),
    accountIdSet: Boolean(c.accountId),
    issues,
  };
}

/**
 * Build a customer portal URL. Patterns vary by CB tenant; we support:
 *  - {base}  (generic portal home — user signs in)
 *  - {base}/?customerId={id}
 *  - {base}/customer/{id}
 * Controlled via CONNECTBOOSTER_PORTAL_PATH_TEMPLATE if set.
 *
 * Template placeholders: {base} {customerId} {accountId}
 */
export function buildConnectBoosterPortalUrl(opts: {
  customerId: string | null | undefined;
  intent?: "profile" | "pay" | "invoices";
}): string | null {
  const c = getConnectBoosterConfigFromEnv();
  if (!c.portalBaseUrl) return null;
  const base = trimSlash(c.portalBaseUrl);
  const customerId = String(opts.customerId ?? "").trim();
  const accountId = c.accountId || "";

  const template =
    cleanEnv(process.env.CONNECTBOOSTER_PORTAL_PATH_TEMPLATE) ||
    (customerId ? "{base}" : "{base}");

  let url = template
    .split("{base}").join(base)
    .split("{customerId}").join(encodeURIComponent(customerId))
    .split("{accountId}").join(encodeURIComponent(accountId));

  // If template was just base and we have a customer id, append a common query
  if (url === base && customerId) {
    const intent = opts.intent || "profile";
    const q = new URLSearchParams();
    q.set("customerId", customerId);
    if (intent === "pay") q.set("view", "pay");
    if (intent === "invoices") q.set("view", "invoices");
    url = `${base}/?${q.toString()}`;
  }

  return url;
}

export type ConnectBoosterInvoice = {
  id: string;
  number: string | null;
  status: string | null;
  /** open | paid | partial | void | unknown */
  statusKind: "open" | "paid" | "partial" | "void" | "unknown";
  issueDate: string | null;
  dueDate: string | null;
  /** Amount due remaining (client-visible) */
  balance: number | null;
  /** Original total if known (not cost/profit) */
  total: number | null;
  currency: string | null;
  /** Direct pay URL when available */
  payUrl: string | null;
  /** PDF or detail URL when available */
  viewUrl: string | null;
};

function classifyStatus(raw: string | null | undefined): ConnectBoosterInvoice["statusKind"] {
  const s = (raw || "").toLowerCase();
  if (!s) return "unknown";
  if (/void|cancel/.test(s)) return "void";
  if (/paid|closed|complete/.test(s) && !/unpaid|partial/.test(s)) return "paid";
  if (/partial/.test(s)) return "partial";
  if (/open|unpaid|due|outstanding|past/.test(s)) return "open";
  return "unknown";
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function mapInvoiceRow(
  raw: Record<string, unknown>,
  customerId: string,
): ConnectBoosterInvoice {
  const id = str(raw.id ?? raw.invoiceId ?? raw.InvoiceId ?? raw.uuid) || "unknown";
  const number = str(
    raw.number ?? raw.invoiceNumber ?? raw.InvoiceNumber ?? raw.reference,
  );
  const status = str(raw.status ?? raw.Status ?? raw.paymentStatus);
  const balance = num(
    raw.balance ??
      raw.amountDue ??
      raw.AmountDue ??
      raw.balanceDue ??
      raw.remainingBalance,
  );
  const total = num(
    raw.total ?? raw.amount ?? raw.Amount ?? raw.invoiceTotal ?? raw.Total,
  );
  const issueDate = str(
    raw.issueDate ?? raw.date ?? raw.invoiceDate ?? raw.InvoiceDate ?? raw.created,
  );
  const dueDate = str(raw.dueDate ?? raw.DueDate ?? raw.due);
  const currency = str(raw.currency ?? raw.Currency ?? raw.currencyCode) || "USD";

  let payUrl = str(raw.payUrl ?? raw.paymentUrl ?? raw.PayUrl);
  let viewUrl = str(raw.viewUrl ?? raw.pdfUrl ?? raw.PdfUrl ?? raw.url);

  if (!payUrl) {
    payUrl = buildConnectBoosterPortalUrl({
      customerId,
      intent: "pay",
    });
  }
  if (!viewUrl) {
    viewUrl = buildConnectBoosterPortalUrl({
      customerId,
      intent: "invoices",
    });
  }

  let statusKind = classifyStatus(status);
  if (statusKind === "unknown" && balance != null) {
    statusKind = balance > 0.009 ? "open" : "paid";
  }

  return {
    id,
    number,
    status,
    statusKind,
    issueDate,
    dueDate,
    balance,
    total,
    currency,
    payUrl,
    viewUrl,
  };
}

/**
 * Try to list invoices for a ConnectBooster customer via optional REST API.
 * Returns null invoices + reason when API is not configured or fails.
 */
export async function fetchConnectBoosterInvoices(opts: {
  customerId: string;
}): Promise<{
  configured: boolean;
  apiConfigured: boolean;
  invoices: ConnectBoosterInvoice[];
  portalUrl: string | null;
  payUrl: string | null;
  error?: string;
  source: "api" | "portal_only" | "none";
}> {
  const customerId = String(opts.customerId || "").trim();
  const portalUrl = buildConnectBoosterPortalUrl({
    customerId: customerId || null,
    intent: "profile",
  });
  const payUrl = buildConnectBoosterPortalUrl({
    customerId: customerId || null,
    intent: "pay",
  });
  const c = getConnectBoosterConfigFromEnv();

  if (!customerId) {
    return {
      configured: Boolean(c.portalBaseUrl || (c.apiBaseUrl && c.apiKey)),
      apiConfigured: isConnectBoosterApiConfigured(),
      invoices: [],
      portalUrl,
      payUrl,
      error: "Company has no ConnectBooster customer ID",
      source: c.portalBaseUrl ? "portal_only" : "none",
    };
  }

  if (!isConnectBoosterApiConfigured()) {
    return {
      configured: Boolean(c.portalBaseUrl),
      apiConfigured: false,
      invoices: [],
      portalUrl,
      payUrl,
      source: c.portalBaseUrl ? "portal_only" : "none",
      error: c.portalBaseUrl
        ? undefined
        : "ConnectBooster portal URL not configured",
    };
  }

  // Tenant-specific paths — try common patterns
  const base = trimSlash(c.apiBaseUrl!);
  const paths = [
    `/api/v1/customers/${encodeURIComponent(customerId)}/invoices`,
    `/api/customers/${encodeURIComponent(customerId)}/invoices`,
    `/v1/customers/${encodeURIComponent(customerId)}/invoices`,
    `/customers/${encodeURIComponent(customerId)}/invoices`,
    `/api/v1/invoices?customerId=${encodeURIComponent(customerId)}`,
  ];

  let lastErr = "No invoice endpoint responded";
  for (const path of paths) {
    try {
      const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${c.apiKey}`,
          "X-Api-Key": c.apiKey!,
          ApiKey: c.apiKey!,
        },
      });
      const text = await res.text();
      if (res.status === 404) continue;
      if (!res.ok) {
        lastErr = `ConnectBooster API ${res.status}: ${text.slice(0, 200)}`;
        continue;
      }
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        lastErr = "ConnectBooster API returned non-JSON";
        continue;
      }
      const rows = extractInvoiceArray(data);
      const invoices = rows.map((r) => mapInvoiceRow(r, customerId));
      invoices.sort((a, b) => {
        const da = a.dueDate || a.issueDate || "";
        const db = b.dueDate || b.issueDate || "";
        return db.localeCompare(da);
      });
      return {
        configured: true,
        apiConfigured: true,
        invoices,
        portalUrl,
        payUrl,
        source: "api",
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  // API configured but unreachable — still offer portal
  return {
    configured: Boolean(c.portalBaseUrl),
    apiConfigured: true,
    invoices: [],
    portalUrl,
    payUrl,
    source: c.portalBaseUrl ? "portal_only" : "none",
    error: `${lastErr}. Use “Open ConnectBooster” to view and pay invoices in the payment portal.`,
  };
}

function extractInvoiceArray(data: unknown): Array<Record<string, unknown>> {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.filter(
      (x): x is Record<string, unknown> => !!x && typeof x === "object",
    );
  }
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["items", "data", "invoices", "results", "value"]) {
      if (Array.isArray(o[key])) {
        return (o[key] as unknown[]).filter(
          (x): x is Record<string, unknown> => !!x && typeof x === "object",
        );
      }
    }
  }
  return [];
}
