import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isDattoRmmConfigured,
  listDattoRmmDevicesForSite,
} from "../_lib/datto-rmm-client.js";

/**
 * GET /api/datto-rmm/devices?siteUid=…
 * List devices for one Datto RMM site (one client company).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed", devices: [] });
    }

    if (!isDattoRmmConfigured()) {
      return res.status(200).json({
        configured: false,
        devices: [],
        error:
          "Datto RMM is not configured. Set DATTO_RMM_API_URL, DATTO_RMM_API_KEY, and DATTO_RMM_API_SECRET.",
      });
    }

    const siteUid = String(
      Array.isArray(req.query.siteUid) ? req.query.siteUid[0] : req.query.siteUid ?? "",
    ).trim();
    if (!siteUid) {
      return res.status(400).json({
        configured: true,
        devices: [],
        error: "siteUid is required",
      });
    }

    const devices = await listDattoRmmDevicesForSite(siteUid);
    return res.status(200).json({
      configured: true,
      siteUid,
      devices,
      count: devices.length,
      onlineCount: devices.filter((d) => d.online === true).length,
      offlineCount: devices.filter((d) => d.online === false).length,
    });
  } catch (err) {
    return res.status(502).json({
      configured: isDattoRmmConfigured(),
      devices: [],
      error:
        err instanceof Error ? err.message : "Failed to list Datto RMM devices",
    });
  }
}
