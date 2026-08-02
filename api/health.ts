import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getDbConfigSummary,
  isPostgresConfigured,
  pingDatabase,
} from "./_lib/pg.js";

/**
 * GET /api/health — always returns quickly.
 * - Without ?db=1: process liveness only (for Docker HEALTHCHECK)
 * - With ?db=1: also pings Postgres (SELECT 1 style), max ~4s
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wantDb =
    String(req.query.db ?? "") === "1" ||
    String(req.query.db ?? "").toLowerCase() === "true";

  const configured = isPostgresConfigured();
  const config = getDbConfigSummary();

  if (!wantDb) {
    return res.status(200).json({
      ok: true,
      service: "akab-portal",
      postgresConfigured: configured,
      config: {
        host: config.host,
        database: config.database,
        user: config.user,
        passwordSet: config.passwordSet,
        source: config.source,
      },
      ts: new Date().toISOString(),
    });
  }

  if (!configured) {
    return res.status(503).json({
      ok: false,
      service: "akab-portal",
      postgresConfigured: false,
      postgresOk: false,
      error: "POSTGRES_* / DATABASE_URL not set",
      config,
      ts: new Date().toISOString(),
    });
  }

  const ping = await pingDatabase(4000);
  return res.status(ping.ok ? 200 : 503).json({
    ok: ping.ok,
    service: "akab-portal",
    postgresConfigured: true,
    postgresOk: ping.ok,
    database: ping.database ?? null,
    error: ping.error ?? null,
    latencyMs: ping.latencyMs ?? null,
    config: {
      host: config.host,
      database: config.database,
      user: config.user,
      passwordSet: config.passwordSet,
      source: config.source,
    },
    ts: new Date().toISOString(),
  });
}
