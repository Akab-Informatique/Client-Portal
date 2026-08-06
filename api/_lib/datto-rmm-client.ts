/**
 * Datto RMM (CentraStage) API client — server-side only.
 *
 * Auth: OAuth2 password grant with public-client / public Basic auth,
 * using the per-user API Key + API Secret as username/password.
 * Docs: https://rmm.datto.com/help/en/Content/2SETUP/APIv2.htm
 */

export type DattoRmmConfig = {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
};

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
  /**
   * Browser Web Remote launch URL for this device.
   * Opens Datto RMM HTML5 remote (technician must be logged into the RMM portal).
   */
  webRemoteUrl: string | null;
};

function cleanEnv(value: string | undefined | null): string {
  if (!value) return "";
  let v = String(value).trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function getDattoRmmConfigFromEnv(): DattoRmmConfig | null {
  const apiUrl = cleanEnv(process.env.DATTO_RMM_API_URL).replace(/\/+$/, "");
  const apiKey = cleanEnv(process.env.DATTO_RMM_API_KEY);
  const apiSecret = cleanEnv(process.env.DATTO_RMM_API_SECRET);
  if (!apiUrl || !apiKey || !apiSecret) return null;
  return { apiUrl, apiKey, apiSecret };
}

export function isDattoRmmConfigured(): boolean {
  return getDattoRmmConfigFromEnv() != null;
}

/**
 * Derive the Datto RMM web portal base from the API URL.
 *   merlot-api.centrastage.net  → https://merlot.centrastage.net
 * Override with DATTO_RMM_PORTAL_URL when needed.
 */
export function getDattoRmmPortalBaseUrl(
  cfg?: DattoRmmConfig | null,
): string | null {
  const override = cleanEnv(process.env.DATTO_RMM_PORTAL_URL).replace(
    /\/+$/,
    "",
  );
  if (override) return override;

  const apiUrl = (cfg ?? getDattoRmmConfigFromEnv())?.apiUrl;
  if (!apiUrl) return null;
  try {
    const u = new URL(apiUrl);
    // merlot-api.centrastage.net → merlot.centrastage.net
    const host = u.hostname.replace(/-api(?=\.)/i, "").replace(/^api\./i, "");
    return `${u.protocol}//${host}`;
  } catch {
    return null;
  }
}

/**
 * Web Remote deep link for a device UID.
 * Classic path used by Datto UI / integrations:
 *   https://{platform}.centrastage.net/csm/remote/rto/{deviceUid}
 */
export function buildDattoWebRemoteUrl(
  deviceUid: string,
  cfg?: DattoRmmConfig | null,
): string | null {
  const uid = String(deviceUid || "").trim();
  if (!uid) return null;
  const portal = getDattoRmmPortalBaseUrl(cfg);
  if (!portal) return null;
  return `${portal}/csm/remote/rto/${encodeURIComponent(uid)}`;
}

/** Cached bearer token (expires ~100h; we refresh earlier). */
let tokenCache: { token: string; expiresAt: number } | null = null;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function pickNumber(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function pickBool(raw: Record<string, unknown>, keys: string[]): boolean | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "boolean") return v;
  }
  return null;
}

/** Datto timestamps are often Unix ms. */
function toIsoFromDatto(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

async function fetchAccessToken(cfg: DattoRmmConfig): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const basic = Buffer.from("public-client:public").toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: cfg.apiKey,
    password: cfg.apiSecret,
  });

  const res = await fetch(`${cfg.apiUrl}/auth/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const r = asRecord(data);
    const msg =
      (r && pickString(r, ["error_description", "error", "message"])) ||
      `Datto RMM auth failed (${res.status})`;
    throw new Error(msg);
  }
  const r = asRecord(data);
  const token = r ? pickString(r, ["access_token"]) : "";
  if (!token) throw new Error("Datto RMM auth returned no access_token");
  const expiresIn = r ? pickNumber(r, ["expires_in"]) : null;
  // Default ~100h; refresh 1h early
  const ttlMs = Math.max(60_000, ((expiresIn ?? 360_000) - 3600) * 1000);
  tokenCache = { token, expiresAt: now + ttlMs };
  return token;
}

export function clearDattoRmmTokenCache(): void {
  tokenCache = null;
}

async function dattoFetch(
  cfg: DattoRmmConfig,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const token = await fetchAccessToken(cfg);
  const url = path.startsWith("http")
    ? path
    : `${cfg.apiUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  // One retry on 401 with fresh token
  if (res.status === 401) {
    clearDattoRmmTokenCache();
    const token2 = await fetchAccessToken(cfg);
    const res2 = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token2}`,
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const text2 = await res2.text();
    let data2: unknown = null;
    try {
      data2 = text2 ? JSON.parse(text2) : null;
    } catch {
      data2 = { raw: text2.slice(0, 500) };
    }
    return { ok: res2.ok, status: res2.status, data: data2, text: text2 };
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data, text };
}

function pageItems(data: unknown): unknown[] {
  const r = asRecord(data);
  if (!r) return [];
  if (Array.isArray(r.sites)) return r.sites;
  if (Array.isArray(r.devices)) return r.devices;
  if (Array.isArray(r.items)) return r.items;
  if (Array.isArray(r.data)) return r.data;
  return [];
}

function nextPageUrl(data: unknown): string | null {
  const r = asRecord(data);
  if (!r) return null;
  const pd = asRecord(r.pageDetails);
  if (pd) {
    const n = pickString(pd, ["nextPageUrl", "nextPageURL"]);
    if (n) return n;
  }
  const n2 = pickString(r, ["nextPageUrl", "nextPageURL"]);
  return n2 || null;
}

async function fetchAllPages(
  cfg: DattoRmmConfig,
  firstPath: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let path: string | null = firstPath;
  let guard = 0;
  while (path && guard < 40) {
    guard += 1;
    const res = await dattoFetch(cfg, path);
    if (!res.ok) {
      const r = asRecord(res.data);
      const msg =
        (r && pickString(r, ["message", "error", "error_description"])) ||
        `Datto RMM request failed (${res.status})`;
      throw new Error(msg);
    }
    out.push(...pageItems(res.data));
    const next = nextPageUrl(res.data);
    path = next || null;
  }
  return out;
}

function mapSite(raw: unknown): DattoRmmSite | null {
  const r = asRecord(raw);
  if (!r) return null;
  const uid = pickString(r, ["uid", "siteUid", "id"]);
  if (!uid) return null;
  const name = pickString(r, ["name", "siteName"]) || uid;
  const description = pickString(r, ["description", "notes"]) || null;
  const autotaskCompanyId = pickNumber(r, [
    "autotaskCompanyId",
    "psaCompanyId",
    "companyId",
  ]);
  const ds = asRecord(r.devicesStatus) || asRecord(r.deviceStatus);
  const devicesStatus = ds
    ? {
        numberOfDevices: pickNumber(ds, [
          "numberOfDevices",
          "totalDevices",
          "devices",
        ]),
        numberOfOnlineDevices: pickNumber(ds, [
          "numberOfOnlineDevices",
          "onlineDevices",
          "online",
        ]),
        numberOfOfflineDevices: pickNumber(ds, [
          "numberOfOfflineDevices",
          "offlineDevices",
          "offline",
        ]),
      }
    : null;
  return {
    uid,
    name,
    description,
    autotaskCompanyId,
    devicesStatus,
  };
}

function mapDevice(
  raw: unknown,
  cfg?: DattoRmmConfig | null,
): DattoRmmDevice | null {
  const r = asRecord(raw);
  if (!r) return null;
  const uid = pickString(r, ["uid", "deviceUid", "id"]);
  if (!uid) return null;

  const hostname =
    pickString(r, ["hostname", "hostName", "deviceName", "name", "displayName"]) ||
    uid;

  // Nested site
  const siteObj = asRecord(r.site);
  const siteUid =
    pickString(r, ["siteUid", "siteId"]) ||
    (siteObj ? pickString(siteObj, ["uid", "id"]) : "") ||
    null;
  const siteName =
    pickString(r, ["siteName"]) ||
    (siteObj ? pickString(siteObj, ["name"]) : "") ||
    null;

  // Device type may be object or string
  const dt = r.deviceType;
  let deviceType: string | null = null;
  let deviceClass: string | null = null;
  if (typeof dt === "string") {
    deviceType = dt;
  } else {
    const dto = asRecord(dt);
    if (dto) {
      deviceType = pickString(dto, ["category", "type", "name"]) || null;
      deviceClass = pickString(dto, ["type", "deviceClass", "class"]) || null;
    }
  }
  if (!deviceClass) {
    deviceClass = pickString(r, ["deviceClass", "class"]) || null;
  }

  const operatingSystem =
    pickString(r, [
      "operatingSystem",
      "operatingSystemName",
      "os",
      "osName",
    ]) || null;

  const online = pickBool(r, ["online", "isOnline", "connected"]);
  // Some payloads use int online status
  let onlineResolved = online;
  if (onlineResolved == null) {
    const n = pickNumber(r, ["online", "status"]);
    if (n != null) onlineResolved = n > 0;
  }

  const portalUrl =
    pickString(r, ["portalUrl", "webUrl", "url", "deviceUrl"]) || null;

  return {
    uid,
    siteUid,
    siteName,
    hostname,
    deviceType,
    deviceClass,
    operatingSystem,
    internalIp: pickString(r, ["intIpAddress", "internalIp", "localIp", "ip"]) || null,
    externalIp:
      pickString(r, ["extIpAddress", "externalIp", "publicIp"]) || null,
    lastSeen: toIsoFromDatto(
      r.lastSeen ?? r.lastAuditDate ?? r.lastSeenDate ?? r.lastOnline,
    ),
    lastUser: pickString(r, ["lastUser", "lastLoggedInUser", "user"]) || null,
    online: onlineResolved,
    suspended: pickBool(r, ["suspended", "isSuspended"]),
    rebootRequired: pickBool(r, ["rebootRequired", "rebootPending"]),
    domain: pickString(r, ["domain", "domainName"]) || null,
    description: pickString(r, ["description", "notes"]) || null,
    serialNumber:
      pickString(r, ["serialNumber", "biosSerialNumber", "sn"]) || null,
    manufacturer: pickString(r, ["manufacturer", "make"]) || null,
    model: pickString(r, ["model", "modelName"]) || null,
    warrantyDate: toIsoFromDatto(r.warrantyDate ?? r.warrantyExpiryDate),
    cagVersion: pickString(r, ["cagVersion", "agentVersion"]) || null,
    portalUrl,
    webRemoteUrl: buildDattoWebRemoteUrl(uid, cfg),
  };
}

export async function testDattoRmmConnection(): Promise<{
  ok: boolean;
  error?: string;
  siteCount?: number;
  accountName?: string | null;
}> {
  const cfg = getDattoRmmConfigFromEnv();
  if (!cfg) {
    return { ok: false, error: "Datto RMM is not configured" };
  }
  try {
    // Lightweight account call first
    const acct = await dattoFetch(cfg, "/api/v2/account");
    if (!acct.ok) {
      // Fall back to sites list
      const sites = await listDattoRmmSites();
      return { ok: true, siteCount: sites.length };
    }
    const r = asRecord(acct.data);
    const accountName = r
      ? pickString(r, ["name", "accountName", "companyName"]) || null
      : null;
    const sites = await listDattoRmmSites();
    return { ok: true, siteCount: sites.length, accountName };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Datto RMM connection failed",
    };
  }
}

export async function listDattoRmmSites(): Promise<DattoRmmSite[]> {
  const cfg = getDattoRmmConfigFromEnv();
  if (!cfg) throw new Error("Datto RMM is not configured");
  const items = await fetchAllPages(cfg, "/api/v2/account/sites?max=250&page=0");
  const sites = items
    .map(mapSite)
    .filter((s): s is DattoRmmSite => s != null);
  sites.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return sites;
}

export async function listDattoRmmDevicesForSite(
  siteUid: string,
): Promise<DattoRmmDevice[]> {
  const cfg = getDattoRmmConfigFromEnv();
  if (!cfg) throw new Error("Datto RMM is not configured");
  const uid = String(siteUid || "").trim();
  if (!uid) throw new Error("Datto RMM site UID is required");
  const path = `/api/v2/site/${encodeURIComponent(uid)}/devices?max=250&page=0`;
  const items = await fetchAllPages(cfg, path);
  const devices = items
    .map(mapDevice)
    .filter((d): d is DattoRmmDevice => d != null);
  devices.sort((a, b) => {
    // Online first, then hostname
    if (a.online !== b.online) {
      if (a.online === true) return -1;
      if (b.online === true) return 1;
    }
    return a.hostname.localeCompare(b.hostname, undefined, {
      sensitivity: "base",
    });
  });
  return devices;
}
