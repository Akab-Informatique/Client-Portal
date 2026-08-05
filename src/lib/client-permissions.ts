/**
 * Client portal section permissions (company users only).
 * Staff use staff_roles / PermissionMap instead.
 *
 * Roles define defaults. Admins can override billing per user
 * via users.billing_access (null = inherit from role).
 */

export const CLIENT_PERMISSIONS = ["billing"] as const;

export type ClientPermission = (typeof CLIENT_PERMISSIONS)[number];

export type ClientPermissionMap = Record<ClientPermission, boolean>;

/** Default for most company contacts — no billing. */
export const STANDARD_CLIENT_PERMISSIONS: ClientPermissionMap = {
  billing: false,
};

/** Finance / billing contacts — billing section on by default. */
export const BILLING_CLIENT_PERMISSIONS: ClientPermissionMap = {
  billing: true,
};

export const EMPTY_CLIENT_PERMISSIONS: ClientPermissionMap = {
  billing: false,
};

export const SYSTEM_CLIENT_ROLE_SLUGS = {
  standard: "standard",
  billing: "billing",
} as const;

export function allClientPermissions(): ClientPermissionMap {
  return { ...BILLING_CLIENT_PERMISSIONS };
}

export function parseClientPermissions(
  raw: string | null | undefined,
): ClientPermissionMap {
  const base: ClientPermissionMap = { ...EMPTY_CLIENT_PERMISSIONS };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of CLIENT_PERMISSIONS) {
      if (parsed[key] === true) base[key] = true;
    }
    return base;
  } catch {
    return base;
  }
}

export function serializeClientPermissions(
  perms: ClientPermissionMap,
): string {
  const out: ClientPermissionMap = { ...EMPTY_CLIENT_PERMISSIONS };
  for (const key of CLIENT_PERMISSIONS) {
    out[key] = !!perms[key];
  }
  return JSON.stringify(out);
}

export function hasClientPermission(
  perms: ClientPermissionMap | null | undefined,
  permission: ClientPermission,
): boolean {
  return !!perms?.[permission];
}

/**
 * Effective client access for one section.
 * - billing_access null/undefined → inherit role default
 * - billing_access true/false → admin override wins
 */
export function resolveClientBillingAccess(opts: {
  billing_access: boolean | null | undefined;
  rolePermissions: ClientPermissionMap | null | undefined;
}): boolean {
  if (opts.billing_access === true) return true;
  if (opts.billing_access === false) return false;
  return hasClientPermission(opts.rolePermissions, "billing");
}

export function countClientGranted(perms: ClientPermissionMap): number {
  return CLIENT_PERMISSIONS.filter((p) => perms[p]).length;
}
