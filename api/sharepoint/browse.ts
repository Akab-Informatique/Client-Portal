import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  describeGraphAuthSource,
  isGraphConfiguredFor,
  joinFolderPath,
  listDriveChildren,
  parseSharePointSiteUrl,
  resolveSiteByUrl,
  type GraphCredentialOverride,
  type GraphDriveItem,
} from "../_lib/graph-client.js";

export type BrowseItem = {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  webUrl: string | null;
  lastModified: string | null;
  mimeType: string | null;
  childCount: number | null;
};

function mapItem(item: GraphDriveItem): BrowseItem {
  return {
    id: item.id,
    name: item.name,
    isFolder: !!item.folder,
    size: typeof item.size === "number" ? item.size : null,
    webUrl: item.webUrl ?? null,
    lastModified: item.lastModifiedDateTime ?? null,
    mimeType: item.file?.mimeType ?? null,
    childCount:
      typeof item.folder?.childCount === "number"
        ? item.folder.childCount
        : null,
  };
}

function readAuthFromRequest(req: VercelRequest): GraphCredentialOverride {
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

function readString(
  req: VercelRequest,
  key: string,
): string {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  if (typeof body[key] === "string") return (body[key] as string).trim();
  const q = req.query?.[key];
  if (typeof q === "string") return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string") return q[0].trim();
  return "";
}

/**
 * GET|POST /api/sharepoint/browse
 *
 * Site + folder:
 *   siteUrl, basePath, path
 * Per-client Graph auth (optional overrides):
 *   tenantId, clientId, clientSecret
 *
 * Prefer POST JSON when sending clientSecret so it is not stored in access logs.
 * Returns folder children from the site's default document library via Microsoft Graph.
 * Each client company stores its own site URL and optional Graph app — only that connection is used.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const auth = readAuthFromRequest(req);
    const authInfo = describeGraphAuthSource(auth);

    if (!isGraphConfiguredFor(auth)) {
      return res.status(200).json({
        configured: false,
        items: [],
        auth: authInfo,
        error:
          "Microsoft Graph is not configured for this client. An AKAB admin must set this company's Graph app (tenant + client ID + secret) under Clients, or portal MICROSOFT_* secrets.",
      });
    }

    const siteUrl = readString(req, "siteUrl");
    if (!siteUrl) {
      return res.status(400).json({
        configured: true,
        items: [],
        auth: authInfo,
        error: "siteUrl is required",
      });
    }

    const parsed = parseSharePointSiteUrl(siteUrl);
    if (!parsed) {
      return res.status(400).json({
        configured: true,
        items: [],
        auth: authInfo,
        error: "Invalid SharePoint site URL",
      });
    }

    const basePath = readString(req, "basePath");
    const relPath = readString(req, "path");

    // If the pasted URL already includes a library/folder after /sites/Name/, use it.
    const folderPath = joinFolderPath(parsed.extraPath, basePath, relPath);

    let site;
    try {
      site = await resolveSiteByUrl(siteUrl, auth);
    } catch (e) {
      return res.status(200).json({
        configured: true,
        items: [],
        siteUrl,
        folderPath,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        error:
          e instanceof Error
            ? e.message
            : "Failed to resolve SharePoint site",
      });
    }

    try {
      const children = await listDriveChildren(site.id, folderPath, auth);
      // Folders first, then files — Graph $orderby=name is alpha only
      const items = children
        .map(mapItem)
        .sort((a, b) => {
          if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        });

      return res.status(200).json({
        configured: true,
        site: {
          id: site.id,
          name: site.displayName || site.name || null,
          webUrl: site.webUrl || siteUrl,
        },
        folderPath,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        items,
      });
    } catch (e) {
      return res.status(200).json({
        configured: true,
        site: {
          id: site.id,
          name: site.displayName || site.name || null,
          webUrl: site.webUrl || siteUrl,
        },
        folderPath,
        auth: authInfo,
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        items: [],
        error: e instanceof Error ? e.message : "Failed to list folder",
      });
    }
  } catch (err) {
    return res.status(500).json({
      configured: false,
      items: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
