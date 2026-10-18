import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { BILLABLE_KINDS, billableCounts, billablesState, createInvoice, DraftError, draftInvoice, editBillable, invoiceableClients, listBillables, postInvoices, postPreview, setBillableStatus, syncBillables } from "../lib/billables.ts";
import type { BillableKind } from "../lib/ticketSource.ts";
import { AutotaskError } from "../lib/autotask.ts";

/**
 * Accounting › Approbation: the work to bill (accounting.view), approved,
 * excluded, changed and posted as invoices (accounting.manage).
 */
const zKind = z.enum(BILLABLE_KINDS as [BillableKind, ...BillableKind[]]);
const zStatus = z.enum(["pending", "approved", "posted", "excluded"]);
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zDraft = z.object({
  clientId: zUuid,
  itemIds: z.array(zUuid).min(1).max(5000).optional(),
  kinds: z.array(zKind).min(1).optional(),
  issuedOn: zDay.optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  dueOn: zDay.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  poNumber: z.string().trim().max(60).nullable().optional(),
});
async function drafted<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DraftError) throw new HTTPException(e.message === "not_found" ? 404 : 400, { message: e.message });
    throw e;
  }
}

export const billablesRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("accounting.view"))

  .get("/", async (c) => {
    const kind = c.req.query("kind") ? zKind.parse(c.req.query("kind")) : null;
    const status = c.req.query("status") ? zStatus.parse(c.req.query("status")) : null;
    const clientId = c.req.query("clientId") ? zUuid.parse(c.req.query("clientId")) : null;
    return c.json(await listBillables(kind, status, clientId));
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

  // ── Créer des factures: a client, the kinds or lines, dates, terms, notes ──
  .get("/clients", async (c) => c.json(await invoiceableClients()))
  .post("/invoice/preview", async (c) => {
    const p = await body(c, zDraft);
    return c.json(await drafted(() => draftInvoice(p)));
  })
  .post("/invoice", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zDraft);
    const made = await drafted(() => createInvoice(a.user.id, p));
    await audit(a.user.id, "billing.invoice_created", made.id, { number: made.number, totalCents: made.totalCents });
    return c.json(made, 201);
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
