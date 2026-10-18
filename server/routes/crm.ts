import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, revokeUserSessions, type AppEnv } from "../lib/auth.ts";
import { hashPassword, temporaryPassword } from "../lib/crypto.ts";
import { sendPasswordLink } from "../lib/passwordLinks.ts";
import { audit } from "../lib/audit.ts";
import { body, zEmail, zOptText, zUuid } from "../lib/validate.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { crmState, descendantsOf, ensureCrm, rememberCompany, rememberContact, syncCrm } from "../lib/crm.ts";
import { lookup, run } from "./tickets.ts";
import { pushInvoice } from "../lib/quickbooks.ts";
import { quickbooksHttp } from "./billing.ts";

/**
 * CRM (crm.view): the clients, from the portal's own copy kept in step with
 * Autotask. Changes go to Autotask first while it is linked (so the next
 * sync does not undo them), then into the copy.
 */
type Client = typeof schema.clients.$inferSelect;

const zText = (max: number) => zOptText(max);

async function clientOr404(id: string): Promise<Client> {
  const [c] = await db().select().from(schema.clients).where(eq(schema.clients.id, zUuid.parse(id)));
  if (!c) throw new HTTPException(404, { message: "not_found" });
  return c;
}

/** Open tickets per source client id. */
async function openTicketsByCompany(): Promise<Map<number, number>> {
  const src = await ticketSource();
  const [all, o] = await run(() => Promise.all([src.list(), src.options()]));
  const L = lookup(o);
  const out = new Map<number, number>();
  for (const t of all) if (L.statusKind(t.status) !== "complete") out.set(t.company.id, (out.get(t.company.id) ?? 0) + 1);
  return out;
}

const view = (c: Client) => ({
  id: c.id,
  name: c.name,
  code: c.code,
  email: c.email,
  phone: c.phone,
  address: c.address,
  city: c.city,
  province: c.province,
  postalCode: c.postalCode,
  website: c.website,
  notes: c.notes,
  active: c.active,
  autotaskId: c.autotaskId,
  parentId: c.parentId,
  syncedAt: c.syncedAt,
});

export const crmRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** Where the data comes from (shown to every staff member, in the top bar). */
  .get("/status", async (c) => {
    const src = await ticketSource();
    const s = await crmState();
    return c.json({ mode: src.demo ? "sample" : "autotask", lastSync: s?.at ?? null, ok: s?.ok ?? null, error: s?.error ?? null, counts: s?.counts ?? null, every: 15 });
  })
  .post("/sync", requirePermission("crm.edit"), async (c) => {
    const a = auth(c);
    const s = await syncCrm();
    await audit(a.user.id, "crm.synced", null, { ok: s.ok, ...s.counts });
    return c.json(s);
  })

  .use(requirePermission("crm.view"))

  .get("/clients", async (c) => {
    await ensureCrm();
    const d = db();
    const [rows, contacts, open] = await Promise.all([
      d.select().from(schema.clients).orderBy(asc(schema.clients.name)),
      d.select({ clientId: schema.clientContacts.clientId }).from(schema.clientContacts).where(eq(schema.clientContacts.active, true)),
      openTicketsByCompany().catch(() => new Map<number, number>()),
    ]);
    const nContacts = new Map<string, number>();
    for (const x of contacts) nContacts.set(x.clientId, (nContacts.get(x.clientId) ?? 0) + 1);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return c.json(
      rows.map((r) => ({
        ...view(r),
        parentName: r.parentId ? (names.get(r.parentId) ?? null) : null,
        children: rows.filter((x) => x.parentId === r.id).length,
        contacts: nContacts.get(r.id) ?? 0,
        openTickets: r.autotaskId != null ? (open.get(r.autotaskId) ?? 0) : 0,
      })),
    );
  })

  /** A new client: in Autotask first while it is linked, then in the copy. */
  .post("/clients", requirePermission("crm.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().min(7).max(40) }));
    const d = db();
    const all = await d.select({ name: schema.clients.name }).from(schema.clients);
    if (all.some((x) => x.name.trim().toLowerCase() === p.name.toLowerCase())) throw new HTTPException(409, { message: "company_exists" });
    const src = await ticketSource();
    const company = await run(() => src.addCompany(p, a));
    const id = await rememberCompany({ ...company, phone: p.phone });
    await audit(a.user.id, "crm.client_created", id, { name: p.name });
    return c.json(view(await clientOr404(id)), 201);
  })

  .get("/clients/:id", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const d = db();
    const [parent] = client.parentId ? await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, client.parentId)) : [];
    const children = await d.select({ id: schema.clients.id, name: schema.clients.name, active: schema.clients.active }).from(schema.clients).where(eq(schema.clients.parentId, client.id)).orderBy(asc(schema.clients.name));
    const a = auth(c);
    return c.json({ ...view(client), parent: parent ?? null, children, invoice: a.permissions.includes("crm.billing") ? client.invoice : null });
  })

  .patch("/clients/:id", requirePermission("crm.edit"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(2).max(100).optional(),
        phone: zText(40),
        email: z.union([zEmail, z.literal("")]).transform((v) => v || null).nullable().optional(),
        address: zText(200),
        city: zText(100),
        province: zText(60),
        postalCode: zText(20),
        website: zText(200),
        notes: zText(4000),
        code: zText(40),
        parentId: zUuid.nullable().optional(),
      }),
    );
    const d = db();
    let parentAt: number | null | undefined;
    if (p.parentId !== undefined) {
      if (p.parentId) {
        // not itself, nor one of its own children (a loop)
        if (p.parentId === client.id || (await descendantsOf(client.id)).has(p.parentId)) throw new HTTPException(400, { message: "parent_loop" });
        const parent = await clientOr404(p.parentId);
        parentAt = parent.autotaskId;
      } else parentAt = null;
    }
    if (p.name && p.name.toLowerCase() !== client.name.toLowerCase()) {
      const all = await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients);
      if (all.some((x) => x.id !== client.id && x.name.trim().toLowerCase() === p.name!.toLowerCase())) throw new HTTPException(409, { message: "company_exists" });
    }
    // Autotask first (the next sync would bring its version back otherwise)
    if (client.autotaskId != null) {
      const src = await ticketSource();
      const synced = { name: p.name, phone: p.phone, address: p.address, city: p.city, province: p.province, postalCode: p.postalCode, website: p.website, parentId: parentAt };
      const patch = Object.fromEntries(Object.entries(synced).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length) await run(() => src.updateCompany(client.autotaskId!, patch, a));
    }
    const [row] = await d
      .update(schema.clients)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.clients.id, client.id))
      .returning();
    await audit(a.user.id, "crm.client_updated", client.id, { fields: Object.keys(p) });
    return c.json(view(row));
  })

  /** Invoice settings (portal only, for Accounting). */
  .put("/clients/:id/invoice", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        billingEmail: z.union([zEmail, z.literal("")]).optional(),
        termsDays: z.number().int().min(0).max(120).optional(),
        delivery: z.enum(["email", "mail"]).optional(),
        taxes: z.boolean().optional(),
        taxNumber: z.string().trim().max(60).optional(),
        poRequired: z.boolean().optional(),
        hourlyRate: z.number().min(0).max(10_000).nullable().optional(),
        notes: z.string().trim().max(2000).optional(),
      }),
    );
    const [row] = await db().update(schema.clients).set({ invoice: p, updatedAt: new Date() }).where(eq(schema.clients.id, client.id)).returning();
    await audit(a.user.id, "crm.invoice_updated", client.id);
    return c.json(row.invoice);
  })

  // ── contacts
  .get("/clients/:id/contacts", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const rows = await db()
      .select({ c: schema.clientContacts, u: { active: schema.users.active, lastLoginAt: schema.users.lastLoginAt, mustChangePassword: schema.users.mustChangePassword, roleSlug: schema.roles.slug } })
      .from(schema.clientContacts)
      .leftJoin(schema.users, eq(schema.users.id, schema.clientContacts.userId))
      .leftJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(eq(schema.clientContacts.clientId, client.id))
      .orderBy(asc(schema.clientContacts.lastName), asc(schema.clientContacts.firstName));
    return c.json(
      rows
        .map(({ c: x, u }) => ({ ...x, portal: u?.active ? { lastLoginAt: u.lastLoginAt, pending: u.mustChangePassword, role: u.roleSlug } : null }))
        .sort((x, y) => Number(y.active) - Number(x.active)),
    );
  })
  .post("/clients/:id/contacts", requirePermission("crm.edit"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        email: z.union([zEmail, z.literal("")]).transform((v) => v || null).optional(),
        phone: zText(40),
        mobile: zText(40),
        title: zText(100),
      }),
    );
    const fields = { firstName: p.firstName, lastName: p.lastName, email: p.email ?? null, phone: p.phone ?? null, mobile: p.mobile ?? null, title: p.title ?? null };
    if (client.autotaskId != null) {
      const src = await ticketSource();
      const made = await run(() => src.addContact(client.autotaskId!, fields, a));
      await rememberContact(client.autotaskId, { id: made.id, ...fields });
    } else {
      await db().insert(schema.clientContacts).values({ clientId: client.id, ...fields });
    }
    await audit(a.user.id, "crm.contact_created", client.id, { name: `${p.firstName} ${p.lastName}` });
    const [row] = await db()
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, client.id), eq(schema.clientContacts.firstName, p.firstName), eq(schema.clientContacts.lastName, p.lastName)));
    return c.json(row, 201);
  })
  .patch("/clients/:id/contacts/:cid", requirePermission("crm.edit"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const [contact] = await db()
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.id, zUuid.parse(c.req.param("cid"))), eq(schema.clientContacts.clientId, client.id)));
    if (!contact) throw new HTTPException(404, { message: "not_found" });
    const p = await body(
      c,
      z.object({
        firstName: z.string().trim().min(1).max(60).optional(),
        lastName: z.string().trim().min(1).max(60).optional(),
        email: z.union([zEmail, z.literal("")]).transform((v) => v || null).nullable().optional(),
        phone: zText(40),
        mobile: zText(40),
        title: zText(100),
        active: z.boolean().optional(),
      }),
    );
    if (contact.userId && p.email && p.email.toLowerCase() !== (contact.email ?? "").toLowerCase()) {
      const [taken] = await db().select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${p.email.toLowerCase()}`);
      if (taken && taken.id !== contact.userId) throw new HTTPException(409, { message: "email_taken" });
    }
    if (contact.autotaskId) {
      const src = await ticketSource();
      await run(() => src.updateContact(contact.autotaskId!, p, a));
    }
    if (contact.userId) {
      if (p.email) await db().update(schema.users).set({ email: p.email, updatedAt: new Date() }).where(eq(schema.users.id, contact.userId));
      if (p.active === false) {
        await db().update(schema.users).set({ active: false, updatedAt: new Date() }).where(eq(schema.users.id, contact.userId));
        await revokeUserSessions(contact.userId);
      }
    }
    const [row] = await db().update(schema.clientContacts).set({ ...p, updatedAt: new Date() }).where(eq(schema.clientContacts.id, contact.id)).returning();
    await audit(a.user.id, "crm.contact_updated", client.id, { contact: contact.id, fields: Object.keys(p) });
    return c.json(row);
  })

  /**
   * Client portal access for a contact (none by default). Given: an account
   * with their email and a random password to change at first sign-in; they
   * get the welcome email (a link to choose their password — the password
   * itself is never emailed). Removed: the account is turned off, its
   * sessions end.
   */
  .put("/clients/:id/contacts/:cid/portal", requirePermission("admin.clients"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const d = db();
    const [contact] = await d
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.id, zUuid.parse(c.req.param("cid"))), eq(schema.clientContacts.clientId, client.id)));
    if (!contact) throw new HTTPException(404, { message: "not_found" });
    const p = await body(c, z.object({ enabled: z.boolean(), role: z.enum(["client-user", "client-admin"]).default("client-user") }));

    if (!p.enabled) {
      if (contact.userId) {
        await d.update(schema.users).set({ active: false, updatedAt: new Date() }).where(eq(schema.users.id, contact.userId));
        await revokeUserSessions(contact.userId);
        await audit(a.user.id, "crm.portal_access_removed", contact.userId, { contact: contact.id, clientId: client.id });
      }
      return c.json({ enabled: false });
    }

    if (!client.active || !contact.active) throw new HTTPException(409, { message: "portal_inactive" });
    const email = contact.email?.trim().toLowerCase();
    if (!email) throw new HTTPException(400, { message: "portal_no_email" });
    const [role] = await d.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.slug, p.role));
    let [user] = contact.userId ? await d.select().from(schema.users).where(eq(schema.users.id, contact.userId)) : [];
    if (!user) {
      const [same] = await d.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
      if (same) {
        // an account of this same client that no contact holds yet: theirs; anything else is someone else's
        const [held] = await d.select({ id: schema.clientContacts.id }).from(schema.clientContacts).where(eq(schema.clientContacts.userId, same.id));
        if (same.kind !== "client" || same.clientId !== client.id || held) throw new HTTPException(409, { message: "email_taken" });
        user = same;
      }
    }
    const name = `${contact.firstName} ${contact.lastName}`.trim() || email;
    const passwordHash = await hashPassword(temporaryPassword());
    if (user) {
      [user] = await d
        .update(schema.users)
        .set({ active: true, name, roleId: role?.id ?? user.roleId, passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id))
        .returning();
      await revokeUserSessions(user.id);
    } else {
      [user] = await d
        .insert(schema.users)
        .values({ email, name, kind: "client", clientId: client.id, roleId: role?.id ?? null, title: contact.title, phone: contact.mobile ?? contact.phone, passwordHash, mustChangePassword: true })
        .returning();
    }
    await d.update(schema.clientContacts).set({ userId: user.id, updatedAt: new Date() }).where(eq(schema.clientContacts.id, contact.id));
    const welcomeSent = await sendPasswordLink(user, "welcome", c);
    await audit(a.user.id, "crm.portal_access_given", user.id, { contact: contact.id, clientId: client.id, role: p.role, welcomeSent });
    return c.json({ enabled: true, welcomeSent });
  })

  // ── contracts (from Autotask, read only for now)
  .get("/clients/:id/contracts", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const rows = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.clientId, client.id)).orderBy(asc(schema.clientContracts.name));
    return c.json(rows.sort((x, y) => Number(y.active) - Number(x.active) || Number(y.isDefault) - Number(x.isDefault)));
  })

  // ── invoices of the client (and of its child companies, on demand): accounting.view
  .get("/clients/:id/invoices", requirePermission("accounting.view"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const ids = [client.id];
    if (c.req.query("children") === "1") ids.push(...(await descendantsOf(client.id)));
    const d = db();
    const names = new Map((await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, ids))).map((r) => [r.id, r.name]));
    const rows = await d.select().from(schema.clientInvoices).where(inArray(schema.clientInvoices.clientId, ids)).orderBy(desc(schema.clientInvoices.issuedOn), desc(schema.clientInvoices.number));
    const payments = rows.length
      ? await d
          .select({ p: schema.invoicePayments, by: schema.users.name })
          .from(schema.invoicePayments)
          .leftJoin(schema.users, eq(schema.users.id, schema.invoicePayments.createdBy))
          .where(inArray(schema.invoicePayments.invoiceId, rows.map((r) => r.id)))
          .orderBy(asc(schema.invoicePayments.paidOn), asc(schema.invoicePayments.createdAt))
      : [];
    const lines = new Map<string, (typeof schema.invoiceLines.$inferSelect)[]>();
    const portal = rows.filter((r) => r.source === "portal").map((r) => r.id);
    if (portal.length) {
      for (const l of await d.select().from(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, portal)).orderBy(asc(schema.invoiceLines.position))) {
        lines.set(l.invoiceId, [...(lines.get(l.invoiceId) ?? []), l]);
      }
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const items = rows.map((v) => {
      const mine = payments.filter((x) => x.p.invoiceId === v.id);
      const received = mine.reduce((s, x) => s + x.p.amountCents, 0);
      // marked paid in the source with no payment here: paid in full
      const paidCents = v.paidOn && received < v.totalCents ? v.totalCents : received;
      const balanceCents = v.voided ? 0 : Math.max(0, v.totalCents - paidCents);
      const late = !v.voided && balanceCents > 0 && Boolean(v.dueOn && v.dueOn < today);
      const status = v.voided ? "voided" : balanceCents === 0 ? "paid" : paidCents > 0 ? "partial" : late ? "overdue" : "due";
      return {
        id: v.id,
        number: v.number,
        company: names.get(v.clientId) ?? "",
        issuedOn: v.issuedOn,
        dueOn: v.dueOn,
        totalCents: v.totalCents,
        taxCents: v.taxCents,
        paidCents,
        balanceCents,
        paidOn: v.paidOn ?? (balanceCents === 0 && mine.length ? mine[mine.length - 1].p.paidOn : null),
        status,
        late,
        daysLate: late ? Math.round((Date.parse(today) - Date.parse(v.dueOn!)) / 86_400_000) : 0,
        source: v.source,
        lines: (lines.get(v.id) ?? []).map((l) => ({ id: l.id, kind: l.kind, description: l.description, quantity: l.quantityX100 / 100, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents, taxable: l.taxable })),
        quickbooks: v.quickbooksId || v.quickbooksError ? { id: v.quickbooksId, syncedAt: v.quickbooksSyncedAt, error: v.quickbooksError } : null,
        payments: mine.map((x) => ({ id: x.p.id, amountCents: x.p.amountCents, paidOn: x.p.paidOn, method: x.p.method, reference: x.p.reference, note: x.p.note, source: x.p.source, by: x.by })),
      };
    });
    const sum = (f: (x: (typeof items)[number]) => boolean, k: "balanceCents" | "paidCents") => items.filter(f).reduce((s, x) => s + x[k], 0);
    return c.json({
      summary: {
        dueCents: sum((x) => x.balanceCents > 0, "balanceCents"),
        overdueCents: sum((x) => x.late, "balanceCents"),
        overdueCount: items.filter((x) => x.late).length,
        partialCount: items.filter((x) => x.status === "partial").length,
        paidYearCents: sum((x) => x.issuedOn >= yearAgo, "paidCents"),
      },
      items,
    });
  })

  /** A payment received (all or part of the balance): accounting.manage. */
  .post("/invoices/:iid/payments", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, zUuid.parse(c.req.param("iid"))));
    if (!inv) throw new HTTPException(404, { message: "not_found" });
    if (inv.voided) throw new HTTPException(409, { message: "invoice_voided" });
    const p = await body(
      c,
      z.object({
        amountCents: z.number().int().min(1).max(100_000_000),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        method: z.enum(["cheque", "transfer", "card", "cash", "stripe", "other"]),
        reference: zText(100),
        note: zText(500),
      }),
    );
    const received = (await db().select({ a: schema.invoicePayments.amountCents }).from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, inv.id))).reduce((s, x) => s + x.a, 0);
    // never more than what is left to pay
    if (received + p.amountCents > inv.totalCents) throw new HTTPException(400, { message: "payment_too_much" });
    const [row] = await db()
      .insert(schema.invoicePayments)
      .values({ invoiceId: inv.id, amountCents: p.amountCents, paidOn: p.paidOn, method: p.method, reference: p.reference ?? null, note: p.note ?? null, createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "billing.payment_recorded", inv.id, { number: inv.number, amountCents: p.amountCents, method: p.method });
    return c.json(row, 201);
  })
  /** Send the invoice to QuickBooks (or its changes): by hand for now. */
  .post("/invoices/:iid/quickbooks", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("iid"));
    try {
      const r = await pushInvoice(id);
      await audit(a.user.id, "billing.quickbooks.invoice_sent", id, r);
      return c.json(r);
    } catch (e) {
      return quickbooksHttp(e);
    }
  })
  .delete("/invoices/:iid/payments/:pid", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const [row] = await db()
      .delete(schema.invoicePayments)
      .where(and(eq(schema.invoicePayments.id, zUuid.parse(c.req.param("pid"))), eq(schema.invoicePayments.invoiceId, zUuid.parse(c.req.param("iid"))), eq(schema.invoicePayments.source, "portal")))
      .returning();
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "billing.payment_removed", row.invoiceId, { amountCents: row.amountCents });
    return c.json({ ok: true });
  })

  // ── tickets of the client (and of its child companies, on demand)
  .get("/clients/:id/tickets", requirePermission("tickets.view"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const ids = [client.id];
    if (c.req.query("children") === "1") ids.push(...(await descendantsOf(client.id)));
    const rows = await db().select({ id: schema.clients.id, autotaskId: schema.clients.autotaskId, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, ids));
    const companies = new Set(rows.map((r) => r.autotaskId).filter((x): x is number => x != null));
    const src = await ticketSource();
    const [all, o] = await run(() => Promise.all([src.list(), src.options()]));
    const L = lookup(o);
    const open = (t: NTicket) => L.statusKind(t.status) !== "complete";
    const mine = all.filter((t) => companies.has(t.company.id));
    const closed = mine.filter((t) => !open(t)).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const list = [...mine.filter(open).sort((x, y) => x.dueAt.localeCompare(y.dueAt)), ...closed.slice(0, 25)];
    return c.json({
      open: mine.length - closed.length,
      closed: closed.length,
      items: list.map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        company: t.company.name,
        contact: t.contact,
        statusLabel: L.statusLabel(t.status),
        statusKind: L.statusKind(t.status),
        priorityLabel: L.priorityLabel(t.priority),
        priorityKind: L.priorityKind(t.priority),
        assignee: t.assignee?.name ?? null,
        dueAt: t.dueAt,
        updatedAt: t.updatedAt,
      })),
    });
  });
