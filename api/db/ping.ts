import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbConfigSummary, pingDatabase } from "../_lib/pg.js";
import { getRequestSessionUserId, readSession } from "../_lib/session.js";
import { loadUserById } from "../_lib/auth-server.js";

/**
 * GET /api/db/ping
 * Public: only { ok, configured } for boot.
 * Staff session: includes non-secret diagnostics (no password flags detail abuse).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const summary = getDbConfigSummary();
  if (!summary.configured) {
    return res.status(200).json({
      mode: "none",
      configured: false,
      ok: false,
      error: "Database not configured",
    });
  }

  const ping = await pingDatabase(4000);

  // Minimal public payload (browser boot)
  const base = {
    mode: "postgres" as const,
    configured: true,
    ok: ping.ok,
    userCount: ping.userCount ?? null,
    latencyMs: ping.latencyMs ?? null,
    error: ping.ok ? null : "Database unavailable",
    native: false,
  };

  // Extra diagnostics only for authenticated staff
  const uid = getRequestSessionUserId(req);
  if (uid != null && readSession(req)) {
    try {
      const user = await loadUserById(uid);
      if (user && user.active && user.role !== "client") {
        return res.status(200).json({
          ...base,
          host: summary.host,
          database: ping.database ?? summary.database,
          // Do not expose DB user name or passwordSet to clients
          passwordSet: summary.passwordSet,
        });
      }
    } catch {
      /* fall through */
    }
  }

  return res.status(200).json(base);
}
