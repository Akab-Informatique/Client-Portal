import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbConfigSummary, pingDatabase } from "./_lib/pg.js";

/**
 * GET /api/health
 * Default: process liveness only (Docker HEALTHCHECK).
 * ?db=1 : also ping Postgres — public response is ok/configured only
 * (no host, user, userCount, passwordSet, or raw error strings).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const checkDb =
    String(req.query.db ?? "") === "1" ||
    String(req.query.db ?? "").toLowerCase() === "true";

  const summary = getDbConfigSummary();
  const base = {
    ok: true as boolean,
    service: "akab-portal",
    postgresConfigured: summary.configured,
    ts: new Date().toISOString(),
  };

  if (!checkDb) {
    return res.status(200).json(base);
  }

  if (!summary.configured) {
    return res.status(200).json({
      ...base,
      ok: false,
      postgresOk: false,
      error: "PostgreSQL not configured",
    });
  }

  const ping = await pingDatabase(4000);
  return res.status(ping.ok ? 200 : 503).json({
    ...base,
    ok: ping.ok,
    postgresOk: ping.ok,
    latencyMs: ping.latencyMs ?? null,
    // Intentionally omit userCount / host / passwordSet on public health
    error: ping.ok ? null : "Database unavailable",
  });
}
