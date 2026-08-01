/**
 * AKAB Portal database client (browser).
 *
 * Dual mode:
 *  1) **PostgreSQL (production)** — when the server has DATABASE_URL,
 *     queries go through POST /api/db/query (Drizzle pg-proxy).
 *     Data is shared across all users and survives app upgrades.
 *  2) **PGlite (local demo)** — browser IndexedDB. Fine for single-operator
 *     development only; not multi-user production.
 *
 * Always `await dbReady` before the first query.
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

const PROXY_SECRET = (import.meta.env.VITE_DB_PROXY_SECRET as string | undefined)?.trim() || "";

async function detectServerPostgres(): Promise<boolean> {
  const forced = String(import.meta.env.VITE_DATABASE_MODE || "")
    .trim()
    .toLowerCase();
  if (forced === "pglite" || forced === "local") return false;
  if (forced === "postgres" || forced === "server" || forced === "pg") {
    return true;
  }

  try {
    const res = await fetch("/api/db/status?migrate=1", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      mode?: string;
      configured?: boolean;
      ok?: boolean;
    };
    return data.mode === "postgres" && data.configured === true && data.ok === true;
  } catch {
    return false;
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
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ sql, params, method }),
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
    },
    { schema },
  );
  return client as unknown as AnyDb;
}

async function createPgliteDb(): Promise<AnyDb> {
  const client = new PGlite("idb://app-db");
  (window as unknown as { __devs_pglite?: PGlite }).__devs_pglite = client;
  const d = drizzlePglite(client, { schema });

  await client.exec(
    `CREATE TABLE IF NOT EXISTS companies (id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT, active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  );
  await client.exec(
    `CREATE TABLE IF NOT EXISTS staff_roles (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL, is_system BOOLEAN NOT NULL, active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  );
  await client.exec(
    `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, company_id INTEGER, active BOOLEAN NOT NULL, job_title TEXT, phone TEXT, mobile TEXT, bio TEXT, locale TEXT, staff_role_id INTEGER, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  );
  await client.exec(
    `CREATE TABLE IF NOT EXISTS board_messages (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, author_id INTEGER NOT NULL, author_name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, pinned BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  );
  await client.exec(
    `CREATE TABLE IF NOT EXISTS message_user_states (id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL, custom_label TEXT, updated_at TEXT, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  );

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

  return d as unknown as AnyDb;
}

/**
 * Resolves when the DB client is ready.
 * Prefer Postgres when the server exposes a healthy DATABASE_URL.
 */
export const dbReady: Promise<void> = (async () => {
  const usePostgres = await detectServerPostgres();
  if (usePostgres) {
    try {
      db = createProxyDb();
      dbMode = "postgres";
      // Smoke-test: list tables via a trivial select through proxy
      await db.select().from(schema.staff_roles).limit(1);
      console.info("[akab] Database mode: PostgreSQL (server, durable)");
      return;
    } catch (err) {
      console.warn(
        "[akab] PostgreSQL proxy failed — falling back to local PGlite.",
        err,
      );
    }
  }

  db = await createPgliteDb();
  dbMode = "pglite";
  console.info(
    "[akab] Database mode: PGlite (browser-local — not for multi-user production)",
  );
})();
