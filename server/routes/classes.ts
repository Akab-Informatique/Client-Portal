import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";

/**
 * Admin › Classifications (admin.classes): how a client is classed — break &
 * fix, MSP, bronze, silver, gold to start, then whatever the admins add.
 * A client carries one (clients.class_key, set on its CRM page).
 */
export const CLASS_COLORS = ["slate", "blue", "orange", "zinc", "yellow", "green", "red", "violet"] as const;
const zName = z.string().trim().min(1).max(40);
const zColor = z.enum(CLASS_COLORS);
const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "classe";

/** The classifications in order (any staff member: the CRM page and the ticket view show them). */
export async function clientClasses() {
  return db().select().from(schema.clientClasses).orderBy(asc(schema.clientClasses.position), asc(schema.clientClasses.name));
}

export const classRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  .get("/", async (c) => {
    const [list, counts] = await Promise.all([
      clientClasses(),
      db().select({ key: schema.clients.classKey, n: sql<number>`count(*)::int` }).from(schema.clients).groupBy(schema.clients.classKey),
    ]);
    const n = new Map(counts.map((r) => [r.key, r.n]));
    return c.json(list.map((k) => ({ key: k.key, name: k.name, color: k.color, position: k.position, clients: n.get(k.key) ?? 0 })));
  })

  .post("/", requirePermission("admin.classes"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName, color: zColor.optional() }));
    const list = await clientClasses();
    if (list.some((k) => k.name.toLowerCase() === p.name.toLowerCase())) throw new HTTPException(409, { message: "class_exists" });
    let key = slug(p.name);
    for (let i = 2; list.some((k) => k.key === key); i++) key = `${slug(p.name)}-${i}`;
    await db().insert(schema.clientClasses).values({ key, name: p.name, color: p.color ?? "slate", position: list.length });
    await audit(a.user.id, "client_class.created", key, { name: p.name });
    return c.json({ key }, 201);
  })

  .patch("/:key", requirePermission("admin.classes"), async (c) => {
    const a = auth(c);
    const cur = await classOf(c.req.param("key"));
    const p = await body(c, z.object({ name: zName.optional(), color: zColor.optional() }));
    if (p.name && (await clientClasses()).some((k) => k.key !== cur.key && k.name.toLowerCase() === p.name!.toLowerCase())) throw new HTTPException(409, { message: "class_exists" });
    await db()
      .update(schema.clientClasses)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.clientClasses.key, cur.key));
    await audit(a.user.id, "client_class.updated", cur.key, p);
    return c.json({ ok: true });
  })

  .post("/:key/move", requirePermission("admin.classes"), async (c) => {
    const a = auth(c);
    const cur = await classOf(c.req.param("key"));
    const p = await body(c, z.object({ direction: z.enum(["up", "down"]) }));
    const keys = (await clientClasses()).map((k) => k.key);
    const i = keys.indexOf(cur.key);
    const j = p.direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= keys.length) return c.json({ ok: true });
    [keys[i], keys[j]] = [keys[j], keys[i]];
    await db().transaction(async (tx) => {
      for (const [n, key] of keys.entries()) await tx.update(schema.clientClasses).set({ position: n }).where(eq(schema.clientClasses.key, key));
    });
    await audit(a.user.id, "client_class.moved", cur.key, { direction: p.direction });
    return c.json({ ok: true });
  })

  /** Its clients are left without a classification. */
  .delete("/:key", requirePermission("admin.classes"), async (c) => {
    const a = auth(c);
    const cur = await classOf(c.req.param("key"));
    await db().transaction(async (tx) => {
      await tx.update(schema.clients).set({ classKey: null }).where(eq(schema.clients.classKey, cur.key));
      await tx.delete(schema.clientClasses).where(eq(schema.clientClasses.key, cur.key));
    });
    await audit(a.user.id, "client_class.deleted", cur.key, { name: cur.name });
    return c.json({ ok: true });
  });

async function classOf(key: string) {
  const [k] = await db().select().from(schema.clientClasses).where(eq(schema.clientClasses.key, key));
  if (!k) throw new HTTPException(404, { message: "not_found" });
  return k;
}
