/**
 * Splashtop Open API client — attended SOS / PSA support sessions.
 *
 * Docs: https://support-splashtopbusiness.splashtop.com/hc/en-us/articles/16772899906459-Splashtop-Open-APIs
 * Reference PDF: https://files.splashtop.com/doc/Splashtop_Open_API.pdf
 *
 * Env:
 *   SPLASHTOP_API_TOKEN   — Bearer token with `psa` (+ ideally `users`) scope
 *   SPLASHTOP_TEAM_ID     — optional; auto-discovered via /users/basic_info
 *   SPLASHTOP_BASE_URL    — optional; default https://webapi.splashtop.com
 *   SPLASHTOP_CHANNEL_ID  — optional; default 0 (private channel)
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

function mapSession(raw: Record<string, unknown>): SplashtopSupportSession {
  const id = raw.id != null ? String(raw.id) : "";
  const code = raw.code != null ? String(raw.code) : "";
  const link =
    raw.support_portal_link != null
      ? String(raw.support_portal_link)
      : raw.supportPortalLink != null
        ? String(raw.supportPortalLink)
        : "";
  return {
    id,
    code,
    supportPortalLink: link,
    status: raw.status != null ? String(raw.status) : "open",
    channelId:
      raw.channel_id != null
        ? String(raw.channel_id)
        : raw.channelId != null
          ? String(raw.channelId)
          : null,
    expiresAt:
      raw.expires_at != null
        ? String(raw.expires_at)
        : raw.expiresAt != null
          ? String(raw.expiresAt)
          : null,
    assigneeEmail:
      raw.assignee_email != null
        ? String(raw.assignee_email)
        : raw.assigneeEmail != null
          ? String(raw.assigneeEmail)
          : null,
    customerName:
      raw.name != null
        ? String(raw.name)
        : raw.customer_name != null
          ? String(raw.customer_name)
          : null,
    serverName:
      raw.server_name != null
        ? String(raw.server_name)
        : raw.serverName != null
          ? String(raw.serverName)
          : null,
    serverOs:
      raw.server_os != null
        ? String(raw.server_os)
        : raw.serverOs != null
          ? String(raw.serverOs)
          : null,
    associatedAt:
      raw.associated_at != null
        ? String(raw.associated_at)
        : raw.associatedAt != null
          ? String(raw.associatedAt)
          : null,
    onlineSince:
      raw.online_since != null
        ? String(raw.online_since)
        : raw.onlineSince != null
          ? String(raw.onlineSince)
          : null,
    connectedSince:
      raw.connected_since != null
        ? String(raw.connected_since)
        : raw.connectedSince != null
          ? String(raw.connectedSince)
          : null,
    raw,
  };
}

function extractSession(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as {
    data?: {
      support_session?: Record<string, unknown>;
      supportSession?: Record<string, unknown>;
    };
    support_session?: Record<string, unknown>;
  };
  return (
    root.data?.support_session ||
    root.data?.supportSession ||
    root.support_session ||
    (root.data as Record<string, unknown> | undefined) ||
    null
  );
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
  const session = mapSession(sessionRaw);
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
    if (d.data && d.data.id != null) return mapSession(d.data);
    throw new Error("Splashtop get session returned empty payload");
  }
  return mapSession(sessionRaw);
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

/** Technician deep-link into Splashtop Business app. */
export function buildTechnicianConnectUrl(opts: {
  sosCode: string;
  accountEmail?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("sos", opts.sosCode);
  params.set("category", "40");
  if (opts.accountEmail?.trim()) {
    params.set("account", opts.accountEmail.trim());
  }
  return `st-business://com.splashtop.business/?${params.toString()}`;
}

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
