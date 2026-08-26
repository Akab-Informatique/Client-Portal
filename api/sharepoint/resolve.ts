import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  describeGraphAuthSource,
  getCachedTokenRoles,
  getGraphAccessToken,
  isGraphConfiguredFor,
  parseSharePointSiteUrl,
  resolveSiteByUrl,
  SITES_PERMISSION_HELP,
  tokenHasSitesAccess,
  type GraphCredentialOverride,
} from "../_lib/graph-client.js";
import { loadCompanyGraphAuth } from "../_lib/company-secrets.js";

function readAuthFromRequest(req: VercelRequest): GraphCredentialOverride {
  // Prefer body (POST) so client secrets are not logged in query strings / proxies.
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  const q = req.query ?? {};
  const pick = (key: string) => {
    const fromBody = body[key];
    if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
    const fromQ = q[key];
    if (typeof fromQ === "string" && fromQ.trim()) return fromQ.trim();
    if (Array.isArray(fromQ) && typeof fromQ[0] === "string" && fromQ[0].trim()) {
      return fromQ[0].trim();
    }
    return null;
  };
  return {
    tenantId: pick("tenantId"),
    clientId: pick("clientId"),
    clientSecret: pick("clientSecret"),
  };
}

function readSiteUrl(req: VercelRequest): string {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  if (typeof body.siteUrl === "string" && body.siteUrl.trim()) {
    return body.siteUrl.trim();
  }
  const q = req.query?.siteUrl;
  if (typeof q === "string") return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string") return q[0].trim();
  return "";
}

/**
 * GET|POST /api/sharepoint/resolve
 * Admin helper: verify a pasted SharePoint URL resolves via Microsoft Graph.
 *
 * Auth (optional per-client overrides):
 *   tenantId, clientId, clientSecret
 * Prefer POST JSON body when sending clientSecret.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    let auth = readAuthFromRequest(req);
    // Prefer server-side sealed secret when companyId is provided (browser never has the real secret)
    const companyIdRaw =
      (req.body && typeof req.body === "object" && (req.body as { companyId?: unknown }).companyId) ??
      req.query?.companyId;
    const companyId = Number(
      Array.isArray(companyIdRaw) ? companyIdRaw[0] : companyIdRaw,
    );
    if (Number.isFinite(companyId) && companyId > 0) {
      const fromDb = await loadCompanyGraphAuth(companyId);
      if (fromDb) {
        auth = {
          tenantId: auth.tenantId || fromDb.tenantId,
          clientId: auth.clientId || fromDb.clientId,
          // DB sealed secret wins unless the admin just typed a fresh secret in the form
          clientSecret: auth.clientSecret || fromDb.clientSecret,
        };
      }
    }
    const authInfo = describeGraphAuthSource(auth);

    if (!isGraphConfiguredFor(auth)) {
      return res.status(200).json({
        configured: false,
        ok: false,
        auth: authInfo,
        error:
          "Microsoft Graph is not configured for this client. Provide this client's Tenant ID + Application (client) ID + Client secret, or set portal MICROSOFT_TENANT_ID / CLIENT_ID / CLIENT_SECRET.",
      });
    }

    const siteUrl = readSiteUrl(req);
    if (!siteUrl) {
      return res.status(400).json({
        configured: true,
        ok: false,
        auth: authInfo,
        error: "siteUrl is required",
      });
    }

    const parsed = parseSharePointSiteUrl(siteUrl);
    if (!parsed) {
      return res.status(400).json({
        configured: true,
        ok: false,
        auth: authInfo,
        error:
          "Invalid SharePoint URL. Paste a site home link like https://contoso.sharepoint.com/sites/YourSite (not a personal OneDrive or file share link).",
      });
    }

    try {
      await getGraphAccessToken(auth);
    } catch (e) {
      return res.status(200).json({
        configured: true,
        ok: false,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        error:
          e instanceof Error
            ? `Authentication failed: ${e.message}`
            : "Authentication failed — check Microsoft credentials for this client.",
        parsed,
        help: authInfo.usingClientApp
          ? [
              "This client uses its own Entra app registration (client ID + secret).",
              "Confirm Tenant ID, Application (client) ID, and Client secret match that app.",
              "The app needs Application permission Sites.Read.All (or Sites.Selected) + admin consent in that tenant.",
            ]
          : (!!authInfo.tenantId && !authInfo.usingClientApp)
            ? [
                "This client uses a custom Entra tenant with the portal app credentials.",
                "The multi-tenant portal app must be consented in THAT tenant, or set this client's own app ID + secret.",
              ]
            : [
                "Using portal default MICROSOFT_TENANT_ID / CLIENT_ID / CLIENT_SECRET.",
                "Or paste this client's own Tenant ID + App client ID + Client secret under Clients → Edit.",
              ],
      });
    }

    const roles = getCachedTokenRoles(auth);
    if (!tokenHasSitesAccess(roles)) {
      return res.status(200).json({
        configured: true,
        ok: false,
        roles,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        error:
          "Microsoft login works, but this app has no SharePoint permission on the token (roles is empty). " +
          "That is why Graph returns “General exception while processing”. " +
          "Add Application permission Sites.Read.All and Grant admin consent on the app registration used for this client, then wait a minute and try again.",
        help: SITES_PERMISSION_HELP.split("\n"),
        parsed: {
          hostname: parsed.hostname,
          sitePath: parsed.sitePath,
          extraPath: parsed.extraPath,
          siteId: parsed.siteId || null,
        },
        code: "MissingSitesAppRole",
      });
    }

    try {
      const site = await resolveSiteByUrl(siteUrl, auth);
      return res.status(200).json({
        configured: true,
        ok: true,
        roles,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        site: {
          id: site.id,
          name: site.displayName || site.name || null,
          webUrl: site.webUrl || siteUrl,
        },
        parsed: {
          hostname: parsed.hostname,
          sitePath: parsed.sitePath,
          extraPath: parsed.extraPath,
          siteId: parsed.siteId || null,
        },
        tip:
          authInfo.usingClientApp
            ? "Site resolved using THIS client's own Graph app credentials. Other clients keep their own auth and sites."
            : "Site resolved for this client. Prefer the site home URL; put library/folder paths in “Folder path”. Optional: set this client's own App ID + secret for fully isolated auth.",
      });
    } catch (e) {
      return res.status(200).json({
        configured: true,
        ok: false,
        roles,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        error: e instanceof Error ? e.message : "Resolve failed",
        parsed: {
          hostname: parsed.hostname,
          sitePath: parsed.sitePath,
          extraPath: parsed.extraPath,
          siteId: parsed.siteId || null,
        },
        help: [
          "Use the site home URL: https://YOURTENANT.sharepoint.com/sites/SiteName",
          "Each client company has its own SharePoint connection — paste THIS client's site.",
          "Auth: portal Graph secrets, or this client's own Tenant ID + App client ID + Client secret.",
          "Azure app needs Application permission Sites.Read.All + admin consent (or Sites.Selected + site grant).",
          "Do not use *-my.sharepoint.com personal links or anonymous sharing links.",
          "Optional: paste the Graph site id (hostname,guid,guid) if you have it from Graph Explorer.",
        ],
      });
    }
  } catch (err) {
    return res.status(500).json({
      configured: false,
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
