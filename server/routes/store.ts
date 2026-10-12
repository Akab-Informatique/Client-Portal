import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { moveStock, productsWithStock } from "../lib/store.ts";

const zCents = z.number().int().min(0).max(100_000_000);
const zProduct = z.object({
  sku: z.string().trim().max(60).nullable().default(null),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(""),
  manufacturer: z.string().trim().max(120).nullable().default(null),
  category: z.string().trim().max(120).nullable().default(null),
  priceCents: zCents,
  costCents: zCents.default(0),
  minQuantity: z.number().int().min(0).max(1_000_000).default(0),
  autotaskProductId: z.number().int().positive().nullable().default(null),
  autotaskProductName: z.string().trim().max(200).nullable().default(null),
  materialCodeId: z.string().max(20).nullable().default(null),
  active: z.boolean().default(true),
});

const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);

async function skuTaken(sku: string | null, exceptId?: string) {
  if (!sku) return false;
  const [row] = await db()
    .select({ id: schema.storeProducts.id })
    .from(schema.storeProducts)
    .where(exceptId ? and(eq(schema.storeProducts.sku, sku), ne(schema.storeProducts.id, exceptId)) : eq(schema.storeProducts.sku, sku));
  return Boolean(row);
}

/** Store inventory (store.view to see, store.manage to change). */
export const storeRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("store.view"))

  .get("/", async (c) => {
    const [products, locations] = await Promise.all([productsWithStock(), db().select().from(schema.storeLocations).orderBy(asc(schema.storeLocations.name))]);
    const active = products.filter((p) => p.active);
    return c.json({
      products,
      locations,
      stats: {
        active: active.length,
        low: active.filter((p) => p.low && p.total > 0).length,
        out: active.filter((p) => p.total <= 0).length,
        valueCents: active.reduce((s, p) => s + p.total * p.costCents, 0),
        units: active.reduce((s, p) => s + p.total, 0),
      },
    });
  })

  .post("/products", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zProduct);
    const sku = blank(p.sku);
    if (await skuTaken(sku)) throw new HTTPException(409, { message: "sku_taken" });
    const [row] = await db()
      .insert(schema.storeProducts)
      .values({ ...p, sku, manufacturer: blank(p.manufacturer), category: blank(p.category) })
      .returning();
    await audit(a.user.id, "store.product_created", row.id, { name: row.name, sku });
    return c.json(row, 201);
  })

  .patch("/products/:id", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, zProduct.partial());
    const sku = p.sku !== undefined ? blank(p.sku) : undefined;
    if (sku !== undefined && (await skuTaken(sku, id))) throw new HTTPException(409, { message: "sku_taken" });
    const [row] = await db()
      .update(schema.storeProducts)
      .set({
        ...p,
        ...(sku !== undefined ? { sku } : {}),
        ...(p.manufacturer !== undefined ? { manufacturer: blank(p.manufacturer) } : {}),
        ...(p.category !== undefined ? { category: blank(p.category) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.storeProducts.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "store.product_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  /** Receive (adds) or count (sets the quantity) at a location. */
  .post("/products/:id/stock", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({ locationId: zUuid, kind: z.enum(["receive", "adjust"]), quantity: z.number().int().min(0).max(1_000_000), note: z.string().trim().max(500).default("") }),
    );
    const [product] = await db().select({ id: schema.storeProducts.id }).from(schema.storeProducts).where(eq(schema.storeProducts.id, id));
    const [location] = await db().select({ id: schema.storeLocations.id }).from(schema.storeLocations).where(eq(schema.storeLocations.id, p.locationId));
    if (!product || !location) throw new HTTPException(404, { message: "not_found" });
    let delta = p.quantity;
    if (p.kind === "adjust") {
      const [cur] = await db()
        .select({ q: schema.storeStock.quantity })
        .from(schema.storeStock)
        .where(and(eq(schema.storeStock.productId, id), eq(schema.storeStock.locationId, p.locationId)));
      delta = p.quantity - (cur?.q ?? 0);
    } else if (p.quantity === 0) {
      throw new HTTPException(400, { message: "Validation failed" });
    }
    const r = await moveStock({ productId: id, locationId: p.locationId, delta, kind: p.kind, note: p.note, userId: a.user.id });
    await audit(a.user.id, `store.stock_${p.kind}`, id, { locationId: p.locationId, delta });
    return c.json({ quantity: r?.quantity ?? 0 });
  })

  .get("/products/:id/movements", async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const rows = await db()
      .select({
        id: schema.storeMovements.id,
        delta: schema.storeMovements.delta,
        kind: schema.storeMovements.kind,
        note: schema.storeMovements.note,
        ticketId: schema.storeMovements.ticketId,
        ticketNumber: schema.storeMovements.ticketNumber,
        createdAt: schema.storeMovements.createdAt,
        location: schema.storeLocations.name,
        user: schema.users.name,
      })
      .from(schema.storeMovements)
      .innerJoin(schema.storeLocations, eq(schema.storeLocations.id, schema.storeMovements.locationId))
      .leftJoin(schema.users, eq(schema.users.id, schema.storeMovements.userId))
      .where(eq(schema.storeMovements.productId, id))
      .orderBy(desc(schema.storeMovements.createdAt))
      .limit(200);
    return c.json(rows);
  })

  .post("/locations", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const [dup] = await db().select({ id: schema.storeLocations.id }).from(schema.storeLocations).where(eq(schema.storeLocations.name, p.name));
    if (dup) throw new HTTPException(409, { message: "location_taken" });
    const [row] = await db().insert(schema.storeLocations).values({ name: p.name }).returning();
    await audit(a.user.id, "store.location_created", row.id, { name: p.name });
    return c.json(row, 201);
  })
  .patch("/locations/:id", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() }));
    if (p.name) {
      const [dup] = await db()
        .select({ id: schema.storeLocations.id })
        .from(schema.storeLocations)
        .where(and(eq(schema.storeLocations.name, p.name), ne(schema.storeLocations.id, id)));
      if (dup) throw new HTTPException(409, { message: "location_taken" });
    }
    const [row] = await db().update(schema.storeLocations).set(p).where(eq(schema.storeLocations.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "store.location_updated", id, p);
    return c.json(row);
  });
