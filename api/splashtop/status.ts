import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  clearSplashtopCache,
  closeSupportSession,
  createSupportSession,
  isSplashtopConfigured,
  probeSplashtopAccess,
} from "../_lib/splashtop-client.js";

/**
 * GET /api/splashtop/status
 * Optional:
 *   ?refresh=1       — clear team-id cache
 *   ?testCreate=1    — create + immediately close a dummy SOS session (staff diag)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (
      String(req.query.refresh ?? "") === "1" ||
      String(req.query.refresh ?? "").toLowerCase() === "true"
    ) {
      clearSplashtopCache();
    }
    if (!isSplashtopConfigured()) {
      return res.status(200).json({
        ok: false,
        configured: false,
        authOk: false,
        teamId: null,
        message:
          "Splashtop credentials missing. Set SPLASHTOP_API_TOKEN in /opt/akab-portal/.env then recreate the app container.",
      });
    }
    const probe = await probeSplashtopAccess();

    const wantTest =
      String(req.query.testCreate ?? "") === "1" ||
      String(req.query.testCreate ?? "").toLowerCase() === "true";

    if (!wantTest) {
      return res.status(200).json(probe);
    }

    // Live create+close — proves the exact path the SOS button uses
    try {
      const session = await createSupportSession({
        customerName: "AKAB Portal Test",
        customerIssue: "Diagnostic testCreate — safe to ignore",
      });
      try {
        if (session.id) await closeSupportSession(session.id, "close");
      } catch {
        /* best-effort close */
      }
      return res.status(200).json({
        ...probe,
        testCreate: {
          ok: true,
          sessionId: session.id,
          code: session.code,
          supportPortalLink: session.supportPortalLink,
          closed: true,
        },
      });
    } catch (e) {
      return res.status(200).json({
        ...probe,
        testCreate: {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  } catch (err) {
    return res.status(500).json({
      ok: false,
      configured: isSplashtopConfigured(),
      authOk: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
