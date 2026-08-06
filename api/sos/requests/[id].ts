import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildTechnicianConnectUrl,
  closeSupportSession,
  derivePortalStatusFromSession,
  getSupportSession,
  isSplashtopConfigured,
  resolveClientPortalLink,
} from "../../_lib/splashtop-client.js";
import {
  getSosRequestById,
  updateSosRequest,
} from "../../_lib/sos-store.js";

/**
 * GET    /api/sos/requests/:id?role=staff|client
 * PATCH  /api/sos/requests/:id  { action: "close"|"refresh", closedByUserId? }
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

    const role = String(req.query.role ?? req.body?.role ?? "staff").toLowerCase();
    const includeCode = role === "staff";

    const toPublic = (r: typeof row) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_name,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      issue: r.issue,
      status: r.status,
      supportPortalLink:
        resolveClientPortalLink({
          link: r.support_portal_link,
          code: r.sos_code,
        }) || null,
      sosCode: includeCode ? r.sos_code : undefined,
      connectUrl:
        includeCode && r.sos_code
          ? buildTechnicianConnectUrl({ sosCode: r.sos_code, apiSession: true })
          : undefined,
      expiresAt: r.expires_at,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      lastPolledAt: r.last_polled_at,
      remoteSnapshot: includeCode ? r.remote_snapshot : undefined,
    });

    if (req.method === "GET") {
      let current = row;
      if (
        isSplashtopConfigured() &&
        row.splashtop_session_id &&
        !["closed", "expired", "error"].includes(row.status)
      ) {
        try {
          const session = await getSupportSession(row.splashtop_session_id);
          const next = derivePortalStatusFromSession(session, row.status);
          const portalLink =
            resolveClientPortalLink({
              link: session.supportPortalLink || row.support_portal_link,
              code: session.code || row.sos_code,
            }) || row.support_portal_link;
          current =
            (await updateSosRequest(row.id, {
              status: next,
              last_polled_at: new Date().toISOString(),
              sos_code: session.code || row.sos_code,
              support_portal_link: portalLink,
              expires_at: session.expiresAt || row.expires_at,
              remote_snapshot: JSON.stringify({
                status: session.status,
                serverName: session.serverName,
                serverOs: session.serverOs,
                associatedAt: session.associatedAt,
                onlineSince: session.onlineSince,
                connectedSince: session.connectedSince,
              }),
            })) ?? row;
        } catch {
          /* keep stored */
        }
      }
      return res.status(200).json({
        configured: isSplashtopConfigured(),
        request: toPublic(current),
      });
    }

    if (req.method === "PATCH" || req.method === "POST") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = String(body.action ?? "refresh").toLowerCase();

      if (action === "close") {
        if (row.splashtop_session_id && isSplashtopConfigured()) {
          try {
            await closeSupportSession(row.splashtop_session_id, "close");
          } catch {
            /* still close locally */
          }
        }
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

      if (action === "refresh") {
        if (!row.splashtop_session_id || !isSplashtopConfigured()) {
          return res.status(200).json({
            ok: true,
            request: toPublic(row),
          });
        }
        const session = await getSupportSession(row.splashtop_session_id);
        const next = derivePortalStatusFromSession(session, row.status);
        const portalLink =
          resolveClientPortalLink({
            link: session.supportPortalLink || row.support_portal_link,
            code: session.code || row.sos_code,
          }) || row.support_portal_link;
        const updated = await updateSosRequest(row.id, {
          status: next,
          last_polled_at: new Date().toISOString(),
          sos_code: session.code || row.sos_code,
          support_portal_link: portalLink,
          expires_at: session.expiresAt || row.expires_at,
          remote_snapshot: JSON.stringify({
            status: session.status,
            serverName: session.serverName,
            serverOs: session.serverOs,
            associatedAt: session.associatedAt,
            onlineSince: session.onlineSince,
            connectedSince: session.connectedSince,
          }),
        });
        return res.status(200).json({
          ok: true,
          request: toPublic(updated ?? row),
        });
      }

      return res.status(400).json({ error: "Unknown action. Use close or refresh." });
    }

    res.setHeader("Allow", "GET, PATCH, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
