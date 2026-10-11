import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { BUILTIN_DASHBOARDS } from "../db/seed.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zName, zUuid } from "../lib/validate.ts";

type Dashboard = typeof schema.dashboards.$inferSelect;
type Access = "view" | "edit";
type Member = { dashboardId: string; userId: string; access: Access };

/**
 * Who sees a dashboard:
 *  - its owner, and the people it is given to directly (members);
 *  - visibility "team" → every technician; "admins" → administrators.
 * Seeing is not editing:
 *  - the default layout is changed only by those who administer the dashboard
 *    (its owner; holders of dashboard.manage for shared ones);
 *  - others may personalize their own layout (the default stays) only when
 *    allowed: `teamAccess` "edit" for the audience, or member access "edit".
 * By default a technician therefore edits only their own dashboards.
 */
const canManage = (a: AuthContext) => a.permissions.includes("dashboard.manage");
const inAudience = (a: AuthContext, d: Dashboard) => d.visibility === "team" || (d.visibility === "admins" && a.isAdmin);
const memberOf = (a: AuthContext, ms: Member[]) => ms.find((m) => m.userId === a.user.id);

function canSee(a: AuthContext, d: Dashboard, ms: Member[]): boolean {
  return d.ownerId === a.user.id || inAudience(a, d) || Boolean(memberOf(a, ms));
}
/** Change visibility, team rights and members (and rename, if not built-in). */
function canAdminister(a: AuthContext, d: Dashboard, ms: Member[]): boolean {
  if (d.ownerId === a.user.id) return true;
  return (Boolean(d.slug) || d.visibility !== "private") && canManage(a) && canSee(a, d, ms);
}
/** Save one's own layout of this dashboard. */
function canCustomize(a: AuthContext, d: Dashboard, ms: Member[]): boolean {
  if (canAdminister(a, d, ms)) return true;
  if (memberOf(a, ms)?.access === "edit") return true;
  return inAudience(a, d) && d.teamAccess === "edit";
}
/** Built-in: admins ↔ team. Own dashboards: private ↔ team. */
function allowedVisibility(a: AuthContext, d: Dashboard, ms: Member[]): Dashboard["visibility"][] {
  if (!canAdminister(a, d, ms)) return [];
  return d.slug ? ["admins", "team"] : d.ownerId === a.user.id ? ["private", "team"] : [];
}
function canDelete(a: AuthContext, d: Dashboard): boolean {
  if (d.slug) return false;
  return d.ownerId === a.user.id || (d.visibility === "team" && canManage(a));
}

const widget = z.object({ id: z.string().min(1).max(60), type: z.string().min(1).max(60), size: z.enum(["sm", "md", "lg"]) });
const zAccess = z.enum(["view", "edit"]);

async function membersOf(ids: string[]): Promise<Member[]> {
  if (!ids.length) return [];
  return db()
    .select({ dashboardId: schema.dashboardMembers.dashboardId, userId: schema.dashboardMembers.userId, access: schema.dashboardMembers.access })
    .from(schema.dashboardMembers)
    .where(inArray(schema.dashboardMembers.dashboardId, ids));
}

/** Load a dashboard the caller can see (404 otherwise, so ids do not leak). */
async function load(a: AuthContext, id: string): Promise<{ d: Dashboard; ms: Member[] }> {
  const [d] = await db().select().from(schema.dashboards).where(eq(schema.dashboards.id, id));
  const ms = d ? await membersOf([d.id]) : [];
  if (!d || !canSee(a, d, ms)) throw new HTTPException(404, { message: "not_found" });
  return { d, ms };
}

const order = (d: Dashboard) => {
  const i = BUILTIN_DASHBOARDS.findIndex((b) => b.slug === d.slug);
  return i === -1 ? BUILTIN_DASHBOARDS.length : i;
};

async function defaultIdOf(userId: string): Promise<string | null> {
  const [p] = await db()
    .select({ id: schema.userPreferences.defaultDashboardId })
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, userId));
  return p?.id ?? null;
}

async function view(a: AuthContext, rows: Dashboard[], all: Member[], defaultId: string | null) {
  const users = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users);
  const own = rows.length
    ? await db()
        .select({ dashboardId: schema.dashboardUserLayouts.dashboardId, layout: schema.dashboardUserLayouts.layout })
        .from(schema.dashboardUserLayouts)
        .where(and(eq(schema.dashboardUserLayouts.userId, a.user.id), inArray(schema.dashboardUserLayouts.dashboardId, rows.map((d) => d.id))))
    : [];
  const nameOf = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  // The chosen default if still visible, otherwise the built-in "Akab" dashboard
  const fallback = rows.find((d) => d.slug === "akab")?.id ?? rows[0]?.id ?? null;
  const effectiveDefault = rows.some((d) => d.id === defaultId) ? defaultId : fallback;
  return rows.map((d) => {
    const ms = all.filter((m) => m.dashboardId === d.id);
    const admin = canAdminister(a, d, ms);
    const customize = canCustomize(a, d, ms);
    // A personal layout counts only while personalizing is still allowed
    const personal = customize ? own.find((o) => o.dashboardId === d.id)?.layout : undefined;
    return {
      id: d.id,
      slug: d.slug,
      name: d.name,
      visibility: d.visibility,
      teamAccess: d.teamAccess,
      layout: personal ?? d.layout,
      defaultLayout: d.layout,
      personalLayout: Boolean(personal),
      ownerName: nameOf(d.ownerId),
      mine: d.ownerId === a.user.id,
      isDefault: d.id === effectiveDefault,
      /** Change the default layout (for everyone) */
      canEdit: admin,
      /** Save one's own layout */
      canCustomize: customize,
      canAdminister: admin,
      canDelete: canDelete(a, d),
      visibilityOptions: allowedVisibility(a, d, ms),
      // Only those who administer the dashboard see who it is shared with
      members: admin ? ms.map((m) => ({ userId: m.userId, name: nameOf(m.userId), access: m.access })) : [],
      updatedAt: d.updatedAt,
    };
  });
}

async function viewOne(a: AuthContext, id: string) {
  const { d, ms } = await load(a, id);
  return (await view(a, [d], ms, await defaultIdOf(a.user.id)))[0];
}

export const dashboardsRoutes = new Hono<AppEnv>()
  .use(requirePermission("dashboard.view"))
  .get("/", async (c) => {
    const a = auth(c);
    const rows = await db().select().from(schema.dashboards).orderBy(asc(schema.dashboards.createdAt));
    const ms = await membersOf(rows.map((d) => d.id));
    const visible = rows
      .filter((d) => canSee(a, d, ms.filter((m) => m.dashboardId === d.id)))
      .sort((x, y) => order(x) - order(y));
    return c.json(await view(a, visible, ms, await defaultIdOf(a.user.id)));
  })

  /** Staff that a dashboard can be shared with (names only). */
  .get("/people", async (c) => {
    const rows = await db()
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
      .orderBy(asc(schema.users.name));
    return c.json(rows);
  })

  /** The dashboard opened first for the signed-in person (null = Akab). */
  .put("/default", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ id: zUuid.nullable() }));
    if (p.id) await load(a, p.id);
    await db()
      .insert(schema.userPreferences)
      .values({ userId: a.user.id, defaultDashboardId: p.id })
      .onConflictDoUpdate({ target: schema.userPreferences.userId, set: { defaultDashboardId: p.id, updatedAt: new Date() } });
    return c.json({ ok: true });
  })

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName, visibility: z.enum(["private", "team"]), teamAccess: zAccess.optional() }));
    const [d] = await db()
      .insert(schema.dashboards)
      .values({ name: p.name, visibility: p.visibility, teamAccess: p.teamAccess ?? "view", ownerId: a.user.id })
      .returning();
    await audit(a.user.id, "dashboard.created", d.id, { name: d.name, visibility: d.visibility });
    return c.json(await viewOne(a, d.id), 201);
  })

  .patch("/:id", async (c) => {
    const a = auth(c);
    const { d, ms } = await load(a, zUuid.parse(c.req.param("id")));
    const p = await body(
      c,
      z.object({
        name: zName.optional(),
        visibility: z.enum(["private", "team", "admins"]).optional(),
        teamAccess: zAccess.optional(),
        layout: z.array(widget).max(40).optional(),
      }),
    );
    // The default layout is for those who administer the dashboard; others save their own (PUT /:id/my-layout)
    if (p.layout !== undefined && !canAdminister(a, d, ms)) throw new HTTPException(403, { message: "Forbidden" });
    if ((p.name !== undefined || p.teamAccess !== undefined) && !canAdminister(a, d, ms)) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    if (p.name !== undefined && d.slug) throw new HTTPException(409, { message: "builtin_name" });
    if (p.visibility !== undefined && !allowedVisibility(a, d, ms).includes(p.visibility)) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    await db()
      .update(schema.dashboards)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.dashboards.id, d.id));
    if (p.layout !== undefined) {
      // Saving the default replaces the saver's own layout
      await db()
        .delete(schema.dashboardUserLayouts)
        .where(and(eq(schema.dashboardUserLayouts.dashboardId, d.id), eq(schema.dashboardUserLayouts.userId, a.user.id)));
      await audit(a.user.id, "dashboard.default_layout", d.id, { widgets: p.layout.length });
    }
    if (p.visibility !== undefined || p.name !== undefined || p.teamAccess !== undefined) {
      await audit(a.user.id, "dashboard.updated", d.id, { name: p.name, visibility: p.visibility, teamAccess: p.teamAccess });
    }
    return c.json(await viewOne(a, d.id));
  })

  /** Save my own layout of this dashboard (the default stays). */
  .put("/:id/my-layout", async (c) => {
    const a = auth(c);
    const { d, ms } = await load(a, zUuid.parse(c.req.param("id")));
    if (!canCustomize(a, d, ms)) throw new HTTPException(403, { message: "Forbidden" });
    const p = await body(c, z.object({ layout: z.array(widget).max(40) }));
    await db()
      .insert(schema.dashboardUserLayouts)
      .values({ dashboardId: d.id, userId: a.user.id, layout: p.layout })
      .onConflictDoUpdate({
        target: [schema.dashboardUserLayouts.dashboardId, schema.dashboardUserLayouts.userId],
        set: { layout: p.layout, updatedAt: new Date() },
      });
    return c.json(await viewOne(a, d.id));
  })

  /** Back to the default layout. */
  .delete("/:id/my-layout", async (c) => {
    const a = auth(c);
    const { d } = await load(a, zUuid.parse(c.req.param("id")));
    await db()
      .delete(schema.dashboardUserLayouts)
      .where(and(eq(schema.dashboardUserLayouts.dashboardId, d.id), eq(schema.dashboardUserLayouts.userId, a.user.id)));
    return c.json(await viewOne(a, d.id));
  })

  /** Replace the people this dashboard is given to directly. */
  .put("/:id/members", async (c) => {
    const a = auth(c);
    const { d, ms } = await load(a, zUuid.parse(c.req.param("id")));
    if (!canAdminister(a, d, ms)) throw new HTTPException(403, { message: "Forbidden" });
    const p = await body(c, z.object({ members: z.array(z.object({ userId: zUuid, access: zAccess })).max(200) }));
    const wanted = new Map(p.members.filter((m) => m.userId !== d.ownerId).map((m) => [m.userId, m.access]));
    if (wanted.size) {
      const staff = await db()
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(inArray(schema.users.id, [...wanted.keys()]), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
      if (staff.length !== wanted.size) throw new HTTPException(400, { message: "invalid_member" });
    }
    await db().transaction(async (tx) => {
      await tx.delete(schema.dashboardMembers).where(eq(schema.dashboardMembers.dashboardId, d.id));
      if (wanted.size) {
        await tx.insert(schema.dashboardMembers).values([...wanted].map(([userId, access]) => ({ dashboardId: d.id, userId, access })));
      }
    });
    await audit(a.user.id, "dashboard.members", d.id, { members: [...wanted].map(([userId, access]) => ({ userId, access })) });
    return c.json(await viewOne(a, d.id));
  })

  .delete("/:id", async (c) => {
    const a = auth(c);
    const { d } = await load(a, zUuid.parse(c.req.param("id")));
    if (!canDelete(a, d)) throw new HTTPException(403, { message: "Forbidden" });
    await db().delete(schema.dashboards).where(eq(schema.dashboards.id, d.id));
    await audit(a.user.id, "dashboard.deleted", d.id, { name: d.name });
    return c.json({ ok: true });
  });
