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

/** True after a successful ensure — skip heavy work on later listStaffRoles calls. */
let defaultsReady = false;

async function selectAllRoles(): Promise<StaffRole[]> {
  return (await db.select().from(schema.staff_roles)) as StaffRole[];
}

async function selectRoleBySlug(slug: string): Promise<StaffRole | null> {
  const rows = (await db
    .select()
    .from(schema.staff_roles)
    .where(eq(schema.staff_roles.slug, slug))
    .limit(1)) as StaffRole[];
  return rows[0] ?? null;
}

async function selectRoleById(id: number): Promise<StaffRole | null> {
  const rows = (await db
    .select()
    .from(schema.staff_roles)
    .where(eq(schema.staff_roles.id, id))
    .limit(1)) as StaffRole[];
  return rows[0] ?? null;
}

/**
 * Insert without `.returning()` — pg-proxy mapping of RETURNING is fragile and
 * can hang the browser. Follow with a SELECT by slug instead.
 */
async function insertRole(values: {
  name: string;
  slug: string;
  description: string;
  permissions: string;
  is_system: boolean;
  active: boolean;
}): Promise<StaffRole> {
  await db.insert(schema.staff_roles).values(values);
  const row = await selectRoleBySlug(values.slug);
  if (!row) {
    throw new Error(`Failed to create staff role “${values.slug}”`);
  }
  return row;
}

async function updateRoleById(
  id: number,
  patch: Record<string, unknown>,
): Promise<StaffRole> {
  await db
    .update(schema.staff_roles)
    .set(patch)
    .where(eq(schema.staff_roles.id, id));
  const row = await selectRoleById(id);
  if (!row) {
    throw new Error(`Staff role #${id} missing after update`);
  }
  return row;
}

/**
 * Merge duplicate staff_roles that share the same slug.
 * Keeps the lowest system-preferring id, reassigns users, deletes the rest.
 * Lightweight when there are no duplicates.
 */
export async function dedupeStaffRoles(): Promise<number> {
  await dbReady;
  const rows = await selectAllRoles();
  if (rows.length < 2) return 0;

  const bySlug = new Map<string, StaffRole[]>();
  for (const r of rows) {
    const key = (r.slug || "").trim().toLowerCase();
    if (!key) continue;
    const list = bySlug.get(key) ?? [];
    list.push(r);
    bySlug.set(key, list);
  }

  let removed = 0;

  for (const group of bySlug.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a: StaffRole, b: StaffRole) => {
      if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
      return a.id - b.id;
    });
    const keep = sorted[0];
    const drop = sorted.slice(1);
    const dropIds = drop.map((r: StaffRole) => r.id);

    const users = (await db.select().from(schema.users)) as Array<{
      id: number;
      staff_role_id: number | null;
    }>;
    for (const u of users) {
      if (u.staff_role_id != null && dropIds.includes(u.staff_role_id)) {
        await db
          .update(schema.users)
          .set({ staff_role_id: keep.id })
          .where(eq(schema.users.id, u.id));
      }
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

  const existing = await selectAllRoles();

  // Only dedupe when we actually see duplicates (common after upgrades)
  const slugCounts = new Map<string, number>();
  for (const r of existing) {
    const k = (r.slug || "").trim().toLowerCase();
    if (!k) continue;
    slugCounts.set(k, (slugCounts.get(k) ?? 0) + 1);
  }
  if ([...slugCounts.values()].some((n) => n > 1)) {
    await dedupeStaffRoles();
  }

  const rows = await selectAllRoles();

  let admin: StaffRole | undefined =
    rows.find((r: StaffRole) => r.slug === SYSTEM_ROLE_SLUGS.admin) ??
    rows.find((r: StaffRole) => r.name.trim().toLowerCase() === "admin");
  let technician: StaffRole | undefined =
    rows.find((r: StaffRole) => r.slug === SYSTEM_ROLE_SLUGS.technician) ??
    rows.find((r: StaffRole) => r.name.trim().toLowerCase() === "technician");

  if (!admin) {
    try {
      admin = await insertRole({
        name: "Admin",
        slug: SYSTEM_ROLE_SLUGS.admin,
        description:
          "Full access to every management section, including technicians and roles.",
        permissions: serializePermissions(ADMIN_PERMISSIONS),
        is_system: true,
        active: true,
      });
    } catch {
      admin =
        (await selectRoleBySlug(SYSTEM_ROLE_SLUGS.admin)) ?? undefined;
      if (!admin) throw new Error("Could not ensure Admin staff role");
    }
  } else {
    const patch: Record<string, unknown> = {};
    if (admin.slug !== SYSTEM_ROLE_SLUGS.admin) {
      patch.slug = SYSTEM_ROLE_SLUGS.admin;
    }
    if (!admin.is_system) patch.is_system = true;
    if (admin.name.trim() !== "Admin") patch.name = "Admin";
    if (!admin.active) patch.active = true;
    const fullAdmin = serializePermissions(ADMIN_PERMISSIONS);
    if (admin.permissions !== fullAdmin) patch.permissions = fullAdmin;
    if (Object.keys(patch).length > 0) {
      admin = await updateRoleById(admin.id, patch);
    }
  }

  if (!technician) {
    try {
      technician = await insertRole({
        name: "Technician",
        slug: SYSTEM_ROLE_SLUGS.technician,
        description:
          "Day-to-day access: clients, users, messages, documentation, and directory. Cannot manage staff or roles.",
        permissions: serializePermissions(TECHNICIAN_PERMISSIONS),
        is_system: true,
        active: true,
      });
    } catch {
      technician =
        (await selectRoleBySlug(SYSTEM_ROLE_SLUGS.technician)) ?? undefined;
      if (!technician) {
        throw new Error("Could not ensure Technician staff role");
      }
    }
  } else {
    const patch: Record<string, unknown> = {};
    if (technician.slug !== SYSTEM_ROLE_SLUGS.technician) {
      patch.slug = SYSTEM_ROLE_SLUGS.technician;
    }
    if (!technician.is_system) patch.is_system = true;
    if (technician.name.trim() !== "Technician") patch.name = "Technician";
    if (!technician.active) patch.active = true;
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
      technician = await updateRoleById(technician.id, patch);
    }
  }

  defaultsReady = true;
  return { admin, technician };
}

/** Ensure default Admin + Technician system roles exist; return them. */
export function ensureDefaultStaffRoles(): Promise<{
  admin: StaffRole;
  technician: StaffRole;
}> {
  if (!ensureDefaultsPromise) {
    ensureDefaultsPromise = ensureDefaultStaffRolesInner().catch((err) => {
      ensureDefaultsPromise = null;
      defaultsReady = false;
      throw err;
    });
  }
  return ensureDefaultsPromise;
}

/** Assign staff_role_id on users that still lack one (migration helper). */
export async function backfillUserStaffRoles() {
  await dbReady;
  const { admin, technician } = await ensureDefaultStaffRoles();
  const users = (await db.select().from(schema.users)) as Array<{
    id: number;
    role: string;
    staff_role_id: number | null;
  }>;
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

/**
 * List roles for the Staff & Roles UI.
 * Ensures defaults once, then is a plain SELECT (no repeated dedupe/migrate).
 */
export async function listStaffRoles(): Promise<StaffRole[]> {
  await dbReady;
  if (!defaultsReady) {
    try {
      await ensureDefaultStaffRoles();
    } catch (err) {
      console.warn(
        "[akab] ensureDefaultStaffRoles failed in listStaffRoles",
        err,
      );
    }
  }
  const rows = await selectAllRoles();
  return rows.sort((a: StaffRole, b: StaffRole) => {
    if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getStaffRoleById(
  id: number | null | undefined,
): Promise<StaffRole | null> {
  if (id == null) return null;
  await dbReady;
  return selectRoleById(id);
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

  if (row.role === "admin" && !row.staff_role_id) {
    return {
      permissions: { ...ADMIN_PERMISSIONS },
      staff_role_name: "Admin",
      staff_role_slug: SYSTEM_ROLE_SLUGS.admin,
    };
  }

  const staffRole = await getStaffRoleById(row.staff_role_id);
  if (!staffRole || !staffRole.active) {
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

  const lower = name.toLowerCase();
  if (lower === "admin" || lower === "technician") {
    throw new Error(
      `"${name}" is a built-in system role. Edit the existing one instead of creating a duplicate.`,
    );
  }

  let slug = slugifyRoleName(name);
  const existing = await selectAllRoles();

  if (
    slug === SYSTEM_ROLE_SLUGS.admin ||
    slug === SYSTEM_ROLE_SLUGS.technician
  ) {
    slug = `custom-${slug}-${Date.now().toString(36)}`;
  }

  if (existing.some((r: StaffRole) => r.slug === slug)) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  if (existing.some((r: StaffRole) => r.name.trim().toLowerCase() === lower)) {
    throw new Error(`A role named "${name}" already exists.`);
  }

  return insertRole({
    name,
    slug,
    description: input.description?.trim() || "",
    permissions: serializePermissions(input.permissions),
    is_system: false,
    active: true,
  });
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

  const patch: Record<string, unknown> = {};

  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new Error("Name is required");
    const lower = name.toLowerCase();
    if (
      !current.is_system &&
      (lower === "admin" || lower === "technician")
    ) {
      throw new Error(
        `"${name}" is reserved for a system role. Choose a different name.`,
      );
    }
    const others = await selectAllRoles();
    if (
      others.some(
        (r: StaffRole) =>
          r.id !== id && r.name.trim().toLowerCase() === lower,
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

  if (Object.keys(patch).length === 0) return current;
  return updateRoleById(id, patch);
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
  const users = (await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.staff_role_id, id))) as Array<{ id: number }>;
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
  const perms = parsePermissions(role.permissions);
  if (perms.technicians && perms.roles) return "admin";
  return "technician";
}
