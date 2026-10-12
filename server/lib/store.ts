import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * Store inventory kept in the portal: products for sale, stock per location
 * and a movement for every change. Money is in cents.
 */
export type StockLine = { locationId: string; location: string; quantity: number };

export type StoreProductView = typeof schema.storeProducts.$inferSelect & { stock: StockLine[]; total: number; low: boolean };

/** Every product with its stock per (active) location. */
export async function productsWithStock(): Promise<StoreProductView[]> {
  const [products, stock] = await Promise.all([
    db().select().from(schema.storeProducts).orderBy(asc(schema.storeProducts.name)),
    db()
      .select({ productId: schema.storeStock.productId, locationId: schema.storeStock.locationId, location: schema.storeLocations.name, quantity: schema.storeStock.quantity })
      .from(schema.storeStock)
      .innerJoin(schema.storeLocations, eq(schema.storeLocations.id, schema.storeStock.locationId))
      .where(eq(schema.storeLocations.active, true))
      .orderBy(asc(schema.storeLocations.name)),
  ]);
  return products.map((p) => {
    const lines = stock.filter((s) => s.productId === p.id).map(({ locationId, location, quantity }) => ({ locationId, location, quantity }));
    const total = lines.reduce((n, s) => n + s.quantity, 0);
    return { ...p, stock: lines, total, low: p.active && total <= p.minQuantity };
  });
}

/** Add (or remove) stock and write the movement, in one transaction. Returns the new quantity. */
export async function moveStock(p: {
  productId: string;
  locationId: string;
  delta: number;
  kind: "receive" | "adjust" | "ticket";
  note?: string;
  userId: string | null;
  ticket?: { id: number; number: string | null };
  /** Refuse when the stock would go below zero (taking items) */
  mustHave?: boolean;
}): Promise<{ quantity: number; movementId: string } | null> {
  return db().transaction(async (tx) => {
    await tx.insert(schema.storeStock).values({ productId: p.productId, locationId: p.locationId, quantity: 0 }).onConflictDoNothing();
    const where = and(eq(schema.storeStock.productId, p.productId), eq(schema.storeStock.locationId, p.locationId));
    const [row] = await tx
      .update(schema.storeStock)
      .set({ quantity: sql`${schema.storeStock.quantity} + ${p.delta}`, updatedAt: new Date() })
      .where(p.mustHave ? and(where, gte(schema.storeStock.quantity, -p.delta)) : where)
      .returning({ quantity: schema.storeStock.quantity });
    if (!row) return null;
    const [m] = await tx
      .insert(schema.storeMovements)
      .values({
        productId: p.productId,
        locationId: p.locationId,
        delta: p.delta,
        kind: p.kind,
        note: p.note ?? "",
        userId: p.userId,
        ticketId: p.ticket?.id ?? null,
        ticketNumber: p.ticket?.number ?? null,
      })
      .returning({ id: schema.storeMovements.id });
    return { quantity: row.quantity, movementId: m.id };
  });
}

/** Undo a movement (e.g. the Autotask charge failed): stock back, movement removed. */
export async function undoMovement(movementId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [m] = await tx.delete(schema.storeMovements).where(eq(schema.storeMovements.id, movementId)).returning();
    if (!m) return;
    await tx
      .update(schema.storeStock)
      .set({ quantity: sql`${schema.storeStock.quantity} - ${m.delta}` })
      .where(and(eq(schema.storeStock.productId, m.productId), eq(schema.storeStock.locationId, m.locationId)));
  });
}

/** Active products matching the words, with their stock per location (for a ticket charge). */
export async function searchProducts(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = await productsWithStock();
  return all
    .filter((p) => p.active && words.every((w) => `${p.name} ${p.sku ?? ""} ${p.manufacturer ?? ""} ${p.category ?? ""}`.toLowerCase().includes(w)))
    .sort((x, y) => Number(y.total > 0) - Number(x.total > 0) || x.name.localeCompare(y.name))
    .slice(0, 25)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      sku: p.sku,
      manufacturer: p.manufacturer,
      unitPrice: p.priceCents / 100,
      unitCost: p.costCents / 100,
      materialCodeId: p.materialCodeId,
      linked: Boolean(p.autotaskProductId),
      stock: p.stock.filter((s) => s.quantity > 0),
      total: p.total,
    }));
}
