/** Client helpers for Datto RMM devices / sites */

export type DattoRmmSite = {
  uid: string;
  name: string;
  description: string | null;
  autotaskCompanyId: number | null;
  devicesStatus: {
    numberOfDevices: number | null;
    numberOfOnlineDevices: number | null;
    numberOfOfflineDevices: number | null;
  } | null;
};

export type DattoRmmDevice = {
  uid: string;
  siteUid: string | null;
  siteName: string | null;
  hostname: string;
  deviceType: string | null;
  deviceClass: string | null;
  operatingSystem: string | null;
  internalIp: string | null;
  externalIp: string | null;
  lastSeen: string | null;
  lastUser: string | null;
  online: boolean | null;
  suspended: boolean | null;
  rebootRequired: boolean | null;
  domain: string | null;
  description: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  warrantyDate: string | null;
  cagVersion: string | null;
  portalUrl: string | null;
  /** Datto Web Remote deep link (opens in new tab; requires RMM login) */
  webRemoteUrl: string | null;
};

/**
 * Build a Datto Web Remote URL in the browser when the API omitted it.
 * Uses apiUrl from /api/datto-rmm/status (e.g. https://merlot-api.centrastage.net).
 */
export function buildClientWebRemoteUrl(
  deviceUid: string | null | undefined,
  apiUrl?: string | null,
): string | null {
  const uid = String(deviceUid ?? "").trim();
  if (!uid) return null;
  const raw = String(apiUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const m =
      host.match(/^([a-z0-9-]+)-api\./i) ||
      host.match(/^([a-z0-9-]+)\.rmm\.datto\.com$/i) ||
      host.match(/^([a-z0-9-]+)\.centrastage\.net$/i);
    const platform =
      m?.[1]?.replace(/-api$/i, "") ||
      (host.split(".")[0] || "").replace(/-api$/i, "");
    if (!platform || platform === "api") return null;
    // Modern Datto UI path
    return `https://${platform}.rmm.datto.com/web-remote/${encodeURIComponent(uid)}`;
  } catch {
    return null;
  }
}

/** Prefer API webRemoteUrl; fall back to client-built URL from status apiUrl. */
export function resolveWebRemoteUrl(
  device: Pick<DattoRmmDevice, "uid" | "webRemoteUrl">,
  apiUrl?: string | null,
): string | null {
  const fromApi = String(device.webRemoteUrl ?? "").trim();
  if (fromApi) return fromApi;
  return buildClientWebRemoteUrl(device.uid, apiUrl);
}

/** Open Datto Web Remote for a device in a new tab (user-gesture safe). */
export function openDattoWebRemote(url: string | null | undefined): boolean {
  const href = String(url ?? "").trim();
  if (!href) return false;
  try {
    // Prefer window.open from the click handler so popup blockers allow it.
    const win = window.open(href, "_blank", "noopener,noreferrer");
    if (win) {
      try {
        win.opener = null;
      } catch {
        /* ignore */
      }
      return true;
    }
  } catch {
    /* fall through to anchor */
  }
  try {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
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
    return false;
  }
}

/** Parse JSON list of Datto device UIDs a client user may Web Remote. */
export function parseWebRemoteDeviceUids(
  raw: string | null | undefined,
): string[] {
  if (!raw || !String(raw).trim()) return [];
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const uid = String(item ?? "").trim();
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      out.push(uid);
    }
    return out;
  } catch {
    // Comma / whitespace separated fallback
    return String(raw)
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

export function serializeWebRemoteDeviceUids(uids: string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of uids) {
    const uid = String(u ?? "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out.length ? JSON.stringify(out) : null;
}

/** Client user may Web Remote this device only if UID is in their grant list. */
export function clientCanWebRemoteDevice(
  grantedUids: string[] | null | undefined,
  deviceUid: string | null | undefined,
): boolean {
  const uid = String(deviceUid ?? "").trim();
  if (!uid) return false;
  const list = grantedUids ?? [];
  return list.includes(uid);
}

export type DattoRmmStatusResponse = {
  configured: boolean;
  ok: boolean;
  apiUrl?: string;
  /** Datto RMM web portal (sign-in here once so Web Remote deep links work) */
  portalUrl?: string | null;
  siteCount?: number | null;
  accountName?: string | null;
  error?: string | null;
  hint?: string;
};

/**
 * Derive Datto portal base URL from API URL when status omits portalUrl.
 * e.g. https://merlot-api.centrastage.net → https://merlot.rmm.datto.com
 */
export function buildDattoPortalUrl(apiUrl?: string | null): string | null {
  const raw = String(apiUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const m =
      host.match(/^([a-z0-9-]+)-api\./i) ||
      host.match(/^([a-z0-9-]+)\.rmm\.datto\.com$/i) ||
      host.match(/^([a-z0-9-]+)\.centrastage\.net$/i);
    const platform =
      m?.[1]?.replace(/-api$/i, "") ||
      (host.split(".")[0] || "").replace(/-api$/i, "");
    if (!platform || platform === "api") return null;
    return `https://${platform}.rmm.datto.com`;
  } catch {
    return null;
  }
}

/** Prefer status.portalUrl, else derive from apiUrl. */
export function resolveDattoPortalUrl(
  status?: Pick<DattoRmmStatusResponse, "portalUrl" | "apiUrl"> | null,
): string | null {
  const fromStatus = String(status?.portalUrl ?? "").trim().replace(/\/+$/, "");
  if (fromStatus) return fromStatus;
  return buildDattoPortalUrl(status?.apiUrl);
}

function formatErr(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; error?: unknown };
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") return o.message;
  }
  return fallback;
}

export async function fetchDattoRmmStatus(
  refresh = false,
): Promise<DattoRmmStatusResponse> {
  try {
    const q = refresh ? "?refresh=1" : "";
    const res = await fetch(`/api/datto-rmm/status${q}`, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json().catch(() => ({}))) as DattoRmmStatusResponse;
    return {
      configured: Boolean(data.configured),
      ok: Boolean(data.ok),
      apiUrl: data.apiUrl,
      portalUrl: data.portalUrl ?? null,
      siteCount: data.siteCount ?? null,
      accountName: data.accountName ?? null,
      error: data.error ?? null,
      hint: data.hint,
    };
  } catch (e) {
    return {
      configured: false,
      ok: false,
      error: e instanceof Error ? e.message : "Status check failed",
    };
  }
}

export async function fetchDattoRmmSites(q?: string): Promise<{
  sites: DattoRmmSite[];
  configured: boolean;
  total?: number;
  error: string | null;
}> {
  try {
    const params = new URLSearchParams();
    if (q?.trim()) params.set("q", q.trim());
    const qs = params.toString();
    const res = await fetch(`/api/datto-rmm/sites${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as {
      sites?: DattoRmmSite[];
      configured?: boolean;
      total?: number;
      error?: string;
    };
    if (!res.ok) {
      return {
        sites: [],
        configured: Boolean(data.configured),
        error: formatErr(data, `Sites failed (${res.status})`),
      };
    }
    return {
      sites: Array.isArray(data.sites) ? data.sites : [],
      configured: Boolean(data.configured),
      total: data.total,
      error: data.error ? String(data.error) : null,
    };
  } catch (e) {
    return {
      sites: [],
      configured: false,
      error: e instanceof Error ? e.message : "Failed to load sites",
    };
  }
}

export async function fetchDattoRmmDevices(siteUid: string): Promise<{
  devices: DattoRmmDevice[];
  configured: boolean;
  count: number;
  onlineCount: number;
  offlineCount: number;
  error: string | null;
}> {
  try {
    const q = new URLSearchParams({ siteUid });
    const res = await fetch(`/api/datto-rmm/devices?${q}`, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as {
      devices?: DattoRmmDevice[];
      configured?: boolean;
      count?: number;
      onlineCount?: number;
      offlineCount?: number;
      error?: string;
    };
    if (!res.ok) {
      return {
        devices: [],
        configured: Boolean(data.configured),
        count: 0,
        onlineCount: 0,
        offlineCount: 0,
        error: formatErr(data, `Devices failed (${res.status})`),
      };
    }
    const devices = Array.isArray(data.devices) ? data.devices : [];
    return {
      devices,
      configured: Boolean(data.configured),
      count: data.count ?? devices.length,
      onlineCount:
        data.onlineCount ?? devices.filter((d) => d.online === true).length,
      offlineCount:
        data.offlineCount ?? devices.filter((d) => d.online === false).length,
      error: data.error ? String(data.error) : null,
    };
  } catch (e) {
    return {
      devices: [],
      configured: false,
      count: 0,
      onlineCount: 0,
      offlineCount: 0,
      error: e instanceof Error ? e.message : "Failed to load devices",
    };
  }
}

export function formatDeviceLastSeen(
  iso: string | null | undefined,
  locale = "en",
): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}
