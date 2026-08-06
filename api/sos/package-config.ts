import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/sos/package-config
 *
 * Public (authenticated clients call it) package branding for the in-portal
 * SOS download page. URLs come from server .env — no rebuild required.
 *
 * Splashtop console:
 *   Management → SOS Customization → Create SOS App → Share
 *   - Share Link  → SPLASHTOP_SOS_PACKAGE_SHARE_URL
 *   - Download App (Win/Mac) → SPLASHTOP_SOS_PACKAGE_WIN_URL / _MAC_URL
 *
 * For API sessions to use your branded package automatically, also set:
 *   Management → Settings → Third Party Integration → Package file
 * so support_portal_link serves the custom package.
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

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const shareUrl = clean(process.env.SPLASHTOP_SOS_PACKAGE_SHARE_URL);
    const winUrl = clean(process.env.SPLASHTOP_SOS_PACKAGE_WIN_URL);
    const macUrl = clean(process.env.SPLASHTOP_SOS_PACKAGE_MAC_URL);
    const linuxUrl = clean(process.env.SPLASHTOP_SOS_PACKAGE_LINUX_URL);
    const androidUrl = clean(process.env.SPLASHTOP_SOS_PACKAGE_ANDROID_URL);
    const packageName =
      clean(process.env.SPLASHTOP_SOS_PACKAGE_NAME) || "Remote support";
    const autoRaw = clean(process.env.SPLASHTOP_SOS_AUTO_DOWNLOAD).toLowerCase();
    const autoDownload = autoRaw === "" || autoRaw === "1" || autoRaw === "true" || autoRaw === "yes";
    // session = always start session portal link (API-bound, recommended)
    // package = start custom package URL first (still keep session link as fallback)
    // both = start package + keep session link visible
    const modeRaw = clean(process.env.SPLASHTOP_SOS_CLIENT_MODE).toLowerCase();
    const mode =
      modeRaw === "package" || modeRaw === "both" ? modeRaw : "session";

    const packageUrls = {
      share: isHttpUrl(shareUrl) ? shareUrl : null,
      windows: isHttpUrl(winUrl) ? winUrl : null,
      mac: isHttpUrl(macUrl) ? macUrl : null,
      linux: isHttpUrl(linuxUrl) ? linuxUrl : null,
      android: isHttpUrl(androidUrl) ? androidUrl : null,
    };

    const hasCustomPackage = Boolean(
      packageUrls.share ||
        packageUrls.windows ||
        packageUrls.mac ||
        packageUrls.linux ||
        packageUrls.android,
    );

    return res.status(200).json({
      ok: true,
      packageName,
      autoDownload,
      mode,
      hasCustomPackage,
      packageUrls,
      hints: {
        createPackage:
          "my.splashtop.com → Management → SOS Customization → Create SOS App → Share",
        applyToApiSessions:
          "my.splashtop.com → Management → Settings → Third Party Integration → select your Package file so API session links use the branded app",
        envKeys: [
          "SPLASHTOP_SOS_PACKAGE_SHARE_URL",
          "SPLASHTOP_SOS_PACKAGE_WIN_URL",
          "SPLASHTOP_SOS_PACKAGE_MAC_URL",
          "SPLASHTOP_SOS_PACKAGE_NAME",
          "SPLASHTOP_SOS_CLIENT_MODE",
          "SPLASHTOP_SOS_AUTO_DOWNLOAD",
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
