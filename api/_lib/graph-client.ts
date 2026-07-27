/**
 * Microsoft Graph helper for SharePoint documentation (app-only / client credentials).
 *
 * Required Azure AD app permissions (Application):
 *   - Sites.Read.All  (or Sites.Selected + per-site grant)
 * Admin consent is required after adding the permission.
 *
 * Portal-wide env defaults:
 *   MICROSOFT_TENANT_ID
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *
 * Per-client auth (optional, stored on each company):
 *   sharepoint_tenant_id
 *   sharepoint_client_id
 *   sharepoint_client_secret
 * When clientId + clientSecret are both set on a company, THAT company's
 * Entra app is used for token requests. Otherwise portal defaults apply
 * (with optional tenant-only override).
 */

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

/** Partial overrides from a company record / API request. */
export type GraphCredentialOverride = {
  tenantId?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
};

export type GraphAuthSource = "client_app" | "portal_app";

function trimOrEmpty(v?: string | null): string {
  return (v || "").trim();
}

function tokenCacheKey(cfg: GraphConfig): string {
  return `${cfg.tenantId.toLowerCase()}|${cfg.clientId.toLowerCase()}`;
}

/**
 * Merge optional per-client credentials with portal env defaults.
 * - clientId + clientSecret both provided → use client's app (tenant may still fall back)
 * - only tenantId → portal app in that tenant
 * - nothing → full portal defaults
 */
export function getGraphConfigFromEnv(
  override?: GraphCredentialOverride | string | null,
): GraphConfig | null {
  const o: GraphCredentialOverride =
    typeof override === "string"
      ? { tenantId: override }
      : override && typeof override === "object"
        ? override
        : {};

  const envTenant = trimOrEmpty(process.env.MICROSOFT_TENANT_ID);
  const envClientId = trimOrEmpty(process.env.MICROSOFT_CLIENT_ID);
  const envSecret = trimOrEmpty(process.env.MICROSOFT_CLIENT_SECRET);

  const ovTenant = trimOrEmpty(o.tenantId);
  const ovClientId = trimOrEmpty(o.clientId);
  const ovSecret = trimOrEmpty(o.clientSecret);

  // Per-client app requires BOTH id and secret together.
  const useClientApp = !!(ovClientId && ovSecret);

  const tenantId = ovTenant || envTenant;
  const clientId = useClientApp ? ovClientId : envClientId;
  const clientSecret = useClientApp ? ovSecret : envSecret;

  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

/** Portal defaults only (no per-client override). */
export function isGraphConfigured(): boolean {
  return getGraphConfigFromEnv() != null;
}

/** True when portal defaults OR the given client override can form a full config. */
export function isGraphConfiguredFor(
  override?: GraphCredentialOverride | string | null,
): boolean {
  return getGraphConfigFromEnv(override) != null;
}

/**
 * Resolve a GraphConfig from:
 * - GraphConfig / GraphCredentialOverride object
 * - tenant id string (legacy)
 * - null/undefined → portal defaults
 */
export function resolveGraphConfig(
  input?: GraphConfig | GraphCredentialOverride | string | null,
): GraphConfig | null {
  if (typeof input === "string") return getGraphConfigFromEnv(input);
  if (input && typeof input === "object") {
    return getGraphConfigFromEnv(input as GraphCredentialOverride);
  }
  return getGraphConfigFromEnv();
}

/** Human-readable auth source for UI badges / verify messages. */
export function describeGraphAuthSource(
  override?: GraphCredentialOverride | string | null,
): {
  source: GraphAuthSource;
  tenantId: string | null;
  clientId: string | null;
  usingClientApp: boolean;
} {
  const o: GraphCredentialOverride =
    typeof override === "string"
      ? { tenantId: override }
      : override && typeof override === "object"
        ? override
        : {};
  const ovClientId = trimOrEmpty(o.clientId);
  const ovSecret = trimOrEmpty(o.clientSecret);
  const usingClientApp = !!(ovClientId && ovSecret);
  const cfg = getGraphConfigFromEnv(o);
  return {
    source: usingClientApp ? "client_app" : "portal_app",
    tenantId: cfg?.tenantId ?? (trimOrEmpty(o.tenantId) || null),
    clientId: cfg?.clientId ?? (usingClientApp ? ovClientId : null),
    usingClientApp,
  };
}

/** Token cache keyed by tenant|clientId (supports per-client apps). */
const tokenCache = new Map<
  string,
  { value: string; expiresAt: number; roles: string[] }
>();

/** Last token used (for status diagnostics when no override). */
let lastTokenRoles: string[] = [];

/** Decode JWT payload without verifying signature (server-side diagnostics only). */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(
      part.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getTokenRoles(token: string): string[] {
  const payload = decodeJwtPayload(token);
  const roles = payload?.roles;
  return Array.isArray(roles) ? roles.map(String) : [];
}

/** True if the app-only token carries a SharePoint/Sites application role. */
export function tokenHasSitesAccess(roles: string[]): boolean {
  const need = [
    "Sites.Read.All",
    "Sites.ReadWrite.All",
    "Sites.FullControl.All",
    "Sites.Manage.All",
    "Sites.Selected",
  ];
  const set = new Set(roles.map((r) => r.toLowerCase()));
  return need.some((n) => set.has(n.toLowerCase()));
}

export async function getGraphAccessToken(
  cfgOrOverride?: GraphConfig | GraphCredentialOverride | string | null,
): Promise<string> {
  const cfg = resolveGraphConfig(cfgOrOverride);
  if (!cfg) {
    throw new Error(
      "Microsoft Graph is not configured. Set portal MICROSOFT_TENANT_ID / CLIENT_ID / CLIENT_SECRET, or provide this client's own tenant + app client ID + client secret.",
    );
  }

  const cacheKey = tokenCacheKey(cfg);
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    lastTokenRoles = cached.roles;
    return cached.value;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(
    cfg.tenantId,
  )}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let data: {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Token request failed for tenant ${cfg.tenantId} / app ${cfg.clientId} (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const roles = getTokenRoles(data.access_token);
  tokenCache.set(cacheKey, {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    roles,
  });
  lastTokenRoles = roles;
  return data.access_token;
}

/** Latest token app roles (empty if no token cached yet). */
export function getCachedTokenRoles(
  tenantOrCfg?: string | GraphConfig | GraphCredentialOverride | null,
): string[] {
  if (tenantOrCfg && typeof tenantOrCfg === "object") {
    const cfg = resolveGraphConfig(tenantOrCfg);
    if (!cfg) return [];
    return tokenCache.get(tokenCacheKey(cfg))?.roles ?? [];
  }
  if (typeof tenantOrCfg === "string" && tenantOrCfg.trim()) {
    const prefix = `${tenantOrCfg.trim().toLowerCase()}|`;
    for (const [key, val] of tokenCache.entries()) {
      if (key.startsWith(prefix)) return val.roles;
    }
    return [];
  }
  return lastTokenRoles;
}

export const SITES_PERMISSION_HELP = [
  "Azure Portal → Microsoft Entra ID → App registrations → your app",
  "API permissions → Add a permission → Microsoft Graph → Application permissions",
  "Add Sites.Read.All (read all site collections) — NOT delegated",
  "Click “Grant admin consent for <tenant>” and confirm it shows Granted",
  "Wait 1–2 minutes, then Verify again in the portal",
  "Optional tighter option: Sites.Selected + grant this app access to each client site",
].join("\n");

type GraphErrorBody = {
  error?: {
    code?: string;
    message?: string;
    innerError?: { date?: string; "request-id"?: string; code?: string };
  };
};

export async function graphFetch<T = unknown>(
  path: string,
  init?: RequestInit,
  /**
   * Optional per-client auth: tenant id string (legacy) or full credential override
   * (tenant / client id / client secret).
   */
  auth?: GraphConfig | GraphCredentialOverride | string | null,
): Promise<
  | { ok: true; data: T; status: number }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      raw?: string;
    }
> {
  const token = await getGraphAccessToken(auth);
  const url = path.startsWith("http")
    ? path
    : `https://graph.microsoft.com/v1.0${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const errObj = data as GraphErrorBody | null;
    const code = errObj?.error?.code;
    const message = errObj?.error?.message;
    const msg =
      [code, message].filter(Boolean).join(": ") ||
      `Graph request failed (${res.status})`;
    return {
      ok: false,
      status: res.status,
      error: msg,
      code,
      raw: text.slice(0, 800),
    };
  }

  return { ok: true, data: data as T, status: res.status };
}

/**
 * Parse a SharePoint site URL into hostname + server-relative site path.
 * Strips library UI junk (Forms/AllItems.aspx, query strings, etc.).
 *
 * Supports:
 *   https://contoso.sharepoint.com/sites/ClientDocs
 *   https://contoso.sharepoint.com/teams/TeamName
 *   https://contoso.sharepoint.com/sites/ClientDocs/Shared%20Documents/Folder
 *   https://contoso.sharepoint.com/sites/ClientDocs/Shared%20Documents/Forms/AllItems.aspx
 *   contoso.sharepoint.com,guid,guid   (Graph site id)
 */
export function parseSharePointSiteUrl(input: string): {
  hostname: string;
  sitePath: string;
  /** Extra path after the site (library/folder) if present in the URL */
  extraPath: string;
  /** When the user pasted a Graph site id directly */
  siteId?: string;
} | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  // Graph composite site id: hostname,spsite-guid,spweb-guid
  if (
    !raw.includes("://") &&
    !raw.includes("/") &&
    raw.includes(",") &&
    raw.split(",").length >= 3
  ) {
    const hostname = raw.split(",")[0];
    return { hostname, sitePath: "/", extraPath: "", siteId: raw };
  }

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;

  // Drop query/hash — AllItems.aspx?id=... etc.
  let parts = url.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });

  // Strip SharePoint library UI segments
  const stripFrom = parts.findIndex((p, i) => {
    const lower = p.toLowerCase();
    if (lower === "forms" && parts[i + 1]?.toLowerCase().endsWith(".aspx")) {
      return true;
    }
    if (lower.endsWith(".aspx")) return true;
    return false;
  });
  if (stripFrom >= 0) parts = parts.slice(0, stripFrom);

  // Personal OneDrive links are not supported for app-only site docs
  if (parts[0]?.toLowerCase() === "personal") {
    return null;
  }

  if (parts.length === 0) {
    return { hostname, sitePath: "/", extraPath: "" };
  }

  const root = parts[0].toLowerCase();
  if (root === "sites" || root === "teams") {
    if (parts.length < 2) return null;
    const sitePath = `/${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2);

    // First segment after site is often the library ("Shared Documents", "Documents")
    // Keep as extraPath so browse can open that folder.
    const extra = rest.join("/");
    return { hostname, sitePath, extraPath: extra };
  }

  // Root site collection with a document library path
  return {
    hostname,
    sitePath: "/",
    extraPath: parts.join("/"),
  };
}

export type GraphSite = {
  id: string;
  displayName?: string;
  webUrl?: string;
  name?: string;
  siteCollection?: { hostname?: string };
};

export type GraphDriveItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { path?: string };
};

function encodeSitePath(sitePath: string): string {
  if (sitePath === "/") return "/";
  return (
    "/" +
    sitePath
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join("/")
  );
}

/**
 * Site IDs look like "host,guid,guid". Do NOT encode commas — Graph treats
 * encodeURIComponent(siteId) as invalid and often returns a generic exception.
 */
function siteIdPathSegment(siteId: string): string {
  return siteId
    .split(",")
    .map((part) => encodeURIComponent(part))
    .join(",");
}

function humanizeGraphError(
  err: string,
  code?: string,
  status?: number,
): string {
  const lower = `${code || ""} ${err}`.toLowerCase();

  if (
    lower.includes("access denied") ||
    lower.includes("accessdenied") ||
    status === 403
  ) {
    return (
      `${err}. ` +
      "The app likely lacks SharePoint access. In Azure → App registration → API permissions, " +
      "add Application permission Sites.Read.All (or Sites.Selected + site grant) and click Grant admin consent."
    );
  }

  if (lower.includes("invalid hostname") || lower.includes("invalidhostname")) {
    return (
      `${err}. ` +
      "Check the hostname (e.g. contoso.sharepoint.com, not contoso-my.sharepoint.com)."
    );
  }

  if (
    lower.includes("itemnotfound") ||
    lower.includes("not found") ||
    status === 404
  ) {
    return (
      `${err}. ` +
      "No site matched that URL. Paste the site home URL only, e.g. " +
      "https://contoso.sharepoint.com/sites/ClientName — not a file or sharing link."
    );
  }

  if (lower.includes("general exception") || lower.includes("generalexception")) {
    return (
      `${err}. ` +
      "Often caused by a library/file URL instead of a site URL, missing admin consent for Sites.Read.All, " +
      "or Sites.Selected without a site permission grant. " +
      "Try the site home page URL (…/sites/YourSite) and confirm admin consent in Azure."
    );
  }

  if (lower.includes("unauthorized") || status === 401) {
    return (
      `${err}. ` +
      "Token rejected — verify MICROSOFT_TENANT_ID, CLIENT_ID, and CLIENT_SECRET belong to the same app registration."
    );
  }

  return err;
}

/**
 * Resolve a SharePoint site from its web URL (or Graph site id) via Microsoft Graph.
 * Tries several strategies because tenants differ in how paths resolve.
 * @param auth Optional per-client Entra tenant string or full credential override.
 */
export async function resolveSiteByUrl(
  siteUrl: string,
  auth?: GraphConfig | GraphCredentialOverride | string | null,
): Promise<GraphSite> {
  const parsed = parseSharePointSiteUrl(siteUrl);
  if (!parsed) {
    throw new Error(
      "Invalid SharePoint URL. Use a site link like https://contoso.sharepoint.com/sites/YourSite " +
        "(not a personal OneDrive or file-sharing link).",
    );
  }

  // Direct site id paste
  if (parsed.siteId) {
    const result = await graphFetch<GraphSite>(
      `/sites/${siteIdPathSegment(parsed.siteId)}`,
      undefined,
      auth,
    );
    if (!result.ok) {
      throw new Error(
        humanizeGraphError(result.error, result.code, result.status),
      );
    }
    return result.data;
  }

  const encodedPath = encodeSitePath(parsed.sitePath);
  const attempts: string[] = [];

  // 1) Canonical: /sites/{hostname}:/{server-relative-path}
  if (parsed.sitePath === "/") {
    attempts.push(`/sites/${parsed.hostname}:/`);
    // Root site alternate
    attempts.push(`/sites/${parsed.hostname}`);
  } else {
    attempts.push(`/sites/${parsed.hostname}:${encodedPath}`);
    // Trailing colon form (required by some Graph operations / older samples)
    attempts.push(`/sites/${parsed.hostname}:${encodedPath}:`);
    // Unencoded path fallback (some tenants dislike double-encoding)
    attempts.push(`/sites/${parsed.hostname}:${parsed.sitePath}`);
    attempts.push(`/sites/${parsed.hostname}:${parsed.sitePath}:`);
  }

  const errors: string[] = [];
  for (const path of attempts) {
    const result = await graphFetch<GraphSite>(path, undefined, auth);
    if (result.ok && result.data?.id) {
      return result.data;
    }
    if (!result.ok) {
      errors.push(`${path} → ${result.code || result.status}: ${result.error}`);
    }
  }

  // 2) Search by site name (last path segment)
  const siteName =
    parsed.sitePath === "/"
      ? null
      : parsed.sitePath.split("/").filter(Boolean).pop() || null;

  if (siteName) {
    const search = await graphFetch<{ value?: GraphSite[] }>(
      `/sites?search=${encodeURIComponent(siteName)}&$select=id,displayName,name,webUrl`,
      undefined,
      auth,
    );
    if (search.ok && search.data.value?.length) {
      const host = parsed.hostname.toLowerCase();
      const wantPath = parsed.sitePath.toLowerCase();
      const match =
        search.data.value.find((s) => {
          try {
            if (!s.webUrl) return false;
            const u = new URL(s.webUrl);
            const p = u.pathname.replace(/\/+$/, "").toLowerCase() || "/";
            return (
              u.hostname.toLowerCase() === host &&
              (p === wantPath || p.endsWith(wantPath))
            );
          } catch {
            return false;
          }
        }) ||
        search.data.value.find((s) =>
          (s.webUrl || "").toLowerCase().includes(host),
        ) ||
        search.data.value[0];

      if (match?.id) return match;
    } else if (!search.ok) {
      errors.push(`search → ${search.code || search.status}: ${search.error}`);
    }
  }

  const last = errors[errors.length - 1] || "Unknown Graph error";
  const lastCode = last.match(/→\s*([^:]+):/)?.[1];
  throw new Error(
    humanizeGraphError(
      `Could not resolve SharePoint site (${parsed.hostname}${parsed.sitePath}). ${last}`,
      lastCode,
    ),
  );
}

/**
 * List children of a folder in the site's default document library.
 * folderPath is relative to the drive root, e.g. "Shared Documents/Manuals"
 * or empty for root.
 *
 * Note: default drive root is usually already the Documents library, so
 * paths should typically NOT start with "Shared Documents" / "Documents"
 * unless that is a subfolder name. We try the path as-is, then strip a
 * leading library segment if Graph returns not found.
 */
export async function listDriveChildren(
  siteId: string,
  folderPath: string,
  auth?: GraphConfig | GraphCredentialOverride | string | null,
): Promise<GraphDriveItem[]> {
  const idSeg = siteIdPathSegment(siteId);

  const buildPath = (folder: string) => {
    const clean = folder
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join("/");
    return clean
      ? `/sites/${idSeg}/drive/root:/${clean}:/children?$top=200`
      : `/sites/${idSeg}/drive/root/children?$top=200`;
  };

  const tryList = async (folder: string) => {
    const result = await graphFetch<{ value?: GraphDriveItem[] }>(
      buildPath(folder),
      undefined,
      auth,
    );
    return result;
  };

  let folder = folderPath.replace(/^\/+|\/+$/g, "");
  let result = await tryList(folder);

  // If path starts with library name but default drive is already that library,
  // strip the first segment and retry.
  if (
    !result.ok &&
    folder &&
    (result.status === 404 ||
      (result.code || "").toLowerCase().includes("itemnotfound") ||
      (result.error || "").toLowerCase().includes("not found"))
  ) {
    const segs = folder.split("/").filter(Boolean);
    if (segs.length > 0) {
      const first = segs[0].toLowerCase();
      if (
        first === "shared documents" ||
        first === "documents" ||
        first === "shared%20documents" ||
        first === "documentation" ||
        first.endsWith("documents")
      ) {
        const stripped = segs.slice(1).join("/");
        const retry = await tryList(stripped);
        if (retry.ok) {
          return retry.data.value ?? [];
        }
        // Prefer the more specific retry error if both failed
        result = retry;
        folder = stripped;
      }
    }
  }

  if (!result.ok) {
    throw new Error(humanizeGraphError(result.error, result.code, result.status));
  }
  return result.data.value ?? [];
}

/**
 * Build the effective folder path from admin settings + optional URL extras + browse path.
 */
export function joinFolderPath(
  ...parts: Array<string | null | undefined>
): string {
  const segs: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    for (const s of p.split(/[/\\]+/)) {
      const t = s.trim();
      if (!t || t === ".") continue;
      // Drop UI artifacts if they slipped in
      if (t.toLowerCase() === "forms") break;
      if (t.toLowerCase().endsWith(".aspx")) break;
      segs.push(t);
    }
  }
  return segs.join("/");
}
