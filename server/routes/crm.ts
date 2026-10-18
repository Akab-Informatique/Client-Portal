import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zEmail, zOptText, zUuid } from "../lib/validate.ts";
import { ticketSource, type NTicket } from "../lib/ticketSource.ts";
import { crmState, descendantsOf, ensureCrm, rememberCompany, rememberContact, syncCrm } from "../lib/crm.ts";
import { lookup, run } from "./tickets.ts";

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
    const rows = await db().select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, client.id)).orderBy(asc(schema.clientContacts.lastName), asc(schema.clientContacts.firstName));
    return c.json(rows.sort((x, y) => Number(y.active) - Number(x.active)));
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
    if (contact.autotaskId) {
      const src = await ticketSource();
      await run(() => src.updateContact(contact.autotaskId!, p, a));
    }
    const [row] = await db().update(schema.clientContacts).set({ ...p, updatedAt: new Date() }).where(eq(schema.clientContacts.id, contact.id)).returning();
    await audit(a.user.id, "crm.contact_updated", client.id, { contact: contact.id, fields: Object.keys(p) });
    return c.json(row);
  })

  // ── contracts (from Autotask, read only for now)
  .get("/clients/:id/contracts", async (c) => {
    const client = await clientOr404(c.req.param("id"));
    const rows = await db().select().from(schema.clientContracts).where(eq(schema.clientContracts.clientId, client.id)).orderBy(asc(schema.clientContracts.name));
    return c.json(rows.sort((x, y) => Number(y.active) - Number(x.active) || Number(y.isDefault) - Number(x.isDefault)));
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
