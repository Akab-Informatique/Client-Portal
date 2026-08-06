import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchServiceDeskCloudBuild,
  platformFromUserAgent,
  resolveClientPortalLink,
  type SosCloudBuildPlatform,
} from "../_lib/splashtop-client.js";
import { getSosRequestById } from "../_lib/sos-store.js";

/**
 * GET /api/sos/download?id=<sos_request_id>&platform=win|mac|auto
 *
 * Resolves the real session-bound SOS installer (.exe / .dmg) via Splashtop's
 * cloud_build_file API. Clients download this file directly — they never need
 * the Splashtop HTML page (which shows "App not available" when the SPA fails
 * or the session is closed).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const id = Number(idRaw);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }

    const row = await getSosRequestById(id);
    if (!row) {
      return res.status(404).json({ ok: false, error: "SOS request not found" });
    }

    if (["closed", "expired", "error"].includes(String(row.status))) {
      return res.status(410).json({
        ok: false,
        error:
          "This support session is no longer available. Click Start SOS again.",
        status: row.status,
      });
    }

    const code = String(row.sos_code || "").trim();
    if (!code) {
      return res.status(409).json({
        ok: false,
        error: "Session code missing — start SOS again.",
      });
    }

    const platRaw = String(
      Array.isArray(req.query.platform)
        ? req.query.platform[0]
        : req.query.platform ?? "auto",
    )
      .trim()
      .toLowerCase();
    let platform: SosCloudBuildPlatform;
    if (platRaw === "mac" || platRaw === "macos" || platRaw === "osx") {
      platform = "mac";
    } else if (platRaw === "win" || platRaw === "windows") {
      platform = "win";
    } else {
      platform = platformFromUserAgent(
        String(req.headers["user-agent"] || ""),
      );
    }

    const build = await fetchServiceDeskCloudBuild(code, platform);
    const portalLink =
      resolveClientPortalLink({
        link: row.support_portal_link,
        code,
      }) || null;

    if (!build.ok || !build.downloadUrl) {
      return res.status(502).json({
        ok: false,
        error:
          build.error ||
          "Could not get the SOS installer. Start SOS again, or try Download now.",
        platform: build.platform,
        portalLink,
        status: row.status,
      });
    }

    return res.status(200).json({
      ok: true,
      platform: build.platform,
      downloadUrl: build.downloadUrl,
      fileName: build.fileName,
      portalLink,
      // Never expose sos code to client payload beyond what's needed
      requestId: row.id,
      status: row.status,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
