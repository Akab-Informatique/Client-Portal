import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildTechnicianConnectUrl,
  CLASSIC_SOS_PORTAL_URL,
  createSupportSession,
  derivePortalStatusFromSession,
  getSupportSession,
  isSplashtopConfigured,
} from "../_lib/splashtop-client.js";
import {
  getSosRequestById,
  insertSosRequest,
  listOpenSosRequests,
  listRecentSosRequests,
  updateSosRequest,
  type SosRequestRow,
} from "../_lib/sos-store.js";

function isApiBacked(row: SosRequestRow): boolean {
  return Boolean(row.splashtop_session_id);
}

function publicRow(row: SosRequestRow, opts?: { includeCode?: boolean }) {
  const apiSession = isApiBacked(row);
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    issue: row.issue,
    status: row.status,
    supportPortalLink: row.support_portal_link,
    /** How the session was created: api | manual */
    mode: apiSession ? "api" : "manual",
    classicSosUrl: CLASSIC_SOS_PORTAL_URL,
    /**
     * SOS code:
     * - staff always see it (for Connect)
     * - client sees it in manual mode so they can confirm what they entered
     */
    sosCode:
      opts?.includeCode || !apiSession ? row.sos_code ?? undefined : undefined,
    connectUrl:
      opts?.includeCode && row.sos_code
        ? buildTechnicianConnectUrl({
            sosCode: row.sos_code,
            apiSession,
          })
        : undefined,
    expiresAt: row.expires_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    lastPolledAt: row.last_polled_at,
  };
}

async function refreshFromSplashtop(row: SosRequestRow): Promise<SosRequestRow> {
  if (!row.splashtop_session_id || !isSplashtopConfigured()) return row;
  const terminal = ["closed", "expired", "error"];
  if (terminal.includes(row.status)) return row;
  try {
    const session = await getSupportSession(row.splashtop_session_id);
    const nextStatus = derivePortalStatusFromSession(session, row.status);
    const snapshot = JSON.stringify({
      status: session.status,
      serverName: session.serverName,
      serverOs: session.serverOs,
      associatedAt: session.associatedAt,
      onlineSince: session.onlineSince,
      connectedSince: session.connectedSince,
    });
    const updated = await updateSosRequest(row.id, {
      status: nextStatus,
      last_polled_at: new Date().toISOString(),
      remote_snapshot: snapshot,
      sos_code: session.code || row.sos_code,
      support_portal_link:
        session.supportPortalLink || row.support_portal_link,
      expires_at: session.expiresAt || row.expires_at,
    });
    return updated ?? row;
  } catch {
    await updateSosRequest(row.id, {
      last_polled_at: new Date().toISOString(),
    });
    return row;
  }
}

/**
 * GET  /api/sos/requests?role=client|staff&userId=&companyId=
 * POST /api/sos/requests  body: { userId, userName, userEmail, companyId, companyName, issue? }
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
      const refresh =
        String(req.query.refresh ?? "1") !== "0" &&
        String(req.query.refresh ?? "").toLowerCase() !== "false";
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
        let rows = await listOpenSosRequests({ userId, limit: 20 });
        if (refresh) {
          rows = await Promise.all(rows.map((r) => refreshFromSplashtop(r)));
        }
        return res.status(200).json({
          configured: isSplashtopConfigured(),
          mode: isSplashtopConfigured() ? "api" : "manual",
          classicSosUrl: CLASSIC_SOS_PORTAL_URL,
          requests: rows.map((r) => publicRow(r, { includeCode: false })),
        });
      }

      // staff queue
      let rows = includeClosed
        ? await listRecentSosRequests({ limit: 80 })
        : await listOpenSosRequests({ limit: 100 });
      if (refresh) {
        rows = await Promise.all(
          rows
            .filter((r) =>
              ["open", "waiting", "ready", "connected"].includes(r.status),
            )
            .map((r) => refreshFromSplashtop(r)),
        );
        // re-list after refresh so closed ones drop when includeClosed=false
        rows = includeClosed
          ? await listRecentSosRequests({ limit: 80 })
          : await listOpenSosRequests({ limit: 100 });
      }
      return res.status(200).json({
        configured: isSplashtopConfigured(),
        mode: isSplashtopConfigured() ? "api" : "manual",
        classicSosUrl: CLASSIC_SOS_PORTAL_URL,
        openCount: rows.filter((r) =>
          ["open", "waiting", "ready", "connected"].includes(r.status),
        ).length,
        requests: rows.map((r) => publicRow(r, { includeCode: true })),
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
        return res.status(400).json({ error: "userName and userEmail are required" });
      }

      // Reuse an existing open request for this user if still active
      const existing = await listOpenSosRequests({ userId, limit: 5 });
      if (existing[0]?.support_portal_link) {
        const refreshed = await refreshFromSplashtop(existing[0]);
        if (["open", "waiting", "ready", "connected"].includes(refreshed.status)) {
          return res.status(200).json({
            configured: isSplashtopConfigured(),
            reused: true,
            request: publicRow(refreshed, { includeCode: false }),
          });
        }
      }

      if (!isSplashtopConfigured()) {
        // Still record a queue entry so techs see demand; mark error for link
        const row = await insertSosRequest({
          company_id: companyId,
          company_name: companyName || `Company #${companyId}`,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          issue,
          status: "error",
          error_message:
            "Splashtop is not configured on the server (SPLASHTOP_API_TOKEN).",
        });
        return res.status(503).json({
          configured: false,
          error:
            "Remote support is not configured yet. Your request was logged for staff.",
          request: publicRow(row, { includeCode: false }),
        });
      }

      try {
        const session = await createSupportSession({
          customerName: `${userName} · ${companyName || "Client"}`.slice(0, 120),
          customerIssue:
            issue ||
            `SOS from AKAB portal — ${userName} <${userEmail}> (${companyName})`,
        });
        const row = await insertSosRequest({
          company_id: companyId,
          company_name: companyName || `Company #${companyId}`,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          issue,
          status: "waiting",
          splashtop_session_id: session.id || null,
          sos_code: session.code || null,
          support_portal_link: session.supportPortalLink || null,
          channel_id: session.channelId,
          expires_at: session.expiresAt,
        });
        return res.status(201).json({
          configured: true,
          reused: false,
          request: publicRow(row, { includeCode: false }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Splashtop create failed";
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
          error: msg,
          request: publicRow(row, { includeCode: false }),
        });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
      requests: [],
    });
  }
}

// re-export helper for [id] route typecheck silence
export { getSosRequestById };
