import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureBootstrap,
  getDbConfigSummary,
  getPool,
  isPostgresConfigured,
  pingDatabase,
  runMigrations,
} from "../_lib/pg.js";
import { getRequestSessionUserId, readSession } from "../_lib/session.js";
import { loadUserById } from "../_lib/auth-server.js";

async function isStaffSession(req: VercelRequest): Promise<boolean> {
  try {
    const uid = getRequestSessionUserId(req);
    if (uid == null || !readSession(req)) return false;
    const user = await loadUserById(uid);
    return Boolean(user && user.active && user.role !== "client");
  } catch {
    return false;
  }
}

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
 * Public: ok/configured/userCount only.
 * Staff session or ?migrate=1 (ops): host/schema details for deploy scripts.
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
    const staff = await isStaffSession(req);
    // Host/schema diagnostics: staff session, or migrate=1 only from loopback
    // (upgrade.sh on the server). Remote anonymous callers never see topology.
    const headers = req.headers || {};
    const fwd = headers["x-forwarded-for"];
    const fwdStr = Array.isArray(fwd) ? fwd[0] : String(fwd || "");
    const realIp = headers["x-real-ip"];
    const realStr = Array.isArray(realIp) ? realIp[0] : String(realIp || "");
    const sock = (req as { socket?: { remoteAddress?: string } }).socket;
    const remote =
      fwdStr.split(",")[0]?.trim() || realStr.trim() || String(sock?.remoteAddress || "");
    const isLoopback =
      !remote ||
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === ":ffff:127.0.0.1" ||
      remote.endsWith("127.0.0.1");
    const revealDiag = staff || (wantMigrate && isLoopback);

    if (!summary.configured) {
      return res.status(200).json({
        mode: "none",
        configured: false,
        ok: false,
        error: "Database not configured",
        hint: "Set POSTGRES_* in .env then: docker compose up -d --build",
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
        console.error("[db/status migrate]", err);
        return res.status(200).json({
          mode: "postgres",
          configured: true,
          ok: false,
          migrated: false,
          error: "Migration/bootstrap failed",
          hint: "docker compose logs --tail=80 app db",
          ...(revealDiag
            ? {
                host: summary.host,
                database: summary.database,
                passwordSet: summary.passwordSet,
              }
            : {}),
        });
      }
    }

    const ping = await withDeadline(pingDatabase(7000), 8000, "status ping");

    let schemaFlags: Record<string, boolean> | null = null;
    if (ping.ok && isPostgresConfigured() && revealDiag) {
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
                 SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='client_user_roles'
               ) AS client_user_roles,
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
          client_user_roles: !!row.client_user_roles,
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
        userCount: null,
        error: "Database not reachable",
        ...(revealDiag
          ? {
              host: summary.host,
              database: summary.database,
              passwordSet: summary.passwordSet,
              schema: schemaFlags,
              hint: "docker compose ps && docker compose logs --tail=80 app db",
            }
          : {}),
      });
    }

    const schemaOk =
      !schemaFlags ||
      (schemaFlags.client_roles_company_id &&
        schemaFlags.client_user_roles &&
        schemaFlags.users_client_role_id);

    return res.status(200).json({
      mode: "postgres",
      configured: true,
      ok: schemaOk,
      userCount: ping.userCount ?? null,
      latencyMs: ping.latencyMs ?? null,
      migrated: wantMigrate,
      error: schemaOk
        ? null
        : "Database reachable but schema incomplete. Rebuild app, then run ?migrate=1.",
      ...(revealDiag
        ? {
            host: summary.host,
            database: ping.database ?? summary.database,
            passwordSet: summary.passwordSet,
            source: summary.source,
            schema: schemaFlags,
            seeded: true,
            hint: schemaOk
              ? "PostgreSQL is ready."
              : 'curl -sS -m 45 "http://127.0.0.1:3000/api/db/status?migrate=1"',
          }
        : {}),
    });
  } catch (err) {
    console.error("[db/status]", err);
    return res.status(200).json({
      mode: "postgres",
      configured: isPostgresConfigured(),
      ok: false,
      error: "Server error",
    });
  }
}
