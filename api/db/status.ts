import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbStatus, isPostgresConfigured, runMigrations } from "../_lib/pg.js";

/**
 * GET /api/db/status
 * Reports whether the server has PostgreSQL configured and reachable.
 * Used by the browser client to choose Postgres proxy vs local PGlite.
 *
 * Query: ?migrate=1 — run additive migrations before checking
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const wantMigrate =
      String(req.query.migrate ?? "") === "1" ||
      String(req.query.migrate ?? "").toLowerCase() === "true";

    if (wantMigrate && isPostgresConfigured()) {
      try {
        await runMigrations();
      } catch (err) {
        return res.status(500).json({
          mode: "postgres",
          configured: true,
          ok: false,
          error:
            err instanceof Error ? err.message : "Migration failed",
        });
      }
    }

    const status = await getDbStatus();
    return res.status(200).json({
      mode: status.backend === "postgres" ? "postgres" : "none",
      configured: status.configured,
      ok: status.ok,
      host: status.host ?? null,
      database: status.database ?? null,
      migrated: status.migrated ?? false,
      error: status.error ?? null,
      // Hint for the UI — never include credentials
      hint: status.configured
        ? status.ok
          ? "PostgreSQL is ready. Portal data is shared and durable."
          : "PostgreSQL is configured but not reachable. Check DATABASE_URL and that Postgres is running."
        : "No DATABASE_URL — browser will use local PGlite (single-browser demo mode).",
    });
  } catch (err) {
    return res.status(500).json({
      mode: "none",
      configured: false,
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
