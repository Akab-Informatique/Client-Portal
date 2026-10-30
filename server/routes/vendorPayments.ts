import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, gt, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { quickbooksSettings } from "../lib/billing.ts";
import { errText, QuickBooksError } from "../lib/quickbooks.ts";
import { billsSummary, billView, pullBills } from "../lib/vendorBills.ts";

/**
 * Accounting › Paiements fournisseurs: the vendors' bills copied from QuickBooks and what is due when
 * (`accounting.view`; `accounting.manage` to refresh from QuickBooks). Read only: nothing goes back to QuickBooks.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zList = z.object({
  /** open = still to pay (late included) · overdue · paid · all */
  status: z.enum(["open", "overdue", "paid", "all"]).default("open"),
  /** on the due date */
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
});

export const vendorPaymentRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("accounting.view"))

  .get("/status", async (c) => {
    const s = await quickbooksSettings();
    return c.json({ connected: Boolean(s.enabled && s.refreshToken && s.realmId), syncOn: s.sync.bills, last: s.imports.bills ?? null });
  })

  .get("/summary", async (c) => c.json(await billsSummary()))

  .get("/bills", async (c) => {
    const p = zList.parse(c.req.query());
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const t = schema.vendorBills;
    const where = and(
      p.status === "paid" ? sql`${t.balanceCents} <= 0` : p.status === "all" ? undefined : gt(t.balanceCents, 0),
      p.status === "overdue" ? sql`${t.dueOn} < ${today}` : undefined,
      p.from ? gte(t.dueOn, p.from) : undefined,
      p.to ? lte(t.dueOn, p.to) : undefined,
      p.q ? or(ilike(t.vendorName, `%${p.q}%`), ilike(t.docNumber, `%${p.q}%`)) : undefined,
    );
    const rows = await db().select().from(t).where(where).orderBy(p.status === "paid" ? desc(t.dueOn) : asc(t.dueOn), asc(t.vendorName)).limit(2000);
    const bills = rows.map((b) => billView(b, today));
    return c.json({ today, bills, totalCents: bills.reduce((x, b) => x + b.balanceCents, 0) });
  })

  .post("/sync", requirePermission("accounting.manage"), async (c) => {
    try {
      const r = await pullBills(auth(c).user.id);
      await audit(auth(c).user.id, "vendor_bills.synced", null, { added: r.added, updated: r.updated, removed: r.removed });
      return c.json(r);
    } catch (e) {
      if (e instanceof QuickBooksError) throw new HTTPException(e.code === "not_connected" ? 409 : 502, { message: e.code === "not_connected" ? "quickbooks_not_connected" : "quickbooks_failed", cause: errText(e) });
      throw e;
    }
  });
