/**
 * AKAB Portal database client (browser).
 *
 * Production build: PostgreSQL ONLY via POST /api/db/query.
 *   PGlite is never statically imported → no WASM in the production bundle.
 * Local dev: dynamic-import PGlite when Postgres is not configured.
 *
 * Always `await dbReady` before the first query.
 */

import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import * as schema from "./schema";

export { schema };

export type DbMode = "postgres" | "pglite" | "none";

/**
 * Loose DB handle so query `.map` callbacks stay typed as needed by call sites.
 * Runtime client is either pg-proxy (prod) or PGlite (dev).
 */
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

const PROXY_SECRET =
  (import.meta.env.VITE_DB_PROXY_SECRET as string | undefined)?.trim() || "";

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
};

function formatFetchError(err: unknown, label: string): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return `${label} aborted (timeout or network). The app/API may be down or Postgres is not answering.`;
  }
  if (err instanceof Error) {
    const m = err.message || "";
    if (/abort/i.test(m) || m === "signal is aborted without reason") {
      return `${label} aborted (timeout or network). Check docker compose ps and /api/health.`;
    }
    return m;
  }
  return String(err);
}

async function fetchDbStatus(migrate: boolean): Promise<StatusPayload> {
  const controller = new AbortController();
  // Keep client waits short. Server already hard-times-out.
  const ms = migrate ? 20000 : 10000;
  const timer = window.setTimeout(() => controller.abort(), ms);
  const url = migrate ? "/api/db/status?migrate=1" : "/api/db/status";
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    let data: StatusPayload = {};
    try {
      data = (await res.json()) as StatusPayload;
    } catch {
      data = { error: `DB status returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok && !data.error) {
      data.error = `DB status HTTP ${res.status}`;
    }
    return data;
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: formatFetchError(err, migrate ? "DB migrate/status" : "DB status"),
      hint:
        'On server: docker compose ps && curl -sS -m 5 "http://127.0.0.1:3000/api/health" && curl -sS -m 10 "http://127.0.0.1:3000/api/db/status"',
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function createProxyDb(): AppDb {
  return drizzleProxy(
    async (sql, params, method) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (PROXY_SECRET) {
        headers["x-db-proxy-secret"] = PROXY_SECRET;
      }
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers,
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
  let status = await fetchDbStatus(false);

  if (!status.configured) {
    throw new Error(
      status.error ||
        "PostgreSQL is not configured. Set POSTGRES_PASSWORD in .env then: docker compose up -d --build",
    );
  }

  if (!status.ok) {
    status = await fetchDbStatus(true);
  }

  if (!status.ok) {
    throw new Error(
      [
        status.error || "PostgreSQL is not ready",
        status.hint || "",
        "On the server run:",
        "  cd /opt/akab-portal",
        "  docker compose ps",
        "  docker compose logs --tail=80 app db",
        '  curl -sS -m 8 "http://127.0.0.1:3000/api/health?db=1"',
        '  curl -sS -m 10 "http://127.0.0.1:3000/api/db/status"',
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const proxy = createProxyDb();
  await withTimeout(
    proxy.select().from(schema.users).limit(1) as unknown as Promise<unknown>,
    10000,
    "PostgreSQL query",
  );
  db = proxy;
  dbMode = "postgres";
  dbBootError = null;
  console.info(
    "[akab] Database: PostgreSQL",
    status.database || "",
    status.userCount != null ? `users=${status.userCount}` : "",
  );
}

/** Dev-only. Loaded via dynamic import — stripped from production rollup. */
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

  // Production: ALWAYS Postgres — never load PGlite
  if ((IS_PROD_BUILD || forcePostgres) && !forcePglite) {
    await initPostgres();
    return;
  }

  if (!forcePglite) {
    try {
      const status = await fetchDbStatus(false);
      if (status.configured && status.ok) {
        await initPostgres();
        return;
      }
      if (status.configured && !status.ok) {
        const s2 = await fetchDbStatus(true);
        if (s2.ok) {
          await initPostgres();
          return;
        }
      }
    } catch (err) {
      console.warn("[akab] status check failed, using PGlite", err);
    }
  }

  await initPgliteDev();
}

export const dbReady: Promise<void> = (async () => {
  try {
    await withTimeout(initDatabase(), 35000, "Database boot");
    if (!db) {
      throw new Error("Database client was not initialized");
    }
  } catch (err) {
    dbBootError = err instanceof Error ? err.message : String(err);
    dbMode = "none";
    console.error("[akab] Database boot failed:", err);
    throw err;
  }
})();
