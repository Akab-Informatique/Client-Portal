import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Client companies served by AKAB. */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  code: text("code"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
});

/** Predefined (is_system) and custom roles; permissions are keys from shared/permissions.ts. */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug"),
    audience: text("audience", { enum: ["staff", "client"] }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isSystem: boolean("is_system").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("roles_slug_unique").on(t.slug)],
);

/** Technicians (kind=staff) and client users (kind=client, with client_id). */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["staff", "client"] }).notNull(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    title: text("title"),
    phone: text("phone"),
    locale: text("locale", { enum: ["fr", "en"] }).notNull().default("fr"),
    /** Receives email copies of board messages */
    notifyEmail: boolean("notify_email").notNull().default(true),
    passwordHash: text("password_hash").notNull(),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** TOTP secret, AES-256-GCM sealed with APP_SECRET */
    mfaSecret: text("mfa_secret"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaLastStep: bigint("mfa_last_step", { mode: "number" }),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Staff only: the matching Autotask resource (actions are made on their behalf) */
    autotaskResourceId: integer("autotask_resource_id"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    index("users_client_idx").on(t.clientId),
    uniqueIndex("users_autotask_resource_unique").on(t.autotaskResourceId),
  ],
);

/** Rights granted or denied directly to a user, on top of the role. */
export const userPermissions = pgTable(
  "user_permissions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.permission] })],
);

/** Server-side sessions. id = SHA-256 of the cookie token (token never stored). */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    /** Staff "view as client": this session shows the portal as that client (read only) */
    viewAsClientId: uuid("view_as_client_id").references(() => clients.id, { onDelete: "set null" }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: created(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type DashboardWidget = { id: string; type: string; size: "sm" | "md" | "lg" };

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  dashboard: jsonb("dashboard").$type<DashboardWidget[] | null>(),
  theme: text("theme", { enum: ["dark", "light", "system"] }),
  /** Dashboard opened first; null = the built-in "Akab" dashboard. */
  defaultDashboardId: uuid("default_dashboard_id").references((): AnyPgColumn => dashboards.id, { onDelete: "set null" }),
  updatedAt: updated(),
});

/** Message board posts from AKAB to clients. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    audience: text("audience", { enum: ["all", "selected"] }).notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    emailCopy: boolean("email_copy").notNull().default(false),
    emailSent: integer("email_sent").notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("messages_created_idx").on(t.createdAt)],
);

export const messageTargets = pgTable(
  "message_targets",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.clientId] })],
);

export const messageReads = pgTable(
  "message_reads",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

/**
 * Extra dashboards (the personal one stays in user_preferences.dashboard).
 * visibility: private = owner only · team = every technician with
 * dashboard.view · admins = administrators only. Built-in ones have a slug.
 */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug"),
    name: text("name").notNull(),
    visibility: text("visibility", { enum: ["private", "team", "admins"] }).notNull(),
    /** "edit": the technicians who see it may personalize their own layout (the default stays) */
    teamAccess: text("team_access", { enum: ["view", "edit"] }).notNull().default("view"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<DashboardWidget[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("dashboards_slug_unique").on(t.slug), index("dashboards_owner_idx").on(t.ownerId)],
);

/**
 * Email templates edited in admin settings (only the edited ones; defaults
 * live in server/lib/emailTemplates.ts).
 */
export const emailTemplates = pgTable(
  "email_templates",
  {
    key: text("key").notNull(),
    locale: text("locale", { enum: ["fr", "en"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    action: text("action").notNull().default(""),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.key, t.locale] })],
);

/**
 * Portal-only data about an Autotask ticket (fields Autotask does not have),
 * keyed by the Autotask ticket id. E.g. the planned start date.
 */
export const ticketMeta = pgTable("ticket_meta", {
  ticketId: bigint("ticket_id", { mode: "number" }).primaryKey(),
  startDate: text("start_date"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updated(),
});

/**
 * Ticket timers (like Autotask's). Kept on the server so they survive a
 * refresh; a running timer whose page stops answering (tab closed) becomes
 * "pending": a time entry the technician validates before it goes to Autotask.
 */
export const ticketTimers = pgTable(
  "ticket_timers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    ticketNumber: text("ticket_number").notNull(),
    ticketTitle: text("ticket_title").notNull(),
    state: text("state", { enum: ["running", "paused", "pending"] }).notNull(),
    /** Time counted before the current running stretch */
    accumulatedMs: bigint("accumulated_ms", { mode: "number" }).notNull().default(0),
    runningSince: timestamp("running_since", { withTimezone: true }),
    /** Last sign of life from a page showing this running timer */
    lastBeatAt: timestamp("last_beat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ticket_timers_user_ticket_unique").on(t.userId, t.ticketId), index("ticket_timers_state_idx").on(t.state)],
);

/** AI results kept in the portal for a ticket (summary, next steps…), visible to the team. */
export const ticketAiNotes = pgTable(
  "ticket_ai_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    kind: text("kind", { enum: ["analysis"] }).notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("ticket_ai_notes_ticket_idx").on(t.ticketId)],
);

/** A technician's saved ticket filters (the list's query string). */
export const ticketFilters = pgTable(
  "ticket_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    query: text("query").notNull(),
    createdAt: created(),
  },
  (t) => [index("ticket_filters_user_idx").on(t.userId)],
);

/** One-time links to choose a password (forgotten password, welcome). Only the SHA-256 is stored. */
export const passwordTokens = pgTable(
  "password_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose", { enum: ["reset", "welcome"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("password_tokens_hash_unique").on(t.tokenHash), index("password_tokens_user_idx").on(t.userId)],
);

/**
 * Settings of external services, one row per provider ("autotask", "smtp").
 * `config` holds non-secret settings; `secret` is a JSON blob sealed with APP_SECRET.
 */
export const integrations = pgTable("integrations", {
  provider: text("provider").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  secret: text("secret"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updated(),
});

/**
 * A person's own layout of a shared dashboard (when they may personalize it).
 * Without a row, they see the dashboard's default layout.
 */
export const dashboardUserLayouts = pgTable(
  "dashboard_user_layouts",
  {
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<DashboardWidget[]>().notNull(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.dashboardId, t.userId] })],
);

/** Access given to specific staff members on a dashboard, on top of its visibility. */
export const dashboardMembers = pgTable(
  "dashboard_members",
  {
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access: text("access", { enum: ["view", "edit"] }).notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.dashboardId, t.userId] }), index("dashboard_members_user_idx").on(t.userId)],
);

/**
 * Per-user notifications (bell). Text is rendered client-side from `type` +
 * `data` so it follows the reader's language; `link` is an in-app path.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Who changed what in admin settings. */
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  details: jsonb("details"),
  createdAt: created(),
});
