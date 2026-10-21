import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { QuickBooksError, quickbooksVendors } from "../lib/quickbooks.ts";
import { pushSoon } from "../lib/qbSync.ts";

/**
 * Admin › PSA › Fournisseurs (admin.billing): the company's vendors. They are NOT synced with QuickBooks: each
 * one is mapped by hand to a QuickBooks vendor (or left alone), and never two to the same one.
 */
const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();
const zVendor = z.object({ name: z.string().trim().min(1).max(200), email: zText(200), phone: zText(60), notes: zText(2000), active: z.boolean().optional() });

export const vendorRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.billing"))

  .get("/", async (c) => c.json(await db().select().from(schema.vendors).orderBy(asc(schema.vendors.name))))

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, zVendor);
    const [row] = await db().insert(schema.vendors).values({ name: p.name, email: p.email ?? null, phone: p.phone ?? null, notes: p.notes ?? null, active: p.active ?? true }).returning();
    await audit(a.user.id, "vendor.created", row.id, { name: p.name });
    return c.json(row, 201);
  })

  .patch("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, zVendor.partial());
    const [row] = await db()
      .update(schema.vendors)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.vendors.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "vendor.updated", id, { fields: Object.keys(p) });
    // a vendor kept in step with QuickBooks: the change goes there too
    void pushSoon("vendors", id);
    return c.json(row);
  })

  .delete("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().delete(schema.vendors).where(eq(schema.vendors.id, id)).returning({ name: schema.vendors.name });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "vendor.deleted", id, { name: row.name });
    return c.json({ ok: true });
  })

  /** The QuickBooks vendors to choose from (read from QuickBooks each time; nothing is copied). */
  .get("/quickbooks/list", async (c) => {
    try {
      return c.json(await quickbooksVendors());
    } catch (e) {
      if (e instanceof QuickBooksError) throw new HTTPException(e.code === "not_connected" ? 409 : 502, { message: `quickbooks_${e.code}`, cause: e.detail ? [{ path: "quickbooks", message: e.detail }] : undefined });
      throw e;
    }
  })

  /** Map a vendor to a QuickBooks vendor by hand (null: unmap). */
  .put("/:id/quickbooks", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ quickbooksId: z.string().trim().min(1).max(40).nullable() }));
    if (p.quickbooksId) {
      const [other] = await db().select({ name: schema.vendors.name }).from(schema.vendors).where(and(eq(schema.vendors.quickbooksId, p.quickbooksId), ne(schema.vendors.id, id)));
      if (other) throw new HTTPException(409, { message: "quickbooks_vendor_taken", cause: [{ path: "quickbooks", message: other.name }] });
    }
    const [row] = await db().update(schema.vendors).set({ quickbooksId: p.quickbooksId, qbSyncedAt: null, updatedAt: new Date() }).where(eq(schema.vendors.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "vendor.mapped", id, { quickbooksId: p.quickbooksId });
    return c.json(row);
  });
