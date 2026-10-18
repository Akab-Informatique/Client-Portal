import { BarChart3, BookOpen, ClipboardCheck, Building2, CalendarCheck, Clock, FileSignature, LayoutDashboard, Mail, Megaphone, MonitorSmartphone, Receipt, Store, Ticket, Wallet, type LucideIcon } from "lucide-react";
import type { PermissionKey } from "@shared/permissions";

/**
 * Sidebar modules for the AKAB team. Add a module here (plus its rights in
 * shared/permissions.ts and its route in App.tsx) to make it appear.
 * `upcoming` modules are shown greyed out as a roadmap.
 * `section` groups them in the sidebar (in the order of NAV_SECTIONS).
 */
export const NAV_SECTIONS = [
  { key: "team", labelKey: "nav.team" },
  { key: "tools", labelKey: "nav.myTools" },
  { key: "command", labelKey: "nav.commandCenter" },
  { key: "management", labelKey: "nav.management" },
  { key: "accounting", labelKey: "nav.accounting" },
] as const;
export type NavSection = (typeof NAV_SECTIONS)[number]["key"];

export type NavModule = {
  key: string;
  path: string;
  labelKey: string;
  icon: LucideIcon;
  section: NavSection;
  permission?: PermissionKey;
  /** Shown only once the user turned it on (profile › Microsoft 365) */
  optIn?: "outlook";
  upcoming?: boolean;
};

export const STAFF_MODULES: NavModule[] = [
  { key: "dashboard", path: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, section: "team", permission: "dashboard.view" },
  { key: "messages", path: "/messages", labelKey: "nav.messages", icon: Megaphone, section: "command", permission: "messages.view" },
  { key: "outlook", path: "/outlook", labelKey: "nav.outlook", icon: Mail, section: "tools", permission: "outlook.view", optIn: "outlook" },
  { key: "timesheets", path: "/timesheets", labelKey: "nav.timesheets", icon: Clock, section: "tools", permission: "timesheets.use" },
  { key: "expenses", path: "/expenses", labelKey: "nav.expenses", icon: Wallet, section: "tools", permission: "timesheets.use" },
  { key: "tickets", path: "/tickets", labelKey: "nav.tickets", icon: Ticket, section: "command", permission: "tickets.view" },
  { key: "crm", path: "/crm", labelKey: "nav.crmClients", icon: Building2, section: "management", permission: "crm.view" },
  { key: "invoices", path: "/accounting/invoices", labelKey: "nav.invoices", icon: Receipt, section: "accounting", permission: "accounting.view" },
  { key: "approvals", path: "/accounting/approvals", labelKey: "nav.approvals", icon: ClipboardCheck, section: "accounting", permission: "accounting.view" },
  { key: "quotes", path: "/accounting/quotes", labelKey: "nav.quotes", icon: FileSignature, section: "accounting", permission: "accounting.view" },
  { key: "store", path: "/store", labelKey: "nav.store", icon: Store, section: "management", permission: "store.view" },
  { key: "reports", path: "/reports", labelKey: "nav.reports", icon: BarChart3, section: "management", upcoming: true },
  { key: "meetings", path: "/meetings", labelKey: "nav.meetings", icon: CalendarCheck, section: "team", permission: "meetings.view" },
  { key: "devices", path: "/devices", labelKey: "nav.devices", icon: MonitorSmartphone, section: "command", upcoming: true },
  { key: "documentation", path: "/documentation", labelKey: "nav.documentation", icon: BookOpen, section: "command", upcoming: true },
];
