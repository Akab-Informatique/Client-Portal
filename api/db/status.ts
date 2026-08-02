import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDbStatus, isPostgresConfigured } from "../_lib/pg.js";

/**
 * GET /api/db/status
 *
 * Fast by default (ping only).
 * ?migrate=1 — run additive migrations + empty-DB bootstrap, then report.
 *
 * Always returns within ~25s max (timeouts inside pg helper).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Never let this handler hang the HTTP request forever
  const hardDeadlineMs = 28000;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled || res.headersSent) return;
    settled = true;
    res.status(503).json({
      mode: isPostgresConfigured() ? "postgres" : "none",
      configured: isPostgresConfigured(),
      ok: false,
      error: `DB status handler timed out after ${hardDeadlineMs}ms. Check: docker compose ps && docker compose logs --tail=80 app db`,
    });
  }, hardDeadlineMs);

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      settled = true;
      clearTimeout(timer);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const wantMigrate =
      String(req.query.migrate ?? "") === "1" ||
      String(req.query.migrate ?? "").toLowerCase() === "true";

    const status = await getDbStatus({ migrate: wantMigrate });
    if (settled || res.headersSent) return;
    settled = true;
    clearTimeout(timer);

    return res.status(200).json({
      mode: status.backend === "postgres" ? "postgres" : "none",
      configured: status.configured,
      ok: status.ok,
      host: status.host ?? null,
      database: status.database ?? null,
      migrated: status.migrated ?? false,
      seeded: status.seeded ?? false,
      userCount: status.userCount ?? null,
      error: status.error ?? null,
      config: status.config ?? null,
      hint: status.configured
        ? status.ok
          ? "PostgreSQL is ready. Portal data is shared and durable."
          : "PostgreSQL is configured but not reachable. Check POSTGRES_PASSWORD matches the volume, and db container is healthy."
        : "No POSTGRES_* / DATABASE_URL — set them in .env and restart compose.",
    });
  } catch (err) {
    if (settled || res.headersSent) return;
    settled = true;
    clearTimeout(timer);
    return res.status(500).json({
      mode: "none",
      configured: false,
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
