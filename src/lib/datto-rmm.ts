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
};

export type DattoRmmStatusResponse = {
  configured: boolean;
  ok: boolean;
  apiUrl?: string;
  siteCount?: number | null;
  accountName?: string | null;
  error?: string | null;
  hint?: string;
};

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
