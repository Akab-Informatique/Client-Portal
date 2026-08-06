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
 *   MESHCENTRAL_REJECT_UNAUTHORIZED — "false" to allow self-signed TLS (dev only)
 *   MESHCENTRAL_CONNECT_PATH     — path/hash for tech UI (default empty → base URL)
 */

import WebSocket from "ws";

function cleanEnv(v: unknown): string {
  return String(v ?? "").trim();
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
  rejectUnauthorized: boolean;
  connectPath: string;
};

export function getMeshCentralConfigFromEnv(): MeshCentralConfig | null {
  const baseRaw = cleanEnv(process.env.MESHCENTRAL_URL);
  if (!baseRaw) return null;
  let baseUrl = baseRaw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;

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

  const rejectUnauthorized =
    cleanEnv(process.env.MESHCENTRAL_REJECT_UNAUTHORIZED).toLowerCase() !==
    "false";

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

function controlWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Preserve path prefix if MeshCentral is under a subpath
  const path = u.pathname.replace(/\/+$/, "");
  u.pathname = `${path}/control.ashx`.replace(/\/{2,}/g, "/");
  u.search = "";
  u.hash = "";
  return u.toString();
}

function meshAuthHeader(username: string, password: string): string {
  return (
    Buffer.from(username, "utf8").toString("base64") +
    "," +
    Buffer.from(password, "utf8").toString("base64")
  );
}

type WsJson = Record<string, unknown>;

/**
 * One-shot authenticated WebSocket RPC against MeshCentral control.ashx.
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

  return new Promise((resolve, reject) => {
    let settled = false;
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
      finish(new Error(`MeshCentral RPC timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(controlWsUrl(cfg.baseUrl), {
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
          const msg = String(data.result);
          // Some successes use result: "ok"
          if (!/^ok$/i.test(msg)) {
            finish(new Error(`MeshCentral: ${msg}`));
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
        finish(new Error("MeshCentral WebSocket closed before response"));
      }
    });
  });
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
  // Some builds return only a code → public invite page
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

  if (isMeshCentralApiConfigured() && cfg.username && cfg.password) {
    const req: WsJson = {
      action: "createInviteLink",
      expire: hours,
      flags,
      responseid: `akab-invite-${Date.now()}`,
    };
    if (cfg.meshId) req.meshid = cfg.meshId;
    else if (cfg.meshName) req.meshname = cfg.meshName;

    try {
      const data = await meshRpc(cfg, req, {
        matchAction: "createInviteLink",
        timeoutMs: 25_000,
      });
      const inviteUrl = pickInviteUrl(data, cfg.baseUrl);
      if (!inviteUrl) {
        throw new Error(
          "MeshCentral createInviteLink returned no url (check mesh id/name and permissions)",
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
      // Fall through to static invite if configured
      if (!cfg.staticInviteUrl) throw e;
    }
  }

  if (cfg.staticInviteUrl) {
    return {
      inviteUrl: cfg.staticInviteUrl,
      expiresAt:
        hours > 0
          ? new Date(Date.now() + hours * 3600_000).toISOString()
          : null,
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

/** Tech console URL (browser). */
export function buildMeshTechnicianConnectUrl(
  cfg?: MeshCentralConfig | null,
): string {
  const c = cfg ?? getMeshCentralConfigFromEnv();
  if (!c) return "";
  const base = c.baseUrl.replace(/\/+$/, "");
  if (c.connectPath) {
    if (/^https?:\/\//i.test(c.connectPath)) return c.connectPath;
    if (c.connectPath.startsWith("#")) return `${base}/${c.connectPath}`;
    return `${base}/${c.connectPath.replace(/^\/+/, "")}`;
  }
  return base;
}

export async function probeMeshCentralAccess(): Promise<{
  ok: boolean;
  configured: boolean;
  authOk: boolean;
  message: string;
  baseUrl: string | null;
  meshId: string | null;
  meshName: string | null;
  staticInviteOnly: boolean;
}> {
  const cfg = getMeshCentralConfigFromEnv();
  if (!cfg) {
    return {
      ok: false,
      configured: false,
      authOk: false,
      message:
        "MeshCentral not configured. Set MESHCENTRAL_URL plus username/password and device group, or a static invite URL.",
      baseUrl: null,
      meshId: null,
      meshName: null,
      staticInviteOnly: false,
    };
  }

  if (!isMeshCentralApiConfigured()) {
    if (cfg.staticInviteUrl) {
      return {
        ok: true,
        configured: true,
        authOk: false,
        message:
          "Using static invite URL only (no MeshCentral API login). Clients can still run the temp agent from that link.",
        baseUrl: cfg.baseUrl,
        meshId: cfg.meshId,
        meshName: cfg.meshName,
        staticInviteOnly: true,
      };
    }
    return {
      ok: false,
      configured: true,
      authOk: false,
      message:
        "MESHCENTRAL_URL is set but API login or mesh group is incomplete.",
      baseUrl: cfg.baseUrl,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      staticInviteOnly: false,
    };
  }

  try {
    // Lightweight call: list meshes (device groups)
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
      message:
        count != null
          ? `MeshCentral connected (${count} device group(s)). SOS uses interactive-only temp agent invites.`
          : "MeshCentral connected. SOS uses interactive-only temp agent invites.",
      baseUrl: cfg.baseUrl,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      staticInviteOnly: false,
    };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      authOk: false,
      message: e instanceof Error ? e.message : "MeshCentral probe failed",
      baseUrl: cfg.baseUrl,
      meshId: cfg.meshId,
      meshName: cfg.meshName,
      staticInviteOnly: false,
    };
  }
}
