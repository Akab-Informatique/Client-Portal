import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { auth, permissionsOf, requirePermission, revokeUserSessions, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { asConnection, listCalendars, O365Error, o365Ready } from "../lib/o365.ts";
import { hashPassword, temporaryPassword } from "../lib/crypto.ts";
import { audit } from "../lib/audit.ts";
import { mailConfigured } from "../lib/mail.ts";
import { sendPasswordLink } from "../lib/passwordLinks.ts";
import { body, zEmail, zName, zOptText, zPhone, zUuid } from "../lib/validate.ts";
import {
  effectivePermissions,
  isPermissionKey,
  MASTER_ROLE,
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

/** The master administrator role's id. */
async function masterRoleId(): Promise<string | null> {
  const [r] = await db().select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.slug, MASTER_ROLE));
  return r?.id ?? null;
}
/**
 * A global admin manages technicians but cannot make anyone master
 * administrator (themselves included), nor change, reset or disable one.
 */
async function assertMasterGuard(a: AuthContext, p: { target?: UserRow; roleId?: string | null }) {
  const master = await masterRoleId();
  if (!master || a.realUser.roleId === master) return;
  if (p.target?.roleId === master || (p.roleId !== undefined && p.roleId === master)) throw new HTTPException(403, { message: "master_only" });
}

async function staffTarget(id: string | undefined): Promise<UserRow> {
  const target = await getUser(zUuid.parse(id));
  if (target.kind !== "staff") throw new HTTPException(400, { message: "staff_only" });
  return target;
}
async function signInOf(userId: string) {
  if (!zUuid.safeParse(userId).success) return null;
  const [conn] = await db().select().from(schema.msConnections).where(eq(schema.msConnections.userId, userId));
  return conn ?? null;
}
async function calendarLink(id: string | undefined) {
  const [l] = await db().select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, zUuid.parse(id)));
  if (!l) throw new HTTPException(404, { message: "not_found" });
  return l;
}
/** What the admin panel shows for a technician's Microsoft 365. */
async function o365View(target: UserRow) {
  const links = await db().select().from(schema.calendarLinks).where(eq(schema.calendarLinks.technicianId, target.id)).orderBy(asc(schema.calendarLinks.createdAt));
  const conns = await db().select({ userId: schema.msConnections.userId, email: schema.msConnections.email, lastError: schema.msConnections.lastError }).from(schema.msConnections);
  const staff = await db().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true))).orderBy(asc(schema.users.name));
  const signIn = (id: string | null) => conns.find((x) => x.userId === id) ?? null;
  return {
    enabled: (await permissionsOf(target)).includes("tickets.o365"),
    mailbox: target.o365Email,
    integrationReady: await o365Ready(),
    signIn: signIn(target.id) ? { email: signIn(target.id)!.email, needsReconnect: signIn(target.id)!.lastError === "reconnect" } : null,
    links: links.map((l) => ({
      id: l.id,
      source: l.source,
      ownerId: l.ownerId,
      mailbox: l.source === "user" ? (signIn(l.ownerId)?.email ?? null) : l.mailbox,
      calendarName: l.calendarName,
      label: l.label,
      display: l.display,
      push: l.push,
      signedIn: l.source === "app" || Boolean(signIn(l.ownerId)),
    })),
    /** Technicians whose own sign-in can lend their calendar */
    people: staff.map((u) => ({ id: u.id, name: u.name, email: u.email, signedIn: Boolean(signIn(u.id)) })),
  };
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
    await assertMasterGuard(auth(c), { roleId: p.roleId });
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
    await assertMasterGuard(a, { target });
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
    await assertMasterGuard(a, { roleId: p.roleId });
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
    await assertMasterGuard(a, { target });
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
    await assertMasterGuard(a, { target });
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
    await assertMasterGuard(a, { target });
    await db()
      .update(schema.users)
      .set({ mfaEnabled: false, mfaSecret: null, mfaLastStep: null, updatedAt: new Date() })
      .where(eq(schema.users.id, target.id));
    await revokeUserSessions(target.id);
    await audit(a.user.id, "user.mfa_reset", target.id);
    return c.json({ ok: true });
  })
  /**
   * Microsoft 365 for a technician (master administrators: the organisation
   * access reads any calendar of AKAB): sync on / off (the right
   * tickets.o365 on top of the role), and the calendars shown in their
   * planning with what each shows.
   */
  .get("/users/:id/o365", requirePermission("admin.o365"), async (c) => {
    const target = await staffTarget(c.req.param("id"));
    return c.json(await o365View(target));
  })
  .put("/users/:id/o365", requirePermission("admin.o365"), async (c) => {
    const a = auth(c);
    const target = await staffTarget(c.req.param("id"));
    const p = await body(c, z.object({ enabled: z.boolean(), mailbox: zEmail.nullable().optional() }));
    // the role decides by default; the switch adds or removes the right for this person only
    await db().delete(schema.userPermissions).where(and(eq(schema.userPermissions.userId, target.id), eq(schema.userPermissions.permission, "tickets.o365")));
    const byRole = (await permissionsOf(target)).includes("tickets.o365");
    if (p.enabled !== byRole) await db().insert(schema.userPermissions).values({ userId: target.id, permission: "tickets.o365", effect: p.enabled ? "allow" : "deny" });
    if (p.mailbox !== undefined) await db().update(schema.users).set({ o365Email: p.mailbox, updatedAt: new Date() }).where(eq(schema.users.id, target.id));
    await audit(a.user.id, "user.o365", target.id, { enabled: p.enabled, mailbox: p.mailbox });
    return c.json(await o365View(await getUser(target.id)));
  })
  /** The calendars of a mailbox, to choose one: through its owner's sign-in, or the organisation access. */
  .get("/users/:id/o365/calendars", requirePermission("admin.o365"), async (c) => {
    await staffTarget(c.req.param("id"));
    const q = z.object({ source: z.enum(["user", "app"]), ownerId: zUuid.optional(), mailbox: zEmail.optional() }).parse(c.req.query());
    try {
      if (q.source === "user") {
        const conn = await signInOf(q.ownerId ?? "");
        if (!conn) throw new HTTPException(409, { message: "o365_not_signed_in" });
        return c.json(await asConnection(q.ownerId!, () => listCalendars(conn.email)));
      }
      if (!q.mailbox) throw new HTTPException(400, { message: "Validation failed" });
      return c.json(await listCalendars(q.mailbox));
    } catch (err) {
      if (err instanceof O365Error) throw new HTTPException(err.code === "not_found" ? 404 : 502, { message: `o365_${err.code}` });
      throw err;
    }
  })
  /** Show a calendar in this technician's planning. */
  .post("/users/:id/calendar-links", requirePermission("admin.o365"), async (c) => {
    const a = auth(c);
    const target = await staffTarget(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        source: z.enum(["user", "app"]),
        ownerId: zUuid.optional(),
        mailbox: zEmail.optional(),
        calendarId: z.string().min(1).max(400).nullable().optional(),
        calendarName: z.string().trim().max(200).nullable().optional(),
        display: z.enum(["details", "busy"]),
        push: z.boolean().default(false),
      }),
    );
    let label: string;
    if (p.source === "user") {
      const owner = p.ownerId ? await getUser(p.ownerId).catch(() => null) : null;
      if (!owner || owner.kind !== "staff") throw new HTTPException(400, { message: "Validation failed" });
      if (!(await signInOf(owner.id))) throw new HTTPException(409, { message: "o365_not_signed_in" });
      label = owner.name;
    } else {
      if (!p.mailbox) throw new HTTPException(400, { message: "Validation failed" });
      if (!(await o365Ready())) throw new HTTPException(409, { message: "o365_not_configured" });
      const [owner] = await db().select().from(schema.users).where(sql`lower(${schema.users.email}) = ${p.mailbox.toLowerCase()} or lower(${schema.users.o365Email}) = ${p.mailbox.toLowerCase()}`);
      label = owner?.name ?? p.mailbox;
      p.ownerId = owner?.id;
    }
    const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.calendarLinks).where(eq(schema.calendarLinks.technicianId, target.id));
    if (n >= 20) throw new HTTPException(409, { message: "too_many" });
    // one calendar receives the technician's blocks
    if (p.push) await db().update(schema.calendarLinks).set({ push: false }).where(eq(schema.calendarLinks.technicianId, target.id));
    const [row] = await db()
      .insert(schema.calendarLinks)
      .values({
        technicianId: target.id,
        source: p.source,
        ownerId: p.ownerId ?? null,
        mailbox: p.source === "app" ? p.mailbox!.toLowerCase() : null,
        calendarId: p.calendarId ?? null,
        calendarName: p.calendarName ?? null,
        label,
        display: p.display,
        push: p.push,
        createdBy: a.user.id,
      })
      .returning();
    await audit(a.user.id, "calendar.linked", target.id, { linkId: row.id, source: row.source, ownerId: row.ownerId, mailbox: row.mailbox, display: row.display, push: row.push });
    return c.json(await o365View(target), 201);
  })
  .patch("/calendar-links/:linkId", requirePermission("admin.o365"), async (c) => {
    const a = auth(c);
    const link = await calendarLink(c.req.param("linkId"));
    const p = await body(c, z.object({ display: z.enum(["details", "busy"]).optional(), push: z.boolean().optional() }));
    if (p.push) await db().update(schema.calendarLinks).set({ push: false }).where(eq(schema.calendarLinks.technicianId, link.technicianId));
    await db().update(schema.calendarLinks).set({ ...p, updatedAt: new Date() }).where(eq(schema.calendarLinks.id, link.id));
    await audit(a.user.id, "calendar.link_updated", link.technicianId, { linkId: link.id, ...p });
    return c.json(await o365View(await getUser(link.technicianId)));
  })
  .delete("/calendar-links/:linkId", requirePermission("admin.o365"), async (c) => {
    const a = auth(c);
    const link = await calendarLink(c.req.param("linkId"));
    await db().delete(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    await audit(a.user.id, "calendar.unlinked", link.technicianId, { linkId: link.id });
    return c.json(await o365View(await getUser(link.technicianId)));
  })

  /** Rights granted or denied directly to this user (on top of the role). */
  .put("/users/:id/permissions", requirePermission("admin.roles"), async (c) => {
    const a = auth(c);
    const target = await getUser(zUuid.parse(c.req.param("id")));
    assertCanManage(a.permissions, target.kind);
    await assertMasterGuard(a, { target });
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
