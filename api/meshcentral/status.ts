import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getMeshCentralConfigFromEnv,
  isMeshCentralConfigured,
  probeMeshCentralAccess,
} from "../_lib/meshcentral-client.js";

/**
 * GET /api/meshcentral/status
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (!isMeshCentralConfigured() && !getMeshCentralConfigFromEnv()) {
      return res.status(200).json({
        ok: false,
        configured: false,
        authOk: false,
        message:
          "MeshCentral credentials missing. Set MESHCENTRAL_URL (and API user + device group, or MESHCENTRAL_STATIC_INVITE_URL) in .env, then recreate the app container.",
      });
    }
    const probe = await probeMeshCentralAccess();
    return res.status(200).json(probe);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      configured: isMeshCentralConfigured(),
      authOk: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
