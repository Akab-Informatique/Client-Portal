import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * Store inventory kept in the portal: products for sale, stock per location
 * and a movement for every change. Money is in cents.
 *
 * Every reception is a purchase record (supplier, invoice, cost). Serialized
 * products are counted by serial number: each unit is a store_serials row
 * (in stock at a location, used on a ticket, or removed), and the stock
 * quantity always equals the units in stock.
 */
export type StockLine = { locationId: string; location: string; quantity: number };

export type StoreProductView = typeof schema.storeProducts.$inferSelect & { stock: StockLine[]; total: number; low: boolean };

export class StoreError extends Error {
  constructor(
    public code: "not_found" | "insufficient_stock" | "serial_exists" | "serial_unavailable" | "serials_required" | "has_stock",
    public detail?: string[],
  ) {
    super(code);
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

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

async function product(id: string) {
  const [p] = await db().select().from(schema.storeProducts).where(eq(schema.storeProducts.id, id));
  if (!p) throw new StoreError("not_found");
  return p;
}

/** Change the stock at a location and write the movement (inside a transaction). */
async function move(
  tx: Tx,
  p: {
    productId: string;
    locationId: string;
    delta: number;
    kind: "receive" | "adjust" | "ticket";
    note?: string;
    userId: string | null;
    ticket?: { id: number; number: string | null };
    receiptId?: string;
    serials?: string[];
    mustHave?: boolean;
  },
) {
  await tx.insert(schema.storeStock).values({ productId: p.productId, locationId: p.locationId, quantity: 0 }).onConflictDoNothing();
  const where = and(eq(schema.storeStock.productId, p.productId), eq(schema.storeStock.locationId, p.locationId));
  const [row] = await tx
    .update(schema.storeStock)
    .set({ quantity: sql`${schema.storeStock.quantity} + ${p.delta}`, updatedAt: new Date() })
    .where(p.mustHave ? and(where, gte(schema.storeStock.quantity, -p.delta)) : where)
    .returning({ quantity: schema.storeStock.quantity });
  if (!row) throw new StoreError("insufficient_stock");
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
      receiptId: p.receiptId ?? null,
      serials: p.serials ?? [],
    })
    .returning({ id: schema.storeMovements.id });
  return { quantity: row.quantity, movementId: m.id };
}

/** Clean list of serial numbers: trimmed, no blanks; duplicates reported. */
export function cleanSerials(list: string[]): { serials: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const s of list.map((x) => x.trim()).filter(Boolean)) {
    if (seen.has(s.toUpperCase())) duplicates.add(s);
    seen.add(s.toUpperCase());
  }
  const serials = [...new Map(list.map((x) => x.trim()).filter(Boolean).map((s) => [s.toUpperCase(), s])).values()];
  return { serials, duplicates: [...duplicates] };
}

/** Receive a purchase: the receipt (supplier, cost…), its serials, the stock and the movement. */
export async function receive(p: {
  productId: string;
  locationId: string;
  quantity: number;
  serials: string[];
  unitCostCents: number;
  supplier: string | null;
  reference: string | null;
  purchasedAt: string | null;
  note: string;
  updateCost: boolean;
  userId: string;
}) {
  const prod = await product(p.productId);
  const { serials, duplicates } = cleanSerials(p.serials);
  if (prod.serialized) {
    if (duplicates.length) throw new StoreError("serial_exists", duplicates);
    if (!serials.length) throw new StoreError("serials_required");
  }
  const quantity = prod.serialized ? serials.length : p.quantity;
  return db().transaction(async (tx) => {
    if (prod.serialized) {
      const taken = await tx
        .select({ serial: schema.storeSerials.serial })
        .from(schema.storeSerials)
        .where(and(eq(schema.storeSerials.productId, p.productId), inArray(sql`upper(${schema.storeSerials.serial})`, serials.map((s) => s.toUpperCase()))));
      if (taken.length) throw new StoreError("serial_exists", taken.map((x) => x.serial));
    }
    const [r] = await tx
      .insert(schema.storeReceipts)
      .values({
        productId: p.productId,
        locationId: p.locationId,
        quantity,
        unitCostCents: p.unitCostCents,
        supplier: p.supplier,
        reference: p.reference,
        purchasedAt: p.purchasedAt,
        note: p.note,
        userId: p.userId,
      })
      .returning({ id: schema.storeReceipts.id });
    if (prod.serialized) {
      await tx.insert(schema.storeSerials).values(serials.map((serial) => ({ productId: p.productId, serial, locationId: p.locationId, receiptId: r.id })));
    }
    if (p.updateCost) await tx.update(schema.storeProducts).set({ costCents: p.unitCostCents, updatedAt: new Date() }).where(eq(schema.storeProducts.id, p.productId));
    const m = await move(tx, {
      productId: p.productId,
      locationId: p.locationId,
      delta: quantity,
      kind: "receive",
      note: p.note,
      userId: p.userId,
      receiptId: r.id,
      serials: prod.serialized ? serials : [],
    });
    return { quantity: m.quantity, receiptId: r.id };
  });
}

/** Count (sets the quantity) — products without serial numbers. */
export async function adjustCount(p: { productId: string; locationId: string; quantity: number; note: string; userId: string }) {
  const prod = await product(p.productId);
  if (prod.serialized) throw new StoreError("serials_required");
  return db().transaction(async (tx) => {
    const [cur] = await tx
      .select({ q: schema.storeStock.quantity })
      .from(schema.storeStock)
      .where(and(eq(schema.storeStock.productId, p.productId), eq(schema.storeStock.locationId, p.locationId)));
    const m = await move(tx, { productId: p.productId, locationId: p.locationId, delta: p.quantity - (cur?.q ?? 0), kind: "adjust", note: p.note, userId: p.userId });
    return { quantity: m.quantity };
  });
}

/** Take serial numbers out of stock (lost, broken, returned to the supplier…). */
export async function removeSerials(p: { productId: string; locationId: string; serialIds: string[]; note: string; userId: string }) {
  return db().transaction(async (tx) => {
    const rows = await tx
      .update(schema.storeSerials)
      .set({ status: "removed", note: p.note, updatedAt: new Date() })
      .where(
        and(
          eq(schema.storeSerials.productId, p.productId),
          eq(schema.storeSerials.locationId, p.locationId),
          eq(schema.storeSerials.status, "in_stock"),
          inArray(schema.storeSerials.id, p.serialIds),
        ),
      )
      .returning({ serial: schema.storeSerials.serial });
    if (rows.length !== p.serialIds.length) throw new StoreError("serial_unavailable");
    const m = await move(tx, { productId: p.productId, locationId: p.locationId, delta: -rows.length, kind: "adjust", note: p.note, userId: p.userId, serials: rows.map((r) => r.serial), mustHave: true });
    return { quantity: m.quantity };
  });
}

/**
 * Take units for a ticket. Serialized: exactly the chosen serials (in stock
 * at that location), marked used with the ticket. Returns what to undo.
 */
export async function takeForTicket(p: {
  productId: string;
  locationId: string;
  quantity: number;
  serialIds: string[];
  ticket: { id: number; number: string | null };
  userId: string;
}): Promise<{ movementId: string; serials: string[] }> {
  const prod = await product(p.productId);
  if (prod.serialized && p.serialIds.length !== p.quantity) throw new StoreError("serials_required");
  return db().transaction(async (tx) => {
    let serials: string[] = [];
    if (prod.serialized) {
      const rows = await tx
        .update(schema.storeSerials)
        .set({ status: "used", ticketId: p.ticket.id, ticketNumber: p.ticket.number, updatedAt: new Date() })
        .where(
          and(
            eq(schema.storeSerials.productId, p.productId),
            eq(schema.storeSerials.locationId, p.locationId),
            eq(schema.storeSerials.status, "in_stock"),
            inArray(schema.storeSerials.id, p.serialIds),
          ),
        )
        .returning({ serial: schema.storeSerials.serial });
      if (rows.length !== p.serialIds.length) throw new StoreError("serial_unavailable");
      serials = rows.map((r) => r.serial);
    }
    const m = await move(tx, { productId: p.productId, locationId: p.locationId, delta: -p.quantity, kind: "ticket", userId: p.userId, ticket: p.ticket, serials, mustHave: true });
    return { movementId: m.movementId, serials };
  });
}

/** Undo a ticket take (the Autotask charge failed): stock and serials back. */
export async function undoTake(movementId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [m] = await tx.delete(schema.storeMovements).where(eq(schema.storeMovements.id, movementId)).returning();
    if (!m) return;
    await tx
      .update(schema.storeStock)
      .set({ quantity: sql`${schema.storeStock.quantity} - ${m.delta}` })
      .where(and(eq(schema.storeStock.productId, m.productId), eq(schema.storeStock.locationId, m.locationId)));
    if (m.serials.length) {
      await tx
        .update(schema.storeSerials)
        .set({ status: "in_stock", ticketId: null, ticketNumber: null, updatedAt: new Date() })
        .where(and(eq(schema.storeSerials.productId, m.productId), inArray(schema.storeSerials.serial, m.serials)));
    }
  });
}

/** Serial numbers of a product (all, or those in stock at a location). */
export async function serialsOf(productId: string, opts: { locationId?: string; inStock?: boolean } = {}) {
  const conds = [eq(schema.storeSerials.productId, productId)];
  if (opts.locationId) conds.push(eq(schema.storeSerials.locationId, opts.locationId));
  if (opts.inStock) conds.push(eq(schema.storeSerials.status, "in_stock"));
  return db()
    .select({
      id: schema.storeSerials.id,
      serial: schema.storeSerials.serial,
      status: schema.storeSerials.status,
      location: schema.storeLocations.name,
      locationId: schema.storeSerials.locationId,
      ticketNumber: schema.storeSerials.ticketNumber,
      note: schema.storeSerials.note,
      supplier: schema.storeReceipts.supplier,
      reference: schema.storeReceipts.reference,
      updatedAt: schema.storeSerials.updatedAt,
    })
    .from(schema.storeSerials)
    .innerJoin(schema.storeLocations, eq(schema.storeLocations.id, schema.storeSerials.locationId))
    .leftJoin(schema.storeReceipts, eq(schema.storeReceipts.id, schema.storeSerials.receiptId))
    .where(and(...conds))
    .orderBy(asc(schema.storeSerials.status), asc(schema.storeSerials.serial));
}

/** The purchases of a product, newest first. */
export async function receiptsOf(productId: string) {
  return db()
    .select({
      id: schema.storeReceipts.id,
      quantity: schema.storeReceipts.quantity,
      unitCostCents: schema.storeReceipts.unitCostCents,
      supplier: schema.storeReceipts.supplier,
      reference: schema.storeReceipts.reference,
      purchasedAt: schema.storeReceipts.purchasedAt,
      note: schema.storeReceipts.note,
      location: schema.storeLocations.name,
      user: schema.users.name,
      createdAt: schema.storeReceipts.createdAt,
    })
    .from(schema.storeReceipts)
    .innerJoin(schema.storeLocations, eq(schema.storeLocations.id, schema.storeReceipts.locationId))
    .leftJoin(schema.users, eq(schema.users.id, schema.storeReceipts.userId))
    .where(eq(schema.storeReceipts.productId, productId))
    .orderBy(desc(schema.storeReceipts.createdAt));
}

/** Suppliers already used (suggestions when receiving). */
export async function suppliers(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ s: schema.storeReceipts.supplier })
    .from(schema.storeReceipts)
    .where(isNotNull(schema.storeReceipts.supplier))
    .orderBy(asc(schema.storeReceipts.supplier));
  return rows.map((r) => r.s!).filter(Boolean);
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
      serialized: p.serialized,
      stock: p.stock.filter((s) => s.quantity > 0),
      total: p.total,
    }));
}
