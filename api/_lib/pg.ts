/**
 * Server-side PostgreSQL access for AKAB Portal.
 *
 * - Used when DATABASE_URL (or POSTGRES_*) is set
 * - Runs additive migrations only (CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS)
 * - Powers the browser Drizzle pg-proxy at POST /api/db/query
 * - Bootstraps admin/demo rows once on an empty database
 *
 * Never expose this module to the browser bundle.
 */

import pg from "pg";

const { Pool } = pg;

export type DbBackend = "postgres" | "none";

let pool: pg.Pool | null = null;
let migratePromise: Promise<void> | null = null;
let bootstrapPromise: Promise<{ seeded: boolean }> | null = null;
let migrateDone = false;
let bootstrapDone = false;

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

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Build a connection string.
 * Prefer discrete POSTGRES_* vars when POSTGRES_HOST is set (Docker Compose)
 * so passwords with @ # $ % etc. are URL-encoded correctly.
 */
export function getDatabaseUrl(): string | null {
  const host = cleanEnv(process.env.POSTGRES_HOST);
  const db =
    cleanEnv(process.env.POSTGRES_DB) ||
    cleanEnv(process.env.POSTGRES_DATABASE);
  const user = cleanEnv(process.env.POSTGRES_USER);
  const password = cleanEnv(process.env.POSTGRES_PASSWORD);

  if (host && db && user) {
    const port = cleanEnv(process.env.POSTGRES_PORT) || "5432";
    const ssl =
      cleanEnv(process.env.POSTGRES_SSL).toLowerCase() === "true" ||
      cleanEnv(process.env.POSTGRES_SSL) === "1";
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      : encodeURIComponent(user);
    const base = `postgres://${auth}@${host}:${port}/${encodeURIComponent(db)}`;
    return ssl ? `${base}?sslmode=require` : base;
  }

  const url = cleanEnv(process.env.DATABASE_URL);
  return url || null;
}

export function isPostgresConfigured(): boolean {
  return getDatabaseUrl() != null;
}

/** Safe diagnostics — never includes password. */
export function getDbConfigSummary(): {
  configured: boolean;
  host: string | null;
  port: string | null;
  database: string | null;
  user: string | null;
  passwordSet: boolean;
  source: "postgres_env" | "database_url" | "none";
} {
  const host = cleanEnv(process.env.POSTGRES_HOST);
  const db =
    cleanEnv(process.env.POSTGRES_DB) ||
    cleanEnv(process.env.POSTGRES_DATABASE);
  const user = cleanEnv(process.env.POSTGRES_USER);
  const password = cleanEnv(process.env.POSTGRES_PASSWORD);
  if (host && db && user) {
    return {
      configured: true,
      host,
      port: cleanEnv(process.env.POSTGRES_PORT) || "5432",
      database: db,
      user,
      passwordSet: Boolean(password),
      source: "postgres_env",
    };
  }
  const url = cleanEnv(process.env.DATABASE_URL);
  if (url) {
    try {
      const u = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
      return {
        configured: true,
        host: u.hostname || null,
        port: u.port || "5432",
        database: (u.pathname || "/").replace(/^\//, "") || null,
        user: decodeURIComponent(u.username || "") || null,
        passwordSet: Boolean(u.password),
        source: "database_url",
      };
    } catch {
      return {
        configured: true,
        host: null,
        port: null,
        database: null,
        user: null,
        passwordSet: url.includes("@"),
        source: "database_url",
      };
    }
  }
  return {
    configured: false,
    host: null,
    port: null,
    database: null,
    user: null,
    passwordSet: false,
    source: "none",
  };
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

  // Keep connect timeout short so curl / browser never hang forever
  const connectTimeout =
    Number(cleanEnv(process.env.PG_CONNECT_TIMEOUT_MS) || "3000") || 3000;

  pool = new Pool({
    connectionString,
    max: Number(cleanEnv(process.env.PG_POOL_MAX) || "10") || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: connectTimeout,
    statement_timeout: 10_000,
    query_timeout: 10_000,
    ssl:
      sslEnv === "true" ||
      sslEnv === "1" ||
      connectionString.includes("sslmode=require")
        ? { rejectUnauthorized }
        : undefined,
  });

  pool.on("error", (err) => {
    console.error("[akab-db] Unexpected PostgreSQL pool error:", err.message);
  });

  return pool;
}

/** Lightweight SELECT 1 — no migrations. Always time-bounded. */
export async function pingDatabase(timeoutMs = 4000): Promise<{
  ok: boolean;
  error?: string;
  database?: string;
  user?: string;
  latencyMs?: number;
}> {
  if (!isPostgresConfigured()) {
    return { ok: false, error: "PostgreSQL is not configured" };
  }
  const started = Date.now();
  try {
    const p = getPool();
    const r = await withTimeout(
      p.query("SELECT current_database() AS database, current_user AS user"),
      timeoutMs,
      "PostgreSQL ping",
    );
    const row = r.rows[0] as { database?: string; user?: string };
    return {
      ok: true,
      database: row?.database,
      user: row?.user,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    // Drop pool so next attempt rebuilds with fresh connections
    try {
      if (pool) {
        const old = pool;
        pool = null;
        void old.end().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Database ping failed",
      latencyMs: Date.now() - started,
    };
  }
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
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_slug_unique ON staff_roles (slug)`,
  `CREATE INDEX IF NOT EXISTS board_messages_company_id_idx ON board_messages (company_id)`,
  `CREATE INDEX IF NOT EXISTS message_user_states_user_id_idx ON message_user_states (user_id)`,
  `CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id)`,
];

const ADDITIVE_COLUMNS: Array<{ table: string; column: string; def: string }> =
  [
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

const ADMIN_PERMISSIONS_JSON = JSON.stringify({
  dashboard: true,
  clients: true,
  technicians: true,
  roles: true,
  users: true,
  messages: true,
  documentation: true,
  passwords: true,
  directory: true,
  profiles: true,
});

const TECH_PERMISSIONS_JSON = JSON.stringify({
  dashboard: true,
  clients: true,
  technicians: false,
  roles: false,
  users: true,
  messages: true,
  documentation: true,
  passwords: true,
  directory: true,
  profiles: true,
});

/**
 * Run additive migrations. Safe on every app start and every upgrade.
 * Never drops tables/columns/rows.
 */
export async function runMigrations(): Promise<void> {
  if (!isPostgresConfigured()) return;
  if (migrateDone) return;
  if (migratePromise) return migratePromise;

  migratePromise = (async () => {
    const p = getPool();
    const client = await withTimeout(
      p.connect(),
      5000,
      "PostgreSQL connect (migrate)",
    );
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
      migrateDone = true;
      console.log(
        "[akab-db] PostgreSQL migrations applied (additive, non-destructive).",
      );
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
  })().catch((err) => {
    migratePromise = null;
    throw err;
  });

  return withTimeout(migratePromise, 20000, "PostgreSQL migrations");
}

/**
 * Ensure default roles + bootstrap admin/demo accounts when the DB is empty.
 * Runs on the server so the browser does not need a long multi-query seed over the proxy.
 */
export async function ensureBootstrap(): Promise<{ seeded: boolean }> {
  if (!isPostgresConfigured()) return { seeded: false };
  if (bootstrapDone) return { seeded: false };
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    await runMigrations();
    const p = getPool();
    const client = await withTimeout(
      p.connect(),
      5000,
      "PostgreSQL connect (bootstrap)",
    );
    try {
      let adminRoleId: number | null = null;
      let techRoleId: number | null = null;

      const roles = await client.query<{ id: number; slug: string }>(
        `SELECT id, slug FROM staff_roles WHERE slug IN ('admin', 'technician')`,
      );
      for (const r of roles.rows) {
        if (r.slug === "admin") adminRoleId = r.id;
        if (r.slug === "technician") techRoleId = r.id;
      }

      if (adminRoleId == null) {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO staff_roles (name, slug, description, permissions, is_system, active)
           VALUES ('Admin', 'admin', 'Full portal access', $1, TRUE, TRUE)
           RETURNING id`,
          [ADMIN_PERMISSIONS_JSON],
        );
        adminRoleId = ins.rows[0]?.id ?? null;
      }
      if (techRoleId == null) {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO staff_roles (name, slug, description, permissions, is_system, active)
           VALUES ('Technician', 'technician', 'Day-to-day client support access', $1, TRUE, TRUE)
           RETURNING id`,
          [TECH_PERMISSIONS_JSON],
        );
        techRoleId = ins.rows[0]?.id ?? null;
      }

      const userCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM users`,
      );
      const n = Number(userCount.rows[0]?.n || "0");
      if (n > 0) {
        if (adminRoleId != null) {
          await client.query(
            `UPDATE users SET staff_role_id = $1
             WHERE role = 'admin' AND staff_role_id IS NULL`,
            [adminRoleId],
          );
        }
        if (techRoleId != null) {
          await client.query(
            `UPDATE users SET staff_role_id = $1
             WHERE role = 'technician' AND staff_role_id IS NULL`,
            [techRoleId],
          );
        }
        bootstrapDone = true;
        return { seeded: false };
      }

      console.log(
        "[akab-db] Empty database — creating bootstrap admin + demo clients",
      );

      const solu = await client.query<{ id: number }>(
        `INSERT INTO companies (name, type, email, phone, notes, active)
         VALUES ('AKAB Informatique', 'internal', 'admin@akab.local', '1-888-765-8841',
                 'Internal management company', TRUE)
         RETURNING id`,
      );
      const acme = await client.query<{ id: number }>(
        `INSERT INTO companies (name, type, email, phone, notes, autotask_company_id, active)
         VALUES ('Acme Manufacturing', 'client', 'it@acme.example', '555-0100',
                 'Demo client company', '1001', TRUE)
         RETURNING id`,
      );
      const north = await client.query<{ id: number }>(
        `INSERT INTO companies (name, type, email, phone, notes, autotask_company_id, active)
         VALUES ('Northstar Logistics', 'client', 'ops@northstar.example', '555-0200',
                 'Second demo client', '1002', TRUE)
         RETURNING id`,
      );

      const soluId = solu.rows[0].id;
      const acmeId = acme.rows[0].id;
      const northId = north.rows[0].id;

      const admin = await client.query<{ id: number; name: string }>(
        `INSERT INTO users (email, password, name, role, company_id, active, staff_role_id,
                            job_title, phone, bio, locale, board_email_opt_in)
         VALUES ('admin@akab.local', 'admin123', 'Portal Admin', 'admin', $1, TRUE, $2,
                 'Portal Administrator', '1-888-765-8841',
                 'AKAB internal administrator for the client portal.', 'en', TRUE)
         RETURNING id, name`,
        [soluId, adminRoleId],
      );
      await client.query(
        `INSERT INTO users (email, password, name, role, company_id, active, staff_role_id,
                            job_title, phone, bio, locale, board_email_opt_in)
         VALUES ('tech@akab.local', 'tech123', 'Alex Technician', 'technician', $1, TRUE, $2,
                 'Service Technician', '1-888-765-8841',
                 'Field and remote support technician at AKAB.', 'en', TRUE)`,
        [soluId, techRoleId],
      );
      await client.query(
        `INSERT INTO users (email, password, name, role, company_id, active,
                            job_title, phone, bio, locale, board_email_opt_in)
         VALUES ('client@acme.example', 'client123', 'Jordan Client', 'client', $1, TRUE,
                 'IT Coordinator', '555-0100',
                 'Primary contact for Acme Manufacturing.', 'en', TRUE)`,
        [acmeId],
      );

      const adminId = admin.rows[0].id;
      const adminName = admin.rows[0].name;
      await client.query(
        `INSERT INTO board_messages (company_id, author_id, author_name, title, body, pinned)
         VALUES
         ($1, $3, $4, 'Welcome to your AKAB portal',
          'This is your company message board. Updates from AKAB will appear here.', TRUE),
         ($2, $3, $4, 'Portal access activated',
          'Your Northstar Logistics zone is ready. Check back here for service notices.', TRUE)`,
        [acmeId, northId, adminId, adminName],
      );

      bootstrapDone = true;
      console.log(
        "[akab-db] Bootstrap complete. Login: admin@akab.local / admin123",
      );
      return { seeded: true };
    } catch (err) {
      bootstrapPromise = null;
      throw err;
    } finally {
      client.release();
    }
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return withTimeout(bootstrapPromise, 25000, "PostgreSQL bootstrap");
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
  const sql = String(opts.sql || "").trim();
  if (!sql) return [];

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
    const result = await withTimeout(
      p.query({
        text: sql,
        values: params,
        rowMode: "array",
      }),
      15000,
      "PostgreSQL query",
    );
    return result.rows as unknown[][];
  }

  const result = await withTimeout(
    p.query({
      text: sql,
      values: params,
    }),
    15000,
    "PostgreSQL query",
  );
  return result.rows as unknown[];
}

/**
 * Status check.
 * @param opts.migrate when true, run migrations + bootstrap first
 * When false (default for health), only ping — never hangs on schema work.
 */
export async function getDbStatus(opts?: { migrate?: boolean }): Promise<{
  backend: DbBackend;
  configured: boolean;
  ok: boolean;
  error?: string;
  host?: string;
  database?: string;
  migrated?: boolean;
  seeded?: boolean;
  userCount?: number;
  config?: ReturnType<typeof getDbConfigSummary>;
}> {
  const summary = getDbConfigSummary();
  if (!isPostgresConfigured()) {
    return {
      backend: "none",
      configured: false,
      ok: false,
      error:
        "DATABASE_URL / POSTGRES_* not set. Set POSTGRES_PASSWORD in .env and restart compose.",
      config: summary,
    };
  }

  try {
    let seeded = false;
    if (opts?.migrate) {
      await runMigrations();
      const boot = await ensureBootstrap();
      seeded = boot.seeded;
    } else {
      // Fast path — ping only
      const ping = await pingDatabase(4000);
      if (!ping.ok) {
        return {
          backend: "postgres",
          configured: true,
          ok: false,
          error: ping.error,
          host: summary.host || undefined,
          database: summary.database || undefined,
          config: summary,
        };
      }
      return {
        backend: "postgres",
        configured: true,
        ok: true,
        migrated: migrateDone,
        seeded: false,
        host: summary.host || undefined,
        database: ping.database || summary.database || undefined,
        config: summary,
      };
    }

    const p = getPool();
    const r = await withTimeout(
      p.query("SELECT current_database() AS database, current_user AS user"),
      5000,
      "PostgreSQL status query",
    );
    const countR = await withTimeout(
      p.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users"),
      5000,
      "PostgreSQL user count",
    );
    const row = r.rows[0] as { database?: string; user?: string };
    return {
      backend: "postgres",
      configured: true,
      ok: true,
      migrated: true,
      seeded,
      host: summary.host || undefined,
      database: row?.database,
      userCount: Number(countR.rows[0]?.n || "0"),
      config: summary,
    };
  } catch (err) {
    return {
      backend: "postgres",
      configured: true,
      ok: false,
      error: err instanceof Error ? err.message : "Database connection failed",
      host: summary.host || undefined,
      database: summary.database || undefined,
      config: summary,
    };
  }
}

/** Close pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    migratePromise = null;
    bootstrapPromise = null;
    migrateDone = false;
    bootstrapDone = false;
  }
}
