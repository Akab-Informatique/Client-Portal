import { sql } from "drizzle-orm";
import {
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
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    index("users_client_idx").on(t.clientId),
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
