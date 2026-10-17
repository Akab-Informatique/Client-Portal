import { BookOpen, CalendarCheck, LayoutDashboard, Mail, Megaphone, MonitorSmartphone, Store, Ticket, Users, type LucideIcon } from "lucide-react";
import type { PermissionKey } from "@shared/permissions";

/**
 * Sidebar modules for the AKAB team. Add a module here (plus its rights in
 * shared/permissions.ts and its route in App.tsx) to make it appear.
 * `upcoming` modules are shown greyed out as a roadmap.
 * `section` groups them in the sidebar (in the order of NAV_SECTIONS).
 */
export const NAV_SECTIONS = [
  { key: "modules", labelKey: "nav.modules" },
  { key: "command", labelKey: "nav.commandCenter" },
  { key: "administration", labelKey: "nav.administration" },
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
  { key: "dashboard", path: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, section: "modules", permission: "dashboard.view" },
  { key: "messages", path: "/messages", labelKey: "nav.messages", icon: Megaphone, section: "modules", permission: "messages.view" },
  { key: "outlook", path: "/outlook", labelKey: "nav.outlook", icon: Mail, section: "modules", permission: "outlook.view", optIn: "outlook" },
  { key: "tickets", path: "/tickets", labelKey: "nav.tickets", icon: Ticket, section: "command", permission: "tickets.view" },
  { key: "store", path: "/store", labelKey: "nav.store", icon: Store, section: "administration", permission: "store.view" },
  { key: "meetings", path: "/meetings", labelKey: "nav.meetings", icon: CalendarCheck, section: "administration", permission: "meetings.view" },
  { key: "clients", path: "/clients", labelKey: "nav.clients", icon: Users, section: "modules", upcoming: true },
  { key: "documentation", path: "/documentation", labelKey: "nav.documentation", icon: BookOpen, section: "modules", upcoming: true },
  { key: "devices", path: "/devices", labelKey: "nav.devices", icon: MonitorSmartphone, section: "modules", upcoming: true },
];
