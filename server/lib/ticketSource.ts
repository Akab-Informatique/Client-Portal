import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { withPortalQueues } from "./queues.ts";
const cents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);
import { demoHistory, ensureClientSamples, demoTicketsWithOtherContact,
  addDemoAttachment,
  addDemoCompany,
  addDemoContact,
  addDemoNote,
  addDemoTicket,
  addDemoTimeEntry,
  demoCompanies,
  demoContact,
  demoAssets,
  demoContacts,
  demoContracts,
  demoTickets,
  type Asset,
  type Contract,
  QUEUES,
  updateDemoTicket,
} from "./demoTickets.ts";

/**
 * Where tickets come from: the portal's own database (localBase + localTicketSource), or sample data in
 * development. Both give the same normalized shape, so the routes and the screens do not care.
 *
 * Statuses, priorities and queues are lists of {value, label}; each value also gets a "kind" (new, complete,
 * critical…) used for colours, tiles and "open/closed".
 */
export type StatusKind = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete" | "other";
export type PriorityKind = "critical" | "high" | "medium" | "low";
export type Choice<K extends string = string> = { value: string; label: string | null; kind: K; /** Not offered when changing a ticket's status (Admin › Statuts) */ hidden?: boolean };
/** Queues are the portal's own; "alerts" marks the monitoring-alert queues */
export type Options = { statuses: Choice<StatusKind>[]; priorities: Choice<PriorityKind>[]; queues: Choice<"" | "alerts">[]; /** Where tickets come from (the portal's own list, Admin › Sources) */ ticketSources?: Choice[] };
export type Person = { id: string; name: string };
/**
 * Texts with the client are copied into the ticket as internal notes, so the
 * exchange is in Autotask too. Their title starts with this tag; the portal
 * does not list them in the activity (it shows the texts themselves).
 */
export const SMS_NOTE_TAG = "[Texto]";
export const isSmsNote = (titleOrText: string | null | undefined) => (titleOrText ?? "").startsWith(SMS_NOTE_TAG);

export type Note = {
  id: string;
  author: string;
  at: string;
  text: string;
  internal: boolean;
  /** "time": a time entry (work done), with its hours and its internal note */
  kind?: "note" | "time";
  hours?: number;
  internalText?: string;
  /** A time entry: billed to the client or not, and the hours not billed (offset) */
  billable?: boolean;
  offsetHours?: number;
  /** Written by the system itself (workflow rule, forward, merge…), not by a technician or the client */
  system?: boolean;
  /** Who wrote it: the client (a contact, or a reply made in the client portal) or a technician. Absent: told by the name. */
  by?: "client" | "tech";
  /** Written on a ticket that was merged into this one (its number) */
  mergedFrom?: string;
};
export type Company = { id: number; name: string };
export type Contact = { id: string; companyId: number; name: string; email: string | null; phone: string | null };
export type { Asset, Contract };
/** What the CRM copies from the source: every active client, contact and contract */
export type CrmExport = {
  companies: { id: number; name: string; phone: string | null; address: string | null; city: string | null; province: string | null; postalCode: string | null; website: string | null; parentId: number | null }[];
  contacts: { id: string; companyId: number; firstName: string; lastName: string; email: string | null; phone: string | null; mobile: string | null; title: string | null }[];
  contracts: { id: string; companyId: number; name: string; type: string | null; isDefault: boolean; startDate: string | null; endDate: string | null }[];
  /** Invoices from the date set in Admin › Facturation (money in cents) */
  invoices: { id: string; companyId: number; number: string; issuedOn: string; dueOn: string | null; totalCents: number; taxCents: number; paidOn: string | null; voided: boolean }[];
  /** false: the invoices could not be read (the copies already made are kept) */
  invoicesRead?: boolean;
};
/** Work to bill not yet posted in the source (Accounting › Approbation). Money in cents. */
/** project: project work, not imported yet */
export type BillableKind = "labour" | "charge" | "expense" | "contract" | "milestone" | "project";
export type Billable = {
  /** Unique in the source, e.g. "time:123" */
  id: string;
  kind: BillableKind;
  companyId: number;
  date: string;
  dateEnd?: string | null;
  description: string;
  ticketNumber?: string | null;
  contractName?: string | null;
  /** The contract's id in the source (for automatic approval) */
  contractSourceId?: string | null;
  resourceName?: string | null;
  /** Hours or units */
  quantity: number;
  /** null: no rate known (the client's or the usual one is used) */
  unitPriceCents: number | null;
  taxable: boolean;
};
export type BillableExport = { items: Billable[]; errors: Partial<Record<BillableKind, string>> };

/** The invoices to copy: from the date set in Admin › Facturation */
export type CompanyPatch = Partial<{ name: string; phone: string | null; address: string | null; city: string | null; province: string | null; postalCode: string | null; website: string | null; parentId: number | null }>;
export type ContactPatch = Partial<{ firstName: string; lastName: string; email: string | null; phone: string | null; mobile: string | null; title: string | null; active: boolean }>;
/** A file attached to a ticket (base64 data) */
export type NewAttachment = { name: string; contentType: string; data: string };
/** The portal stops attachments at 5 MB a file. */
export const MAX_TICKET_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export type NTicket = {
  id: number;
  number: string;
  title: string;
  description: string;
  company: Company;
  contact: string;
  contactId: string | null;
  status: string;
  priority: string;
  queue: string;
  source: string;
  assignee: Person | null;
  secondary: Person[];
  createdAt: string;
  dueAt: string;
  updatedAt: string;
  hours: number;
  notes: Note[];
  /** Device of the ticket; absent in copies made before it existed */
  assetId?: string | null;
  /** Contract the work is billed on */
  contractId?: string | null;
  /** The ticket this one was merged into (it is then closed, status "merged") */
  mergedInto?: { id: number; number: string } | null;
  /** The tickets merged into this one, with what they said at the start */
  mergedTickets?: { id: number; number: string; title: string; description: string; createdAt: string; mergedAt: string; contact: string }[];
  /** Files attached in the portal (sample data only) */
  attachments?: { id: string; name: string; size: number; at: string; author: string; internal?: boolean }[];
  /** Parts that could not be loaded (the rest of the ticket is shown) */
  warnings?: { part: "notes" | "time"; detail: string }[];
};
/** A ticket as the meeting trends need it: when it came in and when it was resolved */
export type HistoryTicket = { id: number; createdAt: string; completedAt: string | null; queue: string; source: string; priority: string };
export type TicketPatch = {
  status?: string;
  priority?: string;
  queue?: string;
  assigneeId?: string | null;
  dueDate?: string;
  /** Exact due date and time (ISO), instead of a day at 17:00 */
  dueAt?: string;
  companyId?: number;
  contactId?: string | null;
  title?: string;
  description?: string;
  /** Device (asset id), null to remove */
  assetId?: string | null;
  /** Secondary technicians (person ids), replaces the list */
  secondaryIds?: string[];
  /** Where the ticket came from (ticket_sources.key); kept in the portal */
  source?: string;
};
/** A charge on a ticket: material, expense, service… */
export type Charge = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  unitCost: number | null;
  billable: boolean;
  type: string | null;
  status: string | null;
  materialCode: string | null;
  date: string | null;
  author: string | null;
};
export type NewCharge = {
  name: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  unitCost: number | null;
  billable: boolean;
  typeId: string | null;
  statusId: string | null;
  materialCodeId: string | null;
  date: string | null;
  /** Catalogue product charged */
  productId: string | null;
};
/** A product of the catalogue (to charge on a ticket). */
export type Product = {
  id: string;
  name: string;
  description: string;
  sku: string | null;
  manufacturer: string | null;
  unitPrice: number | null;
  unitCost: number | null;
  /** Material code to use for a charge of this product */
  materialCodeId: string | null;
};
export type ChargeOptions = { types: { value: string; label: string }[]; statuses: { value: string; label: string }[]; materialCodes: { value: string; label: string }[] };
export type NewTimeEntry = {
  hours: number;
  summary: string;
  internal: string;
  workTypeId: string | null;
  startedAt: Date;
  endedAt: Date;
  /** Billed to the client (false: non billable) */
  billable: boolean;
  /** Hours worked but not billed: 4 h worked with an offset of 2 bills 2 h */
  offsetHours: number;
  /** The contract's id in the source, when the time is logged on one */
  contractSourceId?: string | null;
};
export type NewTicket = {
  title: string;
  description: string;
  companyId: number;
  contactId: string | null;
  priority: string;
  queue: string;
  assigneeId: string | null;
  dueDate: string;
  /** The exact due date and time (ISO), instead of the day at 17:00 */
  dueAt?: string;
  /** Contract the work is billed on (null: none) */
  contractId?: string | null;
  /** Where the ticket comes from (ticket_sources.key): email, sms, phone (the default, by hand), in-person… */
  source?: string;
};

export interface TicketSource {
  demo: boolean;
  options(): Promise<Options>;
  /** People a ticket can be assigned to */
  technicians(): Promise<Person[]>;
  /** The person that is "me" for this account (null: not linked to the source) */
  meId(a: AuthContext): Promise<string | null>;
  list(): Promise<NTicket[]>;
  get(id: number): Promise<NTicket | null>;
  update(id: number, p: TicketPatch, a: AuthContext): Promise<void>;
  addNote(id: number, p: { text: string; internal: boolean }, a: AuthContext): Promise<void>;
  create(p: NewTicket, a: AuthContext): Promise<number>;
  companies(): Promise<Company[]>;
  contacts(companyId: number): Promise<Contact[]>;
  addContact(companyId: number, p: { firstName: string; lastName: string; email: string | null; phone: string | null; mobile?: string | null; title?: string | null }, a: AuthContext): Promise<Contact>;
  /** Every active client, contact and contract (the CRM's copy) */
  crmExport(): Promise<CrmExport>;
  /** Work to bill since a date, not yet posted in the source */
  billables(since: string): Promise<BillableExport>;
  updateCompany(id: number, p: CompanyPatch, a: AuthContext): Promise<void>;
  updateContact(id: string, p: ContactPatch, a: AuthContext): Promise<void>;
  /** A new client */
  addCompany(p: { name: string; phone: string }, a: AuthContext): Promise<Company>;
  /** The client's active contracts */
  contracts(companyId: number): Promise<Contract[]>;
  /** Attach a file to the ticket */
  addAttachment(ticketId: number, p: NewAttachment, a: AuthContext): Promise<void>;
  /** Tickets where this contact is one of the other contacts (not the main one) */
  ticketsWithOtherContact(contactId: string): Promise<number[]>;
  /** Every resolved ticket of a company, however old (the client portal's history; the list keeps recent ones only) */
  companyHistory(companyId: number): Promise<NTicket[]>;
  /** Tickets created or resolved since that time (ISO), light: for the meeting trends */
  history(since: string): Promise<HistoryTicket[]>;
  /** The client's devices (active configuration items) */
  assets(companyId: number): Promise<Asset[]>;
  /** Older tickets (not in the local copy): by exact number, or title words */
  searchArchive(q: string): Promise<NTicket[]>;
  charges(ticketId: number): Promise<Charge[]>;
  chargeOptions(): Promise<ChargeOptions>;
  addCharge(ticketId: number, p: NewCharge, a: AuthContext): Promise<void>;
  /** Catalogue products matching the words (name, SKU, manufacturer part) */
  products(q: string): Promise<Product[]>;
  /** The contact with this phone or mobile number (10 digits), with their client */
  contactByPhone(phone: string): Promise<{ contactId: string; contactName: string; companyId: number; companyName: string } | null>;
  /** The active contact with this email address (e.g. the sender of an email) */
  contactByEmail(email: string): Promise<{ contactId: string; contactName: string; companyId: number; companyName: string } | null>;
  /** A ticket opened by the portal itself (texts with no reply): no technician behind it */
  createSystem(p: NewTicket): Promise<{ id: number; number: string }>;
  /** A note written by the portal itself (e.g. a text from the client), internal */
  /** An internal note for a text with the client (title starts with SMS_NOTE_TAG) */
  addSmsNote(ticketId: number, title: string, text: string): Promise<void>;
  /** An email from the client, added to its ticket as the client's own message (written by the portal, no technician) */
  addMailReply(ticketId: number, from: { name: string | null; address: string }, text: string): Promise<void>;
  /**
   * A text (or any message) from the client arrived: the ticket goes to its
   * "needs attention" status, like a new client reply, unless it is complete.
   * Done by the portal itself (no technician). Returns whether it changed.
   */
  markNeedsAttention(ticketId: number): Promise<boolean>;
  /** Work types for time entries; empty when not used */
  workTypes(): Promise<{ value: string; label: string }[]>;
  addTimeEntry(ticketId: number, p: NewTimeEntry, a: AuthContext): Promise<void>;
}

/** New charges are approved unless another status is chosen ("Approved" / "Approuvé"). */
export const approvedStatus = (statuses: { value: string; label: string }[]) => statuses.find((s) => /approu?v/i.test(s.label)) ?? statuses[0];

/** Sample charges, in memory. */
const demoCharges = new Map<number, Charge[]>();
/** Sample data: changes made in the portal, kept in memory */
const demoCompanyPatches = new Map<number, CompanyPatch>();
const demoContactPatches = new Map<string, ContactPatch>();
const DEMO_CHARGE_OPTIONS: ChargeOptions = {
  types: [
    { value: "1", label: "Opérationnel" },
    { value: "2", label: "Capitalisé" },
  ],
  statuses: [
    { value: "1", label: "En attente" },
    { value: "2", label: "Approuvé" },
  ],
  materialCodes: [
    { value: "10", label: "Matériel informatique" },
    { value: "11", label: "Licences logicielles" },
    { value: "12", label: "Déplacement" },
  ],
};

const DEMO_PRODUCTS: Product[] = [
  { id: "p1", name: "Disque SSD Samsung 990 PRO 1 To", description: "SSD NVMe M.2", sku: "MZ-V9P1T0", manufacturer: "Samsung", unitPrice: 189.99, unitCost: 129.5, materialCodeId: "10" },
  { id: "p2", name: "Mémoire Kingston 16 Go DDR5", description: "SO-DIMM 5600", sku: "KVR56S46BS8-16", manufacturer: "Kingston", unitPrice: 89.99, unitCost: 54, materialCodeId: "10" },
  { id: "p3", name: "Station d'accueil Dell WD22TB4", description: "Thunderbolt 4", sku: "WD22TB4", manufacturer: "Dell", unitPrice: 349, unitCost: 262, materialCodeId: "10" },
  { id: "p4", name: "Microsoft 365 Affaires Standard (1 an)", description: "Licence annuelle", sku: "CFQ7TTC0LDPB", manufacturer: "Microsoft", unitPrice: 225, unitCost: 187.2, materialCodeId: "11" },
  { id: "p5", name: "Câble réseau Cat6 3 m", description: "Bleu", sku: "C6-3M-BL", manufacturer: "Tripp Lite", unitPrice: 12.5, unitCost: 4.1, materialCodeId: "10" },
];
/** A due date picked in the portal: end of the working day in Québec. */
/** A day (and time, 17:00 by default) in Québec as an ISO instant — summer (-04:00) or winter (-05:00) time. */
export function dueIso(date: string, time = "17:00"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const want = `${date} ${time}`;
  for (const offset of ["-04:00", "-05:00"]) {
    const d = new Date(`${date}T${time}:00${offset}`);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === want) return d.toISOString();
  }
  return new Date(`${date}T${time}:00-05:00`).toISOString();
}

export class SourceError extends Error {
  constructor(
    public code: "not_found" | "invalid_company" | "invalid_contact" | "invalid_assignee" | "invalid_value" | "not_linked" | "already_local" | "not_local" | "merge_same" | "merge_already" | "merge_target_merged" | "merge_other_client",
  ) {
    super(code);
  }
}

// ── Which source ─────────────────────────────────────────────────────────────────
/** The ticket source (the portal's database, or the sample data) with the portal's own queues over it (see lib/queues.ts) */
const withQueues = new WeakMap<TicketSource, TicketSource>();
/** Ids given to what was made in the portal before it ran alone, once per start */
let adopted: Promise<void> | null = null;
export async function ticketSource(): Promise<TicketSource> {
  // production, or Admin › Billets set to the portal's own: everything is in the database, never sample data
  const { ticketsLocal, localTicketSource } = await import("./localTickets.ts");
  let base: TicketSource = demoSource;
  if (await ticketsLocal()) {
    const { localBase, adoptLocalIds } = await import("./localBase.ts");
    if (!adopted) adopted = adoptLocalIds().catch((e) => { adopted = null; throw e; });
    await adopted;
    base = localTicketSource(localBase);
  }
  // one wrapper per source
  if (!withQueues.has(base)) withQueues.set(base, withPortalQueues(base));
  return withQueues.get(base)!;
}

async function staffPeople(): Promise<Person[]> {
  return db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name));
}

// ── Sample data ───────────────────────────────────────────────────────────────────
/**
 * Local demo: sample tickets for the portal's own client companies, so the
 * client portal has data (checked at most once a minute; not in tests).
 */
let samplesCheckedAt = 0;
async function portalClientSamples() {
  if (process.env.NODE_ENV === "test" || Date.now() - samplesCheckedAt < 60_000) return;
  samplesCheckedAt = Date.now();
  // every client with portal users, active or not: the sample companies must exist
  // before the CRM copy runs, or it would take the clients for gone
  const rows = await db()
    .select({ client: schema.clients.name, phone: schema.clients.phone, autotaskId: schema.clients.autotaskId, name: schema.users.name, email: schema.users.email })
    .from(schema.clients)
    .innerJoin(schema.users, and(eq(schema.users.clientId, schema.clients.id), eq(schema.users.kind, "client")));
  const byClient = new Map<string, { name: string; phone: string | null; autotaskId: number | null; users: { name: string; email: string }[] }>();
  for (const r of rows) {
    const c = byClient.get(r.client) ?? { name: r.client, phone: r.phone, autotaskId: r.autotaskId, users: [] };
    c.users.push({ name: r.name, email: r.email });
    byClient.set(r.client, c);
  }
  ensureClientSamples([...byClient.values()]);
}
const DEMO_STATUSES: StatusKind[] = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete"];
const DEMO_PRIORITIES: PriorityKind[] = ["critical", "high", "medium", "low"];

const demoSource: TicketSource = {
  demo: true,
  async options() {
    return {
      // label null: the screen shows its own translated name
      statuses: [
        ...DEMO_STATUSES.map((k) => ({ value: k, label: null, kind: k })),
        // a closed ticket merged into another: set by the merge only, never picked by hand
        { value: "merged", label: "Fusionné", kind: "complete" as const, hidden: true },
      ],
      priorities: DEMO_PRIORITIES.map((k) => ({ value: k, label: null, kind: k })),
      queues: QUEUES.map((q) => ({ value: q, label: q, kind: "" as const })),
    };
  },
  technicians: staffPeople,
  async meId(a) {
    return a.user.id;
  },
  async list() {
    await portalClientSamples();
    return demoTickets(await staffPeople());
  },
  async get(id) {
    await portalClientSamples();
    const t = demoTickets(await staffPeople()).find((x) => x.id === id);
    return t ? { ...t, notes: t.notes.filter((n) => !isSmsNote(n.text)) } : null;
  },
  async update(id, p) {
    const staff = await staffPeople();
    const t = demoTickets(staff).find((x) => x.id === id);
    if (!t) throw new SourceError("not_found");
    const patch: Parameters<typeof updateDemoTicket>[1] = {};
    if (p.status) patch.status = p.status as never;
    if (p.priority) patch.priority = p.priority as never;
    if (p.queue) patch.queue = p.queue;
    if (p.dueAt) patch.dueAt = new Date(p.dueAt).toISOString();
    else if (p.dueDate) patch.dueAt = dueIso(p.dueDate);
    if (p.companyId !== undefined) {
      const company = demoCompanies().find((x) => x.id === p.companyId);
      if (!company) throw new SourceError("invalid_company");
      patch.company = company;
      if (p.contactId === undefined) {
        patch.contact = "";
        patch.contactId = null;
      }
    }
    if (p.contactId !== undefined) {
      const contact = p.contactId ? demoContact(p.contactId) : null;
      if (p.contactId && contact?.companyId !== (p.companyId ?? t.company.id)) throw new SourceError("invalid_contact");
      patch.contact = contact?.name ?? "";
      patch.contactId = contact?.id ?? null;
    }
    if (p.assigneeId !== undefined) {
      const person = p.assigneeId ? staff.find((s) => s.id === p.assigneeId) : null;
      if (p.assigneeId && !person) throw new SourceError("invalid_assignee");
      patch.assignee = person ?? null;
    }
    if (p.title !== undefined) patch.title = p.title;
    if (p.description !== undefined) patch.description = p.description;
    if (p.assetId !== undefined) {
      if (p.assetId && !demoAssets(patch.company?.id ?? t.company.id).some((x) => x.id === p.assetId)) throw new SourceError("invalid_value");
      patch.assetId = p.assetId;
    }
    if (p.secondaryIds) {
      const people = p.secondaryIds.map((sid) => staff.find((s) => s.id === sid));
      if (people.some((x) => !x)) throw new SourceError("invalid_assignee");
      patch.secondary = people as Person[];
    }
    updateDemoTicket(id, patch);
  },
  async addNote(id, p, a) {
    await this.list();
    if (!addDemoNote(id, { author: a.user.name, text: p.text, internal: p.internal })) throw new SourceError("not_found");
  },
  async create(p) {
    const company = demoCompanies().find((x) => x.id === p.companyId);
    if (!company) throw new SourceError("invalid_company");
    const contact = p.contactId ? demoContact(p.contactId) : null;
    if (p.contactId && contact?.companyId !== company.id) throw new SourceError("invalid_contact");
    if (p.contractId && !demoContracts(company.id).some((x) => x.id === p.contractId)) throw new SourceError("invalid_value");
    const staff = await staffPeople();
    demoTickets(staff);
    const assignee = p.assigneeId ? (staff.find((s) => s.id === p.assigneeId) ?? null) : null;
    return addDemoTicket({
      contractId: p.contractId ?? null,
      title: p.title,
      description: p.description,
      company,
      contact: contact?.name ?? "",
      contactId: contact?.id ?? null,
      status: assignee ? "inProgress" : "new",
      priority: p.priority as never,
      queue: p.queue,
      source: "portal",
      assignee,
      dueAt: p.dueAt ? new Date(p.dueAt).toISOString() : dueIso(p.dueDate),
    }).id;
  },
  async companies() {
    await portalClientSamples();
    return demoCompanies();
  },
  async assets(companyId) {
    return demoAssets(companyId);
  },
  async searchArchive() {
    return [];
  },
  async contacts(companyId) {
    await portalClientSamples();
    return demoContacts(companyId);
  },
  async addCompany(p) {
    return addDemoCompany(p.name);
  },
  async crmExport() {
    await portalClientSamples();
    const companies = demoCompanies();
    const towns = ["Joliette", "Repentigny", "Terrebonne", "Saint-Lin–Laurentides", "Mascouche", "Rawdon"];
    return {
      companies: companies.map((c, i) => ({ id: c.id, name: c.name, phone: `450-555-${String(2000 + i * 7)}`, address: `${100 + i * 15}, rue Principale`, city: towns[i % towns.length], province: "QC", postalCode: null, website: null, parentId: null, ...demoCompanyPatches.get(c.id) })),
      contacts: companies.flatMap((c) =>
        demoContacts(c.id).map((x) => {
          const [firstName, ...rest] = x.name.split(" ");
          const { active, ...patch } = demoContactPatches.get(x.id) ?? {};
          return active === false ? null : { id: x.id, companyId: c.id, firstName, lastName: rest.join(" "), email: x.email, phone: x.phone, mobile: null, title: null, ...patch };
        }),
      ).filter((x) => x !== null),
      invoices: companies.flatMap((c, i) => {
        const day = (d: Date) => d.toISOString().slice(0, 10);
        const now = new Date();
        return Array.from({ length: 10 }, (_, n) => {
          const issued = new Date(now.getFullYear(), now.getMonth() - n, 1, 12);
          const due = new Date(issued.getTime() + 30 * 86_400_000);
          // the latest is not paid yet; every third client is late on the one before
          const unpaid = n === 0 || (i % 3 === 1 && n === 1);
          const subtotal = 450 + ((i * 137 + n * 61) % 900) + (n % 4 === 0 ? 1200 : 0);
          const tax = Math.round(subtotal * 0.14975 * 100) / 100;
          return {
            id: `inv-${c.id}-${n}`,
            companyId: c.id,
            number: String(10000 + ((issued.getFullYear() - 2026) * 12 + issued.getMonth() - 8) * 16 + i),
            issuedOn: day(issued),
            dueOn: day(due),
            totalCents: cents(subtotal + tax),
            taxCents: cents(tax),
            paidOn: unpaid ? null : day(new Date(due.getTime() - ((i + n) % 20) * 86_400_000)),
            voided: i % 4 === 2 && n === 5,
          };
        });
      }),
      contracts: companies.flatMap((c) => demoContracts(c.id).map((k) => ({ id: k.id, companyId: c.id, name: k.name, type: k.name.startsWith("Banque") ? "Blocs d'heures" : k.name.startsWith("Projet") ? "Prix fixe" : "Récurrent", isDefault: k.isDefault, startDate: null, endDate: k.endDate }))),
    };
  },
  async billables(since) {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const now = new Date();
    const ago = (n: number) => day(new Date(now.getTime() - n * 86_400_000));
    const staff = await staffPeople();
    const tickets = demoTickets(staff);
    const items: Billable[] = [];
    for (const [i, c] of demoCompanies().slice(0, 8).entries()) {
      const mine = tickets.filter((x) => x.company.id === c.id).slice(0, 3);
      // labour on its tickets
      for (const [n, tk] of mine.entries()) {
        items.push({
          id: `demo-time-${c.id}-${n}`,
          kind: "labour",
          companyId: c.id,
          date: ago(2 + n * 4 + i),
          description: `${tk.title} — diagnostic et correction`,
          ticketNumber: tk.number,
          resourceName: tk.assignee?.name ?? staff[n % Math.max(1, staff.length)]?.name ?? null,
          quantity: [1.5, 0.75, 2][n],
          unitPriceCents: null,
          taxable: true,
        });
      }
      // material charged on a ticket
      if (mine[0]) items.push({ id: `demo-charge-${c.id}`, kind: "charge", companyId: c.id, date: ago(3 + i), description: "Câble réseau Cat6 3 m", ticketNumber: mine[0].number, quantity: 2, unitPriceCents: 1250, taxable: true });
      // travel expenses
      if (i % 2 === 0) items.push({ id: `demo-expense-${c.id}`, kind: "expense", companyId: c.id, date: ago(5 + i), description: "Kilométrage — 42 km", resourceName: staff[0]?.name ?? null, quantity: 42, unitPriceCents: 68, taxable: true });
      // this month of the managed services contract, and a project milestone
      for (const k of demoContracts(c.id)) {
        if (k.isDefault) {
          const start = new Date(now.getFullYear(), now.getMonth(), 1, 12);
          const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
          items.push({ id: `demo-contract-${k.id}-${day(start).slice(0, 7)}`, kind: "contract", companyId: c.id, date: day(start), dateEnd: day(end), description: `${k.name} — ${day(start).slice(0, 7)}`, contractName: k.name, contractSourceId: k.id, quantity: 1, unitPriceCents: (450 + i * 50) * 100, taxable: true });
        }
        if (k.name.startsWith("Projet")) items.push({ id: `demo-milestone-${k.id}`, kind: "milestone", companyId: c.id, date: ago(1), description: "Étape 2 — migration des boîtes courriel", contractName: k.name, contractSourceId: k.id, quantity: 1, unitPriceCents: 150000, taxable: true });
      }
    }
    return { items: items.filter((x) => x.date >= since), errors: {} };
  },
  async updateCompany(id, p) {
    demoCompanyPatches.set(id, { ...demoCompanyPatches.get(id), ...p });
  },
  async updateContact(id, p) {
    demoContactPatches.set(id, { ...demoContactPatches.get(id), ...p });
  },
  async contracts(companyId) {
    return demoContracts(companyId);
  },
  async ticketsWithOtherContact(contactId) {
    return demoTicketsWithOtherContact(contactId);
  },
  async companyHistory() {
    // the sample list already holds every ticket
    return [];
  },
  async history(since) {
    return demoHistory(Date.parse(since));
  },
  async addAttachment(ticketId, p, a) {
    await this.list();
    const size = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
    if (!addDemoAttachment(ticketId, { name: p.name, size, author: a.user.name })) throw new SourceError("not_found");
  },
  async addContact(companyId, p) {
    if (!demoCompanies().some((x) => x.id === companyId)) throw new SourceError("invalid_company");
    const c = addDemoContact({ companyId, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone });
    if (p.mobile || p.title) demoContactPatches.set(c.id, { mobile: p.mobile ?? null, title: p.title ?? null });
    return c;
  },
  async charges(ticketId) {
    return demoCharges.get(ticketId) ?? [];
  },
  async chargeOptions() {
    return DEMO_CHARGE_OPTIONS;
  },
  async products(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return DEMO_PRODUCTS.filter((p) => words.every((w) => `${p.name} ${p.sku} ${p.manufacturer}`.toLowerCase().includes(w))).slice(0, 25);
  },
  async addCharge(ticketId, p, a) {
    if (!(await this.get(ticketId))) throw new SourceError("not_found");
    const o = DEMO_CHARGE_OPTIONS;
    const label = (list: { value: string; label: string }[], v: string | null) => (v ? (list.find((x) => x.value === v)?.label ?? null) : null);
    if (p.materialCodeId && !label(o.materialCodes, p.materialCodeId)) throw new SourceError("invalid_value");
    if (p.productId && !DEMO_PRODUCTS.some((x) => x.id === p.productId)) throw new SourceError("invalid_value");
    const list = demoCharges.get(ticketId) ?? [];
    list.push({
      id: `ch-${ticketId}-${list.length + 1}`,
      name: p.name,
      description: p.description,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      unitCost: p.unitCost,
      billable: p.billable,
      type: label(o.types, p.typeId) ?? o.types[0].label,
      status: label(o.statuses, p.statusId) ?? approvedStatus(o.statuses).label,
      materialCode: label(o.materialCodes, p.materialCodeId),
      date: p.date ?? new Date().toISOString().slice(0, 10),
      author: a.user.name,
    });
    demoCharges.set(ticketId, list);
  },
  async workTypes() {
    return [];
  },
  async contactByEmail(email) {
    const e = email.toLowerCase();
    for (const c of demoCompanies()) {
      const hit = demoContacts(c.id).find((x) => (x.email ?? "").toLowerCase() === e);
      if (hit) return { contactId: hit.id, contactName: hit.name, companyId: c.id, companyName: c.name };
    }
    return null;
  },
  async contactByPhone(phone) {
    for (const c of demoCompanies()) {
      const hit = demoContacts(c.id).find((x) => (x.phone ?? "").replace(/\D/g, "").endsWith(phone.slice(-10)));
      if (hit) return { contactId: hit.id, contactName: hit.name, companyId: c.id, companyName: c.name };
    }
    return null;
  },
  async addMailReply(ticketId, from, text) {
    await this.list();
    if (!addDemoNote(ticketId, { author: from.name || from.address, text, internal: false })) throw new SourceError("not_found");
  },
  async addSmsNote(ticketId, title, text) {
    await this.list();
    addDemoNote(ticketId, { author: "Texto", text: `${SMS_NOTE_TAG} ${title}\n${text}`, internal: true });
  },
  async markNeedsAttention(ticketId) {
    const t = (await this.list()).find((x) => x.id === ticketId);
    if (!t || t.status === "complete" || t.status === "needsAttention") return false;
    return updateDemoTicket(ticketId, { status: "needsAttention" });
  },
  async createSystem(p) {
    const id = await this.create(p, undefined as never);
    const t = (await this.list()).find((x) => x.id === id)!;
    return { id, number: t.number };
  },
  async addTimeEntry(ticketId, p, a) {
    await this.list();
    if (!addDemoTimeEntry(ticketId, { author: a.user.name, hours: p.hours, text: p.summary, internalText: p.internal || undefined, at: p.startedAt.toISOString(), billable: p.billable, offsetHours: p.offsetHours })) {
      throw new SourceError("not_found");
    }
  },
};

// ── Statuses and priorities: the kind of a label (colours, open / closed) ──
export function statusKind(label: string, value: string): StatusKind {
  const l = label.toLowerCase();
  if (value === "5" || /complet|closed|ferm|résolu|resolved|terminé/.test(l)) return "complete";
  if (/need.*attention|nécessite|attention requise|customer note|client a répondu/.test(l)) return "needsAttention";
  if (/^new|nouveau/.test(l)) return "new";
  if (/wait.*(customer|client)|attente.*client/.test(l)) return "waitingCustomer";
  if (/wait|attente|vendor|fournisseur|material|matériel|pièce/.test(l)) return "waitingVendor";
  if (/sched|planifi|rendez-vous/.test(l)) return "scheduled";
  if (/progress|cours|assign|travail|work/.test(l)) return "inProgress";
  return "other";
}
export function priorityKind(label: string): PriorityKind {
  const l = label.toLowerCase();
  if (/crit|urgent/.test(l)) return "critical";
  if (/high|haut|élev/.test(l)) return "high";
  if (/low|bas|faible/.test(l)) return "low";
  return "medium";
}

/** The lists the portal keeps for the tickets (statuses, queues…), and the charge lists */
export const defaultChargeOptions = (): ChargeOptions => DEMO_CHARGE_OPTIONS;

/** The status / priority / queue lists of the sample data (the portal's own lists are set in Admin › Billets) */
export async function sourceOptions(): Promise<Options> {
  return demoSource.options();
}
