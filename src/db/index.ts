/**
 * AKAB Portal database client (browser).
 *
 * Dual mode:
 *  1) **PostgreSQL (production)** — when the server has DATABASE_URL / POSTGRES_*,
 *     queries go through POST /api/db/query (Drizzle pg-proxy).
 *     Server runs migrations + first-time bootstrap (admin user) before the UI loads.
 *  2) **PGlite (local demo)** — browser fallback when Postgres is not configured.
 *
 * Always `await dbReady` before the first query.
 * Boot is guarded with short timeouts so the UI never sticks on "Preparing portal…".
 */

import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

export { schema };

export type DbMode = "postgres" | "pglite";

type AnyDb = ReturnType<typeof drizzlePglite<typeof schema>>;

/** Active Drizzle client — assigned once `dbReady` resolves. */
export let db: AnyDb = null as unknown as AnyDb;

/** Which backend was selected after `dbReady`. */
export let dbMode: DbMode = "pglite";

/** Last boot error (if any) — useful for diagnostics. */
export let dbBootError: string | null = null;

const PROXY_SECRET =
  (import.meta.env.VITE_DB_PROXY_SECRET as string | undefined)?.trim() || "";

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

async function detectServerPostgres(): Promise<{
  ok: boolean;
  error?: string;
  userCount?: number;
}> {
  const forced = String(import.meta.env.VITE_DATABASE_MODE || "")
    .trim()
    .toLowerCase();
  if (forced === "pglite" || forced === "local") {
    return { ok: false };
  }

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    // migrate=1 also runs server-side bootstrap (roles + admin if empty)
    const res = await fetch("/api/db/status?migrate=1", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    window.clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `DB status HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      mode?: string;
      configured?: boolean;
      ok?: boolean;
      error?: string;
      userCount?: number;
    };
    if (
      data.mode === "postgres" &&
      data.configured === true &&
      data.ok === true
    ) {
      return { ok: true, userCount: data.userCount };
    }
    if (data.configured && !data.ok) {
      return {
        ok: false,
        error: data.error || "PostgreSQL configured but not reachable",
      };
    }
    return { ok: false };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "DB status check failed";
    console.warn("[akab] DB status check failed — using PGlite", err);
    return { ok: false, error: msg };
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
      const timer = window.setTimeout(() => controller.abort(), 15000);
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

const PGLITE_SCHEMA_SQL = `
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
`;

async function applyPgliteColumns(client: PGlite) {
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
      await client.exec(
        `ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${col}`,
      );
    } catch {
      /* already exists */
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
      /* already exists */
    }
  }
  try {
    await client.exec(
      `UPDATE users SET board_email_opt_in = TRUE WHERE board_email_opt_in IS NULL`,
    );
  } catch {
    /* ignore */
  }
}

async function createPgliteDb(dataDir?: string): Promise<AnyDb> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  // Critical: wait until WASM + backend are ready (otherwise first exec can hang)
  await client.waitReady;
  (window as unknown as { __devs_pglite?: PGlite }).__devs_pglite = client;
  await client.exec(PGLITE_SCHEMA_SQL);
  await applyPgliteColumns(client);
  return drizzlePglite(client, { schema }) as unknown as AnyDb;
}

async function initDatabase(): Promise<void> {
  const forced = String(import.meta.env.VITE_DATABASE_MODE || "")
    .trim()
    .toLowerCase();
  const forcePostgres =
    forced === "postgres" || forced === "server" || forced === "pg";

  const detected = await detectServerPostgres();

  if (detected.ok || forcePostgres) {
    try {
      const proxy = createProxyDb();
      // Fast smoke test — server already migrated + bootstrapped via /api/db/status
      await withTimeout(
        proxy.select().from(schema.users).limit(1) as unknown as Promise<unknown>,
        8000,
        "PostgreSQL proxy smoke test",
      );
      db = proxy;
      dbMode = "postgres";
      dbBootError = null;
      console.info(
        "[akab] Database mode: PostgreSQL (server, durable)",
        detected.userCount != null ? `users=${detected.userCount}` : "",
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[akab] PostgreSQL proxy failed:", msg);
      dbBootError = `PostgreSQL proxy failed: ${msg}`;
      // On a production host that advertised Postgres, do NOT silently use
      // browser PGlite (would look like "login broken" against empty local DB).
      // Still open a memory DB so the UI can render an error and Retry.
      try {
        db = await withTimeout(createPgliteDb(), 8000, "Memory PGlite fallback");
        dbMode = "pglite";
        console.warn(
          "[akab] Using temporary in-memory DB so the UI can load. Fix Postgres, then reload.",
        );
        return;
      } catch (memErr) {
        throw new Error(
          `PostgreSQL failed (${msg}) and local fallback failed (${
            memErr instanceof Error ? memErr.message : String(memErr)
          })`,
        );
      }
    }
  }

  // Local / sandbox demo path
  try {
    db = await withTimeout(
      createPgliteDb("idb://app-db"),
      12000,
      "PGlite init",
    );
    dbMode = "pglite";
    dbBootError = detected.error || null;
    console.info(
      "[akab] Database mode: PGlite (browser-local — not for multi-user production)",
    );
  } catch (err) {
    console.warn("[akab] IndexedDB PGlite failed, trying memory", err);
    db = await withTimeout(createPgliteDb(), 8000, "Memory PGlite init");
    dbMode = "pglite";
    dbBootError =
      err instanceof Error ? err.message : "PGlite IndexedDB init failed";
    console.warn("[akab] Using in-memory PGlite (data will not persist)");
  }
}

/**
 * Resolves when the DB client is ready.
 * Prefer Postgres when the server exposes a healthy database.
 * Always settles with a usable `db` when possible (never hangs forever).
 */
export const dbReady: Promise<void> = (async () => {
  try {
    await withTimeout(initDatabase(), 22000, "Database boot");
    if (!db) {
      throw new Error("Database client was not initialized");
    }
  } catch (err) {
    dbBootError = err instanceof Error ? err.message : String(err);
    console.error("[akab] Database boot failed hard:", err);
    throw err;
  }
})();
