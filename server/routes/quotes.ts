import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { productsWithStock } from "../lib/store.ts";
import { ticketSource } from "../lib/ticketSource.ts";
import { queues } from "../lib/queues.ts";
import { run } from "./tickets.ts";
import { lineAmount, quoteTotals } from "../../shared/quotes.ts";
import { getQuote, listQuotes, nextQuoteNumber, saveLines, todayQc } from "../lib/quotes.ts";
import { QUOTE_KINDS, QUOTE_STATUSES } from "../../shared/quotes.ts";

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zCents = z.number().int().min(0).max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().default(null);

const zLine = z.object({
  productId: zUuid.nullable().default(null),
  sku: z.string().trim().max(60).transform((s) => s || null).nullable().default(null),
  description: z.string().trim().min(1).max(2000),
  quantityX100: z.number().int().min(1).max(100_000_000).default(100),
  unitPriceCents: zCents.default(0),
  unitCostCents: zCents.default(0),
  taxable: z.boolean().default(true),
  optional: z.boolean().default(false),
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
async function checkProducts(lines: { productId: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return;
  const rows = await db().select({ id: schema.storeProducts.id }).from(schema.storeProducts).where(inArray(schema.storeProducts.id, ids));
  const known = new Set(rows.map((r) => r.id));
  if (ids.some((i) => !known.has(i))) throw new HTTPException(400, { message: "product_not_found" });
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
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
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
      .filter((p) => !q || `${p.sku ?? ""} ${p.name} ${p.manufacturer ?? ""} ${p.category ?? ""}`.toLowerCase().includes(q))
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
    return c.json(await getQuote(id));
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
        (cur.lines ?? []).map(({ productId, sku, description, quantityX100, unitPriceCents, unitCostCents, taxable, optional }) => ({ productId, sku, description, quantityX100, unitPriceCents, unitCostCents, taxable, optional })),
      );
      return row.id;
    });
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

  /**
   * Quote → project: a ticket in the Projets queue for the client (what the quote says is in its
   * description), and a point to discuss at the weekly meeting. Done once per quote.
   */
  .post("/:id/to-project", requirePermission("quotes.manage"), requirePermission("tickets.edit"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const q = await getQuote(id);
    if (!q) throw new HTTPException(404, { message: "not_found" });
    if (q.projectTicketId) throw new HTTPException(409, { message: "already_project" });
    if (!q.clientId) throw new HTTPException(409, { message: "project_needs_client" });
    if (!q.lines?.length) throw new HTTPException(409, { message: "quote_empty" });
    const [client] = await db().select({ name: schema.clients.name, companyId: schema.clients.autotaskId }).from(schema.clients).where(eq(schema.clients.id, q.clientId));
    if (!client) throw new HTTPException(409, { message: "project_needs_client" });

    const src = await ticketSource();
    // the ticket source's company: tied by id, else the one with the same name
    const companyId = client.companyId ?? (await run(() => src.companies())).find((x) => x.name.trim().toLowerCase() === client.name.trim().toLowerCase())?.id;
    if (companyId == null) throw new HTTPException(409, { message: "project_needs_client" });
    const o = await run(() => src.options());
    const priority = (o.priorities.find((x) => x.kind === "medium") ?? o.priorities[0])?.value;
    if (!priority) throw new HTTPException(409, { message: "project_no_priority" });
    // the technician who prepared it leads the project, when the ticket source knows them
    const people = await run(() => src.technicians());
    const lead = q.preparedById ? people.find((p) => p.id === q.preparedById) : undefined;

    const t = quoteTotals(q.lines ?? [], q.taxes, q.rates!);
    const fmt = (cents: number) => new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
    const bullets = (q.lines ?? []).map((l) => `- ${l.quantityX100 / 100} × ${l.description}${l.sku ? ` (${l.sku})` : ""}${l.optional ? " [option]" : ""}: ${fmt(lineAmount(l))}`);
    const name = q.title || q.number;
    const description = [
      `Projet issu de la soumission ${q.number}${q.title ? ` « ${q.title} »` : ""} pour ${client.name}.`,
      q.preparedBy ? `Préparée par ${q.preparedBy}.` : "",
      "",
      ...bullets,
      "",
      `Total: ${fmt(t.totalCents)} (sous-total ${fmt(t.subtotalCents)}${q.taxes ? ", taxes en sus" : ", sans taxes"})`,
      q.notes ? `\nNotes pour le client:\n${q.notes}` : "",
      q.internalNotes ? `\nNotes internes:\n${q.internalNotes}` : "",
    ]
      .filter((x, i, all) => x !== "" || all[i - 1] !== "")
      .join("\n")
      .slice(0, 8000);
    const due = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const ticketId = await run(() => src.create({ title: `Projet: ${name}`.slice(0, 250), description, companyId, contactId: null, priority, queue: "", assigneeId: lead?.id ?? null, dueDate: due }, a));
    const queue = (await queues()).find((x) => x.key === "projects") ?? (await queues()).find((x) => /projet|project/i.test(x.name));
    if (queue) {
      await db()
        .insert(schema.ticketMeta)
        .values({ ticketId, queue: queue.key, updatedBy: a.user.id })
        .onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { queue: queue.key, updatedBy: a.user.id, updatedAt: new Date() } });
    }
    const made = await run(() => src.get(ticketId));
    const number = made?.number ?? String(ticketId);

    const [point] = await db()
      .insert(schema.meetingPoints)
      .values({
        text: `Projet ${client.name}: ${name} (${number})`.slice(0, 2000),
        details: [`Soumission ${q.number}, total ${fmt(t.totalCents)}${q.preparedBy ? `, préparée par ${q.preparedBy}` : ""}.`, `Billet de projet ${number}.`, "", ...bullets].join("\n").slice(0, 8000),
        authorId: a.user.id,
        authorName: a.user.name,
      })
      .returning({ id: schema.meetingPoints.id });
    await db().update(schema.quotes).set({ projectTicketId: ticketId, projectTicketNumber: number, meetingPointId: point.id, projectAt: new Date(), updatedAt: new Date() }).where(eq(schema.quotes.id, id));
    await audit(a.user.id, "quote.to_project", id, { number: q.number, ticketId, ticketNumber: number, queue: queue?.key ?? null });
    return c.json({ ticketId, ticketNumber: number, meetingPointId: point.id }, 201);
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
