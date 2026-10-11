import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zName, zUuid } from "../lib/validate.ts";

type Dashboard = typeof schema.dashboards.$inferSelect;

/**
 * Visibility: private → owner only · team → every technician with
 * dashboard.view · admins → administrators only (built-in default).
 */
function canSee(a: AuthContext, d: Dashboard): boolean {
  if (d.visibility === "private") return d.ownerId === a.user.id;
  if (d.visibility === "admins") return a.isAdmin;
  return true;
}
const canManage = (a: AuthContext) => a.permissions.includes("dashboard.manage");
function canEdit(a: AuthContext, d: Dashboard): boolean {
  if (d.ownerId === a.user.id) return true;
  return d.visibility !== "private" && canManage(a) && canSee(a, d);
}
/** Built-in: admins ↔ team, by managers. Own dashboards: private ↔ team, by the owner. */
function allowedVisibility(a: AuthContext, d: Dashboard): Dashboard["visibility"][] {
  if (d.slug) return canManage(a) ? ["admins", "team"] : [];
  if (d.ownerId === a.user.id) return ["private", "team"];
  return [];
}
function canDelete(a: AuthContext, d: Dashboard): boolean {
  if (d.slug) return false;
  return d.ownerId === a.user.id || (d.visibility === "team" && canManage(a));
}

const widget = z.object({ id: z.string().min(1).max(60), type: z.string().min(1).max(60), size: z.enum(["sm", "md", "lg"]) });

async function load(id: string): Promise<Dashboard> {
  const [d] = await db().select().from(schema.dashboards).where(eq(schema.dashboards.id, id));
  if (!d) throw new HTTPException(404, { message: "not_found" });
  return d;
}

async function view(a: AuthContext, rows: Dashboard[]) {
  const owners = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users);
  return rows.map((d) => ({
    id: d.id,
    slug: d.slug,
    name: d.name,
    visibility: d.visibility,
    layout: d.layout,
    ownerName: owners.find((o) => o.id === d.ownerId)?.name ?? null,
    mine: d.ownerId === a.user.id,
    canEdit: canEdit(a, d),
    canDelete: canDelete(a, d),
    visibilityOptions: allowedVisibility(a, d),
    updatedAt: d.updatedAt,
  }));
}

export const dashboardsRoutes = new Hono<AppEnv>()
  .use(requirePermission("dashboard.view"))
  .get("/", async (c) => {
    const a = auth(c);
    const rows = await db().select().from(schema.dashboards).orderBy(asc(schema.dashboards.createdAt));
    return c.json(await view(a, rows.filter((d) => canSee(a, d))));
  })

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName, visibility: z.enum(["private", "team"]) }));
    const [d] = await db().insert(schema.dashboards).values({ name: p.name, visibility: p.visibility, ownerId: a.user.id }).returning();
    await audit(a.user.id, "dashboard.created", d.id, { name: d.name, visibility: d.visibility });
    return c.json((await view(a, [d]))[0], 201);
  })

  .patch("/:id", async (c) => {
    const a = auth(c);
    const d = await load(zUuid.parse(c.req.param("id")));
    if (!canSee(a, d)) throw new HTTPException(404, { message: "not_found" });
    const p = await body(
      c,
      z.object({
        name: zName.optional(),
        visibility: z.enum(["private", "team", "admins"]).optional(),
        layout: z.array(widget).max(40).optional(),
      }),
    );
    if ((p.name !== undefined || p.layout !== undefined) && !canEdit(a, d)) throw new HTTPException(403, { message: "Forbidden" });
    if (p.name !== undefined && d.slug) throw new HTTPException(409, { message: "builtin_name" });
    if (p.visibility !== undefined && !allowedVisibility(a, d).includes(p.visibility)) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    const [row] = await db()
      .update(schema.dashboards)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.dashboards.id, d.id))
      .returning();
    if (p.visibility !== undefined || p.name !== undefined) {
      await audit(a.user.id, "dashboard.updated", d.id, { name: p.name, visibility: p.visibility });
    }
    return c.json((await view(a, [row]))[0]);
  })

  .delete("/:id", async (c) => {
    const a = auth(c);
    const d = await load(zUuid.parse(c.req.param("id")));
    if (!canSee(a, d)) throw new HTTPException(404, { message: "not_found" });
    if (!canDelete(a, d)) throw new HTTPException(403, { message: "Forbidden" });
    await db().delete(schema.dashboards).where(eq(schema.dashboards.id, d.id));
    await audit(a.user.id, "dashboard.deleted", d.id, { name: d.name });
    return c.json({ ok: true });
  });
