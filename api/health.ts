import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbStatus, isPostgresConfigured } from "./_lib/pg.js";

/**
 * GET /api/health — cheap liveness for reverse proxies / docker.
 * Does not run migrations.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configured = isPostgresConfigured();
  let dbOk = false;
  let dbError: string | null = null;
  if (configured) {
    try {
      const s = await getDbStatus();
      dbOk = s.ok;
      dbError = s.error ?? null;
    } catch (err) {
      dbError = err instanceof Error ? err.message : "db error";
    }
  }

  const ok = !configured || dbOk;
  return res.status(ok ? 200 : 503).json({
    ok,
    service: "akab-portal",
    postgresConfigured: configured,
    postgresOk: dbOk,
    error: dbError,
    ts: new Date().toISOString(),
  });
}
