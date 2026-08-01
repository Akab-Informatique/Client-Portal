import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getItGlueConfigFromEnv,
  isItGlueConfigured,
  testItGlueConnection,
} from "../_lib/itglue-client.js";

/**
 * GET /api/itglue/status
 * Connection check for IT Glue / MyGlue API key.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isItGlueConfigured()) {
      return res.status(200).json({
        configured: false,
        ok: false,
        error:
          "ITGLUE_API_KEY is not set. Add it in app secrets (enable Password Access on the key).",
      });
    }

    const cfg = getItGlueConfigFromEnv()!;
    const result = await testItGlueConnection();
    return res.status(200).json({
      configured: true,
      ok: result.ok,
      region: cfg.region,
      organizationCount: result.sampleOrgCount ?? null,
      error: result.error ?? null,
      hint: result.ok
        ? "IT Glue connected. Link each company to an Organization ID and each user to their MyGlue/IT Glue user ID."
        : undefined,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isItGlueConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
