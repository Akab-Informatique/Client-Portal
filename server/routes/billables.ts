import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { BILLABLE_KINDS, billableCounts, billablesState, editBillable, listBillables, postInvoices, postPreview, setBillableStatus, syncBillables } from "../lib/billables.ts";
import type { BillableKind } from "../lib/ticketSource.ts";
import { AutotaskError } from "../lib/autotask.ts";

/**
 * Accounting › Approbation: the work to bill (accounting.view), approved,
 * excluded, changed and posted as invoices (accounting.manage).
 */
const zKind = z.enum(BILLABLE_KINDS as [BillableKind, ...BillableKind[]]);
const zStatus = z.enum(["pending", "approved", "posted", "excluded"]);

export const billablesRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("accounting.view"))

  .get("/", async (c) => {
    const kind = c.req.query("kind") ? zKind.parse(c.req.query("kind")) : null;
    const status = c.req.query("status") ? zStatus.parse(c.req.query("status")) : null;
    return c.json(await listBillables(kind, status));
  })
  .get("/summary", async (c) => c.json({ state: await billablesState(), counts: await billableCounts() }))

  /** Copy the work to bill from Autotask now (it also comes with each CRM sync). */
  .post("/import", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    try {
      const s = await syncBillables();
      await audit(a.user.id, "billing.items_imported", null, { counts: s.counts, errors: Object.keys(s.errors) });
      return c.json(s);
    } catch (e) {
      if (e instanceof AutotaskError) throw new HTTPException(502, { message: `autotask_${e.code}` });
      throw e;
    }
  })
  .post("/status", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ ids: z.array(zUuid).min(1).max(5000), status: z.enum(["pending", "approved", "excluded"]) }));
    const changed = await setBillableStatus(a.user.id, p.ids, p.status);
    await audit(a.user.id, `billing.items_${p.status}`, null, { count: changed });
    return c.json({ changed });
  })
  .patch("/:id", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        quantity: z.number().min(0).max(100_000).optional(),
        unitPriceCents: z.number().int().min(0).max(100_000_000).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        taxable: z.boolean().optional(),
      }),
    );
    const row = await editBillable(id, p);
    if (!row) throw new HTTPException(409, { message: "billing_item_posted" });
    await audit(a.user.id, "billing.item_edited", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  /** What posting the approved items would make (per client). */
  .get("/post", async (c) => {
    const groups = await postPreview();
    return c.json(groups.map(({ items, ...g }) => ({ ...g, kinds: [...new Set(items.map((i) => i.kind))] })));
  })
  .post("/post", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ clientIds: z.array(zUuid).max(5000).optional() }));
    const made = await postInvoices(a.user.id, p.clientIds);
    await audit(a.user.id, "billing.invoices_posted", null, { count: made.length, numbers: made.map((m) => m.number) });
    return c.json(made, 201);
  });
