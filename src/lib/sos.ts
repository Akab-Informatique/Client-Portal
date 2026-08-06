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
 * Pick the best auto-download URL for the branded download page.
 * Session portal link is preferred for API-bound sessions (no code to share).
 * Custom package URLs are used when mode is package/both or as OS-specific buttons.
 */
export function pickSosDownloadUrl(opts: {
  supportPortalLink?: string | null;
  packageConfig?: SosPackageConfig | null;
  preferPackage?: boolean;
}): string | null {
  const session = ensureClientPortalHref(opts.supportPortalLink);
  const cfg = opts.packageConfig;
  const urls = cfg?.packageUrls;
  const os = detectClientOs();
  const osUrl =
    os === "windows"
      ? urls?.windows
      : os === "mac"
        ? urls?.mac
        : os === "linux"
          ? urls?.linux
          : os === "android"
            ? urls?.android
            : null;
  const packageUrl = osUrl || urls?.share || null;

  const mode = cfg?.mode ?? "session";
  if (opts.preferPackage || mode === "package") {
    return packageUrl || session;
  }
  if (mode === "both") {
    // Auto-start session (API binding); package buttons remain on the page
    return session || packageUrl;
  }
  return session || packageUrl;
}

/** Trigger a file download / navigation without leaving the branded page. */
export function triggerSosDownload(url: string | null | undefined): boolean {
  const href = String(url ?? "").trim();
  if (!href) return false;
  try {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    // Same-tab download for direct .exe/.dmg; new tab for HTML portal pages
    const isDirectFile = /\.(exe|dmg|pkg|msi|apk|zip)(\?|#|$)/i.test(href);
    if (isDirectFile) {
      a.setAttribute("download", "");
      a.target = "_self";
    } else {
      a.target = "_blank";
    }
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

/**
 * Open a blank tab/window synchronously (must run in the click handler).
 * After the async create-session call, navigate it to the portal link so the
 * download starts without being blocked as a late popup.
 */
export function openPendingSosWindow(): Window | null {
  try {
    const w = window.open("about:blank", "_blank");
    if (w) {
      try {
        w.document.title = "SOS…";
        w.document.body.innerHTML =
          '<p style="font-family:system-ui,sans-serif;padding:24px;color:#334">Starting remote support…</p>';
      } catch {
        /* cross-origin / opaque about:blank — fine */
      }
    }
    return w;
  } catch {
    return null;
  }
}

/** Navigate a window opened via openPendingSosWindow, or fall back to a link click. */
export function navigatePendingSosWindow(
  pending: Window | null,
  url: string | null | undefined,
): boolean {
  const href = String(url ?? "").trim();
  if (!href) {
    try {
      pending?.close();
    } catch {
      /* ignore */
    }
    return false;
  }
  if (pending && !pending.closed) {
    try {
      pending.location.href = href;
      try {
        pending.focus();
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      /* fall through */
    }
  }
  return openClientPortalLink(href);
}

/**
 * Open the end-user Splashtop session link.
 * Prefer a real <a> click over window.open — popup blockers and sandboxed
 * preview iframes often swallow window.open() after async work.
 */
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
