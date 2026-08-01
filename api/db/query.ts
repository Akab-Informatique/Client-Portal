import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isPostgresConfigured,
  proxyQuery,
  runMigrations,
} from "../_lib/pg.js";

/**
 * POST /api/db/query
 * Drizzle pg-proxy endpoint. Body: { sql, params, method }
 *
 * Only available when DATABASE_URL (or POSTGRES_*) is configured.
 * Same-origin browser client uses this so portal data is shared & durable.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(204).end();
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isPostgresConfigured()) {
      return res.status(503).json({
        error:
          "PostgreSQL is not configured on this server. Set DATABASE_URL in .env.",
      });
    }

    // Optional shared secret (recommended when the app is exposed beyond a trusted LAN)
    const expected = (process.env.DB_PROXY_SECRET || "").trim();
    if (expected) {
      const got =
        String(req.headers["x-db-proxy-secret"] || "").trim() ||
        String(req.headers["x-akab-db-secret"] || "").trim();
      if (got !== expected) {
        return res.status(401).json({ error: "Unauthorized DB proxy request." });
      }
    }

    await runMigrations();

    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const sql = String(body.sql ?? "");
    const params = Array.isArray(body.params) ? body.params : [];
    const method = String(body.method ?? "all");

    const rows = await proxyQuery({ sql, params, method });
    // Drizzle pg-proxy expects the raw rows array as the JSON body
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[akab-db/query]", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Database query failed",
    });
  }
}
