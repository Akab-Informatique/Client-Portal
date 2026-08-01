import { eq, inArray } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import {
  ADMIN_PERMISSIONS,
  SYSTEM_ROLE_SLUGS,
  TECHNICIAN_PERMISSIONS,
  parsePermissions,
  serializePermissions,
  type PermissionMap,
} from "@/lib/permissions";
import type { StaffRole } from "@/lib/types";

/** Single-flight lock so concurrent boot calls never double-insert defaults. */
let ensureDefaultsPromise: Promise<{
  admin: StaffRole;
  technician: StaffRole;
}> | null = null;

/**
 * Merge duplicate staff_roles that share the same slug (or the same
 * case-insensitive name for system Admin/Technician leftovers).
 * Keeps the lowest id as canonical, reassigns users, deletes the rest.
 */
export async function dedupeStaffRoles(): Promise<number> {
  await dbReady;
  const rows = (await db.select().from(schema.staff_roles)) as StaffRole[];
  if (rows.length < 2) return 0;

  // Group by normalized slug first
  const bySlug = new Map<string, StaffRole[]>();
  for (const r of rows) {
    const key = (r.slug || "").trim().toLowerCase();
    if (!key) continue;
    const list = bySlug.get(key) ?? [];
    list.push(r);
    bySlug.set(key, list);
  }

  // Also collapse same-name system leftovers that somehow got different slugs
  // (e.g. "Admin" / "admin" custom copies). Prefer slug groups already built.
  const systemNames = new Set(["admin", "technician"]);
  const byName = new Map<string, StaffRole[]>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!systemNames.has(key)) continue;
    const list = byName.get(key) ?? [];
    list.push(r);
    byName.set(key, list);
  }

  const mergeGroups: StaffRole[][] = [];
  const seenIds = new Set<number>();

  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    mergeGroups.push(group);
    group.forEach((r) => seenIds.add(r.id));
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    // Skip if already fully covered by a slug group
    if (group.every((r) => seenIds.has(r.id))) continue;
    // Prefer merging into the system slug row when present
    const preferredSlug =
      name === "admin"
        ? SYSTEM_ROLE_SLUGS.admin
        : SYSTEM_ROLE_SLUGS.technician;
    const preferred = group.find((r) => r.slug === preferredSlug);
    const ordered = preferred
      ? [preferred, ...group.filter((r) => r.id !== preferred.id)]
      : group;
    mergeGroups.push(ordered);
    ordered.forEach((r) => seenIds.add(r.id));
  }

  let removed = 0;

  for (const group of mergeGroups) {
    // Canonical = system flag first, then lowest id
    const sorted = [...group].sort((a, b) => {
      if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
      return a.id - b.id;
    });
    const keep = sorted[0];
    const drop = sorted.slice(1);
    if (drop.length === 0) continue;

    const dropIds = drop.map((r) => r.id);

    // Re-point users assigned to duplicates onto the kept role
    const users = await db.select().from(schema.users);
    for (const u of users) {
      if (u.staff_role_id != null && dropIds.includes(u.staff_role_id)) {
        await db
          .update(schema.users)
          .set({ staff_role_id: keep.id })
          .where(eq(schema.users.id, u.id));
      }
    }

    // Prefer system flag + richer permissions on the kept row
    const keepPerms = parsePermissions(keep.permissions);
    let bestPerms = keepPerms;
    let bestCount = Object.values(keepPerms).filter(Boolean).length;
    let wantSystem = keep.is_system;
    for (const d of drop) {
      if (d.is_system) wantSystem = true;
      const p = parsePermissions(d.permissions);
      const c = Object.values(p).filter(Boolean).length;
      if (c > bestCount) {
        bestPerms = p;
        bestCount = c;
      }
    }
    const patch: {
      is_system?: boolean;
      permissions?: string;
      slug?: string;
      active?: boolean;
    } = {};
    if (wantSystem && !keep.is_system) patch.is_system = true;
    if (bestCount > Object.values(keepPerms).filter(Boolean).length) {
      patch.permissions = serializePermissions(bestPerms);
    }
    // Normalize slug for system names
    const n = keep.name.trim().toLowerCase();
    if (n === "admin" && keep.slug !== SYSTEM_ROLE_SLUGS.admin) {
      patch.slug = SYSTEM_ROLE_SLUGS.admin;
    } else if (n === "technician" && keep.slug !== SYSTEM_ROLE_SLUGS.technician) {
      patch.slug = SYSTEM_ROLE_SLUGS.technician;
    }
    if (!keep.active && drop.some((d) => d.active)) patch.active = true;
    if (Object.keys(patch).length > 0) {
      await db
        .update(schema.staff_roles)
        .set(patch)
        .where(eq(schema.staff_roles.id, keep.id));
    }

    await db
      .delete(schema.staff_roles)
      .where(inArray(schema.staff_roles.id, dropIds));
    removed += dropIds.length;
  }

  return removed;
}

async function ensureDefaultStaffRolesInner(): Promise<{
  admin: StaffRole;
  technician: StaffRole;
}> {
  await dbReady;
  // Clean any historical duplicates before inserting
  await dedupeStaffRoles();

  const existing = (await db.select().from(schema.staff_roles)) as StaffRole[];

  let admin =
    existing.find((r) => r.slug === SYSTEM_ROLE_SLUGS.admin) ??
    existing.find((r) => r.name.trim().toLowerCase() === "admin");
  let technician =
    existing.find((r) => r.slug === SYSTEM_ROLE_SLUGS.technician) ??
    existing.find((r) => r.name.trim().toLowerCase() === "technician");

  if (!admin) {
    const [row] = await db
      .insert(schema.staff_roles)
      .values({
        name: "Admin",
        slug: SYSTEM_ROLE_SLUGS.admin,
        description:
          "Full access to every management section, including technicians and roles.",
        permissions: serializePermissions(ADMIN_PERMISSIONS),
        is_system: true,
        active: true,
      })
      .returning();
    admin = row as StaffRole;
  } else {
    // Normalize system metadata + ensure full permission set (new sections)
    const patch: {
      slug?: string;
      is_system?: boolean;
      name?: string;
      active?: boolean;
      permissions?: string;
    } = {};
    if (admin.slug !== SYSTEM_ROLE_SLUGS.admin) patch.slug = SYSTEM_ROLE_SLUGS.admin;
    if (!admin.is_system) patch.is_system = true;
    if (admin.name.trim() !== "Admin") patch.name = "Admin";
    if (!admin.active) patch.active = true;
    const fullAdmin = serializePermissions(ADMIN_PERMISSIONS);
    if (admin.permissions !== fullAdmin) patch.permissions = fullAdmin;
    if (Object.keys(patch).length > 0) {
      const [row] = await db
        .update(schema.staff_roles)
        .set(patch)
        .where(eq(schema.staff_roles.id, admin.id))
        .returning();
      admin = (row as StaffRole) ?? { ...admin, ...patch };
    }
  }

  if (!technician) {
    const [row] = await db
      .insert(schema.staff_roles)
      .values({
        name: "Technician",
        slug: SYSTEM_ROLE_SLUGS.technician,
        description:
          "Day-to-day access: clients, users, messages, documentation, and directory. Cannot manage staff or roles.",
        permissions: serializePermissions(TECHNICIAN_PERMISSIONS),
        is_system: true,
        active: true,
      })
      .returning();
    technician = row as StaffRole;
  } else {
    const patch: {
      slug?: string;
      is_system?: boolean;
      name?: string;
      active?: boolean;
      permissions?: string;
    } = {};
    if (technician.slug !== SYSTEM_ROLE_SLUGS.technician) {
      patch.slug = SYSTEM_ROLE_SLUGS.technician;
    }
    if (!technician.is_system) patch.is_system = true;
    if (technician.name.trim() !== "Technician") patch.name = "Technician";
    if (!technician.active) patch.active = true;
    // Auto-enable new section keys only when never set (legacy roles)
    const current = parsePermissions(technician.permissions);
    let raw: Record<string, unknown> = {};
    try {
      raw = technician.permissions ? JSON.parse(technician.permissions) : {};
    } catch {
      raw = {};
    }
    let permsChanged = false;
    if (raw.documentation === undefined) {
      current.documentation = true;
      permsChanged = true;
    }
    if (raw.passwords === undefined) {
      current.passwords = true;
      permsChanged = true;
    }
    if (permsChanged) {
      patch.permissions = serializePermissions(current);
    }
    if (Object.keys(patch).length > 0) {
      const [row] = await db
        .update(schema.staff_roles)
        .set(patch)
        .where(eq(schema.staff_roles.id, technician.id))
        .returning();
      technician = (row as StaffRole) ?? { ...technician, ...patch };
    }
  }

  // Final pass in case insert raced somehow (shouldn't with single-flight)
  await dedupeStaffRoles();

  // Re-read canonical rows after possible dedupe
  const finalRows = (await db.select().from(schema.staff_roles)) as StaffRole[];
  admin =
    finalRows.find((r) => r.slug === SYSTEM_ROLE_SLUGS.admin) ?? admin;
  technician =
    finalRows.find((r) => r.slug === SYSTEM_ROLE_SLUGS.technician) ??
    technician;

  return { admin, technician };
}

/** Ensure default Admin + Technician system roles exist; return them. */
export function ensureDefaultStaffRoles(): Promise<{
  admin: StaffRole;
  technician: StaffRole;
}> {
  if (!ensureDefaultsPromise) {
    ensureDefaultsPromise = ensureDefaultStaffRolesInner().catch((err) => {
      // Allow retry after a failed run
      ensureDefaultsPromise = null;
      throw err;
    });
  }
  return ensureDefaultsPromise;
}

/** Assign staff_role_id on users that still lack one (migration helper). */
export async function backfillUserStaffRoles() {
  await dbReady;
  const { admin, technician } = await ensureDefaultStaffRoles();
  const users = await db.select().from(schema.users);
  for (const u of users) {
    if (u.role === "client") continue;
    if (u.staff_role_id) continue;
    const roleId = u.role === "admin" ? admin.id : technician.id;
    await db
      .update(schema.users)
      .set({ staff_role_id: roleId })
      .where(eq(schema.users.id, u.id));
  }
}

export async function listStaffRoles(): Promise<StaffRole[]> {
  await dbReady;
  await ensureDefaultStaffRoles();
  // Always collapse any leftovers before rendering
  await dedupeStaffRoles();
  const rows = (await db.select().from(schema.staff_roles)) as StaffRole[];
  return rows.sort((a, b) => {
    // System first, then name
    if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getStaffRoleById(
  id: number | null | undefined,
): Promise<StaffRole | null> {
  if (id == null) return null;
  await dbReady;
  const rows = await db
    .select()
    .from(schema.staff_roles)
    .where(eq(schema.staff_roles.id, id))
    .limit(1);
  return (rows[0] as StaffRole) ?? null;
}

export async function resolvePermissionsForUser(row: {
  role: string;
  staff_role_id: number | null;
}): Promise<{
  permissions: PermissionMap | null;
  staff_role_name: string | null;
  staff_role_slug: string | null;
}> {
  if (row.role === "client") {
    return {
      permissions: null,
      staff_role_name: null,
      staff_role_slug: null,
    };
  }

  // Legacy admins without a staff_role_id still get full access
  if (row.role === "admin" && !row.staff_role_id) {
    return {
      permissions: { ...ADMIN_PERMISSIONS },
      staff_role_name: "Admin",
      staff_role_slug: SYSTEM_ROLE_SLUGS.admin,
    };
  }

  const staffRole = await getStaffRoleById(row.staff_role_id);
  if (!staffRole || !staffRole.active) {
    // Fallback by portal role
    if (row.role === "admin") {
      return {
        permissions: { ...ADMIN_PERMISSIONS },
        staff_role_name: "Admin",
        staff_role_slug: SYSTEM_ROLE_SLUGS.admin,
      };
    }
    return {
      permissions: { ...TECHNICIAN_PERMISSIONS },
      staff_role_name: "Technician",
      staff_role_slug: SYSTEM_ROLE_SLUGS.technician,
    };
  }

  return {
    permissions: parsePermissions(staffRole.permissions),
    staff_role_name: staffRole.name,
    staff_role_slug: staffRole.slug,
  };
}

export function slugifyRoleName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `role-${Date.now()}`;
}

export async function createStaffRole(input: {
  name: string;
  description?: string;
  permissions: PermissionMap;
}): Promise<StaffRole> {
  await dbReady;
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");

  // Block creating another Admin/Technician by name — edit the system one instead
  const lower = name.toLowerCase();
  if (lower === "admin" || lower === "technician") {
    throw new Error(
      `"${name}" is a built-in system role. Edit the existing one instead of creating a duplicate.`,
    );
  }

  let slug = slugifyRoleName(name);
  const existing = (await db.select().from(schema.staff_roles)) as StaffRole[];

  // Also block reserved system slugs
  if (
    slug === SYSTEM_ROLE_SLUGS.admin ||
    slug === SYSTEM_ROLE_SLUGS.technician
  ) {
    slug = `custom-${slug}-${Date.now().toString(36)}`;
  }

  if (existing.some((r) => r.slug === slug)) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  // Soft uniqueness on display name (case-insensitive)
  if (existing.some((r) => r.name.trim().toLowerCase() === lower)) {
    throw new Error(`A role named "${name}" already exists.`);
  }

  const [row] = await db
    .insert(schema.staff_roles)
    .values({
      name,
      slug,
      description: input.description?.trim() || null,
      permissions: serializePermissions(input.permissions),
      is_system: false,
      active: true,
    })
    .returning();
  return row as StaffRole;
}

export async function updateStaffRole(
  id: number,
  input: {
    name?: string;
    description?: string | null;
    permissions?: PermissionMap;
    active?: boolean;
  },
): Promise<StaffRole | null> {
  await dbReady;
  const current = await getStaffRoleById(id);
  if (!current) return null;

  const patch: {
    name?: string;
    description?: string | null;
    permissions?: string;
    active?: boolean;
  } = {};

  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new Error("Name is required");
    const lower = name.toLowerCase();
    // Prevent renaming a custom role onto a reserved system name (unless it IS that system role)
    if (
      !current.is_system &&
      (lower === "admin" || lower === "technician")
    ) {
      throw new Error(
        `"${name}" is reserved for a system role. Choose a different name.`,
      );
    }
    // Prevent colliding with another role's display name
    const others = (await db.select().from(schema.staff_roles)) as StaffRole[];
    if (
      others.some(
        (r) => r.id !== id && r.name.trim().toLowerCase() === lower,
      )
    ) {
      throw new Error(`A role named "${name}" already exists.`);
    }
    patch.name = name;
  }
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  if (input.permissions) {
    patch.permissions = serializePermissions(input.permissions);
  }
  if (input.active != null && !current.is_system) {
    patch.active = input.active;
  }

  const [row] = await db
    .update(schema.staff_roles)
    .set(patch)
    .where(eq(schema.staff_roles.id, id))
    .returning();
  return (row as StaffRole) ?? null;
}

export async function deleteStaffRole(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await dbReady;
  const role = await getStaffRoleById(id);
  if (!role) return { ok: false, error: "Role not found." };
  if (role.is_system) {
    return { ok: false, error: "System roles cannot be deleted." };
  }
  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.staff_role_id, id));
  if (users.length > 0) {
    return {
      ok: false,
      error: `This role is assigned to ${users.length} user(s). Reassign them first.`,
    };
  }
  await db.delete(schema.staff_roles).where(eq(schema.staff_roles.id, id));
  return { ok: true };
}

/** Portal role field (admin/technician) derived from staff role slug/permissions. */
export function portalRoleFromStaffRole(
  role: StaffRole,
): "admin" | "technician" {
  if (role.slug === SYSTEM_ROLE_SLUGS.admin) return "admin";
  // Any role with technicians+roles manage rights is treated as admin-class
  const perms = parsePermissions(role.permissions);
  if (perms.technicians && perms.roles) return "admin";
  return "technician";
}
