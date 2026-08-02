import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbConfigSummary, pingDatabase } from "../_lib/pg.js";

/**
 * GET /api/db/ping — fastest Postgres check (also implemented natively in
 * server/prod-server.mjs so production never depends on tsx for boot).
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
      error: "POSTGRES_* not set",
    });
  }

  const ping = await pingDatabase(4000);
  return res.status(200).json({
    mode: "postgres",
    configured: true,
    ok: ping.ok,
    host: summary.host,
    database: ping.database ?? summary.database,
    user: ping.user ?? summary.user,
    passwordSet: summary.passwordSet,
    userCount: ping.userCount ?? null,
    latencyMs: ping.latencyMs ?? null,
    error: ping.error ?? null,
  });
}
