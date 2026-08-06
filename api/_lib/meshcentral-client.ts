/**
 * MeshCentral control API client (WebSocket JSON).
 *
 * Used for SOS: create interactive-only (temporary) agent invite links so
 * clients can download/run the agent without a permanent install when possible.
 *
 * Protocol reference: MeshCentral meshctrl.js / docs.meshcentral.com
 *
 * Env:
 *   MESHCENTRAL_URL              — https://mesh.example.com  (required)
 *   MESHCENTRAL_USERNAME         — login user (required for API invites)
 *   MESHCENTRAL_PASSWORD         — login password (required for API invites)
 *   MESHCENTRAL_MESH_ID          — device group id (mesh//… or 64-char)
 *   MESHCENTRAL_MESH_NAME        — device group name (if id not set)
 *   MESHCENTRAL_INVITE_HOURS     — link lifetime hours (default 8)
 *   MESHCENTRAL_INVITE_FLAGS     — 0 both, 1 interactive-only (default), 2 background-only
 *   MESHCENTRAL_STATIC_INVITE_URL— optional fixed invite page if API login unavailable
 *   MESHCENTRAL_REJECT_UNAUTHORIZED — TLS verify (default false for self-hosted)
 *   MESHCENTRAL_WS_URL           — optional full wss://…/control.ashx override
 *   MESHCENTRAL_CONNECT_PATH     — path/hash for tech UI (default empty → base URL)
 */

import WebSocket from "ws";

function cleanEnv(v: unknown): string {
  return String(v ?? "").trim();
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = cleanEnv(process.env[name]).toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
}

export type MeshCentralConfig = {
  baseUrl: string;
  username: string;
  password: string;
  meshId: string | null;
  meshName: string | null;
  inviteHours: number;
  inviteFlags: number;
  staticInviteUrl: string | null;
  /** When false, Node accepts self-signed / incomplete MeshCentral certs. */
  rejectUnauthorized: boolean;
  /** Optional full WebSocket URL override (wss://host/control.ashx). */
  wsUrlOverride: string | null;
  connectPath: string;
};

/**
 * Normalize MESHCENTRAL_URL to origin (+ optional site prefix).
 * Strips login/UI junk that would produce bad /control.ashx paths.
 */
export function normalizeMeshBaseUrl(raw: string): string {
  let s = cleanEnv(raw);
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  // Drop fragment / query
  try {
    const u = new URL(s);
    u.hash = "";
    u.search = "";
    // Common mistakes: paste of UI routes
    const stripSuffixes = [
      "/control.ashx",
      "/agent.ashx",
      "/meshrelay.ashx",
      "/login",
      "/logout",
      "/default.htm",
      "/index.html",
      "/index.htm",
    ];
    let path = u.pathname || "/";
    for (const suf of stripSuffixes) {
      if (path.toLowerCase().endsWith(suf)) {
        path = path.slice(0, -suf.length) || "/";
      }
    }
    // Collapse trailing slash for storage; empty path → root
    path = path.replace(/\/+$/, "") || "";
    u.pathname = path || "/";
    // Prefer no trailing slash except root
    let out = u.toString().replace(/\/+$/, "");
    if (out.endsWith(":/")) out = out; // safety
    // URL with only origin: https://host
    if (u.pathname === "/" || u.pathname === "") {
      out = `${u.protocol}//${u.host}`;
    }
    return out;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

export function getMeshCentralConfigFromEnv(): MeshCentralConfig | null {
  const baseRaw = cleanEnv(process.env.MESHCENTRAL_URL);
  if (!baseRaw) return null;
  const baseUrl = normalizeMeshBaseUrl(baseRaw);

  const username = cleanEnv(process.env.MESHCENTRAL_USERNAME);
  const password = cleanEnv(process.env.MESHCENTRAL_PASSWORD);
  const meshId = cleanEnv(process.env.MESHCENTRAL_MESH_ID) || null;
  const meshName = cleanEnv(process.env.MESHCENTRAL_MESH_NAME) || null;
  const staticInviteUrl =
    cleanEnv(process.env.MESHCENTRAL_STATIC_INVITE_URL) || null;

  const hoursRaw = cleanEnv(process.env.MESHCENTRAL_INVITE_HOURS) || "8";
  const hours = Math.max(0, Number(hoursRaw) || 8);
  const flagsRaw = cleanEnv(process.env.MESHCENTRAL_INVITE_FLAGS) || "1";
  const inviteFlags = Number(flagsRaw);
  const flags = Number.isFinite(inviteFlags) ? inviteFlags : 1;

  // Self-hosted MeshCentral almost always uses a private/self-signed cert.
  const rejectUnauthorized = envFlag(
    "MESHCENTRAL_REJECT_UNAUTHORIZED",
    false,
  );

  let wsUrlOverride = cleanEnv(process.env.MESHCENTRAL_WS_URL) || null;
  if (wsUrlOverride && !/^wss?:\/\//i.test(wsUrlOverride)) {
    // Allow https://host/control.ashx form
    try {
      const u = new URL(
        /^https?:\/\//i.test(wsUrlOverride)
          ? wsUrlOverride
          : `https://${wsUrlOverride}`,
      );
      u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
      wsUrlOverride = u.toString();
    } catch {
      /* keep as-is */
    }
  }

  const connectPath = cleanEnv(process.env.MESHCENTRAL_CONNECT_PATH);

  return {
    baseUrl,
    username,
    password,
    meshId,
    meshName,
    inviteHours: hours,
    inviteFlags: flags,
    staticInviteUrl,
    rejectUnauthorized,
    wsUrlOverride,
    connectPath,
  };
}

/** True when we can at least hand clients an invite URL (API or static). */
export function isMeshCentralConfigured(): boolean {
  const cfg = getMeshCentralConfigFromEnv();
  if (!cfg) return false;
  if (cfg.staticInviteUrl) return true;
  return Boolean(cfg.username && cfg.password && (cfg.meshId || cfg.meshName));
}

export function isMeshCentralApiConfigured(): boolean {
  const cfg = getMeshCentralConfigFromEnv();
  return Boolean(
    cfg?.username && cfg.password && (cfg.meshId || cfg.meshName),
  );
}

/**
 * Candidate WebSocket control URLs.
 * Mesh is normally at /control.ashx on the site root (or under a reverse-proxy prefix).
 */
export function listControlWsUrls(cfg: MeshCentralConfig): string[] {
  if (cfg.wsUrlOverride) return [cfg.wsUrlOverride];

  const urls: string[] = [];
  try {
    const u = new URL(cfg.baseUrl);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    const origin = `${proto}//${u.host}`;
    let prefix = (u.pathname || "/").replace(/\/+$/, "");
    if (prefix === "/") prefix = "";

    // Most common: root install
    urls.push(`${origin}/control.ashx`);
    // Subpath install: https://host/mesh → wss://host/mesh/control.ashx
    if (prefix) {
      urls.push(`${origin}${prefix}/control.ashx`);
    }
  } catch {
    /* fall through */
  }

  // De-dupe
  return [...new Set(urls.filter(Boolean))];
}

function meshAuthHeader(username: string, password: string): string {
  return (
    Buffer.from(username, "utf8").toString("base64") +
    "," +
    Buffer.from(password, "utf8").toString("base64")
  );
}

function formatWsConnectError(err: unknown, triedUrls: string[]): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";

  const isTls =
    /unable to verify the first certificate/i.test(msg) ||
    /self[- ]signed certificate/i.test(msg) ||
    /certificate has expired/i.test(msg) ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID";

  if (isTls) {
    return new Error(
      `MeshCentral TLS certificate error: ${msg}. ` +
        `Set MESHCENTRAL_REJECT_UNAUTHORIZED=false in .env then recreate the app container.`,
    );
  }

  const is404 =
    /unexpected server response:\s*404/i.test(msg) ||
    /\b404\b/.test(msg);

  if (is404) {
    return new Error(
      `MeshCentral WebSocket 404 (control channel not found). ` +
        `Tried: ${triedUrls.join(" | ") || "(none)"}. ` +
        `Fix: (1) Set MESHCENTRAL_URL to the Mesh site root only, e.g. https://mesh.yourdomain.com ` +
        `(not a /login page). (2) If Mesh is under a subpath, include it: https://host/mesh. ` +
        `(3) Or set MESHCENTRAL_WS_URL=wss://mesh.yourdomain.com/control.ashx explicitly. ` +
        `(4) If Mesh is behind Nginx/Caddy/Cloudflare, enable WebSocket upgrade for /control.ashx ` +
        `(proxy_set_header Upgrade / Connection). ` +
        `(5) Temporary workaround: create an invite in Mesh UI and set MESHCENTRAL_STATIC_INVITE_URL.`,
    );
  }

  if (/unexpected server response:\s*401/i.test(msg) || /\b401\b/.test(msg)) {
    return new Error(
      `MeshCentral authentication failed (401). Check MESHCENTRAL_USERNAME / MESHCENTRAL_PASSWORD.`,
    );
  }

  if (/unexpected server response:\s*403/i.test(msg) || /\b403\b/.test(msg)) {
    return new Error(
      `MeshCentral forbidden (403). User may lack rights to create invites, or reverse proxy blocked the request.`,
    );
  }

  return new Error(
    `MeshCentral connection failed: ${msg}` +
      (triedUrls.length ? ` (tried ${triedUrls.join(", ")})` : ""),
  );
}

type WsJson = Record<string, unknown>;

/**
 * One-shot authenticated WebSocket RPC against MeshCentral control.ashx.
 * Tries each candidate URL until one accepts the upgrade.
 */
function meshRpc(
  cfg: MeshCentralConfig,
  request: WsJson,
  opts?: { timeoutMs?: number; matchAction?: string },
): Promise<WsJson> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const matchAction = opts?.matchAction ?? String(request.action ?? "");
  const responseid =
    typeof request.responseid === "string"
      ? request.responseid
      : `akab-${Date.now()}`;
  const payload = { ...request, responseid };
  const candidates = listControlWsUrls(cfg);

  if (candidates.length === 0) {
    return Promise.reject(
      new Error("No MeshCentral WebSocket URL could be built from MESHCENTRAL_URL"),
    );
  }

  const tryOne = (wsUrl: string): Promise<WsJson> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      const finish = (err: Error | null, data?: WsJson) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(data ?? {});
      };

      const timer = setTimeout(() => {
        finish(new Error(`MeshCentral RPC timed out after ${timeoutMs}ms at ${wsUrl}`));
      }, timeoutMs);

      try {
        ws = new WebSocket(wsUrl, {
          rejectUnauthorized: cfg.rejectUnauthorized,
          headers: {
            "x-meshauth": meshAuthHeader(cfg.username, cfg.password),
          },
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      ws.on("open", () => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      });

      ws.on("message", (raw) => {
        let data: WsJson;
        try {
          data = JSON.parse(String(raw)) as WsJson;
        } catch {
          return;
        }
        const action = String(data.action ?? "");
        const rid = data.responseid != null ? String(data.responseid) : "";
        if (action === matchAction && (rid === responseid || !rid)) {
          if (data.result != null && data.url == null && data.urls == null) {
            const m = String(data.result);
            if (!/^ok$/i.test(m)) {
              finish(new Error(`MeshCentral: ${m}`));
              return;
            }
          }
          finish(null, data);
        }
      });

      ws.on("error", (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("close", () => {
        if (!settled) {
          finish(new Error(`MeshCentral WebSocket closed before response (${wsUrl})`));
        }
      });
    });

  return (async () => {
    const errors: string[] = [];
    for (const url of candidates) {
      try {
        return await tryOne(url);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        errors.push(`${url} → ${m}`);
        // Try next candidate on 404 / connect failures
        const retryable =
          /unexpected server response:\s*404/i.test(m) ||
          /404/.test(m) ||
          /ECONNREFUSED/i.test(m) ||
          /ENOTFOUND/i.test(m) ||
          /closed before response/i.test(m);
        if (!retryable && candidates.length === 1) {
          throw formatWsConnectError(e, candidates);
        }
        if (!retryable && !/404/.test(m)) {
          // Auth / TLS etc. — don't keep probing forever on same host with same creds
          // but still try other paths for pure 404
          if (!/unexpected server response:\s*40[13]/i.test(m) && !/TLS/i.test(m)) {
            continue;
          }
          throw formatWsConnectError(e, [url]);
        }
      }
    }
    throw formatWsConnectError(
      new Error(errors[errors.length - 1] || "Unexpected server response: 404"),
      candidates,
    );
  })();
}

function pickInviteUrl(data: WsJson, baseUrl: string): string | null {
  const direct = data.url ?? data.inviteurl ?? data.inviteUrl;
  if (typeof direct === "string" && direct.trim()) {
    const u = direct.trim();
    if (/^https?:\/\//i.test(u)) return u;
    return `${baseUrl.replace(/\/+$/, "")}/${u.replace(/^\/+/, "")}`;
  }
  if (Array.isArray(data.urls) && data.urls[0]) {
    const u = String(data.urls[0]).trim();
    if (u) {
      if (/^https?:\/\//i.test(u)) return u;
      return `${baseUrl.replace(/\/+$/, "")}/${u.replace(/^\/+/, "")}`;
    }
  }
  const code = data.code ?? data.invitecode ?? data.inviteCode;
  if (typeof code === "string" && code.trim()) {
    return `${baseUrl.replace(/\/+$/, "")}/invite?c=${encodeURIComponent(code.trim())}`;
  }
  return null;
}

export type MeshInviteResult = {
  inviteUrl: string;
  expiresAt: string | null;
  meshId: string | null;
  meshName: string | null;
  flags: number;
  source: "api" | "static";
};

/**
 * Create an interactive-only (temporary) agent invite link for SOS.
 * Falls back to MESHCENTRAL_STATIC_INVITE_URL when API is not configured.
 */
export async function createTemporaryAgentInvite(opts?: {
  hours?: number;
  flags?: number;
  note?: string | null;
}): Promise<MeshInviteResult> {
  const cfg = getMeshCentralConfigFromEnv();
  if (!cfg) throw new Error("MeshCentral is not configured (MESHCENTRAL_URL)");

  const hours = opts?.hours ?? cfg.inviteHours;
  const flags = opts?.flags ?? cfg.inviteFlags;

  if (isMeshCentralApiConfigured()) {
    const op: WsJson = {
      action: "createInviteLink",
      expire: hours,
      flags,
      responseid: `akab-invite-${Date.now()}`,
    };
    if (cfg.meshId) op.meshid = cfg.meshId;
    else if (cfg.meshName) op.meshname = cfg.meshName;

    try {
      const data = await meshRpc(cfg, op, {
        matchAction: "createInviteLink",
        timeoutMs: 25_000,
      });
      const inviteUrl = pickInviteUrl(data, cfg.baseUrl);
      if (!inviteUrl) {
        throw new Error(
          `MeshCentral createInviteLink returned no URL (${JSON.stringify(data).slice(0, 240)})`,
        );
      }
      const expiresAt =
        hours > 0
          ? new Date(Date.now() + hours * 3600_000).toISOString()
          : null;
      return {
        inviteUrl,
        expiresAt,
        meshId: cfg.meshId,
        meshName: cfg.meshName,
        flags,
        source: "api",
      };
    } catch (e) {
      if (cfg.staticInviteUrl) {
        return {
          inviteUrl: cfg.staticInviteUrl,
          expiresAt: null,
          meshId: cfg.meshId,
          meshName: cfg.meshName,
          flags,
          source: "static",
        };
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  if (cfg.staticInviteUrl) {
    return {
      inviteUrl: cfg.staticInviteUrl,
      expiresAt: null,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      flags,
      source: "static",
    };
  }

  throw new Error(
    "MeshCentral API credentials missing. Set MESHCENTRAL_USERNAME, MESHCENTRAL_PASSWORD, and MESHCENTRAL_MESH_NAME (or MESH_ID), or MESHCENTRAL_STATIC_INVITE_URL.",
  );
}

/** Open MeshCentral web UI for technicians (browser). */
export function buildMeshCentralConsoleUrl(opts?: {
  meshId?: string | null;
  cfg?: MeshCentralConfig | null;
}): string {
  const cfg = opts?.cfg ?? getMeshCentralConfigFromEnv();
  if (!cfg) return "";
  if (cfg.connectPath) {
    if (/^https?:\/\//i.test(cfg.connectPath)) return cfg.connectPath;
    return `${cfg.baseUrl.replace(/\/+$/, "")}/${cfg.connectPath.replace(/^\/+/, "")}`;
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (opts?.meshId) {
    return `${base}/?viewmode=1`;
  }
  return base;
}

/**
 * Technician "Connect" URL for SOS queue (alias used by API routes).
 * Accepts optional pre-loaded config from getMeshCentralConfigFromEnv().
 */
export function buildMeshTechnicianConnectUrl(
  cfg?: MeshCentralConfig | null,
): string {
  return buildMeshCentralConsoleUrl({ cfg: cfg ?? null });
}

export async function probeMeshCentralAccess(): Promise<{
  ok: boolean;
  configured: boolean;
  authOk: boolean;
  meshId: string | null;
  meshName: string | null;
  message: string;
  baseUrl: string | null;
  wsUrls?: string[];
  mode: "api" | "static" | "none";
  tlsVerify?: boolean;
}> {
  const cfg = getMeshCentralConfigFromEnv();
  if (!cfg) {
    return {
      ok: false,
      configured: false,
      authOk: false,
      meshId: null,
      meshName: null,
      baseUrl: null,
      mode: "none",
      message:
        "MeshCentral not configured. Set MESHCENTRAL_URL plus username/password and device group, or a static invite URL.",
    };
  }

  if (!isMeshCentralApiConfigured()) {
    if (cfg.staticInviteUrl) {
      return {
        ok: true,
        configured: true,
        authOk: true,
        meshId: cfg.meshId,
        meshName: cfg.meshName,
        baseUrl: cfg.baseUrl,
        mode: "static",
        tlsVerify: cfg.rejectUnauthorized,
        message:
          "Using static MeshCentral invite URL (API login not fully configured). Clients share one invite page.",
      };
    }
    return {
      ok: false,
      configured: true,
      authOk: false,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      baseUrl: cfg.baseUrl,
      mode: "none",
      tlsVerify: cfg.rejectUnauthorized,
      message:
        "MESHCENTRAL_URL is set but API login or mesh group is incomplete.",
    };
  }

  const wsUrls = listControlWsUrls(cfg);

  try {
    const data = await meshRpc(
      cfg,
      { action: "meshes", responseid: `akab-probe-${Date.now()}` },
      { matchAction: "meshes", timeoutMs: 15_000 },
    );
    const meshes = data.meshes ?? data.result;
    const count = Array.isArray(meshes) ? meshes.length : null;
    return {
      ok: true,
      configured: true,
      authOk: true,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      baseUrl: cfg.baseUrl,
      wsUrls,
      mode: "api",
      tlsVerify: cfg.rejectUnauthorized,
      message:
        count != null
          ? `MeshCentral connected (${count} device group(s)). WS OK. TLS verify=${cfg.rejectUnauthorized ? "on" : "off"}.`
          : `MeshCentral connected. WS OK. TLS verify=${cfg.rejectUnauthorized ? "on" : "off"}.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (cfg.staticInviteUrl) {
      return {
        ok: true,
        configured: true,
        authOk: false,
        meshId: cfg.meshId,
        meshName: cfg.meshName,
        baseUrl: cfg.baseUrl,
        wsUrls,
        mode: "static",
        tlsVerify: cfg.rejectUnauthorized,
        message: `API probe failed (${msg}). Falling back to static invite URL.`,
      };
    }
    return {
      ok: false,
      configured: true,
      authOk: false,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      baseUrl: cfg.baseUrl,
      wsUrls,
      mode: "api",
      tlsVerify: cfg.rejectUnauthorized,
      message: msg,
    };
  }
}
