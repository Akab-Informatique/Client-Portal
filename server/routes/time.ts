import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { addDays, editable, ensureTypes, sheetOf, todayQc, weekEntries, weekStartOf, weekTotals } from "../lib/timesheets.ts";
import { autoSync } from "../lib/quickbooks.ts";

/**
 * Timesheets and expenses: my week and my expense claims (timesheets.use),
 * their approval (timesheets.approve: hours per type only, not the details;
 * expenses with their receipt), and the types (Admin, admin.billing).
 */
const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RECEIPT = 5 * 1024 * 1024;
const zReceipt = z
  .object({ name: z.string().trim().min(1).max(200), contentType: z.string().max(120), data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_RECEIPT / 3) * 4) })
  .nullable()
  .optional();

type Expense = typeof schema.expenses.$inferSelect;
const expenseView = (x: Expense, extra: Record<string, unknown> = {}) => {
  const { receiptData, ...rest } = x;
  return { ...rest, hasReceipt: Boolean(receiptData), ...extra };
};

async function ownExpense(id: string, userId: string) {
  const [x] = await db().select().from(schema.expenses).where(and(eq(schema.expenses.id, zUuid.parse(id)), eq(schema.expenses.userId, userId)));
  if (!x) throw new HTTPException(404, { message: "not_found" });
  return x;
}

/** Amount from quantity × the type's rate (km…), or the amount typed. */
async function priced(typeId: string, p: { quantity?: number; amountCents?: number }) {
  const [type] = await db().select().from(schema.expenseTypes).where(eq(schema.expenseTypes.id, typeId));
  if (!type || !type.active) throw new HTTPException(400, { message: "expense_type_unknown" });
  if (type.unit && type.unitPriceCents != null) {
    const q = Math.round((p.quantity ?? 0) * 100);
    if (q <= 0) throw new HTTPException(400, { message: "Validation failed" });
    return { type, quantityX100: q, unitPriceCents: type.unitPriceCents, amountCents: Math.round((q * type.unitPriceCents) / 100) };
  }
  if (!p.amountCents || p.amountCents <= 0) throw new HTTPException(400, { message: "Validation failed" });
  return { type, quantityX100: 100, unitPriceCents: p.amountCents, amountCents: p.amountCents };
}

export const timeRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** The active types, for the forms. */
  .get("/types", async (c) => {
    await ensureTypes();
    const d = db();
    const [time, expense] = await Promise.all([
      d.select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.active, true)).orderBy(asc(schema.timesheetTypes.position), asc(schema.timesheetTypes.name)),
      d.select().from(schema.expenseTypes).where(eq(schema.expenseTypes.active, true)).orderBy(asc(schema.expenseTypes.position), asc(schema.expenseTypes.name)),
    ]);
    return c.json({ time, expense });
  })

  // ── Admin › Temps et dépenses ──
  .get("/admin/types", requirePermission("admin.billing"), async (c) => {
    await ensureTypes();
    const d = db();
    return c.json({
      time: await d.select().from(schema.timesheetTypes).orderBy(asc(schema.timesheetTypes.position), asc(schema.timesheetTypes.name)),
      expense: await d.select().from(schema.expenseTypes).orderBy(asc(schema.expenseTypes.position), asc(schema.expenseTypes.name)),
    });
  })
  .post("/admin/timesheet-types", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const [row] = await db().insert(schema.timesheetTypes).values({ name: p.name, kind: "other", position: 100 }).returning();
    await audit(a.user.id, "time.type_created", row.id, { name: p.name });
    return c.json(row, 201);
  })
  .patch("/admin/timesheet-types/:id", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ name: z.string().trim().min(1).max(80), active: z.boolean(), quickbooksItemId: z.string().max(40).nullable() }).partial());
    const [cur] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, id));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    // the ticket time type is always there
    if (cur.kind === "labour" && p.active === false) throw new HTTPException(409, { message: "time_type_builtin" });
    const [row] = await db().update(schema.timesheetTypes).set({ ...p, updatedAt: new Date() }).where(eq(schema.timesheetTypes.id, id)).returning();
    await audit(a.user.id, "time.type_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })
  .post("/admin/expense-types", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(80), ledgerAccountId: zUuid.nullable().optional(), unit: z.string().trim().max(20).nullable().optional(), unitPriceCents: z.number().int().min(0).max(1_000_000).nullable().optional(), billable: z.boolean().optional() }),
    );
    const [row] = await db()
      .insert(schema.expenseTypes)
      .values({ name: p.name, ledgerAccountId: p.ledgerAccountId ?? null, unit: p.unit || null, unitPriceCents: p.unit ? (p.unitPriceCents ?? null) : null, billable: p.billable ?? false, position: 100 })
      .returning();
    await audit(a.user.id, "expense.type_created", row.id, { name: p.name });
    return c.json(row, 201);
  })
  .patch("/admin/expense-types/:id", requirePermission("admin.billing"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(
      c,
      z
        .object({ name: z.string().trim().min(1).max(80), ledgerAccountId: zUuid.nullable(), unit: z.string().trim().max(20).nullable(), unitPriceCents: z.number().int().min(0).max(1_000_000).nullable(), billable: z.boolean(), active: z.boolean() })
        .partial(),
    );
    const [row] = await db().update(schema.expenseTypes).set({ ...p, ...(p.unit === "" ? { unit: null } : {}), updatedAt: new Date() }).where(eq(schema.expenseTypes.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "expense.type_updated", id, { fields: Object.keys(p) });
    return c.json(row);
  })

  // ── my timesheet ──
  .get("/week", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const weekStart = weekStartOf(c.req.query("start") ? zDay.parse(c.req.query("start")) : todayQc());
    const sheet = await sheetOf(a.user.id, weekStart);
    const rows = await weekEntries(a.user.id, weekStart);
    const [me] = await db().select({ required: schema.users.timesheetRequired }).from(schema.users).where(eq(schema.users.id, a.user.id));
    return c.json({
      weekStart,
      /** This person submits weekly timesheets for approval (set by an admin) */
      required: me?.required ?? true,
      weekEnd: addDays(weekStart, 6),
      status: sheet.status,
      comment: sheet.comment,
      entries: rows.map((r) => ({ ...r.e, hours: r.e.hoursX100 / 100, type: r.type, kind: r.kind })),
      ...(await weekTotals(a.user.id, weekStart)),
    });
  })
  .post("/entries", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ date: zDay, typeId: zUuid, hours: z.number().positive().max(24), note: z.string().trim().max(500).optional() }));
    const [type] = await db().select().from(schema.timesheetTypes).where(eq(schema.timesheetTypes.id, p.typeId));
    // ticket time comes from the tickets only
    if (!type || !type.active || type.kind === "labour") throw new HTTPException(400, { message: "time_type_unknown" });
    const sheet = await sheetOf(a.user.id, weekStartOf(p.date));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    const [row] = await db()
      .insert(schema.timesheetEntries)
      .values({ userId: a.user.id, date: p.date, typeId: type.id, hoursX100: Math.round(p.hours * 100), note: p.note || null, source: "manual" })
      .returning();
    return c.json(row, 201);
  })
  .delete("/entries/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const [e] = await db()
      .select()
      .from(schema.timesheetEntries)
      .where(and(eq(schema.timesheetEntries.id, zUuid.parse(c.req.param("id"))), eq(schema.timesheetEntries.userId, a.user.id)));
    if (!e || e.source !== "manual") throw new HTTPException(404, { message: "not_found" });
    const sheet = await sheetOf(a.user.id, weekStartOf(e.date));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    await db().delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, e.id));
    return c.json({ ok: true });
  })
  .post("/week/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ weekStart: zDay }));
    const sheet = await sheetOf(a.user.id, weekStartOf(p.weekStart));
    if (!editable(sheet.status)) throw new HTTPException(409, { message: "timesheet_locked" });
    const [me] = await db().select({ required: schema.users.timesheetRequired }).from(schema.users).where(eq(schema.users.id, a.user.id));
    if (me && !me.required) throw new HTTPException(409, { message: "timesheet_not_required" });
    const [row] = await db().update(schema.timesheets).set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() }).where(eq(schema.timesheets.id, sheet.id)).returning();
    await audit(a.user.id, "timesheet.submitted", row.id, { weekStart: row.weekStart });
    return c.json(row);
  })

  // ── my expenses ──
  .get("/expenses", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ x: schema.expenses, type: schema.expenseTypes.name, client: schema.clients.name })
      .from(schema.expenses)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
      .where(eq(schema.expenses.userId, a.user.id))
      .orderBy(desc(schema.expenses.date), desc(schema.expenses.createdAt));
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, clientName: r.client })));
  })
  .post("/expenses", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        date: zDay,
        typeId: zUuid,
        description: z.string().trim().min(1).max(500),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
      }),
    );
    const pr = await priced(p.typeId, p);
    const [row] = await db()
      .insert(schema.expenses)
      .values({
        userId: a.user.id,
        date: p.date,
        typeId: pr.type.id,
        description: p.description,
        quantityX100: pr.quantityX100,
        unitPriceCents: pr.unitPriceCents,
        amountCents: pr.amountCents,
        clientId: p.clientId ?? null,
        billable: Boolean(p.clientId) && (p.billable ?? pr.type.billable),
        receiptName: p.receipt?.name ?? null,
        receiptType: p.receipt?.contentType ?? null,
        receiptData: p.receipt?.data ?? null,
      })
      .returning();
    return c.json(expenseView(row), 201);
  })
  .patch("/expenses/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    const p = await body(
      c,
      z.object({
        date: zDay.optional(),
        typeId: zUuid.optional(),
        description: z.string().trim().min(1).max(500).optional(),
        quantity: z.number().min(0).max(100_000).optional(),
        amountCents: z.number().int().min(0).max(10_000_000).optional(),
        clientId: zUuid.nullable().optional(),
        billable: z.boolean().optional(),
        receipt: zReceipt,
      }),
    );
    const pr = p.typeId || p.quantity !== undefined || p.amountCents !== undefined ? await priced(p.typeId ?? cur.typeId, { quantity: p.quantity ?? cur.quantityX100 / 100, amountCents: p.amountCents ?? cur.amountCents }) : null;
    const clientId = p.clientId !== undefined ? p.clientId : cur.clientId;
    const [row] = await db()
      .update(schema.expenses)
      .set({
        date: p.date ?? cur.date,
        description: p.description ?? cur.description,
        ...(pr ? { typeId: pr.type.id, quantityX100: pr.quantityX100, unitPriceCents: pr.unitPriceCents, amountCents: pr.amountCents } : {}),
        clientId,
        billable: Boolean(clientId) && (p.billable ?? cur.billable),
        ...(p.receipt !== undefined ? { receiptName: p.receipt?.name ?? null, receiptType: p.receipt?.contentType ?? null, receiptData: p.receipt?.data ?? null } : {}),
        status: "draft",
        updatedAt: new Date(),
      })
      .where(eq(schema.expenses.id, cur.id))
      .returning();
    return c.json(expenseView(row));
  })
  .delete("/expenses/:id", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    await db().delete(schema.expenses).where(eq(schema.expenses.id, cur.id));
    return c.json({ ok: true });
  })
  .post("/expenses/:id/submit", requirePermission("timesheets.use"), async (c) => {
    const a = auth(c);
    const cur = await ownExpense(c.req.param("id"), a.user.id);
    if (!editable(cur.status)) throw new HTTPException(409, { message: "expense_locked" });
    const [row] = await db().update(schema.expenses).set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() }).where(eq(schema.expenses.id, cur.id)).returning();
    await audit(a.user.id, "expense.submitted", row.id, { amountCents: row.amountCents });
    return c.json(expenseView(row));
  })
  /** The receipt: its owner, or whoever approves. */
  .get("/expenses/:id/receipt", async (c) => {
    const a = auth(c);
    const [x] = await db().select().from(schema.expenses).where(eq(schema.expenses.id, zUuid.parse(c.req.param("id"))));
    if (!x || !x.receiptData || (x.userId !== a.user.id && !a.permissions.includes("timesheets.approve"))) throw new HTTPException(404, { message: "not_found" });
    const name = x.receiptName ?? "recu";
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(Buffer.from(x.receiptData, "base64"), {
      headers: {
        "content-type": /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(x.receiptType ?? "") ? x.receiptType! : "application/octet-stream",
        "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  })

  // ── approval (timesheets.approve) ──
  /** Weeks to approve: per person, the hours per type only. */
  .get("/approvals/timesheets", requirePermission("timesheets.approve"), async (c) => {
    const status = z.enum(["submitted", "approved", "rejected"]).parse(c.req.query("status") ?? "submitted");
    const rows = await db()
      .select({ s: schema.timesheets, name: schema.users.name })
      .from(schema.timesheets)
      .innerJoin(schema.users, eq(schema.users.id, schema.timesheets.userId))
      .where(eq(schema.timesheets.status, status))
      .orderBy(desc(schema.timesheets.weekStart), asc(schema.users.name))
      .limit(200);
    const out = [];
    for (const r of rows) {
      out.push({
        id: r.s.id,
        userName: r.name,
        weekStart: r.s.weekStart,
        weekEnd: addDays(r.s.weekStart, 6),
        status: r.s.status,
        submittedAt: r.s.submittedAt,
        comment: r.s.comment,
        quickbooks: r.s.quickbooksSyncedAt || r.s.quickbooksError ? { syncedAt: r.s.quickbooksSyncedAt, error: r.s.quickbooksError } : null,
        ...(await weekTotals(r.s.userId, r.s.weekStart)),
      });
    }
    return c.json(out);
  })
  .post("/approvals/timesheets/:id", requirePermission("timesheets.approve"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(500).optional() }));
    const [cur] = await db().select().from(schema.timesheets).where(eq(schema.timesheets.id, zUuid.parse(c.req.param("id"))));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.status !== "submitted") throw new HTTPException(409, { message: "timesheet_not_submitted" });
    const [row] = await db()
      .update(schema.timesheets)
      .set({ status: p.decision === "approve" ? "approved" : "rejected", decidedBy: a.user.id, decidedAt: new Date(), comment: p.comment || null, updatedAt: new Date() })
      .where(eq(schema.timesheets.id, cur.id))
      .returning();
    await audit(a.user.id, `timesheet.${p.decision === "approve" ? "approved" : "rejected"}`, row.id, { weekStart: row.weekStart });
    if (row.status === "approved") await autoSync("timesheets", row.id);
    return c.json({ id: row.id, status: row.status });
  })
  .get("/approvals/expenses", requirePermission("timesheets.approve"), async (c) => {
    const status = z.enum(["submitted", "approved", "rejected"]).parse(c.req.query("status") ?? "submitted");
    const rows = await db()
      .select({ x: schema.expenses, type: schema.expenseTypes.name, unit: schema.expenseTypes.unit, user: schema.users.name, client: schema.clients.name })
      .from(schema.expenses)
      .innerJoin(schema.expenseTypes, eq(schema.expenseTypes.id, schema.expenses.typeId))
      .innerJoin(schema.users, eq(schema.users.id, schema.expenses.userId))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
      .where(eq(schema.expenses.status, status))
      .orderBy(asc(schema.users.name), desc(schema.expenses.date))
      .limit(500);
    return c.json(rows.map((r) => expenseView(r.x, { type: r.type, unit: r.unit, userName: r.user, clientName: r.client })));
  })
  .post("/approvals/expenses", requirePermission("timesheets.approve"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ ids: z.array(zUuid).min(1).max(500), decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(500).optional() }));
    const d = db();
    const rows = await d.select().from(schema.expenses).where(and(inArray(schema.expenses.id, p.ids), eq(schema.expenses.status, "submitted")));
    for (const x of rows) {
      let billingItemId: string | null = null;
      // billable to a client: it becomes work to invoice, already approved
      if (p.decision === "approve" && x.billable && x.clientId) {
        const [type] = await d.select({ name: schema.expenseTypes.name }).from(schema.expenseTypes).where(eq(schema.expenseTypes.id, x.typeId));
        const [u] = await d.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, x.userId));
        const [item] = await d
          .insert(schema.billingItems)
          .values({
            clientId: x.clientId,
            kind: "expense",
            source: "portal",
            sourceId: `expense:${x.id}`,
            date: x.date,
            description: `${type?.name ?? ""} — ${x.description}`,
            resourceName: u?.name ?? null,
            quantityX100: x.quantityX100,
            unitPriceCents: x.unitPriceCents,
            amountCents: x.amountCents,
            status: "approved",
            approvedBy: a.user.id,
            approvedAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ id: schema.billingItems.id });
        billingItemId = item?.id ?? null;
      }
      await d
        .update(schema.expenses)
        .set({ status: p.decision === "approve" ? "approved" : "rejected", decidedBy: a.user.id, decidedAt: new Date(), comment: p.comment || null, billingItemId, updatedAt: new Date() })
        .where(eq(schema.expenses.id, x.id));
      if (p.decision === "approve") await autoSync("expenses", x.id);
    }
    await audit(a.user.id, `expense.${p.decision === "approve" ? "approved" : "rejected"}`, null, { count: rows.length });
    return c.json({ changed: rows.length });
  });
