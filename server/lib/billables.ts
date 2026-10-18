import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { billingSettings, formatInvoiceNumber, saveBillingSettings, type BillingSettings } from "./billing.ts";
import { ensureCrm } from "./crm.ts";
import { ticketSource, type BillableKind } from "./ticketSource.ts";

/**
 * Work to bill (Accounting › Approbation): copied from Autotask while it is
 * linked — only what is not posted there yet, so nothing is billed twice —
 * then approved (or excluded) in the portal, then posted: one new invoice per
 * client, its lines, GST and QST, the next invoice number.
 */
export const BILLABLE_KINDS: BillableKind[] = ["labour", "charge", "expense", "contract", "milestone"];
const STATE_KEY = "autotask.billables";
export type BillablesState = { at: string | null; counts: Partial<Record<BillableKind, number>>; errors: Partial<Record<BillableKind, string>>; skipped: number };

export async function billablesState(): Promise<BillablesState> {
  const [row] = await db().select().from(schema.syncState).where(eq(schema.syncState.key, STATE_KEY));
  return (row?.data as BillablesState | undefined) ?? { at: null, counts: {}, errors: {}, skipped: 0 };
}

const amountOf = (quantityX100: number, unitPriceCents: number) => Math.round((quantityX100 * unitPriceCents) / 100);

let running: Promise<BillablesState> | null = null;

/** Copy the work to bill from the source. Items changed or decided in the portal are left as they are. */
export function syncBillables(): Promise<BillablesState> {
  running ??= (async () => {
    await ensureCrm();
    const s = await billingSettings();
    const src = await ticketSource();
    const data = await src.billables(s.autotask.itemsSince);
    const d = db();
    const now = new Date();
    const clients = new Map(
      (await d.select({ id: schema.clients.id, at: schema.clients.autotaskId, invoice: schema.clients.invoice }).from(schema.clients)).filter((c) => c.at != null).map((c) => [c.at!, c]),
    );
    const existing = new Map((await d.select().from(schema.billingItems).where(eq(schema.billingItems.source, "autotask"))).map((x) => [x.sourceId!, x]));
    const counts: BillablesState["counts"] = {};
    let skipped = 0;
    const seen = new Set<string>();
    for (const it of data.items) {
      const client = clients.get(it.companyId);
      if (!client) {
        skipped++;
        continue;
      }
      seen.add(it.id);
      counts[it.kind] = (counts[it.kind] ?? 0) + 1;
      // no rate in the source: the client's hourly rate, else the usual one
      const rate = it.unitPriceCents ?? (it.kind === "labour" ? Math.round((client.invoice?.hourlyRate ?? s.rates.hourly) * 100) : 0);
      const quantityX100 = Math.round(it.quantity * 100);
      const values = {
        clientId: client.id,
        kind: it.kind,
        date: it.date,
        dateEnd: it.dateEnd ?? null,
        description: it.description,
        ticketNumber: it.ticketNumber ?? null,
        contractName: it.contractName ?? null,
        resourceName: it.resourceName ?? null,
        quantityX100,
        unitPriceCents: rate,
        amountCents: amountOf(quantityX100, rate),
        taxable: it.taxable,
        syncedAt: now,
      };
      const hit = existing.get(it.id);
      if (!hit) await d.insert(schema.billingItems).values({ ...values, source: "autotask", sourceId: it.id });
      else if (hit.status === "pending" && !hit.edited) await d.update(schema.billingItems).set({ ...values, updatedAt: now }).where(eq(schema.billingItems.id, hit.id));
    }
    // gone from the source (posted or removed in Autotask): pending, untouched ones go too — only for kinds read without error
    const gone = [...existing.values()].filter((x) => !seen.has(x.sourceId!) && x.status === "pending" && !x.edited && !data.errors[x.kind as BillableKind]).map((x) => x.id);
    if (gone.length) await d.delete(schema.billingItems).where(inArray(schema.billingItems.id, gone));
    const state: BillablesState = { at: now.toISOString(), counts, errors: data.errors, skipped };
    await d
      .insert(schema.syncState)
      .values({ key: STATE_KEY, data: state })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { data: state, updatedAt: now } });
    return state;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** The items of a kind (and status), with their client. */
export async function listBillables(kind: BillableKind | null, status: string | null) {
  const rows = await db()
    .select({ b: schema.billingItems, client: schema.clients.name, invoice: schema.clientInvoices.number })
    .from(schema.billingItems)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.billingItems.clientId))
    .leftJoin(schema.clientInvoices, eq(schema.clientInvoices.id, schema.billingItems.invoiceId))
    .where(and(kind ? eq(schema.billingItems.kind, kind) : undefined, status ? eq(schema.billingItems.status, status) : undefined))
    .orderBy(asc(schema.clients.name), asc(schema.billingItems.date));
  return rows.map(({ b, client, invoice }) => ({ ...b, clientName: client, invoiceNumber: invoice }));
}

/** How many items wait, by kind and status (for the tab counts). */
export async function billableCounts() {
  const rows = await db()
    .select({ kind: schema.billingItems.kind, status: schema.billingItems.status, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${schema.billingItems.amountCents}), 0)::bigint` })
    .from(schema.billingItems)
    .groupBy(schema.billingItems.kind, schema.billingItems.status);
  return rows.map((r) => ({ ...r, cents: Number(r.cents) }));
}

/** Approve, send back, exclude or bring back items (never posted ones). */
export async function setBillableStatus(actorId: string, ids: string[], status: "pending" | "approved" | "excluded") {
  if (!ids.length) return 0;
  const rows = await db()
    .update(schema.billingItems)
    .set({ status, approvedBy: status === "approved" ? actorId : null, approvedAt: status === "approved" ? new Date() : null, updatedAt: new Date() })
    .where(and(inArray(schema.billingItems.id, ids), sql`${schema.billingItems.status} <> 'posted'`))
    .returning({ id: schema.billingItems.id });
  return rows.length;
}

/** Change an item before it is posted (the next syncs keep the change). */
export async function editBillable(id: string, p: { quantity?: number; unitPriceCents?: number; description?: string; taxable?: boolean }) {
  const [cur] = await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, id));
  if (!cur || cur.status === "posted") return null;
  const quantityX100 = p.quantity !== undefined ? Math.round(p.quantity * 100) : cur.quantityX100;
  const unitPriceCents = p.unitPriceCents ?? cur.unitPriceCents;
  const [row] = await db()
    .update(schema.billingItems)
    .set({ quantityX100, unitPriceCents, amountCents: amountOf(quantityX100, unitPriceCents), description: p.description ?? cur.description, taxable: p.taxable ?? cur.taxable, edited: true, updatedAt: new Date() })
    .where(eq(schema.billingItems.id, id))
    .returning();
  return row;
}

// ── posting: approved items → one invoice per client ──
const ACCOUNT_OF: Record<BillableKind, keyof BillingSettings["accounts"]> = { labour: "labour", charge: "charges", expense: "charges", contract: "contracts", milestone: "contracts" };

function taxesOf(s: BillingSettings, taxableCents: number, exempt: boolean) {
  if (exempt) return { gst: 0, qst: 0 };
  return { gst: Math.round((taxableCents * s.taxes.gstRate) / 100), qst: Math.round((taxableCents * s.taxes.qstRate) / 100) };
}

/** What posting would make: per client, the lines, subtotal, taxes and total. */
export async function postPreview(clientIds?: string[]) {
  const s = await billingSettings();
  const rows = await db()
    .select({ b: schema.billingItems, client: schema.clients })
    .from(schema.billingItems)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.billingItems.clientId))
    .where(and(eq(schema.billingItems.status, "approved"), clientIds?.length ? inArray(schema.billingItems.clientId, clientIds) : undefined))
    .orderBy(asc(schema.clients.name), asc(schema.billingItems.date));
  const groups = new Map<string, { client: typeof schema.clients.$inferSelect; items: (typeof schema.billingItems.$inferSelect)[] }>();
  for (const r of rows) {
    const g = groups.get(r.client.id) ?? { client: r.client, items: [] };
    g.items.push(r.b);
    groups.set(r.client.id, g);
  }
  return [...groups.values()].map((g) => {
    const subtotal = g.items.reduce((x, i) => x + i.amountCents, 0);
    const taxable = g.items.filter((i) => i.taxable).reduce((x, i) => x + i.amountCents, 0);
    const exempt = g.client.invoice?.taxes === false;
    const { gst, qst } = taxesOf(s, taxable, exempt);
    return {
      client: { id: g.client.id, name: g.client.name },
      items: g.items,
      count: g.items.length,
      subtotalCents: subtotal,
      gstCents: gst,
      qstCents: qst,
      totalCents: subtotal + gst + qst,
      exempt,
      termsDays: g.client.invoice?.termsDays ?? s.template.termsDays,
    };
  });
}

let numbering: Promise<unknown> = Promise.resolve();

/** The next invoice number: the setting, after the highest number already used (the Autotask ones included). */
async function nextNumber(actorId: string): Promise<string> {
  const s = await billingSettings();
  const all = await db().select({ number: schema.clientInvoices.number }).from(schema.clientInvoices);
  const used = new Set(all.map((x) => x.number));
  const highest = all.reduce((m, x) => {
    const digits = x.number.startsWith(s.numbering.prefix) ? x.number.slice(s.numbering.prefix.length) : "";
    return /^\d+$/.test(digits) ? Math.max(m, Number(digits)) : m;
  }, 0);
  let value = Math.max(s.numbering.next, highest + 1);
  while (used.has(formatInvoiceNumber(s.numbering, value))) value++;
  await saveBillingSettings(actorId, { numbering: { next: value + 1 } });
  return formatInvoiceNumber(s.numbering, value);
}

/** Post the approved items: one invoice per client (all clients, or the ones given). */
export async function postInvoices(actorId: string, clientIds?: string[]) {
  const run = numbering.then(async () => {
    const s = await billingSettings();
    const groups = await postPreview(clientIds);
    const d = db();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const made: { id: string; number: string; client: string; totalCents: number }[] = [];
    for (const g of groups) {
      const number = await nextNumber(actorId);
      const due = new Date(`${today}T12:00:00`);
      due.setDate(due.getDate() + g.termsDays);
      const [inv] = await d
        .insert(schema.clientInvoices)
        .values({
          clientId: g.client.id,
          number,
          issuedOn: today,
          dueOn: due.toISOString().slice(0, 10),
          totalCents: g.totalCents,
          taxCents: g.gstCents + g.qstCents,
          source: "portal",
        })
        .returning();
      await d.insert(schema.invoiceLines).values(
        g.items.map((i, n) => ({
          invoiceId: inv.id,
          billingItemId: i.id,
          kind: i.kind,
          description: [i.ticketNumber && `[${i.ticketNumber}]`, i.description, i.resourceName && `(${i.resourceName})`].filter(Boolean).join(" "),
          quantityX100: i.quantityX100,
          unitPriceCents: i.unitPriceCents,
          amountCents: i.amountCents,
          taxable: i.taxable,
          ledgerAccountId: s.accounts[ACCOUNT_OF[i.kind as BillableKind]] ?? null,
          position: n,
        })),
      );
      await d
        .update(schema.billingItems)
        .set({ status: "posted", invoiceId: inv.id, postedAt: new Date(), updatedAt: new Date() })
        .where(inArray(schema.billingItems.id, g.items.map((i) => i.id)));
      made.push({ id: inv.id, number, client: g.client.name, totalCents: g.totalCents });
    }
    return made;
  });
  numbering = run.catch(() => undefined);
  return run;
}

/** The lines of an invoice made in the portal. */
export async function linesOf(invoiceId: string) {
  return db().select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).orderBy(asc(schema.invoiceLines.position));
}
