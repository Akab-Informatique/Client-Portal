import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  diagnoseConnectBoosterEnv,
  isConnectBoosterApiConfigured,
  isConnectBoosterPortalConfigured,
} from "../_lib/connectbooster-client.js";

/**
 * GET /api/connectbooster/status
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const diag = diagnoseConnectBoosterEnv();
    const ok = diag.portalConfigured || diag.apiConfigured;

    return res.status(200).json({
      ok,
      configured: ok,
      portalConfigured: diag.portalConfigured,
      apiConfigured: diag.apiConfigured,
      portalBaseUrl: diag.portalBaseUrl,
      apiBaseUrl: diag.apiBaseUrl,
      hasApiKey: diag.hasApiKey,
      accountIdSet: diag.accountIdSet,
      issues: diag.issues,
      message: ok
        ? diag.portalConfigured && diag.apiConfigured
          ? "ConnectBooster portal + API configured"
          : diag.portalConfigured
            ? "ConnectBooster portal URL configured (invoice list API optional)"
            : "ConnectBooster API configured"
        : "ConnectBooster not configured. Set CONNECTBOOSTER_PORTAL_BASE_URL in .env (and optional API key).",
      fix: ok
        ? undefined
        : [
            "Edit /opt/akab-portal/.env:",
            "  CONNECTBOOSTER_PORTAL_BASE_URL=https://your-payment-portal.example",
            "  # optional invoice API (tenant-specific):",
            "  # CONNECTBOOSTER_API_BASE_URL=...",
            "  # CONNECTBOOSTER_API_KEY='...'",
            "  # CONNECTBOOSTER_ACCOUNT_ID=...",
            "Map each client: Clients → Edit → ConnectBooster customer ID",
            "Then: docker compose up -d --force-recreate app",
          ],
      portalReady: isConnectBoosterPortalConfigured(),
      apiReady: isConnectBoosterApiConfigured(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
