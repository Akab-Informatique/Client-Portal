/**
 * Server-side PostgreSQL access for AKAB Portal.
 *
 * - Used when DATABASE_URL (or POSTGRES_*) is set
 * - Runs additive migrations only (CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS)
 * - Powers the browser Drizzle pg-proxy at POST /api/db/query
 *
 * Never expose this module to the browser bundle.
 */

import pg from "pg";

const { Pool } = pg;

export type DbBackend = "postgres" | "none";

let pool: pg.Pool | null = null;
let migratePromise: Promise<void> | null = null;

function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/** Build a connection string from DATABASE_URL or discrete POSTGRES_* vars. */
export function getDatabaseUrl(): string | null {
  const url = cleanEnv(process.env.DATABASE_URL);
  if (url) return url;

  const host = cleanEnv(process.env.POSTGRES_HOST);
  const db = cleanEnv(process.env.POSTGRES_DB) || cleanEnv(process.env.POSTGRES_DATABASE);
  const user = cleanEnv(process.env.POSTGRES_USER);
  const password = cleanEnv(process.env.POSTGRES_PASSWORD);
  if (!host || !db || !user) return null;

  const port = cleanEnv(process.env.POSTGRES_PORT) || "5432";
  const ssl =
    cleanEnv(process.env.POSTGRES_SSL).toLowerCase() === "true" ||
    cleanEnv(process.env.POSTGRES_SSL) === "1";
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  const base = `postgres://${auth}@${host}:${port}/${db}`;
  return ssl ? `${base}?sslmode=require` : base;
}

export function isPostgresConfigured(): boolean {
  return getDatabaseUrl() != null;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      "PostgreSQL is not configured. Set DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD.",
    );
  }

  const sslEnv = cleanEnv(process.env.POSTGRES_SSL).toLowerCase();
  const rejectUnauthorized =
    cleanEnv(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED).toLowerCase() !==
    "false";

  pool = new Pool({
    connectionString,
    max: Number(cleanEnv(process.env.PG_POOL_MAX) || "10") || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl:
      sslEnv === "true" || sslEnv === "1" || connectionString.includes("sslmode=require")
        ? { rejectUnauthorized }
        : undefined,
  });

  pool.on("error", (err) => {
    console.error("[akab-db] Unexpected PostgreSQL pool error:", err.message);
  });

  return pool;
}

/** Additive schema — safe to re-run on every boot / upgrade. Never drops data. */
const MIGRATION_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    autotask_company_id TEXT,
    dashboard_layout TEXT,
    sharepoint_site_url TEXT,
    sharepoint_folder_path TEXT,
    sharepoint_tenant_id TEXT,
    sharepoint_client_id TEXT,
    sharepoint_client_secret TEXT,
    documentation_title TEXT,
    documentation_enabled BOOLEAN,
    itglue_organization_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS staff_roles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    company_id INTEGER,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    job_title TEXT,
    phone TEXT,
    mobile TEXT,
    bio TEXT,
    locale TEXT,
    staff_role_id INTEGER,
    itglue_user_id TEXT,
    board_email_opt_in BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS board_messages (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS message_user_states (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    custom_label TEXT,
    updated_at TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Unique email (case-insensitive lookup still done in app; enforce uniqueness)
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_slug_unique ON staff_roles (slug)`,
  `CREATE INDEX IF NOT EXISTS board_messages_company_id_idx ON board_messages (company_id)`,
  `CREATE INDEX IF NOT EXISTS message_user_states_user_id_idx ON message_user_states (user_id)`,
  `CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id)`,
];

const ADDITIVE_COLUMNS: Array<{ table: string; column: string; def: string }> = [
  { table: "companies", column: "autotask_company_id", def: "TEXT" },
  { table: "companies", column: "dashboard_layout", def: "TEXT" },
  { table: "companies", column: "sharepoint_site_url", def: "TEXT" },
  { table: "companies", column: "sharepoint_folder_path", def: "TEXT" },
  { table: "companies", column: "sharepoint_tenant_id", def: "TEXT" },
  { table: "companies", column: "sharepoint_client_id", def: "TEXT" },
  { table: "companies", column: "sharepoint_client_secret", def: "TEXT" },
  { table: "companies", column: "documentation_title", def: "TEXT" },
  { table: "companies", column: "documentation_enabled", def: "BOOLEAN" },
  { table: "companies", column: "itglue_organization_id", def: "TEXT" },
  { table: "users", column: "job_title", def: "TEXT" },
  { table: "users", column: "phone", def: "TEXT" },
  { table: "users", column: "mobile", def: "TEXT" },
  { table: "users", column: "bio", def: "TEXT" },
  { table: "users", column: "locale", def: "TEXT" },
  { table: "users", column: "staff_role_id", def: "INTEGER" },
  { table: "users", column: "itglue_user_id", def: "TEXT" },
  { table: "users", column: "board_email_opt_in", def: "BOOLEAN" },
];

/**
 * Run additive migrations. Safe on every app start and every upgrade.
 * Never drops tables/columns/rows.
 */
export async function runMigrations(): Promise<void> {
  if (!isPostgresConfigured()) return;
  if (migratePromise) return migratePromise;

  migratePromise = (async () => {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      for (const sql of MIGRATION_STATEMENTS) {
        await client.query(sql);
      }
      for (const { table, column, def } of ADDITIVE_COLUMNS) {
        await client.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`,
        );
      }
      await client.query(
        `UPDATE users SET board_email_opt_in = TRUE WHERE board_email_opt_in IS NULL`,
      );
      await client.query("COMMIT");
      console.log("[akab-db] PostgreSQL migrations applied (additive, non-destructive).");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      migratePromise = null;
      throw err;
    } finally {
      client.release();
    }
  })();

  return migratePromise;
}

/**
 * Execute one query for the Drizzle pg-proxy protocol.
 * `method === "all"` → array-mode rows (string[][])
 * otherwise → object rows
 */
export async function proxyQuery(opts: {
  sql: string;
  params?: unknown[];
  method?: string;
}): Promise<unknown[] | unknown[][]> {
  await runMigrations();
  const sql = String(opts.sql || "").trim();
  if (!sql) return [];

  // Hard block multi-statement / dangerous patterns (proxy is not a full SQL console)
  if (sql.includes(";")) {
    throw new Error("Multiple SQL statements are not allowed.");
  }
  const lower = sql.toLowerCase();
  if (
    lower.includes("drop table") ||
    lower.includes("drop database") ||
    lower.includes("truncate ") ||
    lower.includes("alter system")
  ) {
    throw new Error("Destructive SQL is blocked by the portal DB proxy.");
  }

  const p = getPool();
  const method = opts.method || "all";
  const params = Array.isArray(opts.params) ? opts.params : [];

  if (method === "all") {
    const result = await p.query({
      text: sql,
      values: params,
      rowMode: "array",
    });
    return result.rows as unknown[][];
  }

  const result = await p.query({
    text: sql,
    values: params,
  });
  return result.rows as unknown[];
}

export async function getDbStatus(): Promise<{
  backend: DbBackend;
  configured: boolean;
  ok: boolean;
  error?: string;
  host?: string;
  database?: string;
  migrated?: boolean;
}> {
  if (!isPostgresConfigured()) {
    return {
      backend: "none",
      configured: false,
      ok: false,
      error:
        "DATABASE_URL not set. Portal will use browser-local PGlite (dev only).",
    };
  }

  try {
    await runMigrations();
    const p = getPool();
    const r = await p.query(
      "SELECT current_database() AS database, inet_server_addr()::text AS addr, current_user AS user",
    );
    const row = r.rows[0] as {
      database?: string;
      addr?: string | null;
      user?: string;
    };
    const url = getDatabaseUrl() || "";
    let host = "configured";
    try {
      host = new URL(url.replace(/^postgres(ql)?:/i, "http:")).hostname;
    } catch {
      /* ignore */
    }
    return {
      backend: "postgres",
      configured: true,
      ok: true,
      migrated: true,
      host,
      database: row?.database,
    };
  } catch (err) {
    return {
      backend: "postgres",
      configured: true,
      ok: false,
      error: err instanceof Error ? err.message : "Database connection failed",
    };
  }
}

/** Close pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    migratePromise = null;
  }
}
