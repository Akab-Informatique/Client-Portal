import{drizzle as i}from"drizzle-orm/pglite";import{PGlite as E}from"@electric-sql/pglite";import{s as L}from"./index-CUfZfqcD.js";import"./vendor-CXU8bRBo.js";import"./motion-CPslPGox.js";async function r(e){const T=e?new E(e):new E;await T.waitReady,window.__devs_pglite=T,await T.exec(`
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
`);for(const[N,s]of[["companies","autotask_company_id TEXT"],["companies","dashboard_layout TEXT"],["companies","sharepoint_site_url TEXT"],["companies","sharepoint_folder_path TEXT"],["companies","sharepoint_tenant_id TEXT"],["companies","sharepoint_client_id TEXT"],["companies","sharepoint_client_secret TEXT"],["companies","documentation_title TEXT"],["companies","documentation_enabled BOOLEAN"],["companies","itglue_organization_id TEXT"],["users","job_title TEXT"],["users","phone TEXT"],["users","mobile TEXT"],["users","bio TEXT"],["users","locale TEXT"],["users","staff_role_id INTEGER"],["users","client_role_id INTEGER"],["users","billing_access BOOLEAN"],["client_roles","company_id INTEGER"],["users","itglue_user_id TEXT"],["users","board_email_opt_in BOOLEAN"],["users","mfa_enabled BOOLEAN"],["users","mfa_totp_secret TEXT"],["users","mfa_recovery_codes TEXT"],["users","mfa_email_code_hash TEXT"],["users","mfa_email_code_expires TEXT"]])try{await T.exec(`ALTER TABLE ${N} ADD COLUMN IF NOT EXISTS ${s}`)}catch{}return i(T,{schema:L})}export{r as openPglite};
