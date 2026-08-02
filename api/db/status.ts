import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureBootstrap,
  getDbConfigSummary,
  getDbStatus,
  isPostgresConfigured,
  pingDatabase,
  runMigrations,
} from "../_lib/pg.js";

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * GET /api/db/status
 * Fast by default (ping only).
 * ?migrate=1 — also run additive migrations + empty-DB bootstrap (bounded).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Never let this handler hang the client/curl forever
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const summary = getDbConfigSummary();
    const wantMigrate =
      String(req.query.migrate ?? "") === "1" ||
      String(req.query.migrate ?? "").toLowerCase() === "true";

    if (!summary.configured) {
      return res.status(200).json({
        mode: "none",
        configured: false,
        ok: false,
        host: null,
        database: null,
        migrated: false,
        seeded: false,
        userCount: null,
        passwordSet: false,
        source: "none",
        error:
          "POSTGRES_* not set. In Docker Compose set POSTGRES_PASSWORD in .env",
        hint: "Edit /opt/akab-portal/.env then: docker compose up -d --build",
      });
    }

    if (wantMigrate && isPostgresConfigured()) {
      try {
        await withDeadline(
          (async () => {
            await runMigrations();
            await ensureBootstrap();
          })(),
          25000,
          "migrate+bootstrap",
        );
      } catch (err) {
        return res.status(200).json({
          mode: "postgres",
          configured: true,
          ok: false,
          host: summary.host,
          database: summary.database,
          passwordSet: summary.passwordSet,
          source: summary.source,
          migrated: false,
          seeded: false,
          userCount: null,
          error:
            err instanceof Error ? err.message : "Migration/bootstrap failed",
          hint:
            "Check: docker compose logs app db | Verify POSTGRES_PASSWORD matches the volume",
        });
      }
    }

    // Prefer fast ping; fall back to full status
    const ping = await withDeadline(pingDatabase(), 8000, "status ping");
    if (!ping.ok) {
      return res.status(200).json({
        mode: "postgres",
        configured: true,
        ok: false,
        host: summary.host,
        database: summary.database,
        passwordSet: summary.passwordSet,
        source: summary.source,
        migrated: false,
        seeded: false,
        userCount: null,
        error: ping.error || "Database not reachable",
        hint:
          "docker compose ps && docker compose logs --tail=80 app db && verify POSTGRES_PASSWORD",
      });
    }

    const status = await getDbStatus();
    return res.status(200).json({
      mode: "postgres",
      configured: true,
      ok: true,
      host: summary.host,
      database: status.database ?? summary.database,
      passwordSet: summary.passwordSet,
      source: summary.source,
      migrated: status.migrated ?? false,
      seeded: status.seeded ?? false,
      userCount: status.userCount ?? ping.userCount ?? null,
      error: null,
      hint: "PostgreSQL is ready. Portal data is shared and durable.",
    });
  } catch (err) {
    return res.status(200).json({
      mode: "none",
      configured: isPostgresConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
      hint: "docker compose logs --tail=100 app",
    });
  }
}
