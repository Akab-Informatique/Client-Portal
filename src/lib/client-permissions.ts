/**
 * Client portal section permissions (company users only).
 * Staff use staff_roles / PermissionMap instead.
 *
 * Roles define defaults. Permissions from all assigned roles STACK (OR).
 * Admins can still override billing per user via users.billing_access
 * (null = inherit from stacked roles).
 *
 * Standard (core) is editable so each client can tighten default access.
 */

export const CLIENT_PERMISSIONS = [
  "board",
  "tickets",
  "documentation",
  "passwords",
  "directory",
  "devices",
  "billing",
] as const;

export type ClientPermission = (typeof CLIENT_PERMISSIONS)[number];

export type ClientPermissionMap = Record<ClientPermission, boolean>;

/** Labels for admin UI (i18n keys under clientRoles.perm*). */
export const CLIENT_PERMISSION_META: Record<
  ClientPermission,
  { labelKey: string; hintKey: string }
> = {
  board: {
    labelKey: "clientRoles.permBoard",
    hintKey: "clientRoles.permBoardHint",
  },
  tickets: {
    labelKey: "clientRoles.permTickets",
    hintKey: "clientRoles.permTicketsHint",
  },
  documentation: {
    labelKey: "clientRoles.permDocumentation",
    hintKey: "clientRoles.permDocumentationHint",
  },
  passwords: {
    labelKey: "clientRoles.permPasswords",
    hintKey: "clientRoles.permPasswordsHint",
  },
  directory: {
    labelKey: "clientRoles.permDirectory",
    hintKey: "clientRoles.permDirectoryHint",
  },
  devices: {
    labelKey: "clientRoles.permDevices",
    hintKey: "clientRoles.permDevicesHint",
  },
  billing: {
    labelKey: "clientRoles.permBilling",
    hintKey: "clientRoles.permBillingHint",
  },
};

/**
 * Default for Standard core — full portal except billing + devices.
 * Devices must be enabled explicitly on a role (sensitive RMM inventory).
 */
export const STANDARD_CLIENT_PERMISSIONS: ClientPermissionMap = {
  board: true,
  tickets: true,
  documentation: true,
  passwords: true,
  directory: true,
  devices: false,
  billing: false,
};

/** Finance / billing contacts — billing on; other sections inherit from Standard stack. */
export const BILLING_CLIENT_PERMISSIONS: ClientPermissionMap = {
  board: false,
  tickets: false,
  documentation: false,
  passwords: false,
  directory: false,
  devices: false,
  billing: true,
};

export const EMPTY_CLIENT_PERMISSIONS: ClientPermissionMap = {
  board: false,
  tickets: false,
  documentation: false,
  passwords: false,
  directory: false,
  devices: false,
  billing: false,
};

export const SYSTEM_CLIENT_ROLE_SLUGS = {
  standard: "standard",
  billing: "billing",
} as const;

export function allClientPermissions(): ClientPermissionMap {
  const out = { ...EMPTY_CLIENT_PERMISSIONS };
  for (const key of CLIENT_PERMISSIONS) out[key] = true;
  return out;
}

export function parseClientPermissions(
  raw: string | null | undefined,
): ClientPermissionMap {
  // Legacy rows only stored { billing: bool } — treat missing section keys as
  // "on" for core portal sections so upgrades don't lock everyone out.
  // devices stays off until explicitly granted (RMM inventory).
  const base: ClientPermissionMap = {
    board: true,
    tickets: true,
    documentation: true,
    passwords: true,
    directory: true,
    devices: false,
    billing: false,
  };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // If the stored map has any of the new keys, use explicit true/false for all.
    const hasSectionKeys = CLIENT_PERMISSIONS.some(
      (k) => k !== "billing" && k in parsed,
    );
    for (const key of CLIENT_PERMISSIONS) {
      if (key in parsed) {
        base[key] = parsed[key] === true;
      } else if (hasSectionKeys) {
        // Explicit new-format map missing a key → off
        base[key] = false;
      }
      // else keep legacy defaults (core on, billing only if set)
    }
    if ("billing" in parsed) base.billing = parsed.billing === true;
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
