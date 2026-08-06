import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildMeshTechnicianConnectUrl,
  getMeshCentralConfigFromEnv,
  isMeshCentralConfigured,
} from "../../_lib/meshcentral-client.js";
import {
  getSosRequestById,
  updateSosRequest,
} from "../../_lib/sos-store.js";

/**
 * GET   /api/sos/requests/:id
 * PATCH /api/sos/requests/:id  { action: "close"|"ready"|"refresh", closedByUserId? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const id = Number(idRaw);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const row = await getSosRequestById(id);
    if (!row) return res.status(404).json({ error: "SOS request not found" });

    const role = String(
      req.query.role ?? (req.body as { role?: string } | undefined)?.role ?? "staff",
    ).toLowerCase();
    const staff = role === "staff";
    const cfg = getMeshCentralConfigFromEnv();

    const toPublic = (r: typeof row) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_name,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      issue: r.issue,
      status: r.status,
      supportPortalLink: r.support_portal_link,
      agentInviteUrl: r.support_portal_link,
      mode: "meshcentral",
      provider: "meshcentral",
      connectUrl: staff ? buildMeshTechnicianConnectUrl(cfg) || undefined : undefined,
      meshId: r.channel_id,
      expiresAt: r.expires_at,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      lastPolledAt: r.last_polled_at,
      remoteSnapshot: staff ? r.remote_snapshot : undefined,
    });

    if (req.method === "GET") {
      return res.status(200).json({
        configured: isMeshCentralConfigured(),
        request: toPublic(row),
      });
    }

    if (req.method === "PATCH" || req.method === "POST") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = String(body.action ?? "refresh").toLowerCase();

      if (action === "close") {
        const closedBy =
          body.closedByUserId != null ? Number(body.closedByUserId) : null;
        const updated = await updateSosRequest(row.id, {
          status: "closed",
          closed_at: new Date().toISOString(),
          closed_by_user_id:
            closedBy != null && Number.isFinite(closedBy) ? closedBy : null,
        });
        return res.status(200).json({
          ok: true,
          request: toPublic(updated ?? row),
        });
      }

      // Client finished launching the temp agent
      if (action === "ready" || action === "agent_running") {
        const updated = await updateSosRequest(row.id, {
          status: "ready",
          last_polled_at: new Date().toISOString(),
          error_message: null,
        });
        return res.status(200).json({
          ok: true,
          request: toPublic(updated ?? row),
        });
      }

      if (action === "refresh") {
        return res.status(200).json({
          ok: true,
          request: toPublic(row),
        });
      }

      // Legacy no-ops from Splashtop code flow
      if (action === "set_code" || action === "attach_code") {
        return res.status(400).json({
          error:
            "SOS now uses MeshCentral temporary agents — no code entry. Open the agent link and run the app.",
        });
      }

      return res.status(400).json({
        error: "Unknown action. Use close, ready, or refresh.",
      });
    }

    res.setHeader("Allow", "GET, PATCH, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
