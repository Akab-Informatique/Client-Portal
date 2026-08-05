import { eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import {
  BILLING_CLIENT_PERMISSIONS,
  STANDARD_CLIENT_PERMISSIONS,
  SYSTEM_CLIENT_ROLE_SLUGS,
  parseClientPermissions,
  serializeClientPermissions,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type { ClientRole } from "@/lib/types";

let ensureDefaultsPromise: Promise<{
  standard: ClientRole;
  billing: ClientRole;
}> | null = null;

let defaultsReady = false;

async function selectAll(): Promise<ClientRole[]> {
  return (await db.select().from(schema.client_roles)) as ClientRole[];
}

async function selectBySlug(slug: string): Promise<ClientRole | null> {
  const rows = (await db
    .select()
    .from(schema.client_roles)
    .where(eq(schema.client_roles.slug, slug))
    .limit(1)) as ClientRole[];
  return rows[0] ?? null;
}

async function selectById(id: number): Promise<ClientRole | null> {
  const rows = (await db
    .select()
    .from(schema.client_roles)
    .where(eq(schema.client_roles.id, id))
    .limit(1)) as ClientRole[];
  return rows[0] ?? null;
}

async function insertRole(values: {
  name: string;
  slug: string;
  description: string;
  permissions: string;
  is_system: boolean;
  active: boolean;
}): Promise<ClientRole> {
  await db.insert(schema.client_roles).values(values);
  const row = await selectBySlug(values.slug);
  if (!row) throw new Error(`Failed to create client role “${values.slug}”`);
  return row;
}

/**
 * Ensure system client roles exist (Standard + Billing contact).
 * Safe to call on every boot.
 */
export async function ensureDefaultClientRoles(): Promise<{
  standard: ClientRole;
  billing: ClientRole;
}> {
  if (defaultsReady && ensureDefaultsPromise) {
    return ensureDefaultsPromise;
  }
  if (ensureDefaultsPromise) return ensureDefaultsPromise;

  ensureDefaultsPromise = (async () => {
    await dbReady;

    let standard = await selectBySlug(SYSTEM_CLIENT_ROLE_SLUGS.standard);
    if (!standard) {
      standard = await insertRole({
        name: "Standard user",
        slug: SYSTEM_CLIENT_ROLE_SLUGS.standard,
        description:
          "Default company contact. Core portal access only — no billing by default.",
        permissions: serializeClientPermissions(STANDARD_CLIENT_PERMISSIONS),
        is_system: true,
        active: true,
      });
    }

    let billing = await selectBySlug(SYSTEM_CLIENT_ROLE_SLUGS.billing);
    if (!billing) {
      billing = await insertRole({
        name: "Billing contact",
        slug: SYSTEM_CLIENT_ROLE_SLUGS.billing,
        description:
          "Company finance contact. Billing section (invoices & contracts) is on by default. Admins can still override per user.",
        permissions: serializeClientPermissions(BILLING_CLIENT_PERMISSIONS),
        is_system: true,
        active: true,
      });
    }

    defaultsReady = true;
    return { standard, billing };
  })();

  try {
    return await ensureDefaultsPromise;
  } catch (err) {
    ensureDefaultsPromise = null;
    defaultsReady = false;
    throw err;
  }
}

export async function listClientRoles(opts?: {
  activeOnly?: boolean;
}): Promise<ClientRole[]> {
  await ensureDefaultClientRoles();
  let rows = await selectAll();
  if (opts?.activeOnly) rows = rows.filter((r) => r.active);
  return rows.sort((a, b) => {
    if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export async function getClientRoleById(
  id: number | null | undefined,
): Promise<ClientRole | null> {
  if (id == null) return null;
  await dbReady;
  return selectById(id);
}

export async function createClientRole(input: {
  name: string;
  slug?: string;
  description?: string | null;
  permissions: ClientPermissionMap;
}): Promise<ClientRole> {
  await ensureDefaultClientRoles();
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const slug =
    (input.slug || name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `role-${Date.now()}`;
  const existing = await selectBySlug(slug);
  if (existing) throw new Error(`A client role with slug “${slug}” already exists`);
  return insertRole({
    name,
    slug,
    description: input.description?.trim() || "",
    permissions: serializeClientPermissions(input.permissions),
    is_system: false,
    active: true,
  });
}

export async function updateClientRole(
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    permissions?: ClientPermissionMap;
    active?: boolean;
  },
): Promise<ClientRole> {
  await dbReady;
  const current = await selectById(id);
  if (!current) throw new Error("Client role not found");
  const next: Record<string, unknown> = {};
  if (patch.name != null) next.name = patch.name.trim();
  if (patch.description !== undefined) {
    next.description = patch.description?.trim() || null;
  }
  if (patch.permissions) {
    next.permissions = serializeClientPermissions(patch.permissions);
  }
  if (patch.active != null) {
    if (current.is_system && patch.active === false) {
      throw new Error("System client roles cannot be deactivated");
    }
    next.active = patch.active;
  }
  if (Object.keys(next).length === 0) return current;
  await db
    .update(schema.client_roles)
    .set(next)
    .where(eq(schema.client_roles.id, id));
  const row = await selectById(id);
  if (!row) throw new Error("Client role missing after update");
  return row;
}

export async function deleteClientRole(id: number): Promise<void> {
  await dbReady;
  const current = await selectById(id);
  if (!current) return;
  if (current.is_system) {
    throw new Error("System client roles cannot be deleted");
  }
  const { standard } = await ensureDefaultClientRoles();
  // Reassign users to Standard
  await db
    .update(schema.users)
    .set({ client_role_id: standard.id })
    .where(eq(schema.users.client_role_id, id));
  await db.delete(schema.client_roles).where(eq(schema.client_roles.id, id));
}

export function permissionsOfClientRole(
  role: ClientRole | null | undefined,
): ClientPermissionMap {
  if (!role) return { ...STANDARD_CLIENT_PERMISSIONS };
  return parseClientPermissions(role.permissions);
}

/**
 * Resolve effective client permissions for a portal user row.
 * billing_access null → role default; true/false → override.
 */
export async function resolveClientAccessForUser(row: {
  role: string;
  client_role_id?: number | null;
  billing_access?: boolean | null;
}): Promise<{
  client_permissions: ClientPermissionMap;
  client_role_name: string | null;
  client_role_slug: string | null;
  billing_enabled: boolean;
}> {
  if (row.role !== "client") {
    return {
      client_permissions: { ...EMPTY_OR_NONE() },
      client_role_name: null,
      client_role_slug: null,
      billing_enabled: false,
    };
  }

  await ensureDefaultClientRoles();
  let roleRow: ClientRole | null = null;
  if (row.client_role_id != null) {
    roleRow = await selectById(row.client_role_id);
  }
  if (!roleRow) {
    roleRow = await selectBySlug(SYSTEM_CLIENT_ROLE_SLUGS.standard);
  }
  const rolePerms = permissionsOfClientRole(roleRow);
  const billing =
    row.billing_access === true
      ? true
      : row.billing_access === false
        ? false
        : rolePerms.billing;

  return {
    client_permissions: { ...rolePerms, billing },
    client_role_name: roleRow?.name ?? null,
    client_role_slug: roleRow?.slug ?? null,
    billing_enabled: billing,
  };
}

function EMPTY_OR_NONE(): ClientPermissionMap {
  return { billing: false };
}
