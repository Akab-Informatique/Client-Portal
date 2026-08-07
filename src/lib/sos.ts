export type SosStatus =
  | "open"
  | "waiting"
  | "ready"
  | "connected"
  | "closed"
  | "expired"
  | "error";

export type SosRequest = {
  id: number;
  companyId: number;
  companyName: string;
  userId: number;
  userName: string;
  userEmail: string;
  issue: string | null;
  status: SosStatus | string;
  supportPortalLink: string | null;
  sosCode?: string | null;
  connectUrl?: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  closedAt: string | null;
  lastPolledAt: string | null;
  remoteSnapshot?: string | null;
};

function errMsg(d: unknown, fallback: string): string {
  if (d && typeof d === "object" && "error" in d) {
    const e = (d as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e;
  }
  return fallback;
}

export async function createSosRequest(input: {
  userId: number;
  userName: string;
  userEmail: string;
  companyId: number;
  companyName: string;
  issue?: string | null;
}): Promise<{ request: SosRequest | null; error: string | null; reused?: boolean }> {
  const r = await fetch("/api/sos/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const d = (await r.json()) as {
    request?: SosRequest;
    error?: string;
    reused?: boolean;
  };
  if (!r.ok && !d.request) {
    return { request: null, error: errMsg(d, `SOS failed (${r.status})`) };
  }
  return {
    request: d.request ?? null,
    error: d.error ? String(d.error) : null,
    reused: d.reused,
  };
}

export async function fetchClientSosRequests(
  userId: number,
): Promise<{ requests: SosRequest[]; error: string | null; configured: boolean }> {
  const q = new URLSearchParams({
    role: "client",
    userId: String(userId),
    refresh: "1",
  });
  const r = await fetch(`/api/sos/requests?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as {
    requests?: SosRequest[];
    error?: string;
    configured?: boolean;
  };
  if (!r.ok) {
    return {
      requests: [],
      configured: Boolean(d.configured),
      error: errMsg(d, `SOS list failed (${r.status})`),
    };
  }
  return {
    requests: Array.isArray(d.requests) ? d.requests : [],
    configured: Boolean(d.configured),
    error: d.error ? String(d.error) : null,
  };
}

export async function fetchStaffSosQueue(opts?: {
  includeClosed?: boolean;
}): Promise<{
  requests: SosRequest[];
  openCount: number;
  configured: boolean;
  error: string | null;
}> {
  const q = new URLSearchParams({ role: "staff", refresh: "1" });
  if (opts?.includeClosed) q.set("includeClosed", "1");
  const r = await fetch(`/api/sos/requests?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as {
    requests?: SosRequest[];
    openCount?: number;
    configured?: boolean;
    error?: string;
  };
  if (!r.ok) {
    return {
      requests: [],
      openCount: 0,
      configured: Boolean(d.configured),
      error: errMsg(d, `SOS queue failed (${r.status})`),
    };
  }
  return {
    requests: Array.isArray(d.requests) ? d.requests : [],
    openCount: Number(d.openCount ?? 0),
    configured: Boolean(d.configured),
    error: d.error ? String(d.error) : null,
  };
}

export async function closeSosRequest(
  id: number,
  closedByUserId?: number | null,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await fetch(`/api/sos/requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      action: "close",
      role: "staff",
      closedByUserId: closedByUserId ?? null,
    }),
  });
  const d = (await r.json()) as { error?: string; ok?: boolean };
  if (!r.ok) return { ok: false, error: errMsg(d, `Close failed (${r.status})`) };
  return { ok: true, error: null };
}

export async function fetchSplashtopStatus(refresh = false): Promise<{
  ok: boolean;
  configured: boolean;
  authOk?: boolean;
  teamId?: string | null;
  baseUrl?: string | null;
  message?: string;
  error?: string;
}> {
  const q = refresh ? "?refresh=1" : "";
  const r = await fetch(`/api/splashtop/status${q}`, {
    headers: { Accept: "application/json" },
  });
  return (await r.json()) as {
    ok: boolean;
    configured: boolean;
    authOk?: boolean;
    teamId?: string | null;
    baseUrl?: string | null;
    message?: string;
    error?: string;
  };
}

export function formatSosTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

export type SosPackageConfig = {
  ok: boolean;
  packageName: string;
  autoDownload: boolean;
  mode: "session" | "package" | "both";
  hasCustomPackage: boolean;
  packageUrls: {
    share: string | null;
    windows: string | null;
    mac: string | null;
    linux: string | null;
    android: string | null;
  };
  hints?: {
    createPackage?: string;
    applyToApiSessions?: string;
    envKeys?: string[];
  };
  error?: string;
};

export async function fetchSosPackageConfig(): Promise<SosPackageConfig> {
  try {
    const r = await fetch("/api/sos/package-config", {
      headers: { Accept: "application/json" },
    });
    const d = (await r.json()) as SosPackageConfig;
    if (!r.ok) {
      return {
        ok: false,
        packageName: "Remote support",
        autoDownload: true,
        mode: "session",
        hasCustomPackage: false,
        packageUrls: {
          share: null,
          windows: null,
          mac: null,
          linux: null,
          android: null,
        },
        error: errMsg(d, `Package config failed (${r.status})`),
      };
    }
    return {
      ok: Boolean(d.ok),
      packageName: d.packageName || "Remote support",
      autoDownload: d.autoDownload !== false,
      mode: d.mode === "package" || d.mode === "both" ? d.mode : "session",
      hasCustomPackage: Boolean(d.hasCustomPackage),
      packageUrls: {
        share: d.packageUrls?.share ?? null,
        windows: d.packageUrls?.windows ?? null,
        mac: d.packageUrls?.mac ?? null,
        linux: d.packageUrls?.linux ?? null,
        android: d.packageUrls?.android ?? null,
      },
      hints: d.hints,
    };
  } catch (e) {
    return {
      ok: false,
      packageName: "Remote support",
      autoDownload: true,
      mode: "session",
      hasCustomPackage: false,
      packageUrls: {
        share: null,
        windows: null,
        mac: null,
        linux: null,
        android: null,
      },
      error: e instanceof Error ? e.message : "Package config failed",
    };
  }
}

export async function fetchSosRequestById(
  id: number,
  role: "client" | "staff" = "client",
): Promise<{ request: SosRequest | null; error: string | null }> {
  const q = new URLSearchParams({ role });
  const r = await fetch(`/api/sos/requests/${id}?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as { request?: SosRequest; error?: string };
  if (!r.ok) {
    return { request: null, error: errMsg(d, `SOS request failed (${r.status})`) };
  }
  return { request: d.request ?? null, error: d.error ? String(d.error) : null };
}

/** Detect client OS for package picker (best-effort). */
export function detectClientOs(): "windows" | "mac" | "linux" | "android" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "other";
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

/**
 * Resolve the session-bound SOS installer via our same-origin proxy.
 * Returns `/api/sos/download?...&file=1` — never a Splashtop HTML portal page.
 */
export async function fetchSosInstallerDownload(
  requestId: number,
  platform: "auto" | "win" | "mac" = "auto",
): Promise<{
  ok: boolean;
  downloadUrl: string | null;
  fileName: string | null;
  platform?: string;
  error: string | null;
}> {
  if (!requestId || requestId <= 0) {
    return {
      ok: false,
      downloadUrl: null,
      fileName: null,
      error: "Missing request id",
    };
  }
  try {
    const q = new URLSearchParams({
      id: String(requestId),
      platform,
    });
    const r = await fetch(`/api/sos/download?${q}`, {
      headers: { Accept: "application/json" },
    });
    const d = (await r.json()) as {
      ok?: boolean;
      downloadUrl?: string;
      fileName?: string;
      platform?: string;
      error?: string;
    };
    if (!r.ok || !d.downloadUrl) {
      return {
        ok: false,
        downloadUrl: null,
        fileName: null,
        platform: d.platform,
        error: errMsg(d, `Download failed (${r.status})`),
      };
    }
    // Always prefer same-origin stream URL (file=1)
    let downloadUrl = String(d.downloadUrl).trim();
    if (downloadUrl && !downloadUrl.includes("file=1")) {
      const u = downloadUrl.startsWith("http")
        ? new URL(downloadUrl)
        : new URL(downloadUrl, window.location.origin);
      u.searchParams.set("file", "1");
      downloadUrl = u.pathname + u.search;
    }
    return {
      ok: true,
      downloadUrl,
      fileName: d.fileName ?? null,
      platform: d.platform,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      downloadUrl: null,
      fileName: null,
      error: e instanceof Error ? e.message : "Download failed",
    };
  }
}

/**
 * Download the SOS installer file and stay on the portal page.
 * Uses blob + download attribute for same-origin proxy URLs.
 * NEVER navigates to Splashtop HTML / support portal pages.
 */
export async function triggerSosDownload(
  url: string | null | undefined,
  fileName?: string | null,
): Promise<boolean> {
  const href = String(url ?? "").trim();
  if (!href) return false;

  // Block known HTML portal hosts — installer only
  if (
    /my\.splashtop\.com\/(service_desk|sos|download_client)/i.test(href) ||
    /support_portal|service_desk\/psa/i.test(href)
  ) {
    console.warn("[sos] refused portal HTML link", href.slice(0, 80));
    return false;
  }

  try {
    // Same-origin proxy or any absolute URL we can fetch as blob
    const res = await fetch(href, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/octet-stream,*/*" },
    });
    if (!res.ok) {
      // If server returned JSON error, surface false
      return false;
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/json")) {
      // Not a binary installer
      return false;
    }
    const blob = await res.blob();
    if (!blob || blob.size < 1024) {
      // Tiny payload is almost certainly an error page
      return false;
    }
    let name = (fileName || "").trim();
    if (!name) {
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(cd);
      if (m?.[1]) name = decodeURIComponent(m[1].replace(/"/g, ""));
    }
    if (!name) {
      name = /mac|dmg/i.test(href) ? "SplashtopSOS.dmg" : "SplashtopSOS.exe";
    }
    const { downloadBlob } = await import("@/lib/download");
    downloadBlob(blob, name);
    return true;
  } catch (e) {
    console.warn("[sos] download failed", e);
    return false;
  }
}

/**
 * @deprecated kept for type compat — SOS no longer opens blank windows.
 */
export function openPendingSosWindow(): Window | null {
  return null;
}

/**
 * @deprecated — do not navigate to portal links for client SOS.
 */
export function navigatePendingSosWindow(
  pending: Window | null,
  _url?: string | null,
): boolean {
  try {
    pending?.close();
  } catch {
    /* ignore */
  }
  return false;
}

export function openClientPortalLink(url: string | null | undefined): boolean {
  const href = String(url ?? "").trim();
  if (!href) return false;
  try {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    // Keep it in the DOM briefly so some browsers honor the navigation
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch {
        /* ignore */
      }
    }, 0);
    return true;
  } catch {
    try {
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    } catch {
      return false;
    }
  }
}

/** Normalize / repair a stored portal link on the client if needed. */
export function ensureClientPortalHref(
  link: string | null | undefined,
): string | null {
  const raw = String(link ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `https://my.splashtop.com${raw}`;
  if (/^[a-z0-9.-]+(\/|$)/i.test(raw)) return `https://${raw}`;
  return raw;
}
