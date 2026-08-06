import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isDattoRmmConfigured,
  listDattoRmmSites,
} from "../_lib/datto-rmm-client.js";

/**
 * GET /api/datto-rmm/sites
 * List Datto RMM sites (for linking a client company).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed", sites: [] });
    }

    if (!isDattoRmmConfigured()) {
      return res.status(200).json({
        configured: false,
        sites: [],
        error:
          "Datto RMM is not configured. Set DATTO_RMM_API_URL, DATTO_RMM_API_KEY, and DATTO_RMM_API_SECRET.",
      });
    }

    const sites = await listDattoRmmSites();
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const filtered = q
      ? sites.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.uid.toLowerCase().includes(q) ||
            (s.description || "").toLowerCase().includes(q),
        )
      : sites;

    return res.status(200).json({
      configured: true,
      sites: filtered,
      total: sites.length,
    });
  } catch (err) {
    return res.status(502).json({
      configured: isDattoRmmConfigured(),
      sites: [],
      error: err instanceof Error ? err.message : "Failed to list Datto RMM sites",
    });
  }
}
