/**
 * AKAB Portal database client (browser).
 *
 * Production: PostgreSQL ONLY via POST /api/db/query.
 * Boot checks /api/db/ping (native Node handler — never hangs on tsx).
 * Local dev: dynamic-import PGlite when Postgres is not configured.
 */

import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import * as schema from "./schema";

export { schema };

export type DbMode = "postgres" | "pglite" | "none";

export type AppDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: (...args: any[]) => any;
};

export let db: AppDb = null as unknown as AppDb;
export let dbMode: DbMode = "none";
export let dbBootError: string | null = null;

const IS_PROD_BUILD = import.meta.env.PROD === true;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type StatusPayload = {
  mode?: string;
  configured?: boolean;
  ok?: boolean;
  error?: string;
  userCount?: number | null;
  host?: string | null;
  database?: string | null;
  hint?: string | null;
  passwordSet?: boolean;
  native?: boolean;
  latencyMs?: number | null;
};

function formatFetchError(err: unknown, label: string): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return `${label} timed out. App container may be down.`;
  }
  if (err instanceof Error) {
    const m = err.message || "";
    if (/abort/i.test(m)) return `${label} timed out. Check docker compose ps.`;
    return m;
  }
  return String(err);
}

/**
 * Prefer native /api/db/ping (no TypeScript, no migrate) — answers in <1s when healthy.
 * Falls back to /api/health?db=1, then /api/db/status.
 */
async function fetchDbReady(): Promise<StatusPayload> {
  const paths = ["/api/db/ping", "/api/health?db=1", "/api/db/status"];

  let last: StatusPayload = {
    configured: false,
    ok: false,
    error: "No response from server",
  };

  for (const path of paths) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(path, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      let data: Record<string, unknown> = {};
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        last = { ok: false, error: `${path} returned non-JSON (HTTP ${res.status})` };
        continue;
      }

      // Normalize health?db=1 shape → status shape
      if (path.includes("/api/health")) {
        const configured = Boolean(data.postgresConfigured);
        const ok = Boolean(data.postgresOk ?? data.ok) && configured;
        last = {
          mode: configured ? "postgres" : "none",
          configured,
          ok,
          host: (data.postgresHost as string) ?? null,
          database: (data.database as string) ?? (data.postgresDb as string) ?? null,
          userCount: (data.userCount as number) ?? null,
          passwordSet: Boolean(data.passwordSet),
          error: (data.error as string) ?? null,
          latencyMs: (data.latencyMs as number) ?? null,
          native: Boolean(data.native),
          hint: ok
            ? "PostgreSQL is ready."
            : "docker compose logs --tail=80 app db",
        };
      } else {
        last = {
          mode: (data.mode as string) ?? "postgres",
          configured: data.configured !== false,
          ok: Boolean(data.ok),
          host: (data.host as string) ?? null,
          database: (data.database as string) ?? null,
          userCount: (data.userCount as number) ?? null,
          passwordSet: Boolean(data.passwordSet),
          error: (data.error as string) ?? null,
          hint: (data.hint as string) ?? null,
          latencyMs: (data.latencyMs as number) ?? null,
          native: Boolean(data.native),
        };
      }

      // Success or definitive config error — stop
      if (last.ok || last.configured === false) return last;
      // Definitive DB error from native path — stop (don't cascade timeouts)
      if (last.native && last.error) return last;
    } catch (err) {
      last = {
        configured: true,
        ok: false,
        error: formatFetchError(err, path),
        hint: 'curl -sS -m 5 "http://127.0.0.1:3000/api/health" && curl -sS -m 5 "http://127.0.0.1:3000/api/db/ping"',
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  return last;
}

function createProxyDb(): AppDb {
  return drizzleProxy(
    async (sql, params, method) => {
      // Auth is the HttpOnly session cookie only — never a VITE_ secret.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({ sql, params, method }),
          signal: controller.signal,
        });
        if (!res.ok) {
          let message = `Database error (${res.status})`;
          try {
            const errBody = (await res.json()) as { error?: string };
            if (errBody?.error) message = errBody.error;
          } catch {
            /* ignore */
          }
          throw new Error(message);
        }
        const rows = await res.json();
        return { rows: rows ?? [] };
      } finally {
        window.clearTimeout(timer);
      }
    },
    { schema },
  );
}

async function initPostgres(): Promise<void> {
  const status = await fetchDbReady();

  if (!status.configured) {
    throw new Error(
      status.error ||
        "PostgreSQL is not configured. Set POSTGRES_PASSWORD in .env then: docker compose up -d --build",
    );
  }

  if (!status.ok) {
    throw new Error(
      [
        status.error || "PostgreSQL is not ready",
        status.hint || "",
        "",
        "On the Ubuntu server run:",
        "  cd /opt/akab-portal",
        "  docker compose ps",
        "  docker compose logs --tail=80 app db",
        '  curl -sS -m 5  "http://127.0.0.1:3000/api/health"',
        '  curl -sS -m 5  "http://127.0.0.1:3000/api/db/ping"',
        '  curl -sS -m 8  "http://127.0.0.1:3000/api/health?db=1"',
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
    );
  }

  // Do NOT smoke-test via /api/db/query here — that endpoint requires an
  // authenticated MFA session. Public /api/db/ping (above) already proved
  // Postgres is reachable. Real queries run after login with credentials: "same-origin".
  db = createProxyDb();
  dbMode = "postgres";
  dbBootError = null;
  console.info(
    "[akab] Database: PostgreSQL",
    status.database || "",
    status.userCount != null ? `users=${status.userCount}` : "",
    status.native ? "(native ping)" : "",
  );
}

async function initPgliteDev(): Promise<void> {
  const { openPglite } = await import("./pglite-dev");
  try {
    db = await withTimeout(openPglite("idb://app-db"), 12000, "PGlite init");
  } catch (err) {
    console.warn("[akab] IndexedDB PGlite failed, trying memory", err);
    db = await withTimeout(openPglite(), 8000, "Memory PGlite init");
  }
  dbMode = "pglite";
  console.info("[akab] Database: PGlite (local demo only)");
}

async function initDatabase(): Promise<void> {
  const forced = String(import.meta.env.VITE_DATABASE_MODE || "")
    .trim()
    .toLowerCase();
  const forcePglite = forced === "pglite" || forced === "local";
  const forcePostgres =
    forced === "postgres" || forced === "server" || forced === "pg";

  if ((IS_PROD_BUILD || forcePostgres) && !forcePglite) {
    await initPostgres();
    return;
  }

  if (!forcePglite) {
    try {
      const status = await fetchDbReady();
      if (status.configured && status.ok) {
        await initPostgres();
        return;
      }
    } catch (err) {
      console.warn("[akab] status check failed, using PGlite", err);
    }
  }

  await initPgliteDev();
}

export const dbReady: Promise<void> = (async () => {
  try {
    await withTimeout(initDatabase(), 25000, "Database boot");
    if (!db) throw new Error("Database client was not initialized");
  } catch (err) {
    dbBootError = err instanceof Error ? err.message : String(err);
    dbMode = "none";
    console.error("[akab] Database boot failed:", err);
    throw err;
  }
})();
