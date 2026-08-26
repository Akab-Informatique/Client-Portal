import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbConfigSummary, pingDatabase } from "../_lib/pg.js";
import { readSession } from "../_lib/session.js";
import { requireSessionUser } from "../_lib/auth-server.js";

/**
 * GET /api/db/ping
 * Public: only { ok, configured } for boot — no host/user/userCount/passwordSet.
 * Staff session: optional non-secret diagnostics.
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

  // Minimal public payload (browser boot) — no topology or row counts
  const base = {
    mode: "postgres" as const,
    configured: true,
    ok: ping.ok,
    latencyMs: ping.latencyMs ?? null,
    error: ping.ok ? null : "Database unavailable",
    native: false,
  };

  const session = readSession(req);
  if (session) {
    try {
      const user = await requireSessionUser(session);
      if (user && user.role !== "client") {
        return res.status(200).json({
          ...base,
          host: summary.host,
          database: ping.database ?? summary.database,
          userCount: ping.userCount ?? null,
          passwordSet: summary.passwordSet,
        });
      }
    } catch {
      /* fall through */
    }
  }

  return res.status(200).json(base);
}
