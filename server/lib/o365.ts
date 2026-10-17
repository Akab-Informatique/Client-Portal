import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * Microsoft 365 (Microsoft Graph), server side only.
 *
 * One app registration in AKAB's tenant, used two ways:
 * - organisation access (application permissions, admin consent): the
 *   portal reaches any mailbox / calendar of the tenant — admins only;
 * - a technician's own sign-in (delegated permissions): only what that
 *   person can reach, linked by themselves (see msauth.ts).
 * The client secret and refresh tokens are sealed with APP_SECRET and never
 * sent to the browser.
 */
export const O365_PROVIDER = "o365";
const GRAPH = "https://graph.microsoft.com/v1.0/";
const TIMEOUT_MS = 15_000;
const TZ = "America/Toronto";

export type O365Settings = { enabled: boolean; tenantId: string; clientId: string; secret: string | null; lastTest?: { ok: boolean; at: string; error?: string } };

export class O365Error extends Error {
  constructor(
    public code: "not_configured" | "auth" | "not_found" | "forbidden" | "network" | "api",
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export async function o365Settings(): Promise<O365Settings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, O365_PROVIDER));
  const c = (row?.config ?? {}) as { tenantId?: string; clientId?: string; lastTest?: O365Settings["lastTest"] };
  let secret: string | null = null;
  try {
    secret = (JSON.parse(unseal(row?.secret) ?? "{}") as { secret?: string }).secret ?? null;
  } catch {
    secret = null;
  }
  return { enabled: row?.enabled ?? false, tenantId: c.tenantId ?? "", clientId: c.clientId ?? "", secret, lastTest: c.lastTest };
}

export async function saveO365Settings(actorId: string, p: { enabled?: boolean; tenantId?: string; clientId?: string; secret?: string; lastTest?: O365Settings["lastTest"] }) {
  const cur = await o365Settings();
  const changed = p.secret !== undefined || p.tenantId !== undefined || p.clientId !== undefined;
  const values = {
    enabled: p.enabled ?? cur.enabled,
    config: { tenantId: p.tenantId ?? cur.tenantId, clientId: p.clientId ?? cur.clientId, lastTest: changed ? undefined : (p.lastTest ?? cur.lastTest) },
    secret: seal(JSON.stringify({ secret: p.secret ?? cur.secret ?? undefined })),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: O365_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
  token = null;
  if (changed) userTokens.clear();
}

/** Ready to use: enabled and complete. */
export async function o365Ready(): Promise<boolean> {
  const s = await o365Settings();
  return s.enabled && Boolean(s.tenantId && s.clientId && s.secret);
}

// ── Token (client credentials), cached until shortly before it expires ──
let token: { value: string; until: number; key: string } | null = null;
async function accessToken(s: Pick<O365Settings, "tenantId" | "clientId" | "secret">): Promise<string> {
  const key = `${s.tenantId}:${s.clientId}`;
  if (token && token.key === key && token.until > Date.now()) return token.value;
  const j = await tokenRequest(s, { scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  if (!j.access_token) throw new O365Error("auth", j.error_description?.split("\r\n")[0]?.slice(0, 200));
  token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000, key };
  return token.value;
}

// ── A technician's own sign-in: delegated tokens, refreshed as needed ──
/** Graph calls inside `asUser` go out with that person's own access. */
type GraphAs = { userId: string; self: string };
const graphAs = new AsyncLocalStorage<GraphAs | null>();
export function asUser<T>(as: GraphAs | null, fn: () => Promise<T>): Promise<T> {
  return graphAs.run(as, fn);
}
/** Run as the owner of this Microsoft sign-in (or with the organisation access when null). */
export async function asConnection<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  if (!userId) return asUser(null, fn);
  const [conn] = await db().select({ email: schema.msConnections.email }).from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  if (!conn) throw new O365Error("auth", "not_signed_in");
  return asUser({ userId, self: conn.email.toLowerCase() }, fn);
}

const userTokens = new Map<string, { value: string; until: number }>();
export function forgetUserToken(userId: string) {
  userTokens.delete(userId);
}

/** Access token of a technician's sign-in (the refresh token is renewed by Microsoft as it goes). */
async function userAccessToken(userId: string): Promise<string> {
  const hit = userTokens.get(userId);
  if (hit && hit.until > Date.now()) return hit.value;
  const s = await o365Settings();
  if (!s.enabled || !s.tenantId || !s.clientId || !s.secret) throw new O365Error("not_configured");
  const [conn] = await db().select().from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  const refresh = unseal(conn?.refreshToken);
  if (!conn || !refresh) throw new O365Error("auth", "not_signed_in");
  const j = await tokenRequest(s, { grant_type: "refresh_token", refresh_token: refresh, scope: conn.scopes || DELEGATED_SCOPES.join(" ") });
  if (!j.access_token) {
    // revoked, expired or password changed: the person signs in again
    await db().update(schema.msConnections).set({ lastError: "reconnect", updatedAt: new Date() }).where(eq(schema.msConnections.userId, userId));
    throw new O365Error("auth", "reconnect");
  }
  await db()
    .update(schema.msConnections)
    .set({ ...(j.refresh_token ? { refreshToken: seal(j.refresh_token) } : {}), lastError: null, updatedAt: new Date() })
    .where(eq(schema.msConnections.userId, userId));
  userTokens.set(userId, { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 });
  return j.access_token;
}

/** What a technician's sign-in asks for (delegated permissions). */
export const DELEGATED_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"];

export type TokenAnswer = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
export async function tokenRequest(s: Pick<O365Settings, "tenantId" | "clientId" | "secret">, params: Record<string, string>): Promise<TokenAnswer> {
  if (!s.tenantId || !s.clientId || !s.secret || !/^[0-9a-z.-]+$/i.test(s.tenantId)) throw new O365Error("not_configured");
  let res: Response;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(s.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: s.clientId, client_secret: s.secret, ...params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new O365Error("network", (e as Error).name);
  }
  return ((await res.json().catch(() => null)) as TokenAnswer | null) ?? {};
}

/**
 * One Graph call. `path` is relative to GRAPH (e.g. "users/x/messages").
 * `prefer` adds Prefer options (e.g. outlook.body-content-type="html").
 */
export async function graph<T>(
  method: string,
  path: string,
  body?: unknown,
  settings?: Pick<O365Settings, "tenantId" | "clientId" | "secret">,
  prefer: string[] = [],
): Promise<T> {
  const as = settings ? null : graphAs.getStore();
  const bearer = as ? await userAccessToken(as.userId) : await accessToken(settings ?? (await o365Settings()));
  let res: Response;
  try {
    res = await fetch(GRAPH + path, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        prefer: [`outlook.timezone="${TZ}"`, ...prefer].join(", "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new O365Error("network", (e as Error).name);
  }
  if (res.status === 204 || res.status === 202) return undefined as T;
  const j = (await res.json().catch(() => null)) as ({ error?: { message?: string } } & T) | null;
  if (!res.ok) {
    const detail = j?.error?.message?.slice(0, 200);
    throw new O365Error(res.status === 401 ? "auth" : res.status === 403 ? "forbidden" : res.status === 404 ? "not_found" : "api", detail);
  }
  return j as T;
}

export const GRAPH_BASE = GRAPH;
/** A mailbox in a Graph path: "me" for the signed-in technician's own, else users/<address>. */
export const user = (email: string) => {
  const as = graphAs.getStore();
  return as && email.toLowerCase() === as.self ? "me" : `users/${encodeURIComponent(email)}`;
};
const calendarPath = (email: string, calendarId?: string | null) => (calendarId ? `${user(email)}/calendars/${encodeURIComponent(calendarId)}` : user(email));

export type CalendarInfo = { id: string; name: string; isDefault: boolean; canEdit: boolean; owner: string | null };
/** The calendars of a mailbox (to choose the one shown in a planning). */
export async function listCalendars(email: string): Promise<CalendarInfo[]> {
  type C = { id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { address?: string } };
  const r = await graph<{ value: C[] }>("GET", `${user(email)}/calendars?$select=id,name,isDefaultCalendar,canEdit,owner&$top=100`);
  return (r.value ?? []).map((c) => ({ id: c.id, name: c.name, isDefault: Boolean(c.isDefaultCalendar), canEdit: c.canEdit !== false, owner: c.owner?.address ?? null }));
}

/** Test: read the calendar of this mailbox with the given (or saved) settings. */
export async function testO365(email: string, settings?: Pick<O365Settings, "tenantId" | "clientId" | "secret">) {
  await graph(`GET`, `${user(email)}/calendar?$select=id,name`, undefined, settings);
}

export type OutlookEvent = { id: string; title: string; startsAt: string; endsAt: string; allDay: boolean; location: string | null; showAs: string | null; private: boolean };

/** The mailbox's events between two dates (expanded recurrences). */
export async function outlookEvents(email: string, from: Date, to: Date, calendarId?: string | null): Promise<OutlookEvent[]> {
  type Ev = { id: string; subject?: string; isAllDay?: boolean; showAs?: string; sensitivity?: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName?: string }; categories?: string[] };
  const q = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: "id,subject,isAllDay,showAs,sensitivity,start,end,location,categories",
    $top: "200",
  });
  const r = await graph<{ value: Ev[] }>("GET", `${calendarPath(email, calendarId)}/calendarView?${q}`);
  // Graph answers in the time zone asked (Prefer header), without offset: read it as local time
  const at = (s: string) => new Date(`${s.slice(0, 19)}${offset(s)}`).toISOString();
  return (r.value ?? [])
    .filter((e) => !(e.categories ?? []).includes(PORTAL_CATEGORY)) // our own blocks are already shown
    .map((e) => ({ id: e.id, title: e.subject || "—", startsAt: at(e.start.dateTime), endsAt: at(e.end.dateTime), allDay: Boolean(e.isAllDay), location: e.location?.displayName || null, showAs: e.showAs ?? null, private: e.sensitivity === "private" || e.sensitivity === "confidential" }));
}

/** UTC offset of Québec time on that date ("-04:00" in summer, "-05:00" in winter). */
function offset(local: string): string {
  const d = new Date(`${local.slice(0, 19)}Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d);
  const v = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  return v.replace("GMT", "") || "+00:00";
}
const local = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d).replace(" ", "T");

/** Category put on the events the portal creates (to recognize them). */
export const PORTAL_CATEGORY = "Portail AKAB";

export type EventInput = { subject: string; body: string; startsAt: Date; endsAt: Date; location?: string | null; allDay?: boolean; reminderMinutes?: number };
function eventBody(e: EventInput) {
  const day = (d: Date) => local(d).slice(0, 10);
  return {
    subject: e.subject.slice(0, 250),
    body: { contentType: "text", content: e.body.slice(0, 4000) },
    start: { dateTime: e.allDay ? `${day(e.startsAt)}T00:00:00` : local(e.startsAt), timeZone: TZ },
    end: { dateTime: e.allDay ? `${day(e.endsAt)}T00:00:00` : local(e.endsAt), timeZone: TZ },
    isAllDay: Boolean(e.allDay),
    ...(e.location ? { location: { displayName: e.location } } : {}),
    categories: [PORTAL_CATEGORY],
    isReminderOn: Boolean(e.reminderMinutes),
    ...(e.reminderMinutes ? { reminderMinutesBeforeStart: e.reminderMinutes } : {}),
    showAs: e.allDay ? "free" : "busy",
  };
}
export async function createEvent(email: string, e: EventInput, calendarId?: string | null): Promise<string> {
  return (await graph<{ id: string }>("POST", `${calendarPath(email, calendarId)}/events`, eventBody(e))).id;
}
export async function updateEvent(email: string, id: string, e: EventInput): Promise<void> {
  await graph("PATCH", `${user(email)}/events/${encodeURIComponent(id)}`, eventBody(e));
}
export async function deleteEvent(email: string, id: string): Promise<void> {
  await graph("DELETE", `${user(email)}/events/${encodeURIComponent(id)}`).catch((e) => {
    if (!(e instanceof O365Error && e.code === "not_found")) throw e;
  });
}
