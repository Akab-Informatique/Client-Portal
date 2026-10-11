import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requireAuth, type AppEnv } from "../lib/auth.ts";
import { zUuid } from "../lib/validate.ts";

/** The signed-in person's own notifications (none while viewing as a client). */
export const notificationRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const a = auth(c);
    if (a.viewAs) return c.json({ items: [], unread: 0 });
    const userId = a.realUser.id;
    const items = await db()
      .select({
        id: schema.notifications.id,
        type: schema.notifications.type,
        data: schema.notifications.data,
        link: schema.notifications.link,
        readAt: schema.notifications.readAt,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(30);
    const [{ n }] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    return c.json({ items, unread: n });
  })
  .post("/read-all", async (c) => {
    const a = auth(c);
    await db()
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, a.realUser.id), isNull(schema.notifications.readAt)));
    return c.json({ ok: true });
  })
  .post("/:id/read", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const rows = await db()
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, a.realUser.id)))
      .returning({ id: schema.notifications.id });
    if (!rows.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  });
