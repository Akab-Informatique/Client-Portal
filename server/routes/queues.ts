import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { forgetQueues, queues } from "../lib/queues.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { lookup, run } from "./tickets.ts";

/**
 * Admin › Files d'attente (admin.queues): the portal's own ticket queues —
 * Support, Alertes and Projets to start.
 */
const zName = z.string().trim().min(1).max(40);
const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "file";

export const queueRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.queues"))

  /** The queues in order, each with its open tickets. */
  .get("/", async (c) => {
    const src = await ticketSource();
    const [list, tickets, o] = await run(() => Promise.all([queues(), src.list(), src.options()]));
    const L = lookup(o);
    const open = new Map<string, number>();
    for (const t of tickets) if (L.statusKind(t.status) !== "complete") open.set(t.queue, (open.get(t.queue) ?? 0) + 1);
    return c.json(list.map((q) => ({ key: q.key, name: q.name, alerts: q.alerts, isDefault: q.isDefault, position: q.position, openTickets: open.get(q.key) ?? 0 })));
  })

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName, alerts: z.boolean().optional() }));
    const list = await queues();
    if (list.some((q) => q.name.toLowerCase() === p.name.toLowerCase())) throw new HTTPException(409, { message: "queue_exists" });
    let key = slug(p.name);
    for (let i = 2; list.some((q) => q.key === key); i++) key = `${slug(p.name)}-${i}`;
    await db().insert(schema.ticketQueues).values({ key, name: p.name, alerts: p.alerts ?? false, position: list.length });
    forgetQueues();
    await audit(a.user.id, "queue.created", key, { name: p.name });
    return c.json({ key }, 201);
  })

  /** Rename, mark as alerts, make the default (the default is never an alerts queue). */
  .patch("/:key", async (c) => {
    const a = auth(c);
    const cur = await queueOf(c.req.param("key"));
    const p = await body(c, z.object({ name: zName.optional(), alerts: z.boolean().optional(), isDefault: z.literal(true).optional() }));
    const list = await queues();
    if (p.name && list.some((q) => q.key !== cur.key && q.name.toLowerCase() === p.name!.toLowerCase())) throw new HTTPException(409, { message: "queue_exists" });
    const alerts = p.alerts ?? cur.alerts;
    if (alerts && (p.isDefault || cur.isDefault)) throw new HTTPException(409, { message: "queue_default_alerts" });
    await db().transaction(async (tx) => {
      if (p.isDefault) await tx.update(schema.ticketQueues).set({ isDefault: false }).where(ne(schema.ticketQueues.key, cur.key));
      await tx
        .update(schema.ticketQueues)
        .set({ ...(p.name ? { name: p.name } : {}), alerts, ...(p.isDefault ? { isDefault: true } : {}), updatedAt: new Date() })
        .where(eq(schema.ticketQueues.key, cur.key));
    });
    forgetQueues();
    await audit(a.user.id, "queue.updated", cur.key, { ...(p.name ? { name: p.name } : {}), alerts, ...(p.isDefault ? { isDefault: true } : {}) });
    return c.json({ ok: true });
  })

  /** One place up or down. */
  .post("/:key/move", async (c) => {
    const a = auth(c);
    const cur = await queueOf(c.req.param("key"));
    const p = await body(c, z.object({ direction: z.enum(["up", "down"]) }));
    const keys = (await queues()).map((q) => q.key);
    const i = keys.indexOf(cur.key);
    const j = p.direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= keys.length) return c.json({ ok: true });
    [keys[i], keys[j]] = [keys[j], keys[i]];
    await db().transaction(async (tx) => {
      for (const [n, key] of keys.entries()) await tx.update(schema.ticketQueues).set({ position: n }).where(eq(schema.ticketQueues.key, key));
    });
    forgetQueues();
    await audit(a.user.id, "queue.moved", cur.key, { direction: p.direction });
    return c.json({ ok: true });
  })

  /** Its tickets move to the default queue; the default queue and the last one cannot go. */
  .delete("/:key", async (c) => {
    const a = auth(c);
    const cur = await queueOf(c.req.param("key"));
    const list = await queues();
    if (cur.isDefault) throw new HTTPException(409, { message: "queue_is_default" });
    if (list.length <= 1) throw new HTTPException(409, { message: "queue_last" });
    const fallback = list.find((q) => q.isDefault)!.key;
    await db().transaction(async (tx) => {
      await tx.update(schema.ticketMeta).set({ queue: fallback }).where(eq(schema.ticketMeta.queue, cur.key));
      await tx.delete(schema.ticketQueues).where(eq(schema.ticketQueues.key, cur.key));
    });
    forgetQueues();
    await audit(a.user.id, "queue.deleted", cur.key, { name: cur.name, movedTo: fallback });
    return c.json({ ok: true });
  });

async function queueOf(key: string) {
  const [q] = await db().select().from(schema.ticketQueues).where(and(eq(schema.ticketQueues.key, key)));
  if (!q) throw new HTTPException(404, { message: "not_found" });
  return q;
}
