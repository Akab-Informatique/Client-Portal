import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchServiceDeskCloudBuild,
  platformFromUserAgent,
  type SosCloudBuildPlatform,
} from "../_lib/splashtop-client.js";
import { getSosRequestById } from "../_lib/sos-store.js";

/**
 * GET /api/sos/download?id=<sos_request_id>&platform=win|mac|auto[&file=1]
 *
 * Resolves the real session-bound SOS installer (.exe / .dmg) via Splashtop
 * cloud_build_file and either:
 *   - JSON { downloadUrl, fileName } (default) — for diagnostics
 *   - file=1 → proxy stream with Content-Disposition: attachment
 *     so the browser downloads the binary WITHOUT opening Splashtop HTML.
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

    const wantFile = (() => {
      const f = String(
        Array.isArray(req.query.file) ? req.query.file[0] : req.query.file ?? "",
      )
        .trim()
        .toLowerCase();
      const m = String(
        Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode ?? "",
      )
        .trim()
        .toLowerCase();
      return (
        f === "1" ||
        f === "true" ||
        f === "yes" ||
        m === "file" ||
        m === "stream" ||
        m === "download"
      );
    })();

    const build = await fetchServiceDeskCloudBuild(code, platform);

    if (!build.ok || !build.downloadUrl) {
      return res.status(502).json({
        ok: false,
        error:
          build.error ||
          "Could not get the SOS installer. Start SOS again, or try Download again.",
        platform: build.platform,
        status: row.status,
      });
    }

    const fileName =
      build.fileName ||
      (build.platform === "mac" ? "SplashtopSOS.dmg" : "SplashtopSOS.exe");

    // Same-origin file stream — browser saves the binary, never navigates to Splashtop
    if (wantFile) {
      const upstream = await fetch(build.downloadUrl, {
        redirect: "follow",
        headers: {
          Accept: "*/*",
          // Some CDNs want a browser-like UA
          "User-Agent":
            String(req.headers["user-agent"] || "") ||
            "AKAB-Portal-SOS-Download/1.0",
        },
      });
      if (!upstream.ok || !upstream.body) {
        return res.status(502).json({
          ok: false,
          error: `Installer fetch failed (${upstream.status}). Try Download again.`,
          platform: build.platform,
        });
      }

      const contentType =
        upstream.headers.get("content-type") ||
        (build.platform === "mac"
          ? "application/x-apple-diskimage"
          : "application/octet-stream");
      // Force download — never inline HTML
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName.replace(/"/g, "")}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);

      // Node fetch body → buffer → send (works in Vercel + local Node)
      const ab = await upstream.arrayBuffer();
      const buf = Buffer.from(ab);
      res.status(200).end(buf);
      return;
    }

    // JSON metadata (for UI status / filename). Prefer same-origin stream URL.
    const qs = new URLSearchParams({
      id: String(row.id),
      platform: build.platform,
      file: "1",
    });
    return res.status(200).json({
      ok: true,
      platform: build.platform,
      // Same-origin proxy — clients MUST use this, not the Splashtop CDN URL
      downloadUrl: `/api/sos/download?${qs.toString()}`,
      // Direct CDN (diagnostics only — do not open in browser as navigation)
      directUrl: build.downloadUrl,
      fileName,
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
