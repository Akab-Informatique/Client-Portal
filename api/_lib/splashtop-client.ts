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

/**
 * Strip BOM / quotes / CR that Docker Compose, dotenv, or shell can leave on
 * secret values. Matches the Autotask cleaner so tokens with edge characters
 * still authenticate (quoted tokens return Splashtop 41406).
 */
function cleanEnv(v: unknown): string {
  if (v == null) return "";
  let s = String(v).trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1).trim();
  // Peel up to two layers of matching quotes
  for (let i = 0; i < 2; i++) {
    if (
      (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    ) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.replace(/\r/g, "").trim();
}

/** Splashtop rejects customer_name longer than 64 chars (result 40422). */
const CUSTOMER_NAME_MAX = 64;
const CUSTOMER_ISSUE_MAX = 500;

export type SplashtopConfig = {
  token: string;
  baseUrl: string;
  teamId: string | null;
  /**
   * Explicit channel id from env, or null = auto-pick the team Default
   * channel (isDefault / name "Default"), then fall back to private 0.
   */
  channelId: string | null;
};

export function getSplashtopConfigFromEnv(): SplashtopConfig | null {
  const token = cleanEnv(process.env.SPLASHTOP_API_TOKEN);
  if (!token) return null;
  const baseRaw =
    cleanEnv(process.env.SPLASHTOP_BASE_URL) ||
    "https://webapi.splashtop.com";
  const baseUrl = baseRaw.replace(/\/+$/, "");
  const teamId = cleanEnv(process.env.SPLASHTOP_TEAM_ID) || null;
  // Empty / "auto" / "default" → resolve live Default channel at create time
  const rawCh = cleanEnv(process.env.SPLASHTOP_CHANNEL_ID).toLowerCase();
  const channelId =
    !rawCh || rawCh === "auto" || rawCh === "default" ? null : cleanEnv(process.env.SPLASHTOP_CHANNEL_ID);
  return { token, baseUrl, teamId, channelId };
}

/** Safe for logs — never the full token. */
export function describeSplashtopToken(token: string | null | undefined): string {
  const t = cleanEnv(token);
  if (!t) return "missing";
  return `len=${t.length} head=${t.slice(0, 4)}…`;
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

export type SplashtopBasicInfo = {
  teamId: string;
  email: string | null;
  name: string | null;
  /** Scope names present on the token (e.g. psa, users, service_desk). */
  scopes: string[];
  /** Prefer team id nested under scopes.psa when present. */
  psaTeamId: string | null;
  raw: Record<string, unknown>;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Parse /users/basic_info — team id for PSA lives under data.scopes.psa.team_id
 * in current Splashtop docs (not always top-level team_id).
 */
export function parseBasicInfo(data: unknown): SplashtopBasicInfo {
  const root = asRecord(data) ?? {};
  const payload = asRecord(root.data) ?? root;
  const scopesObj = asRecord(payload.scopes) ?? {};
  const scopeNames = Object.keys(scopesObj);
  const psa = asRecord(scopesObj.psa);
  const serviceDesk = asRecord(scopesObj.service_desk);
  const psaTeam =
    psa?.team_id != null
      ? String(psa.team_id).trim()
      : psa?.stb_team_id != null
        ? String(psa.stb_team_id).trim()
        : serviceDesk?.team_id != null
          ? String(serviceDesk.team_id).trim()
          : null;

  const topTeam =
    payload.team_id != null
      ? String(payload.team_id).trim()
      : payload.stb_team_id != null
        ? String(payload.stb_team_id).trim()
        : payload.teamId != null
          ? String(payload.teamId).trim()
          : null;

  const teamId = (psaTeam || topTeam || "").trim();
  return {
    teamId,
    email:
      payload.email != null
        ? String(payload.email)
        : payload.user_email != null
          ? String(payload.user_email)
          : null,
    name: payload.name != null ? String(payload.name) : null,
    scopes: scopeNames,
    psaTeamId: psaTeam,
    raw: payload,
  };
}

export async function fetchBasicInfo(
  cfg: SplashtopConfig,
): Promise<SplashtopBasicInfo> {
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
  const info = parseBasicInfo(res.data);
  if (!info.teamId) {
    throw new Error(
      "Splashtop basic_info did not return team id. Set SPLASHTOP_TEAM_ID in .env.",
    );
  }
  if (info.scopes.length > 0 && !info.scopes.includes("psa")) {
    throw new Error(
      `Splashtop token is missing the "psa" scope (has: ${info.scopes.join(", ") || "none"}). ` +
        `Recreate the Web API token at my.splashtop.com → Account → Web API Tokens with scopes: psa, users.`,
    );
  }
  return info;
}

/**
 * Resolve team id: env pin → cache → GET /api/open/v1/users/basic_info
 * Prefer scopes.psa.team_id from basic_info (Open API PDF §5.1).
 */
export async function resolveTeamId(cfg: SplashtopConfig): Promise<string> {
  if (cfg.teamId) return cfg.teamId;
  const key = cfg.token.slice(0, 12);
  if (cachedTeamId && cachedTeamKey === key) return cachedTeamId;

  const info = await fetchBasicInfo(cfg);
  cachedTeamId = info.teamId;
  cachedTeamKey = key;
  return info.teamId;
}

export type SplashtopChannel = {
  id: string;
  name: string;
  isDefault: boolean;
  isPrivate: boolean;
};

/**
 * List Service Desk / PSA channels (private id is always 0).
 * GET /api/open/v1/teams/{team_id}/psa/channel_list?mode=psa
 */
export async function listPsaChannels(
  cfg?: SplashtopConfig | null,
): Promise<SplashtopChannel[]> {
  const c = cfg ?? getSplashtopConfigFromEnv();
  if (!c) throw new Error("Splashtop is not configured");
  const teamId = await resolveTeamId(c);
  const path =
    `/api/open/v1/teams/${encodeURIComponent(teamId)}/psa/channel_list?mode=psa`;
  const res = await stFetch(c, path);
  if (!res.ok) {
    throw new Error(
      `Splashtop channel_list failed (${res.status}): ${formatStError(res.data, res.text.slice(0, 200))}`,
    );
  }
  const code = resultCode(res.data);
  if (code != null && code !== 20200 && code !== 0) {
    throw new Error(
      `Splashtop channel_list error: ${formatStError(res.data, `code ${code}`)}`,
    );
  }
  const root = asRecord(res.data) ?? {};
  const data = asRecord(root.data) ?? root;
  const out: SplashtopChannel[] = [];
  const priv = asRecord(data.private);
  if (priv) {
    out.push({
      id: priv.id != null ? String(priv.id) : "0",
      name: priv.name != null ? String(priv.name) : "Private",
      isDefault: Boolean(priv.default),
      isPrivate: true,
    });
  } else {
    out.push({ id: "0", name: "Private", isDefault: false, isPrivate: true });
  }
  const channels = Array.isArray(data.channels) ? data.channels : [];
  for (const ch of channels) {
    const row = asRecord(ch);
    if (!row || row.id == null) continue;
    out.push({
      id: String(row.id),
      name: String(row.name ?? row.Name ?? `Channel ${row.id}`),
      isDefault: Boolean(row.default ?? row.Default),
      isPrivate: false,
    });
  }
  return out;
}

function explainCreateError(data: unknown, fallback: string): string {
  const base = formatStError(data, fallback);
  const code = resultCode(data);
  if (code === 40403) {
    return (
      `${base}. Splashtop 40403 = not allowed (value/action/target). Common fixes: ` +
      `(1) API token must include scope "psa" (and ideally "users") — recreate at my.splashtop.com → Web API Tokens; ` +
      `(2) Enterprise plan with Attended Support / Service Desk enabled; ` +
      `(3) Use a valid channel_id (0 = private) via SPLASHTOP_CHANNEL_ID; ` +
      `(4) Confirm SPLASHTOP_BASE_URL region (US webapi.splashtop.com vs EU webapi.splashtop.eu); ` +
      `(5) Token owner must be Team Owner or Super Admin.`
    );
  }
  if (code === 40100 || code === 40101 || code === 40300) {
    return `${base}. Check SPLASHTOP_API_TOKEN is valid and not expired.`;
  }
  return base;
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

export type SosCloudBuildPlatform = "win" | "mac";

export type SosCloudBuildResult = {
  ok: boolean;
  platform: SosCloudBuildPlatform;
  canBuild: boolean;
  /** Preferred direct file URL (.exe / .dmg) for this session code */
  downloadUrl: string | null;
  fileName: string | null;
  cacheUrl: string | null;
  backupUrl: string | null;
  category: number | null;
  error?: string;
};

/**
 * Resolve the real session-bound SOS installer URL.
 *
 * Splashtop's HTML page (service_desk/psa/{code}) calls this same endpoint
 * and shows "App not available" when the session is closed/expired OR when
 * the SPA fails. We call it server-side and hand the client the .exe/.dmg
 * so download never depends on that HTML page.
 *
 * POST https://my.splashtop.com/api/web/v1/teams/service_desk/{code}/cloud_build_file
 * body: { category: "win" | "mac" }
 */
export async function fetchServiceDeskCloudBuild(
  sosCode: string,
  platform: SosCloudBuildPlatform,
  cfg?: SplashtopConfig | null,
): Promise<SosCloudBuildResult> {
  const code = String(sosCode || "").trim();
  const cat: SosCloudBuildPlatform = platform === "mac" ? "mac" : "win";
  if (!/^\d{6,12}$/.test(code)) {
    return {
      ok: false,
      platform: cat,
      canBuild: false,
      downloadUrl: null,
      fileName: null,
      cacheUrl: null,
      backupUrl: null,
      category: null,
      error: "Invalid SOS session code",
    };
  }
  const host = getClientPortalBaseUrl(cfg);
  const url = `${host}/api/web/v1/teams/service_desk/${encodeURIComponent(code)}/cloud_build_file`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ category: cat }),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const root = asRecord(data) ?? {};
    const result = Number(root.result ?? res.status);
    const payload = asRecord(root.data) ?? {};
    const canBuild = Boolean(payload.can_build);
    const cacheUrl = pickString(payload, ["cache_url", "cacheUrl"]) || null;
    const cacheOkUrl =
      pickString(payload, ["cache_ok_url", "cacheOkUrl"]) || null;
    const backupUrl =
      pickString(payload, ["backup_url", "backupUrl"]) || null;
    const categoryRaw = payload.category;
    const category =
      categoryRaw != null && Number.isFinite(Number(categoryRaw))
        ? Number(categoryRaw)
        : null;

    // Prefer cache_url once ready; fall back to signed backup_url.
    // Splashtop's SPA polls cache_ok_url — we do a quick HEAD first.
    let downloadUrl: string | null = null;
    if (canBuild && cacheUrl && cacheOkUrl) {
      try {
        const head = await fetch(cacheOkUrl, { method: "HEAD" });
        if (head.ok) downloadUrl = cacheUrl;
      } catch {
        /* use backup */
      }
    }
    if (!downloadUrl && backupUrl) downloadUrl = backupUrl;
    if (!downloadUrl && cacheUrl) downloadUrl = cacheUrl;

    // Result codes 40403 / 40404 = session blocked / not available
    if (result === 40403 || result === 40404) {
      return {
        ok: false,
        platform: cat,
        canBuild: false,
        downloadUrl: null,
        fileName: null,
        cacheUrl,
        backupUrl,
        category,
        error:
          "App not available — this support session was closed or expired. Start SOS again.",
      };
    }

    if (!downloadUrl) {
      return {
        ok: false,
        platform: cat,
        canBuild,
        downloadUrl: null,
        fileName: null,
        cacheUrl,
        backupUrl,
        category,
        error: canBuild
          ? "Installer is still building — try Download again in a few seconds."
          : "App not available for this session. Start SOS again from the portal.",
      };
    }

    let fileName: string | null = null;
    try {
      const u = new URL(downloadUrl);
      const last = u.pathname.split("/").filter(Boolean).pop() || "";
      fileName = decodeURIComponent(last) || null;
      // backup_url often has filename in content-disposition query
      const disp = u.searchParams.get("response-content-disposition") || "";
      const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(disp); // Content-Disposition header parse (not shell)
      if (m?.[1]) fileName = decodeURIComponent(m[1].replace(/"/g, ""));
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      platform: cat,
      canBuild,
      downloadUrl,
      fileName,
      cacheUrl,
      backupUrl,
      category,
    };
  } catch (e) {
    return {
      ok: false,
      platform: cat,
      canBuild: false,
      downloadUrl: null,
      fileName: null,
      cacheUrl: null,
      backupUrl: null,
      category: null,
      error: e instanceof Error ? e.message : "Cloud build request failed",
    };
  }
}

/** Guess win/mac from a User-Agent string. */
export function platformFromUserAgent(
  ua: string | null | undefined,
): SosCloudBuildPlatform {
  const s = String(ua || "");
  if (/Mac OS X|Macintosh|Mac OS/i.test(s) && !/iPhone|iPad|iPod/i.test(s)) {
    return "mac";
  }
  return "win";
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

/** Clamp + sanitize the end-user display name (max 64 on Splashtop). */
export function sanitizeCustomerName(raw: string | null | undefined): string {
  let s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "Client";
  if (s.length > CUSTOMER_NAME_MAX) s = s.slice(0, CUSTOMER_NAME_MAX).trim();
  return s || "Client";
}

/**
 * Pick channel order for create:
 * 1. Explicit opts / SPLASHTOP_CHANNEL_ID pin
 * 2. Team Default channel (isDefault=true, or name "Default")
 * 3. Private 0
 * 4. Any other listed channels
 */
export async function resolveChannelPreference(
  cfg: SplashtopConfig,
  teamId: string,
  explicit?: string | null,
): Promise<{ preferred: string; ordered: string[]; channels: SplashtopChannel[] }> {
  let channels: SplashtopChannel[] = [];
  try {
    channels = await listPsaChannels({ ...cfg, teamId });
  } catch {
    channels = [{ id: "0", name: "Private", isDefault: false, isPrivate: true }];
  }

  const defaultCh =
    channels.find((c) => c.isDefault && !c.isPrivate) ||
    channels.find((c) => c.isDefault) ||
    channels.find((c) => /^default$/i.test(c.name) && !c.isPrivate) ||
    channels.find((c) => /^default$/i.test(c.name)) ||
    null;

  const pin = String(explicit ?? cfg.channelId ?? "").trim();
  // Empty pin → auto Default. Explicit "0" keeps private.
  const preferred =
    pin && pin !== "auto" && pin.toLowerCase() !== "default"
      ? pin
      : defaultCh?.id || "0";

  const ordered: string[] = [];
  const push = (id: string | null | undefined) => {
    const s = String(id ?? "").trim();
    if (s && !ordered.includes(s)) ordered.push(s);
  };
  push(preferred);
  if (defaultCh) push(defaultCh.id);
  push("0");
  for (const c of channels) push(c.id);

  return { preferred, ordered, channels };
}

/**
 * Create a PSA attended support session (SOS).
 * Returns code + support_portal_link for the end user.
 *
 * Proven working request (Open API PDF §5.8.1.2 + live verify):
 *   POST /api/open/v1/teams/{team_id}/psa/support_sessions
 *   JSON { "channel_id": <Default|0>, "customer_name": "…", "customer_issue": "…" }
 *
 * Notes from live testing against this tenant:
 * - customer_name max length is 64 (longer → result 40422 wrong_params)
 * - Prefer team Default channel (e.g. 4673) over private 0 when present
 * - form/query encodings are unnecessary — JSON is the supported path
 */
export async function createSupportSession(opts: {
  customerName: string;
  customerIssue?: string | null;
  channelId?: string | null;
}): Promise<SplashtopSupportSession> {
  const cfg = getSplashtopConfigFromEnv();
  if (!cfg) throw new Error("Splashtop is not configured (SPLASHTOP_API_TOKEN)");

  // Validate token + resolve team (throws if psa missing when scopes are listed)
  const info = await fetchBasicInfo(cfg);
  // Prefer live psa.team_id over a possibly-stale SPLASHTOP_TEAM_ID pin
  const teamId = info.psaTeamId || info.teamId || cfg.teamId;
  if (!teamId) {
    throw new Error(
      "Splashtop team id missing. Set SPLASHTOP_TEAM_ID or use a token with psa scope.",
    );
  }
  if (cfg.teamId && info.psaTeamId && cfg.teamId !== info.psaTeamId) {
    // Env pin disagrees with token — trust the token (wrong pin → 40404/40403)
    console.warn(
      `[splashtop] SPLASHTOP_TEAM_ID=${cfg.teamId} differs from token psa.team_id=${info.psaTeamId}; using token team id`,
    );
  }
  cachedTeamId = teamId;
  cachedTeamKey = cfg.token.slice(0, 12);

  const { preferred, ordered: channelIds, channels } =
    await resolveChannelPreference(cfg, teamId, opts.channelId);
  const prefName =
    channels.find((c) => c.id === preferred)?.name || preferred;
  console.info(
    `[splashtop] create session → channel ${preferred} (${prefName}); order=[${channelIds.join(",")}]`,
  );

  const customerName = sanitizeCustomerName(opts.customerName);
  const customerIssue = opts.customerIssue?.trim()
    ? opts.customerIssue.trim().slice(0, CUSTOMER_ISSUE_MAX)
    : null;

  const path = `/api/open/v1/teams/${encodeURIComponent(teamId)}/psa/support_sessions`;
  const errors: string[] = [];

  for (const ch of channelIds) {
    const chNum = Number(ch);
    const channelValue = Number.isFinite(chNum) ? chNum : ch;

    const bodies: Record<string, unknown>[] = [
      // Primary — documented JSON (verified live)
      {
        channel_id: channelValue,
        customer_name: customerName,
        ...(customerIssue ? { customer_issue: customerIssue } : {}),
      },
    ];
    // Fallback without issue text
    if (customerIssue) {
      bodies.push({ channel_id: channelValue, customer_name: customerName });
    }
    // Fallback: short generic name if tenant rejects special characters
    if (customerName !== "Client") {
      bodies.push({
        channel_id: channelValue,
        customer_name: "Client",
        ...(customerIssue ? { customer_issue: customerIssue.slice(0, 80) } : {}),
      });
    }

    for (const body of bodies) {
      const res = await stFetch(cfg, path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const code = resultCode(res.data);
      if (!res.ok || (code != null && code !== 20200 && code !== 0)) {
        errors.push(
          `ch=${ch} ${JSON.stringify(body)} → ${explainCreateError(
            res.data,
            res.ok ? `code ${code}` : `HTTP ${res.status} ${res.text.slice(0, 120)}`,
          )}`,
        );
        continue;
      }
      const sessionRaw = extractSession(res.data);
      if (!sessionRaw) {
        errors.push(
          `ch=${ch} empty session raw=${JSON.stringify(res.data).slice(0, 200)}`,
        );
        continue;
      }
      const session = mapSession(sessionRaw, cfg);
      if (!session.code && !session.supportPortalLink) {
        errors.push(`ch=${ch} session missing code/link`);
        continue;
      }
      return session;
    }
  }

  const scopeHint =
    info.scopes.length > 0
      ? ` Token scopes: [${info.scopes.join(", ")}].`
      : " Token scopes unknown — ensure the Web API token includes psa.";
  const teamHint = ` team_id=${teamId} (${describeSplashtopToken(cfg.token)} base=${cfg.baseUrl}).`;
  throw new Error(
    `Splashtop create session failed after trying channel(s) ${channelIds.join(", ")}.` +
      teamHint +
      ` Last errors: ${errors.slice(-3).join(" | ")}.` +
      scopeHint,
  );
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
  scopes?: string[];
  hasPsaScope?: boolean;
  channels?: Array<{ id: string; name: string; isDefault?: boolean }>;
  channelId?: string | null;
  defaultChannelId?: string | null;
  defaultChannelName?: string | null;
  channelMode?: string;
  email?: string | null;
  /** Redacted token fingerprint for support (never the secret). */
  token?: string;
  psaTeamId?: string | null;
  envTeamId?: string | null;
  envTeamMismatch?: boolean;
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
    const info = await fetchBasicInfo(cfg);
    const teamId = cfg.teamId || info.psaTeamId || info.teamId;
    cachedTeamId = teamId;
    cachedTeamKey = cfg.token.slice(0, 12);

    let channels: SplashtopChannel[] = [];
    let channelErr: string | null = null;
    let preferredChannel: string | null = cfg.channelId;
    let defaultChannel: SplashtopChannel | null = null;
    try {
      if (teamId) {
        const resolved = await resolveChannelPreference(cfg, teamId);
        channels = resolved.channels;
        preferredChannel = resolved.preferred;
        defaultChannel =
          channels.find((c) => c.isDefault && !c.isPrivate) ||
          channels.find((c) => c.isDefault) ||
          channels.find((c) => /^default$/i.test(c.name)) ||
          null;
      }
    } catch (e) {
      channelErr = e instanceof Error ? e.message : String(e);
    }

    const hasPsa =
      info.scopes.length === 0 || info.scopes.includes("psa");
    const ok = Boolean(teamId) && hasPsa;
    const chSummary =
      channels.length > 0
        ? channels
            .slice(0, 8)
            .map(
              (c) =>
                `${c.id}:${c.name}${c.isDefault ? "*" : ""}${c.isPrivate ? " (private)" : ""}`,
            )
            .join(", ")
        : channelErr
          ? `channel_list failed (${channelErr})`
          : "none";

    const envTeamMismatch =
      Boolean(cfg.teamId) &&
      Boolean(info.psaTeamId) &&
      cfg.teamId !== info.psaTeamId;

    const channelMode = cfg.channelId ? "pinned" : "auto-default";
    const channelLabel = cfg.channelId
      ? `pinned channel ${cfg.channelId}`
      : defaultChannel
        ? `Default channel ${defaultChannel.id} (${defaultChannel.name})`
        : `channel ${preferredChannel || "0"}`;

    return {
      ok,
      configured: true,
      authOk: true,
      teamId,
      psaTeamId: info.psaTeamId,
      envTeamId: cfg.teamId,
      envTeamMismatch,
      baseUrl: cfg.baseUrl,
      scopes: info.scopes,
      hasPsaScope: hasPsa,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
      })),
      channelId: preferredChannel,
      defaultChannelId: defaultChannel?.id ?? null,
      defaultChannelName: defaultChannel?.name ?? null,
      channelMode,
      email: info.email,
      token: describeSplashtopToken(cfg.token),
      message: ok
        ? `Connected to Splashtop (team ${teamId}` +
          `${info.email ? `, ${info.email}` : ""}). ` +
          `Scopes: [${info.scopes.join(", ") || "unknown"}]. ` +
          `Channels: ${chSummary}. ` +
          `Create uses ${channelLabel}.` +
          (envTeamMismatch
            ? ` WARNING: SPLASHTOP_TEAM_ID=${cfg.teamId} ≠ token psa.team_id=${info.psaTeamId} (token id is used).`
            : "")
        : `Token authenticated but PSA may be unavailable. Scopes: [${info.scopes.join(", ") || "none"}]. ` +
          `Recreate Web API token with scope "psa" (Owner/Super Admin).`,
    };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      authOk: false,
      teamId: cfg.teamId,
      baseUrl: cfg.baseUrl,
      channelId: cfg.channelId,
      token: describeSplashtopToken(cfg.token),
      message: e instanceof Error ? e.message : "Splashtop probe failed",
    };
  }
}
