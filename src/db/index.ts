import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";

const client = new PGlite("idb://app-db");
(window as any).__devs_pglite = client;
export const db = drizzle(client, { schema });
export { schema };

export const dbReady = (async () => {
  await client.exec(`CREATE TABLE IF NOT EXISTS companies (id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT, active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`);
  await client.exec(`CREATE TABLE IF NOT EXISTS staff_roles (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL, is_system BOOLEAN NOT NULL, active BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`);
  await client.exec(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, company_id INTEGER, active BOOLEAN NOT NULL, job_title TEXT, phone TEXT, mobile TEXT, bio TEXT, locale TEXT, staff_role_id INTEGER, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`);
  await client.exec(`CREATE TABLE IF NOT EXISTS board_messages (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, author_id INTEGER NOT NULL, author_name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, pinned BOOLEAN NOT NULL, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`);
  await client.exec(`CREATE TABLE IF NOT EXISTS message_user_states (id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL, custom_label TEXT, updated_at TEXT, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`);

  // Additive migrations for existing local DBs
  try {
    await client.exec(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS autotask_company_id TEXT`);
  } catch {
    /* column may already exist on fresh create in some engines */
  }
  try {
    await client.exec(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS dashboard_layout TEXT`);
  } catch {
    /* already exists */
  }
  for (const col of [
    "sharepoint_site_url TEXT",
    "sharepoint_folder_path TEXT",
    "sharepoint_tenant_id TEXT",
    "sharepoint_client_id TEXT",
    "sharepoint_client_secret TEXT",
    "documentation_title TEXT",
    "documentation_enabled BOOLEAN",
  ]) {
    try {
      await client.exec(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${col}`);
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
  ]) {
    try {
      await client.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`);
    } catch {
      /* already exists */
    }
  }
})();
