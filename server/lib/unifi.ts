import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * UniFi (Ubiquiti), read only. The UniFi Site Manager API (https://developer.ui.com): one API key made on unifi.ui.com
 * sees every console (host), site and device of the account. Only GET calls, only the fixed host api.ui.com (nothing
 * typed in the browser reaches a URL), the key is sealed and never sent back. Answers are kept 60 seconds in memory so the
 * page does not hammer the API.
 *
 * Written from the documented shape of `GET /v1/hosts`, `/v1/sites` and `/v1/devices` (envelope `{ data, nextToken }`,
 * header `X-API-KEY`) and tested against a mock only, not against a real account: a field that comes back named
 * differently is simply left empty.
 */
export const UNIFI_PROVIDER = "unifi";
export const UNIFI_BASE = "https://api.ui.com";
const PAGE = 100;
const TTL = 60_000;

export class UnifiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type UnifiSettings = {
  enabled: boolean;
  apiKey: string | null;
  lastTest?: { ok: boolean; at: string; error?: string; hosts?: number };
};

export async function unifiSettings(): Promise<UnifiSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, UNIFI_PROVIDER));
  const c = (row?.config ?? {}) as { lastTest?: UnifiSettings["lastTest"] };
  let key: string | null = null;
  try {
    key = row?.secret ? unseal(row.secret) : null;
  } catch {
    key = null;
  }
  return { enabled: row?.enabled ?? false, apiKey: key, lastTest: c.lastTest };
}

// ── 60 s cache, one entry per key and path
const cache = new Map<string, { at: number; value: unknown }>();
export const forgetUnifiCache = () => cache.clear();

export async function saveUnifiSettings(actorId: string | null, p: Partial<UnifiSettings>) {
  const next = { ...(await unifiSettings()), ...p };
  const values = {
    enabled: next.enabled,
    config: { lastTest: next.lastTest },
    secret: next.apiKey ? seal(next.apiKey) : null,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: UNIFI_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
  cache.clear();
}

export const unifiReady = (s: UnifiSettings) => s.enabled && Boolean(s.apiKey);

async function get<T>(key: string, path: string): Promise<T> {
  const ck = `${key.slice(-6)}|${path}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const res = await fetch(`${UNIFI_BASE}${path}`, {
    method: "GET",
    headers: { "x-api-key": key, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) throw new UnifiError("unifi_unauthorized");
  if (res.status === 429) throw new UnifiError("unifi_rate_limited");
  if (!res.ok) throw new UnifiError(`unifi_http_${res.status}`);
  const value = (await res.json()) as T;
  cache.set(ck, { at: Date.now(), value });
  return value;
}

type Page = { data?: unknown; nextToken?: string | null };
async function all(key: string, path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let token: string | null | undefined;
  for (let i = 0; i < 50; i++) {
    const q = `pageSize=${PAGE}${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`;
    const j = await get<Page>(key, `${path}?${q}`);
    if (Array.isArray(j.data)) out.push(...(j.data as Record<string, unknown>[]));
    token = j.nextToken;
    if (!token) break;
  }
  return out;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const first = (...v: unknown[]) => v.map(str).find((x) => x) ?? "";
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

export type UnifiHost = { id: string; name: string; model: string; type: string; firmware: string; ip: string; online: boolean; state: string; lastChange: string | null };
export type UnifiSite = { id: string; hostId: string; name: string; devices: number; offline: number; pendingUpdates: number; clients: number };
export type UnifiDevice = {
  id: string;
  hostId: string;
  hostName: string;
  siteId: string;
  name: string;
  model: string;
  kind: string;
  mac: string;
  ip: string;
  firmware: string;
  updateAvailable: string;
  online: boolean;
  status: string;
  uptimeSince: string | null;
  adoptedAt: string | null;
  isConsole: boolean;
};

export const mapHost = (h: Record<string, unknown>): UnifiHost => {
  const r = rec(h.reportedState);
  const state = first(r.state, h.state).toLowerCase();
  return {
    id: str(h.id),
    name: first(r.name, r.hostname, rec(h.userData).name, h.id),
    model: first(rec(r.hardware).name, r.hardware, r.model, h.type),
    type: str(h.type),
    // checked against a real account (2026-11-17): the console's firmware is reportedState.hardware.firmwareVersion, else reportedState.version
    firmware: first(rec(r.hardware).firmwareVersion, r.firmwareVersion, r.firmware, r.version),
    ip: first(h.ipAddress, r.ip, r.ipAddress),
    online: state === "connected" || state === "online",
    state,
    lastChange: iso(h.lastConnectionStateChange),
  };
};

export const mapSite = (s: Record<string, unknown>): UnifiSite => {
  const counts = rec(rec(s.statistics).counts);
  return {
    id: str(s.siteId),
    hostId: str(s.hostId),
    name: first(rec(s.meta).name, rec(s.meta).desc, s.siteId),
    devices: num(counts.totalDevice),
    offline: num(counts.offlineDevice),
    pendingUpdates: num(counts.pendingUpdateDevice),
    clients: num(counts.wifiClient) + num(counts.wiredClient),
  };
};

export const mapDevices = (groups: Record<string, unknown>[], siteByHost: Map<string, string>): UnifiDevice[] => {
  const out: UnifiDevice[] = [];
  for (const g of groups) {
    const hostId = str(g.hostId);
    for (const raw of Array.isArray(g.devices) ? (g.devices as unknown[]) : []) {
      const d = rec(raw);
      const status = str(d.status).toLowerCase();
      out.push({
        id: first(d.id, d.mac),
        hostId,
        hostName: str(g.hostName),
        siteId: siteByHost.get(hostId) ?? "",
        name: first(d.name, d.shortname, d.model, d.mac),
        model: first(d.model, d.shortname),
        kind: first(d.productLine, d.type),
        mac: str(d.mac),
        ip: str(d.ip),
        firmware: first(d.version, d.firmwareVersion),
        updateAvailable: first(d.updateAvailable),
        online: status === "online" || status === "connected",
        status,
        uptimeSince: iso(d.startupTime),
        adoptedAt: iso(d.adoptionTime),
        isConsole: d.isConsole === true,
      });
    }
  }
  return out;
};

export async function unifiOverview() {
  const s = await unifiSettings();
  if (!unifiReady(s)) throw new UnifiError("unifi_not_configured");
  const key = s.apiKey!;
  const [hosts, sites, devs] = await Promise.all([all(key, "/v1/hosts"), all(key, "/v1/sites"), all(key, "/v1/devices")]);
  const mappedSites = sites.map(mapSite);
  const siteByHost = new Map<string, string>();
  for (const x of mappedSites) if (x.hostId && !siteByHost.has(x.hostId)) siteByHost.set(x.hostId, x.id);
  return { hosts: hosts.map(mapHost), sites: mappedSites, devices: mapDevices(devs, siteByHost), fetchedAt: new Date().toISOString() };
}

export async function testUnifi(actorId: string | null) {
  const s = await unifiSettings();
  if (!s.apiKey) throw new UnifiError("unifi_incomplete");
  let lastTest: NonNullable<UnifiSettings["lastTest"]>;
  try {
    forgetUnifiCache();
    const hosts = await all(s.apiKey, "/v1/hosts");
    lastTest = { ok: true, at: new Date().toISOString(), hosts: hosts.length };
  } catch (e) {
    lastTest = { ok: false, at: new Date().toISOString(), error: e instanceof UnifiError ? e.code : "unifi_unreachable" };
  }
  await saveUnifiSettings(actorId, { lastTest });
  return lastTest;
}
