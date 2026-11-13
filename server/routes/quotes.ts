import { syncQuoteToPipeline } from "../lib/quoteSales.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { productsWithStock } from "../lib/store.ts";
import { depositOf } from "../../shared/quotes.ts";
import { DraftError, quickInvoice } from "../lib/billables.ts";
import { billingSettings } from "../lib/billing.ts";
import { autoSync } from "../lib/quickbooks.ts";
import { sendInvoiceMail } from "../lib/invoiceMail.ts";
import { stripePayReady } from "../lib/payLink.ts";
import { getQuote, listQuotes, nextQuoteNumber, saveLines, todayQc } from "../lib/quotes.ts";
import { QUOTE_KINDS, QUOTE_RECURRENCES, QUOTE_STATUSES, recurrenceOf } from "../../shared/quotes.ts";

/** Lower case, no accents, punctuation as spaces: "Exchange Online (Plan 1)" → "exchange online plan 1" */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Every word typed is somewhere in the text, in any order ("exchange plan 1" finds "Exchange Online (Plan 1) P1M") */
const matcher = (q: string) => {
  const words = fold(q).split(" ").filter(Boolean);
  return (text: string) => {
    const hay = ` ${fold(text)} `;
    return words.every((w) => hay.includes(w));
  };
};

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zCents = z.number().int().min(0).max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().default(null);

const zLine = z.object({
  productId: zUuid.nullable().default(null),
  serviceId: zUuid.nullable().default(null),
  sku: z.string().trim().max(60).transform((s) => s || null).nullable().default(null),
  description: z.string().trim().min(1).max(2000),
  details: text(2000),
  quantityX100: z.number().int().min(1).max(100_000_000).default(100),
  unitPriceCents: zCents.default(0),
  unitCostCents: zCents.default(0),
  /** percent ×100: 0 to 100 % */
  discountX100: z.number().int().min(0).max(10_000).default(0),
  taxable: z.boolean().default(true),
  optional: z.boolean().default(false),
  recurrence: z.enum(QUOTE_RECURRENCES).default("once"),
});

const zQuote = z.object({
  clientId: zUuid.nullable().default(null),
  prospectName: text(200),
  contactName: text(200),
  contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.union([z.email(), z.literal("")])).transform((s) => s || null).nullable().default(null),
  title: z.string().trim().max(200).default(""),
  issuedOn: zDate.optional(),
  validUntil: zDate.nullable().default(null),
  taxes: z.boolean().optional(),
  notes: text(4000),
  internalNotes: text(4000),
  lines: z.array(zLine).max(300).default([]),
  kind: z.enum(QUOTE_KINDS).default("standard"),
  saleType: z.enum(["fixed", "bank", "hourly"]).default("fixed"),
  preparedById: zUuid.nullable().optional(),
  survey: z.record(z.string().max(80), z.string().max(2000)).refine((o) => Object.keys(o).length <= 800).default({}),
});

async function clientTaxes(clientId: string | null): Promise<boolean | null> {
  if (!clientId) return null;
  const [c] = await db().select({ id: schema.clients.id, invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!c) throw new HTTPException(400, { message: "client_not_found" });
  return c.invoice?.taxes !== false;
}

const needsWho = (p: { clientId: string | null; prospectName: string | null }) => {
  if (!p.clientId && !p.prospectName) throw new HTTPException(400, { message: "quote_who_required" });
};

/** A line keeps the inventory product it came from only while that product exists. */
async function checkProducts(lines: { productId: string | null; serviceId: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
  if (ids.length) {
    const rows = await db().select({ id: schema.storeProducts.id }).from(schema.storeProducts).where(inArray(schema.storeProducts.id, ids));
    const known = new Set(rows.map((r) => r.id));
    if (ids.some((i) => !known.has(i))) throw new HTTPException(400, { message: "product_not_found" });
  }
  // the same for a line taken from Inventory › Services
  const sids = [...new Set(lines.map((l) => l.serviceId).filter((x): x is string => Boolean(x)))];
  if (sids.length) {
    const rows = await db().select({ id: schema.services.id }).from(schema.services).where(inArray(schema.services.id, sids));
    const known = new Set(rows.map((r) => r.id));
    if (sids.some((i) => !known.has(i))) throw new HTTPException(400, { message: "service_not_found" });
  }
}

/** Whoever prepares a quote is an active staff member (the list of the editor). */
async function staffMember(id: string) {
  const [u] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new HTTPException(400, { message: "prepared_by_invalid" });
}

const OPEN = new Set(["draft", "sent"]);

/** Quotes (quotes.view to see, quotes.manage to change). */
export const quoteRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("quotes.view"))

  .get("/", async (c) => {
    const status = c.req.query("status");
    const clientId = c.req.query("clientId");
    return c.json(
      await listQuotes({
        status: status && (QUOTE_STATUSES as readonly string[]).includes(status) ? status : undefined,
        clientId: clientId && zUuid.safeParse(clientId).success ? clientId : undefined,
        q: c.req.query("q"),
      }),
    );
  })

  /** For the client field: who a quote can be made for, and whether they pay taxes. */
  .get("/clients", async (c) => {
    const rows = await db()
      .select({ id: schema.clients.id, name: schema.clients.name, email: schema.clients.email, invoice: schema.clients.invoice })
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(asc(schema.clients.name));
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, email: r.email, taxes: r.invoice?.taxes !== false })));
  })

  /** The technicians a quote can be prepared by. */
  .get("/staff", async (c) => {
    const rows = await db().select({ id: schema.users.id, name: schema.users.name, title: schema.users.title }).from(schema.users).where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true))).orderBy(asc(schema.users.name));
    return c.json(rows);
  })

  /**
   * The inventory, for adding lines: what is sold most often in quotes first, then by name.
   * Only what a quote needs (no stock per location), so it needs no inventory right.
   */
  .get("/products", async (c) => {
    const matches = matcher(c.req.query("q") ?? "");
    const [products, used] = await Promise.all([
      productsWithStock(),
      db()
        .select({ productId: schema.quoteLines.productId, n: sql<number>`count(*)::int` })
        .from(schema.quoteLines)
        .where(isNotNull(schema.quoteLines.productId))
        .groupBy(schema.quoteLines.productId),
    ]);
    const uses = new Map(used.map((u) => [u.productId, u.n]));
    const shown = products
      .filter((p) => p.active)
      .filter((p) => matches(`${p.sku ?? ""} ${p.name} ${p.manufacturer ?? ""} ${p.category ?? ""}`))
      .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 40)
      .map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        manufacturer: p.manufacturer,
        category: p.category,
        priceCents: p.priceCents,
        costCents: p.costCents,
        stock: p.total,
        uses: uses.get(p.id) ?? 0,
      }));
    return c.json(shown);
  })

  /**
   * The services (Inventory › Services), for adding lines: every active one, the most quoted first, then by name;
   * the search is word by word, accents and punctuation ignored.
   * A monthly / yearly service becomes a monthly / yearly line. Needs no services right, like the inventory.
   */
  .get("/services", async (c) => {
    const matches = matcher(c.req.query("q") ?? "");
    const [rows, used] = await Promise.all([
      db().select().from(schema.services).where(eq(schema.services.active, true)),
      db()
        .select({ serviceId: schema.quoteLines.serviceId, n: sql<number>`count(*)::int` })
        .from(schema.quoteLines)
        .where(isNotNull(schema.quoteLines.serviceId))
        .groupBy(schema.quoteLines.serviceId),
    ]);
    const uses = new Map(used.map((u) => [u.serviceId, u.n]));
    const recurrence = (kind: string) => (kind === "recurring" ? "monthly" : kind === "recurring_yearly" ? "yearly" : "once");
    return c.json(
      rows
        .filter((s) => matches(`${s.sku ?? ""} ${s.name} ${s.description} ${s.vendorSku ?? ""}`))
        .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.name.localeCompare(b.name, "fr"))
        // every active service (the catalogue is not that long); a cap only against a runaway list
        .slice(0, 1000)
        .map((s) => ({ id: s.id, sku: s.sku, name: s.name, description: s.description, recurrence: recurrence(s.kind), priceCents: s.priceCents, costCents: s.costCents, taxable: s.taxable, uses: uses.get(s.id) ?? 0 })),
    );
  })

  .get("/:id", async (c) => {
    const q = await getQuote(zUuid.parse(c.req.param("id")));
    if (!q) throw new HTTPException(404, { message: "not_found" });
    return c.json(q);
  })

  .post("/", requirePermission("quotes.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zQuote);
    needsWho(p);
    await checkProducts(p.lines);
    const preparedBy = p.preparedById ?? a.user.id;
    await staffMember(preparedBy);
    const taxes = p.taxes ?? (await clientTaxes(p.clientId)) ?? true;
    if (p.clientId) await clientTaxes(p.clientId);
    const today = todayQc();
    const number = await nextQuoteNumber();
    const id = await db().transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.quotes)
        .values({
          number,
          clientId: p.clientId,
          prospectName: p.clientId ? null : p.prospectName,
          contactName: p.contactName,
          contactEmail: p.contactEmail,
          title: p.title,
          kind: p.kind,
          saleType: p.saleType,
          survey: p.survey,
          preparedBy,
          issuedOn: p.issuedOn ?? today,
          validUntil: p.validUntil ?? new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
          taxes,
          notes: p.notes,
          internalNotes: p.internalNotes,
          createdBy: a.user.id,
        })
        .returning({ id: schema.quotes.id });
      await saveLines(tx, row.id, p.lines);
      return row.id;
    });
    await syncQuoteToPipeline(id, a.user.id);
    const q = await getQuote(id);
    await audit(a.user.id, "quote.created", id, { number: q?.number, clientId: p.clientId, preparedBy });
    return c.json(q, 201);
  })

  /** Save the whole quote: its header and its lines, as the editor shows them. */
  .put("/:id", requirePermission("quotes.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const cur = await getQuote(id);
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (!OPEN.has(cur.status)) throw new HTTPException(409, { message: "quote_locked" });
    const p = await body(c, zQuote);
    needsWho(p);
    await checkProducts(p.lines);
    if (p.clientId) await clientTaxes(p.clientId);
    if (p.preparedById && p.preparedById !== cur.preparedById) await staffMember(p.preparedById);
    await db().transaction(async (tx) => {
      await tx
        .update(schema.quotes)
        .set({
          clientId: p.clientId,
          prospectName: p.clientId ? null : p.prospectName,
          contactName: p.contactName,
          contactEmail: p.contactEmail,
          title: p.title,
          saleType: p.saleType,
          survey: p.survey,
          preparedBy: p.preparedById ?? cur.preparedById,
          issuedOn: p.issuedOn ?? cur.issuedOn,
          validUntil: p.validUntil,
          taxes: p.taxes ?? cur.taxes,
          notes: p.notes,
          internalNotes: p.internalNotes,
          updatedAt: new Date(),
        })
        .where(eq(schema.quotes.id, id));
      await saveLines(tx, id, p.lines);
    });
await audit(a.user.id, "quote.updated", id, { number: cur.number, lines: p.lines.length, ...(p.preparedById && p.preparedById !== cur.preparedById ? { preparedBy: p.preparedById } : {}) });
    await syncQuoteToPipeline(id, a.user.id);
    return c.json(await getQuote(id));
  })

  .post("/:id/status", requirePermission("quotes.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const { status } = await body(c, z.object({ status: z.enum(QUOTE_STATUSES) }));
    const cur = await getQuote(id);
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if ((status === "sent" || status === "accepted") && cur.lineCount === 0) throw new HTTPException(409, { message: "quote_empty" });
    const now = new Date();
    await db()
      .update(schema.quotes)
      .set({
        status,
        sentAt: status === "sent" ? now : status === "draft" ? null : cur.sentAt,
        decidedAt: status === "accepted" || status === "declined" ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.quotes.id, id));
    await audit(a.user.id, "quote.status", id, { number: cur.number, from: cur.status, to: status });
    await syncQuoteToPipeline(id, a.user.id);
    return c.json(await getQuote(id));
  })

  /**
   * The deposit invoice of an accepted quote: a share of the implementation (50 % unless another is
   * chosen), one line per tax treatment, made like any invoice (numbering, taxes of the client, QuickBooks
   * with the item "Dépôt client") and emailed when asked. One per quote — a voided one can be made again.
   */
  .post("/:id/deposit", requirePermission("quotes.manage"), requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ percent: z.number().min(1).max(100).default(50), issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), send: z.boolean().default(true), payOnline: z.boolean().default(true), clientId: zUuid.optional(), lineIds: z.array(zUuid).min(1).max(200).optional() }));
    let q = await getQuote(id);
    if (!q) throw new HTTPException(404, { message: "not_found" });
    if (q.status !== "accepted") throw new HTTPException(409, { message: "quote_not_accepted" });
    // a quote made for a prospect: the CRM client picked in the deposit window becomes the quote's client
    if (!q.clientId && p.clientId) {
      const [cl] = await db().select({ id: schema.clients.id, invoice: schema.clients.invoice }).from(schema.clients).where(eq(schema.clients.id, p.clientId));
      if (!cl) throw new HTTPException(400, { message: "client_unknown" });
      await db().update(schema.quotes).set({ clientId: cl.id, taxes: cl.invoice?.taxes !== false, updatedAt: new Date() }).where(eq(schema.quotes.id, id));
      await audit(a.user.id, "quote.client_set", id, { number: q.number, clientId: cl.id });
      q = (await getQuote(id))!;
    }
    if (!q.clientId) throw new HTTPException(409, { message: "deposit_needs_client" });
    if (q.depositInvoiceId && !q.depositVoided) throw new HTTPException(409, { message: "deposit_exists" });
    // hourly: nothing is billed before the work is done; a bank of hours is paid in full; a fixed price takes the share chosen
    if (q.saleType === "hourly") throw new HTTPException(409, { message: "deposit_not_allowed" });
    const percentX100 = q.saleType === "bank" ? 10_000 : Math.round(p.percent * 100);
    // only the lines ticked (e.g. the equipment); none given: every one-time line
    const onceLines = (q.lines ?? []).filter((l) => !l.optional && recurrenceOf(l) === "once");
    if (p.lineIds?.some((lid) => !onceLines.some((l) => l.id === lid))) throw new HTTPException(400, { message: "deposit_lines_invalid" });
    const lineIds = p.lineIds && p.lineIds.length < onceLines.length ? [...new Set(p.lineIds)] : null;
    const dep = depositOf(q.lines ?? [], percentX100, lineIds);
    if (dep.subtotalCents <= 0) throw new HTTPException(409, { message: "deposit_nothing" });
    const lang = (await billingSettings()).template.language;
    const pct = (percentX100 / 100).toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { maximumFractionDigits: 2 });
    const on = lineIds ? onceLines.filter((l) => lineIds.includes(l.id)).map((l) => l.description).join(", ") : "";
    const text = (lang === "en" ? `Deposit of ${pct}% — Quote ${q.number}${q.title ? `: ${q.title}` : ""}${on ? ` — on: ${on}` : ""}` : `Dépôt de ${pct} % — Soumission ${q.number}${q.title ? ` : ${q.title}` : ""}${on ? ` — sur : ${on}` : ""}`).slice(0, 480);
    const parts = [
      { cents: dep.taxableCents, taxable: true },
      { cents: dep.exemptCents, taxable: false },
    ].filter((x) => x.cents > 0);
    const lines = parts.map((x, i) => ({
      description: (parts.length > 1 && !x.taxable ? `${text} (${lang === "en" ? "not taxable" : "non taxable"})` : text).slice(0, 500),
      quantity: 1,
      unitPriceCents: x.cents,
      taxable: x.taxable,
      sourceId: `deposit:${q.id}:${i}:${crypto.randomUUID()}`,
    }));
    let made: Awaited<ReturnType<typeof quickInvoice>>;
    try {
      made = await quickInvoice(a.user.id, { clientId: q.clientId, issuedOn: p.issuedOn, termsDays: 0, notes: lang === "en" ? `Deposit on quote ${q.number}.` : `Dépôt sur la soumission ${q.number}.`, lines });
    } catch (e) {
      if (e instanceof DraftError) throw new HTTPException(409, { message: e.message });
      throw e;
    }
    // the Stripe pay link for the deposit (its balance), in the email and the PDF, whatever the client's usual choice
    await db().update(schema.clientInvoices).set({ payOnline: p.payOnline }).where(eq(schema.clientInvoices.id, made.id));
    await db().update(schema.quotes).set({ depositInvoiceId: made.id, depositPercentX100: percentX100, depositLineIds: lineIds, updatedAt: new Date() }).where(eq(schema.quotes.id, id));
    await audit(a.user.id, "quote.deposit_invoiced", id, { number: q.number, invoice: made.number, percent: p.percent, totalCents: made.totalCents });
    await autoSync("invoices", made.id);
    let emailed: string | null = null;
    let mailError: string | null = null;
    if (p.send) {
      try {
        emailed = (await sendInvoiceMail(made.id, "sent", a.user.id)).to;
      } catch (e) {
        mailError = e instanceof Error ? e.message : "mail_failed";
      }
    }
    return c.json({ invoice: { id: made.id, number: made.number, totalCents: made.totalCents }, payLink: p.payOnline && (await stripePayReady()), emailed, mailError, quote: await getQuote(id) }, 201);
  })

  /** A copy as a new draft (same client and lines), for a similar quote. */
  .post("/:id/duplicate", requirePermission("quotes.manage"), async (c) => {
    const a = auth(c);
    const cur = await getQuote(zUuid.parse(c.req.param("id")));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const number = await nextQuoteNumber();
    const id = await db().transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.quotes)
        .values({
          number,
          clientId: cur.clientId,
          prospectName: cur.prospectName,
          contactName: cur.contactName,
          contactEmail: cur.contactEmail,
          title: cur.title,
          kind: cur.kind,
          saleType: cur.saleType,
          survey: cur.survey ?? {},
          preparedBy: a.user.id,
          issuedOn: todayQc(),
          validUntil: new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
          taxes: cur.taxes,
          notes: cur.notes,
          internalNotes: cur.internalNotes,
          createdBy: a.user.id,
        })
        .returning({ id: schema.quotes.id });
      await saveLines(
        tx,
        row.id,
        (cur.lines ?? []).map(({ productId, serviceId, sku, description, details, quantityX100, unitPriceCents, unitCostCents, discountX100, taxable, optional, recurrence }) => ({ productId, serviceId, sku, description, details, quantityX100, unitPriceCents, unitCostCents, discountX100, taxable, optional, recurrence: recurrenceOf({ recurrence }) })),
      );
      return row.id;
    });
    await syncQuoteToPipeline(id, a.user.id);
    const q = await getQuote(id);
    await audit(a.user.id, "quote.duplicated", id, { from: cur.number, number: q?.number });
    return c.json(q, 201);
  })

  .delete("/:id", requirePermission("quotes.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const cur = await getQuote(id);
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.status === "accepted") throw new HTTPException(409, { message: "quote_locked" });
    await db().delete(schema.quotes).where(eq(schema.quotes.id, id));
    await audit(a.user.id, "quote.deleted", id, { number: cur.number });
    return c.json({ ok: true });
  })

  /** A line typed on the spot becomes an inventory product (and the line is tied to it): next time it is one search away. */
  .post("/:id/lines/:lineId/to-inventory", requirePermission("quotes.manage"), requirePermission("store.manage"), async (c) => {
    const a = auth(c);
    const quoteId = zUuid.parse(c.req.param("id"));
    const lineId = zUuid.parse(c.req.param("lineId"));
    const p = await body(c, z.object({ sku: z.string().trim().max(60).nullable().default(null), category: z.string().trim().max(120).nullable().default(null) }));
    const [line] = await db().select().from(schema.quoteLines).where(eq(schema.quoteLines.id, lineId));
    if (!line || line.quoteId !== quoteId) throw new HTTPException(404, { message: "not_found" });
    if (line.productId) throw new HTTPException(409, { message: "already_in_inventory" });
    const sku = p.sku || line.sku || null;
    if (sku) {
      const [dup] = await db().select({ id: schema.storeProducts.id }).from(schema.storeProducts).where(eq(schema.storeProducts.sku, sku));
      if (dup) throw new HTTPException(409, { message: "sku_taken" });
    }
    const [product] = await db()
      .insert(schema.storeProducts)
      .values({ sku, name: line.description.slice(0, 200), priceCents: Number(line.unitPriceCents), costCents: Number(line.unitCostCents), category: p.category || null })
      .returning();
    await db().update(schema.quoteLines).set({ productId: product.id, sku }).where(eq(schema.quoteLines.id, lineId));
    await audit(a.user.id, "quote.line_to_inventory", product.id, { quoteId, sku });
    return c.json({ productId: product.id, sku }, 201);
  });
