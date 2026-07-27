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
  job_title: string | null;
  phone: string | null;
  mobile: string | null;
  bio: string | null;
  /** Preferred UI language: "en" | "fr" */
  locale: string | null;
  created_at: Date | string;
}

/** Public profile fields safe to show inside the same company only. */
export type PublicProfile = Omit<User, "password">;

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

export type SessionUser = Omit<User, "password"> & {
  /** Resolved staff permissions (admin/technician only). */
  permissions: PermissionMap | null;
  /** Display name of assigned staff role, if any. */
  staff_role_name: string | null;
  staff_role_slug: string | null;
};

/** Suggested quick labels clients can apply to board messages */
export const MESSAGE_LABEL_PRESETS = [
  "Important",
  "Follow up",
  "Waiting on us",
  "Done",
  "Archive",
] as const;
