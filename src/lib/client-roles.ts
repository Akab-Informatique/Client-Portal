import { and, eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import {
  BILLING_CLIENT_PERMISSIONS,
  STANDARD_CLIENT_PERMISSIONS,
  SYSTEM_CLIENT_ROLE_SLUGS,
  parseClientPermissions,
  serializeClientPermissions,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type { ClientRole, Company } from "@/lib/types";

async function selectById(id: number): Promise<ClientRole | null> {
  const rows = (await db
    .select()
    .from(schema.client_roles)
    .where(eq(schema.client_roles.id, id))
    .limit(1)) as ClientRole[];
  return rows[0] ?? null;
}

async function selectByCompanySlug(
  companyId: number,
  slug: string,
): Promise<ClientRole | null> {
  const rows = (await db
    .select()
    .from(schema.client_roles)
    .where(
      and(
        eq(schema.client_roles.company_id, companyId),
        eq(schema.client_roles.slug, slug),
      ),
    )
    .limit(1)) as ClientRole[];
  return rows[0] ?? null;
}

async function insertRole(values: {
  company_id: number;
  name: string;
  slug: string;
  description: string;
  permissions: string;
  is_system: boolean;
  active: boolean;
}): Promise<ClientRole> {
  try {
    await db.insert(schema.client_roles).values(values);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/company_id/i.test(msg) && /does not exist/i.test(msg)) {
      throw new Error(
        'Database is missing client_roles.company_id. On the server run: curl -sS -m 30 "http://127.0.0.1:3000/api/db/status?migrate=1" after rebuilding the app container.',
      );
    }
    throw e;
  }
  const row = await selectByCompanySlug(values.company_id, values.slug);
  if (!row) {
    throw new Error(
      `Failed to create client user role “${values.slug}” for company #${values.company_id}`,
    );
  }
  return row;
}

/**
 * Ensure Standard + Billing user roles exist for ONE client company.
 * Safe to call repeatedly.
 */
export async function ensureClientUserRolesForCompany(
  companyId: number,
): Promise<{ standard: ClientRole; billing: ClientRole }> {
  await dbReady;
  if (!Number.isFinite(companyId) || companyId <= 0) {
    throw new Error("companyId is required for client user roles");
  }

  let standard = await selectByCompanySlug(
    companyId,
    SYSTEM_CLIENT_ROLE_SLUGS.standard,
  );
  if (!standard) {
    standard = await insertRole({
      company_id: companyId,
      name: "Standard user",
      slug: SYSTEM_CLIENT_ROLE_SLUGS.standard,
      description:
        "Default contact for this company. Core portal only — no billing by default.",
      permissions: serializeClientPermissions(STANDARD_CLIENT_PERMISSIONS),
      is_system: true,
      active: true,
    });
  }

  let billing = await selectByCompanySlug(
    companyId,
    SYSTEM_CLIENT_ROLE_SLUGS.billing,
  );
  if (!billing) {
    billing = await insertRole({
      company_id: companyId,
      name: "Billing contact",
      slug: SYSTEM_CLIENT_ROLE_SLUGS.billing,
      description:
        "Finance contact for this company. Billing (invoices & contracts) is on by default. Admins can still override per user.",
      permissions: serializeClientPermissions(BILLING_CLIENT_PERMISSIONS),
      is_system: true,
      active: true,
    });
  }

  return { standard, billing };
}

/**
 * Create default user roles for every active client company, and remap
 * users that still point at orphan/global roles onto this company's Standard.
 */
export async function ensureAllClientCompanyRoles(): Promise<void> {
  await dbReady;
  const companies = (await db.select().from(schema.companies)) as Company[];
  const clients = companies.filter((c) => c.type === "client");

  for (const c of clients) {
    try {
      const { standard } = await ensureClientUserRolesForCompany(c.id);
      // Remap users of this company whose role is missing or belongs to another company
      const users = (await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.company_id, c.id))) as Array<{
        id: number;
        role: string;
        client_role_id: number | null;
      }>;
      for (const u of users) {
        if (u.role !== "client") continue;
        if (u.client_role_id == null) {
          await db
            .update(schema.users)
            .set({ client_role_id: standard.id })
            .where(eq(schema.users.id, u.id));
          continue;
        }
        const roleRow = await selectById(u.client_role_id);
        if (!roleRow || roleRow.company_id !== c.id) {
          // Prefer matching slug on this company if old role was billing
          let target = standard;
          if (roleRow?.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing) {
            const { billing } = await ensureClientUserRolesForCompany(c.id);
            target = billing;
          }
          await db
            .update(schema.users)
            .set({ client_role_id: target.id })
            .where(eq(schema.users.id, u.id));
        }
      }
    } catch (e) {
      console.warn(
        `[akab] client user roles for company #${c.id} failed:`,
        e,
      );
    }
  }

  // Drop legacy global roles (company_id missing/0) if any remain unused
  try {
    const allRoles = (await db
      .select()
      .from(schema.client_roles)) as ClientRole[];
    for (const r of allRoles) {
      const cid = Number((r as ClientRole).company_id);
      if (Number.isFinite(cid) && cid > 0) continue;
      const stillUsed = (
        (await db.select().from(schema.users)) as Array<{
          client_role_id: number | null;
        }>
      ).some((u) => u.client_role_id === r.id);
      if (!stillUsed) {
        await db
          .delete(schema.client_roles)
          .where(eq(schema.client_roles.id, r.id));
      }
    }
  } catch {
    /* ignore cleanup */
  }
}

/** @deprecated use ensureClientUserRolesForCompany / ensureAllClientCompanyRoles */
export async function ensureDefaultClientRoles(): Promise<{
  standard: ClientRole;
  billing: ClientRole;
}> {
  await ensureAllClientCompanyRoles();
  const companies = (await db.select().from(schema.companies)) as Company[];
  const first = companies.find((c) => c.type === "client");
  if (!first) {
    // No clients yet — return a throw-free placeholder by creating nothing
    throw new Error("No client companies — create a client first");
  }
  return ensureClientUserRolesForCompany(first.id);
}

export async function listClientRolesForCompany(
  companyId: number,
  opts?: { activeOnly?: boolean },
): Promise<ClientRole[]> {
  await ensureClientUserRolesForCompany(companyId);
  let rows = (await db
    .select()
    .from(schema.client_roles)
    .where(eq(schema.client_roles.company_id, companyId))) as ClientRole[];
  if (opts?.activeOnly) rows = rows.filter((r) => r.active);
  return rows.sort((a, b) => {
    if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** @deprecated use listClientRolesForCompany */
export async function listClientRoles(opts?: {
  activeOnly?: boolean;
}): Promise<ClientRole[]> {
  await ensureAllClientCompanyRoles();
  let rows = (await db.select().from(schema.client_roles)) as ClientRole[];
  if (opts?.activeOnly) rows = rows.filter((r) => r.active);
  return rows.sort((a, b) => {
    if (a.company_id !== b.company_id) return a.company_id - b.company_id;
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

export async function createClientUserRole(input: {
  companyId: number;
  name: string;
  slug?: string;
  description?: string | null;
  permissions: ClientPermissionMap;
}): Promise<ClientRole> {
  await ensureClientUserRolesForCompany(input.companyId);
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const slug =
    (input.slug || name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `role-${Date.now()}`;
  if (
    slug === SYSTEM_CLIENT_ROLE_SLUGS.standard ||
    slug === SYSTEM_CLIENT_ROLE_SLUGS.billing
  ) {
    throw new Error("That slug is reserved for built-in roles");
  }
  const existing = await selectByCompanySlug(input.companyId, slug);
  if (existing) {
    throw new Error(`A user role “${slug}” already exists for this client`);
  }
  return insertRole({
    company_id: input.companyId,
    name,
    slug,
    description: input.description?.trim() || "",
    permissions: serializeClientPermissions(input.permissions),
    is_system: false,
    active: true,
  });
}

/** @deprecated use createClientUserRole */
export async function createClientRole(input: {
  name: string;
  slug?: string;
  description?: string | null;
  permissions: ClientPermissionMap;
  companyId?: number;
}): Promise<ClientRole> {
  if (input.companyId == null) {
    throw new Error("companyId is required — roles belong to one client");
  }
  return createClientUserRole({
    companyId: input.companyId,
    name: input.name,
    slug: input.slug,
    description: input.description,
    permissions: input.permissions,
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
  if (!current) throw new Error("Client user role not found");
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
      throw new Error("Built-in user roles cannot be deactivated");
    }
    next.active = patch.active;
  }
  if (Object.keys(next).length === 0) return current;
  await db
    .update(schema.client_roles)
    .set(next)
    .where(eq(schema.client_roles.id, id));
  const row = await selectById(id);
  if (!row) throw new Error("Client user role missing after update");
  return row;
}

export async function deleteClientRole(id: number): Promise<void> {
  await dbReady;
  const current = await selectById(id);
  if (!current) return;
  if (current.is_system) {
    throw new Error("Built-in user roles cannot be deleted");
  }
  const { standard } = await ensureClientUserRolesForCompany(
    current.company_id,
  );
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
 * Role must belong to the user's company. billing_access override wins.
 */
export async function resolveClientAccessForUser(row: {
  role: string;
  company_id?: number | null;
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
      client_permissions: { billing: false },
      client_role_name: null,
      client_role_slug: null,
      billing_enabled: false,
    };
  }

  let roleRow: ClientRole | null = null;
  if (row.client_role_id != null) {
    roleRow = await selectById(row.client_role_id);
  }

  // Heal: role missing or from another company → this company's Standard
  if (
    row.company_id != null &&
    (!roleRow || roleRow.company_id !== row.company_id)
  ) {
    try {
      const { standard, billing } = await ensureClientUserRolesForCompany(
        row.company_id,
      );
      roleRow =
        roleRow?.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing ? billing : standard;
    } catch {
      roleRow = null;
    }
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
