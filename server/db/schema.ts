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

/** Invoice settings of a client (portal only, used by Accounting). */
export type ClientInvoiceSettings = {
  billingEmail?: string;
  /** Payment terms, in days (0: on receipt) */
  termsDays?: number;
  delivery?: "email" | "mail";
  /** GST / QST charged (false: exempt) */
  taxes?: boolean;
  taxNumber?: string;
  poRequired?: boolean;
  hourlyRate?: number | null;
  /** Kinds of work approved automatically when imported (labour, charge, contract, milestone, project) */
  autoApprove?: string[];
  notes?: string;
};

/**
 * Client companies served by AKAB â€” the CRM. The portal's own copy, kept in
 * step with Autotask (autotask_id) while it is linked; the portal keeps
 * everything when it is unlinked. A client can belong to a parent company.
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    code: text("code"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),
    website: text("website"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    /** Autotask company id (null: only in the portal) */
    autotaskId: integer("autotask_id"),
    parentId: uuid("parent_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
    invoice: jsonb("invoice").$type<ClientInvoiceSettings>().notNull().default({}),
    /** The matching QuickBooks customer (never two clients on the same one) */
    quickbooksId: text("quickbooks_id"),
    /** The client's classification (client_classes.key): break & fix, MSP, bronze, silver, gold… */
    classKey: text("class_key"),
    /** When the client and its QuickBooks customer were last known to match */
    qbSyncedAt: timestamp("qb_synced_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("clients_autotask_idx").on(t.autotaskId), index("clients_parent_idx").on(t.parentId), uniqueIndex("clients_quickbooks_idx").on(t.quickbooksId)],
);

/** Client classifications (Admin › Classifications): break & fix, MSP, bronze, silver, gold to start; admins add their own. */
export const clientClasses = pgTable("client_classes", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  /** A colour token the screens know: slate, blue, orange, zinc, yellow, green, red, violet */
  color: text("color").notNull().default("slate"),
  position: integer("position").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

/** People at a client (Autotask Contacts). */
export const clientContacts = pgTable(
  "client_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** Autotask id, as text (like contact ids elsewhere in the portal) */
    autotaskId: text("autotask_id"),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    phone: text("phone"),
    mobile: text("mobile"),
    title: text("title"),
    active: boolean("active").notNull().default(true),
    /** Their client portal account, once access was given */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("client_contacts_autotask_idx").on(t.autotaskId), index("client_contacts_client_idx").on(t.clientId), uniqueIndex("client_contacts_user_idx").on(t.userId)],
);

/** A client's contracts (Autotask Contracts). */
export const clientContracts = pgTable(
  "client_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** Autotask id, as text (like contact ids elsewhere in the portal) */
    autotaskId: text("autotask_id"),
    name: text("name").notNull(),
    type: text("type"),
    active: boolean("active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    /** Work done under this contract is approved automatically when imported */
    autoApprove: boolean("auto_approve").notNull().default(false),
    /**
     * How support under this contract is billed: hourly (rate below, else the usual
     * rate of Admin › Facturation), monthly (a flat monthly rate), per_ticket (a flat
     * rate per ticket) or none (included, never billed). Only hourly bills the hours.
     */
    billingMode: text("billing_mode").notNull().default("hourly"),
    /** Hourly rate in cents; none: the usual hourly rate */
    hourlyRateCents: integer("hourly_rate_cents"),
    monthlyRateCents: integer("monthly_rate_cents"),
    ticketRateCents: integer("ticket_rate_cents"),
    /** The contract type (contract_types.key) it was made from */
    typeKey: text("type_key"),
    /** Banked hours: the block of hours bought (x100) */
    bankedHoursX100: integer("banked_hours_x100"),
    /** Fixed price in cents */
    fixedPriceCents: integer("fixed_price_cents"),
    /** The client's default support contract, chosen in the portal (else the source's default) */
    supportDefault: boolean("support_default").notNull().default(false),
    /** YYYY-MM-DD */
    startDate: text("start_date"),
    endDate: text("end_date"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("client_contracts_autotask_idx").on(t.autotaskId), index("client_contracts_client_idx").on(t.clientId)],
);

/**
 * Recurring services added to a contract: the service as it was when added (name, price, cost), the day it
 * was added, and from them the prorata of the first period and of the rest of the term (shared/prorata.ts).
 */
export const contractServices = pgTable(
  "contract_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => clientContracts.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** recurring (monthly) | recurring_yearly */
    kind: text("kind").notNull(),
    priceCents: integer("price_cents").notNull(),
    costCents: integer("cost_cents").notNull().default(0),
    /** YYYY-MM-DD: when the service starts on the contract */
    addedOn: text("added_on").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("contract_services_contract_idx").on(t.contractId)],
);

/** A client's invoices (Autotask Invoices while linked). Money in cents. */
export const clientInvoices = pgTable(
  "client_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    autotaskId: text("autotask_id"),
    number: text("number").notNull(),
    /** YYYY-MM-DD */
    issuedOn: text("issued_on").notNull(),
    dueOn: text("due_on"),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    /** Set once paid (YYYY-MM-DD) */
    paidOn: text("paid_on"),
    voided: boolean("voided").notNull().default(false),
    /** The invoice in QuickBooks, once sent; the last send and its error */
    quickbooksId: text("quickbooks_id"),
    quickbooksSyncedAt: timestamp("quickbooks_synced_at", { withTimezone: true }),
    quickbooksError: text("quickbooks_error"),
    /** autotask: copied from Autotask · portal: made here from posted items */
    source: text("source").notNull().default("autotask"),
    /** Shown on the invoice (made in the portal) */
    notes: text("notes"),
    poNumber: text("po_number"),
    /** Sent to the client by email (marked by hand until the portal emails invoices) */
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("client_invoices_autotask_idx").on(t.autotaskId), uniqueIndex("client_invoices_quickbooks_idx").on(t.quickbooksId), index("client_invoices_client_idx").on(t.clientId, t.issuedOn)],
);

/**
 * Work to bill, waiting for approval and posting (Accounting › Approbation):
 * labour, charges, expenses, recurring contract periods, milestones. Copied
 * from Autotask (not yet posted there) or made in the portal. Posted items
 * become the lines of a new invoice. Money in cents, quantities ×100.
 */
export const billingItems = pgTable(
  "billing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** labour | charge | expense | contract | milestone */
    kind: text("kind").notNull(),
    /** autotask | portal */
    source: text("source").notNull().default("autotask"),
    /** Id in the source (e.g. "time:123"): copied once */
    sourceId: text("source_id"),
    /** YYYY-MM-DD (work date, purchase date, period start…) */
    date: text("date").notNull(),
    /** End of a contract period (YYYY-MM-DD) */
    dateEnd: text("date_end"),
    description: text("description").notNull().default(""),
    ticketNumber: text("ticket_number"),
    contractName: text("contract_name"),
    /** The contract it was done under (for automatic approval) */
    contractId: uuid("contract_id").references(() => clientContracts.id, { onDelete: "set null" }),
    resourceName: text("resource_name"),
    /** Hours, units… ×100 */
    quantityX100: integer("quantity_x100").notNull().default(100),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull().default(0),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull().default(0),
    taxable: boolean("taxable").notNull().default(true),
    /** pending | approved | posted | excluded */
    status: text("status").notNull().default("pending"),
    /** Changed in the portal: a sync does not overwrite it */
    edited: boolean("edited").notNull().default(false),
    /** Why it is excluded: "billed" = already billed (e.g. in Autotask) */
    excludedReason: text("excluded_reason"),
    invoiceId: uuid("invoice_id").references(() => clientInvoices.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("billing_items_source_idx").on(t.sourceId), index("billing_items_status_idx").on(t.status, t.kind), index("billing_items_client_idx").on(t.clientId)],
);

/** The lines of an invoice made in the portal. Money in cents, quantities ×100. */
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => clientInvoices.id, { onDelete: "cascade" }),
    billingItemId: uuid("billing_item_id").references(() => billingItems.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    quantityX100: integer("quantity_x100").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    taxable: boolean("taxable").notNull().default(true),
    ledgerAccountId: uuid("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId, t.position)],
);

/** A payment received on an invoice (several make a partial payment). Money in cents. */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => clientInvoices.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    /** YYYY-MM-DD */
    paidOn: text("paid_on").notNull(),
    /** cheque | transfer | card | cash | stripe | other */
    method: text("method").notNull().default("other"),
    reference: text("reference"),
    note: text("note"),
    /** Where it was recorded: portal | quickbooks | stripe */
    source: text("source").notNull().default("portal"),
    /** Id in the source (QuickBooks: payment id + invoice id) */
    externalId: text("external_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("invoice_payments_invoice_idx").on(t.invoiceId), uniqueIndex("invoice_payments_external_idx").on(t.externalId)],
);

/** The chart of accounts (plan comptable), for invoices and the QuickBooks sync. */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    name: text("name").notNull(),
    /** asset | liability | equity | revenue | expense */
    type: text("type").notNull(),
    active: boolean("active").notNull().default(true),
    /** The matching QuickBooks account, once linked */
    quickbooksId: text("quickbooks_id"),
    qbSyncedAt: timestamp("qb_synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ledger_accounts_number_idx").on(t.number)],
);

/** QuickBooks products, services and categories (copied from QuickBooks, to match SKUs and invoice lines). */
export const quickbooksItems = pgTable(
  "quickbooks_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quickbooksId: text("quickbooks_id").notNull(),
    name: text("name").notNull(),
    sku: text("sku"),
    /** Service | Inventory | NonInventory | Category | Group */
    type: text("type").notNull(),
    /** Its category (QuickBooks id) */
    parentId: text("parent_id"),
    incomeAccountId: text("income_account_id"),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }),
    active: boolean("active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("quickbooks_items_qb_idx").on(t.quickbooksId), index("quickbooks_items_sku_idx").on(t.sku)],
);

/** Where a sync stands (e.g. "autotask.crm"): last run, result, counts. */
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
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
    /** Built-in roles: the default rights already given (new defaults are added once, removals kept) */
    defaultsApplied: jsonb("defaults_applied").$type<string[]>(),
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
    /** Mobile number (SMS alerts, later) */
    mobile: text("mobile"),
    /** Microsoft 365 mailbox for calendar sync, when different from the email (set by an admin only) */
    o365Email: text("o365_email"),
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
    /** The matching QuickBooks employee (timesheets, expenses) */
    quickbooksEmployeeId: text("quickbooks_employee_id"),
    /** Must submit a weekly timesheet for approval (set by an admin) */
    timesheetRequired: boolean("timesheet_required").notNull().default(true),
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
  /** The Outlook module, turned on by the technician in their profile (off by default) */
  outlook: boolean("outlook").notNull().default(false),
  /** Email signature (sanitized HTML), added to the emails they write in the Outlook module */
  emailSignature: text("email_signature"),
  /** Hours worked go to the hours bank by default (each entry can still say otherwise) */
  bankHoursDefault: boolean("bank_hours_default").notNull().default(false),
  /** The channels ticked by default when notifying a technician from a ticket (the bell is always on) */
  notifyDefaults: jsonb("notify_defaults").$type<{ email: boolean; sms: boolean; teams: boolean }>().notNull().default({ email: true, sms: false, teams: false }),
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
 * visibility: private = owner only Â· team = every technician with
 * dashboard.view Â· admins = administrators only. Built-in ones have a slug.
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
/**
 * The portal's own tickets (once switched from Autotask: Admin › Intégrations).
 * Tickets copied from Autotask keep their id and number; new ones follow.
 * Company and contact are the CRM ids (Autotask ids as text for contacts),
 * with their names as they were; people are portal users, or "at-<resource>"
 * for Autotask resources never linked to an account.
 */
export const tickets = pgTable(
  "tickets",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    number: text("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    companyId: bigint("company_id", { mode: "number" }).notNull(),
    companyName: text("company_name").notNull().default(""),
    contactId: text("contact_id"),
    contactName: text("contact_name").notNull().default(""),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    queue: text("queue").notNull().default(""),
    source: text("source").notNull().default("portal"),
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    secondary: jsonb("secondary").$type<{ id: string; name: string }[]>().notNull().default(sql`'[]'::jsonb`),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    assetId: text("asset_id"),
    contractId: text("contract_id"),
    createdAt: created(),
    updatedAt: updated(),
    /** When it got a "complete" status (null while open) */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** The ticket this one was merged into (its status is then "merged", a closed one) */
    mergedIntoId: bigint("merged_into_id", { mode: "number" }),
    /** When it was last written from Autotask (null: made in the portal). Edited in the portal since: an import keeps the portal's version. */
    autotaskSyncedAt: timestamp("autotask_synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("tickets_number_idx").on(t.number), index("tickets_company_idx").on(t.companyId), index("tickets_completed_idx").on(t.completedAt), index("tickets_created_idx").on(t.createdAt)],
);

/**
 * Tickets deleted in the portal: an import from Autotask never brings them
 * back (unless a ticket is imported by its number on purpose).
 */
export const deletedTickets = pgTable("deleted_tickets", {
  ticketId: bigint("ticket_id", { mode: "number" }).primaryKey(),
  number: text("number").notNull(),
  title: text("title").notNull().default(""),
  deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Replies and internal notes of a portal ticket */
export const ticketNotes = pgTable(
  "ticket_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** Where it came from ("n123": an Autotask note) */
    externalId: text("external_id"),
    author: text("author").notNull().default(""),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    internal: boolean("internal").notNull().default(false),
    /** Written by the system (an Autotask workflow rule…), not by a person */
    system: boolean("system").notNull().default(false),
    /** The number of the ticket it was written on before that ticket was merged into this one */
    mergedFrom: text("merged_from"),
    createdAt: created(),
  },
  (t) => [index("ticket_notes_ticket_idx").on(t.ticketId, t.createdAt), uniqueIndex("ticket_notes_external_idx").on(t.externalId)],
);

/** Work done on a portal ticket (minutes; the billing uses what is not billed yet) */
export const ticketTimeEntries = pgTable(
  "ticket_time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** "time:123": an Autotask time entry (same id as its work to bill) */
    externalId: text("external_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    author: text("author").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    minutes: integer("minutes").notNull(),
    offsetMinutes: integer("offset_minutes").notNull().default(0),
    summary: text("summary").notNull().default(""),
    internalText: text("internal_text").notNull().default(""),
    billable: boolean("billable").notNull().default(true),
    workType: text("work_type"),
    contractId: text("contract_id"),
    /** The number of the ticket it was entered on before that ticket was merged into this one */
    mergedFrom: text("merged_from"),
    /** Already billed (posted in Autotask before the switch): never billed again */
    billed: boolean("billed").notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("ticket_time_ticket_idx").on(t.ticketId), index("ticket_time_started_idx").on(t.startedAt), uniqueIndex("ticket_time_external_idx").on(t.externalId)],
);

/** Charges on a portal ticket (material, services…) */
export const ticketCharges = pgTable(
  "ticket_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** "charge:45": an Autotask charge */
    externalId: text("external_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    quantityX100: integer("quantity_x100").notNull().default(100),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }),
    billable: boolean("billable").notNull().default(true),
    type: text("type"),
    status: text("status"),
    materialCode: text("material_code"),
    productId: text("product_id"),
    contractId: text("contract_id"),
    date: text("date"),
    author: text("author"),
    billed: boolean("billed").notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("ticket_charges_ticket_idx").on(t.ticketId), uniqueIndex("ticket_charges_external_idx").on(t.externalId)],
);

/** Files of a portal ticket (base64, 5 MB each at most) */
export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    /** The file (null: Autotask could not give it when the tickets were copied) */
    data: text("data"),
    internal: boolean("internal").notNull().default(false),
    author: text("author").notNull().default(""),
    createdAt: created(),
  },
  (t) => [index("ticket_attachments_ticket_idx").on(t.ticketId), uniqueIndex("ticket_attachments_external_idx").on(t.externalId)],
);

export const ticketMeta = pgTable("ticket_meta", {
  ticketId: bigint("ticket_id", { mode: "number" }).primaryKey(),
  startDate: text("start_date"),
  /** HH:MM (Québec) on the start date, optional */
  startTime: text("start_time"),
  /** Restriction: no work on the ticket before its start date (off by default) */
  startLocked: boolean("start_locked").notNull().default(false),
  /** The portal's own queue (ticket_queues.key); none: worked out from the source, else the default queue */
  queue: text("queue"),
  /** A device of the portal's own (local_assets.id) linked to the ticket when the RMM / Autotask has none */
  localAsset: uuid("local_asset"),
  /** Where the ticket came from (ticket_sources.key); none: worked out from the source's own label, else phone */
  source: text("source"),
  /** The contract the ticket's work is billed on (client_contracts.id); none: the client's default support contract */
  contractId: uuid("contract_id"),
  /** Estimated time to resolve, in minutes (none: not estimated); set by a technician or by the AI */
  estimateMinutes: integer("estimate_minutes"),
  /** tech | ai */
  estimateSource: text("estimate_source"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updated(),
});

/**
 * The portal's own ticket queues (Admin › Files d'attente): not tied to Autotask. A ticket is in the one
 * stored on it (ticket_meta.queue), else the one its source suggests (an alert, a project), else the default.
 */
/**
 * Devices made in the portal for a client the RMM does not know (RMM / Autotask
 * devices stay the reference where they exist). Listed with the synced ones; id
 * on a ticket is "local:<id>".
 */
export const localAssets = pgTable("local_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: integer("company_id").notNull(),
  name: text("name").notNull(),
  type: text("type"),
  serial: text("serial"),
  hostname: text("hostname"),
  ip: text("ip"),
  os: text("os"),
  contactId: text("contact_id"),
  contactName: text("contact_name"),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
});

/**
 * Emails read from the support mailbox (Admin › Courriel entrant): each one is
 * claimed here before anything is done with it, so it never makes two tickets.
 * status: ticket (a ticket was opened), reply (added to the ticket named in its
 * subject), pending (nobody to match: a technician decides), ignored, skipped
 * (an automatic or looping message), error.
 */
export const mailIntake = pgTable(
  "mail_intake",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Graph message id */
    messageId: text("message_id").notNull(),
    mailbox: text("mailbox").notNull(),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    subject: text("subject"),
    body: text("body"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    status: text("status").notNull().default("processing"),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    companyId: integer("company_id"),
    contactId: text("contact_id"),
    note: text("note"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("mail_intake_message_idx").on(t.messageId), index("mail_intake_status_idx").on(t.status)],
);

/**
 * Where a ticket comes from (Admin › Sources): phone, text, email, in person to
 * start. A ticket made from an email is "email", from a text "sms", by phone or
 * by hand "phone".
 */
export const ticketSources = pgTable("ticket_sources", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

/**
 * How the source's ticket statuses (Autotask's list) are shown and offered
 * (Admin › Statuts): a label, a kind (colours, tiles, open / closed), an order,
 * and whether the status can still be picked. Statuses without a row keep the
 * source's own label and kind.
 */
export const ticketStatuses = pgTable("ticket_statuses", {
  /** The status value in the source */
  value: text("value").primaryKey(),
  label: text("label"),
  kind: text("kind"),
  position: integer("position").notNull().default(0),
  /** Not offered when changing a ticket's status (tickets already in it keep it) */
  hidden: boolean("hidden").notNull().default(false),
  updatedAt: updated(),
});

/**
 * The order the AI planned for a technician's tickets, kept when they apply the plan
 * (Tickets › sort "Planifié par l'IA"). Applying a new plan replaces it.
 */
export const ticketAiPlan = pgTable(
  "ticket_ai_plan",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    /** 0 = first */
    position: integer("position").notNull(),
    plannedAt: timestamp("planned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ticketId] })],
);

export const ticketQueues = pgTable("ticket_queues", {
  /** Stable id (a slug); the name can change */
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  /** Monitoring alerts: kept out of the gauges, the client portal and the automatic replies */
  alerts: boolean("alerts").notNull().default(false),
  /** Where a ticket goes when nothing says otherwise (one queue) */
  isDefault: boolean("is_default").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: created(),
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

/** AI results kept in the portal for a ticket (summary, next stepsâ€¦), visible to the team. */
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
    /** Shown as a button (a tile with its count) above the list */
    pinned: boolean("pinned").notNull().default(false),
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

/**
 * Local copy of the Autotask tickets (open + recently completed), as shown in
 * the portal. Kept in sync in the background (only what changed), so lists and
 * searches never wait for Autotask nor use its hourly quota.
 */
export const autotaskTickets = pgTable(
  "autotask_tickets",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    lastActivity: timestamp("last_activity", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("autotask_tickets_activity_idx").on(t.lastActivity)],
);

// â”€â”€ Store inventory (products sold by AKAB, kept in the portal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/** A product for sale. Money in cents. Optionally linked to an Autotask product. */
export const storeProducts = pgTable(
  "store_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    manufacturer: text("manufacturer"),
    category: text("category"),
    priceCents: integer("price_cents").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    /** Reorder point: total stock at or under it shows as low */
    minQuantity: integer("min_quantity").notNull().default(0),
    /** Autotask product and material code used when it is charged on a ticket */
    autotaskProductId: bigint("autotask_product_id", { mode: "number" }),
    autotaskProductName: text("autotask_product_name"),
    materialCodeId: text("material_code_id"),
    /** The QuickBooks item with the same SKU */
    quickbooksItemId: text("quickbooks_item_id"),
    /** Counted by serial number: each unit is a store_serials row */
    serialized: boolean("serialized").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("store_products_sku_unique").on(t.sku), index("store_products_name_idx").on(t.name)],
);

/** Where stock is kept (warehouse, a technician's truckâ€¦). */
export const storeLocations = pgTable(
  "store_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex("store_locations_name_unique").on(t.name)],
);

/** Quantity on hand of a product at a location. */
export const storeStock = pgTable(
  "store_stock",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => storeLocations.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.locationId] })],
);

/** Every stock change: received, adjusted (count), used on a ticket. */
export const storeMovements = pgTable(
  "store_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => storeLocations.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    kind: text("kind", { enum: ["receive", "adjust", "ticket"] }).notNull(),
    note: text("note").notNull().default(""),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    /** The purchase it came from (received stock) */
    receiptId: uuid("receipt_id").references((): AnyPgColumn => storeReceipts.id, { onDelete: "set null" }),
    /** Serial numbers moved (serialized products) */
    serials: jsonb("serials").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("store_movements_product_idx").on(t.productId, t.createdAt)],
);

/** A purchase received in stock: where it was bought, at what cost. */
export const storeReceipts = pgTable(
  "store_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => storeLocations.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    supplier: text("supplier"),
    /** Supplier invoice or purchase order number */
    reference: text("reference"),
    purchasedAt: text("purchased_at"),
    note: text("note").notNull().default(""),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("store_receipts_product_idx").on(t.productId, t.createdAt), index("store_receipts_supplier_idx").on(t.supplier)],
);

/** One unit of a serialized product: where it is, or which ticket it went to. */
export const storeSerials = pgTable(
  "store_serials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    serial: text("serial").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => storeLocations.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["in_stock", "used", "removed"] }).notNull().default("in_stock"),
    receiptId: uuid("receipt_id").references(() => storeReceipts.id, { onDelete: "set null" }),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    note: text("note").notNull().default(""),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("store_serials_product_serial_unique").on(t.productId, t.serial), index("store_serials_stock_idx").on(t.productId, t.locationId, t.status)],
);

/**
 * Who wrote what in Autotask from the portal (notes, time entries): the
 * activity shows the technician even when Autotask records the portal's API
 * user as the author (impersonation refused).
 */
export const autotaskAuthors = pgTable(
  "autotask_authors",
  {
    entity: text("entity", { enum: ["note", "time"] }).notNull(),
    autotaskId: bigint("autotask_id", { mode: "number" }).notNull(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.entity, t.autotaskId] }), index("autotask_authors_ticket_idx").on(t.ticketId)],
);

// â”€â”€ Planning: tickets pinned to a technician, time reserved on their calendar â”€â”€
/** A priority: a ticket an admin gives a technician for a day or a week, with a direction. */
export const ticketPins = pgTable(
  "ticket_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    ticketNumber: text("ticket_number").notNull(),
    ticketTitle: text("ticket_title").notNull(),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Direction for the technician (what to do, how, by when) */
    note: text("note").notNull().default(""),
    /** Daily or weekly priority, for that day / the week starting that Monday (YYYY-MM-DD) */
    horizon: text("horizon", { enum: ["day", "week"] }).notNull().default("week"),
    forDate: text("for_date").notNull(),
    /** Marked done by the technician */
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** All-day event in the technician's Microsoft 365 calendar (priority of the day) */
    o365EventId: text("o365_event_id"),
    /** Order in the technician's list (1 = first) */
    rank: integer("rank").notNull().default(0),
    pinnedBy: uuid("pinned_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ticket_pins_ticket_tech_unique").on(t.ticketId, t.technicianId), index("ticket_pins_tech_idx").on(t.technicianId)],
);

/** Time reserved by an admin on a technician's calendar (for a pinned ticket, or a reserved slot). */
export const calendarBlocks = pgTable(
  "calendar_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    title: text("title").notNull(),
    note: text("note").notNull().default(""),
    /** work: on a ticket (remote / workshop); onsite: service call at the client; slot: reserved time */
    kind: text("kind", { enum: ["work", "onsite", "slot"] }).notNull().default("work"),
    /** Client, for on-site service calls */
    companyName: text("company_name"),
    /** Alert this many minutes before (0 = none) */
    reminderMinutes: integer("reminder_minutes").notNull().default(15),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    /** The Autotask service call created for an on-site visit */
    autotaskServiceCallId: bigint("autotask_service_call_id", { mode: "number" }),
    /** The event created in the technician's Microsoft 365 calendar */
    o365EventId: text("o365_event_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("calendar_blocks_tech_time_idx").on(t.technicianId, t.startsAt)],
);

// â”€â”€ SMS (VoIP.ms): conversations with clients, seen by every technician â”€â”€
/** One conversation per client number (a new one after it is closed). */
export const smsConversations = pgTable(
  "sms_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Client number, 10 digits (North America) */
    phone: text("phone").notNull(),
    /** Who it is, when the number matches a contact */
    contactName: text("contact_name"),
    contactId: text("contact_id"),
    companyId: bigint("company_id", { mode: "number" }),
    companyName: text("company_name"),
    /** waiting: the client waits for a technician (auto ticket at the deadline); details: the client asked for a ticket (1), we asked what it is about; open: being handled; ticket: linked to a ticket; closed */
    status: text("status", { enum: ["waiting", "details", "open", "ticket", "closed"] }).notNull().default("waiting"),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    /** When it becomes a ticket if no technician replies */
    autoTicketAt: timestamp("auto_ticket_at", { withTimezone: true }),
    /** When the automatic reply went to the client in this conversation (none: not sent, e.g. one went out to the number less than 24 h before) */
    autoRepliedAt: timestamp("auto_replied_at", { withTimezone: true }),
    unread: integer("unread").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    lastPreview: text("last_preview").notNull().default(""),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("sms_conversations_phone_idx").on(t.phone, t.status), index("sms_conversations_last_idx").on(t.lastMessageAt)],
);

export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => smsConversations.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    body: text("body").notNull(),
    /** VoIP.ms message id (received) â€” a callback sent twice is kept once */
    providerId: text("provider_id"),
    /** Sent by a technician (null: the client, or an automatic message) */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    auto: boolean("auto").notNull().default(false),
    /** Sent to several people at once from a ticket: the same key on each person's copy */
    groupKey: text("group_key"),
    status: text("status", { enum: ["received", "sent", "failed"] }).notNull(),
    error: text("error"),
    createdAt: created(),
  },
  (t) => [index("sms_messages_conv_idx").on(t.conversationId, t.createdAt), uniqueIndex("sms_messages_provider_unique").on(t.providerId)],
);

/** Outlook module: a technician's own address book; everyone they write to is added automatically. */
export const mailContacts = pgTable(
  "mail_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Lower case */
    address: text("address").notNull(),
    name: text("name"),
    note: text("note"),
    /** Added by hand, or from a sent email */
    source: text("source", { enum: ["manual", "sent"] }).notNull().default("sent"),
    timesUsed: integer("times_used").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("mail_contacts_user_address_idx").on(t.userId, t.address)],
);

/** Outlook module: AKAB Microsoft 365 mailboxes a technician linked (only they see them). */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    displayName: text("display_name"),
    /** "user": through the technician's own Microsoft sign-in; "app": the organisation access (admins, shared mailboxes) */
    via: text("via", { enum: ["user", "app"] }).notNull().default("app"),
    /** The technician's folder layout: favourites on top (in order) and hidden folders */
    folderPrefs: jsonb("folder_prefs").$type<{ pinned: { id: string; name: string }[]; hidden: string[]; order?: string[] }>(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("mail_accounts_user_address_unique").on(t.userId, sql`lower(${t.address})`)],
);

/** Weekly meeting: projects in progress (e.g. a camera installation at a client). */
export const meetingProjects = pgTable("meeting_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  /** Client or place, free text */
  client: text("client"),
  /** YYYY-MM-DD */
  dueDate: text("due_date"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: updated(),
});

/** Notes taken on a project during the meetings, newest first. */
export const meetingProjectNotes = pgTable(
  "meeting_project_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => meetingProjects.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    createdAt: created(),
  },
  (t) => [index("meeting_project_notes_project_idx").on(t.projectId)],
);

/** Team members assigned to a meeting project. */
export const meetingProjectMembers = pgTable(
  "meeting_project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => meetingProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

/** Points to discuss with the team at the weekly meeting (pay due Tuesday, someone awayâ€¦). */
export const meetingPoints = pgTable("meeting_points", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The point itself (its title) */
  text: text("text").notNull(),
  /** Optional details: a description, or bullet points (lines starting with "- ") */
  details: text("details"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  /** Archived: gone from the list, kept in the archive at the bottom of the page */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Put off to a later meeting: hidden until this day (YYYY-MM-DD, Québec) */
  snoozeUntil: text("snooze_until"),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
  authorName: text("author_name").notNull(),
  createdAt: created(),
});

/**
 * What the automatic workflows did (Admin › Flux de travail): one row per
 * workflow and ticket — the unique key is what keeps a ticket from being
 * answered twice.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflow: text("workflow").notNull(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    ticketNumber: text("ticket_number").notNull().default(""),
    ticketTitle: text("ticket_title").notNull().default(""),
    toEmail: text("to_email"),
    /** pending: being sent · sent · failed · skipped (see reason) */
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("workflow_runs_ticket_idx").on(t.workflow, t.ticketId), index("workflow_runs_created_idx").on(t.workflow, t.createdAt)],
);

/** Notes taken on a point to discuss, oldest first. */
export const meetingPointNotes = pgTable(
  "meeting_point_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pointId: uuid("point_id")
      .notNull()
      .references(() => meetingPoints.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    createdAt: created(),
  },
  (t) => [index("meeting_point_notes_point_idx").on(t.pointId)],
);

/** Team absences (vacation, sick dayâ€¦), shown on the weekly meeting calendar. */
export const meetingAbsences = pgTable(
  "meeting_absences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD, both days included */
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    kind: text("kind", { enum: ["vacation", "sick", "training", "personal", "other"] }).notNull().default("vacation"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("meeting_absences_dates_idx").on(t.startDate, t.endDate)],
);

/** Coffee break: a game of chess between two team members (the position as FEN, the moves as PGN) */
/**
 * Complots (coffee break): a table of 2 to 6 colleagues. The host invites,
 * those who accept play; the game itself is the engine's JSON state
 * (server/lib/complots.ts), each player seeing only their own cards.
 */
export const complotsGames = pgTable(
  "complots_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** lobby | playing | done | cancelled */
    status: text("status").notNull().default("lobby"),
    /** Everyone asked, the host first: their answer (null: not yet) */
    seats: jsonb("seats").$type<{ id: string; name: string; answer: "yes" | "no" | null }[]>().notNull(),
    /** The 5 characters of this game, one per clan */
    chars: jsonb("chars").$type<string[]>().notNull(),
    state: jsonb("state").$type<Record<string, unknown>>(),
    winnerId: uuid("winner_id").references(() => users.id, { onDelete: "set null" }),
    /** Changes counter: a write is refused when someone else wrote first */
    rev: integer("rev").notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("complots_games_status_idx").on(t.status, t.updatedAt)],
);

export const chessGames = pgTable(
  "chess_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Who invited (plays white, moves first) */
    whiteId: uuid("white_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blackId: uuid("black_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** invited | playing | done | declined */
    status: text("status").notNull().default("invited"),
    fen: text("fen").notNull(),
    pgn: text("pgn").notNull().default(""),
    /** The last move, "e2e4" (shown on the board) */
    lastMove: text("last_move"),
    /** w | b | draw, once done */
    result: text("result"),
    /** checkmate | stalemate | draw | resign */
    endedBy: text("ended_by"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("chess_games_players_idx").on(t.whiteId, t.blackId)],
);

/** Coffee break time used per person and day (Québec), 30 minutes at most */
export const breakroomUsage = pgTable(
  "breakroom_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD in Québec */
    day: text("day").notNull(),
    usedSeconds: integer("used_seconds").notNull().default(0),
    lastBeatAt: timestamp("last_beat_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/** Weekly meeting: something on the team week (a team lunch, a client visit, a deadline…) */
export const meetingEvents = pgTable(
  "meeting_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** YYYY-MM-DD */
    date: text("date").notNull(),
    /** HH:MM, both empty for the whole day */
    startTime: text("start_time"),
    endTime: text("end_time"),
    title: text("title").notNull(),
    note: text("note"),
    /** Who it is for (none: the whole team) */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The ticket it is about (optional; number and title as read from the ticket source) */
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    ticketTitle: text("ticket_title"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("meeting_events_date_idx").on(t.date)],
);

/**
 * A technician's own Microsoft 365 sign-in (delegated access): what they
 * linked themselves (Outlook mail, calendar, later To Do). The refresh token
 * is sealed with APP_SECRET and never leaves the server.
 */
export const msConnections = pgTable("ms_connections", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Microsoft account (object id) and its address */
  msUserId: text("ms_user_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  refreshToken: text("refresh_token").notNull(),
  scopes: text("scopes").notNull().default(""),
  /** Set when Microsoft refused the token (sign in again) */
  lastError: text("last_error"),
  connectedAt: created(),
  updatedAt: updated(),
});

/**
 * Calendars shown in a technician's planning (tickets page), chosen by a
 * master admin: the technician's own, or anyone's, each with what it shows.
 * No row for a technician with the right: their own calendar, in detail.
 */
export const calendarLinks = pgTable(
  "calendar_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The planning it appears in */
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "user": the owner's Microsoft sign-in; "app": the organisation access to the mailbox */
    source: text("source", { enum: ["user", "app"] }).notNull(),
    /** Whose calendar (source "user"; also the name shown when busy) */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    /** Source "app": the mailbox */
    mailbox: text("mailbox"),
    /** A calendar of that mailbox; null = the main one */
    calendarId: text("calendar_id"),
    calendarName: text("calendar_name"),
    /** Name shown on its events when only busy times are shown */
    label: text("label").notNull(),
    display: text("display", { enum: ["details", "busy"] }).notNull().default("details"),
    /** Receives the portal's blocks and priorities of the day (one per technician) */
    push: boolean("push").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("calendar_links_technician").on(t.technicianId)],
);

/** Each request to Claude: who, for which part of the portal, which model, tokens and cost. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. "ticket.analyze" (see AI_FEATURES) */
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Cost in millionths of a US dollar */
    costMicros: integer("cost_micros").notNull().default(0),
    createdAt: created(),
  },
  (t) => [index("ai_usage_user_time").on(t.userId, t.createdAt), index("ai_usage_time").on(t.createdAt)],
);

// ── Timesheets and expenses (My tools; approved in Accounting) ──────────────────

/** Kinds of time on a timesheet. "labour" is the built-in one: time logged on tickets. */
export const timesheetTypes = pgTable("timesheet_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** labour (built in, from tickets) | workday (built in: start, end and lunch of the day, not counted in the hours worked) | bankpay (built in: hours paid out of the hours bank, taken off the bank, not hours worked) | other (entered by hand) */
  kind: text("kind").notNull().default("other"),
  active: boolean("active").notNull().default(true),
  position: integer("position").notNull().default(0),
  /** Counts as billable time in our stats (Admin › Temps et dépenses); ticket time is billable entry by entry */
  billable: boolean("billable").notNull().default(false),
  /** QuickBooks service item for its time activities */
  quickbooksItemId: text("quickbooks_item_id"),
  createdAt: created(),
  updatedAt: updated(),
});

/** Kinds of expenses, with their account (and a rate for those counted by unit, e.g. km). */
export const expenseTypes = pgTable("expense_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ledgerAccountId: uuid("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "set null" }),
  /** e.g. "km": counted by unit at the rate below */
  unit: text("unit"),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }),
  /** Billed to the client by default */
  billable: boolean("billable").notNull().default(false),
  active: boolean("active").notNull().default(true),
  position: integer("position").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

/**
 * A technician's expense kept as a favourite (the same trip, parking…):
 * one click fills a new expense with it.
 */
export const expenseFavorites = pgTable(
  "expense_favorites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => expenseTypes.id, { onDelete: "cascade" }),
    description: text("description").notNull().default(""),
    /** By unit (km…): the quantity; otherwise the amount */
    quantityX100: integer("quantity_x100"),
    amountCents: bigint("amount_cents", { mode: "number" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    billable: boolean("billable").notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("expense_favorites_user_idx").on(t.userId)],
);

/** A technician's week (Monday), submitted then approved. */
export const timesheets = pgTable(
  "timesheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Monday, YYYY-MM-DD */
    weekStart: text("week_start").notNull(),
    /** draft | submitted | approved | rejected | paid */
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    /** Paid by accounting (status "paid") */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "set null" }),
    quickbooksSyncedAt: timestamp("quickbooks_synced_at", { withTimezone: true }),
    quickbooksError: text("quickbooks_error"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("timesheets_user_week_idx").on(t.userId, t.weekStart)],
);

/** Time on a timesheet: from a ticket's time entry, or entered by hand. Hours ×100. */
export const timesheetEntries = pgTable(
  "timesheet_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD */
    date: text("date").notNull(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => timesheetTypes.id, { onDelete: "restrict" }),
    hoursX100: integer("hours_x100").notNull(),
    note: text("note"),
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    ticketTitle: text("ticket_title"),
    /** A work day (type workday): HH:MM, and the lunch in minutes (30 or 60) taken off */
    startTime: text("start_time"),
    endTime: text("end_time"),
    lunchMinutes: integer("lunch_minutes"),
    /** The hours of this entry that count as billable (ticket time: worked − offset, or 0 when not billed); none: by its type */
    billableX100: integer("billable_x100"),
    /** Banked instead of paid: the hours go to the person's hours bank */
    banked: boolean("banked").notNull().default(false),
    /** The contract the time was logged on (client_contracts.id) */
    contractId: uuid("contract_id"),
    /** ticket | manual */
    source: text("source").notNull().default("manual"),
    createdAt: created(),
  },
  (t) => [index("timesheet_entries_user_date_idx").on(t.userId, t.date)],
);

/** An expense claim (with its receipt), approved then reimbursed; billable ones go on the client's invoice. */
/**
 * An expense report: items added one by one while it is open, then submitted
 * together. Each item is still approved (or refused) on its own; a refused
 * item opens the report again (submitted_at back to null).
 */
export const expenseReports = pgTable(
  "expense_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** The days it covers (YYYY-MM-DD, both included); every item's date is within */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    /** null: open (items can be added, changed, removed) */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** The Autotask expense report it was copied from (the final sync): a second pass updates it */
    autotaskId: bigint("autotask_id", { mode: "number" }),
    /** When it was last copied; changed in the portal since: a second pass keeps the portal's version */
    autotaskSyncedAt: timestamp("autotask_synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("expense_reports_user_idx").on(t.userId), uniqueIndex("expense_reports_autotask_idx").on(t.autotaskId)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The report it is part of (every expense has one; older ones got their own) */
    reportId: uuid("report_id").references(() => expenseReports.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => expenseTypes.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    quantityX100: integer("quantity_x100").notNull().default(100),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull().default(0),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull().default(0),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    billable: boolean("billable").notNull().default(false),
    /** draft | submitted | approved | rejected */
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    /** Paid by accounting (status "paid") */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "set null" }),
    /** The work to bill made from it (billable ones) */
    billingItemId: uuid("billing_item_id").references(() => billingItems.id, { onDelete: "set null" }),
    receiptName: text("receipt_name"),
    receiptType: text("receipt_type"),
    /** The receipt file, base64 */
    receiptData: text("receipt_data"),
    quickbooksId: text("quickbooks_id"),
    quickbooksSyncedAt: timestamp("quickbooks_synced_at", { withTimezone: true }),
    quickbooksError: text("quickbooks_error"),
    /** The Autotask expense item it was copied from (the final sync) */
    autotaskId: bigint("autotask_id", { mode: "number" }),
    autotaskSyncedAt: timestamp("autotask_synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("expenses_user_idx").on(t.userId, t.date), index("expenses_status_idx").on(t.status), uniqueIndex("expenses_autotask_idx").on(t.autotaskId)],
);

/**
 * Files made from Autotask's data by the final sync (time sheets as CSV), kept
 * in the portal so they can still be downloaded once the connection is closed.
 */
export const autotaskExports = pgTable("autotask_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** timesheets-detail | timesheets-weeks */
  kind: text("kind").notNull(),
  filename: text("filename").notNull(),
  /** The period it starts at (YYYY-MM-DD) */
  since: text("since").notNull(),
  content: text("content").notNull(),
  rows: integer("rows").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
});

/** Card payment links made for invoices (Accounting › Paiements, Stripe Checkout). Money in cents. */
export const stripeCheckouts = pgTable(
  "stripe_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => clientInvoices.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    url: text("url").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    /** open | paid | expired | failed */
    status: text("status").notNull().default("open"),
    /** Made with a live key (real money) or a test key */
    live: boolean("live").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("stripe_checkouts_session_idx").on(t.sessionId), index("stripe_checkouts_invoice_idx").on(t.invoiceId)],
);

/** Contract types set up in Admin › Types de contrats: a name over one of four ways to bill (kind) */
export const contractTypes = pgTable(
  "contract_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** recurring (monthly service) | hourly | banked (block of hours) | fixed (fixed price) */
    kind: text("kind").notNull(),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("contract_types_key_idx").on(t.key)],
);

/** Services the company sells (Services, under Inventory): the catalogue, with no stock */
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** one_time | recurring (monthly) | recurring_yearly */
    kind: text("kind").notNull().default("one_time"),
    priceCents: integer("price_cents").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    taxable: boolean("taxable").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("services_name_idx").on(t.name)],
);

/** Vendors (Admin › PSA › Fournisseurs). Mapped by hand to QuickBooks vendors, never synced with them. */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    /** The QuickBooks vendor it is mapped to (never two vendors on the same one) */
    quickbooksId: text("quickbooks_id"),
    qbSyncedAt: timestamp("qb_synced_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("vendors_quickbooks_idx").on(t.quickbooksId), index("vendors_name_idx").on(t.name)],
);

/** The week ahead written for the Monday meeting (a few bullets and management suggestions), one per week */
export const meetingWeekBriefs = pgTable("meeting_week_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The Monday (YYYY-MM-DD) */
  weekStart: text("week_start").notNull().unique(),
  bullets: jsonb("bullets").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  suggestions: jsonb("suggestions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  source: text("source", { enum: ["ai", "rules"] }).notNull().default("rules"),
  generatedBy: uuid("generated_by").references(() => users.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Pipeline: the team's to-do list and each technician's day ──
/** A to-do: shared by the team, assigned to someone (or nobody), with a checklist, notes, a parent and a task it waits for. */
export const pipelineTasks = pgTable(
  "pipeline_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** Instructions / notes written on the task */
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: ["todo", "doing", "blocked", "done"] }).notNull().default("todo"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** A subtask of this task: the parent is done only when every subtask is */
    parentId: uuid("parent_id").references((): AnyPgColumn => pipelineTasks.id, { onDelete: "set null" }),
    /** This task cannot start or be finished before that one is done */
    blockedById: uuid("blocked_by_id").references((): AnyPgColumn => pipelineTasks.id, { onDelete: "set null" }),
    /** YYYY-MM-DD */
    dueDate: text("due_date"),
    /** HH:MM (Québec) on the due day, optional */
    dueTime: text("due_time"),
    /** Not to be started before this day (YYYY-MM-DD) and time (HH:MM), optional */
    startDate: text("start_date"),
    startTime: text("start_time"),
    estimateMinutes: integer("estimate_minutes"),
    /** Free labels, to find and filter */
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** team: everyone who sees the Pipeline; private: the one who made it and the one it is assigned to; selected: those and the people chosen (pipeline_task_viewers) */
    visibility: text("visibility", { enum: ["team", "private", "selected"] }).notNull().default("team"),
    /** Comes back after it is done (see shared/recurrence.ts); the next one is made when this one is completed */
    recurrence: jsonb("recurrence").$type<{ freq: "daily" | "weekly" | "monthly" | "yearly"; interval: number; weekdays?: number[]; until?: string | null } | null>(),
    /** The first task of a recurring series (every occurrence points at it) */
    seriesId: uuid("series_id"),
    /** A ticket the task is about (only its id comes from the browser) */
    ticketId: bigint("ticket_id", { mode: "number" }),
    ticketNumber: text("ticket_number"),
    ticketTitle: text("ticket_title"),
    position: integer("position").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("pipeline_tasks_assignee_idx").on(t.assigneeId, t.status), index("pipeline_tasks_parent_idx").on(t.parentId), index("pipeline_tasks_due_idx").on(t.dueDate)],
);

export const pipelineChecklist = pgTable(
  "pipeline_checklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => pipelineTasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: created(),
  },
  (t) => [index("pipeline_checklist_task_idx").on(t.taskId, t.position)],
);

/** The people a "selected" task is shared with, besides who made it and who has it */
export const pipelineTaskViewers = pgTable(
  "pipeline_task_viewers",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => pipelineTasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
);

/** Files attached to a task (base64, 5 MB each at most) */
export const pipelineTaskFiles = pgTable(
  "pipeline_task_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => pipelineTasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    data: text("data").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index("pipeline_task_files_task_idx").on(t.taskId)],
);

/** Comments on a task (what was done, questions, instructions added later) */
export const pipelineTaskNotes = pgTable(
  "pipeline_task_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => pipelineTasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    author: text("author").notNull().default(""),
    text: text("text").notNull(),
    createdAt: created(),
  },
  (t) => [index("pipeline_task_notes_task_idx").on(t.taskId, t.createdAt)],
);

/** One technician's day as planned (a suggestion, not a calendar): the AI's summary and the time blocks. */
export const pipelineDayPlans = pgTable(
  "pipeline_day_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (Québec) */
    date: text("date").notNull(),
    summary: text("summary").notNull().default(""),
    blocks: jsonb("blocks").$type<PipelineBlock[]>().notNull().default(sql`'[]'::jsonb`),
    /** Minutes available that day (work hours less absences and events) and minutes of work to place */
    capacityMinutes: integer("capacity_minutes").notNull().default(0),
    plannedMinutes: integer("planned_minutes").notNull().default(0),
    /** The technician's Microsoft 365 calendar when the plan was made: ok (read), none (no calendar linked or Microsoft 365 off), or the error */
    calendar: text("calendar").notNull().default("none"),
    calendarEvents: integer("calendar_events").notNull().default(0),
    /** ai: written by the AI; rules: laid out by the portal's own rules (AI off or failed) */
    source: text("source", { enum: ["ai", "rules"] }).notNull().default("rules"),
    smsSentAt: timestamp("sms_sent_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("pipeline_day_plans_user_date_unique").on(t.userId, t.date)],
);

export type PipelineBlock = {
  start: string;
  end: string;
  title: string;
  kind: "task" | "ticket" | "event" | "break";
  /** The task id, or the ticket id */
  refId: string | null;
  ticketNumber?: string | null;
  priority?: string | null;
  /** The AI's reason, in a few words */
  note?: string | null;
  /** Did not fit in the day */
  overflow?: boolean;
  /** A priority pinned for the technician: of the day, or of the week */
  pinned?: "day" | "week";
  /** An event of the technician's Microsoft 365 calendar (not one the portal reserved) */
  o365?: boolean;
  /** An event that lasts the whole day (it does not take hours off) */
  allDay?: boolean;
  /** Not shown in detail to this viewer (a private event or task) */
  masked?: boolean;
};

// ── Quotes (soumissions) ──────────────────────────────────────────────────────
/**
 * A quote for a client (or a prospect not yet in the CRM). Lines are typed on
 * the spot or picked from the inventory; the totals are always computed from
 * the lines. Money in cents, quantities ×100.
 */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "S-1001": the next one is the highest + 1 */
    number: text("number").notNull(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Who it is for when there is no client yet */
    prospectName: text("prospect_name"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    title: text("title").notNull().default(""),
    /** draft | sent | accepted | declined */
    status: text("status").notNull().default("draft"),
    /** standard | site_visit (a new client: the IT checklist is filled in during the visit) */
    kind: text("kind").notNull().default("standard"),
    /** The answers of the site visit checklist, by field key (shared/quoteSurvey.ts) */
    survey: jsonb("survey").$type<Record<string, string>>().notNull().default({}),
    /** YYYY-MM-DD */
    issuedOn: text("issued_on").notNull(),
    validUntil: text("valid_until"),
    /** GST / QST charged on the taxable lines (false: exempt) */
    taxes: boolean("taxes").notNull().default(true),
    /** Shown to the client */
    notes: text("notes"),
    /** Internal only */
    internalNotes: text("internal_notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** The technician who prepared it: shown on the sheet (starts as who created it) */
    preparedBy: uuid("prepared_by").references(() => users.id, { onDelete: "set null" }),
    /** The project ticket made from this quote (Vente › Dernières soumissions) and its point in the weekly meeting */
    projectTicketId: bigint("project_ticket_id", { mode: "number" }),
    projectTicketNumber: text("project_ticket_number"),
    meetingPointId: uuid("meeting_point_id").references(() => meetingPoints.id, { onDelete: "set null" }),
    projectAt: timestamp("project_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("quotes_number_unique").on(t.number), index("quotes_client_idx").on(t.clientId), index("quotes_status_idx").on(t.status, t.issuedOn)],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    /** The inventory product it came from (null: typed on the spot) */
    productId: uuid("product_id").references(() => storeProducts.id, { onDelete: "set null" }),
    sku: text("sku"),
    description: text("description").notNull(),
    quantityX100: integer("quantity_x100").notNull().default(100),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull().default(0),
    /** What it costs AKAB, for the margin (internal) */
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull().default(0),
    taxable: boolean("taxable").notNull().default(true),
    /** An option offered to the client: shown, but not in the total */
    optional: boolean("optional").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("quote_lines_quote_idx").on(t.quoteId, t.position), index("quote_lines_product_idx").on(t.productId)],
);

/** A person's Passbolt private key, still protected by their passphrase (sealed again with the portal's secret). The server never has the passphrase. */
export const passboltKeys = pgTable("passbolt_keys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  armoredSealed: text("armored_sealed").notNull(),
  /** Their user id in Passbolt (needed to sign in) */
  passboltUserId: text("passbolt_user_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  updatedAt: updated(),
});

/** The checklist of a ticket: tasks to complete before the ticket can be; an item can wait for another item of the same ticket */
export const ticketChecklist = pgTable(
  "ticket_checklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: integer("ticket_id").notNull(),
    text: text("text").notNull(),
    position: integer("position").notNull().default(0),
    done: boolean("done").notNull().default(false),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: uuid("done_by").references(() => users.id, { onDelete: "set null" }),
    /** Another item of the same ticket that must be done first */
    dependsOnId: uuid("depends_on_id").references((): AnyPgColumn => ticketChecklist.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("ticket_checklist_ticket_idx").on(t.ticketId, t.position)],
);
