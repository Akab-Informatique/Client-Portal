/**
 * AKAB Portal database client (browser).
 *
 * Production build: PostgreSQL ONLY via POST /api/db/query (never PGlite).
 * Local dev: PGlite when the server has no Postgres configured.
 *
 * Always `await dbReady` before the first query.
 */

import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

export { schema };

export type DbMode = "postgres" | "pglite" | "none";

/** Use PGlite's typed client shape so app query callbacks stay typed. */
type AnyDb = ReturnType<typeof drizzlePglite<typeof schema>>;

/** Active Drizzle client — assigned once `dbReady` resolves. */
export let db: AnyDb = null as unknown as AnyDb;

/** Which backend was selected after `dbReady`. */
export let dbMode: DbMode = "none";

/** Last boot error (if any) — shown in the UI. */
export let dbBootError: string | null = null;

const PROXY_SECRET =
  (import.meta.env.VITE_DB_PROXY_SECRET as string | undefined)?.trim() || "";

/** Built production bundle — never boot browser PGlite on a real deploy. */
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
};

async function fetchDbStatus(): Promise<StatusPayload> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("/api/db/status?migrate=1", {
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
  } finally {
    window.clearTimeout(timer);
  }
}

function createProxyDb(): AnyDb {
  const client = drizzleProxy(
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
  return client as unknown as AnyDb;
}

async function initPostgres(status: StatusPayload): Promise<void> {
  if (!status.ok) {
    throw new Error(
      status.error ||
        status.hint ||
        "PostgreSQL is not ready. On the server: docker compose logs app db && curl -s localhost:3000/api/db/status?migrate=1",
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

async function createPgliteDb(dataDir?: string): Promise<AnyDb> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await withTimeout(Promise.resolve(client.waitReady), 10000, "PGlite waitReady");
  (window as unknown as { __devs_pglite?: PGlite }).__devs_pglite = client;

  await client.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  email TEXT, phone TEXT, notes TEXT, active BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_roles (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
  description TEXT, permissions TEXT NOT NULL, is_system BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT NOT NULL, password TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL, company_id INTEGER, active BOOLEAN NOT NULL,
  job_title TEXT, phone TEXT, mobile TEXT, bio TEXT, locale TEXT,
  staff_role_id INTEGER, itglue_user_id TEXT, board_email_opt_in BOOLEAN,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS board_messages (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS message_user_states (
  id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  status TEXT NOT NULL, custom_label TEXT, updated_at TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
`);
  for (const col of [
    "autotask_company_id TEXT",
    "dashboard_layout TEXT",
    "sharepoint_site_url TEXT",
    "sharepoint_folder_path TEXT",
    "sharepoint_tenant_id TEXT",
    "sharepoint_client_id TEXT",
    "sharepoint_client_secret TEXT",
    "documentation_title TEXT",
    "documentation_enabled BOOLEAN",
    "itglue_organization_id TEXT",
  ]) {
    try {
      await client.exec(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${col}`);
    } catch {
      /* exists */
    }
  }
  for (const col of [
    "job_title TEXT",
    "phone TEXT",
    "mobile TEXT",
    "bio TEXT",
    "locale TEXT",
    "staff_role_id INTEGER",
    "itglue_user_id TEXT",
    "board_email_opt_in BOOLEAN",
  ]) {
    try {
      await client.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`);
    } catch {
      /* exists */
    }
  }
  return drizzlePglite(client, { schema }) as unknown as AnyDb;
}

async function initDatabase(): Promise<void> {
  const forced = String(import.meta.env.VITE_DATABASE_MODE || "")
    .trim()
    .toLowerCase();
  const forcePglite = forced === "pglite" || forced === "local";
  const forcePostgres =
    forced === "postgres" || forced === "server" || forced === "pg";

  // Production build: ALWAYS Postgres. Never touch PGlite (avoids WASM hangs).
  if ((IS_PROD_BUILD || forcePostgres) && !forcePglite) {
    let status: StatusPayload;
    try {
      status = await fetchDbStatus();
    } catch (err) {
      throw new Error(
        `Cannot reach /api/db/status: ${
          err instanceof Error ? err.message : String(err)
        }. Is the app container running? docker compose ps && docker compose logs app`,
      );
    }

    if (!status.configured) {
      throw new Error(
        "PostgreSQL is not configured on the server. Set POSTGRES_PASSWORD in /opt/akab-portal/.env then: docker compose up -d --build",
      );
    }

    await initPostgres(status);
    return;
  }

  // Dev / sandbox: try Postgres if healthy, else PGlite
  if (!forcePglite) {
    try {
      const status = await fetchDbStatus();
      if (status.configured && status.ok) {
        await initPostgres(status);
        return;
      }
    } catch (err) {
      console.warn("[akab] status check failed, using PGlite", err);
    }
  }

  try {
    db = await withTimeout(createPgliteDb("idb://app-db"), 12000, "PGlite init");
  } catch (err) {
    console.warn("[akab] IndexedDB PGlite failed, trying memory", err);
    db = await withTimeout(createPgliteDb(), 8000, "Memory PGlite init");
  }
  dbMode = "pglite";
  console.info("[akab] Database: PGlite (local demo only)");
}

/**
 * Resolves when the DB client is ready.
 * Production never falls back to PGlite — failures surface as dbBootError.
 */
export const dbReady: Promise<void> = (async () => {
  try {
    await withTimeout(initDatabase(), 25000, "Database boot");
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
