import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/sos/package-config
 *
 * Branding for the in-portal SOS download page.
 *
 * Download is ALWAYS the API session portal link created on the team
 * Default channel (support_portal_link). Custom package / share / OS
 * backup URLs are intentionally disabled so clients never land on a
 * generic SOS package outside the queued session.
 *
 * Optional branding only:
 *   SPLASHTOP_SOS_PACKAGE_NAME
 *   SPLASHTOP_SOS_AUTO_DOWNLOAD  (default true)
 */

function clean(v: unknown): string {
  if (v == null) return "";
  let s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/\r/g, "").trim();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const packageName =
      clean(process.env.SPLASHTOP_SOS_PACKAGE_NAME) || "Remote support";
    const autoRaw = clean(process.env.SPLASHTOP_SOS_AUTO_DOWNLOAD).toLowerCase();
    const autoDownload =
      autoRaw === "" ||
      autoRaw === "1" ||
      autoRaw === "true" ||
      autoRaw === "yes";

    return res.status(200).json({
      ok: true,
      packageName,
      autoDownload,
      // Always session — Default-channel API portal link only
      mode: "session",
      hasCustomPackage: false,
      packageUrls: {
        share: null,
        windows: null,
        mac: null,
        linux: null,
        android: null,
      },
      hints: {
        createPackage:
          "Disabled: clients use the Default-channel session portal link only (no package backup URLs).",
        applyToApiSessions:
          "my.splashtop.com → Management → Settings → Third Party Integration → Package file (optional brand on the session link itself)",
        envKeys: [
          "SPLASHTOP_SOS_PACKAGE_NAME",
          "SPLASHTOP_SOS_AUTO_DOWNLOAD",
          "SPLASHTOP_CHANNEL_ID",
        ],
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
