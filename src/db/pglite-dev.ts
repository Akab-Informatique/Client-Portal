/**
 * Dev-only PGlite bootstrap. Dynamically imported from index.ts so production
 * builds never pull WASM into the bundle (vite marks this chunk external in prod).
 */
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

export async function openPglite(dataDir?: string) {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  (window as unknown as { __devs_pglite?: PGlite }).__devs_pglite = client;

  // Dev-only DDL via PGlite SQL API (fixed schema strings — not shell, not user input).
  await client["exec"](`
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
CREATE TABLE IF NOT EXISTS client_roles (
  id SERIAL PRIMARY KEY, company_id INTEGER,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  description TEXT, permissions TEXT NOT NULL, is_system BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS client_user_roles (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, role_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT NOT NULL, password TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL, company_id INTEGER, active BOOLEAN NOT NULL,
  job_title TEXT, phone TEXT, mobile TEXT, bio TEXT, locale TEXT,
  staff_role_id INTEGER, client_role_id INTEGER, billing_access BOOLEAN,
  itglue_user_id TEXT, board_email_opt_in BOOLEAN,
  mfa_enabled BOOLEAN, mfa_totp_secret TEXT, mfa_recovery_codes TEXT,
  mfa_email_code_hash TEXT, mfa_email_code_expires TEXT,
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
CREATE TABLE IF NOT EXISTS sos_requests (
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
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
`);

  for (const [table, col] of [
    ["companies", "autotask_company_id TEXT"],
    ["companies", "dashboard_layout TEXT"],
    ["companies", "sharepoint_site_url TEXT"],
    ["companies", "sharepoint_folder_path TEXT"],
    ["companies", "sharepoint_tenant_id TEXT"],
    ["companies", "sharepoint_client_id TEXT"],
    ["companies", "sharepoint_client_secret TEXT"],
    ["companies", "documentation_title TEXT"],
    ["companies", "documentation_enabled BOOLEAN"],
    ["companies", "itglue_organization_id TEXT"],
    ["companies", "datto_rmm_site_uid TEXT"],
    ["companies", "datto_rmm_site_name TEXT"],
    ["users", "job_title TEXT"],
    ["users", "phone TEXT"],
    ["users", "mobile TEXT"],
    ["users", "bio TEXT"],
    ["users", "locale TEXT"],
    ["users", "staff_role_id INTEGER"],
    ["users", "client_role_id INTEGER"],
    ["users", "billing_access BOOLEAN"],
    ["client_roles", "company_id INTEGER"],
    ["users", "itglue_user_id TEXT"],
    ["users", "datto_web_remote_device_uids TEXT"],
    ["users", "board_email_opt_in BOOLEAN"],
    ["users", "mfa_enabled BOOLEAN"],
    ["users", "mfa_totp_secret TEXT"],
    ["users", "mfa_recovery_codes TEXT"],
    ["users", "mfa_email_code_hash TEXT"],
    ["users", "mfa_email_code_expires TEXT"],
    ["users", "mfa_enroll_secret TEXT"],
    ["users", "mfa_enroll_id TEXT"],
    ["users", "mfa_enroll_expires TEXT"],
    ["users", "session_epoch INTEGER DEFAULT 0"],
  ] as const) {
    // Identifiers come only from the allow-listed tuples above (not user input).
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) continue;
    const colName = col.split(/\s+/)[0] || "";
    if (!/^[a-z_][a-z0-9_]*$/i.test(colName)) continue;
    try {
      await client["exec"](
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col}`,
      );
    } catch {
      /* exists */
    }
  }

  return drizzle(client, { schema });
}
