import { FilePlus2, HeartHandshake, MessagesSquare, History, Workflow, Coffee, BarChart3, BookOpen, FolderKanban, ClipboardCheck, Building2, CalendarCheck, Clock, FileSignature, LayoutDashboard, Mail, Megaphone, MonitorSmartphone, Receipt, KeyRound, Store, Target, Ticket, Wallet, TrendingUp, Wrench, type LucideIcon } from "lucide-react";
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
  { key: "sales", labelKey: "nav.sales" },
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
  /** Also needs this right, or else the rule (e.g. the timesheet only for those who fill one) */
  orRight?: PermissionKey;
  rule?: "timesheetRequired" | "passbolt";
  upcoming?: boolean;
  /** A collapsible sub-menu inside its section (the entries of one group sit under its header) */
  group?: "security";
};

/** The sub-menus inside a section */
export const NAV_GROUPS = { security: { labelKey: "nav.security" } } as const;

export const STAFF_MODULES: NavModule[] = [
  { key: "dashboard", path: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, section: "team", permission: "dashboard.view" },
  { key: "messages", path: "/messages", labelKey: "nav.messages", icon: Megaphone, section: "command", permission: "messages.view" },
  { key: "pipeline", path: "/pipeline", labelKey: "nav.pipeline", icon: Workflow, section: "command", permission: "pipeline.view" },
  { key: "chat", path: "/chat", labelKey: "nav.chat", icon: MessagesSquare, section: "tools", permission: "chat.use" },
  { key: "outlook", path: "/outlook", labelKey: "nav.outlook", icon: Mail, section: "tools", permission: "outlook.view", optIn: "outlook" },
  { key: "timesheets", path: "/timesheets", labelKey: "nav.timesheets", icon: Clock, section: "tools", permission: "timesheets.use", orRight: "timesheets.manage", rule: "timesheetRequired" },
  { key: "expenses", path: "/expenses", labelKey: "nav.expenses", icon: Wallet, section: "tools", permission: "timesheets.use" },
  { key: "tickets", path: "/tickets", labelKey: "nav.tickets", icon: Ticket, section: "command", permission: "tickets.view" },
  { key: "crm", path: "/crm", labelKey: "nav.crmClients", icon: Building2, section: "management", permission: "crm.view" },
  { key: "invoices", path: "/accounting/invoices", labelKey: "nav.invoices", icon: Receipt, section: "accounting", permission: "accounting.view" },
  { key: "approvals", path: "/accounting/approvals", labelKey: "nav.approvals", icon: ClipboardCheck, section: "accounting", permission: "accounting.view" },
  { key: "sales", path: "/sales", labelKey: "nav.salesDashboard", icon: TrendingUp, section: "sales", permission: "opportunities.view" },
  { key: "quotes", path: "/accounting/quotes", labelKey: "nav.quotesLatest", icon: History, section: "sales", permission: "quotes.view" },
  { key: "marketing", path: "/marketing", labelKey: "nav.marketing", icon: Target, section: "sales", upcoming: true },
  { key: "quotesNew", path: "/accounting/quotes/new", labelKey: "nav.quotesNew", icon: FilePlus2, section: "sales", permission: "quotes.manage" },
  { key: "store", path: "/store", labelKey: "nav.store", icon: Store, section: "management", permission: "store.view" },
  { key: "hr", path: "/hr", labelKey: "nav.hr", icon: HeartHandshake, section: "management", permission: "hr.manage" },
  { key: "services", path: "/services", labelKey: "nav.services", icon: Wrench, section: "management", permission: "services.view" },
  { key: "projects", path: "/projects", labelKey: "nav.projects", icon: FolderKanban, section: "command", permission: "projects.view" },
  { key: "passbolt", path: "/security/passbolt", labelKey: "nav.passbolt", icon: KeyRound, section: "command", group: "security", permission: "passbolt.use", rule: "passbolt" },
  { key: "reports", path: "/reports", labelKey: "nav.reports", icon: BarChart3, section: "management", upcoming: true },
  { key: "meetings", path: "/meetings", labelKey: "nav.meetings", icon: CalendarCheck, section: "team", permission: "meetings.view" },
  { key: "breakroom", path: "/breakroom", labelKey: "nav.breakroom", icon: Coffee, section: "team", permission: "breakroom.use" },
  { key: "devices", path: "/devices", labelKey: "nav.devices", icon: MonitorSmartphone, section: "command", upcoming: true },
  { key: "documentation", path: "/documentation", labelKey: "nav.documentation", icon: BookOpen, section: "command", upcoming: true },
];

/**
 * Client portal sidebar (client users, and technicians in client view).
 * Laid out like the client rights (ACCESS_LAYOUT): a page shows only to whom
 * has its right, even while it is `upcoming` (greyed out, not linked yet).
 */
export const CLIENT_NAV_SECTIONS = [
  { key: "board", labelKey: "client.nav.boardSection" },
  { key: "operations", labelKey: "client.nav.operationsSection" },
  { key: "accounting", labelKey: "client.nav.accountingSection" },
] as const;
export type ClientNavSection = (typeof CLIENT_NAV_SECTIONS)[number]["key"];
export type ClientNavModule = Omit<NavModule, "section" | "optIn"> & { section: ClientNavSection };

export const CLIENT_MODULES: ClientNavModule[] = [
  { key: "board", path: "/", labelKey: "client.nav.board", icon: Megaphone, section: "board", permission: "board.view" },
  { key: "tickets", path: "/tickets", labelKey: "client.nav.tickets", icon: Ticket, section: "operations", permission: "clientTickets.view" },
  { key: "devices", path: "/devices", labelKey: "client.nav.devices", icon: MonitorSmartphone, section: "operations", permission: "clientDevices.view", upcoming: true },
  { key: "documentation", path: "/documentation", labelKey: "client.nav.documentation", icon: BookOpen, section: "operations", permission: "clientDocs.view", upcoming: true },
  { key: "invoices", path: "/invoices", labelKey: "client.nav.invoices", icon: Receipt, section: "accounting", permission: "clientInvoices.view", upcoming: true },
  { key: "quotes", path: "/quotes", labelKey: "client.nav.quotes", icon: FileSignature, section: "accounting", permission: "clientQuotes.view", upcoming: true },
];
