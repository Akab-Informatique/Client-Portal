import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { applyToLines, contractsIn, runningLinesOf } from "../lib/servicePrices.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Services (under Inventory): what the company sells besides products — a name, a price, one time or
 * recurring (monthly). No stock. Seen with services.view, changed with services.manage.
 */
const zCents = z.number().int().min(0).max(100_000_000);
const zFields = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000),
  // one time, recurring monthly ("recurring", as before) or recurring yearly
  kind: z.enum(["one_time", "recurring", "recurring_yearly"]),
  priceCents: zCents,
  costCents: zCents,
  taxable: z.boolean(),
  active: z.boolean(),
  // who we buy it from, and their reference: for our own use only (never shown to a client)
  vendorId: zUuid.nullable(),
  vendorSku: z.string().trim().max(100).nullable(),
});
// a new service: the defaults
const zService = zFields.partial({ description: true, kind: true, costCents: true, taxable: true, active: true, vendorId: true, vendorSku: true }).transform((p) => ({ description: "", kind: "recurring" as const, costCents: 0, taxable: true, active: true, vendorId: null, vendorSku: null, ...p }));
// a change: only what is sent (a default here would reset the other fields)
// `applyToContracts`: when the price or cost changes and the service is in running contracts, say whether they follow (true) or only future additions do (false)
const zPatch = zFields.partial().extend({ applyToContracts: z.boolean().optional() });

/** A vendor that exists, and a reference not already used by another service of that vendor */
async function checkVendor(vendorId: string | null | undefined, vendorSku: string | null | undefined, exceptServiceId?: string) {
  if (!vendorId) return;
  const [v] = await db().select({ id: schema.vendors.id }).from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  if (!v) throw new HTTPException(400, { message: "vendor_unknown" });
  if (vendorSku) {
    const [same] = await db().select({ id: schema.services.id }).from(schema.services).where(and(eq(schema.services.vendorId, vendorId), eq(schema.services.vendorSku, vendorSku)));
    if (same && same.id !== exceptServiceId) throw new HTTPException(409, { message: "vendor_sku_taken" });
  }
}

export const serviceRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  .get("/", requirePermission("services.view"), async (c) => {
    const rows = await db()
      .select({ s: schema.services, vendorName: schema.vendors.name })
      .from(schema.services)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.services.vendorId))
      .orderBy(asc(schema.services.name));
    return c.json(rows.map((r) => ({ ...r.s, vendorName: r.vendorName })));
  })

  /** The vendors to pick from (internal: where we buy a service) */
  .get("/vendors", requirePermission("services.view", "services.manage"), async (c) => {
    const rows = await db().select({ id: schema.vendors.id, name: schema.vendors.name }).from(schema.vendors).where(eq(schema.vendors.active, true)).orderBy(asc(schema.vendors.name));
    return c.json(rows);
  })

  .post("/", requirePermission("services.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zService);
    await checkVendor(p.vendorId, p.vendorSku);
    const [row] = await db().insert(schema.services).values(p).returning();
    await audit(a.user.id, "service.created", row.id, { name: p.name });
    return c.json(row, 201);
  })

  .patch("/:id", requirePermission("services.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const { applyToContracts, ...p } = await body(c, zPatch);
    const [before] = await db().select().from(schema.services).where(eq(schema.services.id, id));
    if (!before) throw new HTTPException(404, { message: "not_found" });
    // the vendor of a service made by the ITCloud sync is the sync's (it finds the service by it)
    if (before.sku?.startsWith("ITC-") && ((p.vendorId !== undefined && p.vendorId !== before.vendorId) || (p.vendorSku !== undefined && p.vendorSku !== before.vendorSku))) throw new HTTPException(409, { message: "service_from_vendor" });
    if (p.vendorId !== undefined || p.vendorSku !== undefined) await checkVendor(p.vendorId === undefined ? before.vendorId : p.vendorId, p.vendorSku === undefined ? before.vendorSku : p.vendorSku, id);
    // a price or cost that really changes, for a service that is in running contracts: ask whether they follow
    const priceChanged = p.priceCents !== undefined && p.priceCents !== before.priceCents;
    const costChanged = p.costCents !== undefined && p.costCents !== before.costCents;
    const lines = priceChanged || costChanged ? await runningLinesOf(id) : [];
    if (lines.length && applyToContracts === undefined) throw new HTTPException(409, { message: "price_scope_required", cause: [{ path: "contracts", message: String(contractsIn(lines)) }] });
    const [row] = await db()
      .update(schema.services)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.services.id, id))
      .returning();
    if (applyToContracts && lines.length) await applyToLines(lines, { ...(priceChanged ? { priceCents: row.priceCents } : {}), ...(costChanged ? { costCents: row.costCents } : {}) }, { userId: a.user.id });
    await audit(a.user.id, "service.updated", id, { fields: Object.keys(p), ...(lines.length ? { contracts: contractsIn(lines), applied: Boolean(applyToContracts) } : {}) });
    return c.json(row);
  })

  .delete("/:id", requirePermission("services.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().delete(schema.services).where(eq(schema.services.id, id)).returning({ name: schema.services.name });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "service.deleted", id, { name: row.name });
    return c.json({ ok: true });
  });
