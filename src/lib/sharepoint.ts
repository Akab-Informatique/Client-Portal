import type { SharePointItem } from "@/lib/types";

/** Optional per-client Microsoft Graph app credentials. */
export type GraphAuthOverride = {
  tenantId?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
};

export type SharePointAuthInfo = {
  source: "client_app" | "portal_app" | "none";
  tenantId: string | null;
  clientId: string | null;
  usesClientTenant: boolean;
  usesClientApp: boolean;
};

export type SharePointBrowseResponse = {
  configured: boolean;
  items: SharePointItem[];
  site?: { id: string; name: string | null; webUrl: string | null };
  folderPath?: string;
  tenantId?: string | null;
  clientId?: string | null;
  auth?: SharePointAuthInfo;
  error?: string;
};

export type SharePointStatusResponse = {
  configured: boolean;
  ok: boolean;
  tenantId?: string;
  clientId?: string;
  token?: boolean;
  scope?: string;
  note?: string;
  error?: string;
};

export type SharePointResolveResponse = {
  configured: boolean;
  ok: boolean;
  tenantId?: string | null;
  clientId?: string | null;
  auth?: SharePointAuthInfo;
  site?: { id: string; name: string | null; webUrl: string | null };
  error?: string;
  tip?: string;
  help?: string[];
  parsed?: {
    hostname?: string;
    sitePath?: string;
    extraPath?: string;
    siteId?: string | null;
  };
};

/** True when this company has its own SharePoint connection configured. */
export function isCompanySharePointLinked(company: {
  documentation_enabled?: boolean | null;
  sharepoint_site_url?: string | null;
}): boolean {
  return (
    company.documentation_enabled !== false &&
    !!(company.sharepoint_site_url || "").trim()
  );
}

/** True when the company has its own Graph app id + secret stored. */
export function companyHasOwnGraphApp(company: {
  sharepoint_client_id?: string | null;
  sharepoint_client_secret?: string | null;
}): boolean {
  return (
    !!(company.sharepoint_client_id || "").trim() &&
    !!(company.sharepoint_client_secret || "").trim()
  );
}

export function graphAuthFromCompany(company: {
  sharepoint_tenant_id?: string | null;
  sharepoint_client_id?: string | null;
  sharepoint_client_secret?: string | null;
}): GraphAuthOverride {
  return {
    tenantId: company.sharepoint_tenant_id || null,
    clientId: company.sharepoint_client_id || null,
    clientSecret: company.sharepoint_client_secret || null,
  };
}

export async function fetchSharePointStatus(probe = false): Promise<SharePointStatusResponse> {
  const res = await fetch(
    `/api/sharepoint/status${probe ? "?probe=1" : ""}`,
  );
  return (await res.json()) as SharePointStatusResponse;
}

/**
 * Resolve/verify a SharePoint site. Prefer POST so client secrets are not
 * placed in query strings.
 */
export async function resolveSharePointSite(
  siteUrl: string,
  auth?: GraphAuthOverride | string | null,
): Promise<SharePointResolveResponse> {
  const override: GraphAuthOverride =
    typeof auth === "string" ? { tenantId: auth } : auth || {};

  const res = await fetch(`/api/sharepoint/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteUrl,
      tenantId: override.tenantId || undefined,
      clientId: override.clientId || undefined,
      clientSecret: override.clientSecret || undefined,
    }),
  });
  return (await res.json()) as SharePointResolveResponse;
}

export async function browseSharePoint(opts: {
  siteUrl: string;
  basePath?: string | null;
  path?: string | null;
  /** Per-client Graph auth (tenant and/or client id + secret). */
  auth?: GraphAuthOverride | null;
  /** @deprecated use auth.tenantId */
  tenantId?: string | null;
}): Promise<SharePointBrowseResponse> {
  const auth: GraphAuthOverride = {
    tenantId: opts.auth?.tenantId ?? opts.tenantId ?? null,
    clientId: opts.auth?.clientId ?? null,
    clientSecret: opts.auth?.clientSecret ?? null,
  };

  // POST keeps client secrets out of URL/query logs
  const res = await fetch(`/api/sharepoint/browse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteUrl: opts.siteUrl,
      basePath: opts.basePath || undefined,
      path: opts.path || undefined,
      tenantId: auth.tenantId || undefined,
      clientId: auth.clientId || undefined,
      clientSecret: auth.clientSecret || undefined,
    }),
  });
  return (await res.json()) as SharePointBrowseResponse;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fileIconKind(
  item: Pick<SharePointItem, "isFolder" | "mimeType" | "name">,
): "folder" | "pdf" | "image" | "sheet" | "doc" | "file" {
  if (item.isFolder) return "folder";
  const name = item.name.toLowerCase();
  const mime = (item.mimeType || "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (
    mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)
  )
    return "image";
  if (
    mime.includes("sheet") ||
    mime.includes("excel") ||
    /\.(xlsx?|csv)$/i.test(name)
  )
    return "sheet";
  if (
    mime.includes("word") ||
    mime.includes("document") ||
    /\.(docx?|rtf|txt|md)$/i.test(name)
  )
    return "doc";
  return "file";
}
