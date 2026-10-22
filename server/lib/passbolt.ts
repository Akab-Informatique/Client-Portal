import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";

/**
 * Passbolt as the vault engine behind the portal's own screens (Sécurité › Passbolt). The portal's server only
 * FORWARDS calls to one configured Passbolt server (a short list of paths, never anything else) and keeps each
 * person's passphrase-protected private key. Secrets are decrypted in the person's browser; the server never sees
 * a passphrase or a decrypted secret. This is a spike: switched off in production unless PASSBOLT_SPIKE=true.
 */
export const PASSBOLT_PROVIDER = "passbolt";

export type PassboltSettings = { enabled: boolean; baseUrl: string; lastTest?: { ok: boolean; at: string; error?: string } };

/** https only; a local address over http is allowed outside production (a test server) */
export function validBaseUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return !config.production && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function passboltSettings(): Promise<PassboltSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, PASSBOLT_PROVIDER));
  const c = (row?.config ?? {}) as Partial<PassboltSettings>;
  return { enabled: row?.enabled ?? false, baseUrl: (c.baseUrl ?? "").replace(/\/+$/, ""), lastTest: c.lastTest };
}

export async function savePassboltSettings(actorId: string, p: Partial<PassboltSettings>) {
  const cur = await passboltSettings();
  const next = { ...cur, ...p };
  const values = { enabled: next.enabled, config: { baseUrl: next.baseUrl, lastTest: next.lastTest }, updatedBy: actorId, updatedAt: new Date() };
  await db()
    .insert(schema.integrations)
    .values({ provider: PASSBOLT_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

/** The only Passbolt calls the portal forwards: signing in (JWT), listing, reading one secret, the metadata keys. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ALLOWED: { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "GET", path: /^\/auth\/verify\.json$/ },
  { method: "POST", path: /^\/auth\/jwt\/login\.json$/ },
  { method: "POST", path: /^\/auth\/jwt\/refresh\.json$/ },
  { method: "POST", path: /^\/auth\/jwt\/logout\.json$/ },
  { method: "GET", path: /^\/users\/me\.json$/ },
  { method: "GET", path: /^\/resources\.json$/ },
  { method: "GET", path: new RegExp(`^/resources/${UUID}\\.json$`) },
  { method: "GET", path: new RegExp(`^/secrets/resource/${UUID}\\.json$`) },
  { method: "GET", path: /^\/metadata\/keys\.json$/ },
];
export const pathAllowed = (method: string, path: string) => ALLOWED.some((a) => a.method === method && a.path.test(path));
/** Query strings are plain filters (contain[…]=1, api-version=v2) */
export const queryAllowed = (q: string) => q.length <= 300 && /^[A-Za-z0-9[\]=&._%-]*$/.test(q);

const MAX_BYTES = 5 * 1024 * 1024;

/** One call to the configured Passbolt server, as the browser asked. Returns what Passbolt answered. */
export async function forward(method: "GET" | "POST", path: string, query: string, headers: { authorization?: string }, body: string | undefined): Promise<{ status: number; text: string }> {
  const s = await passboltSettings();
  if (!s.enabled || !s.baseUrl || !validBaseUrl(s.baseUrl)) throw new Error("passbolt_not_ready");
  if (!pathAllowed(method, path) || !queryAllowed(query)) throw new Error("passbolt_path");
  const res = await fetch(`${s.baseUrl}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      // only a bearer token, never the portal's own cookie or anything else
      ...(headers.authorization && /^Bearer [A-Za-z0-9._~+/=-]+$/.test(headers.authorization) ? { authorization: headers.authorization } : {}),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("passbolt_too_big");
  return { status: res.status, text };
}

/** Does the server answer? (its public health status, no sign-in) */
export async function testPassbolt(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/healthcheck/status.json`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "error" };
  }
}
