/**
 * Server-side PostgreSQL for AKAB Portal (production).
 *
 * Uses discrete host/user/password (never a fragile URL with special chars).
 * Additive migrations only. Empty-DB bootstrap once.
 * Hard timeouts so HTTP handlers never hang forever.
 *
 * Never import this from the browser bundle.
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
  // Docker Compose often leaves empty DATABASE_URL as ""
  if (!v) return "";
  return v;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type PgConnConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  source: "postgres_env" | "database_url";
};

/**
 * Resolve connection from POSTGRES_* (preferred) or DATABASE_URL.
 * Discrete env vars avoid password URL-encoding bugs.
 */
export function resolvePgConfig(): PgConnConfig | null {
  const host = cleanEnv(process.env.POSTGRES_HOST);
  const database =
    cleanEnv(process.env.POSTGRES_DB) ||
    cleanEnv(process.env.POSTGRES_DATABASE);
  const user = cleanEnv(process.env.POSTGRES_USER);
  const password = cleanEnv(process.env.POSTGRES_PASSWORD);

  if (host && database && user) {
    return {
      host,
      port: Number(cleanEnv(process.env.POSTGRES_PORT) || "5432") || 5432,
      database,
      user,
      password,
      ssl:
        cleanEnv(process.env.POSTGRES_SSL).toLowerCase() === "true" ||
        cleanEnv(process.env.POSTGRES_SSL) === "1",
      source: "postgres_env",
    };
  }

  const url = cleanEnv(process.env.DATABASE_URL);
  if (!url) return null;

  try {
    // Normalize postgres:// → http:// for URL parser
    const u = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
    return {
      host: u.hostname || "127.0.0.1",
      port: Number(u.port || "5432") || 5432,
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || "postgres"),
      user: decodeURIComponent(u.username || "postgres"),
      password: decodeURIComponent(u.password || ""),
      ssl:
        u.searchParams.get("sslmode") === "require" ||
        cleanEnv(process.env.POSTGRES_SSL).toLowerCase() === "true",
      source: "database_url",
    };
  } catch {
    return null;
  }
}

/** @deprecated use resolvePgConfig — kept for older callers */
export function getDatabaseUrl(): string | null {
  const c = resolvePgConfig();
  if (!c) return null;
  const auth = c.password
    ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`
    : encodeURIComponent(c.user);
  const base = `postgres://${auth}@${c.host}:${c.port}/${encodeURIComponent(c.database)}`;
  return c.ssl ? `${base}?sslmode=require` : base;
}

export function isPostgresConfigured(): boolean {
  return resolvePgConfig() != null;
}

export function getDbConfigSummary(): {
  configured: boolean;
  host: string | null;
  port: string | null;
  database: string | null;
  user: string | null;
  passwordSet: boolean;
  source: "postgres_env" | "database_url" | "none";
} {
  const c = resolvePgConfig();
  if (!c) {
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
  return {
    configured: true,
    host: c.host,
    port: String(c.port),
    database: c.database,
    user: c.user,
    passwordSet: Boolean(c.password),
    source: c.source,
  };
}

export function resetPool(): void {
  if (pool) {
    const old = pool;
    pool = null;
    void old.end().catch(() => undefined);
  }
  migratePromise = null;
  bootstrapPromise = null;
  migrateDone = false;
  bootstrapDone = false;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const c = resolvePgConfig();
  if (!c) {
    throw new Error(
      "PostgreSQL is not configured. Set POSTGRES_HOST, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD (Docker Compose sets these automatically).",
    );
  }

  const rejectUnauthorized =
    cleanEnv(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED).toLowerCase() !==
    "false";

  // Discrete config — never build a URL (fixes special-char passwords)
  pool = new Pool({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    max: Number(cleanEnv(process.env.PG_POOL_MAX) || "10") || 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis:
      Number(cleanEnv(process.env.PG_CONNECT_TIMEOUT_MS) || "4000") || 4000,
    statement_timeout:
      Number(cleanEnv(process.env.PG_STATEMENT_TIMEOUT_MS) || "15000") || 15000,
    ssl: c.ssl ? { rejectUnauthorized } : undefined,
  });

  pool.on("error", (err) => {
    console.error("[akab-db] pool error:", err.message);
  });

  return pool;
}

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
    datto_rmm_site_uid TEXT,
    datto_rmm_site_name TEXT,
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
  `CREATE TABLE IF NOT EXISTS client_roles (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Multi-role membership: Default core + additional additive groups per user
  `CREATE TABLE IF NOT EXISTS client_user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
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
    client_role_id INTEGER,
    billing_access BOOLEAN,
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
  `CREATE TABLE IF NOT EXISTS sos_requests (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    company_name TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    issue TEXT,
    status TEXT NOT NULL,
    splashtop_session_id TEXT,
    sos_code TEXT,
    support_portal_link TEXT,
    channel_id TEXT,
    error_message TEXT,
    expires_at TEXT,
    closed_at TEXT,
    closed_by_user_id INTEGER,
    last_polled_at TEXT,
    remote_snapshot TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`,
  `CREATE INDEX IF NOT EXISTS sos_requests_status_idx ON sos_requests (status)`,
  `CREATE INDEX IF NOT EXISTS sos_requests_user_id_idx ON sos_requests (user_id)`,
  `CREATE INDEX IF NOT EXISTS sos_requests_company_id_idx ON sos_requests (company_id)`,
  `CREATE INDEX IF NOT EXISTS sos_requests_created_at_idx ON sos_requests (created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_slug_unique ON staff_roles (slug)`,
  // NOTE: client_roles (company_id, slug) indexes are ONLY in POST_ALTER_INDEXES.
  // On upgraded DBs company_id is added in phase 2 — creating them here aborts migrate.
  `CREATE INDEX IF NOT EXISTS board_messages_company_id_idx ON board_messages (company_id)`,
  `CREATE INDEX IF NOT EXISTS message_user_states_user_id_idx ON message_user_states (user_id)`,
  `CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id)`,
];

/**
 * Indexes that depend on additive columns. MUST run AFTER ADDITIVE_COLUMNS.
 * Creating users_client_role_id_idx before client_role_id exists on upgraded
 * DBs aborted the whole migrate transaction and left columns missing.
 */
const POST_ALTER_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS users_client_role_id_idx ON users (client_role_id)`,
  `CREATE INDEX IF NOT EXISTS users_staff_role_id_idx ON users (staff_role_id)`,
  // Existing DBs: company_id added in phase 2 — create composite unique after that
  `CREATE UNIQUE INDEX IF NOT EXISTS client_roles_company_slug_unique ON client_roles (company_id, slug)`,
  `CREATE INDEX IF NOT EXISTS client_roles_company_id_idx ON client_roles (company_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS client_user_roles_user_role_unique ON client_user_roles (user_id, role_id)`,
  `CREATE INDEX IF NOT EXISTS client_user_roles_user_id_idx ON client_user_roles (user_id)`,
  `CREATE INDEX IF NOT EXISTS client_user_roles_role_id_idx ON client_user_roles (role_id)`,
  `CREATE INDEX IF NOT EXISTS client_user_roles_company_id_idx ON client_user_roles (company_id)`,
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
    { table: "companies", column: "datto_rmm_site_uid", def: "TEXT" },
    { table: "companies", column: "datto_rmm_site_name", def: "TEXT" },
    { table: "users", column: "job_title", def: "TEXT" },
    { table: "users", column: "phone", def: "TEXT" },
    { table: "users", column: "mobile", def: "TEXT" },
    { table: "users", column: "bio", def: "TEXT" },
    { table: "users", column: "locale", def: "TEXT" },
    { table: "users", column: "staff_role_id", def: "INTEGER" },
    { table: "users", column: "client_role_id", def: "INTEGER" },
    { table: "users", column: "billing_access", def: "BOOLEAN" },
    // CRITICAL: existing DBs created client_roles without company_id.
    // Must be nullable here so ALTER succeeds when legacy rows exist;
    // app backfill assigns company_id per client.
    { table: "client_roles", column: "company_id", def: "INTEGER" },
    { table: "users", column: "itglue_user_id", def: "TEXT" },
    { table: "users", column: "datto_web_remote_device_uids", def: "TEXT" },
    { table: "users", column: "board_email_opt_in", def: "BOOLEAN" },
    { table: "users", column: "mfa_enabled", def: "BOOLEAN" },
    { table: "users", column: "mfa_totp_secret", def: "TEXT" },
    { table: "users", column: "mfa_recovery_codes", def: "TEXT" },
    { table: "users", column: "mfa_email_code_hash", def: "TEXT" },
    { table: "users", column: "mfa_email_code_expires", def: "TEXT" },
    // Bumped on logout / password / MFA change so old cookies stop working
    { table: "users", column: "session_epoch", def: "INTEGER DEFAULT 0" },
    // TOTP seed during enrollment — server-only, never put in cookies
    { table: "users", column: "mfa_enroll_secret", def: "TEXT" },
    { table: "users", column: "mfa_enroll_id", def: "TEXT" },
    { table: "users", column: "mfa_enroll_expires", def: "TEXT" },
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
  devices: true,
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
  devices: true,
  profiles: true,
});

export async function runMigrations(): Promise<void> {
  if (!isPostgresConfigured()) return;
  if (migrateDone) return;
  if (migratePromise) return migratePromise;

  migratePromise = (async () => {
    const p = getPool();
    const client = await withTimeout(p.connect(), 5000, "migrate connect");
    try {
      // Phase 1 — create base tables / safe indexes (one transaction)
      await withTimeout(client.query("BEGIN"), 5000, "migrate BEGIN");
      for (const sql of MIGRATION_STATEMENTS) {
        await withTimeout(client.query(sql), 15000, "migrate DDL");
      }
      await withTimeout(client.query("COMMIT"), 5000, "migrate COMMIT tables");

      // Phase 2 — additive columns (separate statements; IF NOT EXISTS is idempotent).
      // Keep outside a single giant transaction so one bad ALTER cannot wipe progress.
      // IMPORTANT: existing DBs that created client_roles before company_id existed
      // only pick up that column here — CREATE TABLE IF NOT EXISTS is a no-op.
      for (const { table, column, def } of ADDITIVE_COLUMNS) {
        await withTimeout(
          client.query(
            `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`,
          ),
          10000,
          `migrate ALTER ${table}.${column}`,
        );
      }

      // Phase 3 — indexes that need columns from phase 2
      // Drop legacy global unique on client_roles.slug (roles are per-company now)
      for (const dropSql of [
        `DROP INDEX IF EXISTS client_roles_slug_unique`,
        // Some PG versions name unique indexes from constraint name
        `ALTER TABLE client_roles DROP CONSTRAINT IF EXISTS client_roles_slug_key`,
        `ALTER TABLE client_roles DROP CONSTRAINT IF EXISTS client_roles_slug_unique`,
      ]) {
        try {
          await withTimeout(
            client.query(dropSql),
            10000,
            "migrate drop legacy client_roles slug unique",
          );
        } catch {
          /* ignore */
        }
      }
      for (const sql of POST_ALTER_INDEXES) {
        try {
          await withTimeout(client.query(sql), 15000, "migrate post-index");
        } catch (idxErr) {
          // Unique index can fail if duplicate (company_id, slug) during partial
          // upgrade — log and continue; app still works with non-unique slugs.
          console.warn(
            "[akab-db] post-index skipped:",
            sql,
            idxErr instanceof Error ? idxErr.message : idxErr,
          );
        }
      }

      // Phase 4 — data backfills
      await withTimeout(
        client.query(
          `UPDATE users SET board_email_opt_in = TRUE WHERE board_email_opt_in IS NULL`,
        ),
        10000,
        "migrate backfill",
      );

      // Verify critical column for per-client user roles
      const colCheck = await withTimeout(
        client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'client_roles'
             AND column_name = 'company_id'
           LIMIT 1`,
        ),
        5000,
        "migrate verify client_roles.company_id",
      );
      if (!colCheck.rowCount) {
        throw new Error(
          "client_roles.company_id missing after migrate — additive ALTER failed",
        );
      }

      // Phase 5 — DB-level isolation for the browser SQL proxy (best effort)
      await setupProxyIsolation(client);

      migrateDone = true;
      console.log("[akab-db] migrations OK (additive, phased)");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      migratePromise = null;
      migrateDone = false;
      throw err;
    } finally {
      client.release();
    }
  })();

  return migratePromise;
}

/**
 * First boot only: create system roles + demo admin when users table is empty.
 */
export async function ensureBootstrap(): Promise<{ seeded: boolean }> {
  if (!isPostgresConfigured()) return { seeded: false };
  if (bootstrapDone) return { seeded: false };
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    await runMigrations();
    const p = getPool();

    const countRes = await withTimeout(
      p.query(`SELECT COUNT(*)::int AS n FROM users`),
      5000,
      "bootstrap count",
    );
    const n = Number((countRes.rows[0] as { n?: number })?.n ?? 0);
    if (n > 0) {
      bootstrapDone = true;
      return { seeded: false };
    }

    console.log("[akab-db] empty DB — seeding admin + demo clients…");
    const client = await withTimeout(p.connect(), 5000, "bootstrap connect");
    try {
      await client.query("BEGIN");

      const adminRole = await client.query(
        `INSERT INTO staff_roles (name, slug, description, permissions, is_system, active)
         VALUES ($1,$2,$3,$4,TRUE,TRUE)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          "Admin",
          "admin",
          "Full portal access",
          ADMIN_PERMISSIONS_JSON,
        ],
      );
      const techRole = await client.query(
        `INSERT INTO staff_roles (name, slug, description, permissions, is_system, active)
         VALUES ($1,$2,$3,$4,TRUE,TRUE)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          "Technician",
          "technician",
          "Day-to-day service access",
          TECH_PERMISSIONS_JSON,
        ],
      );
      const adminRoleId = (adminRole.rows[0] as { id: number }).id;
      const techRoleId = (techRole.rows[0] as { id: number }).id;

      const solu = await client.query(
        `INSERT INTO companies (name, type, email, phone, notes, active)
         VALUES ($1,'internal',$2,$3,$4,TRUE) RETURNING id`,
        [
          "AKAB Informatique",
          "admin@akab.local",
          "1-888-765-8841",
          "Internal management company",
        ],
      );
      const acme = await client.query(
        `INSERT INTO companies (name, type, email, phone, notes, autotask_company_id, active)
         VALUES ($1,'client',$2,$3,$4,$5,TRUE) RETURNING id`,
        [
          "Acme Manufacturing",
          "it@acme.example",
          "555-0100",
          "Demo client company",
          "1001",
        ],
      );
      const north = await client.query(
        `INSERT INTO companies (name, type, email, phone, notes, autotask_company_id, active)
         VALUES ($1,'client',$2,$3,$4,$5,TRUE) RETURNING id`,
        [
          "Northstar Logistics",
          "ops@northstar.example",
          "555-0200",
          "Second demo client",
          "1002",
        ],
      );

      const soluId = (solu.rows[0] as { id: number }).id;
      const acmeId = (acme.rows[0] as { id: number }).id;
      const northId = (north.rows[0] as { id: number }).id;

      const { hashPassword } = await import("./passwords.js");
      const adminPw = await hashPassword("admin123");
      const techPw = await hashPassword("tech123");
      const clientPw = await hashPassword("client123");

      const adminUser = await client.query(
        `INSERT INTO users (email, password, name, role, company_id, active, staff_role_id, job_title, phone, bio, locale, board_email_opt_in)
         VALUES ($1,$2,$3,'admin',$4,TRUE,$5,$6,$7,$8,'en',TRUE) RETURNING id`,
        [
          "admin@akab.local",
          adminPw,
          "Portal Admin",
          soluId,
          adminRoleId,
          "Portal Administrator",
          "1-888-765-8841",
          "AKAB internal administrator for the client portal.",
        ],
      );
      await client.query(
        `INSERT INTO users (email, password, name, role, company_id, active, staff_role_id, job_title, phone, bio, locale, board_email_opt_in)
         VALUES ($1,$2,$3,'technician',$4,TRUE,$5,$6,$7,$8,'en',TRUE)`,
        [
          "tech@akab.local",
          techPw,
          "Alex Technician",
          soluId,
          techRoleId,
          "Service Technician",
          "1-888-765-8841",
          "Field and remote support technician at AKAB.",
        ],
      );
      await client.query(
        `INSERT INTO users (email, password, name, role, company_id, active, job_title, phone, bio, locale, board_email_opt_in)
         VALUES ($1,$2,$3,'client',$4,TRUE,$5,$6,$7,'en',TRUE)`,
        [
          "client@acme.example",
          clientPw,
          "Jordan Client",
          acmeId,
          "IT Coordinator",
          "555-0100",
          "Primary contact for Acme Manufacturing.",
        ],
      );

      const adminId = (adminUser.rows[0] as { id: number }).id;
      await client.query(
        `INSERT INTO board_messages (company_id, author_id, author_name, title, body, pinned)
         VALUES
         ($1,$2,'Portal Admin','Welcome to your AKAB portal','This is your company message board. Updates from AKAB will appear here.',TRUE),
         ($3,$2,'Portal Admin','Portal access activated','Your Northstar Logistics zone is ready.',TRUE)`,
        [acmeId, adminId, northId],
      );

      await client.query("COMMIT");
      bootstrapDone = true;
      console.log(
        "[akab-db] bootstrap OK — admin@akab.local / admin123 (change password!)",
      );
      return { seeded: true };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      bootstrapPromise = null;
      throw err;
    } finally {
      client.release();
    }
  })();

  return bootstrapPromise;
}

// ---------------------------------------------------------------------------
// Browser SQL proxy isolation
//
// Proxy statements run as a restricted NOLOGIN role with row-level security,
// so tenant isolation is enforced by Postgres itself — not only by the SQL text
// checks in api/db/query.ts. Internal server queries (auth, migrations, API
// handlers) keep running as the owner and are unaffected.
// ---------------------------------------------------------------------------
const PROXY_ROLE = "akab_proxy";
const PROXY_TABLES = [
  "companies",
  "users",
  "staff_roles",
  "client_roles",
  "client_user_roles",
  "board_messages",
  "message_user_states",
  "sos_requests",
] as const;

const RLS_STAFF = `current_setting('akab.role', true) IN ('admin','technician')`;
const RLS_UID = `NULLIF(current_setting('akab.user_id', true), '')::int`;
const RLS_COMPANIES = `string_to_array(NULLIF(current_setting('akab.company_ids', true), ''), ',')::int[]`;

/** [table, policy, command, USING/WITH CHECK expression] */
const PROXY_POLICIES: Array<[string, string, string, string]> = [
  ["companies", "proxy_read", "SELECT", `${RLS_STAFF} OR id = ANY(${RLS_COMPANIES})`],
  ["companies", "proxy_write", "ALL", RLS_STAFF],
  ["users", "proxy_read", "SELECT", `${RLS_STAFF} OR id = ${RLS_UID} OR company_id = ANY(${RLS_COMPANIES})`],
  ["users", "proxy_update", "UPDATE", `${RLS_STAFF} OR id = ${RLS_UID}`],
  ["users", "proxy_write", "ALL", RLS_STAFF],
  ["staff_roles", "proxy_all", "ALL", RLS_STAFF],
  ["client_roles", "proxy_read", "SELECT", `${RLS_STAFF} OR company_id = ANY(${RLS_COMPANIES})`],
  ["client_roles", "proxy_write", "ALL", RLS_STAFF],
  ["client_user_roles", "proxy_read", "SELECT", `${RLS_STAFF} OR company_id = ANY(${RLS_COMPANIES})`],
  ["client_user_roles", "proxy_write", "ALL", RLS_STAFF],
  ["board_messages", "proxy_all", "ALL", `${RLS_STAFF} OR company_id = ANY(${RLS_COMPANIES})`],
  ["message_user_states", "proxy_all", "ALL", `${RLS_STAFF} OR user_id = ${RLS_UID}`],
  ["sos_requests", "proxy_all", "ALL", `${RLS_STAFF} OR (user_id = ${RLS_UID} AND company_id = ANY(${RLS_COMPANIES}))`],
];

/** Columns whose values never leave the server, whatever the SQL looked like. */
const PROXY_SECRET_FIELDS = new Set([
  "password",
  "mfa_totp_secret",
  "mfa_recovery_codes",
  "mfa_email_code_hash",
  "mfa_email_code_expires",
  "mfa_enroll_secret",
  "mfa_enroll_id",
  "mfa_enroll_expires",
  "sharepoint_client_secret",
]);

let proxyRoleReady = false;

export function isProxyIsolationReady(): boolean {
  return proxyRoleReady;
}

/**
 * Idempotent: create the proxy role, grants and RLS policies.
 * Best effort — on failure the proxy keeps working without DB-level isolation
 * and logs a loud warning (never blocks boot).
 */
async function setupProxyIsolation(client: pg.PoolClient): Promise<void> {
  const q = (sql: string) => withTimeout(client.query(sql), 15000, "proxy isolation");
  try {
    await q("BEGIN");
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROXY_ROLE}') THEN
        CREATE ROLE ${PROXY_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`);
    await q(`DO $$ BEGIN
      EXECUTE format('GRANT ${PROXY_ROLE} TO %I', current_user);
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$`);
    await q(`GRANT USAGE ON SCHEMA public TO ${PROXY_ROLE}`);
    await q(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${PROXY_ROLE}`);
    for (const t of PROXY_TABLES) {
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${PROXY_ROLE}`);
      await q(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    }
    for (const [table, name, cmd, expr] of PROXY_POLICIES) {
      await q(`DROP POLICY IF EXISTS ${name} ON ${table}`);
      const check = cmd === "SELECT" || cmd === "DELETE" ? "" : ` WITH CHECK (${expr})`;
      await q(
        `CREATE POLICY ${name} ON ${table} AS PERMISSIVE FOR ${cmd} TO ${PROXY_ROLE} USING (${expr})${check}`,
      );
    }
    await q("COMMIT");
    proxyRoleReady = true;
    console.log("[akab-db] SQL proxy isolation: role + row-level security ready");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    proxyRoleReady = false;
    console.error(
      "[akab-db] WARNING: SQL proxy isolation NOT active (row-level security setup failed):",
      err instanceof Error ? err.message : err,
    );
  }
}

export type ProxyScope = {
  role: "admin" | "technician" | "client";
  userId: number;
  companyIds: number[];
};

function redactSecretFields(result: pg.QueryResult, arrayMode: boolean): void {
  const idx: number[] = [];
  const names: string[] = [];
  (result.fields || []).forEach((f, i) => {
    if (PROXY_SECRET_FIELDS.has(String(f.name).toLowerCase())) {
      idx.push(i);
      names.push(f.name);
    }
  });
  if (!idx.length) return;
  for (const row of result.rows as unknown[]) {
    if (arrayMode && Array.isArray(row)) {
      for (const i of idx) row[i] = null;
    } else if (row && typeof row === "object") {
      for (const n of names) (row as Record<string, unknown>)[n] = null;
    }
  }
}

export async function proxyQuery(opts: {
  sql: string;
  params?: unknown[];
  method?: string;
  scope?: ProxyScope;
}): Promise<unknown[] | unknown[][]> {
  // Migrations run on server boot — do NOT re-run on every query
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
  const qTimeout =
    Number(cleanEnv(process.env.PG_QUERY_TIMEOUT_MS) || "12000") || 12000;

  const arrayMode = method === "all";
  const query = arrayMode
    ? { text: sql, values: params, rowMode: "array" as const }
    : { text: sql, values: params };

  // Isolated path: restricted role + per-request RLS settings, one transaction
  if (opts.scope && proxyRoleReady) {
    const s = opts.scope;
    const client = await withTimeout(p.connect(), 5000, "proxy connect");
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${PROXY_ROLE}`);
      await client.query(
        `SELECT set_config('akab.role', $1, true),
                set_config('akab.user_id', $2, true),
                set_config('akab.company_ids', $3, true)`,
        [
          s.role,
          String(Math.floor(s.userId)),
          s.companyIds.filter((n) => Number.isFinite(n)).map((n) => Math.floor(n)).join(","),
        ],
      );
      const result = await withTimeout(client.query(query), qTimeout, "SQL query");
      await client.query("COMMIT");
      redactSecretFields(result, arrayMode);
      return result.rows as unknown[] | unknown[][];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const result = await withTimeout(p.query(query), qTimeout, "SQL query");
  redactSecretFields(result, arrayMode);
  return result.rows as unknown[] | unknown[][];
}

/** Fast SELECT 1 — no migrations. Always finishes within ~6s. */
export async function pingDatabase(timeoutMs = 5000): Promise<{
  ok: boolean;
  error?: string;
  database?: string;
  user?: string;
  userCount?: number;
  latencyMs?: number;
}> {
  if (!isPostgresConfigured()) {
    return { ok: false, error: "PostgreSQL is not configured" };
  }
  const started = Date.now();
  try {
    const p = getPool();
    const r = await withTimeout(
      p.query(
        `SELECT current_database() AS database, current_user AS user,
                (SELECT COUNT(*)::int FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='users') AS has_users_table`,
      ),
      timeoutMs,
      "DB ping",
    );
    const row = r.rows[0] as {
      database?: string;
      user?: string;
      has_users_table?: number;
    };
    let userCount: number | undefined;
    if (Number(row?.has_users_table) > 0) {
      const c = await withTimeout(
        p.query(`SELECT COUNT(*)::int AS n FROM users`),
        Math.min(4000, timeoutMs),
        "user count",
      );
      userCount = Number((c.rows[0] as { n?: number })?.n ?? 0);
    }
    return {
      ok: true,
      database: row?.database,
      user: row?.user,
      userCount,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    resetPool();
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Database connection failed",
      latencyMs: Date.now() - started,
    };
  }
}

export async function getDbStatus(): Promise<{
  backend: DbBackend;
  configured: boolean;
  ok: boolean;
  error?: string;
  host?: string;
  database?: string;
  migrated?: boolean;
  seeded?: boolean;
  userCount?: number;
}> {
  const summary = getDbConfigSummary();
  if (!summary.configured) {
    return {
      backend: "none",
      configured: false,
      ok: false,
      error:
        "POSTGRES_* not set. With Docker Compose, set POSTGRES_PASSWORD in .env",
    };
  }

  if (!summary.passwordSet && summary.source === "postgres_env") {
    return {
      backend: "postgres",
      configured: true,
      ok: false,
      host: summary.host || undefined,
      database: summary.database || undefined,
      error:
        "POSTGRES_PASSWORD is empty. Set it in .env and recreate the app container.",
    };
  }

  const ping = await pingDatabase();
  if (!ping.ok) {
    return {
      backend: "postgres",
      configured: true,
      ok: false,
      host: summary.host || undefined,
      database: summary.database || undefined,
      error: ping.error,
    };
  }

  return {
    backend: "postgres",
    configured: true,
    ok: true,
    migrated: migrateDone,
    seeded: bootstrapDone,
    host: summary.host || undefined,
    database: ping.database || summary.database || undefined,
    userCount: ping.userCount,
  };
}

export async function closePool(): Promise<void> {
  resetPool();
}
