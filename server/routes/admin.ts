import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { auth, permissionsOf, requirePermission, revokeUserSessions, type AppEnv } from "../lib/auth.ts";
import { o365Ready } from "../lib/o365.ts";
import { hashPassword, temporaryPassword } from "../lib/crypto.ts";
import { audit } from "../lib/audit.ts";
import { mailConfigured } from "../lib/mail.ts";
import { sendPasswordLink } from "../lib/passwordLinks.ts";
import { body, zEmail, zName, zOptText, zPhone, zUuid } from "../lib/validate.ts";
import {
  effectivePermissions,
  isPermissionKey,
  permissionsFor,
  type Audience,
  type Override,
  type PermissionKey,
} from "../../shared/permissions.ts";

type UserRow = typeof schema.users.$inferSelect;

// ── helpers ──────────────────────────────────────────────────────────────────
function publicUser(u: UserRow, overrides: { permission: string; effect: "allow" | "deny" }[] = []) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    kind: u.kind,
    clientId: u.clientId,
    roleId: u.roleId,
    active: u.active,
    title: u.title,
    phone: u.phone,
    mobile: u.mobile,
    o365Email: u.o365Email,
    locale: u.locale,
    notifyEmail: u.notifyEmail,
    mfaEnabled: u.mfaEnabled,
    mustChangePassword: u.mustChangePassword,
    locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    overrides,
  };
}

async function withOverrides(rows: UserRow[]) {
  if (!rows.length) return [];
  const ov = await db()
    .select()
    .from(schema.userPermissions)
    .where(inArray(schema.userPermissions.userId, rows.map((r) => r.id)));
  return rows.map((u) =>
    publicUser(
      u,
      ov.filter((o) => o.userId === u.id).map((o) => ({ permission: o.permission, effect: o.effect })),
    ),
  );
}

async function getUser(id: string): Promise<UserRow> {
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw new HTTPException(404, { message: "not_found" });
  return u;
}

/** Managing a user needs admin.staff (technicians) or admin.clients (client users). */
function assertCanManage(perms: PermissionKey[], kind: Audience) {
  const needed: PermissionKey = kind === "staff" ? "admin.staff" : "admin.clients";
  if (!perms.includes(needed)) throw new HTTPException(403, { message: "Forbidden" });
}

async function assertRoleFor(roleId: string | null | undefined, audience: Audience) {
  if (!roleId) return;
  const [r] = await db().select().from(schema.roles).where(eq(schema.roles.id, roleId));
  if (!r || r.audience !== audience) throw new HTTPException(400, { message: "invalid_role" });
}

async function emailTaken(email: string, exceptId?: string): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`);
  return rows.some((r) => r.id !== exceptId);
}

/**
 * Lock-out guard: after a pending change, at least one active technician must
 * still hold both admin.staff and admin.roles (able to repair access).
 */
async function assertAdminRemains(change: {
  userId?: string;
  active?: boolean;
  roleId?: string | null;
  overrides?: Override[];
  role?: { id: string; permissions: string[] };
}) {
  const d = db();
  const staff = await d.select().from(schema.users).where(eq(schema.users.kind, "staff"));
  const roles = await d.select().from(schema.roles);
  const ovs = await d.select().from(schema.userPermissions);
  const ok = staff.some((u) => {
    const pending = u.id === change.userId;
    const active = pending && change.active !== undefined ? change.active : u.active;
    if (!active) return false;
    const roleId = pending && change.roleId !== undefined ? change.roleId : u.roleId;
    const role = roles.find((r) => r.id === roleId);
    const rolePerms =
      change.role && role && role.id === change.role.id ? change.role.permissions : (role?.permissions ?? []);
    const overrides: Override[] =
      pending && change.overrides
        ? change.overrides
        : ovs
            .filter((o) => o.userId === u.id && isPermissionKey(o.permission))
            .map((o) => ({ key: o.permission as PermissionKey, effect: o.effect }));
    const perms = effectivePermissions("staff", role?.audience === "staff" ? rolePerms : [], overrides);
    return perms.includes("admin.staff") && perms.includes("admin.roles");
  });
  if (!ok) throw new HTTPException(409, { message: "last_admin" });
}

const userInput = {
  email: zEmail,
  name: zName,
  title: zOptText(120),
  phone: zOptText(40),
  roleId: zUuid.nullable().optional(),
  locale: z.enum(["fr", "en"]).optional(),
  notifyEmail: z.boolean().optional(),
  /** Email a "choose your password" link (welcome template) */
  sendWelcome: z.boolean().optional(),
};

async function createUser(
  actorId: string,
  kind: Audience,
  clientId: string | null,
  p: {
    email: string;
    name: string;
    title?: string | null;
    phone?: string | null;
    roleId?: string | null;
    locale?: "fr" | "en";
    notifyEmail?: boolean;
    sendWelcome?: boolean;
  },
  c?: Context,
) {
  if (await emailTaken(p.email)) throw new HTTPException(409, { message: "email_taken" });
  await assertRoleFor(p.roleId, kind);
  const password = temporaryPassword();
  const [u] = await db()
    .insert(schema.users)
    .values({
      email: p.email,
      name: p.name,
      kind,
      clientId,
      roleId: p.roleId ?? null,
      title: p.title ?? null,
      phone: p.phone ?? null,
      locale: p.locale ?? "fr",
      notifyEmail: p.notifyEmail ?? true,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    })
    .returning();
  await audit(actorId, `${kind}.created`, u.id, { email: u.email, clientId });
  const welcomeSent = p.sendWelcome ? await sendPasswordLink(u, "welcome", c) : false;
  if (welcomeSent) await audit(actorId, "user.welcome_sent", u.id);
  return { user: publicUser(u), temporaryPassword: password, welcomeSent };
}

// ── routes ───────────────────────────────────────────────────────────────────
export const adminRoutes = new Hono<AppEnv>()
  // Technicians
  .get("/staff", requirePermission("admin.staff"), async (c) => {
    const rows = await db().select().from(schema.users).where(eq(schema.users.kind, "staff")).orderBy(asc(schema.users.name));
    return c.json(await withOverrides(rows));
  })
  .post("/staff", requirePermission("admin.staff"), async (c) => {
    const p = await body(c, z.object(userInput));
    return c.json(await createUser(auth(c).user.id, "staff", null, p, c), 201);
  })

  // Clients
  .get("/clients", requirePermission("admin.clients"), async (c) => {
    const rows = await db()
      .select({
        client: schema.clients,
        userCount: sql<number>`(select count(*)::int from users u where u.client_id = "clients"."id")`,
      })
      .from(schema.clients)
      .orderBy(asc(schema.clients.name));
    return c.json(rows.map((r) => ({ ...r.client, userCount: r.userCount })));
  })
  .post("/clients", requirePermission("admin.clients"), async (c) => {
    const p = await body(
      c,
      z.object({
        name: zName,
        code: zOptText(20),
        email: zOptText(254),
        phone: zOptText(40),
        address: zOptText(300),
        notes: zOptText(2000),
      }),
    );
    const [row] = await db().insert(schema.clients).values(p).returning();
    await audit(auth(c).user.id, "client.created", row.id, { name: row.name });
    return c.json({ ...row, userCount: 0 }, 201);
  })
  .patch("/clients/:id", requirePermission("admin.clients"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        name: zName.optional(),
        code: zOptText(20),
        email: zOptText(254),
        phone: zOptText(40),
        address: zOptText(300),
        notes: zOptText(2000),
        active: z.boolean().optional(),
      }),
    );
    const [row] = await db()
      .update(schema.clients)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.clients.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    if (p.active === false) {
      const members = await db().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.clientId, id));
      for (const m of members) await revokeUserSessions(m.id);
    }
    await audit(auth(c).user.id, "client.updated", id, p);
    return c.json(row);
  })
  .get("/clients/:id/users", requirePermission("admin.clients"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const rows = await db().select().from(schema.users).where(eq(schema.users.clientId, id)).orderBy(asc(schema.users.name));
    return c.json(await withOverrides(rows));
  })
  .post("/clients/:id/users", requirePermission("admin.clients"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.id, id));
    if (!client) throw new HTTPException(404, { message: "not_found" });
    const p = await body(c, z.object(userInput));
    return c.json(await createUser(auth(c).user.id, "client", id, p, c), 201);
  })

  // Any user (technician or client user)
  .patch("/users/:id", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    const p = await body(
      c,
      z.object({
        email: zEmail.optional(),
        name: zName.optional(),
        title: zOptText(120),
        phone: zOptText(40),
        mobile: zPhone,
        roleId: zUuid.nullable().optional(),
        locale: z.enum(["fr", "en"]).optional(),
        notifyEmail: z.boolean().optional(),
        active: z.boolean().optional(),
        unlock: z.boolean().optional(),
      }),
    );
    if (p.email && (await emailTaken(p.email, target.id))) throw new HTTPException(409, { message: "email_taken" });
    if (p.roleId !== undefined) await assertRoleFor(p.roleId, target.kind);
    if (target.id === a.user.id && p.active === false) throw new HTTPException(409, { message: "cannot_disable_self" });
    if (target.kind === "staff" && (p.active !== undefined || p.roleId !== undefined)) {
      await assertAdminRemains({ userId: target.id, active: p.active, roleId: p.roleId });
    }
    const { unlock, ...fields } = p;
    const [u] = await db()
      .update(schema.users)
      .set({ ...fields, ...(unlock ? { lockedUntil: null, failedLogins: 0 } : {}), updatedAt: new Date() })
      .where(eq(schema.users.id, target.id))
      .returning();
    if (p.active === false) await revokeUserSessions(target.id);
    await audit(a.user.id, "user.updated", target.id, { ...fields, unlock });
    return c.json((await withOverrides([u]))[0]);
  })
  .post("/users/:id/reset-password", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    const password = temporaryPassword();
    await db()
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: true, lockedUntil: null, failedLogins: 0, updatedAt: new Date() })
      .where(eq(schema.users.id, target.id));
    await revokeUserSessions(target.id);
    await audit(a.user.id, "user.password_reset", target.id);
    return c.json({ temporaryPassword: password });
  })
  /** Email a password reset link (the person chooses the new password). */
  .post("/users/:id/send-reset-link", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    if (!target.active) throw new HTTPException(409, { message: "user_inactive" });
    // Development without a mail server prints the email to the console
    if (config.production && !(await mailConfigured())) throw new HTTPException(409, { message: "mail_not_configured" });
    if (!(await sendPasswordLink(target, "reset", c))) throw new HTTPException(502, { message: "mail_failed" });
    await audit(a.user.id, "user.reset_link_sent", target.id);
    return c.json({ ok: true });
  })
  .post("/users/:id/reset-mfa", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    await db()
      .update(schema.users)
      .set({ mfaEnabled: false, mfaSecret: null, mfaLastStep: null, updatedAt: new Date() })
      .where(eq(schema.users.id, target.id));
    await revokeUserSessions(target.id);
    await audit(a.user.id, "user.mfa_reset", target.id);
    return c.json({ ok: true });
  })
  /**
   * Microsoft 365 calendar sync for a technician: on / off (the right
   * tickets.o365, given or taken on top of the role) and the mailbox when it
   * differs from the email. Only admins choose the mailbox: the portal can
   * read any calendar of the organization.
   */
  .get("/users/:id/o365", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    if (target.kind !== "staff") throw new HTTPException(400, { message: "staff_only" });
    return c.json({ enabled: (await permissionsOf(target)).includes("tickets.o365"), mailbox: target.o365Email, integrationReady: await o365Ready() });
  })
  .put("/users/:id/o365", async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    if (target.kind !== "staff") throw new HTTPException(400, { message: "staff_only" });
    const p = await body(c, z.object({ enabled: z.boolean(), mailbox: zEmail.nullable().optional() }));
    // the role decides by default; the switch adds or removes the right for this person only
    await db().delete(schema.userPermissions).where(and(eq(schema.userPermissions.userId, target.id), eq(schema.userPermissions.permission, "tickets.o365")));
    const byRole = (await permissionsOf(target)).includes("tickets.o365");
    if (p.enabled !== byRole) await db().insert(schema.userPermissions).values({ userId: target.id, permission: "tickets.o365", effect: p.enabled ? "allow" : "deny" });
    if (p.mailbox !== undefined) await db().update(schema.users).set({ o365Email: p.mailbox, updatedAt: new Date() }).where(eq(schema.users.id, target.id));
    await audit(a.user.id, "user.o365", target.id, { enabled: p.enabled, mailbox: p.mailbox });
    return c.json({ enabled: p.enabled, mailbox: p.mailbox === undefined ? target.o365Email : p.mailbox, integrationReady: await o365Ready() });
  })

  /** Rights granted or denied directly to this user (on top of the role). */
  .put("/users/:id/permissions", requirePermission("admin.roles"), async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    const { overrides } = await body(
      c,
      z.object({
        overrides: z
          .array(z.object({ key: z.string(), effect: z.enum(["allow", "deny"]) }))
          .max(200),
      }),
    );
    const allowed = new Set<string>(permissionsFor(target.kind));
    const clean: Override[] = [];
    for (const o of overrides) {
      if (!isPermissionKey(o.key) || !allowed.has(o.key)) throw new HTTPException(400, { message: "invalid_permission" });
      clean.push({ key: o.key, effect: o.effect });
    }
    if (target.kind === "staff") await assertAdminRemains({ userId: target.id, overrides: clean });
    await db().delete(schema.userPermissions).where(eq(schema.userPermissions.userId, target.id));
    if (clean.length) {
      await db()
        .insert(schema.userPermissions)
        .values(clean.map((o) => ({ userId: target.id, permission: o.key, effect: o.effect })));
    }
    await audit(a.user.id, "user.permissions", target.id, { overrides: clean });
    return c.json({ ok: true });
  })

  // Roles
  .get("/roles", requirePermission("admin.roles", "admin.staff", "admin.clients"), async (c) => {
    const rows = await db()
      .select({
        role: schema.roles,
        userCount: sql<number>`(select count(*)::int from users u where u.role_id = "roles"."id")`,
      })
      .from(schema.roles)
      .orderBy(desc(schema.roles.isSystem), asc(schema.roles.name));
    return c.json(rows.map((r) => ({ ...r.role, userCount: r.userCount })));
  })
  .post("/roles", requirePermission("admin.roles"), async (c) => {
    const p = await body(
      c,
      z.object({
        name: zName,
        description: zOptText(300),
        audience: z.enum(["staff", "client"]),
        permissions: z.array(z.string()).max(200),
      }),
    );
    const allowed = new Set<string>(permissionsFor(p.audience));
    if (p.permissions.some((k) => !allowed.has(k))) throw new HTTPException(400, { message: "invalid_permission" });
    const [row] = await db()
      .insert(schema.roles)
      .values({ name: p.name, description: p.description ?? null, audience: p.audience, permissions: [...new Set(p.permissions)] })
      .returning();
    await audit(auth(c).user.id, "role.created", row.id, { name: row.name, permissions: row.permissions });
    return c.json({ ...row, userCount: 0 }, 201);
  })
  .patch("/roles/:id", requirePermission("admin.roles"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const [role] = await db().select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!role) throw new HTTPException(404, { message: "not_found" });
    if (role.locked) throw new HTTPException(409, { message: "role_locked" });
    const p = await body(
      c,
      z.object({
        name: zName.optional(),
        description: zOptText(300),
        permissions: z.array(z.string()).max(200).optional(),
      }),
    );
    if (p.permissions) {
      const allowed = new Set<string>(permissionsFor(role.audience));
      if (p.permissions.some((k) => !allowed.has(k))) throw new HTTPException(400, { message: "invalid_permission" });
      p.permissions = [...new Set(p.permissions)];
      if (role.audience === "staff") await assertAdminRemains({ role: { id: role.id, permissions: p.permissions } });
    }
    const [row] = await db()
      .update(schema.roles)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.roles.id, id))
      .returning();
    await audit(auth(c).user.id, "role.updated", id, p);
    return c.json(row);
  })
  .delete("/roles/:id", requirePermission("admin.roles"), async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const [role] = await db().select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!role) throw new HTTPException(404, { message: "not_found" });
    if (role.isSystem) throw new HTTPException(409, { message: "role_system" });
    const [{ n }] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(eq(schema.users.roleId, id));
    if (n > 0) throw new HTTPException(409, { message: "role_in_use" });
    await db().delete(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.isSystem, false)));
    await audit(auth(c).user.id, "role.deleted", id, { name: role.name });
    return c.json({ ok: true });
  })

  // Activity
  .get("/audit", requirePermission("admin.roles", "admin.staff", "admin.clients", "admin.integrations", "admin.email"), async (c) => {
    const rows = await db()
      .select({ log: schema.auditLog, actor: schema.users.name })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(100);
    return c.json(rows.map((r) => ({ ...r.log, actorName: r.actor })));
  });
