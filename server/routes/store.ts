import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { adjustCount, productsWithStock, receiptsOf, receive, removeSerials, serialsOf, StoreError, suppliers } from "../lib/store.ts";

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
  materialCodeId: z.string().max(20).nullable().default(null),
  serialized: z.boolean().default(false),
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

async function location(id: string) {
  const [l] = await db().select({ id: schema.storeLocations.id }).from(schema.storeLocations).where(eq(schema.storeLocations.id, id));
  if (!l) throw new HTTPException(404, { message: "not_found" });
}

/** Store errors → HTTP (the serial numbers in conflict are listed). */
export function storeHttp(e: unknown): unknown {
  if (!(e instanceof StoreError)) return e;
  const status = e.code === "not_found" ? 404 : e.code === "serials_required" ? 400 : 409;
  return new HTTPException(status, { message: e.code, cause: e.detail?.length ? e.detail.map((s) => ({ path: "serial", message: s })) : undefined });
}
async function store<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw storeHttp(e);
  }
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
    const sent = (await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = await body(c, zProduct.partial());
    // only the fields actually sent
    const p = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in sent)) as typeof parsed;
    const sku = p.sku !== undefined ? blank(p.sku) : undefined;
    if (sku !== undefined && (await skuTaken(sku, id))) throw new HTTPException(409, { message: "sku_taken" });
    if (p.serialized !== undefined) {
      const cur = (await productsWithStock()).find((x) => x.id === id);
      if (cur && cur.serialized !== p.serialized && cur.total > 0) throw new HTTPException(409, { message: "has_stock" });
    }
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

  /** Receive a purchase: supplier, invoice, cost, and the serial numbers of serialized products. */
  .post("/products/:id/receive", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        locationId: zUuid,
        quantity: z.number().int().min(1).max(1_000_000).default(1),
        serials: z.array(z.string().max(100)).max(1000).default([]),
        unitCostCents: zCents,
        supplier: z.string().trim().max(120).nullable().default(null),
        reference: z.string().trim().max(120).nullable().default(null),
        purchasedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .default(null),
        note: z.string().trim().max(500).default(""),
        updateCost: z.boolean().default(true),
      }),
    );
    await location(p.locationId);
    const r = await store(() => receive({ ...p, productId: id, supplier: p.supplier || null, reference: p.reference || null, userId: a.user.id }));
    await audit(a.user.id, "store.stock_receive", id, { locationId: p.locationId, quantity: p.serials.length || p.quantity, supplier: p.supplier, reference: p.reference });
    return c.json(r, 201);
  })

  /** Count (sets the quantity) — or, for serialized products, take serial numbers out. */
  .post("/products/:id/adjust", requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        locationId: zUuid,
        quantity: z.number().int().min(0).max(1_000_000).optional(),
        removeSerialIds: z.array(zUuid).max(1000).optional(),
        note: z.string().trim().max(500).default(""),
      }),
    );
    await location(p.locationId);
    const r = p.removeSerialIds?.length
      ? await store(() => removeSerials({ productId: id, locationId: p.locationId, serialIds: p.removeSerialIds!, note: p.note, userId: a.user.id }))
      : p.quantity !== undefined
        ? await store(() => adjustCount({ productId: id, locationId: p.locationId, quantity: p.quantity!, note: p.note, userId: a.user.id }))
        : null;
    if (!r) throw new HTTPException(400, { message: "Validation failed" });
    await audit(a.user.id, "store.stock_adjust", id, { locationId: p.locationId, quantity: p.quantity, removed: p.removeSerialIds?.length });
    return c.json(r);
  })

  .get("/products/:id/serials", async (c) => c.json(await serialsOf(zUuid.parse(c.req.param("id")))))
  /**
   * What the product label needs: the product and where it went — the units (serial numbers) or the stock
   * taken for a ticket, with the ticket's number and client. Newest first.
   */
  .get("/products/:id/label", async (c) => {
    const id = zUuid.parse(c.req.param("id"));
    const [p] = await db().select().from(schema.storeProducts).where(eq(schema.storeProducts.id, id));
    if (!p) throw new HTTPException(404, { message: "not_found" });
    const [serials, moves] = await Promise.all([
      db()
        .select({ serial: schema.storeSerials.serial, ticketId: schema.storeSerials.ticketId, ticketNumber: schema.storeSerials.ticketNumber, at: schema.storeSerials.updatedAt })
        .from(schema.storeSerials)
        .where(and(eq(schema.storeSerials.productId, id), eq(schema.storeSerials.status, "used"))),
      db()
        .select({ ticketId: schema.storeMovements.ticketId, ticketNumber: schema.storeMovements.ticketNumber, serials: schema.storeMovements.serials, at: schema.storeMovements.createdAt })
        .from(schema.storeMovements)
        .where(and(eq(schema.storeMovements.productId, id), eq(schema.storeMovements.kind, "ticket"))),
    ]);
    const rows: { ticketId: number; ticketNumber: string | null; serial: string | null; at: Date }[] = [];
    for (const r of serials) if (r.ticketId) rows.push({ ticketId: r.ticketId, ticketNumber: r.ticketNumber, serial: r.serial, at: r.at });
    // stock taken without serial numbers: one line per ticket
    const seen = new Set(rows.map((r) => r.ticketId));
    for (const m of moves) if (m.ticketId && !m.serials.length && !seen.has(m.ticketId)) {
      seen.add(m.ticketId);
      rows.push({ ticketId: m.ticketId, ticketNumber: m.ticketNumber, serial: null, at: m.at });
    }
    // the client of each ticket: the portal's own tickets, else the ticket source
    const ids = [...seen];
    const own = ids.length ? await db().select({ id: schema.tickets.id, company: schema.tickets.companyName, number: schema.tickets.number }).from(schema.tickets).where(inArray(schema.tickets.id, ids)) : [];
    const info = new Map(own.map((t) => [t.id, { client: t.company, number: t.number }]));
    const missing = ids.filter((x) => !info.has(x));
    if (missing.length) {
      const src = await ticketSource();
      for (const tid of missing.slice(0, 20)) {
        const t = await src.get(tid).catch(() => null);
        if (t) info.set(tid, { client: t.company.name, number: t.number });
      }
    }
    return c.json({
      product: { id: p.id, name: p.name, sku: p.sku, priceCents: p.priceCents, serialized: p.serialized },
      assignments: rows
        .sort((x, y) => y.at.getTime() - x.at.getTime())
        .map((r) => ({ ticketId: r.ticketId, ticketNumber: info.get(r.ticketId)?.number ?? r.ticketNumber, client: info.get(r.ticketId)?.client ?? null, serial: r.serial, at: r.at })),
    });
  })
  .get("/products/:id/receipts", async (c) => c.json(await receiptsOf(zUuid.parse(c.req.param("id")))))
  .get("/suppliers", async (c) => c.json(await suppliers()))

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
        serials: schema.storeMovements.serials,
        supplier: schema.storeReceipts.supplier,
        reference: schema.storeReceipts.reference,
        unitCostCents: schema.storeReceipts.unitCostCents,
        createdAt: schema.storeMovements.createdAt,
        location: schema.storeLocations.name,
        user: schema.users.name,
      })
      .from(schema.storeMovements)
      .innerJoin(schema.storeLocations, eq(schema.storeLocations.id, schema.storeMovements.locationId))
      .leftJoin(schema.users, eq(schema.users.id, schema.storeMovements.userId))
      .leftJoin(schema.storeReceipts, eq(schema.storeReceipts.id, schema.storeMovements.receiptId))
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
