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
 * Client portal roles (Standard, Billing contact, custom…).
 * permissions is a JSON map of client section → boolean (e.g. billing).
 * Defaults apply to users on that role; admins can still override per user.
 */
export const client_roles = pgTable("client_roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  /** JSON ClientPermissionMap */
  permissions: text("permissions").notNull(),
  is_system: boolean("is_system").notNull(),
  active: boolean("active").notNull(),
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
  /** Client role template (null for staff) */
  client_role_id: integer("client_role_id"),
  /**
   * Client billing section access.
   * null = inherit from client role default; true/false = admin override.
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
