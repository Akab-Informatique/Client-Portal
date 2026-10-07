import { BookOpen, LayoutDashboard, Megaphone, MonitorSmartphone, Ticket, Users, type LucideIcon } from "lucide-react";
import type { PermissionKey } from "@shared/permissions";

/**
 * Sidebar modules for the AKAB team. Add a module here (plus its rights in
 * shared/permissions.ts and its route in App.tsx) to make it appear.
 * `upcoming` modules are shown greyed out as a roadmap.
 */
export type NavModule = {
  key: string;
  path: string;
  labelKey: string;
  icon: LucideIcon;
  permission?: PermissionKey;
  upcoming?: boolean;
};

export const STAFF_MODULES: NavModule[] = [
  { key: "dashboard", path: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, permission: "dashboard.view" },
  { key: "messages", path: "/messages", labelKey: "nav.messages", icon: Megaphone, permission: "messages.view" },
  { key: "tickets", path: "/tickets", labelKey: "nav.tickets", icon: Ticket, upcoming: true },
  { key: "clients", path: "/clients", labelKey: "nav.clients", icon: Users, upcoming: true },
  { key: "documentation", path: "/documentation", labelKey: "nav.documentation", icon: BookOpen, upcoming: true },
  { key: "devices", path: "/devices", labelKey: "nav.devices", icon: MonitorSmartphone, upcoming: true },
];
