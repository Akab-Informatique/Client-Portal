/**
 * Splashtop Open API client — attended SOS / PSA support sessions.
 *
 * Docs: https://support-splashtopbusiness.splashtop.com/hc/en-us/articles/16772899906459-Splashtop-Open-APIs
 * Reference PDF: https://files.splashtop.com/doc/Splashtop_Open_API.pdf
 *
 * Env:
 *   SPLASHTOP_API_TOKEN         — Bearer token with `psa` (+ ideally `users`) scope
 *   SPLASHTOP_TEAM_ID           — optional; auto-discovered via /users/basic_info
 *   SPLASHTOP_BASE_URL          — optional; default https://webapi.splashtop.com
 *   SPLASHTOP_CHANNEL_ID        — optional; default 0 (private channel)
 *   SPLASHTOP_PORTAL_BASE_URL   — optional client-link host; default my.splashtop.com|eu
 *                                 (use if API returns stack hosts like my.aws-rd.splashtop.com)
 */

function cleanEnv(v: unknown): string {
  return String(v ?? "").trim();
}

export type SplashtopConfig = {
  token: string;
  baseUrl: string;
  teamId: string | null;
  channelId: string;
};

export function getSplashtopConfigFromEnv(): SplashtopConfig | null {
  const token = cleanEnv(process.env.SPLASHTOP_API_TOKEN);
  if (!token) return null;
  const baseRaw =
    cleanEnv(process.env.SPLASHTOP_BASE_URL) ||
    "https://webapi.splashtop.com";
  const baseUrl = baseRaw.replace(/\/+$/, "");
  const teamId = cleanEnv(process.env.SPLASHTOP_TEAM_ID) || null;
  const channelId = cleanEnv(process.env.SPLASHTOP_CHANNEL_ID) || "0";
  return { token, baseUrl, teamId, channelId };
}

export function isSplashtopConfigured(): boolean {
  return getSplashtopConfigFromEnv() != null;
}

let cachedTeamId: string | null = null;
let cachedTeamKey: string | null = null;

export function clearSplashtopCache(): void {
  cachedTeamId = null;
  cachedTeamKey = null;
}

function authHeaders(cfg: SplashtopConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function stFetch(
  cfg: SplashtopConfig,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const url = path.startsWith("http")
    ? path
    : `${cfg.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(cfg),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data, text };
}

function resultCode(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const r = (data as { result?: unknown }).result;
  return typeof r === "number" ? r : null;
}

function formatStError(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const d = data as {
    result?: unknown;
    message?: unknown;
    messages?: unknown;
    error?: unknown;
    data?: { message?: unknown };
  };
  const parts: string[] = [];
  if (d.result != null) parts.push(`result=${String(d.result)}`);
  if (typeof d.message === "string" && d.message.trim()) {
    parts.push(d.message.trim());
  }
  if (Array.isArray(d.messages)) {
    for (const m of d.messages) {
      if (typeof m === "string" && m.trim()) parts.push(m.trim());
      else if (m && typeof m === "object" && "message" in m) {
        const s = String((m as { message?: unknown }).message ?? "").trim();
        if (s) parts.push(s);
      }
    }
  }
  if (typeof d.error === "string" && d.error.trim()) parts.push(d.error.trim());
  if (typeof d.data?.message === "string" && d.data.message.trim()) {
    parts.push(d.data.message.trim());
  }
  return parts.length ? parts.join(" — ") : fallback;
}

/**
 * Resolve team id: env pin → cache → GET /api/open/v1/users/basic_info
 */
export async function resolveTeamId(cfg: SplashtopConfig): Promise<string> {
  if (cfg.teamId) return cfg.teamId;
  const key = cfg.token.slice(0, 12);
  if (cachedTeamId && cachedTeamKey === key) return cachedTeamId;

  const res = await stFetch(cfg, "/api/open/v1/users/basic_info");
  if (!res.ok) {
    throw new Error(
      `Splashtop basic_info failed (${res.status}): ${formatStError(res.data, res.text.slice(0, 200))}`,
    );
  }
  const code = resultCode(res.data);
  if (code != null && code !== 20200 && code !== 0) {
    throw new Error(
      `Splashtop basic_info error: ${formatStError(res.data, `code ${code}`)}`,
    );
  }

  const root = res.data as {
    data?: Record<string, unknown>;
    stb_team_id?: unknown;
    team_id?: unknown;
  };
  const payload =
    root.data && typeof root.data === "object" ? root.data : (root as Record<string, unknown>);
  const team =
    payload.stb_team_id ??
    payload.team_id ??
    payload.teamId ??
    (payload.team && typeof payload.team === "object"
      ? (payload.team as { id?: unknown }).id
      : null);

  const teamId = team != null ? String(team).trim() : "";
  if (!teamId) {
    throw new Error(
      "Splashtop basic_info did not return team id. Set SPLASHTOP_TEAM_ID in .env.",
    );
  }
  cachedTeamId = teamId;
  cachedTeamKey = key;
  return teamId;
}

export type SplashtopSupportSession = {
  id: string;
  code: string;
  supportPortalLink: string;
  status: string;
  channelId: string | null;
  expiresAt: string | null;
  assigneeEmail: string | null;
  customerName: string | null;
  serverName: string | null;
  serverOs: string | null;
  associatedAt: string | null;
  onlineSince: string | null;
  connectedSince: string | null;
  raw: Record<string, unknown>;
};

/**
 * Portal host for end-user SOS session links.
 * API base is webapi.splashtop.com|eu — client links live on my.splashtop.com|eu
 * (or a stack-specific host like my.aws-rd.splashtop.com when API returns one).
 */
export function getClientPortalBaseUrl(cfg?: SplashtopConfig | null): string {
  const pinned = cleanEnv(process.env.SPLASHTOP_PORTAL_BASE_URL);
  if (pinned) return pinned.replace(/\/+$/, "");

  const base = (cfg?.baseUrl || cleanEnv(process.env.SPLASHTOP_BASE_URL) || "")
    .toLowerCase()
    .replace(/\/+$/, "");
  if (base.includes("splashtop.eu") || base.includes("webapi.splashtop.eu")) {
    return "https://my.splashtop.eu";
  }
  if (base.includes("splashtop.nr")) {
    return "https://my.splashtop.nr";
  }
  return "https://my.splashtop.com";
}

/**
 * Build the end-user session link from a 9-digit SOS code.
 * Format (Open API PDF): https://my…/service_desk/psa/{code}
 */
export function buildClientPortalUrl(
  sosCode: string,
  cfg?: SplashtopConfig | null,
): string {
  const code = String(sosCode || "").trim();
  if (!code) return "";
  const host = getClientPortalBaseUrl(cfg);
  return `${host}/service_desk/psa/${encodeURIComponent(code)}`;
}

/** Prefer API-provided absolute URL; otherwise synthesize from code. */
export function resolveClientPortalLink(opts: {
  link?: string | null;
  code?: string | null;
  cfg?: SplashtopConfig | null;
}): string {
  const raw = String(opts.link ?? "").trim();
  if (raw) {
    // Absolute http(s) link from API — use as-is
    if (/^https?:\/\//i.test(raw)) return raw;
    // Protocol-relative
    if (raw.startsWith("//")) return `https:${raw}`;
    // Path-only from API — attach to portal host
    if (raw.startsWith("/")) {
      return `${getClientPortalBaseUrl(opts.cfg)}${raw}`;
    }
    // Bare host/path without scheme
    if (/^[a-z0-9.-]+\//i.test(raw) || raw.includes("splashtop.")) {
      return `https://${raw.replace(/^\/+/, "")}`;
    }
  }
  return buildClientPortalUrl(String(opts.code ?? ""), opts.cfg);
}

function pickString(
  raw: Record<string, unknown>,
  keys: string[],
): string {
  for (const k of keys) {
    const v = raw[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function mapSession(
  raw: Record<string, unknown>,
  cfg?: SplashtopConfig | null,
): SplashtopSupportSession {
  const id = pickString(raw, ["id", "session_id", "support_session_id"]);
  const code = pickString(raw, ["code", "sos_code", "session_code"]);
  const linkFromApi = pickString(raw, [
    "support_portal_link",
    "supportPortalLink",
    "portal_link",
    "portalLink",
    "session_link",
    "sessionLink",
    "client_link",
    "clientLink",
    "url",
    "link",
  ]);
  const link = resolveClientPortalLink({
    link: linkFromApi,
    code,
    cfg: cfg ?? getSplashtopConfigFromEnv(),
  });
  return {
    id,
    code,
    supportPortalLink: link,
    status: pickString(raw, ["status"]) || "open",
    channelId: (() => {
      const v = pickString(raw, ["channel_id", "channelId"]);
      return v || null;
    })(),
    expiresAt: (() => {
      const v = pickString(raw, ["expires_at", "expiresAt"]);
      return v || null;
    })(),
    assigneeEmail: (() => {
      const v = pickString(raw, ["assignee_email", "assigneeEmail"]);
      return v || null;
    })(),
    customerName: (() => {
      const v = pickString(raw, ["name", "customer_name", "customerName"]);
      return v || null;
    })(),
    serverName: (() => {
      const v = pickString(raw, ["server_name", "serverName"]);
      return v || null;
    })(),
    serverOs: (() => {
      const v = pickString(raw, ["server_os", "serverOs"]);
      return v || null;
    })(),
    associatedAt: (() => {
      const v = pickString(raw, ["associated_at", "associatedAt"]);
      return v || null;
    })(),
    onlineSince: (() => {
      const v = pickString(raw, ["online_since", "onlineSince"]);
      return v || null;
    })(),
    connectedSince: (() => {
      const v = pickString(raw, ["connected_since", "connectedSince"]);
      return v || null;
    })(),
    raw,
  };
}

function extractSession(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const dataNode =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : null;

  const candidates: unknown[] = [
    dataNode?.support_session,
    dataNode?.supportSession,
    dataNode?.session,
    root.support_session,
    root.supportSession,
    root.session,
    // list-style: data.support_sessions[0]
    Array.isArray(dataNode?.support_sessions)
      ? (dataNode!.support_sessions as unknown[])[0]
      : null,
    Array.isArray(dataNode?.supportSessions)
      ? (dataNode!.supportSessions as unknown[])[0]
      : null,
    // bare session object under data
    dataNode &&
    (dataNode.id != null || dataNode.code != null || dataNode.support_portal_link != null)
      ? dataNode
      : null,
    // top-level session fields
    root.id != null || root.code != null || root.support_portal_link != null
      ? root
      : null,
  ];

  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      return c as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Create a PSA attended support session (SOS).
 * Returns code + support_portal_link for the end user.
 */
export async function createSupportSession(opts: {
  customerName: string;
  customerIssue?: string | null;
  channelId?: string | null;
}): Promise<SplashtopSupportSession> {
  const cfg = getSplashtopConfigFromEnv();
  if (!cfg) throw new Error("Splashtop is not configured (SPLASHTOP_API_TOKEN)");

  const teamId = await resolveTeamId(cfg);
  const channelId = String(opts.channelId ?? cfg.channelId ?? "0");
  const body: Record<string, unknown> = {
    channel_id: Number.isFinite(Number(channelId))
      ? Number(channelId)
      : channelId,
    customer_name: opts.customerName.slice(0, 120),
  };
  if (opts.customerIssue?.trim()) {
    body.customer_issue = opts.customerIssue.trim().slice(0, 500);
  }
  // Identify sessions created by AKAB portal
  body.source_name = "AKAB Portal";

  const res = await stFetch(
    cfg,
    `/api/open/v1/teams/${encodeURIComponent(teamId)}/psa/support_sessions`,
    { method: "POST", body: JSON.stringify(body) },
  );

  if (!res.ok) {
    throw new Error(
      `Splashtop create session failed (${res.status}): ${formatStError(res.data, res.text.slice(0, 240))}`,
    );
  }
  const code = resultCode(res.data);
  if (code != null && code !== 20200 && code !== 0) {
    throw new Error(
      `Splashtop create session error: ${formatStError(res.data, `code ${code}`)}`,
    );
  }

  const sessionRaw = extractSession(res.data);
  if (!sessionRaw) {
    throw new Error("Splashtop create session returned no support_session payload");
  }
  const session = mapSession(sessionRaw, cfg);
  if (!session.code && !session.supportPortalLink) {
    throw new Error("Splashtop session missing code and support_portal_link");
  }
  return session;
}

export async function getSupportSession(
  sessionId: string,
): Promise<SplashtopSupportSession> {
  const cfg = getSplashtopConfigFromEnv();
  if (!cfg) throw new Error("Splashtop is not configured");
  const teamId = await resolveTeamId(cfg);
  const res = await stFetch(
    cfg,
    `/api/open/v1/teams/${encodeURIComponent(teamId)}/psa/support_sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) {
    throw new Error(
      `Splashtop get session failed (${res.status}): ${formatStError(res.data, res.text.slice(0, 200))}`,
    );
  }
  const sessionRaw = extractSession(res.data);
  if (!sessionRaw) {
    // Some responses return the session at top-level data
    const d = res.data as { data?: Record<string, unknown> };
    if (d.data && d.data.id != null) return mapSession(d.data, cfg);
    throw new Error("Splashtop get session returned empty payload");
  }
  return mapSession(sessionRaw, cfg);
}

export async function closeSupportSession(
  sessionId: string,
  kind: "close" | "delete" = "close",
): Promise<void> {
  const cfg = getSplashtopConfigFromEnv();
  if (!cfg) throw new Error("Splashtop is not configured");
  const teamId = await resolveTeamId(cfg);
  const res = await stFetch(
    cfg,
    `/api/open/v1/teams/${encodeURIComponent(teamId)}/psa/support_sessions/${encodeURIComponent(sessionId)}/action`,
    {
      method: "PUT",
      body: JSON.stringify({ kind }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Splashtop ${kind} session failed (${res.status}): ${formatStError(res.data, res.text.slice(0, 200))}`,
    );
  }
}

/**
 * Technician deep-link into Splashtop Business app.
 * - API-created sessions: category=40
 * - Classic / manual SOS codes (client typed code): omit category
 */
export function buildTechnicianConnectUrl(opts: {
  sosCode: string;
  accountEmail?: string | null;
  /** true when the session was created via Splashtop Open API */
  apiSession?: boolean;
}): string {
  const params = new URLSearchParams();
  params.set("sos", String(opts.sosCode || "").trim());
  if (opts.apiSession) {
    params.set("category", "40");
  }
  if (opts.accountEmail?.trim()) {
    params.set("account", opts.accountEmail.trim());
  }
  return `st-business://com.splashtop.business/?${params.toString()}`;
}

/** Classic Splashtop SOS download / run page (no Open API required). */
export const CLASSIC_SOS_PORTAL_URL = "https://sos.splashtop.com";

/**
 * Map Splashtop session fields → portal status.
 */
export function derivePortalStatusFromSession(
  session: SplashtopSupportSession,
  current: string,
): string {
  const st = (session.status || "").toLowerCase();
  if (st === "closed" || st === "deleted") return "closed";
  if (st === "expired") return "expired";
  if (session.connectedSince) return "connected";
  if (session.associatedAt || session.serverName || session.onlineSince) {
    return "ready";
  }
  if (current === "connected" || current === "ready") return current;
  return "waiting";
}

export async function probeSplashtopAccess(): Promise<{
  ok: boolean;
  configured: boolean;
  authOk: boolean;
  teamId: string | null;
  message: string;
  baseUrl: string | null;
}> {
  const cfg = getSplashtopConfigFromEnv();
  if (!cfg) {
    return {
      ok: false,
      configured: false,
      authOk: false,
      teamId: null,
      baseUrl: null,
      message:
        "Splashtop is not configured. Set SPLASHTOP_API_TOKEN in .env (Open API token with psa scope).",
    };
  }
  try {
    const teamId = await resolveTeamId(cfg);
    return {
      ok: true,
      configured: true,
      authOk: true,
      teamId,
      baseUrl: cfg.baseUrl,
      message: `Connected to Splashtop (team ${teamId}).`,
    };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      authOk: false,
      teamId: cfg.teamId,
      baseUrl: cfg.baseUrl,
      message: e instanceof Error ? e.message : "Splashtop probe failed",
    };
  }
}
