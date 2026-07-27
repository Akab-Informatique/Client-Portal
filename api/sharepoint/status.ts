import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getCachedTokenRoles,
  getGraphAccessToken,
  getGraphConfigFromEnv,
  graphFetch,
  isGraphConfigured,
  SITES_PERMISSION_HELP,
  tokenHasSitesAccess,
} from "../_lib/graph-client.js";

/**
 * GET /api/sharepoint/status
 * Checks portal-wide Microsoft Graph app credentials + whether the token has Sites.* roles.
 * Per-client Graph apps are configured under Clients → Edit (not here).
 * ?probe=1 also hits Graph lightly.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isGraphConfigured()) {
      return res.status(200).json({
        configured: false,
        ok: false,
        scope: "portal",
        error:
          "Portal Microsoft Graph defaults are not configured. Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, and MICROSOFT_CLIENT_SECRET — or configure each client's own Graph app under Clients → Edit.",
      });
    }

    const probe = String(req.query.probe ?? "") === "1";
    const cfg = getGraphConfigFromEnv()!;

    if (!probe) {
      return res.status(200).json({
        configured: true,
        ok: true,
        scope: "portal",
        tenantId: cfg.tenantId,
        clientId: cfg.clientId,
        note: "Portal default app. Individual clients may use their own Graph app credentials under Clients.",
      });
    }

    try {
      await getGraphAccessToken();
    } catch (e) {
      return res.status(200).json({
        configured: true,
        ok: false,
        scope: "portal",
        token: false,
        error: e instanceof Error ? e.message : "Token request failed",
      });
    }

    const roles = getCachedTokenRoles();
    const hasSites = tokenHasSitesAccess(roles);

    if (!hasSites) {
      return res.status(200).json({
        configured: true,
        ok: false,
        scope: "portal",
        token: true,
        sitesAccess: false,
        roles,
        error:
          "Portal app token has no SharePoint/Sites permission. " +
          "Add Application permission Sites.Read.All and click Grant admin consent. " +
          "Until the token includes a Sites.* role, every site call returns “General exception”. " +
          "Clients with their own Graph app are checked separately when verifying that client.",
        help: SITES_PERMISSION_HELP,
        code: "MissingSitesAppRole",
      });
    }

    // Light permission check
    const search = await graphFetch<{ value?: unknown[] }>(
      `/sites?search=a&$top=1&$select=id`,
    );

    if (!search.ok) {
      return res.status(200).json({
        configured: true,
        ok: false,
        scope: "portal",
        token: true,
        sitesAccess: false,
        roles,
        error: search.error,
        code: search.code,
        help: SITES_PERMISSION_HELP,
      });
    }

    return res.status(200).json({
      configured: true,
      ok: true,
      scope: "portal",
      token: true,
      sitesAccess: true,
      roles,
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isGraphConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
