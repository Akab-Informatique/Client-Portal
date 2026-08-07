import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  clearDattoRmmTokenCache,
  getDattoRmmConfigFromEnv,
  getDattoRmmPortalBaseUrl,
  isDattoRmmConfigured,
  testDattoRmmConnection,
} from "../_lib/datto-rmm-client.js";

/**
 * GET /api/datto-rmm/status?refresh=1
 * Connection check for Datto RMM API credentials.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isDattoRmmConfigured()) {
      return res.status(200).json({
        configured: false,
        ok: false,
        error:
          "Datto RMM is not configured. Set DATTO_RMM_API_URL, DATTO_RMM_API_KEY, and DATTO_RMM_API_SECRET.",
      });
    }

    const refresh =
      String(req.query.refresh ?? "") === "1" ||
      String(req.query.refresh ?? "").toLowerCase() === "true";
    if (refresh) clearDattoRmmTokenCache();

    const cfg = getDattoRmmConfigFromEnv()!;
    const result = await testDattoRmmConnection();
    const portalUrl = getDattoRmmPortalBaseUrl(cfg);
    return res.status(200).json({
      configured: true,
      ok: result.ok,
      apiUrl: cfg.apiUrl,
      portalUrl: portalUrl ?? null,
      siteCount: result.siteCount ?? null,
      accountName: result.accountName ?? null,
      error: result.error ?? null,
      hint: result.ok
        ? "Datto RMM connected. Link each client company to a Site UID under Clients → Edit."
        : undefined,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isDattoRmmConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
