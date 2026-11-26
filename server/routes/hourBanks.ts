import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { body, zUuid } from "../lib/validate.ts";
import { db, schema } from "../db/index.ts";
import { bankTargets, linkHourBank, sellHourBank } from "../lib/hourBanks.ts";
import { ticketScopeOf } from "../lib/selfManaged.ts";

/**
 * Prepaid hours banks (see server/lib/hourBanks.ts): the tickets and projects a bank can be tied to, selling one (from Accounting ›
 * Éléments à facturer with its billing item, or from the client's page with or without it) and tying one to a ticket / project later.
 * A quote sells them when it is accepted (routes/quotes.ts).
 */
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const hourBankRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .get("/targets", requirePermission("crm.view", "quotes.view", "accounting.view"), async (c) => {
    const id = c.req.query("clientId") ?? "";
    if (!zUuid.safeParse(id).success) throw new HTTPException(400, { message: "invalid_client" });
    return c.json(await bankTargets(id, ticketScopeOf(c)));
  })
  /** The usual hourly rate to start the sale window with: the client's own rate, else the usual one */
  .get("/defaults", requirePermission("crm.view", "accounting.view", "quotes.view"), async (c) => {
    const { billingSettings } = await import("../lib/billing.ts");
    const id = c.req.query("clientId") ?? "";
    const usual = (await billingSettings()).rates.hourly;
    let rate = usual;
    if (zUuid.safeParse(id).success) {
      const [cl] = await db().select({ invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, id));
      const own = (cl?.invoice as { hourlyRate?: number } | null | undefined)?.hourlyRate;
      if (typeof own === "number" && own > 0) rate = own;
    }
    return c.json({ rate });
  })
  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        clientId: zUuid,
        name: z.string().trim().max(200).nullable().optional(),
        /** Hours bought and the price of an hour (dollars) */
        hours: z.number().positive().max(100_000),
        rate: z.number().min(0).max(100_000),
        ticketId: z.number().int().positive().nullable().optional(),
        projId: zUuid.nullable().optional(),
        expiresOn: zDay.nullable().optional(),
        /** Make the billing item (approved, ready to invoice); false = a bank given or paid elsewhere */
        invoice: z.boolean().default(true),
        taxable: z.boolean().default(true),
      }),
    );
    // the bank itself is the client's contract (crm.billing); its billing item is accounting's
    if (!a.permissions.includes(p.invoice ? "accounting.manage" : "crm.billing")) throw new HTTPException(403, { message: "Forbidden" });
    const made = await sellHourBank(a.user.id, { clientId: p.clientId, name: p.name, hours: p.hours, rateCents: Math.round(p.rate * 100), ticketId: p.ticketId, projId: p.projId, expiresOn: p.expiresOn, invoice: p.invoice, taxable: p.taxable, approved: true, ticketScope: ticketScopeOf(c) });
    return c.json({ id: made.contract.id, name: made.contract.name, billingItemId: made.itemId }, 201);
  })
  /** Tie a bank to a ticket or a project of its client, or to none */
  .put("/:id/link", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ ticketId: z.number().int().positive().nullable().optional(), projId: zUuid.nullable().optional() }));
    const [k] = await db().select({ clientId: schema.clientContracts.clientId }).from(schema.clientContracts).where(eq(schema.clientContracts.id, id));
    if (!k) throw new HTTPException(404, { message: "not_found" });
    return c.json(await linkHourBank(a.user.id, k.clientId, id, p, ticketScopeOf(c)));
  });
