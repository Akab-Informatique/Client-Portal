import type { Audience, PermissionKey } from "@shared/permissions";

export type Stage = "anonymous" | "mfa" | "mfa-setup" | "password" | "ready";

export type DashboardWidget = { id: string; type: string; size: "sm" | "md" | "lg" };

export type Me = {
  id: string;
  email: string;
  name: string;
  kind: Audience;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  /** Outlook calendar sync (allowed by an admin): the mailbox, and whether the integration is on */
  o365: { mailbox: string; active: boolean } | null;
  locale: "fr" | "en";
  notifyEmail: boolean;
  mfaEnabled: boolean;
  role: { id: string; slug: string | null; name: string; nameEn: string } | null;
  client: { id: string; name: string } | null;
  permissions: PermissionKey[];
  isAdmin: boolean;
  /** Set while a technician views the portal as a client (read only). */
  viewAs: { clientId: string; clientName: string } | null;
  realUser: { name: string; email: string } | null;
  /** Parts switched on for this server (Sécurité › Passbolt is off in production unless set) */
  features?: { passbolt: boolean };
  /** Fills in a weekly timesheet (set by an admin) */
  timesheetRequired: boolean;
  preferences: { dashboard: DashboardWidget[] | null; theme: "dark" | "light" | "system"; outlook: boolean; bankHours: boolean; notify: { email: boolean; sms: boolean; teams: boolean }; pushDetails: boolean };
};

export type AuthState = { stage: Stage; /** Phones that can approve this sign-in (while the second step is asked) */ push?: number; me?: Me | { name: string; email: string; locale: "fr" | "en" } };

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  kind: Audience;
  clientId: string | null;
  roleId: string | null;
  active: boolean;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  o365Email: string | null;
  locale: "fr" | "en";
  notifyEmail: boolean;
  timesheetRequired: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  overrides: { permission: string; effect: "allow" | "deny" }[];
};

export type Client = {
  id: string;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  /** The client portal is open for the whole company */
  portalEnabled: boolean;
  userCount: number;
  createdAt: string;
};

export type Role = {
  id: string;
  slug: string | null;
  audience: Audience;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  locked: boolean;
  userCount: number;
};

export type Message = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  audience: "all" | "selected";
  authorId: string | null;
  author: string | null;
  emailCopy: boolean;
  emailSent: number;
  clients: { id: string; name: string }[];
  readCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ClientOption = { id: string; name: string; code: string | null; notifyCount: number };

export type AuditEntry = {
  id: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
};
