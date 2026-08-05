/**
 * Autotask REST API helper (server-only).
 * Auth headers: ApiIntegrationCode, UserName, Secret
 * Docs: https://www.autotask.net/help/developerhelp/
 */

export type AutotaskConfig = {
  integrationCode: string;
  username: string;
  secret: string;
  /** Optional fixed zone base, e.g. https://webservices3.autotask.net/atservicesrest/ */
  zoneBaseUrl?: string;
};

export type RawTicket = {
  id: number;
  ticketNumber?: string;
  title?: string;
  description?: string | null;
  status?: number;
  priority?: number | null;
  createDate?: string | null;
  dueDateTime?: string | null;
  lastActivityDate?: string | null;
  companyID?: number | null;
  contactID?: number | null;
  createdByContactID?: number | null;
};

export type MappedTicket = {
  id: number;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: number;
  statusLabel: string;
  priority: number | null;
  priorityLabel: string | null;
  createDate: string | null;
  dueDateTime: string | null;
  lastActivityDate: string | null;
  companyID: number | null;
  contactID: number | null;
  createdByContactID: number | null;
};

export type AutotaskContact = {
  id: number;
  emailAddress: string | null;
  firstName: string | null;
  lastName: string | null;
  companyID: number | null;
  isActive: boolean;
};

/** Strip surrounding quotes / BOM / whitespace from .env values */
function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  // Peel one layer of matching quotes (dotenv / docker / shell may leave them)
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  // Peel a second layer if nested ("'value'" / '"value"')
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  // Docker Compose / shell sometimes leave a trailing \r from Windows .env
  v = v.replace(/\r/g, "").trim();
  return v;
}

/**
 * Detect common .env problems for Autotask without logging secret values.
 *
 * Critical vs advisory:
 * - Email as AUTOTASK_USERNAME → almost always 401 (use Username Key)
 * - $ / # inside a healthy-length secret → normal for Autotask; only warn if
 *   secret looks truncated or contains Compose expansion markers (${…})
 */
export function diagnoseAutotaskEnv(): {
  configured: boolean;
  issues: string[];
  criticalIssues: string[];
  usernameLooksLikeEmail: boolean;
  secretLength: number;
  integrationCodeLength: number;
  usernameLength: number;
  secretHasDollar: boolean;
  secretHasHash: boolean;
  secretLooksTruncated: boolean;
  zonePinned: boolean;
} {
  const integrationCode = cleanEnv(process.env.AUTOTASK_INTEGRATION_CODE);
  const username = cleanEnv(process.env.AUTOTASK_USERNAME);
  const secret = cleanEnv(process.env.AUTOTASK_SECRET);
  const zone = cleanEnv(process.env.AUTOTASK_ZONE_URL);
  const issues: string[] = [];
  const criticalIssues: string[] = [];
  const usernameLooksLikeEmail = /@/.test(username);
  const secretHasDollar = secret.includes("$");
  const secretHasHash = secret.includes("#");
  const secretLooksTruncated = secret.length > 0 && secret.length < 16;
  const secretLooksExpanded =
    secret.includes("${") ||
    (secret.includes("{") && secret.includes("}")) ||
    /\$[A-Za-z_][A-Za-z0-9_]*/.test(secret);

  if (!integrationCode || !username || !secret) {
    const msg =
      "One or more of AUTOTASK_INTEGRATION_CODE / AUTOTASK_USERNAME / AUTOTASK_SECRET is empty after loading .env";
    issues.push(msg);
    criticalIssues.push(msg);
  }

  if (usernameLooksLikeEmail) {
    const msg =
      "CRITICAL: AUTOTASK_USERNAME is an email address. Autotask API will return 401. Open Autotask → Admin → Resources (Users) → your API User → Credentials tab → copy “Username (Key)” (long key, not the login email) into AUTOTASK_USERNAME.";
    issues.push(msg);
    criticalIssues.push(msg);
  }

  if (secretLooksTruncated) {
    const msg = `CRITICAL: AUTOTASK_SECRET looks truncated (length ${secret.length}). Re-copy the full Secret from Autotask Credentials and put it in single quotes: AUTOTASK_SECRET='…'`;
    issues.push(msg);
    criticalIssues.push(msg);
  }

  if (integrationCode.length > 0 && integrationCode.length < 6) {
    const msg =
      "CRITICAL: AUTOTASK_INTEGRATION_CODE looks too short. Use the API Tracking Identifier from the API User Credentials tab.";
    issues.push(msg);
    criticalIssues.push(msg);
  }

  // $ and # are common in real Autotask secrets. Only treat as problems when
  // the value looks Compose-expanded or truncated — not merely "contains $".
  if (secretHasDollar || secretHasHash) {
    if (secretLooksExpanded || secretLooksTruncated) {
      const msg =
        "AUTOTASK_SECRET may be corrupted by Docker Compose ($ expansion or # truncation). Re-paste the FULL secret inside single quotes in /opt/akab-portal/.env then: docker compose up -d --force-recreate app";
      issues.push(msg);
      criticalIssues.push(msg);
    } else {
      issues.push(
        "Note: AUTOTASK_SECRET contains $ and/or # (normal for Autotask). Keep it single-quoted in .env. With the current app image the mounted .env is re-read without Compose expansion.",
      );
    }
  }

  return {
    configured: Boolean(integrationCode && username && secret),
    issues,
    criticalIssues,
    usernameLooksLikeEmail,
    secretLength: secret.length,
    integrationCodeLength: integrationCode.length,
    usernameLength: username.length,
    secretHasDollar,
    secretHasHash,
    secretLooksTruncated,
    zonePinned: Boolean(zone),
  };
}


/**
 * Normalize zone base to .../atservicesrest/ (lowercase path — IIS is usually
 * case-insensitive, but some reverse proxies are not). Avoid double-appending
 * when zoneInformation returns ATServicesRest.
 */
function normalizeBase(url: string) {
  let u = url.trim();
  u = u.replace(/\/ATServicesRest\/?/i, "/atservicesrest/");
  if (!u.toLowerCase().includes("/atservicesrest")) {
    u = u.replace(/\/?$/, "/atservicesrest/");
  }
  if (!u.endsWith("/")) u += "/";
  u = u.replace(/([^:]\/)\/+/g, "$1");
  return u;
}

export function getAutotaskConfigFromEnv(): AutotaskConfig | null {
  const integrationCode = cleanEnv(process.env.AUTOTASK_INTEGRATION_CODE);
  const username = cleanEnv(process.env.AUTOTASK_USERNAME);
  const secret = cleanEnv(process.env.AUTOTASK_SECRET);
  if (!integrationCode || !username || !secret) return null;
  const zone = cleanEnv(process.env.AUTOTASK_ZONE_URL);
  return {
    integrationCode,
    username,
    secret,
    zoneBaseUrl: zone || undefined,
  };
}

export function isAutotaskConfigured() {
  return getAutotaskConfigFromEnv() != null;
}

/** In-memory zone cache (per process). Cleared on 401/410 so a bad pin can recover. */
let cachedZoneBase: string | null = null;
let cachedZoneKey: string | null = null;

function zoneCacheKey(cfg: AutotaskConfig): string {
  return `${cfg.username}|${cfg.zoneBaseUrl || ""}|${cfg.integrationCode.slice(0, 8)}`;
}

export function clearAutotaskZoneCache(): void {
  cachedZoneBase = null;
  cachedZoneKey = null;
}

export async function resolveZoneBase(
  cfg: AutotaskConfig,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const key = zoneCacheKey(cfg);
  if (!opts?.forceRefresh && cachedZoneBase && cachedZoneKey === key) {
    return cachedZoneBase;
  }

  if (cfg.zoneBaseUrl) {
    const base = normalizeBase(cfg.zoneBaseUrl);
    cachedZoneBase = base;
    cachedZoneKey = key;
    return base;
  }

  const zoneRes = await fetch(
    `https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user=${encodeURIComponent(cfg.username)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!zoneRes.ok) {
    throw new Error(
      `Autotask zone lookup failed (${zoneRes.status}). Check AUTOTASK_USERNAME (API Username/Key) is correct.`,
    );
  }
  const zone = (await zoneRes.json()) as { url?: string; zoneName?: string };
  if (!zone.url) throw new Error("Autotask zone lookup returned no URL");
  const base = normalizeBase(zone.url);
  cachedZoneBase = base;
  cachedZoneKey = key;
  return base;
}

function authHeaders(
  cfg: AutotaskConfig,
  opts?: { jsonBody?: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    ApiIntegrationCode: cfg.integrationCode,
    UserName: cfg.username,
    Secret: cfg.secret,
    Accept: "application/json",
  };
  // Only set Content-Type when sending a JSON body. Some gateways reject GET + Content-Type.
  if (opts?.jsonBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function atFetch(
  url: string,
  cfg: AutotaskConfig,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const hasBody = init?.body != null && method !== "GET" && method !== "HEAD";
  return fetch(url, {
    ...init,
    headers: {
      ...authHeaders(cfg, { jsonBody: hasBody }),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}


/**
 * Flatten Autotask error payloads to a readable string.
 * Autotask often returns: { errors: [{ code, id, message }, ...] }
 */
export function formatAutotaskErrorPayload(
  data: unknown,
  fallback = "Unknown Autotask error",
): string {
  if (data == null) return fallback;
  if (typeof data === "string") {
    const t = data.trim();
    return t || fallback;
  }
  if (typeof data === "number" || typeof data === "boolean") {
    return String(data);
  }
  if (Array.isArray(data)) {
    const parts = data
      .map((item) => formatAutotaskErrorPayload(item, ""))
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : fallback;
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.trim()) {
      const code =
        obj.code != null && String(obj.code).trim()
          ? ` (${String(obj.code)})`
          : "";
      return `${obj.message.trim()}${code}`;
    }
    if (obj.errors != null) {
      return formatAutotaskErrorPayload(obj.errors, fallback);
    }
    if (obj.error != null) {
      return formatAutotaskErrorPayload(obj.error, fallback);
    }
    try {
      return JSON.stringify(data);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function auth401Help(entityLabel: string, detail: string): string {
  const envDiag = diagnoseAutotaskEnv();
  // Lead with the real blocker — email username causes almost every "sudden" 401.
  if (envDiag.usernameLooksLikeEmail) {
    return (
      `Autotask ${entityLabel} failed (401 Unauthorized): ${detail || "credentials rejected"}. ` +
      "PRIMARY FIX: AUTOTASK_USERNAME is set to an email. Replace it with the API “Username (Key)” " +
      "from Autotask → Admin → Resources → API User → Credentials (long key, not the login email). " +
      "Also set AUTOTASK_INTEGRATION_CODE = API Tracking Identifier and " +
      "AUTOTASK_SECRET='full-secret' (single quotes). Then: " +
      "docker compose up -d --force-recreate app && curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'"
    );
  }
  const extra: string[] = [];
  if (envDiag.secretLooksTruncated) {
    extra.push(
      `AUTOTASK_SECRET length is only ${envDiag.secretLength} (likely truncated). Re-copy the full secret inside single quotes.`,
    );
  }
  if (envDiag.criticalIssues.length && !envDiag.usernameLooksLikeEmail) {
    extra.push(...envDiag.criticalIssues.slice(0, 2));
  }
  const hint = extra.length ? ` ${extra.join(" ")}` : "";
  return (
    `Autotask ${entityLabel} failed (401 Unauthorized): ${detail || "credentials rejected"}.${hint} ` +
    "Fix /opt/akab-portal/.env then recreate the container: " +
    "(1) AUTOTASK_INTEGRATION_CODE = API Tracking Identifier, " +
    "(2) AUTOTASK_USERNAME = Username (Key) — not a login email, " +
    "(3) AUTOTASK_SECRET='full-secret' ← always use single quotes, " +
    "(4) API user = API User (API-only) with Tickets View + Contacts View, " +
    "(5) remove AUTOTASK_ZONE_URL unless you must pin a zone. " +
    "Then: docker compose up -d --force-recreate app && curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'"
  );
}

function throwAutotaskHttpError(
  entityLabel: string,
  status: number,
  data: unknown,
  text: string,
): never {
  const detail = formatAutotaskErrorPayload(
    data,
    text.slice(0, 400) || "No details",
  );
  if (status === 401) {
    throw new Error(auth401Help(entityLabel, detail));
  }
  if (status === 403) {
    throw new Error(
      `Autotask ${entityLabel} failed (403 Forbidden): ${detail}. ` +
        "Credentials were accepted but this API user cannot access that entity. " +
        "Edit the API User security level and enable CRM → Contacts (View) and Service Desk → Tickets (View).",
    );
  }
  if (status === 410) {
    throw new Error(
      `Autotask ${entityLabel} failed (410 Gone): ${detail}. ` +
        "The Autotask zone URL is no longer valid. Clear AUTOTASK_ZONE_URL if set, then retry.",
    );
  }
  throw new Error(`Autotask ${entityLabel} failed (${status}): ${detail}`);
}

async function postQueryOnce<T>(
  base: string,
  cfg: AutotaskConfig,
  entityPath: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; data: unknown; text: string }> {
  const url = `${base}v1.0/${entityPath}`;
  const res = await atFetch(url, cfg, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, data, text };
  }
  return { ok: true, data: data as T };
}

async function postQuery<T>(
  base: string,
  cfg: AutotaskConfig,
  entityPath: string,
  body: unknown,
): Promise<T> {
  let result = await postQueryOnce<T>(base, cfg, entityPath, body);
  if (
    !result.ok &&
    (result.status === 401 || result.status === 410) &&
    !cfg.zoneBaseUrl
  ) {
    // Stale zone discovery — refresh once and retry
    clearAutotaskZoneCache();
    try {
      const freshBase = await resolveZoneBase(cfg, { forceRefresh: true });
      if (freshBase !== base) {
        result = await postQueryOnce<T>(freshBase, cfg, entityPath, body);
      }
    } catch {
      /* keep original failure */
    }
  }
  if (!result.ok) {
    throwAutotaskHttpError(entityPath, result.status, result.data, result.text);
  }
  return result.data;
}

type FieldsResponse = {
  fields?: Array<{
    name?: string;
    picklistValues?: Array<{
      value?: string;
      label?: string;
      isActive?: boolean;
      isSystem?: boolean;
    }>;
  }>;
};

async function getPicklistMap(
  base: string,
  cfg: AutotaskConfig,
  entity: string,
  fieldName: string,
): Promise<Record<string, string>> {
  try {
    const res = await atFetch(
      `${base}v1.0/${entity}/entityInformation/fields`,
      cfg,
    );
    if (!res.ok) return {};
    const data = (await res.json()) as FieldsResponse;
    const field = data.fields?.find(
      (f) => f.name?.toLowerCase() === fieldName.toLowerCase(),
    );
    const map: Record<string, string> = {};
    for (const p of field?.picklistValues ?? []) {
      if (p.value != null && p.label) map[String(p.value)] = p.label;
    }
    return map;
  } catch {
    return {};
  }
}

/** Status values commonly treated as complete/closed in Autotask (tenant-specific). */
const DEFAULT_COMPLETE_STATUSES = new Set([5]);

function completeStatusValues(statusLabels: Record<string, string>): number[] {
  const completeValues = new Set<number>(DEFAULT_COMPLETE_STATUSES);
  for (const [value, label] of Object.entries(statusLabels)) {
    const l = label.toLowerCase();
    if (
      l.includes("complete") ||
      l.includes("closed") ||
      l.includes("canceled") ||
      l.includes("cancelled")
    ) {
      completeValues.add(Number(value));
    }
  }
  return [...completeValues].filter((n) => Number.isFinite(n));
}

function mapTickets(
  items: RawTicket[],
  statusLabels: Record<string, string>,
  priorityLabels: Record<string, string>,
): MappedTicket[] {
  const tickets: MappedTicket[] = items.map((t) => {
    const status = t.status ?? 0;
    const priority = t.priority ?? null;
    return {
      id: t.id,
      ticketNumber: t.ticketNumber ?? String(t.id),
      title: t.title ?? "(no title)",
      description: t.description ?? null,
      status,
      statusLabel: statusLabels[String(status)] ?? `Status ${status}`,
      priority,
      priorityLabel:
        priority == null
          ? null
          : (priorityLabels[String(priority)] ?? `Priority ${priority}`),
      createDate: t.createDate ?? null,
      dueDateTime: t.dueDateTime ?? null,
      lastActivityDate: t.lastActivityDate ?? null,
      companyID: t.companyID ?? null,
      contactID: t.contactID ?? null,
      createdByContactID: t.createdByContactID ?? null,
    };
  });

  tickets.sort((a, b) => {
    const da = a.lastActivityDate || a.createDate || "";
    const db = b.lastActivityDate || b.createDate || "";
    return db.localeCompare(da);
  });

  return tickets;
}

const TICKET_INCLUDE_FIELDS = [
  "id",
  "ticketNumber",
  "title",
  "description",
  "status",
  "priority",
  "createDate",
  "dueDateTime",
  "lastActivityDate",
  "companyID",
  "contactID",
  "createdByContactID",
];


/** Lightweight auth + Contacts permission probe for /api/autotask/status */
export async function probeAutotaskAccess(): Promise<{
  ok: boolean;
  zoneOk?: boolean;
  zoneUrl?: string;
  authOk?: boolean;
  ticketsAuthOk?: boolean;
  contactsAuthOk?: boolean;
  httpStatus?: number;
  message: string;
  detail?: string;
}> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) {
    return {
      ok: false,
      zoneOk: false,
      authOk: false,
      ticketsAuthOk: false,
      contactsAuthOk: false,
      message:
        "Autotask credentials missing. Set AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
    };
  }

  let zoneUrl: string;
  try {
    zoneUrl = await resolveZoneBase(cfg, { forceRefresh: true });
  } catch (e) {
    return {
      ok: false,
      zoneOk: false,
      authOk: false,
      ticketsAuthOk: false,
      contactsAuthOk: false,
      message: e instanceof Error ? e.message : "Zone lookup failed",
    };
  }

  // GET probes — no Content-Type header
  const getHeaders = authHeaders(cfg, { jsonBody: false });

  const ticketProbe = await fetch(`${zoneUrl}v1.0/Tickets/entityInformation`, {
    method: "GET",
    headers: getHeaders,
  });
  if (!ticketProbe.ok) {
    const textBody = await ticketProbe.text().catch(() => "");
    let parsed: unknown = textBody;
    try {
      parsed = textBody ? JSON.parse(textBody) : null;
    } catch {
      /* keep text */
    }
    const detail = formatAutotaskErrorPayload(
      parsed,
      textBody.slice(0, 200) || "No details",
    );
    return {
      ok: false,
      zoneOk: true,
      zoneUrl,
      authOk: false,
      ticketsAuthOk: false,
      contactsAuthOk: false,
      httpStatus: ticketProbe.status,
      detail,
      message:
        ticketProbe.status === 401
          ? auth401Help("Tickets/entityInformation", detail)
          : `Autotask Tickets probe failed (${ticketProbe.status}): ${detail}`,
    };
  }

  // Contacts entity info
  let contactsEntityOk = false;
  const contactProbe = await fetch(`${zoneUrl}v1.0/Contacts/entityInformation`, {
    method: "GET",
    headers: getHeaders,
  });
  if (contactProbe.ok) {
    contactsEntityOk = true;
  }

  // Contacts/query — required for client ticket email matching.
  // Try a few Autotask-safe filters (tenants differ on "exist").
  const queryBodies = [
    {
      MaxRecords: 1,
      IncludeFields: ["id", "emailAddress", "companyID"],
      filter: [{ op: "gte", field: "id", value: 0 }],
    },
    {
      MaxRecords: 1,
      IncludeFields: ["id"],
      filter: [{ op: "exist", field: "id" }],
    },
  ];

  let contactsQueryOk = false;
  let contactsQueryError: string | null = null;
  let contactsHttp: number | undefined;

  for (const body of queryBodies) {
    try {
      await postQuery(zoneUrl, cfg, "Contacts/query", body);
      contactsQueryOk = true;
      contactsQueryError = null;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      contactsQueryError = msg;
      if (/\(401\b/.test(msg)) contactsHttp = 401;
      else if (/\(403\b/.test(msg)) contactsHttp = 403;
      else if (/\(400\b/.test(msg)) contactsHttp = 400;
      // try next filter shape
    }
  }

  const contactsAuthOk = contactsQueryOk || contactsEntityOk;

  // Main connection = Tickets auth. Contacts is reported separately so Settings
  // does not look "fully down" when only Contacts permission is missing.
  if (!contactsQueryOk) {
    const detail = contactsQueryError || "Contacts/query failed";
    const msg = contactsEntityOk
      ? `Autotask Tickets API is connected, but Contacts/query failed: ${detail}. Client tickets need Contacts View on the API User security level (CRM → Contacts). Company search may still work.`
      : `Autotask Tickets API is connected, but Contacts access failed: ${detail}. Enable CRM → Contacts → View on the API User (API-only) security level.`;

    return {
      ok: true, // tickets connected
      zoneOk: true,
      zoneUrl,
      authOk: true,
      ticketsAuthOk: true,
      contactsAuthOk: false,
      httpStatus: contactsHttp,
      detail,
      message: msg,
    };
  }

  return {
    ok: true,
    zoneOk: true,
    zoneUrl,
    authOk: true,
    ticketsAuthOk: true,
    contactsAuthOk: true,
    message:
      "Connected to Autotask PSA (Tickets + Contacts). Client tickets load when portal email matches an Autotask Contact and the company has Autotask Company ID set.",
  };
}


export async function findContactsByEmail(
  email: string,
  opts?: { companyId?: number | null },
): Promise<AutotaskContact[]> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");
  const base = await resolveZoneBase(cfg);
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return [];

  type ContactRaw = {
    id?: number;
    emailAddress?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyID?: number | null;
    isActive?: number | boolean | null;
  };
  type QueryRes = { items?: ContactRaw[] };

  const mapContact = (c: ContactRaw): AutotaskContact => ({
    id: Number(c.id),
    emailAddress: c.emailAddress ?? null,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    companyID: c.companyID ?? null,
    isActive: c.isActive === true || c.isActive === 1,
  });

  const include = [
    "id",
    "firstName",
    "lastName",
    "emailAddress",
    "companyID",
    "isActive",
  ];

  const exactFilter: Array<Record<string, unknown>> = [
    { op: "eq", field: "emailAddress", value: email.trim() },
  ];
  if (opts?.companyId != null && Number.isFinite(opts.companyId)) {
    exactFilter.push({ op: "eq", field: "companyID", value: opts.companyId });
  }

  let data = await postQuery<QueryRes>(base, cfg, "Contacts/query", {
    MaxRecords: 25,
    IncludeFields: include,
    filter:
      exactFilter.length === 1
        ? exactFilter
        : [{ op: "and", items: exactFilter }],
  });

  let items = data.items ?? [];

  // Fallback: case variants / contains (some tenants store mixed case)
  if (items.length === 0) {
    const looseFilter: Array<Record<string, unknown>> = [
      { op: "contains", field: "emailAddress", value: normalized },
    ];
    if (opts?.companyId != null && Number.isFinite(opts.companyId)) {
      looseFilter.push({ op: "eq", field: "companyID", value: opts.companyId });
    }
    data = await postQuery<QueryRes>(base, cfg, "Contacts/query", {
      MaxRecords: 25,
      IncludeFields: include,
      filter:
        looseFilter.length === 1
          ? looseFilter
          : [{ op: "and", items: looseFilter }],
    });
    items = (data.items ?? []).filter(
      (c) => (c.emailAddress ?? "").trim().toLowerCase() === normalized,
    );
  }

  // If company-scoped search missed (contact under parent/0), retry without company
  if (
    items.length === 0 &&
    opts?.companyId != null &&
    Number.isFinite(opts.companyId)
  ) {
    return findContactsByEmail(email, undefined);
  }

  return items
    .filter((c) => c.id != null && Number.isFinite(Number(c.id)))
    .map(mapContact);
}

export async function fetchOpenTicketsForCompany(
  autotaskCompanyId: string | number,
  opts?: {
    /** When set, only tickets for this Autotask contact (ticket contact OR creator contact). */
    contactIds?: number[];
  },
): Promise<{
  tickets: MappedTicket[];
  statusLabels: Record<string, string>;
  priorityLabels: Record<string, string>;
  zoneUrl: string;
}> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");

  const base = await resolveZoneBase(cfg);
  const companyIdNum = Number(autotaskCompanyId);
  if (!Number.isFinite(companyIdNum)) {
    throw new Error("Invalid Autotask company ID");
  }

  const [statusLabels, priorityLabels] = await Promise.all([
    getPicklistMap(base, cfg, "Tickets", "status"),
    getPicklistMap(base, cfg, "Tickets", "priority"),
  ]);

  const completeValues = completeStatusValues(statusLabels);

  const filterItems: Array<Record<string, unknown>> = [
    { op: "eq", field: "companyID", value: companyIdNum },
  ];

  if (completeValues.length > 0) {
    filterItems.push({
      op: "notIn",
      field: "status",
      value: completeValues,
    });
  }

  const contactIds = (opts?.contactIds ?? []).filter((id) =>
    Number.isFinite(id),
  );

  // Scope to the logged-in contact: ticket's Contact OR Created-by Contact
  if (contactIds.length === 1) {
    const cid = contactIds[0];
    filterItems.push({
      op: "or",
      items: [
        { op: "eq", field: "contactID", value: cid },
        { op: "eq", field: "createdByContactID", value: cid },
      ],
    });
  } else if (contactIds.length > 1) {
    filterItems.push({
      op: "or",
      items: [
        { op: "in", field: "contactID", value: contactIds },
        { op: "in", field: "createdByContactID", value: contactIds },
      ],
    });
  }

  const body = {
    MaxRecords: 100,
    IncludeFields: TICKET_INCLUDE_FIELDS,
    filter: [{ op: "and", items: filterItems }],
  };

  type QueryRes = { items?: RawTicket[] };
  const data = await postQuery<QueryRes>(base, cfg, "Tickets/query", body);
  const tickets = mapTickets(data.items ?? [], statusLabels, priorityLabels);

  return { tickets, statusLabels, priorityLabels, zoneUrl: base };
}

/**
 * Open tickets for one portal user: match Autotask Contact by email, then
 * return only tickets where they are the ticket contact or creator contact.
 */
export async function fetchOpenTicketsForUser(opts: {
  autotaskCompanyId: string | number;
  userEmail: string;
}): Promise<{
  tickets: MappedTicket[];
  statusLabels: Record<string, string>;
  priorityLabels: Record<string, string>;
  zoneUrl: string;
  contacts: AutotaskContact[];
  contactMatched: boolean;
}> {
  const companyIdNum = Number(opts.autotaskCompanyId);
  const contacts = await findContactsByEmail(opts.userEmail, {
    companyId: Number.isFinite(companyIdNum) ? companyIdNum : null,
  });

  if (contacts.length === 0) {
    const cfg = getAutotaskConfigFromEnv();
    if (!cfg) throw new Error("Autotask is not configured");
    const base = await resolveZoneBase(cfg);
    const [statusLabels, priorityLabels] = await Promise.all([
      getPicklistMap(base, cfg, "Tickets", "status"),
      getPicklistMap(base, cfg, "Tickets", "priority"),
    ]);
    return {
      tickets: [],
      statusLabels,
      priorityLabels,
      zoneUrl: base,
      contacts: [],
      contactMatched: false,
    };
  }

  const result = await fetchOpenTicketsForCompany(opts.autotaskCompanyId, {
    contactIds: contacts.map((c) => c.id),
  });

  return {
    ...result,
    contacts,
    contactMatched: true,
  };
}

// ── Ticket notes / detail / close ──────────────────────────────────────────

export type RawTicketNote = {
  id?: number;
  ticketID?: number;
  title?: string | null;
  description?: string | null;
  noteType?: number | null;
  publish?: number | null;
  createDateTime?: string | null;
  lastActivityDate?: string | null;
  creatorResourceID?: number | null;
  createdByContactID?: number | null;
};

export type MappedTicketNote = {
  id: number;
  ticketID: number;
  title: string | null;
  description: string;
  noteType: number | null;
  noteTypeLabel: string | null;
  publish: number | null;
  publishLabel: string | null;
  createDateTime: string | null;
  lastActivityDate: string | null;
  creatorResourceID: number | null;
  createdByContactID: number | null;
  /** true when the note was authored by a contact (client-side reply) */
  fromContact: boolean;
};

function mapNote(
  n: RawTicketNote,
  noteTypeLabels: Record<string, string>,
  publishLabels: Record<string, string>,
): MappedTicketNote {
  const noteType = n.noteType ?? null;
  const publish = n.publish ?? null;
  return {
    id: Number(n.id),
    ticketID: Number(n.ticketID ?? 0),
    title: n.title ?? null,
    description: n.description ?? "",
    noteType,
    noteTypeLabel:
      noteType == null
        ? null
        : (noteTypeLabels[String(noteType)] ?? `Type ${noteType}`),
    publish,
    publishLabel:
      publish == null
        ? null
        : (publishLabels[String(publish)] ?? `Publish ${publish}`),
    createDateTime: n.createDateTime ?? null,
    lastActivityDate: n.lastActivityDate ?? null,
    creatorResourceID: n.creatorResourceID ?? null,
    createdByContactID: n.createdByContactID ?? null,
    fromContact: n.createdByContactID != null && Number(n.createdByContactID) > 0,
  };
}

async function getEntityById<T>(
  base: string,
  cfg: AutotaskConfig,
  entityPath: string,
  id: number,
): Promise<T | null> {
  const res = await atFetch(`${base}v1.0/${entityPath}/${id}`, cfg);
  if (res.status === 404) return null;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throwAutotaskHttpError(`${entityPath}/${id}`, res.status, data, text);
  }
  // Autotask wraps single entity as { item: {...} }
  if (data && typeof data === "object" && "item" in data) {
    return (data as { item: T }).item ?? null;
  }
  return (data as T) ?? null;
}

async function patchEntity(
  base: string,
  cfg: AutotaskConfig,
  entityPath: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await atFetch(`${base}v1.0/${entityPath}`, cfg, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throwAutotaskHttpError(`PATCH ${entityPath}`, res.status, data, text);
  }
}

async function postEntity(
  base: string,
  cfg: AutotaskConfig,
  entityPath: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await atFetch(`${base}v1.0/${entityPath}`, cfg, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throwAutotaskHttpError(`POST ${entityPath}`, res.status, data, text);
  }
  if (data && typeof data === "object" && "itemId" in data) {
    return Number((data as { itemId: number }).itemId);
  }
  return 0;
}

function pickDefaultFromLabels(
  labels: Record<string, string>,
  prefer: string[],
  fallback: number,
): number {
  for (const want of prefer) {
    const found = Object.entries(labels).find(([, label]) =>
      label.toLowerCase().includes(want.toLowerCase()),
    );
    if (found) {
      const n = Number(found[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  const first = Object.keys(labels)[0];
  if (first != null && Number.isFinite(Number(first))) return Number(first);
  return fallback;
}

export async function fetchTicketById(ticketId: number): Promise<{
  ticket: MappedTicket | null;
  statusLabels: Record<string, string>;
  priorityLabels: Record<string, string>;
}> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");
  const base = await resolveZoneBase(cfg);

  const [raw, statusLabels, priorityLabels] = await Promise.all([
    getEntityById<RawTicket>(base, cfg, "Tickets", ticketId),
    getPicklistMap(base, cfg, "Tickets", "status"),
    getPicklistMap(base, cfg, "Tickets", "priority"),
  ]);

  if (!raw || raw.id == null) {
    return { ticket: null, statusLabels, priorityLabels };
  }

  const mapped = mapTickets([raw], statusLabels, priorityLabels);
  return { ticket: mapped[0] ?? null, statusLabels, priorityLabels };
}

export async function fetchTicketNotes(ticketId: number): Promise<{
  notes: MappedTicketNote[];
  noteTypeLabels: Record<string, string>;
  publishLabels: Record<string, string>;
}> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");
  const base = await resolveZoneBase(cfg);

  const [noteTypeLabels, publishLabels] = await Promise.all([
    getPicklistMap(base, cfg, "TicketNotes", "noteType"),
    getPicklistMap(base, cfg, "TicketNotes", "publish"),
  ]);

  type QueryRes = { items?: RawTicketNote[] };

  // Prefer child collection; fall back to entity query
  let items: RawTicketNote[] = [];
  try {
    const childRes = await atFetch(
      `${base}v1.0/Tickets/${ticketId}/Notes?MaxRecords=100`,
      cfg,
    );
    if (childRes.ok) {
      const childData = (await childRes.json()) as QueryRes;
      items = childData.items ?? [];
    }
  } catch {
    /* fall through to query */
  }

  if (items.length === 0) {
    try {
      const data = await postQuery<QueryRes>(base, cfg, "TicketNotes/query", {
        MaxRecords: 100,
        IncludeFields: [
          "id",
          "ticketID",
          "title",
          "description",
          "noteType",
          "publish",
          "createDateTime",
          "lastActivityDate",
          "creatorResourceID",
          "createdByContactID",
        ],
        filter: [{ op: "eq", field: "ticketID", value: ticketId }],
      });
      items = data.items ?? [];
    } catch {
      items = [];
    }
  }

  // Conversation only: tech ↔ client messages. Hide workflow/system/internal noise.
  // Newest on top, oldest at bottom.
  const notes = items
    .filter((n) => n.id != null)
    .map((n) => mapNote(n, noteTypeLabels, publishLabels))
    .filter(isClientConversationNote)
    .sort((a, b) => {
      const da = a.createDateTime || a.lastActivityDate || "";
      const db = b.createDateTime || b.lastActivityDate || "";
      return db.localeCompare(da);
    });

  return { notes, noteTypeLabels, publishLabels };
}

/**
 * Keep only notes that look like real tech ↔ client conversation.
 * Drops workflow, RMM, status-change, checklist, and internal-only noise.
 */
function isClientConversationNote(n: MappedTicketNote): boolean {
  const title = (n.title ?? "").toLowerCase().trim();
  const body = (n.description ?? "").toLowerCase().trim();
  const typeLabel = (n.noteTypeLabel ?? "").toLowerCase();
  const publishLabel = (n.publishLabel ?? "").toLowerCase();

  if (!body && !title) return false;

  // Never show pure internal notes
  if (
    publishLabel.includes("internal") &&
    !publishLabel.includes("all") &&
    !publishLabel.includes("client") &&
    !publishLabel.includes("customer") &&
    !publishLabel.includes("portal")
  ) {
    return false;
  }

  // Workflow / system note types
  if (
    typeLabel.includes("workflow") ||
    typeLabel.includes("system") ||
    typeLabel.includes("rma") ||
    typeLabel.includes("checklist") ||
    typeLabel.includes("survey") ||
    typeLabel.includes("quality")
  ) {
    return false;
  }

  const noiseTitle =
    /^(workflow|system|status|status change|ticket status|auto|automated|rmm|alert|datto|n-able|connectwise|backup|monitor|sla|escalation rule|rule fired)/i;
  if (title && noiseTitle.test(title) && !n.fromContact) return false;

  const noiseBody =
    /^(status (was |is |changed|set)|ticket (was |is )?(assigned|created|updated|merged)|priority (was |changed)|queue (was |changed)|assigned to |reassigned |sla |workflow rule|automatically |this ticket was)/i;
  if (!n.fromContact && body && noiseBody.test(body) && body.length < 280) {
    return false;
  }

  // Keep client replies (portal stamp or contact-authored)
  if (n.fromContact) return true;
  if (body.includes("client portal") || title.includes("client portal")) return true;
  if (title.includes("elevation") || body.includes("elevation requested")) {
    return true;
  }

  // Keep normal technician conversation notes
  if (
    typeLabel.includes("detail") ||
    typeLabel.includes("summary") ||
    typeLabel.includes("customer") ||
    typeLabel.includes("client") ||
    typeLabel.includes("task") ||
    typeLabel.includes("general") ||
    typeLabel === "" ||
    typeLabel.startsWith("type ")
  ) {
    return true;
  }

  if (
    publishLabel.includes("all") ||
    publishLabel.includes("client") ||
    publishLabel.includes("customer") ||
    publishLabel.includes("portal") ||
    !publishLabel
  ) {
    return body.length >= 8;
  }

  return false;
}

export async function createTicketNote(opts: {
  ticketId: number;
  title: string;
  description: string;
  /** When set, attributes the note to this Autotask contact */
  contactId?: number | null;
  /** Portal user email — stamped into the note body for staff visibility */
  userEmail?: string | null;
  userName?: string | null;
}): Promise<{ noteId: number }> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");
  const base = await resolveZoneBase(cfg);

  const [noteTypeLabels, publishLabels] = await Promise.all([
    getPicklistMap(base, cfg, "TicketNotes", "noteType"),
    getPicklistMap(base, cfg, "TicketNotes", "publish"),
  ]);

  // Prefer customer-visible publish + a general/detail note type
  const publish = pickDefaultFromLabels(
    publishLabels,
    ["all autotask", "all users", "client", "portal", "all"],
    1,
  );
  const noteType = pickDefaultFromLabels(
    noteTypeLabels,
    ["detail", "ticket detail", "task detail", "general", "summary", "customer"],
    1,
  );

  const title = opts.title.trim().slice(0, 250) || "Client reply";
  const rawDescription = opts.description.trim();
  if (!rawDescription) throw new Error("Note description is required");

  // Always stamp who replied from the portal so staff can see it even when
  // createdByContactID cannot be set (inactive contact, missing rights, etc.)
  const who =
    [opts.userName?.trim(), opts.userEmail?.trim()].filter(Boolean).join(" · ") ||
    opts.userEmail?.trim() ||
    "Client portal user";
  const description = `[Client portal reply — ${who}]\n\n${rawDescription}`.slice(
    0,
    32000,
  );

  const baseBody: Record<string, unknown> = {
    ticketID: opts.ticketId,
    title,
    description,
    noteType,
    publish,
  };

  const tryPost = async (body: Record<string, unknown>) => {
    try {
      return await postEntity(
        base,
        cfg,
        `Tickets/${opts.ticketId}/Notes`,
        body,
      );
    } catch (childErr) {
      try {
        return await postEntity(base, cfg, "TicketNotes", body);
      } catch {
        throw childErr;
      }
    }
  };

  // Attempt with contact attribution first (active contacts only usually work)
  if (opts.contactId != null && Number.isFinite(opts.contactId)) {
    try {
      const noteId = await tryPost({
        ...baseBody,
        createdByContactID: opts.contactId,
      });
      return { noteId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Inactive / invalid contact — retry without attribution
      if (
        /createdByContactID|contact/i.test(msg) &&
        /(invalid|does not exist|inactive|not active)/i.test(msg)
      ) {
        const noteId = await tryPost(baseBody);
        return { noteId };
      }
      throw err;
    }
  }

  const noteId = await tryPost(baseBody);
  return { noteId };
}

export async function closeTicket(opts: {
  ticketId: number;
  resolution?: string | null;
}): Promise<{ ticket: MappedTicket }> {
  const cfg = getAutotaskConfigFromEnv();
  if (!cfg) throw new Error("Autotask is not configured");
  const base = await resolveZoneBase(cfg);

  const statusLabels = await getPicklistMap(base, cfg, "Tickets", "status");
  const completeValues = completeStatusValues(statusLabels);
  // Prefer label "Complete", then first complete-like value, else 5
  let completeStatus = 5;
  const byLabel = Object.entries(statusLabels).find(([, label]) =>
    /^complete$/i.test(label.trim()),
  );
  if (byLabel) completeStatus = Number(byLabel[0]);
  else if (completeValues.length > 0) completeStatus = completeValues[0];

  const patch: Record<string, unknown> = {
    id: opts.ticketId,
    status: completeStatus,
  };
  const resolution = opts.resolution?.trim();
  if (resolution) {
    patch.resolution = resolution.slice(0, 8000);
  }

  await patchEntity(base, cfg, "Tickets", patch);

  const { ticket } = await fetchTicketById(opts.ticketId);
  if (!ticket) {
    throw new Error("Ticket was closed but could not be reloaded");
  }
  return { ticket };
}

// ── Demo / mock store (dev when credentials are missing) ───────────────────

type MockStore = {
  tickets: Map<number, MappedTicket>;
  notes: Map<number, MappedTicketNote[]>;
  nextNoteId: number;
};

const mockStores = new Map<string, MockStore>();

function mockStoreKey(companyId?: string | null, email?: string | null) {
  return `${companyId ?? "0"}::${(email ?? "").toLowerCase()}`;
}

function ensureMockStore(
  autotaskCompanyId?: string | null,
  userEmail?: string | null,
): MockStore {
  const key = mockStoreKey(autotaskCompanyId, userEmail);
  let store = mockStores.get(key);
  if (!store) {
    const tickets = mockOpenTickets(autotaskCompanyId, { userEmail });
    store = {
      tickets: new Map(tickets.map((t) => [t.id, { ...t }])),
      notes: new Map(),
      nextNoteId: 1,
    };
    // Seed conversation notes (newest will sort to top in the UI)
    const first = tickets[0];
    if (first) {
      const now = Date.now();
      store.notes.set(first.id, [
        {
          id: store.nextNoteId++,
          ticketID: first.id,
          title: "Technician update",
          description:
            "We've started investigating. We'll follow up once we have more information.",
          noteType: 1,
          noteTypeLabel: "Ticket Detail",
          publish: 1,
          publishLabel: "All Autotask Users",
          createDateTime: new Date(now - 1000 * 60 * 40).toISOString(),
          lastActivityDate: new Date(now - 1000 * 60 * 40).toISOString(),
          creatorResourceID: 1,
          createdByContactID: null,
          fromContact: false,
        },
        {
          id: store.nextNoteId++,
          ticketID: first.id,
          title: "Initial report",
          description:
            first.description ||
            "Client reported the issue via the SOLU TI portal.",
          noteType: 1,
          noteTypeLabel: "Ticket Detail",
          publish: 1,
          publishLabel: "All Autotask Users",
          createDateTime: first.createDate,
          lastActivityDate: first.createDate,
          creatorResourceID: null,
          createdByContactID: first.contactID ?? null,
          fromContact: true,
        },
      ]);
    }
    mockStores.set(key, store);
  }
  return store;
}

/** Demo tickets when Autotask credentials are not configured */
export function mockOpenTickets(
  autotaskCompanyId?: string | null,
  opts?: { userEmail?: string | null },
): MappedTicket[] {
  const companyID = autotaskCompanyId ? Number(autotaskCompanyId) || 1001 : 1001;
  const now = Date.now();
  const email = (opts?.userEmail ?? "demo@example.com").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  const contactID = 800000 + (Math.abs(hash) % 100000);

  // If a live mock store already exists for this user, return its open tickets
  const key = mockStoreKey(autotaskCompanyId, email);
  const existing = mockStores.get(key);
  if (existing) {
    return [...existing.tickets.values()]
      .filter((t) => {
        const l = t.statusLabel.toLowerCase();
        return !l.includes("complete") && !l.includes("closed");
      })
      .sort((a, b) => {
        const da = a.lastActivityDate || a.createDate || "";
        const db = b.lastActivityDate || b.createDate || "";
        return db.localeCompare(da);
      });
  }

  return [
    {
      id: 90001,
      ticketNumber: "T20260001",
      title: "VPN intermittent disconnects",
      description:
        "Your VPN drops every 30–45 minutes during peak hours. Demo ticket while Autotask is not connected.",
      status: 1,
      statusLabel: "New",
      priority: 2,
      priorityLabel: "Medium",
      createDate: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
      dueDateTime: new Date(now + 1000 * 60 * 60 * 48).toISOString(),
      lastActivityDate: new Date(now - 1000 * 60 * 90).toISOString(),
      companyID,
      contactID,
      createdByContactID: contactID,
    },
    {
      id: 90002,
      ticketNumber: "T20260014",
      title: "Mailbox nearly full",
      description:
        "Your mailbox is at 98% capacity. Demo open ticket for you only.",
      status: 8,
      statusLabel: "In Progress",
      priority: 1,
      priorityLabel: "High",
      createDate: new Date(now - 1000 * 60 * 60 * 8).toISOString(),
      dueDateTime: new Date(now + 1000 * 60 * 60 * 12).toISOString(),
      lastActivityDate: new Date(now - 1000 * 60 * 20).toISOString(),
      companyID,
      contactID,
      createdByContactID: null,
    },
  ];
}

export function mockGetTicketDetail(
  ticketId: number,
  opts?: { autotaskCompanyId?: string | null; userEmail?: string | null },
): { ticket: MappedTicket | null; notes: MappedTicketNote[] } {
  const store = ensureMockStore(opts?.autotaskCompanyId, opts?.userEmail);
  const ticket = store.tickets.get(ticketId) ?? null;
  const notes = ticket
    ? [...(store.notes.get(ticketId) ?? [])]
        .filter(isClientConversationNote)
        .sort((a, b) => {
          const da = a.createDateTime || a.lastActivityDate || "";
          const db = b.createDateTime || b.lastActivityDate || "";
          return db.localeCompare(da); // newest first
        })
    : [];
  return { ticket, notes };
}

export function mockAddTicketNote(opts: {
  ticketId: number;
  title: string;
  description: string;
  autotaskCompanyId?: string | null;
  userEmail?: string | null;
  contactId?: number | null;
}): MappedTicketNote {
  const store = ensureMockStore(opts.autotaskCompanyId, opts.userEmail);
  const ticket = store.tickets.get(opts.ticketId);
  if (!ticket) throw new Error("Ticket not found");
  const now = new Date().toISOString();
  const note: MappedTicketNote = {
    id: store.nextNoteId++,
    ticketID: opts.ticketId,
    title: opts.title.trim() || "Client reply",
    description: opts.description.trim(),
    noteType: 1,
    noteTypeLabel: "Ticket Detail",
    publish: 1,
    publishLabel: "All Autotask Users",
    createDateTime: now,
    lastActivityDate: now,
    creatorResourceID: null,
    createdByContactID: opts.contactId ?? ticket.contactID ?? null,
    fromContact: true,
  };
  const list = store.notes.get(opts.ticketId) ?? [];
  list.unshift(note); // newest first
  store.notes.set(opts.ticketId, list);
  store.tickets.set(opts.ticketId, {
    ...ticket,
    lastActivityDate: now,
    status: ticket.status === 1 ? 8 : ticket.status,
    statusLabel: ticket.status === 1 ? "In Progress" : ticket.statusLabel,
  });
  return note;
}

export function mockCloseTicket(opts: {
  ticketId: number;
  resolution?: string | null;
  autotaskCompanyId?: string | null;
  userEmail?: string | null;
}): MappedTicket {
  const store = ensureMockStore(opts.autotaskCompanyId, opts.userEmail);
  const ticket = store.tickets.get(opts.ticketId);
  if (!ticket) throw new Error("Ticket not found");
  const now = new Date().toISOString();
  const closed: MappedTicket = {
    ...ticket,
    status: 5,
    statusLabel: "Complete",
    lastActivityDate: now,
  };
  store.tickets.set(opts.ticketId, closed);
  if (opts.resolution?.trim()) {
    const list = store.notes.get(opts.ticketId) ?? [];
    list.push({
      id: store.nextNoteId++,
      ticketID: opts.ticketId,
      title: "Closed by client",
      description: opts.resolution.trim(),
      noteType: 1,
      noteTypeLabel: "Ticket Detail",
      publish: 1,
      publishLabel: "All Autotask Users",
      createDateTime: now,
      lastActivityDate: now,
      creatorResourceID: null,
      createdByContactID: ticket.contactID ?? null,
      fromContact: true,
    });
    store.notes.set(opts.ticketId, list);
  }
  return closed;
}

/** Ensure mock store is primed so list + detail stay in sync */
export function primeMockTickets(
  autotaskCompanyId?: string | null,
  userEmail?: string | null,
) {
  ensureMockStore(autotaskCompanyId, userEmail);
}
