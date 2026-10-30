/**
 * The portal's own database as the source of everything around the tickets —
 * clients, contacts, contracts, products, lists — the
 * reference (not linked, or closed for good). No sample data, nothing read from
 * or written outside. `localTicketSource` (localTickets.ts) puts the tickets
 * themselves over it.
 *
 * What the portal makes gets ids kept apart (see ids.ts), so a
 * link made again later can never meet them.
 */
import { contractBillables } from "./contractBills.ts";
import { and, asc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { LOCAL_PREFIX, NATIVE_ID_START } from "./ids.ts";
import { SourceError, defaultChargeOptions, sourceOptions, type Company, type Contact, type Product, type TicketSource } from "./ticketSource.ts";
import { localCompanies, localContacts, localContracts } from "./crm.ts";
import { provisionPortalUsers } from "./portalUsers.ts";

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const newContactId = () => `${LOCAL_PREFIX}${crypto.randomUUID()}`;

/** Next number for a client made here: above everything used so far */
async function nextCompanyId(): Promise<number> {
  const [r] = await db().select({ m: sql<number>`coalesce(max(${schema.clients.autotaskId}), 0)::int` }).from(schema.clients);
  return Math.max(r.m + 1, NATIVE_ID_START);
}

/**
 * Give an id to every client, contact and contract that has none (made in the
 * portal before it ran alone), so the tickets can point at them. Cheap when
 * there is nothing to do.
 */
export async function adoptLocalIds(): Promise<void> {
  const d = db();
  for (const c of await d.select({ id: schema.clients.id }).from(schema.clients).where(isNull(schema.clients.autotaskId)).orderBy(asc(schema.clients.createdAt))) {
    await d.update(schema.clients).set({ autotaskId: await nextCompanyId() }).where(eq(schema.clients.id, c.id));
  }
  for (const c of await d.select({ id: schema.clientContacts.id }).from(schema.clientContacts).where(isNull(schema.clientContacts.autotaskId))) {
    await d.update(schema.clientContacts).set({ autotaskId: newContactId() }).where(eq(schema.clientContacts.id, c.id));
  }
  for (const k of await d.select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(isNull(schema.clientContracts.autotaskId))) {
    await d.update(schema.clientContracts).set({ autotaskId: newContactId() }).where(eq(schema.clientContracts.id, k.id));
  }
}

async function contactHit(where: ReturnType<typeof and>) {
  const [r] = await db()
    .select({ c: schema.clientContacts, companyId: schema.clients.autotaskId, companyName: schema.clients.name })
    .from(schema.clientContacts)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
    .where(and(eq(schema.clientContacts.active, true), eq(schema.clients.active, true), isNotNull(schema.clientContacts.autotaskId), where));
  return r ? { contactId: r.c.autotaskId!, contactName: `${r.c.firstName} ${r.c.lastName}`.trim(), companyId: r.companyId!, companyName: r.companyName } : null;
}

const none = async () => {
  throw new SourceError("not_found");
};

export const localBase: TicketSource = {
  demo: false,
  options: () => sourceOptions(),
  technicians: async () => [],
  meId: async (a) => a.user.id,
  // the tickets, notes, time… are served by localTicketSource; these are never reached
  list: async () => [],
  get: async () => null,
  update: none,
  addNote: none,
  create: none,
  addAttachment: none,
  addTimeEntry: none,
  addCharge: none,
  removeCharge: none,
  addSmsNote: none,
  addMailReply: none,
  createSystem: none,
  markNeedsAttention: async () => false,
  charges: async () => [],
  ticketsWithOtherContact: async () => [],
  companyHistory: async () => [],
  history: async () => [],
  searchArchive: async () => [],

  async companies(): Promise<Company[]> {
    return (await localCompanies(true)) ?? [];
  },
  async contacts(companyId): Promise<Contact[]> {
    return (await localContacts(companyId, true)) ?? [];
  },
  async contracts(companyId) {
    return (await localContracts(companyId, true)) ?? [];
  },
  async assets() {
    return [];
  },
  /** Nothing to copy: the portal's database is the copy */
  async crmExport() {
    return { companies: [], contacts: [], contracts: [], invoices: [], invoicesRead: false };
  },
  // the recurring charges of the contracts (the labour and charges come from the portal's tickets)
  async billables(since) {
    return { items: await contractBillables(since), errors: {} };
  },
  async addCompany(p) {
    const id = await nextCompanyId();
    await db().insert(schema.clients).values({ name: p.name, phone: p.phone || null, autotaskId: id, syncedAt: new Date() });
    return { id, name: p.name };
  },
  async addContact(companyId, p) {
    const [client] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.autotaskId, companyId));
    if (!client) throw new SourceError("invalid_company");
    const id = newContactId();
    await db()
      .insert(schema.clientContacts)
      .values({ clientId: client.id, autotaskId: id, firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone, mobile: p.mobile ?? null, title: p.title ?? null, syncedAt: new Date() });
    await provisionPortalUsers(client.id);
    return { id, companyId, name: `${p.firstName} ${p.lastName}`.trim(), email: p.email, phone: p.phone };
  },
  // The route writes the change in the database itself
  async updateCompany() {},
  async updateContact() {},

  async contactByEmail(email) {
    return contactHit(sql`lower(${schema.clientContacts.email}) = ${email.trim().toLowerCase()}`);
  },
  async contactByPhone(phone) {
    const last = digits(phone).slice(-10);
    if (last.length < 10) return null;
    const rows = await db()
      .select({ c: schema.clientContacts, companyId: schema.clients.autotaskId, companyName: schema.clients.name })
      .from(schema.clientContacts)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
      .where(and(eq(schema.clientContacts.active, true), eq(schema.clients.active, true), isNotNull(schema.clientContacts.autotaskId)));
    const hit = rows.find((r) => digits(r.c.phone).endsWith(last) || digits(r.c.mobile).endsWith(last));
    return hit ? { contactId: hit.c.autotaskId!, contactName: `${hit.c.firstName} ${hit.c.lastName}`.trim(), companyId: hit.companyId!, companyName: hit.companyName } : null;
  },

  // Lists kept by the portal, else the usual defaults
  async chargeOptions() {
    const { ticketMode } = await import("./localTickets.ts");
    return (await ticketMode()).chargeOptions ?? defaultChargeOptions();
  },
  async workTypes() {
    const { ticketMode } = await import("./localTickets.ts");
    return (await ticketMode()).workTypes ?? [];
  },
  async products(q): Promise<Product[]> {
    const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const rows = await db()
      .select()
      .from(schema.storeProducts)
      .where(
        and(
          eq(schema.storeProducts.active, true),
          ...words.map((w) => {
            const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            return or(ilike(schema.storeProducts.name, like), ilike(schema.storeProducts.sku, like), ilike(schema.storeProducts.manufacturer, like))!;
          }),
        ),
      )
      .orderBy(asc(schema.storeProducts.name))
      .limit(25);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      sku: p.sku,
      manufacturer: p.manufacturer,
      unitPrice: p.priceCents / 100,
      unitCost: p.costCents / 100,
      materialCodeId: p.materialCodeId,
    }));
  },
};
