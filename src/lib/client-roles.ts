import { and, eq, inArray } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import {
  BILLING_CLIENT_PERMISSIONS,
  EMPTY_CLIENT_PERMISSIONS,
  STANDARD_CLIENT_PERMISSIONS,
  SYSTEM_CLIENT_ROLE_SLUGS,
  parseClientPermissions,
  serializeClientPermissions,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type {
  ClientRole,
  ClientRoleMember,
  ClientUserRole,
  Company,
  User,
} from "@/lib/types";

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
 * Ensure Default + Billing user roles exist for ONE client company.
 * Safe to call repeatedly. Every new client user gets Default automatically.
 * Additional groups only ADD access (never deny).
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
      name: "Default",
      slug: SYSTEM_CLIENT_ROLE_SLUGS.standard,
      description:
        "Base group for every contact at this company. Always assigned. Edit its sections to tighten what everyone gets; additional groups only add more access.",
      permissions: serializeClientPermissions(STANDARD_CLIENT_PERMISSIONS),
      is_system: true,
      active: true,
    });
  } else if (
    standard.name === "Standard user" ||
    standard.name === "Standard"
  ) {
    // Rename legacy "Standard" → "Default" (non-destructive)
    try {
      await db
        .update(schema.client_roles)
        .set({
          name: "Default",
          description:
            standard.description?.includes("Standard")
              ? "Base group for every contact at this company. Always assigned. Edit its sections to tighten what everyone gets; additional groups only add more access."
              : standard.description,
        })
        .where(eq(schema.client_roles.id, standard.id));
      standard = (await selectById(standard.id)) ?? standard;
    } catch {
      /* ignore rename */
    }
  }

  let billing = await selectByCompanySlug(
    companyId,
    SYSTEM_CLIENT_ROLE_SLUGS.billing,
  );
  if (!billing) {
    billing = await insertRole({
      company_id: companyId,
      name: "Billing",
      slug: SYSTEM_CLIENT_ROLE_SLUGS.billing,
      description:
        "Additional group — adds Billing (invoices & contracts) on top of Default. Create more groups the same way (e.g. Accounting) to grant only the sections you choose.",
      permissions: serializeClientPermissions(BILLING_CLIENT_PERMISSIONS),
      is_system: true,
      active: true,
    });
  } else if (billing.name === "Billing contact") {
    try {
      await db
        .update(schema.client_roles)
        .set({
          name: "Billing",
          description:
            "Additional group — adds Billing (invoices & contracts) on top of Default. Create more groups the same way (e.g. Accounting) to grant only the sections you choose.",
        })
        .where(eq(schema.client_roles.id, billing.id));
      billing = (await selectById(billing.id)) ?? billing;
    } catch {
      /* ignore */
    }
  }

  return { standard, billing };
}

/** Membership rows for one user. */
export async function listMembershipsForUser(
  userId: number,
): Promise<ClientUserRole[]> {
  await dbReady;
  try {
    return (await db
      .select()
      .from(schema.client_user_roles)
      .where(eq(schema.client_user_roles.user_id, userId))) as ClientUserRole[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/client_user_roles/i.test(msg) && /does not exist/i.test(msg)) {
      return [];
    }
    throw e;
  }
}

/** Role rows for one user (memberships resolved). */
export async function listRolesForUser(userId: number): Promise<ClientRole[]> {
  const memberships = await listMembershipsForUser(userId);
  if (memberships.length === 0) return [];
  const roleIds = [...new Set(memberships.map((m) => m.role_id))];
  const roles = (await db
    .select()
    .from(schema.client_roles)
    .where(inArray(schema.client_roles.id, roleIds))) as ClientRole[];
  return roles.sort((a, b) => {
    // Standard first, then billing, then name
    if (a.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) return -1;
    if (b.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) return 1;
    if (a.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing) return -1;
    if (b.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Members of one role/group (for expandable UI). */
export async function listMembersForRole(
  roleId: number,
): Promise<ClientRoleMember[]> {
  await dbReady;
  const role = await selectById(roleId);
  if (!role) return [];
  const isCore = role.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard;

  // Core Standard: ensure every client user of this company is a member, then list them.
  if (isCore && role.company_id) {
    try {
      await ensureAllClientCompanyRoles({ companyId: role.company_id });
    } catch {
      /* ignore ensure failures */
    }
  }

  let memberships: ClientUserRole[] = [];
  try {
    memberships = (await db
      .select()
      .from(schema.client_user_roles)
      .where(
        eq(schema.client_user_roles.role_id, roleId),
      )) as ClientUserRole[];
  } catch {
    memberships = [];
  }

  // Fallback for Standard: if membership table empty/missing, show all company clients
  if (memberships.length === 0 && isCore && role.company_id) {
    try {
      const companyUsers = (
        (await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.company_id, role.company_id))) as User[]
      ).filter((u) => u.role === "client");
      return companyUsers
        .map((u) => ({
          user_id: u.id,
          name: u.name,
          email: u.email,
          active: u.active,
          is_core: true,
        }))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
    } catch {
      return [];
    }
  }

  if (memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.user_id);
  const users = (await db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.id, userIds))) as User[];

  return users
    .map((u) => ({
      user_id: u.id,
      name: u.name,
      email: u.email,
      active: u.active,
      is_core: isCore,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/**
 * Replace a user's additional role memberships.
 * Standard is always kept. Pass role ids that belong to the company
 * (Standard may be included; it is forced on).
 */
export async function setUserClientRoles(opts: {
  userId: number;
  companyId: number;
  /** Role ids to assign (Standard is always added) */
  roleIds: number[];
}): Promise<ClientRole[]> {
  await dbReady;
  const { standard } = await ensureClientUserRolesForCompany(opts.companyId);
  const companyRoles = await listClientRolesForCompany(opts.companyId);
  const byId = new Map(companyRoles.map((r) => [r.id, r]));

  const wanted = new Set<number>();
  wanted.add(standard.id);
  for (const id of opts.roleIds) {
    const r = byId.get(id);
    if (r && r.company_id === opts.companyId && r.active !== false) {
      wanted.add(id);
    }
  }

  let existing: ClientUserRole[] = [];
  try {
    existing = await listMembershipsForUser(opts.userId);
  } catch {
    existing = [];
  }

  // Remove memberships not wanted (or wrong company)
  for (const m of existing) {
    if (m.company_id !== opts.companyId || !wanted.has(m.role_id)) {
      try {
        await db
          .delete(schema.client_user_roles)
          .where(eq(schema.client_user_roles.id, m.id));
      } catch {
        /* ignore */
      }
    }
  }

  const remaining = new Set(
    (await listMembershipsForUser(opts.userId))
      .filter((m) => m.company_id === opts.companyId)
      .map((m) => m.role_id),
  );

  for (const roleId of wanted) {
    if (remaining.has(roleId)) continue;
    try {
      await db.insert(schema.client_user_roles).values({
        user_id: opts.userId,
        role_id: roleId,
        company_id: opts.companyId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/client_user_roles/i.test(msg) && /does not exist/i.test(msg)) {
        throw new Error(
          'Table client_user_roles is missing. Rebuild the app container, then run: curl -sS -m 45 "http://127.0.0.1:3000/api/db/status?migrate=1"',
        );
      }
      // unique violation — already there
      if (!/unique|duplicate/i.test(msg)) throw e;
    }
  }

  // Keep legacy client_role_id = Standard for back-compat displays
  try {
    await db
      .update(schema.users)
      .set({ client_role_id: standard.id })
      .where(eq(schema.users.id, opts.userId));
  } catch {
    /* ignore */
  }

  return listRolesForUser(opts.userId);
}

/** Ensure Standard membership exists; migrate legacy client_role_id if needed. */
export async function ensureUserMemberships(opts: {
  userId: number;
  companyId: number;
  /** Legacy single role to import as additional if not Standard */
  legacyRoleId?: number | null;
}): Promise<ClientRole[]> {
  await dbReady;
  const { standard } = await ensureClientUserRolesForCompany(opts.companyId);
  const memberships = await listMembershipsForUser(opts.userId);
  const companyMemberships = memberships.filter(
    (m) => m.company_id === opts.companyId,
  );

  if (companyMemberships.length === 0) {
    const seedIds = [standard.id];
    if (
      opts.legacyRoleId != null &&
      opts.legacyRoleId !== standard.id
    ) {
      const legacy = await selectById(opts.legacyRoleId);
      if (legacy && legacy.company_id === opts.companyId) {
        seedIds.push(legacy.id);
      }
    }
    return setUserClientRoles({
      userId: opts.userId,
      companyId: opts.companyId,
      roleIds: seedIds,
    });
  }

  // Always ensure Standard is present
  if (!companyMemberships.some((m) => m.role_id === standard.id)) {
    try {
      await db.insert(schema.client_user_roles).values({
        user_id: opts.userId,
        role_id: standard.id,
        company_id: opts.companyId,
      });
    } catch {
      /* ignore */
    }
  }

  return listRolesForUser(opts.userId);
}

/**
 * Create default user roles for every active client company, migrate
 * legacy single-role users into memberships, ensure Standard for all.
 */
export async function ensureAllClientCompanyRoles(opts?: {
  /** Limit to one company (e.g. when listing its Default members). */
  companyId?: number;
}): Promise<void> {
  await dbReady;
  // Set-based: read everything once, then write only what is missing.
  // (Previously ~3 sequential round-trips per company + 1 per user.)
  const [companies, roleRows, userRows] = await Promise.all([
    db.select().from(schema.companies) as Promise<Company[]>,
    db.select().from(schema.client_roles) as Promise<ClientRole[]>,
    db
      .select({
        id: schema.users.id,
        role: schema.users.role,
        company_id: schema.users.company_id,
        client_role_id: schema.users.client_role_id,
      })
      .from(schema.users) as Promise<
      Array<{ id: number; role: string; company_id: number | null; client_role_id: number | null }>
    >,
  ]);
  let memberships: ClientUserRole[] = [];
  try {
    memberships = (await db.select().from(schema.client_user_roles)) as ClientUserRole[];
  } catch {
    memberships = [];
  }

  const clients = companies.filter(
    (c) => c.type === "client" && (opts?.companyId == null || c.id === opts.companyId),
  );

  // 1) System roles per company — only touch companies missing / with legacy names
  const standardByCompany = new Map<number, ClientRole>();
  for (const c of clients) {
    const own = roleRows.filter((r) => r.company_id === c.id);
    const std = own.find((r) => r.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard);
    const bill = own.find((r) => r.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing);
    const legacyName =
      std?.name === "Standard user" || std?.name === "Standard" || bill?.name === "Billing contact";
    try {
      if (!std || !bill || legacyName) {
        const ensured = await ensureClientUserRolesForCompany(c.id);
        standardByCompany.set(c.id, ensured.standard);
        roleRows.push(ensured.standard, ensured.billing);
      } else {
        standardByCompany.set(c.id, std);
      }
    } catch (e) {
      console.warn(`[akab] client user roles for company #${c.id} failed:`, e);
    }
  }

  // 2) Memberships: every client user has Default; legacy single role imported once
  const roleById = new Map(roleRows.map((r) => [r.id, r]));
  const have = new Set(memberships.map((m) => `${m.user_id}:${m.role_id}`));
  const toInsert: Array<{ user_id: number; role_id: number; company_id: number }> = [];
  const pinLegacyToStandard = new Map<number, number[]>(); // standardId → userIds
  for (const u of userRows) {
    if (u.role !== "client" || u.company_id == null) continue;
    const standard = standardByCompany.get(u.company_id);
    if (!standard) continue;
    const mine = memberships.filter(
      (m) => m.user_id === u.id && m.company_id === u.company_id,
    );
    const add = (roleId: number) => {
      const key = `${u.id}:${roleId}`;
      if (have.has(key)) return;
      have.add(key);
      toInsert.push({ user_id: u.id, role_id: roleId, company_id: u.company_id! });
    };
    if (mine.length === 0) {
      add(standard.id);
      const legacy = u.client_role_id != null ? roleById.get(u.client_role_id) : null;
      if (legacy && legacy.id !== standard.id && legacy.company_id === u.company_id) {
        add(legacy.id);
      }
      if (u.client_role_id !== standard.id) {
        const list = pinLegacyToStandard.get(standard.id) ?? [];
        list.push(u.id);
        pinLegacyToStandard.set(standard.id, list);
      }
    } else if (!mine.some((m) => m.role_id === standard.id)) {
      add(standard.id);
    }
  }
  for (let i = 0; i < toInsert.length; i += 500) {
    try {
      await db
        .insert(schema.client_user_roles)
        .values(toInsert.slice(i, i + 500))
        .onConflictDoNothing();
    } catch (e) {
      console.warn("[akab] client user role memberships insert failed:", e);
    }
  }
  // Keep legacy client_role_id = Standard for back-compat displays
  for (const [standardId, ids] of pinLegacyToStandard) {
    try {
      await db
        .update(schema.users)
        .set({ client_role_id: standardId })
        .where(inArray(schema.users.id, ids));
    } catch {
      /* ignore */
    }
  }

  // 3) Drop legacy global roles (company_id missing/0) if unused
  if (opts?.companyId != null) return;
  try {
    const usedRoleIds = new Set(userRows.map((u) => u.client_role_id));
    for (const r of roleRows) {
      const cid = Number(r.company_id);
      if (Number.isFinite(cid) && cid > 0) continue;
      if (!usedRoleIds.has(r.id)) {
        await db.delete(schema.client_roles).where(eq(schema.client_roles.id, r.id));
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
    if (a.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) return -1;
    if (b.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) return 1;
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
  if (
    current.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard &&
    patch.permissions
  ) {
    // Standard stays core-only — don't strip or invent billing here silently
  }
  const next: Record<string, unknown> = {};
  if (patch.name != null) {
    if (current.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) {
      // keep name editable lightly
      next.name = patch.name.trim() || current.name;
    } else {
      next.name = patch.name.trim();
    }
  }
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
  // Drop memberships for this role only — users keep Standard + other groups
  try {
    await db
      .delete(schema.client_user_roles)
      .where(eq(schema.client_user_roles.role_id, id));
  } catch {
    /* table may not exist yet */
  }
  // Legacy column cleanup
  try {
    const { standard } = await ensureClientUserRolesForCompany(
      current.company_id,
    );
    await db
      .update(schema.users)
      .set({ client_role_id: standard.id })
      .where(eq(schema.users.client_role_id, id));
  } catch {
    /* ignore */
  }
  await db.delete(schema.client_roles).where(eq(schema.client_roles.id, id));
}

export function permissionsOfClientRole(
  role: ClientRole | null | undefined,
): ClientPermissionMap {
  if (!role) return { ...STANDARD_CLIENT_PERMISSIONS };
  return parseClientPermissions(role.permissions);
}

/** OR-merge permission maps (any true wins). */
export function stackClientPermissions(
  maps: ClientPermissionMap[],
): ClientPermissionMap {
  const out: ClientPermissionMap = { ...EMPTY_CLIENT_PERMISSIONS };
  for (const m of maps) {
    for (const key of Object.keys(out) as (keyof ClientPermissionMap)[]) {
      if (m[key]) out[key] = true;
    }
  }
  return out;
}

/**
 * Resolve effective client permissions for a portal user.
 * Memberships stack (OR). billing_access override wins when set.
 * Standard is always part of the stack for client users.
 */
export async function resolveClientAccessForUser(row: {
  id?: number;
  role: string;
  company_id?: number | null;
  client_role_id?: number | null;
  billing_access?: boolean | null;
}): Promise<{
  client_permissions: ClientPermissionMap;
  client_role_name: string | null;
  client_role_slug: string | null;
  client_role_names: string[];
  client_role_slugs: string[];
  billing_enabled: boolean;
}> {
  if (row.role !== "client") {
    return {
      client_permissions: { ...EMPTY_CLIENT_PERMISSIONS },
      client_role_name: null,
      client_role_slug: null,
      client_role_names: [],
      client_role_slugs: [],
      billing_enabled: false,
    };
  }

  let roles: ClientRole[] = [];
  if (row.id != null && row.company_id != null) {
    try {
      roles = await ensureUserMemberships({
        userId: row.id,
        companyId: row.company_id,
        legacyRoleId: row.client_role_id,
      });
    } catch {
      roles = [];
    }
  } else if (row.client_role_id != null) {
    const one = await selectById(row.client_role_id);
    if (one) roles = [one];
  }

  if (roles.length === 0 && row.company_id != null) {
    try {
      const { standard } = await ensureClientUserRolesForCompany(
        row.company_id,
      );
      roles = [standard];
    } catch {
      roles = [];
    }
  }

  const stacked = stackClientPermissions(
    roles.map((r) => permissionsOfClientRole(r)),
  );
  const billing =
    row.billing_access === true
      ? true
      : row.billing_access === false
        ? false
        : stacked.billing;

  const names = roles.map((r) => r.name);
  const slugs = roles.map((r) => r.slug);
  const primary =
    roles.find((r) => r.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard) ??
    roles[0] ??
    null;

  return {
    client_permissions: { ...stacked, billing },
    client_role_name: primary?.name ?? names[0] ?? null,
    client_role_slug: primary?.slug ?? slugs[0] ?? null,
    client_role_names: names,
    client_role_slugs: slugs,
    billing_enabled: billing,
  };
}
