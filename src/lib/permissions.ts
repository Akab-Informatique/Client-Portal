/**
 * Staff (admin/technician) section permissions.
 * Clients are not governed by staff_roles — they use the client portal only.
 */

export const STAFF_PERMISSIONS = [
  "dashboard",
  "clients",
  "technicians",
  "roles",
  "users",
  "messages",
  "documentation",
  "passwords",
  "directory",
  "devices",
  "profiles",
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export type PermissionMap = Record<StaffPermission, boolean>;

/** Admin role — full access to every management section. */
export const ADMIN_PERMISSIONS: PermissionMap = {
  dashboard: true,
  clients: true,
  technicians: true,
  roles: true,
  users: true,
  messages: true,
  documentation: true,
  passwords: true,
  directory: true,
  devices: true,
  profiles: true,
};

/**
 * Default Technician role — day-to-day ops without staff/role administration.
 */
export const TECHNICIAN_PERMISSIONS: PermissionMap = {
  dashboard: true,
  clients: true,
  technicians: false,
  roles: false,
  users: true,
  messages: true,
  documentation: true,
  passwords: true,
  directory: true,
  devices: true,
  profiles: true,
};

export const EMPTY_PERMISSIONS: PermissionMap = {
  dashboard: false,
  clients: false,
  technicians: false,
  roles: false,
  users: false,
  messages: false,
  documentation: false,
  passwords: false,
  directory: false,
  devices: false,
  profiles: false,
};

export const SYSTEM_ROLE_SLUGS = {
  admin: "admin",
  technician: "technician",
} as const;

export function allPermissions(): PermissionMap {
  return { ...ADMIN_PERMISSIONS };
}

export function parsePermissions(raw: string | null | undefined): PermissionMap {
  const base: PermissionMap = { ...EMPTY_PERMISSIONS };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of STAFF_PERMISSIONS) {
      if (parsed[key] === true) base[key] = true;
    }
    return base;
  } catch {
    return base;
  }
}

export function serializePermissions(perms: PermissionMap): string {
  const out: PermissionMap = { ...EMPTY_PERMISSIONS };
  for (const key of STAFF_PERMISSIONS) {
    out[key] = !!perms[key];
  }
  return JSON.stringify(out);
}

export function hasPermission(
  perms: PermissionMap | null | undefined,
  permission: StaffPermission,
): boolean {
  return !!perms?.[permission];
}

/** First section the user is allowed to open (for redirects). */
export function firstAllowedAdminPath(perms: PermissionMap | null | undefined): string {
  const order: { perm: StaffPermission; path: string }[] = [
    { perm: "dashboard", path: "/admin" },
    { perm: "messages", path: "/admin/messages" },
    { perm: "documentation", path: "/admin/documentation" },
    { perm: "passwords", path: "/admin/passwords" },
    { perm: "devices", path: "/admin/devices" },
    { perm: "clients", path: "/admin/clients" },
    // Staff & Roles page self-gates technicians vs roles tabs — same path for both
    { perm: "technicians", path: "/admin/technicians" },
    { perm: "roles", path: "/admin/technicians" },
    { perm: "directory", path: "/admin/directory" },
    { perm: "profiles", path: "/admin/profile/me" },
  ];
  for (const item of order) {
    if (hasPermission(perms, item.perm)) return item.path;
  }
  return "/admin/profile/me";
}

/** Map a path segment under /admin to the required permission. */
export function permissionForAdminPath(pathname: string): StaffPermission | null {
  const path = pathname.replace(/\/+$/, "") || "/admin";
  if (path === "/admin") return "dashboard";
  if (path.startsWith("/admin/clients")) return "clients";
  /**
   * Staff & Roles is reachable with EITHER technicians OR roles permission.
   * Return null here so ProtectedRoute does not hard-require one of them
   * (which caused an infinite redirect loop for roles-only staff when the
   * fallback was `/admin/technicians?tab=roles` vs pathname `/admin/technicians`).
   * The page itself gates content.
   */
  if (path.startsWith("/admin/technicians")) return null;
  // Legacy users route redirects to clients
  if (path.startsWith("/admin/users")) return "clients";
  // General settings is open to any staff who can reach the admin shell
  if (path.startsWith("/admin/settings")) return null;
  // Client role templates — same gate as Clients management
  if (path.startsWith("/admin/client-roles")) return "clients";
  // To-do workspace is available to any signed-in staff
  if (path.startsWith("/admin/todo")) return null;
  // Admin billing placeholders — open to staff in admin shell
  if (path.startsWith("/admin/billing")) return null;
  // SOS queue is available to any signed-in staff
  if (path.startsWith("/admin/sos")) return null;
  if (path.startsWith("/admin/messages")) return "messages";
  if (path.startsWith("/admin/documentation")) return "documentation";
  if (path.startsWith("/admin/passwords")) return "passwords";
  if (path.startsWith("/admin/devices")) return "devices";
  if (path.startsWith("/admin/directory")) return "directory";
  if (path.startsWith("/admin/profile")) return "profiles";
  return null;
}

export function countGranted(perms: PermissionMap): number {
  return STAFF_PERMISSIONS.filter((p) => perms[p]).length;
}
