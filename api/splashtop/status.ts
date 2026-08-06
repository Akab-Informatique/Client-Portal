import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  clearSplashtopCache,
  isSplashtopConfigured,
  probeSplashtopAccess,
} from "../_lib/splashtop-client.js";

/**
 * GET /api/splashtop/status
 * Optional: ?refresh=1 clears team-id cache.
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
    return res.status(200).json(probe);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      configured: isSplashtopConfigured(),
      authOk: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
