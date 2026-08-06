import type { PermissionMap } from "@/lib/permissions";

export type UserRole = "admin" | "technician" | "client";

export type CompanyType = "internal" | "client";

export interface Company {
  id: number;
  name: string;
  type: CompanyType;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  autotask_company_id: string | null;
  /** JSON string of ClientDashboardLayout set by admin (nullable). */
  dashboard_layout: string | null;
  /** SharePoint site URL set by admin (private per client — never shared). */
  sharepoint_site_url: string | null;
  /** Optional folder path inside the document library. */
  sharepoint_folder_path: string | null;
  /**
   * Optional Entra tenant ID for this client's Graph auth.
   * Empty/null → use portal default MICROSOFT_TENANT_ID.
   */
  sharepoint_tenant_id: string | null;
  /**
   * Optional per-client Graph app (client) ID.
   * With sharepoint_client_secret → this company uses its own Entra app.
   */
  sharepoint_client_id: string | null;
  /** Optional per-client Graph app client secret. */
  sharepoint_client_secret: string | null;
  /** Optional Documentation section title. */
  documentation_title: string | null;
  /** When false/null with no URL, docs section is inactive. */
  documentation_enabled: boolean | null;
  /** IT Glue / MyGlue organization id for passwords vault */
  itglue_organization_id: string | null;
  /** ConnectBooster customer id for invoices / pay portal */
  connectbooster_customer_id: string | null;
  /** Optional per-company ConnectBooster portal URL override */
  connectbooster_portal_url: string | null;
  created_at: Date | string;
}

/** File/folder entry returned by the SharePoint browse API. */
export interface SharePointItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  webUrl: string | null;
  lastModified: string | null;
  mimeType: string | null;
  childCount?: number | null;
}

export interface StaffRole {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  /** JSON string of PermissionMap */
  permissions: string;
  is_system: boolean;
  active: boolean;
  created_at: Date | string;
}

/**
 * Client USER role for one company only (Standard, Billing contact, custom…).
 * Never shared across client companies. Users may hold several at once.
 */
export interface ClientRole {
  id: number;
  /** Owning client company id */
  company_id: number;
  name: string;
  slug: string;
  description: string | null;
  /** JSON string of ClientPermissionMap */
  permissions: string;
  is_system: boolean;
  active: boolean;
  created_at: Date | string;
}

/** Membership row: user ↔ role within one company. */
export interface ClientUserRole {
  id: number;
  user_id: number;
  role_id: number;
  company_id: number;
  created_at: Date | string;
}

/** Lightweight member row shown under a role group. */
export interface ClientRoleMember {
  user_id: number;
  name: string;
  email: string;
  active: boolean;
  /** True when this membership is the core Standard role */
  is_core?: boolean;
}

export interface User {
  id: number;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  company_id: number | null;
  active: boolean;
  /** FK to staff_roles for admin/technician accounts */
  staff_role_id: number | null;
  /**
   * Legacy single client role id (backfill / display fallback).
   * Effective access uses multi-role memberships.
   */
  client_role_id: number | null;
  /**
   * Per-user billing override for client accounts.
   * null = inherit from stacked roles; true/false = force on/off.
   */
  billing_access: boolean | null;
  job_title: string | null;
  phone: string | null;
  mobile: string | null;
  bio: string | null;
  /** Preferred UI language: "en" | "fr" */
  locale: string | null;
  /** Linked IT Glue / MyGlue user id (for password ACL) */
  itglue_user_id: string | null;
  /**
   * Receive message-board emails when staff posts with “send by email”.
   * null/undefined treated as true for legacy rows.
   */
  board_email_opt_in: boolean | null;
  /** MFA enrolled (authenticator app). Required for full portal access. */
  mfa_enabled: boolean | null;
  /** Base32 TOTP secret — never expose on PublicProfile / SessionUser. */
  mfa_totp_secret: string | null;
  /** JSON array of hashed recovery codes. */
  mfa_recovery_codes: string | null;
  mfa_email_code_hash: string | null;
  mfa_email_code_expires: string | null;
  created_at: Date | string;
}

/** Public profile fields safe to show inside the same company only. */
export type PublicProfile = Omit<
  User,
  | "password"
  | "mfa_totp_secret"
  | "mfa_recovery_codes"
  | "mfa_email_code_hash"
  | "mfa_email_code_expires"
>;

export interface BoardMessage {
  id: number;
  company_id: number;
  author_id: number;
  author_name: string;
  title: string;
  body: string;
  pinned: boolean;
  created_at: Date | string;
}

export type MessageReadStatus = "unread" | "read";

export interface MessageUserState {
  id: number;
  message_id: number;
  user_id: number;
  status: MessageReadStatus;
  custom_label: string | null;
  updated_at: string | null;
  created_at: Date | string;
}

/** Board message + this client's personal state (default unread, no label). */
export interface BoardMessageWithState extends BoardMessage {
  readStatus: MessageReadStatus;
  customLabel: string | null;
  stateId: number | null;
}

export interface AutotaskTicket {
  id: number;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: number;
  statusLabel: string;
  priority: number | null;
  priorityLabel: string | null;
  createDate: string | null;
  dueDateTime: string | null;
  lastActivityDate: string | null;
  companyID: number | null;
  contactID?: number | null;
  createdByContactID?: number | null;
}

export interface AutotaskTicketNote {
  id: number;
  ticketID: number;
  title: string | null;
  description: string;
  noteType: number | null;
  noteTypeLabel: string | null;
  publish: number | null;
  publishLabel: string | null;
  createDateTime: string | null;
  lastActivityDate: string | null;
  creatorResourceID: number | null;
  createdByContactID: number | null;
  fromContact: boolean;
}

export interface TicketDetailResponse {
  ticket: AutotaskTicket;
  notes: AutotaskTicketNote[];
  configured: boolean;
  mock?: boolean;
  error?: string;
  statusLabels?: Record<string, string>;
  priorityLabels?: Record<string, string>;
}

export type SessionUser = Omit<
  User,
  | "password"
  | "mfa_totp_secret"
  | "mfa_recovery_codes"
  | "mfa_email_code_hash"
  | "mfa_email_code_expires"
> & {
  /** Resolved staff permissions (admin/technician only). */
  permissions: PermissionMap | null;
  /** Display name of assigned staff role, if any. */
  staff_role_name: string | null;
  staff_role_slug: string | null;
  /** Authenticator MFA fully enrolled. */
  mfa_enabled: boolean;
  /** Primary / display client role label (usually Standard). */
  client_role_name: string | null;
  client_role_slug: string | null;
  /** All client role names assigned (Standard + additional groups). */
  client_role_names: string[];
  /** All client role slugs assigned. */
  client_role_slugs: string[];
  /** Effective billing access for client portal users (stacked + override). */
  billing_enabled: boolean;
  /** Stacked client section permissions (board, tickets, docs, …). */
  client_permissions: import("@/lib/client-permissions").ClientPermissionMap | null;
};

/** Suggested quick labels clients can apply to board messages */
export const MESSAGE_LABEL_PRESETS = [
  "Important",
  "Follow up",
  "Waiting on us",
  "Done",
  "Archive",
] as const;
