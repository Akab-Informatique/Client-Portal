import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * Autotask PSA REST client (server side only).
 *
 * One API-only account ("API User" security level) is configured in the admin
 * settings. Its secret and integration code are sealed with APP_SECRET and
 * never sent to the browser. Actions done for a technician pass their Autotask
 * resource id in `ImpersonationResourceId`, so Autotask records them under the
 * technician's name and applies their own Autotask rights.
 */

const ZONE_LOOKUP = "https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation";
const TIMEOUT_MS = 20_000;
export const PROVIDER = "autotask";

export type Zone = { name: string; url: string; webUrl: string | null };
export type Credentials = { username: string; secret: string; integrationCode: string };
export type AutotaskConfig = {
  username?: string;
  zone?: Zone;
  lastTest?: { ok: boolean; at: string; error?: AutotaskErrorCode };
};
export type AutotaskErrorCode = "not_configured" | "disabled" | "zone" | "auth" | "rate_limit" | "network" | "api";

export class AutotaskError extends Error {
  constructor(
    public code: AutotaskErrorCode,
    public status?: number,
    /** Autotask's own message (e.g. a required field), safe to show to staff */
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new AutotaskError("network", undefined, (e as Error).name);
  }
}

/** Finds the data centre (zone) of an Autotask API user. */
export async function detectZone(username: string): Promise<Zone> {
  const res = await send(`${ZONE_LOOKUP}?user=${encodeURIComponent(username)}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AutotaskError("zone", res.status);
  const j = (await res.json().catch(() => null)) as { zoneName?: string; url?: string; webUrl?: string } | null;
  if (!j?.url || !/^https:\/\/[a-z0-9.-]+\.autotask\.net\//i.test(j.url)) throw new AutotaskError("zone");
  return { name: j.zoneName ?? "", url: j.url.endsWith("/") ? j.url : `${j.url}/`, webUrl: j.webUrl ?? null };
}

export type Client = ReturnType<typeof createClient>;

export function createClient(creds: Credentials, zone: Zone) {
  const base = new URL("V1.0/", zone.url);

  async function call<T>(method: string, path: string, body?: unknown, opts: { impersonate?: number | null } = {}): Promise<T> {
    // Absolute URLs are only accepted on the zone host (pagination links)
    const url = path.startsWith("https://") ? new URL(path) : new URL(path, base);
    if (url.host !== base.host) throw new AutotaskError("api", undefined, "unexpected host");
    const res = await send(url.toString(), {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ApiIntegrationCode: creds.integrationCode,
        UserName: creds.username,
        Secret: creds.secret,
        ...(opts.impersonate ? { ImpersonationResourceId: String(opts.impersonate) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new AutotaskError("auth", res.status);
    if (res.status === 429) throw new AutotaskError("rate_limit", res.status);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { errors?: string[] } | null;
      throw new AutotaskError("api", res.status, j?.errors?.join("; ").slice(0, 300));
    }
    return (await res.json()) as T;
  }

  type Page<T> = { items: T[]; pageDetails?: { nextPageUrl?: string | null } };

  /** Entity query with paging (Autotask returns up to 500 items per page). */
  async function query<T>(entity: string, filter: unknown[], opts: { fields?: string[]; max?: number } = {}): Promise<T[]> {
    const max = opts.max ?? 5000;
    const out: T[] = [];
    let page = await call<Page<T>>("POST", `${entity}/query`, {
      filter,
      ...(opts.fields ? { IncludeFields: opts.fields } : {}),
      ...(opts.max && opts.max <= 500 ? { MaxRecords: opts.max } : {}),
    });
    for (;;) {
      out.push(...page.items);
      const next = page.pageDetails?.nextPageUrl;
      if (!next || out.length >= max) break;
      page = await call<Page<T>>("GET", next);
    }
    return out.slice(0, max);
  }

  return { call, query, zone };
}

// ── Stored settings ────────────────────────────────────────────────────────────
export type Settings = {
  enabled: boolean;
  config: AutotaskConfig;
  credentials: Credentials | null;
  hasSecret: boolean;
  hasIntegrationCode: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
};

type SealedSecrets = { secret?: string; integrationCode?: string };

export async function loadSettings(): Promise<Settings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  const config = (row?.config ?? {}) as AutotaskConfig;
  let secrets: SealedSecrets = {};
  try {
    secrets = JSON.parse(unseal(row?.secret) ?? "{}") as SealedSecrets;
  } catch {
    secrets = {};
  }
  const credentials =
    config.username && secrets.secret && secrets.integrationCode
      ? { username: config.username, secret: secrets.secret, integrationCode: secrets.integrationCode }
      : null;
  return {
    enabled: row?.enabled ?? false,
    config,
    credentials,
    hasSecret: Boolean(secrets.secret),
    hasIntegrationCode: Boolean(secrets.integrationCode),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export async function saveSettings(
  actorId: string,
  p: { enabled?: boolean; config?: AutotaskConfig; secret?: string; integrationCode?: string },
): Promise<void> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
  let secrets: SealedSecrets = {};
  try {
    secrets = JSON.parse(unseal(row?.secret) ?? "{}") as SealedSecrets;
  } catch {
    secrets = {};
  }
  if (p.secret !== undefined) secrets.secret = p.secret;
  if (p.integrationCode !== undefined) secrets.integrationCode = p.integrationCode;
  const values = {
    enabled: p.enabled ?? row?.enabled ?? false,
    config: (p.config ?? row?.config ?? {}) as Record<string, unknown>,
    secret: seal(JSON.stringify(secrets)),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
  resourceCache = null;
}

/** Client for the configured account; throws not_configured / disabled. */
export async function autotask(opts: { allowDisabled?: boolean } = {}): Promise<Client> {
  const s = await loadSettings();
  if (!s.credentials || !s.config.zone) throw new AutotaskError("not_configured");
  if (!s.enabled && !opts.allowDisabled) throw new AutotaskError("disabled");
  return createClient(s.credentials, s.config.zone);
}

// ── Resources (Autotask users), cached ───────────────────────────────────────────
export type Resource = { id: number; name: string; email: string | null };
type RawResource = { id: number; firstName?: string; lastName?: string; email?: string | null; userName?: string | null };
let resourceCache: { at: number; items: Resource[] } | null = null;
const RESOURCE_TTL = 60 * 60 * 1000;

export async function listResources(force = false): Promise<Resource[]> {
  if (!force && resourceCache && Date.now() - resourceCache.at < RESOURCE_TTL) return resourceCache.items;
  const at = await autotask({ allowDisabled: true });
  const raw = await at.query<RawResource>("Resources", [{ op: "eq", field: "isActive", value: true }], {
    fields: ["id", "firstName", "lastName", "email", "userName"],
  });
  const items = raw
    .map((r) => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.userName || `#${r.id}`,
      email: r.email?.trim().toLowerCase() || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  resourceCache = { at: Date.now(), items };
  return items;
}

export function clearAutotaskCache() {
  resourceCache = null;
}
