import { pushSoon } from "../lib/qbSync.ts";
import { ItcloudError, setServiceContract, unmappedServices } from "../lib/itcloud.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, revokeUserSessions, type AppEnv } from "../lib/auth.ts";
import { hashPassword, temporaryPassword } from "../lib/crypto.ts";
import { forgetPasswordLinks, sendPasswordLink } from "../lib/passwordLinks.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zEmail, zOptText, zUuid } from "../lib/validate.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { crmState, descendantsOf, ensureCrm, rememberCompany, rememberContact, syncCrm } from "../lib/crm.ts";
import { lookup, run } from "./tickets.ts";
import { pushInvoice } from "../lib/quickbooks.ts";
import { DraftError, recalcInvoiceTaxes, taxesByLine } from "../lib/billables.ts";
import { applyToLines, contractsIn, runningLinesOf } from "../lib/servicePrices.ts";
import { InvoiceMailError, invoicePdfFor, sendInvoiceMail, sendStatement, sendStatements, statementOf, statementTargets } from "../lib/invoiceMail.ts";
import { applyAutoApprove } from "../lib/billables.ts";
import { BILLING_MODES, KIND_MODE, contractTypes, usedHoursOf, type ContractKind } from "../lib/contracts.ts";
import { prorata, type ServicePeriod } from "../../shared/prorata.ts";
import { chargesOn, contractCharges, type ChargeLine } from "../../shared/contractCharges.ts";
import { contractCharged, contractEventsOf, recordContractEvent, syncMonthlyRate } from "../lib/contractEvents.ts";
import { todayQc } from "../lib/timesheets.ts";
import { billingSettings } from "../lib/billing.ts";
import { quickbooksHttp } from "./billing.ts";

/**
 * CRM (crm.view): the clients, contacts and contracts of the portal.
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
  classKey: c.classKey,
  syncedAt: c.syncedAt,
});

type ContractRow = typeof schema.clientContracts.$inferSelect;
async function contractOr404(clientId: string, id: string) {
  const [k] = await db()
    .select()
    .from(schema.clientContracts)
    .where(and(eq(schema.clientContracts.id, zUuid.parse(id)), eq(schema.clientContracts.clientId, clientId)));
  if (!k) throw new HTTPException(404, { message: "not_found" });
  return k;
}
/** A service on a contract, with the prorata worked out on the contract's term (none while it has no term). */
function serviceLine(r: typeof schema.contractServices.$inferSelect, k: ContractRow) {
  const plan = k.startDate && k.endDate ? prorata({ period: (r.kind === "recurring_yearly" ? "yearly" : "monthly") as ServicePeriod, priceCents: r.priceCents * r.quantity, addedOn: r.addedOn, start: k.startDate, end: k.endDate }) : "dates";
  return { ...r, firstCents: typeof plan === "string" ? null : plan.firstCents, totalCents: typeof plan === "string" ? null : plan.totalCents, periods: typeof plan === "string" ? [] : plan.periods };
}

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
type ServiceRow = typeof schema.contractServices.$inferSelect;
const chargeLines = (rows: ServiceRow[]): ChargeLine[] => rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind === "recurring_yearly" ? "recurring_yearly" : "recurring", priceCents: r.priceCents, quantity: r.quantity, addedOn: r.addedOn }));
/** What a contract charges (per full period, over its term) and what comes next, from its services */
function summaryOf(k: ContractRow, rows: ServiceRow[], today: string) {
  const ch = contractCharges({ startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: k.billingPeriod === "yearly" ? "yearly" : "monthly" }, chargeLines(rows));
  const on = chargesOn(ch, today, k.billedThrough);
  return {
    billedThrough: k.billedThrough ?? null,
    billedCents: on.billedCents,
    revenueCents: ch.revenueCents,
    perPeriodCents: ch.perPeriodCents,
    yearlyExtraCents: ch.yearlyExtraCents,
    endsOn: ch.endsOn,
    dueCents: on.dueCents,
    next: on.next ? { date: on.next.date, amountCents: on.next.amountCents, prorated: on.next.prorated } : null,
  };
}
/** Lines of a contract still to approve or approved, dated up to `through` (included): "already invoiced", never billed here */
async function excludeBilledThrough(contractId: string, through: string) {
  const rows = await db()
    .update(schema.billingItems)
    .set({ status: "excluded", excludedReason: "billed", approvedBy: null, approvedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.billingItems.contractId, contractId), inArray(schema.billingItems.status, ["pending", "approved"]), lte(schema.billingItems.date, through)))
    .returning({ id: schema.billingItems.id });
  return rows.length;
}
const servicesOf = (contractId: string) => db().select().from(schema.contractServices).where(eq(schema.contractServices.contractId, contractId)).orderBy(asc(schema.contractServices.addedOn), asc(schema.contractServices.name));

export const crmRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** Where the data comes from (shown to every staff member, in the top bar). */
  .get("/status", async (c) => {
    const src = await ticketSource();
    const s = await crmState();
    return c.json({ mode: src.demo ? "sample" : "local", lastSync: s?.at ?? null, ok: s?.ok ?? null, error: s?.error ?? null, counts: s?.counts ?? null, every: 15 });
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

  /** A new client. */
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
        classKey: z.string().max(40).nullable().optional(),
      }),
    );
    const d = db();
    if (p.classKey && !(await d.select().from(schema.clientClasses).where(eq(schema.clientClasses.key, p.classKey)))[0]) throw new HTTPException(400, { message: "invalid_value" });
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
    // the source (the portal's database, or the sample data) first
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
    // a client tied to a QuickBooks customer: the change goes there too
    void pushSoon("clients", client.id);
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
        payOnline: z.boolean().nullable().optional(),
        hourlyRate: z.number().min(0).max(10_000).nullable().optional(),
        notes: z.string().trim().max(2000).optional(),
        autoApprove: z.array(z.enum(["labour", "charge", "contract", "milestone", "project"])).optional(),
      }),
    );
    const before = client.invoice?.autoApprove ?? [];
    if ((p.autoApprove ?? []).some((k) => !before.includes(k)) && !a.permissions.includes("accounting.manage")) throw new HTTPException(403, { message: "accounting_manage_only" });
    const [row] = await db().update(schema.clients).set({ invoice: { ...client.invoice, ...p }, updatedAt: new Date() }).where(eq(schema.clients.id, client.id)).returning();
    if (p.billingEmail !== undefined) void pushSoon("clients", client.id);
    // what waits already follows the new rule
    const approved = p.autoApprove?.length ? await applyAutoApprove(client.id) : 0;
    await audit(a.user.id, "crm.invoice_updated", client.id, { autoApprove: p.autoApprove, approved });
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
    const loginChange = Boolean(contact.userId) && ((p.email !== undefined && (p.email ?? "").toLowerCase() !== (contact.email ?? "").toLowerCase()) || p.active === false);
    if (loginChange && !a.permissions.includes("admin.clients")) throw new HTTPException(403, { message: "portal_admin_only" });
    if (contact.userId && p.email && p.email.toLowerCase() !== (contact.email ?? "").toLowerCase()) {
      const [taken] = await db().select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${p.email.toLowerCase()}`);
      if (taken && taken.id !== contact.userId) throw new HTTPException(409, { message: "email_taken" });
    }
    if (contact.autotaskId) {
      const src = await ticketSource();
      await run(() => src.updateContact(contact.autotaskId!, p, a));
    }
    if (contact.userId) {
      if (p.email && p.email.toLowerCase() !== (contact.email ?? "").toLowerCase()) {
        await db().update(schema.users).set({ email: p.email, updatedAt: new Date() }).where(eq(schema.users.id, contact.userId));
        await forgetPasswordLinks(contact.userId);
        await revokeUserSessions(contact.userId);
      }
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

  // ── contract types (Admin › Types de contrats), for the contract forms
  /** What a new contract starts with: the usual hourly rate of Admin › Facturation (the contract takes it, and can change it). */
  .get("/contract-defaults", requirePermission("crm.billing"), async (c) => c.json({ hourlyRateCents: Math.round((await billingSettings()).rates.hourly * 100) }))
  .get("/contract-types", async (c) => c.json((await contractTypes()).filter((t) => t.active).map((t) => ({ key: t.key, name: t.name, kind: t.kind }))))

  // ── contracts
  /**
   * A contract made by hand (crm.billing): from a contract type, whose kind sets how it is billed. A recurring services
   * contract has no figure: it is charged monthly or yearly from its services, which can be added as it is made.
   */
  .post("/clients/:id/contracts", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const p = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        typeKey: z.string().trim().min(1).max(60),
        // a contract has a term: both days are needed (the prorata of its services runs on them)
        startDate: zDay,
        endDate: zDay,
        /** How a recurring services contract is charged */
        billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
        /** Already invoiced in the old system up to this day (included) */
        billedThrough: zDay.nullable().optional(),
        /** The client's default support contract (the one tickets are logged on unless another is picked) */
        supportDefault: z.boolean().optional(),
        /** Dollars */
        hourlyRate: z.number().min(0).max(100_000).nullable().optional(),
        monthlyRate: z.number().min(0).max(1_000_000).nullable().optional(),
        fixedPrice: z.number().min(0).max(10_000_000).nullable().optional(),
        bankedHours: z.number().min(0).max(100_000).nullable().optional(),
        /** Recurring services added as the contract is made */
        services: z
          .array(z.object({ serviceId: zUuid, addedOn: zDay, quantity: z.number().int().min(1).max(100_000).default(1), priceCents: z.number().int().min(0).max(100_000_000).optional() }))
          .max(100)
          .default([]),
      }),
    );
    const type = (await contractTypes()).find((t) => t.key === p.typeKey && t.active);
    if (!type) throw new HTTPException(400, { message: "invalid_type" });
    if (p.endDate < p.startDate) throw new HTTPException(400, { message: "contract_dates" });
    const cents = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
    const mode = KIND_MODE[type.kind as ContractKind];
    // the services, checked before anything is written
    const catalog = p.services.length ? await db().select().from(schema.services).where(inArray(schema.services.id, [...new Set(p.services.map((s) => s.serviceId))])) : [];
    const lines = p.services.map((s) => {
      const svc = catalog.find((x) => x.id === s.serviceId);
      if (!svc || !svc.active) throw new HTTPException(404, { message: "not_found" });
      if (svc.kind !== "recurring" && svc.kind !== "recurring_yearly") throw new HTTPException(400, { message: "service_not_recurring" });
      const plan = prorata({ period: svc.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents: s.priceCents ?? svc.priceCents, addedOn: s.addedOn, start: p.startDate, end: p.endDate });
      if (typeof plan === "string") throw new HTTPException(400, { message: plan === "outside" ? "service_outside_term" : "contract_dates" });
      return { svc, s };
    });
    const row = await db().transaction(async (tx) => {
      if (p.supportDefault) await tx.update(schema.clientContracts).set({ supportDefault: false }).where(eq(schema.clientContracts.clientId, client.id));
      const [k] = await tx
        .insert(schema.clientContracts)
        .values({
          clientId: client.id,
          autotaskId: `local-${crypto.randomUUID()}`,
          name: p.name,
          type: type.name,
          typeKey: type.key,
          billingMode: mode,
          billingPeriod: p.billingPeriod,
          billedThrough: p.billedThrough ?? null,
          startDate: p.startDate,
          endDate: p.endDate,
          hourlyRateCents: cents(p.hourlyRate),
          supportDefault: Boolean(p.supportDefault),
          // a recurring services contract has no typed charge: it comes from its services
          monthlyRateCents: type.kind === "recurring" ? null : cents(p.monthlyRate),
          fixedPriceCents: cents(p.fixedPrice),
          bankedHoursX100: p.bankedHours == null ? null : Math.round(p.bankedHours * 100),
          syncedAt: new Date(),
        })
        .returning();
      for (const { svc, s } of lines) {
        await tx.insert(schema.contractServices).values({ contractId: k.id, serviceId: svc.id, name: svc.name, kind: svc.kind, priceCents: s.priceCents ?? svc.priceCents, costCents: svc.costCents, addedOn: s.addedOn, quantity: s.quantity, createdBy: a.user.id });
      }
      return k;
    });
    await audit(a.user.id, "crm.contract_created", row.id, { name: p.name, type: type.key, services: lines.length });
    await recordContractEvent(row.id, "created", { name: p.name, type: type.name, startDate: p.startDate, endDate: p.endDate, billingPeriod: p.billingPeriod }, { userId: a.user.id });
    for (const { svc, s } of lines) await recordContractEvent(row.id, "service_added", { name: svc.name, quantity: s.quantity, priceCents: s.priceCents ?? svc.priceCents, addedOn: s.addedOn, kind: svc.kind }, { userId: a.user.id });
    await syncMonthlyRate(row.id);
    return c.json(row, 201);
  })
  // ── the recurring services of a contract, with their prorata
  /** The catalogue to pick from: the active recurring services (monthly or yearly). */
  .get("/services-catalog", async (c) => {
    const rows = await db().select().from(schema.services).where(and(eq(schema.services.active, true), inArray(schema.services.kind, ["recurring", "recurring_yearly"]))).orderBy(asc(schema.services.name));
    return c.json(rows.map((x) => ({ id: x.id, name: x.name, kind: x.kind, priceCents: x.priceCents, costCents: x.costCents })));
  })
  .get("/clients/:id/contracts/:kid/services", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const rows = await db().select().from(schema.contractServices).where(eq(schema.contractServices.contractId, k.id)).orderBy(asc(schema.contractServices.addedOn), asc(schema.contractServices.name));
    return c.json(rows.map((r) => serviceLine(r, k)));
  })
  /** Adds a service to a contract from a day: its price and quantity, then the prorata of the first period and of the term is worked out (crm.billing). */
  .post("/clients/:id/contracts/:kid/services", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const p = await body(c, z.object({ serviceId: zUuid, addedOn: zDay, quantity: z.number().int().min(1).max(100_000).default(1), priceCents: z.number().int().min(0).max(100_000_000).optional() }));
    const [svc] = await db().select().from(schema.services).where(eq(schema.services.id, p.serviceId));
    if (!svc || !svc.active) throw new HTTPException(404, { message: "not_found" });
    if (svc.kind !== "recurring" && svc.kind !== "recurring_yearly") throw new HTTPException(400, { message: "service_not_recurring" });
    if (!k.startDate || !k.endDate) throw new HTTPException(400, { message: "contract_no_term" });
    const plan = prorata({ period: svc.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents: (p.priceCents ?? svc.priceCents) * p.quantity, addedOn: p.addedOn, start: k.startDate, end: k.endDate });
    if (typeof plan === "string") throw new HTTPException(400, { message: plan === "outside" ? "service_outside_term" : "contract_dates" });
    const [row] = await db()
      .insert(schema.contractServices)
      .values({ contractId: k.id, serviceId: svc.id, name: svc.name, kind: svc.kind, priceCents: p.priceCents ?? svc.priceCents, costCents: svc.costCents, addedOn: p.addedOn, quantity: p.quantity, createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "crm.contract_service_added", k.id, { service: svc.name, addedOn: p.addedOn, firstCents: plan.firstCents, totalCents: plan.totalCents });
    await recordContractEvent(k.id, "service_added", { name: svc.name, quantity: p.quantity, priceCents: row.priceCents, addedOn: p.addedOn, kind: svc.kind, firstCents: plan.firstCents }, { userId: a.user.id });
    await syncMonthlyRate(k.id);
    return c.json(serviceLine(row, k), 201);
  })
  /** Changes a line of a contract: its quantity, its price (per unit) or the day it starts. A line kept by a vendor follows the vendor. */
  .patch("/clients/:id/contracts/:kid/services/:sid", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const sid = zUuid.parse(c.req.param("sid"));
    // `scope` (asked when the price changes): "line" = this contract only; "service" = the service itself and every running contract that has it
    const { scope, ...p } = await body(c, z.object({ quantity: z.number().int().min(1).max(100_000).optional(), priceCents: z.number().int().min(0).max(100_000_000).optional(), addedOn: zDay.optional(), scope: z.enum(["line", "service"]).optional() }));
    const [cur] = await db().select().from(schema.contractServices).where(and(eq(schema.contractServices.id, sid), eq(schema.contractServices.contractId, k.id)));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (cur.source) throw new HTTPException(409, { message: "service_from_vendor" });
    const priceChanges = p.priceCents !== undefined && p.priceCents !== cur.priceCents && Boolean(cur.serviceId);
    const others = priceChanges && cur.serviceId ? await runningLinesOf(cur.serviceId, cur.id) : [];
    if (priceChanges && !scope) throw new HTTPException(409, { message: "price_scope_required", cause: [{ path: "contracts", message: String(contractsIn(others)) }] });
    if (!k.startDate || !k.endDate) throw new HTTPException(400, { message: "contract_no_term" });
    const next = { quantity: p.quantity ?? cur.quantity, priceCents: p.priceCents ?? cur.priceCents, addedOn: p.addedOn ?? cur.addedOn };
    const plan = prorata({ period: cur.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents: next.priceCents * next.quantity, addedOn: next.addedOn, start: k.startDate, end: k.endDate });
    if (typeof plan === "string") throw new HTTPException(400, { message: plan === "outside" ? "service_outside_term" : "contract_dates" });
    const [row] = await db().update(schema.contractServices).set(next).where(eq(schema.contractServices.id, sid)).returning();
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of ["quantity", "priceCents", "addedOn"] as const) if (cur[key] !== next[key]) changes[key] = [cur[key], next[key]];
    if (Object.keys(changes).length) {
      await audit(a.user.id, "crm.contract_service_changed", k.id, { service: cur.name, ...changes });
      await recordContractEvent(k.id, "service_changed", { name: cur.name, changes }, { userId: a.user.id });
      await syncMonthlyRate(k.id);
    }
    // the price goes to the service and to the other running contracts too
    if (priceChanges && scope === "service" && cur.serviceId) {
      await db().update(schema.services).set({ priceCents: next.priceCents, updatedAt: new Date() }).where(eq(schema.services.id, cur.serviceId));
      await applyToLines(others, { priceCents: next.priceCents }, { userId: a.user.id });
      await audit(a.user.id, "crm.contract_service_price_to_service", k.id, { service: cur.name, priceCents: next.priceCents, contracts: contractsIn(others) });
    }
    return c.json(serviceLine(row, k));
  })
  // ── ITCloud services of the client that wait for a contract: map them to this one ──
  .get("/clients/:id/contracts/:kid/itcloud-services", requirePermission("crm.billing"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    await contractOr404(client.id, c.req.param("kid"));
    return c.json(await unmappedServices(client.id));
  })
  .post("/clients/:id/contracts/:kid/itcloud-services", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const p = await body(c, z.object({ serviceId: z.number().int().positive() }));
    if (!k.active) throw new HTTPException(409, { message: "contract_inactive" });
    try {
      const r = await setServiceContract(p.serviceId, k.id, client.id);
      if (!r.line) throw new HTTPException(409, { message: "itcloud_service_not_placeable" });
      await audit(a.user.id, "crm.contract_itcloud_service_mapped", k.id, { itcloudService: p.serviceId, service: r.line.name });
      return c.json(serviceLine(r.line, k), 201);
    } catch (e) {
      if (e instanceof ItcloudError) throw new HTTPException(404, { message: e.code });
      throw e;
    }
  })
  .delete("/clients/:id/contracts/:kid/services/:sid", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const sid = zUuid.parse(c.req.param("sid"));
    const [line] = await db().select().from(schema.contractServices).where(and(eq(schema.contractServices.id, sid), eq(schema.contractServices.contractId, k.id)));
    if (!line) throw new HTTPException(404, { message: "not_found" });
    // a line kept by a vendor (ITCloud) follows the vendor: it leaves when the service ends there
    if (line.source) throw new HTTPException(409, { message: "service_from_vendor" });
    await db().delete(schema.contractServices).where(eq(schema.contractServices.id, sid));
    await audit(a.user.id, "crm.contract_service_removed", k.id, { service: line.name });
    await recordContractEvent(k.id, "service_removed", { name: line.name, quantity: line.quantity, priceCents: line.priceCents, addedOn: line.addedOn, kind: line.kind }, { userId: a.user.id });
    await syncMonthlyRate(k.id);
    return c.json({ ok: true });
  })
  /** One contract with its services and the activity summary (the contract window) */
  .get("/clients/:id/contracts/:kid", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const rows = await servicesOf(k.id);
    const today = todayQc();
    const used = await usedHoursOf([k]);
    const usual = Math.round((await billingSettings()).rates.hourly * 100);
    return c.json({ ...k, usedHours: used.get(k.id) ?? 0, usualRateCents: usual, services: rows.map((r) => serviceLine(r, k)), summary: summaryOf(k, rows, today), charged: await contractCharged(k.id, today) });
  })
  /** What happened on a contract: added, changed, removed, stopped (newest first) */
  .get("/clients/:id/contracts/:kid/activity", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    return c.json(await contractEventsOf(k.id));
  })
  /**
   * Deleting a contract: one that has no charges is removed; one on which billing started (work to bill, time, or
   * a service whose first day has come) is only stopped: made inactive from today, its services charged up to then,
   * so that everything already done stays on record.
   */
  .delete("/clients/:id/contracts/:kid", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const k = await contractOr404(client.id, c.req.param("kid"));
    const today = todayQc();
    const charged = await contractCharged(k.id, today);
    if (!charged.has) {
      await db().delete(schema.clientContracts).where(eq(schema.clientContracts.id, k.id));
      await audit(a.user.id, "crm.contract_deleted", k.id, { name: k.name });
      return c.json({ deleted: true, deactivated: false });
    }
    const stop = k.startDate && today < k.startDate ? k.startDate : today;
    if (k.active) {
      await db().update(schema.clientContracts).set({ active: false, endedOn: stop, supportDefault: false, updatedAt: new Date() }).where(eq(schema.clientContracts.id, k.id));
      await recordContractEvent(k.id, "stopped", { on: stop, billingItems: charged.billingItems, timeEntries: charged.timeEntries, servicesStarted: charged.servicesStarted }, { userId: a.user.id });
    }
    await audit(a.user.id, "crm.contract_stopped", k.id, { name: k.name, on: stop });
    return c.json({ deleted: false, deactivated: true, endedOn: k.active ? stop : k.endedOn });
  })
  .get("/clients/:id/contracts", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const rows = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.clientId, client.id)).orderBy(asc(schema.clientContracts.name));
    // the client's default support contract: the one picked here, else the source's, else its only active one
    const active = rows.filter((k) => k.active);
    const chosen = active.find((k) => k.supportDefault) ?? active.find((k) => k.isDefault) ?? (active.length === 1 ? active[0] : null);
    const usual = Math.round((await billingSettings()).rates.hourly * 100);
    const used = await usedHoursOf(rows);
    const allLines = rows.length ? await db().select().from(schema.contractServices).where(inArray(schema.contractServices.contractId, rows.map((k) => k.id))) : [];
    const today = todayQc();
    return c.json(
      rows
        .map((k) => ({ ...k, isSupportDefault: chosen?.id === k.id, usualRateCents: usual, usedHours: used.get(k.id) ?? 0, serviceCount: allLines.filter((l) => l.contractId === k.id).length, summary: summaryOf(k, allLines.filter((l) => l.contractId === k.id), today) }))
        .sort((x, y) => Number(y.active) - Number(x.active) || Number(y.isSupportDefault) - Number(x.isSupportDefault) || x.name.localeCompare(y.name)),
    );
  })

  // ── invoices of the client (and of its child companies, on demand): accounting.view
  .get("/clients/:id/invoices", requirePermission("accounting.view"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const ids = [client.id];
    if (c.req.query("children") === "1") ids.push(...(await descendantsOf(client.id)));
    const d = db();
    const names = new Map((await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, ids))).map((r) => [r.id, r.name]));
    const rows = await d.select().from(schema.clientInvoices).where(inArray(schema.clientInvoices.clientId, ids)).orderBy(desc(schema.clientInvoices.issuedOn), desc(schema.clientInvoices.number));
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const items = await invoiceViews(rows, names, { lines: true });
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

  /**
   * Every invoice (Accounting › Factures › Toutes les factures), newest first,
   * with filters: status (due, overdue, partial, paid, voided; "open" = still
   * to pay), client, issue dates, number or PO, sent by email or not,
   * QuickBooks (synced, not synced, error), source.
   */
  .get("/invoices", requirePermission("accounting.view"), async (c) => {
    const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = z
      .object({
        status: z.enum(["open", "due", "overdue", "partial", "paid", "voided"]).optional(),
        clientId: zUuid.optional(),
        from: zDay.optional(),
        to: zDay.optional(),
        q: z.string().trim().max(100).optional(),
        emailed: z.enum(["yes", "no"]).optional(),
        quickbooks: z.enum(["synced", "unsynced", "error"]).optional(),
        source: z.enum(["portal", "autotask", "quickbooks"]).optional(),
      })
      .safeParse(Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => [k, v[0] || undefined])));
    if (!q.success) throw new HTTPException(400, { message: "invalid_filter" });
    const f = q.data;
    const v = schema.clientInvoices;
    // the number or PO contains the text (% and _ taken literally)
    const words = (f.q ?? "").replace(/[\\%_]/g, "\\$&");
    const rows = await db()
      .select()
      .from(v)
      .where(
        and(
          f.clientId ? eq(v.clientId, f.clientId) : undefined,
          f.from ? gte(v.issuedOn, f.from) : undefined,
          f.to ? lte(v.issuedOn, f.to) : undefined,
          words ? or(ilike(v.number, `%${words}%`), ilike(v.poNumber, `%${words}%`)) : undefined,
          f.emailed === "yes" ? isNotNull(v.emailedAt) : f.emailed === "no" ? isNull(v.emailedAt) : undefined,
          f.quickbooks === "synced" ? isNotNull(v.quickbooksId) : f.quickbooks === "unsynced" ? isNull(v.quickbooksId) : f.quickbooks === "error" ? isNotNull(v.quickbooksError) : undefined,
          f.source ? eq(v.source, f.source) : undefined,
        ),
      )
      .orderBy(desc(v.issuedOn), desc(v.number))
      .limit(2000);
    const clients = await db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(asc(schema.clients.name));
    const names = new Map(clients.map((x) => [x.id, x.name]));
    const all = await invoiceViews(rows, names, { lines: false });
    // the status needs the payments: filtered once known
    const items = all.filter((x) => !f.status || (f.status === "open" ? x.balanceCents > 0 : x.status === f.status));
    const sum = (k: "totalCents" | "balanceCents" | "paidCents", w: (x: (typeof items)[number]) => boolean = () => true) => items.filter(w).reduce((t, x) => t + x[k], 0);
    return c.json({
      summary: {
        count: items.length,
        totalCents: sum("totalCents", (x) => x.status !== "voided"),
        paidCents: sum("paidCents"),
        dueCents: sum("balanceCents"),
        overdueCents: sum("balanceCents", (x) => x.late),
        overdueCount: items.filter((x) => x.late).length,
      },
      // the clients that have invoices (for the client filter)
      clients: [...new Set((await db().selectDistinct({ id: v.clientId }).from(v)).map((r) => r.id))].map((id) => ({ id, name: names.get(id) ?? "" })).sort((a, b) => a.name.localeCompare(b.name)),
      items: items.map((x) => ({ ...x, clientId: rows.find((r) => r.id === x.id)!.clientId })),
    });
  })
  /** Sent to the client by email, or not (marked by hand for now): accounting.manage. */
  .post("/invoices/:iid/emailed", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ emailed: z.boolean() }));
    const [row] = await db()
      .update(schema.clientInvoices)
      .set({ emailedAt: p.emailed ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.clientInvoices.id, zUuid.parse(c.req.param("iid"))))
      .returning({ id: schema.clientInvoices.id, number: schema.clientInvoices.number, emailedAt: schema.clientInvoices.emailedAt });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, p.emailed ? "billing.invoice_emailed" : "billing.invoice_not_emailed", row.id, { number: row.number });
    return c.json(row);
  })

  /** The invoice as a PDF, shown in the preview window (or opened / downloaded): accounting.view */
  .get("/invoices/:iid/pdf", requirePermission("accounting.view"), async (c) => {
    try {
      const pdf = await invoicePdfFor(zUuid.parse(c.req.param("iid")));
      if (!pdf) throw new HTTPException(500, { message: "pdf_failed" });
      const download = c.req.query("download") === "1";
      return new Response(new Uint8Array(pdf.content), { headers: { "content-type": "application/pdf", "content-disposition": `${download ? "attachment" : "inline"}; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
    } catch (e) {
      return mailHttp(e);
    }
  })
  /** Put an invoice on the line-by-line taxes (the way QuickBooks rounds them), and send it to QuickBooks again */
  .post("/invoices/:iid/taxes", requirePermission("accounting.manage"), async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("iid"));
    try {
      const r = await recalcInvoiceTaxes(id);
      await audit(a.user.id, "billing.invoice_taxes_recalculated", id, r);
      const [inv] = await db().select({ qb: schema.clientInvoices.quickbooksId }).from(schema.clientInvoices).where(eq(schema.clientInvoices.id, id));
      const sent = inv?.qb ? await pushInvoice(id).catch(() => null) : null;
      return c.json({ ...r, sentToQuickBooks: Boolean(sent) });
    } catch (e) {
      if (e instanceof DraftError) throw new HTTPException(409, { message: e.message });
      return mailHttp(e);
    }
  })
  // ── emails: an invoice, a reminder, an account statement (one client, some, or all that owe something)
  .post("/invoices/:iid/mail", requirePermission("accounting.manage"), async (c) => {
    const p = await body(c, z.object({ kind: z.enum(["sent", "reminder"]) }));
    if (!rateLimit(`invoice-mail:${auth(c).user.id}`, 60, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    try {
      return c.json(await sendInvoiceMail(zUuid.parse(c.req.param("iid")), p.kind, auth(c).user.id));
    } catch (e) {
      return mailHttp(e);
    }
  })
  .get("/clients/:id/statement", requirePermission("accounting.view"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    return c.json(await statementOf(client.id));
  })
  .post("/clients/:id/statement/send", requirePermission("accounting.manage"), async (c) => {
    const client = await clientOr404(c.req.param("id"));
    if (!rateLimit(`statement-mail:${auth(c).user.id}`, 30, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    try {
      return c.json(await sendStatement(client.id, auth(c).user.id));
    } catch (e) {
      return mailHttp(e);
    }
  })
  .get("/statements/targets", requirePermission("accounting.view"), async (c) => c.json(await statementTargets()))
  .post("/statements/send", requirePermission("accounting.manage"), async (c) => {
    const p = await body(c, z.object({ clientIds: z.array(zUuid).min(1).max(1000).optional() }));
    if (!rateLimit(`statements-mail:${auth(c).user.id}`, 5, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const results = await sendStatements(p.clientIds ?? null, auth(c).user.id);
    return c.json({ results, sent: results.filter((r) => r.status === "sent").length });
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

  /**
   * A contract's billing (crm.billing): how its support is billed (hourly, monthly, per ticket, never),
   * its rates, whether it is the client's default support contract, and whether its work is approved
   * automatically when imported.
   */
  .patch("/clients/:id/contracts/:kid", requirePermission("crm.billing"), async (c) => {
    const a = auth(c);
    const client = await clientOr404(c.req.param("id"));
    const zRate = z.number().min(0).max(100_000).nullable().optional();
    const p = await body(
      c,
      z.object({
        autoApprove: z.boolean().optional(),
        billingMode: z.enum(BILLING_MODES).optional(),
        /** Dollars; null: the usual hourly rate of Admin › Facturation applies */
        hourlyRate: zRate,
        monthlyRate: zRate,
        ticketRate: zRate,
        supportDefault: z.literal(true).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        typeKey: z.string().trim().min(1).max(60).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        fixedPrice: z.number().min(0).max(10_000_000).nullable().optional(),
        bankedHours: z.number().min(0).max(100_000).nullable().optional(),
        billingPeriod: z.enum(["monthly", "yearly"]).optional(),
        billedThrough: zDay.nullable().optional(),
        active: z.boolean().optional(),
      }),
    );
    const before = await contractOr404(client.id, c.req.param("kid"));
    const type = p.typeKey ? (await contractTypes()).find((t) => t.key === p.typeKey) : undefined;
    if (p.typeKey && !type) throw new HTTPException(400, { message: "invalid_type" });
    if (p.autoApprove && !a.permissions.includes("accounting.manage")) throw new HTTPException(403, { message: "accounting_manage_only" });
    const kid = zUuid.parse(c.req.param("kid"));
    const cents = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : Math.round(v * 100));
    const set = {
      ...(p.autoApprove !== undefined ? { autoApprove: p.autoApprove } : {}),
      ...(p.billingMode ? { billingMode: p.billingMode } : {}),
      ...(p.hourlyRate !== undefined ? { hourlyRateCents: cents(p.hourlyRate) } : {}),
      ...(p.monthlyRate !== undefined ? { monthlyRateCents: cents(p.monthlyRate) } : {}),
      ...(p.ticketRate !== undefined ? { ticketRateCents: cents(p.ticketRate) } : {}),
      ...(p.supportDefault ? { supportDefault: true } : {}),
      ...(p.name ? { name: p.name } : {}),
      ...(type ? { typeKey: type.key, type: type.name, billingMode: KIND_MODE[type.kind as ContractKind] } : {}),
      ...(p.startDate !== undefined ? { startDate: p.startDate } : {}),
      ...(p.endDate !== undefined ? { endDate: p.endDate } : {}),
      ...(p.fixedPrice !== undefined ? { fixedPriceCents: cents(p.fixedPrice) } : {}),
      ...(p.bankedHours !== undefined ? { bankedHoursX100: p.bankedHours === null ? null : Math.round(p.bankedHours * 100) } : {}),
      ...(p.billingPeriod ? { billingPeriod: p.billingPeriod } : {}),
      ...(p.billedThrough !== undefined ? { billedThrough: p.billedThrough } : {}),
      // stopping a contract keeps what was charged: it is charged up to today; starting it again clears the stop
      ...(p.active !== undefined && p.active !== before.active ? (p.active ? { active: true, endedOn: null } : { active: false, endedOn: before.startDate && todayQc() < before.startDate ? before.startDate : todayQc(), supportDefault: false }) : {}),
    };
    // the term cannot leave a service out
    if ((p.startDate !== undefined || p.endDate !== undefined) && (before.startDate || before.endDate)) {
      const start = p.startDate !== undefined ? p.startDate : before.startDate;
      const end = p.endDate !== undefined ? p.endDate : before.endDate;
      if (start && end && end < start) throw new HTTPException(400, { message: "contract_dates" });
      const lines = await servicesOf(before.id);
      if (lines.some((l) => (start && l.addedOn < start) || (end && l.addedOn > end))) throw new HTTPException(400, { message: "contract_dates_services" });
    }
    const row = await db().transaction(async (tx) => {
      if (p.supportDefault) await tx.update(schema.clientContracts).set({ supportDefault: false }).where(and(eq(schema.clientContracts.clientId, client.id), ne(schema.clientContracts.id, kid)));
      const [r] = await tx
        .update(schema.clientContracts)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(schema.clientContracts.id, kid), eq(schema.clientContracts.clientId, client.id)))
        .returning();
      return r;
    });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    const approved = p.autoApprove ? await applyAutoApprove(client.id) : 0;
    // lines of this contract already copied for days up to there were invoiced elsewhere: set aside as "already invoiced"
    const setAside = row.billedThrough ? await excludeBilledThrough(row.id, row.billedThrough) : 0;
    await audit(a.user.id, "crm.contract_updated", row.id, { ...set, approved });
    // the activity: what changed, and a stop or a restart on its own
    const watched = ["name", "type", "startDate", "endDate", "billingPeriod", "billingMode", "hourlyRateCents", "monthlyRateCents", "ticketRateCents", "fixedPriceCents", "bankedHoursX100", "autoApprove", "billedThrough"] as const;
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of watched) if (key in set && before[key] !== row[key]) changes[key] = [before[key], row[key]];
    if (Object.keys(changes).length) await recordContractEvent(row.id, "updated", { changes }, { userId: a.user.id });
    if (p.active !== undefined && p.active !== before.active) await recordContractEvent(row.id, p.active ? "resumed" : "stopped", p.active ? {} : { on: row.endedOn }, { userId: a.user.id });
    if (p.typeKey || p.billingMode) await syncMonthlyRate(row.id);
    return c.json({ ...row, approved, setAside });
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

/**
 * Invoices as the screens show them: what was paid (payments here, or marked
 * paid in the source), the balance, the status (voided, paid, partial,
 * overdue, due), QuickBooks, sent by email; their lines on demand.
 */
/** Email errors as API errors (invoice_mail_no_email…). */
function mailHttp(e: unknown): never {
  if (e instanceof InvoiceMailError) throw new HTTPException(e.code === "mail_failed" ? 502 : 409, { message: `invoice_mail_${e.code}` });
  throw e;
}

async function invoiceViews(rows: (typeof schema.clientInvoices.$inferSelect)[], names: Map<string, string>, opts: { lines: boolean }) {
  const d = db();
  const ids = rows.map((r) => r.id);
  const payments = ids.length
    ? await d
        .select({ p: schema.invoicePayments, by: schema.users.name })
        .from(schema.invoicePayments)
        .leftJoin(schema.users, eq(schema.users.id, schema.invoicePayments.createdBy))
        .where(inArray(schema.invoicePayments.invoiceId, ids))
        .orderBy(asc(schema.invoicePayments.paidOn), asc(schema.invoicePayments.createdAt))
    : [];
  const lines = new Map<string, (typeof schema.invoiceLines.$inferSelect)[]>();
  const portal = opts.lines ? rows.filter((r) => r.source === "portal").map((r) => r.id) : [];
  if (portal.length) {
    for (const l of await d.select().from(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, portal)).orderBy(asc(schema.invoiceLines.position))) {
      lines.set(l.invoiceId, [...(lines.get(l.invoiceId) ?? []), l]);
    }
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  // an invoice of the portal, with no payment, whose taxes are not the line-by-line ones: how much they would change
  const taxFix = new Map<string, number>();
  if (opts.lines) {
    for (const v of rows) {
      if (v.source !== "portal" || v.voided || v.taxCents === 0 || payments.some((x) => x.p.invoiceId === v.id)) continue;
      const diff = (await taxesByLine(v.id)) - v.taxCents;
      if (diff !== 0) taxFix.set(v.id, diff);
    }
  }
  return rows.map((v) => {
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
      notes: v.notes,
      poNumber: v.poNumber,
      emailedAt: v.emailedAt,
      taxFixCents: taxFix.get(v.id) ?? 0,
      lines: (lines.get(v.id) ?? []).map((l) => ({ id: l.id, kind: l.kind, description: l.description, quantity: l.quantityX100 / 100, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents, taxable: l.taxable })),
      quickbooks: v.quickbooksId || v.quickbooksError ? { id: v.quickbooksId, syncedAt: v.quickbooksSyncedAt, error: v.quickbooksError } : null,
      payments: mine.map((x) => ({ id: x.p.id, amountCents: x.p.amountCents, paidOn: x.p.paidOn, method: x.p.method, reference: x.p.reference, note: x.p.note, source: x.p.source, by: x.by })),
    };
  });
}
