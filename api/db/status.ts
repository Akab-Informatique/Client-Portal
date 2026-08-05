import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureBootstrap,
  getDbConfigSummary,
  isPostgresConfigured,
  pingDatabase,
  runMigrations,
} from "../_lib/pg.js";

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
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
 * Always time-bounded — never hangs curl or the browser.
 *
 * Default: fast ping only (~8s max).
 * ?migrate=1: migrations + bootstrap first (~25s max), then ping.
 *
 * Important: do NOT call getDbStatus() here — it could re-enter migrate
 * without a deadline and hang the HTTP response.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

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

    // Single timed ping — includes user count when tables exist
    const ping = await withDeadline(pingDatabase(7000), 8000, "status ping");

    // Lightweight schema probe so ops can confirm critical upgrades landed
    let schemaFlags: Record<string, boolean> | null = null;
    if (ping.ok && isPostgresConfigured()) {
      try {
        const pool = getPool();
        const r = await withDeadline(
          pool.query(
            `SELECT
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='client_roles'
                   AND column_name='company_id'
               ) AS client_roles_company_id,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='users'
                   AND column_name='client_role_id'
               ) AS users_client_role_id,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='users'
                   AND column_name='billing_access'
               ) AS users_billing_access`,
          ),
          4000,
          "schema flags",
        );
        const row = (r.rows[0] ?? {}) as Record<string, boolean>;
        schemaFlags = {
          client_roles_company_id: !!row.client_roles_company_id,
          users_client_role_id: !!row.users_client_role_id,
          users_billing_access: !!row.users_billing_access,
        };
      } catch {
        schemaFlags = null;
      }
    }

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
        schema: schemaFlags,
        error: ping.error || "Database not reachable",
        hint:
          'docker compose ps && docker compose logs --tail=80 app db && curl -sS -m 8 "http://127.0.0.1:3000/api/health?db=1"',
      });
    }

    const schemaOk =
      !schemaFlags ||
      (schemaFlags.client_roles_company_id &&
        schemaFlags.users_client_role_id);

    return res.status(200).json({
      mode: "postgres",
      configured: true,
      ok: schemaOk,
      host: summary.host,
      database: ping.database ?? summary.database,
      passwordSet: summary.passwordSet,
      source: summary.source,
      migrated: wantMigrate,
      seeded: true,
      userCount: ping.userCount ?? null,
      schema: schemaFlags,
      error: schemaOk
        ? null
        : "Database reachable but schema incomplete (missing client_roles.company_id). Run ?migrate=1 after rebuild.",
      latencyMs: ping.latencyMs ?? null,
      hint: schemaOk
        ? "PostgreSQL is ready. Portal data is shared and durable."
        : 'curl -sS -m 30 "http://127.0.0.1:3000/api/db/status?migrate=1"',
    });
  } catch (err) {
    return res.status(200).json({
      mode: "postgres",
      configured: isPostgresConfigured(),
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
      hint: "docker compose logs --tail=100 app db",
    });
  }
}
