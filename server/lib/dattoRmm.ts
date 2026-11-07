import { asc, eq, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";
import { normName } from "./itcloud.ts";

/**
 * Datto RMM, read only: its sites (one per customer company) are matched to the portal's clients, and every device it
 * manages is copied here every 15 minutes (name, kind, OS, last user, online, last seen, patches, antivirus, links to
 * the device and its web remote control) so a client's computers can be seen from the client page. Nothing is ever
 * written to Datto.
 *
 * Datto's API v2: a key and a secret key (made in Datto RMM › Setup › Global settings › Access control), exchanged
 * at `<api url>/auth/oauth/token` (password grant, the public client) for a bearer token good for 100 hours. The API
 * address depends on the platform the account is on (`https://<platform>-api.centrastage.net`).
 */
export const DATTO_PROVIDER = "rmm.datto";
const TOKEN_PATH = "/auth/oauth/token";
const PAGE = 250;

export class DattoError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type DattoSync = { at: string; ok: boolean; error?: string; counts?: { sites: number; devices: number; online: number; removed: number } };
export type DattoSettings = {
  enabled: boolean;
  apiUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  /** The sync runs every 15 minutes by itself (on by default) */
  autoSync: boolean;
  lastTest?: { ok: boolean; at: string; error?: string; sites?: number };
  lastSync?: DattoSync;
};

export async function dattoSettings(): Promise<DattoSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, DATTO_PROVIDER));
  const c = (row?.config ?? {}) as Partial<DattoSettings>;
  let secret: string | null = null;
  try {
    secret = row?.secret ? unseal(row.secret) : null;
  } catch {
    secret = null;
  }
  return { enabled: row?.enabled ?? false, apiUrl: c.apiUrl ?? null, apiKey: c.apiKey ?? null, apiSecret: secret, autoSync: c.autoSync ?? true, lastTest: c.lastTest, lastSync: c.lastSync };
}

export async function saveDattoSettings(actorId: string | null, p: Partial<DattoSettings>) {
  const next = { ...(await dattoSettings()), ...p };
  const values = {
    enabled: next.enabled,
    config: { apiUrl: next.apiUrl, apiKey: next.apiKey, autoSync: next.autoSync, lastTest: next.lastTest, lastSync: next.lastSync },
    secret: next.apiSecret ? seal(next.apiSecret) : null,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: DATTO_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

export const dattoReady = (s: DattoSettings) => s.enabled && Boolean(s.apiUrl && s.apiKey && s.apiSecret);

/** Only Datto's own API hosts: the address is typed by an administrator and the portal sends the secret there */
export function validApiUrl(u: string): boolean {
  return /^https:\/\/[a-z0-9]+-api\.centrastage\.net$/i.test(u.trim().replace(/\/+$/, ""));
}
const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
/** A link coming back from Datto (a device page, a remote control) is shown only when it is on Datto's own hosts */
export const dattoLink = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/[a-z0-9.-]+\.centrastage\.net(\/|$)/i.test(u) ? u : null);

// ── the token, kept in memory (valid 100 hours; asked again a little before)
const tokens = new Map<string, { value: string; until: number }>();
export const forgetDattoToken = () => tokens.clear();

async function token(s: DattoSettings, fresh = false): Promise<string> {
  if (!s.apiUrl || !s.apiKey || !s.apiSecret) throw new DattoError("rmm_incomplete");
  const id = `${s.apiUrl}|${s.apiKey}`;
  const hit = tokens.get(id);
  if (!fresh && hit && hit.until > Date.now()) return hit.value;
  const res = await fetch(`${cleanUrl(s.apiUrl)}${TOKEN_PATH}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("public-client:public").toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "password", username: s.apiKey, password: s.apiSecret }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new DattoError("rmm_unauthorized");
  if (!res.ok) throw new DattoError(`rmm_http_${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new DattoError("rmm_unauthorized");
  tokens.set(id, { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 360_000) - 600) * 1000 });
  return j.access_token;
}

async function get<T>(s: DattoSettings, path: string, retried = false): Promise<T> {
  const res = await fetch(`${cleanUrl(s.apiUrl!)}${path}`, {
    headers: { authorization: `Bearer ${await token(s, retried)}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  // a token that was refused is asked for again, once
  if (res.status === 401 && !retried) return get<T>(s, path, true);
  if (res.status === 429) throw new DattoError("rmm_rate_limited");
  if (res.status === 401 || res.status === 403) throw new DattoError("rmm_unauthorized");
  if (!res.ok) throw new DattoError(`rmm_http_${res.status}`);
  return (await res.json()) as T;
}

/** Every page of a list (`max` per page, until a short page or no next page) */
async function all<T>(s: DattoSettings, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 400; page++) {
    const j = await get<Record<string, unknown> & { pageDetails?: { nextPageUrl?: string | null } }>(s, `${path}${path.includes("?") ? "&" : "?"}page=${page}&max=${PAGE}`);
    const rows = Array.isArray(j[key]) ? (j[key] as T[]) : [];
    out.push(...rows);
    if (rows.length < PAGE || !j.pageDetails?.nextPageUrl) break;
  }
  return out;
}

// ── what the API says (only what is read)
type Site = { uid: string; id?: number; name?: string; description?: string };
type Device = {
  uid: string;
  siteUid?: string;
  hostname?: string;
  description?: string;
  intIpAddress?: string;
  extIpAddress?: string;
  operatingSystem?: string;
  lastLoggedInUser?: string;
  deviceType?: { category?: string; type?: string };
  online?: boolean;
  rebootRequired?: boolean;
  lastSeen?: number | string | null;
  lastReboot?: number | string | null;
  lastAuditDate?: number | string | null;
  patchManagement?: { patchStatus?: string; patchesApprovedPending?: number; patchesNotApproved?: number } | null;
  antivirus?: { antivirusProduct?: string; antivirusStatus?: string } | null;
  warrantyDate?: string | null;
  portalUrl?: string;
  webRemoteUrl?: string;
};
const asDate = (v: number | string | null | undefined): Date | null => {
  if (v == null || v === "") return null;
  const d = new Date(typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const text = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");

/** Sign in and count the sites (the Test button) */
export async function testDatto(actorId: string | null): Promise<NonNullable<DattoSettings["lastTest"]>> {
  const s = await dattoSettings();
  let result: NonNullable<DattoSettings["lastTest"]>;
  try {
    forgetDattoToken();
    const sites = await all<Site>(s, "/api/v2/account/sites", "sites");
    result = { ok: true, at: new Date().toISOString(), sites: sites.length };
  } catch (e) {
    result = { ok: false, at: new Date().toISOString(), error: e instanceof DattoError ? e.code : "rmm_failed" };
  }
  await saveDattoSettings(actorId, { lastTest: result });
  return result;
}

let running: Promise<DattoSync> | null = null;

/** Copy the sites and the devices (one at a time); a device Datto no longer lists is dropped here too */
export function syncDatto(actorId: string | null): Promise<DattoSync> {
  running ??= (async () => {
    const s = await dattoSettings();
    let result: DattoSync;
    try {
      if (!s.apiUrl || !s.apiKey || !s.apiSecret) throw new DattoError("rmm_incomplete");
      const [sites, devices] = [await all<Site>(s, "/api/v2/account/sites", "sites"), await all<Device>(s, "/api/v2/account/devices", "devices")];
      const d = db();
      const now = new Date();
      const known = sites.filter((x) => x.uid);
      for (const x of known) {
        const count = devices.filter((v) => v.siteUid === x.uid).length;
        await d
          .insert(schema.rmmSites)
          .values({ uid: x.uid, name: text(x.name) || x.uid, description: text(x.description), deviceCount: count, syncedAt: now })
          .onConflictDoUpdate({ target: schema.rmmSites.uid, set: { name: text(x.name) || x.uid, description: text(x.description), deviceCount: count, syncedAt: now } });
      }
      let online = 0;
      for (const v of devices) {
        if (!v.uid || !v.siteUid) continue;
        if (v.online) online++;
        const row = {
          siteUid: v.siteUid,
          hostname: text(v.hostname, 200),
          description: text(v.description),
          ip: text(v.intIpAddress, 60),
          externalIp: text(v.extIpAddress, 60),
          os: text(v.operatingSystem, 200),
          lastUser: text(v.lastLoggedInUser, 200),
          category: text(v.deviceType?.category, 60),
          kind: text(v.deviceType?.type, 60),
          online: Boolean(v.online),
          rebootRequired: Boolean(v.rebootRequired),
          lastSeen: asDate(v.lastSeen),
          lastReboot: asDate(v.lastReboot),
          lastAudit: asDate(v.lastAuditDate),
          patchStatus: text(v.patchManagement?.patchStatus, 60),
          patchesPending: Number(v.patchManagement?.patchesApprovedPending ?? 0) || 0,
          antivirus: text(v.antivirus?.antivirusProduct, 120),
          antivirusStatus: text(v.antivirus?.antivirusStatus, 60),
          warrantyDate: text(v.warrantyDate, 20),
          portalUrl: dattoLink(v.portalUrl),
          remoteUrl: dattoLink(v.webRemoteUrl),
          syncedAt: now,
        };
        await d.insert(schema.rmmDevices).values({ uid: v.uid, ...row }).onConflictDoUpdate({ target: schema.rmmDevices.uid, set: row });
      }
      // what Datto no longer lists
      const uids = devices.map((v) => v.uid).filter(Boolean);
      const gone = uids.length ? await d.delete(schema.rmmDevices).where(notInArray(schema.rmmDevices.uid, uids)).returning({ id: schema.rmmDevices.id }) : await d.delete(schema.rmmDevices).returning({ id: schema.rmmDevices.id });
      const siteUids = known.map((x) => x.uid);
      if (siteUids.length) await d.delete(schema.rmmSites).where(notInArray(schema.rmmSites.uid, siteUids));
      result = { at: now.toISOString(), ok: true, counts: { sites: known.length, devices: devices.length, online, removed: gone.length } };
    } catch (e) {
      result = { at: new Date().toISOString(), ok: false, error: e instanceof DattoError ? e.code : e instanceof Error ? e.message.slice(0, 200) : "rmm_failed" };
    }
    await saveDattoSettings(actorId, { lastSync: result });
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function dattoTick(): Promise<void> {
  const s = await dattoSettings();
  if (!dattoReady(s) || !s.autoSync) return;
  await syncDatto(null);
}

// ── sites ↔ clients
/** The sites with the client each is tied to, and the one proposed (same name, only when unambiguous) */
export async function sitePlan() {
  const d = db();
  const [sites, clients] = await Promise.all([d.select().from(schema.rmmSites).orderBy(asc(schema.rmmSites.name)), d.select({ id: schema.clients.id, name: schema.clients.name, active: schema.clients.active }).from(schema.clients).orderBy(asc(schema.clients.name))]);
  const byName = new Map<string, string[]>();
  for (const c of clients) {
    const k = normName(c.name);
    if (k) byName.set(k, [...(byName.get(k) ?? []), c.id]);
  }
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return {
    sites: sites.map((x) => {
      const same = byName.get(normName(x.name)) ?? [];
      const proposed = !x.clientId && same.length === 1 ? same[0]! : null;
      return { uid: x.uid, name: x.name, devices: x.deviceCount, clientId: x.clientId, clientName: x.clientId ? (names.get(x.clientId) ?? null) : null, proposedId: proposed, proposedName: proposed ? (names.get(proposed) ?? null) : null };
    }),
    clients: clients.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
  };
}

/** Tie a site to a client (or untie it); a client may have several sites, a site has one client */
export async function setSiteClient(siteUid: string, clientId: string | null) {
  const [site] = await db().select({ id: schema.rmmSites.id }).from(schema.rmmSites).where(eq(schema.rmmSites.uid, siteUid));
  if (!site) throw new DattoError("not_found");
  if (clientId) {
    const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, clientId));
    if (!c) throw new DattoError("client_not_found");
  }
  await db().update(schema.rmmSites).set({ clientId }).where(eq(schema.rmmSites.id, site.id));
}

/** Accept the proposed matches (the ones given, or all) */
export async function acceptProposals(uids?: string[]): Promise<number> {
  const plan = await sitePlan();
  let n = 0;
  for (const x of plan.sites) {
    if (!x.proposedId || (uids && !uids.includes(x.uid))) continue;
    await db().update(schema.rmmSites).set({ clientId: x.proposedId }).where(eq(schema.rmmSites.uid, x.uid));
    n++;
  }
  return n;
}

// ── devices of a client
export type ClientDevice = {
  id: string;
  uid: string;
  siteName: string;
  hostname: string;
  description: string;
  ip: string;
  os: string;
  lastUser: string;
  category: string;
  kind: string;
  online: boolean;
  rebootRequired: boolean;
  lastSeen: Date | null;
  lastReboot: Date | null;
  patchStatus: string;
  patchesPending: number;
  antivirus: string;
  antivirusStatus: string;
  warrantyDate: string;
  portalUrl: string | null;
  remoteUrl: string | null;
};
export async function devicesOfClient(clientId: string): Promise<ClientDevice[]> {
  const rows = await db()
    .select({ v: schema.rmmDevices, site: schema.rmmSites.name })
    .from(schema.rmmDevices)
    .innerJoin(schema.rmmSites, eq(schema.rmmSites.uid, schema.rmmDevices.siteUid))
    .where(eq(schema.rmmSites.clientId, clientId))
    .orderBy(asc(schema.rmmDevices.hostname));
  return rows.map(({ v, site }) => ({
    id: v.id,
    uid: v.uid,
    siteName: site,
    hostname: v.hostname,
    description: v.description,
    ip: v.ip,
    os: v.os,
    lastUser: v.lastUser,
    category: v.category,
    kind: v.kind,
    online: v.online,
    rebootRequired: v.rebootRequired,
    lastSeen: v.lastSeen,
    lastReboot: v.lastReboot,
    patchStatus: v.patchStatus,
    patchesPending: v.patchesPending,
    antivirus: v.antivirus,
    antivirusStatus: v.antivirusStatus,
    warrantyDate: v.warrantyDate,
    portalUrl: v.portalUrl,
    remoteUrl: v.remoteUrl,
  }));
}

/** How many sites are tied to a client (the tab shows only for them) */
export async function clientSiteCount(clientId: string): Promise<number> {
  const [r] = await db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.rmmSites).where(eq(schema.rmmSites.clientId, clientId));
  return r?.n ?? 0;
}

