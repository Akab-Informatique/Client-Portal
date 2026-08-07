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
 * Build same-origin SOS installer stream URL (Content-Disposition: attachment).
 * Never points at Splashtop HTML.
 */
export function sosInstallerFileUrl(
  requestId: number,
  platform: "auto" | "win" | "mac" = "auto",
): string {
  const q = new URLSearchParams({
    id: String(requestId),
    platform,
    file: "1",
  });
  return `/api/sos/download?${q.toString()}`;
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
  building?: boolean;
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
    // Metadata probe (JSON). The actual file is always sosInstallerFileUrl().
    const q = new URLSearchParams({
      id: String(requestId),
      platform,
    });
    const r = await fetch(`/api/sos/download?${q}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const d = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      downloadUrl?: string;
      fileName?: string;
      platform?: string;
      error?: string;
    };
    const fileUrl = sosInstallerFileUrl(
      requestId,
      (d.platform === "mac" || d.platform === "win" ? d.platform : platform) as
        | "auto"
        | "win"
        | "mac",
    );
    if (!r.ok) {
      const msg = errMsg(d, `Download failed (${r.status})`);
      const building = /still building|try Download again/i.test(msg);
      return {
        ok: false,
        downloadUrl: fileUrl,
        fileName: d.fileName ?? null,
        platform: d.platform,
        error: msg,
        building,
      };
    }
    return {
      ok: true,
      downloadUrl: fileUrl,
      fileName:
        d.fileName ??
        (d.platform === "mac" ? "SplashtopSOS.dmg" : "SplashtopSOS.exe"),
      platform: d.platform,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      downloadUrl: sosInstallerFileUrl(requestId, platform),
      fileName: null,
      error: e instanceof Error ? e.message : "Download failed",
    };
  }
}

/**
 * Start the SOS installer download WITHOUT leaving the portal.
 *
 * Prefer a hidden iframe pointed at our same-origin attachment proxy.
 * That works after async session create (browsers often block blob/a.click
 * once the original user gesture is gone). Manual retries should use a real
 * <a href> click (see SosButton).
 *
 * NEVER navigates to Splashtop HTML / support portal pages.
 */
export function triggerSosDownload(
  url: string | null | undefined,
  fileName?: string | null,
): boolean {
  const href = String(url ?? "").trim();
  if (!href) return false;

  // Refuse known HTML portal hosts — installer only
  if (
    /^https?:\/\//i.test(href) &&
    !href.startsWith(window.location.origin) &&
    (/my\.splashtop\.com/i.test(href) ||
      /support_portal|service_desk\/psa/i.test(href))
  ) {
    console.warn("[sos] refused external portal HTML link", href.slice(0, 80));
    return false;
  }

  // Resolve to absolute same-origin when possible
  let abs = href;
  try {
    abs = new URL(href, window.location.origin).toString();
  } catch {
    /* keep */
  }

  try {
    // 1) Hidden iframe — Content-Disposition: attachment on the proxy
    //    triggers a file save without navigating the app shell.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:0;left:-9999px;top:0;opacity:0;pointer-events:none";
    iframe.src = abs;
    document.body.appendChild(iframe);
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    }, 120_000);

    // 2) Also fire a same-origin <a download> as a backup (helps some browsers)
    try {
      const a = document.createElement("a");
      a.href = abs;
      a.download = (fileName || "").trim() || "SplashtopSOS.exe";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        try {
          a.remove();
        } catch {
          /* ignore */
        }
      }, 0);
    } catch {
      /* iframe is primary */
    }

    return true;
  } catch (e) {
    console.warn("[sos] download trigger failed", e);
    return false;
  }
}

/**
 * Optional blob path — only call from a fresh user click if iframe failed.
 * Kept for the manual "Download again" fallback path.
 */
export async function triggerSosDownloadBlob(
  url: string | null | undefined,
  fileName?: string | null,
): Promise<boolean> {
  const href = String(url ?? "").trim();
  if (!href) return false;
  try {
    const res = await fetch(href, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/octet-stream,*/*" },
    });
    if (!res.ok) return false;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/json")) return false;
    const blob = await res.blob();
    if (!blob || blob.size < 1024) return false;
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
  } catch {
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
