import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  active: boolean("active").notNull(),
  /** Autotask PSA company ID used to fetch open tickets for this client */
  autotask_company_id: text("autotask_company_id"),
  /**
   * Admin-defined default client dashboard layout (JSON).
   * Applied when a client user has no personal layout override.
   */
  dashboard_layout: text("dashboard_layout"),
  /**
   * Private SharePoint documentation for this client only.
   * Each client company has its own connection — never shared across companies.
   * Admin pastes the site URL (and optional folder path); Graph lists files.
   */
  sharepoint_site_url: text("sharepoint_site_url"),
  /** Optional folder path inside the site library, e.g. "Shared Documents/Manuals" */
  sharepoint_folder_path: text("sharepoint_folder_path"),
  /**
   * Optional Microsoft Entra tenant ID for THIS client's Graph/SharePoint auth.
   * Leave empty to use the portal-wide MICROSOFT_TENANT_ID.
   */
  sharepoint_tenant_id: text("sharepoint_tenant_id"),
  /**
   * Optional per-client Microsoft Graph app (client) ID.
   * When set with sharepoint_client_secret, THIS company authenticates with its
   * own Entra app registration — not the portal default MICROSOFT_CLIENT_ID.
   */
  sharepoint_client_id: text("sharepoint_client_id"),
  /**
   * Optional per-client Microsoft Graph app client secret.
   * Stored with the company record (same as other client connection fields).
   * Never sent to other clients' sessions for browsing.
   */
  sharepoint_client_secret: text("sharepoint_client_secret"),
  /** Optional label shown in the Documentation section */
  documentation_title: text("documentation_title"),
  /** When false, Documentation is hidden for this client even if a URL is set */
  documentation_enabled: boolean("documentation_enabled"),
  /** IT Glue / MyGlue organization ID for this client. */
  itglue_organization_id: text("itglue_organization_id"),
  /**
   * Datto RMM site UID for this client company.
   * Devices under Operations are loaded from this site only.
   */
  datto_rmm_site_uid: text("datto_rmm_site_uid"),
  /** Optional display name of the linked Datto RMM site (cached for UI). */
  datto_rmm_site_name: text("datto_rmm_site_name"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Customizable staff roles (Admin, Technician, and any extras).
 * permissions is a JSON map of section → boolean.
 */
export const staff_roles = pgTable("staff_roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Stable slug: admin | technician | custom-… */
  slug: text("slug").notNull(),
  description: text("description"),
  /** JSON PermissionMap */
  permissions: text("permissions").notNull(),
  /** System roles cannot be deleted */
  is_system: boolean("is_system").notNull(),
  active: boolean("active").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Client USER roles — unique per client company.
 * Each company has its own Standard / Billing / custom roles.
 * permissions is a JSON map of client section → boolean (e.g. billing).
 * Users can hold MULTIPLE roles; permissions stack (OR).
 * Standard is always the core membership for every client user.
 */
export const client_roles = pgTable("client_roles", {
  id: serial("id").primaryKey(),
  /** Owning client company (roles never shared across companies). */
  company_id: integer("company_id").notNull(),
  name: text("name").notNull(),
  /** Unique within the company: standard | billing | custom-… */
  slug: text("slug").notNull(),
  description: text("description"),
  /** JSON ClientPermissionMap */
  permissions: text("permissions").notNull(),
  /** Built-in templates for this company cannot be deleted */
  is_system: boolean("is_system").notNull(),
  active: boolean("active").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Many-to-many: a client user can belong to several roles/groups
 * in their company. Permissions from all memberships are combined (OR).
 * Standard is always present for every client user.
 */
export const client_user_roles = pgTable("client_user_roles", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  role_id: integer("role_id").notNull(),
  company_id: integer("company_id").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  /** Base portal type: admin | technician | client */
  role: text("role").notNull(),
  company_id: integer("company_id"),
  active: boolean("active").notNull(),
  /** Staff role template (null for client users) */
  staff_role_id: integer("staff_role_id"),
  /**
   * Legacy single client role (kept for migrate/backfill).
   * Runtime access uses client_user_roles memberships.
   */
  client_role_id: integer("client_role_id"),
  /**
   * Client billing section access.
   * null = inherit from stacked roles; true/false = admin override.
   */
  billing_access: boolean("billing_access"),
  /** Job title shown on company profile */
  job_title: text("job_title"),
  /** Work phone */
  phone: text("phone"),
  /** Mobile phone */
  mobile: text("mobile"),
  /** Short public bio (same-company only) */
  bio: text("bio"),
  /** Preferred UI language: en | fr */
  locale: text("locale"),
  /**
   * Linked IT Glue / MyGlue user id.
   * Restricted passwords are filtered to this user’s authorized_users list
   * (same visibility the person would have inside MyGlue).
   */
  itglue_user_id: text("itglue_user_id"),
  /**
   * JSON array of Datto RMM device UIDs this client user may Web Remote.
   * Staff ignore this (full remote on Operations → Devices).
   * Empty/null = no Web Remote for client users.
   */
  datto_web_remote_device_uids: text("datto_web_remote_device_uids"),
  /**
   * When true, this user receives board message emails (if staff checks
   * “Also send by email” when posting). Default true for new users.
   */
  board_email_opt_in: boolean("board_email_opt_in"),
  /**
   * Multi-factor authentication (required for all portal users).
   * Primary: TOTP authenticator app. Backup: emailed one-time code + recovery codes.
   */
  mfa_enabled: boolean("mfa_enabled"),
  /** Base32 TOTP secret (only when MFA is enabled / during setup). */
  mfa_totp_secret: text("mfa_totp_secret"),
  /** JSON array of SHA-256 hashed one-time recovery codes. */
  mfa_recovery_codes: text("mfa_recovery_codes"),
  /** Pending email OTP hash (SHA-256 of 6-digit code). */
  mfa_email_code_hash: text("mfa_email_code_hash"),
  /** ISO timestamp when email OTP expires. */
  mfa_email_code_expires: text("mfa_email_code_expires"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const board_messages = pgTable("board_messages", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull(),
  author_id: integer("author_id").notNull(),
  author_name: text("author_name").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  pinned: boolean("pinned").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Per-client-user state for board messages.
 * No row = unread (default). Clients can mark read and/or set a custom label.
 */
export const message_user_states = pgTable("message_user_states", {
  id: serial("id").primaryKey(),
  message_id: integer("message_id").notNull(),
  user_id: integer("user_id").notNull(),
  /** "unread" | "read" */
  status: text("status").notNull(),
  /** Optional custom label set by the client user */
  custom_label: text("custom_label"),
  updated_at: text("updated_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Splashtop SOS remote-support requests from client portal users.
 * Techs see open requests and connect via Splashtop Business deep link.
 */
export const sos_requests = pgTable("sos_requests", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull(),
  company_name: text("company_name").notNull(),
  user_id: integer("user_id").notNull(),
  user_name: text("user_name").notNull(),
  user_email: text("user_email").notNull(),
  /** Client-provided short description of the issue */
  issue: text("issue"),
  /**
   * open | waiting | ready | connected | closed | expired | error
   * open/waiting = session created, client may still need to launch SOS
   * ready = remote endpoint associated (Splashtop reports device online)
   * connected = tech connected (best-effort from poll)
   * closed/expired/error = terminal
   */
  status: text("status").notNull(),
  /** Splashtop support session id */
  splashtop_session_id: text("splashtop_session_id"),
  /** SOS code used in st-business:// deep link */
  sos_code: text("sos_code"),
  /** End-user portal link to download/run SOS applet */
  support_portal_link: text("support_portal_link"),
  /** Channel id used when creating the session (0 = private) */
  channel_id: text("channel_id"),
  /** Last error message if create/poll failed */
  error_message: text("error_message"),
  /** ISO timestamps as text for simple cross-db handling */
  expires_at: text("expires_at"),
  closed_at: text("closed_at"),
  closed_by_user_id: integer("closed_by_user_id"),
  last_polled_at: text("last_polled_at"),
  /** JSON blob of last Splashtop session snapshot (optional diagnostics) */
  remote_snapshot: text("remote_snapshot"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
