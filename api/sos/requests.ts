import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildMeshTechnicianConnectUrl,
  createTemporaryAgentInvite,
  getMeshCentralConfigFromEnv,
  isMeshCentralConfigured,
} from "../_lib/meshcentral-client.js";
import {
  insertSosRequest,
  listOpenSosRequests,
  listRecentSosRequests,
  updateSosRequest,
  type SosRequestRow,
} from "../_lib/sos-store.js";

function publicRow(row: SosRequestRow, opts?: { staff?: boolean }) {
  const cfg = getMeshCentralConfigFromEnv();
  const connectUrl = opts?.staff ? buildMeshTechnicianConnectUrl(cfg) : undefined;
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    issue: row.issue,
    status: row.status,
    /** Client: run MeshCentral temporary agent from this link (no code). */
    supportPortalLink: row.support_portal_link,
    agentInviteUrl: row.support_portal_link,
    mode: "meshcentral",
    provider: "meshcentral",
    /** Staff: open MeshCentral web console to take control */
    connectUrl: connectUrl || undefined,
    meshId: row.channel_id,
    expiresAt: row.expires_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    lastPolledAt: row.last_polled_at,
  };
}

/**
 * GET  /api/sos/requests?role=client|staff
 * POST /api/sos/requests — create SOS + MeshCentral temp agent invite
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const role = String(req.query.role ?? "staff").toLowerCase();
      const userIdRaw = req.query.userId;
      const userId =
        userIdRaw != null && String(userIdRaw).trim()
          ? Number(userIdRaw)
          : null;
      const includeClosed =
        String(req.query.includeClosed ?? "") === "1" ||
        String(req.query.includeClosed ?? "").toLowerCase() === "true";

      if (role === "client") {
        if (!userId || !Number.isFinite(userId)) {
          return res.status(400).json({
            error: "userId is required for client SOS list",
            requests: [],
          });
        }
        const rows = await listOpenSosRequests({ userId, limit: 20 });
        return res.status(200).json({
          configured: isMeshCentralConfigured(),
          mode: "meshcentral",
          provider: "meshcentral",
          requests: rows.map((r) => publicRow(r, { staff: false })),
        });
      }

      const rows = includeClosed
        ? await listRecentSosRequests({ limit: 80 })
        : await listOpenSosRequests({ limit: 100 });

      return res.status(200).json({
        configured: isMeshCentralConfigured(),
        mode: "meshcentral",
        provider: "meshcentral",
        connectUrl: buildMeshTechnicianConnectUrl(),
        openCount: rows.filter((r) =>
          ["open", "waiting", "ready", "connected"].includes(r.status),
        ).length,
        requests: rows.map((r) => publicRow(r, { staff: true })),
      });
    }

    if (req.method === "POST") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = Number(body.userId);
      const companyId = Number(body.companyId);
      const userName = String(body.userName ?? "").trim();
      const userEmail = String(body.userEmail ?? "").trim();
      const companyName = String(body.companyName ?? "").trim();
      const issue = String(body.issue ?? "").trim() || null;

      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: "userId is required" });
      }
      if (!Number.isFinite(companyId) || companyId <= 0) {
        return res.status(400).json({ error: "companyId is required" });
      }
      if (!userName || !userEmail) {
        return res
          .status(400)
          .json({ error: "userName and userEmail are required" });
      }

      // Reuse active open request (same invite) when still valid
      const existing = await listOpenSosRequests({ userId, limit: 5 });
      const active = existing.find((r) =>
        ["open", "waiting", "ready", "connected"].includes(r.status),
      );
      if (active?.support_portal_link) {
        const exp = active.expires_at ? Date.parse(active.expires_at) : NaN;
        const stillValid = !Number.isFinite(exp) || exp > Date.now();
        if (stillValid) {
          return res.status(200).json({
            configured: isMeshCentralConfigured(),
            mode: "meshcentral",
            provider: "meshcentral",
            reused: true,
            needsRunAgent: true,
            request: publicRow(active, { staff: false }),
          });
        }
      }

      if (!isMeshCentralConfigured()) {
        const row = await insertSosRequest({
          company_id: companyId,
          company_name: companyName || `Company #${companyId}`,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          issue,
          status: "error",
          error_message:
            "MeshCentral is not configured (MESHCENTRAL_URL + invite settings).",
        });
        return res.status(503).json({
          configured: false,
          mode: "meshcentral",
          error:
            "Remote support is not configured yet. Ask your provider to connect MeshCentral.",
          request: publicRow(row, { staff: false }),
        });
      }

      try {
        const invite = await createTemporaryAgentInvite({
          note: `SOS ${userName} <${userEmail}> · ${companyName}${issue ? ` · ${issue}` : ""}`,
        });
        const row = await insertSosRequest({
          company_id: companyId,
          company_name: companyName || `Company #${companyId}`,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          issue,
          status: "waiting",
          // Reuse columns: session id = mesh id marker, link = agent invite
          splashtop_session_id: invite.meshId
            ? `mesh:${invite.meshId}`
            : invite.meshName
              ? `meshname:${invite.meshName}`
              : `meshcentral:${invite.source}`,
          support_portal_link: invite.inviteUrl,
          channel_id: invite.meshId || invite.meshName,
          sos_code: null,
          expires_at: invite.expiresAt,
          error_message: null,
        });
        return res.status(201).json({
          configured: true,
          mode: "meshcentral",
          provider: "meshcentral",
          reused: false,
          needsRunAgent: true,
          request: publicRow(row, { staff: false }),
        });
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "MeshCentral invite failed";
        const row = await insertSosRequest({
          company_id: companyId,
          company_name: companyName || `Company #${companyId}`,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          issue,
          status: "error",
          error_message: msg,
        });
        return res.status(502).json({
          configured: true,
          mode: "meshcentral",
          error: msg,
          request: publicRow(row, { staff: false }),
        });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
