import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { autotask, AutotaskError, listResources, loadSettings, type Client } from "./autotask.ts";
import {
  addDemoContact,
  addDemoNote,
  addDemoTicket,
  addDemoTimeEntry,
  demoCompanies,
  demoContact,
  demoAssets,
  demoContacts,
  demoTickets,
  type Asset,
  QUEUES,
  updateDemoTicket,
} from "./demoTickets.ts";

/**
 * Where tickets come from: Autotask when the integration is enabled, sample
 * data otherwise. Both give the same normalized shape, so the routes and the
 * screens do not care.
 *
 * Statuses, priorities and queues are the source's own lists ({value, label});
 * each value also gets a "kind" (new, complete, critical…) used for colours,
 * tiles and "open/closed" — Autotask lets every MSP rename them.
 */
export type StatusKind = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete" | "other";
export type PriorityKind = "critical" | "high" | "medium" | "low";
export type Choice<K extends string = string> = { value: string; label: string | null; kind: K };
export type Options = { statuses: Choice<StatusKind>[]; priorities: Choice<PriorityKind>[]; queues: Choice<"">[] };
export type Person = { id: string; name: string };
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
};
export type Company = { id: number; name: string };
export type Contact = { id: string; companyId: number; name: string; email: string | null; phone: string | null };
export type { Asset };
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
  /** Device of the ticket (Autotask configuration item); absent in copies made before it existed */
  assetId?: string | null;
  /** Parts that could not be loaded (the rest of the ticket is shown) */
  warnings?: { part: "notes" | "time"; detail: string }[];
};
export type TicketPatch = {
  status?: string;
  priority?: string;
  queue?: string;
  assigneeId?: string | null;
  dueDate?: string;
  companyId?: number;
  contactId?: string | null;
  title?: string;
  description?: string;
  /** Device (asset id), null to remove */
  assetId?: string | null;
  /** Secondary technicians (person ids), replaces the list */
  secondaryIds?: string[];
};
/** A charge on a ticket (Autotask TicketCharges): material, expense, service… */
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
  /** Catalogue product charged (links the charge to it in Autotask) */
  productId: string | null;
};
/** A product of the Autotask catalogue (to charge on a ticket). */
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
export type NewTimeEntry = { hours: number; summary: string; internal: string; workTypeId: string | null; startedAt: Date; endedAt: Date };
export type NewTicket = {
  title: string;
  description: string;
  companyId: number;
  contactId: string | null;
  priority: string;
  queue: string;
  assigneeId: string | null;
  dueDate: string;
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
  addContact(companyId: number, p: { firstName: string; lastName: string; email: string | null; phone: string | null }, a: AuthContext): Promise<Contact>;
  /** The client's devices (active configuration items) */
  assets(companyId: number): Promise<Asset[]>;
  /** Older tickets (not in the local copy): by exact number, or title words */
  searchArchive(q: string): Promise<NTicket[]>;
  charges(ticketId: number): Promise<Charge[]>;
  chargeOptions(): Promise<ChargeOptions>;
  addCharge(ticketId: number, p: NewCharge, a: AuthContext): Promise<void>;
  /** Catalogue products matching the words (name, SKU, manufacturer part) */
  products(q: string): Promise<Product[]>;
  /** On-site visit: an Autotask service call for the ticket and the technician (null for sample data) */
  createServiceCall(p: { ticketId: number; technicianId: string; startsAt: Date; endsAt: Date; description: string }, a: AuthContext): Promise<number | null>;
  updateServiceCall(id: number, p: { startsAt: Date; endsAt: Date }, a: AuthContext): Promise<void>;
  deleteServiceCall(id: number, a: AuthContext): Promise<void>;
  /** The contact with this phone or mobile number (10 digits), with their client */
  contactByPhone(phone: string): Promise<{ contactId: string; contactName: string; companyId: number; companyName: string } | null>;
  /** A ticket opened by the portal itself (texts with no reply): no technician behind it */
  createSystem(p: NewTicket): Promise<{ id: number; number: string }>;
  /** A note written by the portal itself (e.g. a text from the client), internal */
  addSystemNote(ticketId: number, text: string): Promise<void>;
  /** Work types for time entries (Autotask billing codes); empty when not used */
  workTypes(): Promise<{ value: string; label: string }[]>;
  addTimeEntry(ticketId: number, p: NewTimeEntry, a: AuthContext): Promise<void>;
}

/** New charges are approved unless another status is chosen ("Approved" / "Approuvé"). */
export const approvedStatus = (statuses: { value: string; label: string }[]) => statuses.find((s) => /approu?v/i.test(s.label)) ?? statuses[0];

/** Sample charges, in memory. */
const demoCharges = new Map<number, Charge[]>();
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
export const dueIso = (date: string) => new Date(`${date}T17:00:00-04:00`).toISOString();

export class SourceError extends Error {
  constructor(
    public code: "not_found" | "invalid_company" | "invalid_contact" | "invalid_assignee" | "invalid_value" | "not_linked",
  ) {
    super(code);
  }
}

// ── Which source ─────────────────────────────────────────────────────────────────
export async function ticketSource(): Promise<TicketSource> {
  const s = await loadSettings();
  return s.enabled && s.credentials && s.config.zone ? autotaskSource : demoSource;
}

async function staffPeople(): Promise<Person[]> {
  return db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name));
}

// ── Sample data ───────────────────────────────────────────────────────────────────
const DEMO_STATUSES: StatusKind[] = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete"];
const DEMO_PRIORITIES: PriorityKind[] = ["critical", "high", "medium", "low"];

const demoSource: TicketSource = {
  demo: true,
  async options() {
    return {
      // label null: the screen shows its own translated name
      statuses: DEMO_STATUSES.map((k) => ({ value: k, label: null, kind: k })),
      priorities: DEMO_PRIORITIES.map((k) => ({ value: k, label: null, kind: k })),
      queues: QUEUES.map((q) => ({ value: q, label: q, kind: "" as const })),
    };
  },
  technicians: staffPeople,
  async meId(a) {
    return a.user.id;
  },
  async list() {
    return demoTickets(await staffPeople());
  },
  async get(id) {
    return demoTickets(await staffPeople()).find((t) => t.id === id) ?? null;
  },
  async update(id, p) {
    const staff = await staffPeople();
    const t = demoTickets(staff).find((x) => x.id === id);
    if (!t) throw new SourceError("not_found");
    const patch: Parameters<typeof updateDemoTicket>[1] = {};
    if (p.status) patch.status = p.status as never;
    if (p.priority) patch.priority = p.priority as never;
    if (p.queue) patch.queue = p.queue;
    if (p.dueDate) patch.dueAt = dueIso(p.dueDate);
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
    const staff = await staffPeople();
    demoTickets(staff);
    const assignee = p.assigneeId ? (staff.find((s) => s.id === p.assigneeId) ?? null) : null;
    return addDemoTicket({
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
      dueAt: dueIso(p.dueDate),
    }).id;
  },
  async companies() {
    return demoCompanies();
  },
  async assets(companyId) {
    return demoAssets(companyId);
  },
  async searchArchive() {
    return [];
  },
  async contacts(companyId) {
    return demoContacts(companyId);
  },
  async addContact(companyId, p) {
    if (!demoCompanies().some((x) => x.id === companyId)) throw new SourceError("invalid_company");
    return addDemoContact({ companyId, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone });
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
  async createServiceCall() {
    return null;
  },
  async contactByPhone(phone) {
    for (const c of demoCompanies()) {
      const hit = demoContacts(c.id).find((x) => (x.phone ?? "").replace(/\D/g, "").endsWith(phone.slice(-10)));
      if (hit) return { contactId: hit.id, contactName: hit.name, companyId: c.id, companyName: c.name };
    }
    return null;
  },
  async addSystemNote(ticketId, text) {
    await this.list();
    addDemoNote(ticketId, { author: "Texto", text, internal: true });
  },
  async createSystem(p) {
    const id = await this.create(p, undefined as never);
    const t = (await this.list()).find((x) => x.id === id)!;
    return { id, number: t.number };
  },
  async updateServiceCall() {},
  async deleteServiceCall() {},
  async addTimeEntry(ticketId, p, a) {
    await this.list();
    if (!addDemoTimeEntry(ticketId, { author: a.user.name, hours: p.hours, text: p.summary, internalText: p.internal || undefined, at: p.startedAt.toISOString() })) {
      throw new SourceError("not_found");
    }
  },
};

// ── Autotask ──────────────────────────────────────────────────────────────────────
type PicklistValue = { value: string; label: string; isActive?: boolean; sortOrder?: number };
type FieldInfo = { name: string; isPickList?: boolean; picklistValues?: PicklistValue[] | null };
type AtTicket = {
  id: number;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: number;
  priority: number;
  queueID: number | null;
  companyID: number;
  contactID: number | null;
  assignedResourceID: number | null;
  dueDateTime: string | null;
  createDate: string;
  lastActivityDate: string | null;
  configurationItemID?: number | null;
  source: number | null;
};
const TICKET_FIELDS = [
  "id",
  "configurationItemID",
  "ticketNumber",
  "title",
  "description",
  "status",
  "priority",
  "queueID",
  "companyID",
  "contactID",
  "assignedResourceID",
  "dueDateTime",
  "createDate",
  "lastActivityDate",
  "source",
];

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

/**
 * Small cache for Autotask reads. Concurrent callers share one load. With
 * `stale`, an expired value is returned at once and refreshed in the
 * background (nobody waits for Autotask once the data is there).
 */
const cache = new Map<string, { at: number; value: unknown }>();
const loading = new Map<string, Promise<unknown>>();
function load<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = loading.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn()
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts: { stale?: boolean } = {}): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  if (hit && opts.stale) {
    void load(key, fn).catch((e) => console.warn(`[autotask] refresh ${key} failed:`, e instanceof Error ? e.message : e));
    return hit.value as T;
  }
  return load(key, fn);
}
const forget = (prefix: string) => {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
};
export async function clearTicketCache() {
  cache.clear();
  loading.clear();
  generation++;
  mirror = null;
  lastFull = 0;
  lastInc = 0;
  await db().delete(schema.autotaskTickets);
}

/**
 * Local copy of the Autotask tickets (table autotask_tickets + memory).
 * Lists, filters and searches read it: they never wait for Autotask and do not
 * use its hourly quota. Kept up to date in the background:
 *  - incremental: only tickets with activity since the last pass (usually one
 *    small request, nothing to normalize);
 *  - full: every 30 min (and when the copy is empty), which also drops deleted
 *    tickets and old completed ones.
 * Our own changes are written to the copy at once (refreshOne).
 */
const FULL_EVERY = 30 * 60_000;
const INCREMENTAL_EVERY = 30_000;
let mirror: Map<number, NTicket> | null = null;
let lastFull = 0;
let lastInc = 0;
let generation = 0;
let syncing: Promise<void> | null = null;

async function mirrorMap(): Promise<Map<number, NTicket>> {
  if (!mirror) {
    const rows = await db().select({ id: schema.autotaskTickets.id, data: schema.autotaskTickets.data }).from(schema.autotaskTickets);
    mirror ??= new Map(rows.map((r) => [r.id, r.data as unknown as NTicket]));
  }
  return mirror;
}

const activityOf = (x: NTicket) => {
  const d = new Date(x.updatedAt);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

async function store(list: NTicket[], replace: boolean) {
  await db().transaction(async (tx) => {
    if (replace) await tx.delete(schema.autotaskTickets);
    for (const part of chunks(list, 200)) {
      await tx
        .insert(schema.autotaskTickets)
        .values(part.map((x) => ({ id: x.id, data: x as unknown as Record<string, unknown>, lastActivity: activityOf(x), syncedAt: new Date() })))
        .onConflictDoUpdate({
          target: schema.autotaskTickets.id,
          set: { data: sql`excluded.data`, lastActivity: sql`excluded.last_activity`, syncedAt: sql`excluded.synced_at` },
        });
    }
  });
}

/** One sync at a time; callers share it. */
export function syncTickets(): Promise<void> {
  syncing ??= runSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync() {
  const gen = generation;
  const m = await mirrorMap();
  if (!m.size || Date.now() - lastFull > FULL_EVERY) {
    const started = Date.now();
    const list = await loadList();
    if (gen !== generation) return;
    await store(list, true);
    mirror = new Map(list.map((x) => [x.id, x]));
    lastFull = lastInc = started;
    return;
  }
  const at = await autotask();
  const started = Date.now();
  // Since the last pass (or the newest activity we know, after a restart), with an overlap
  const newest = lastInc || Math.max(0, ...[...m.values()].map((x) => activityOf(x).getTime()));
  const since = new Date(newest - 2 * 60_000).toISOString();
  const rows = await at.query<AtTicket>(
    "Tickets",
    [
      {
        op: "or",
        items: [
          { op: "gte", field: "lastActivityDate", value: since },
          { op: "gte", field: "createDate", value: since },
        ],
      },
    ],
    { fields: TICKET_FIELDS, max: 3000 },
  );
  // Seen in the overlap and unchanged: nothing to do
  const changed = rows.filter((r) => m.get(r.id)?.updatedAt !== (r.lastActivityDate ?? r.createDate));
  if (changed.length) {
    const list = await normalize(at, changed, true);
    if (gen !== generation) return;
    await store(list, false);
    for (const x of list) m.set(x.id, x);
  }
  lastInc = started;
}

/** Background sync while the portal is used (stops after 15 min idle). */
let lastUse = 0;
let warmTimer: ReturnType<typeof setInterval> | null = null;
export function keepTicketsWarm() {
  if (warmTimer) return;
  const tick = async () => {
    if (lastUse && Date.now() - lastUse > 15 * 60_000) return;
    const src = await ticketSource();
    if (src.demo) return;
    await syncTickets().catch((e) => console.warn("[autotask] sync failed:", e instanceof Error ? e.message : e));
  };
  void tick();
  warmTimer = setInterval(() => void tick(), INCREMENTAL_EVERY);
  warmTimer.unref?.();
}

const picklist = (fields: FieldInfo[], name: string) =>
  (fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.picklistValues ?? [])
    .filter((v) => v.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

async function fieldsOf(at: Client, entity: string): Promise<FieldInfo[]> {
  return cached(`fields:${entity}`, 6 * 60 * 60_000, async () => (await at.call<{ fields: FieldInfo[] }>("GET", `${entity}/entityInformation/fields`)).fields ?? []);
}

/**
 * Only ask Autotask for fields its entity really has (names differ between
 * versions, e.g. createdByContactID): asking for an unknown field fails the
 * whole query.
 */
async function safeFields(at: Client, entity: string, wanted: string[]): Promise<string[]> {
  const known = new Set((await fieldsOf(at, entity).catch(() => [] as FieldInfo[])).map((x) => x.name.toLowerCase()));
  if (!known.size) return wanted;
  return wanted.filter((w) => known.has(w.toLowerCase()));
}

const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Portal accounts linked to an Autotask resource: resource id → portal user id. */
async function links(): Promise<Map<number, string>> {
  const rows = await db()
    .select({ id: schema.users.id, resourceId: schema.users.autotaskResourceId })
    .from(schema.users)
    .where(and(eq(schema.users.kind, "staff"), isNotNull(schema.users.autotaskResourceId)));
  return new Map(rows.map((r) => [r.resourceId!, r.id]));
}
/**
 * Resource id → person. A linked resource is shown as the portal account (same
 * id as the portal's filters), others as "at-<resource id>". Loaded once per call.
 */
async function people(): Promise<(resourceId: number | null) => Person | null> {
  const [res, map] = await Promise.all([listResources(), links()]);
  const names = new Map(res.map((r) => [r.id, r.name]));
  return (resourceId) => (resourceId ? { id: map.get(resourceId) ?? `at-${resourceId}`, name: names.get(resourceId) ?? `#${resourceId}` } : null);
}
/** Person id (portal user or "at-<resource>") → Autotask resource id. */
async function resourceIdOf(personId: string): Promise<number | null> {
  if (personId.startsWith("at-")) return Number(personId.slice(3)) || null;
  const [u] = await db().select({ r: schema.users.autotaskResourceId }).from(schema.users).where(eq(schema.users.id, personId));
  return u?.r ?? null;
}
/** Writes are made on behalf of the technician (ImpersonationResourceId). */
async function actorResource(a: AuthContext): Promise<number> {
  const [u] = await db().select({ r: schema.users.autotaskResourceId }).from(schema.users).where(eq(schema.users.id, a.realUser.id));
  if (!u?.r) throw new SourceError("not_linked");
  return u.r;
}
async function roleOf(at: Client, resourceId: number): Promise<number | null> {
  const roles = await cached(`roles:${resourceId}`, 60 * 60_000, () =>
    at.query<{ roleID: number }>("ResourceRoles", [{ op: "eq", field: "resourceID", value: resourceId }, { op: "eq", field: "isActive", value: true }], { fields: ["roleID"], max: 20 }),
  );
  return roles[0]?.roleID ?? null;
}

/**
 * Client names for these ids: from the cached full list when it is there,
 * otherwise only the needed ids are asked (never the whole list just for this).
 */
async function companyNames(at: Client, ids: number[]): Promise<Map<number, string>> {
  const all = (cache.get("companies")?.value as Company[] | undefined) ?? [];
  const map = new Map(all.map((c) => [c.id, c.name]));
  const missing = [...new Set(ids)].filter((id) => !map.has(id));
  const parts = await Promise.all(
    chunks(missing, 200).map((part) =>
      at.query<{ id: number; companyName: string }>("Companies", [{ op: "in", field: "id", value: part }], { fields: ["id", "companyName"] }),
    ),
  );
  for (const r of parts.flat()) map.set(r.id, r.companyName);
  return map;
}
async function contactNames(at: Client, ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const parts = await Promise.all(
    chunks([...new Set(ids)], 200).map((part) =>
      at.query<{ id: number; firstName: string; lastName: string }>("Contacts", [{ op: "in", field: "id", value: part }], { fields: ["id", "firstName", "lastName"] }),
    ),
  );
  for (const r of parts.flat()) map.set(r.id, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim());
  return map;
}

async function normalize(at: Client, rows: AtTicket[], withSecondary: boolean): Promise<NTicket[]> {
  const [companies, contacts, opts, personOf, secondaryRows] = await Promise.all([
    companyNames(
      at,
      rows.map((r) => r.companyID),
    ),
    contactNames(
      at,
      rows.map((r) => r.contactID).filter((x): x is number => Boolean(x)),
    ),
    atOptions(),
    people(),
    withSecondary
      ? Promise.all(
          chunks(
            rows.map((r) => r.id),
            200,
          ).map((part) =>
            at.query<{ ticketID: number; resourceID: number }>("TicketSecondaryResources", [{ op: "in", field: "ticketID", value: part }], {
              fields: ["ticketID", "resourceID"],
            }),
          ),
        ).then((x) => x.flat())
      : Promise.resolve([] as { ticketID: number; resourceID: number }[]),
  ]);
  const secondary = new Map<number, number[]>();
  for (const s of secondaryRows) secondary.set(s.ticketID, [...(secondary.get(s.ticketID) ?? []), s.resourceID]);
  const out: NTicket[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      number: r.ticketNumber,
      title: r.title,
      description: r.description ?? "",
      company: { id: r.companyID, name: companies.get(r.companyID) ?? `#${r.companyID}` },
      contact: r.contactID ? (contacts.get(r.contactID) ?? "") : "",
      contactId: r.contactID ? String(r.contactID) : null,
      status: String(r.status),
      priority: String(r.priority),
      queue: r.queueID ? String(r.queueID) : "",
      source: r.source ? (opts.sources.get(String(r.source)) ?? "") : "",
      assignee: personOf(r.assignedResourceID),
      secondary: (secondary.get(r.id) ?? []).map((x) => personOf(x)).filter((p): p is Person => Boolean(p) && p!.id !== personOf(r.assignedResourceID)?.id),
      createdAt: r.createDate,
      // No due date in Autotask: far away, so it sorts last
      dueAt: r.dueDateTime ?? "2999-12-31T00:00:00.000Z",
      updatedAt: r.lastActivityDate ?? r.createDate,
      hours: 0,
      notes: [],
      assetId: r.configurationItemID ? String(r.configurationItemID) : null,
    });
  }
  return out;
}

/** An Autotask product row → Product (its material code field name varies). */
function productOf(r: Record<string, string | number | null | undefined> & { id: number }): Product {
  const n = (v: unknown) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
  const code = r.billingCodeID ?? r.chargeBillingCodeID ?? r.productBillingCodeID;
  return {
    id: String(r.id),
    name: String(r.name ?? `#${r.id}`),
    description: String(r.description ?? ""),
    sku: r.sku ? String(r.sku) : null,
    manufacturer: r.manufacturerName ? String(r.manufacturerName) : null,
    unitPrice: n(r.unitPrice),
    unitCost: n(r.unitCost),
    materialCodeId: code ? String(code) : null,
  };
}

/**
 * When Autotask records the portal's API user (the technician's name was
 * refused), the text says who really wrote it.
 */
const byline = (a: AuthContext) => `— ${a.user.name} (via le portail AKAB)`;
const signText = (a: AuthContext, field: string) => (body: unknown) => {
  const b = body as Record<string, unknown>;
  const text = typeof b[field] === "string" && b[field] ? `${b[field]}\n\n` : "";
  return { ...b, [field]: `${text}${byline(a)}`.slice(0, 8000) };
};

/** Remember which technician wrote a note / time entry (shown in the activity). */
async function rememberAuthor(entity: "note" | "time", autotaskId: number | undefined, ticketId: number, a: AuthContext) {
  if (!autotaskId) return;
  await db().insert(schema.autotaskAuthors).values({ entity, autotaskId, ticketId, userId: a.realUser.id }).onConflictDoNothing();
}

/** Make the ticket's secondary technicians exactly this list (adds / removes). */
async function setSecondary(at: Client, ticketId: number, personIds: string[], actor: number): Promise<void> {
  const wanted = new Set<number>();
  for (const pid of personIds) {
    const rid = await resourceIdOf(pid);
    if (!rid) throw new SourceError("invalid_assignee");
    wanted.add(rid);
  }
  const current = await at.query<{ id: number; resourceID: number }>("TicketSecondaryResources", [{ op: "eq", field: "ticketID", value: ticketId }], {
    fields: ["id", "resourceID"],
  });
  for (const row of current.filter((r) => !wanted.has(r.resourceID))) {
    await at.call("DELETE", `Tickets/${ticketId}/SecondaryResources/${row.id}`, undefined, { impersonate: actor });
  }
  for (const rid of [...wanted].filter((r) => !current.some((c) => c.resourceID === r))) {
    await at.call("POST", `Tickets/${ticketId}/SecondaryResources`, { ticketID: ticketId, resourceID: rid, roleID: await roleOf(at, rid) }, { impersonate: actor });
  }
}

/**
 * After a change: reload just this ticket and put it in the cached list
 * (instead of reloading the whole list from Autotask).
 */
async function refreshOne(at: Client, id: number): Promise<void> {
  forget(`detail:${id}:`);
  try {
    const m = await mirrorMap();
    const item = (await at.call<{ item: AtTicket | null }>("GET", `Tickets/${id}`)).item;
    if (item) {
      const [x] = await normalize(at, [item], true);
      m.set(id, x);
      await store([x], false);
    } else {
      m.delete(id);
      await db().delete(schema.autotaskTickets).where(eq(schema.autotaskTickets.id, id));
    }
  } catch (e) {
    // the next sync brings it
    console.warn(`[autotask] ticket ${id} reload failed:`, e instanceof Error ? e.message : e);
  }
}

/** Open tickets + those completed in the last 14 days, normalized. */
async function loadList(): Promise<NTicket[]> {
  const at = await autotask();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const complete = (await atOptions()).statuses.filter((s) => s.kind === "complete").map((s) => Number(s.value));
  const rows = await at.query<AtTicket>(
    "Tickets",
    [
      {
        op: "or",
        items: [
          { op: "notIn", field: "status", value: complete.length ? complete : [5] },
          { op: "gte", field: "completedDate", value: since },
        ],
      },
    ],
    { fields: TICKET_FIELDS, max: 3000 },
  );
  return normalize(at, rows, true);
}

/** Autotask lists (cached 10 min): ticket picklists + note types/publish values. */
async function atOptions() {
  const at = await autotask();
  return cached("options", 60 * 60_000, async () => {
      const [fields, noteFields] = await Promise.all([fieldsOf(at, "Tickets"), fieldsOf(at, "TicketNotes").catch(() => [] as FieldInfo[])]);
      return {
        statuses: picklist(fields, "status").map((v) => ({ value: String(v.value), label: v.label, kind: statusKind(v.label, String(v.value)) })),
        priorities: picklist(fields, "priority").map((v) => ({ value: String(v.value), label: v.label, kind: priorityKind(v.label) })),
        queues: picklist(fields, "queueID").map((v) => ({ value: String(v.value), label: v.label, kind: "" as const })),
        sources: new Map(picklist(fields, "source").map((v) => [String(v.value), v.label])),
        noteTypes: picklist(noteFields, "noteType"),
        publish: picklist(noteFields, "publish"),
      };
    });
}

const autotaskSource: TicketSource = {
  demo: false,

  options: () => atOptions(),

  async technicians() {
    const [res, map] = await Promise.all([listResources(), links()]);
    return res.map((r) => ({ id: map.get(r.id) ?? `at-${r.id}`, name: r.name }));
  },

  async meId(a) {
    const [u] = await db().select({ r: schema.users.autotaskResourceId }).from(schema.users).where(eq(schema.users.id, a.user.id));
    return u?.r ? a.user.id : null;
  },

  /** Open tickets + those completed in the last 14 days, from the local copy. */
  async list() {
    lastUse = Date.now();
    const m = await mirrorMap();
    if (!m.size) await syncTickets();
    else if (Date.now() - lastInc > INCREMENTAL_EVERY) void syncTickets().catch((e) => console.warn("[autotask] sync failed:", e instanceof Error ? e.message : e));
    return [...(mirror ?? m).values()];
  },

  async get(id) {
    const at = await autotask();
    const fromList = (await mirrorMap()).get(id);
    const loadTicket = async (): Promise<NTicket | null> => {
      if (fromList) return { ...fromList };
      let item: AtTicket | undefined;
      try {
        item = (await at.call<{ item: AtTicket | null }>("GET", `Tickets/${id}`)).item ?? undefined;
      } catch (e) {
        if (e instanceof AutotaskError && e.status === 404) return null;
        throw e;
      }
      return item ? (await normalize(at, [item], true))[0] : null;
    };
    const warnings: NonNullable<NTicket["warnings"]> = [];
    const soft = <T>(part: "notes" | "time", fallback: T) => (e: unknown) => {
      const detail = e instanceof AutotaskError ? (e.detail ?? e.code) : e instanceof Error ? e.message : String(e);
      console.warn(`[autotask] ticket ${id}: ${part} could not be loaded: ${detail}`);
      warnings.push({ part, detail });
      return fallback;
    };
    type AtNote = { id: number; title?: string; description?: string; createDateTime: string; creatorResourceID?: number | null; createdByContactID?: number | null; creatorContactID?: number | null; publish?: number };
    type AtTime = { id: number; resourceID?: number | null; dateWorked?: string; startDateTime?: string | null; createDateTime?: string; hoursWorked?: number; summaryNotes?: string | null; internalNotes?: string | null };
    // Notes and time: kept until the ticket has new activity (or we change it)
    const extrasKey = `detail:${id}:${fromList?.updatedAt ?? "?"}`;
    const loadExtras = async () => {
      const [noteFields, timeFields] = await Promise.all([
        safeFields(at, "TicketNotes", ["id", "title", "description", "createDateTime", "creatorResourceID", "createdByContactID", "creatorContactID", "publish"]),
        safeFields(at, "TimeEntries", ["id", "resourceID", "dateWorked", "startDateTime", "createDateTime", "hoursWorked", "summaryNotes", "internalNotes"]),
      ]);
      const [notes, times] = await Promise.all([
        at.query<AtNote>("TicketNotes", [{ op: "eq", field: "ticketID", value: id }], { fields: noteFields, max: 300 }).catch(soft("notes", [] as AtNote[])),
        at.query<AtTime>("TimeEntries", [{ op: "eq", field: "ticketID", value: id }], { fields: timeFields, max: 500 }).catch(soft("time", [] as AtTime[])),
      ]);
      return { notes, times, warnings: [...warnings] };
    };
    const [t, extras, res] = await Promise.all([loadTicket(), cached(extrasKey, fromList ? 10 * 60_000 : 30_000, loadExtras), listResources()]);
    // a part failed: shown with a warning, asked again next time
    if (extras.warnings.length) forget(extrasKey);
    const { notes, times } = extras;
    if (!t) return null;
    t.warnings = extras.warnings;
    const internalValues = new Set((await atOptions()).publish.filter((p) => /intern/i.test(p.label)).map((p) => String(p.value)));
    const contactOf = (n: AtNote) => n.createdByContactID ?? n.creatorContactID ?? null;
    const contactIds = notes.map(contactOf).filter((x): x is number => Boolean(x));
    const contactMap = contactIds.length ? await contactNames(at, contactIds).catch(() => new Map<number, string>()) : new Map<number, string>();
    const resourceName = (rid?: number | null) => (rid ? (res.find((r) => r.id === rid)?.name ?? `#${rid}`) : null);
    // Written from the portal: the technician (even if Autotask shows the API user)
    const authors = await db()
      .select({ entity: schema.autotaskAuthors.entity, autotaskId: schema.autotaskAuthors.autotaskId, name: schema.users.name })
      .from(schema.autotaskAuthors)
      .innerJoin(schema.users, eq(schema.users.id, schema.autotaskAuthors.userId))
      .where(eq(schema.autotaskAuthors.ticketId, id));
    const portalAuthor = (entity: "note" | "time", aid: number) => authors.find((x) => x.entity === entity && x.autotaskId === aid)?.name ?? null;
    const noteItems: Note[] = notes.map((n) => ({
      id: `n${n.id}`,
      author: portalAuthor("note", n.id) ?? resourceName(n.creatorResourceID) ?? (contactOf(n) ? (contactMap.get(contactOf(n)!) ?? "") : "Autotask"),
      at: n.createDateTime,
      text: [n.title, n.description].filter(Boolean).join("\n").trim(),
      internal: internalValues.has(String(n.publish)),
      kind: "note",
    }));
    // Time entries = the work done on the ticket (summary for the client, internal note for the team)
    const timeItems: Note[] = times.map((x) => ({
      id: `t${x.id}`,
      author: portalAuthor("time", x.id) ?? resourceName(x.resourceID) ?? "Autotask",
      at: x.startDateTime ?? x.dateWorked ?? x.createDateTime ?? "",
      text: (x.summaryNotes ?? "").trim(),
      internal: false,
      kind: "time",
      hours: x.hoursWorked ?? 0,
      internalText: (x.internalNotes ?? "").trim() || undefined,
    }));
    t.notes = [...noteItems, ...timeItems].sort((a, b) => a.at.localeCompare(b.at));
    t.hours = Math.round(times.reduce((sum, x) => sum + (x.hoursWorked ?? 0), 0) * 100) / 100;
    return t;
  },

  async update(id, p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const opts = await atOptions();
    const patch: Record<string, unknown> = { id };
    if (p.status !== undefined) {
      if (!opts.statuses.some((s) => s.value === p.status)) throw new SourceError("invalid_value");
      patch.status = Number(p.status);
    }
    if (p.priority !== undefined) {
      if (!opts.priorities.some((s) => s.value === p.priority)) throw new SourceError("invalid_value");
      patch.priority = Number(p.priority);
    }
    if (p.queue !== undefined) {
      if (!opts.queues.some((s) => s.value === p.queue)) throw new SourceError("invalid_value");
      patch.queueID = Number(p.queue);
    }
    if (p.dueDate) patch.dueDateTime = dueIso(p.dueDate);
    if (p.companyId !== undefined) {
      patch.companyID = p.companyId;
      if (p.contactId === undefined) patch.contactID = null;
    }
    if (p.contactId !== undefined) {
      if (p.contactId) {
        const companyId = p.companyId ?? (await this.get(id))?.company.id;
        const ok = (await this.contacts(companyId!)).some((x) => x.id === p.contactId);
        if (!ok) throw new SourceError("invalid_contact");
      }
      patch.contactID = p.contactId ? Number(p.contactId) : null;
    }
    if (p.assigneeId !== undefined) {
      if (p.assigneeId) {
        const rid = await resourceIdOf(p.assigneeId);
        if (!rid) throw new SourceError("invalid_assignee");
        patch.assignedResourceID = rid;
        patch.assignedResourceRoleID = await roleOf(at, rid);
      } else {
        patch.assignedResourceID = null;
        patch.assignedResourceRoleID = null;
      }
    }
    if (p.title !== undefined) patch.title = p.title;
    if (p.description !== undefined) patch.description = p.description;
    if (p.assetId !== undefined) {
      if (p.assetId) {
        const companyId = p.companyId ?? (await this.get(id))?.company.id;
        if (!companyId || !(await this.assets(companyId)).some((x) => x.id === p.assetId)) throw new SourceError("invalid_value");
      }
      patch.configurationItemID = p.assetId ? Number(p.assetId) : null;
    }
    if (Object.keys(patch).length > 1) await at.call("PATCH", "Tickets", patch, { impersonate: actor });
    if (p.secondaryIds) await setSecondary(at, id, p.secondaryIds, actor);
    await refreshOne(at, id);
  },

  async addNote(id, p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const opts = await atOptions();
    const noteType = opts.noteTypes.find((n) => /task|tâche|detail|détail/i.test(n.label)) ?? opts.noteTypes[0];
    const publish = opts.publish.find((x) => (p.internal ? /intern/i : /all|tous|client|customer/i).test(x.label)) ?? opts.publish[0];
    const res = await at.call<{ itemId: number }>(
      "POST",
      `Tickets/${id}/Notes`,
      {
        ticketID: id,
        title: p.text.split("\n")[0].slice(0, 120) || "Note",
        description: p.text,
        noteType: noteType ? Number(noteType.value) : 1,
        publish: publish ? Number(publish.value) : p.internal ? 2 : 1,
      },
      { impersonate: actor, asApiUser: signText(a, "description") },
    );
    await rememberAuthor("note", res?.itemId, id, a);
    forget(`detail:${id}:`);
    // the list does not show notes: no reload
  },

  async create(p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const opts = await atOptions();
    const rid = p.assigneeId ? await resourceIdOf(p.assigneeId) : null;
    if (p.assigneeId && !rid) throw new SourceError("invalid_assignee");
    const newStatus = opts.statuses.find((s) => s.kind === "new") ?? opts.statuses[0];
    const res = await at.call<{ itemId: number }>(
      "POST",
      "Tickets",
      {
        companyID: p.companyId,
        contactID: p.contactId ? Number(p.contactId) : null,
        title: p.title,
        description: p.description || undefined,
        status: Number(newStatus.value),
        priority: Number(p.priority),
        queueID: p.queue ? Number(p.queue) : undefined,
        dueDateTime: dueIso(p.dueDate),
        ...(rid ? { assignedResourceID: rid, assignedResourceRoleID: await roleOf(at, rid) } : {}),
      },
      { impersonate: actor, asApiUser: signText(a, "description") },
    );
    await refreshOne(at, res.itemId);
    return res.itemId;
  },

  async companies() {
    const at = await autotask();
    return cached("companies", 60 * 60_000, async () =>
      (await at.query<{ id: number; companyName: string }>("Companies", [{ op: "eq", field: "isActive", value: true }], { fields: ["id", "companyName"], max: 10_000 }))
        .map((c) => ({ id: c.id, name: c.companyName }))
        .sort((x, y) => x.name.localeCompare(y.name)),
      { stale: true },
    );
  },

  async contacts(companyId) {
    const at = await autotask();
    return cached(`contacts:${companyId}`, 5 * 60_000, async () =>
      (
        await at.query<{ id: number; firstName: string; lastName: string; emailAddress: string | null; phone: string | null }>(
          "Contacts",
          [
            { op: "eq", field: "companyID", value: companyId },
            { op: "eq", field: "isActive", value: 1 },
          ],
          { fields: ["id", "firstName", "lastName", "emailAddress", "phone"], max: 2000 },
        )
      )
        .map((c) => ({ id: String(c.id), companyId, name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(), email: c.emailAddress || null, phone: c.phone || null }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    );
  },

  async assets(companyId) {
    const at = await autotask();
    return cached(`assets:${companyId}`, 10 * 60_000, async () => {
      type AtCi = Record<string, string | number | boolean | null | undefined> & { id: number };
      const fields = await safeFields(at, "ConfigurationItems", [
        "id",
        "referenceTitle",
        "referenceNumber",
        "serialNumber",
        "configurationItemType",
        "contactID",
        "warrantyExpirationDate",
        "rmmDeviceID",
        "rmmDeviceUID",
        "rmmDeviceAuditHostname",
        "rmmDeviceAuditIPAddress",
        "rmmDeviceAuditOperatingSystem",
        "rmmDeviceAuditLastUser",
        "dattoHostname",
        "dattoInternalIP",
        "dattoSerialNumber",
        "dattoLastCheckInDateTime",
      ]);
      const [rows, types, contacts] = await Promise.all([
        at.query<AtCi>(
          "ConfigurationItems",
          [
            { op: "eq", field: "companyID", value: companyId },
            { op: "eq", field: "isActive", value: true },
          ],
          { fields, max: 2000 },
        ),
        fieldsOf(at, "ConfigurationItems")
          .then((f) => picklist(f, "configurationItemType"))
          .catch(() => [] as PicklistValue[]),
        this.contacts(companyId).catch(() => [] as Contact[]),
      ]);
      const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
      return rows
        .map((r): Asset => {
          const contactId = s(r.contactID);
          const hostname = s(r.rmmDeviceAuditHostname) ?? s(r.dattoHostname);
          return {
            id: String(r.id),
            name: s(r.referenceTitle) ?? hostname ?? s(r.referenceNumber) ?? `#${r.id}`,
            type: types.find((x) => String(x.value) === s(r.configurationItemType))?.label ?? null,
            serial: s(r.serialNumber) ?? s(r.dattoSerialNumber),
            companyId,
            contactId,
            contactName: contactId ? (contacts.find((c) => c.id === contactId)?.name ?? null) : null,
            hostname,
            ip: s(r.rmmDeviceAuditIPAddress) ?? s(r.dattoInternalIP),
            os: s(r.rmmDeviceAuditOperatingSystem),
            lastUser: s(r.rmmDeviceAuditLastUser),
            lastSeen: s(r.dattoLastCheckInDateTime),
            warrantyEnd: s(r.warrantyExpirationDate),
            rmm: { id: s(r.rmmDeviceID), uid: s(r.rmmDeviceUID) },
          };
        })
        .sort((x, y) => x.name.localeCompare(y.name));
    });
  },

  async searchArchive(q) {
    const at = await autotask();
    const text = q.trim();
    const byNumber = /^T\d{8}\.\d{3,5}$/i.test(text);
    const rows = await at.query<AtTicket>("Tickets", [byNumber ? { op: "eq", field: "ticketNumber", value: text.toUpperCase() } : { op: "contains", field: "title", value: text }], {
      fields: TICKET_FIELDS,
      max: 25,
    });
    return normalize(at, rows, false);
  },

  async charges(ticketId) {
    const at = await autotask();
    return cached(`charges:${ticketId}`, 5 * 60_000, async () => {
      type AtCharge = { id: number; name?: string; description?: string | null; unitQuantity?: number; unitPrice?: number | null; unitCost?: number | null; isBillableToCompany?: boolean; chargeType?: number; status?: number; billingCodeID?: number | null; datePurchased?: string | null; creatorResourceID?: number | null };
      const fields = await safeFields(at, "TicketCharges", ["id", "name", "description", "unitQuantity", "unitPrice", "unitCost", "isBillableToCompany", "chargeType", "status", "billingCodeID", "datePurchased", "creatorResourceID"]);
      const [rows, o, res] = await Promise.all([
        at.query<AtCharge>("TicketCharges", [{ op: "eq", field: "ticketID", value: ticketId }], { fields, max: 500 }),
        this.chargeOptions(),
        listResources().catch(() => []),
      ]);
      const label = (list: { value: string; label: string }[], v: unknown) => (v === null || v === undefined ? null : (list.find((x) => x.value === String(v))?.label ?? null));
      return rows.map(
        (r): Charge => ({
          id: String(r.id),
          name: r.name ?? "",
          description: r.description ?? "",
          quantity: r.unitQuantity ?? 0,
          unitPrice: r.unitPrice ?? null,
          unitCost: r.unitCost ?? null,
          billable: r.isBillableToCompany !== false,
          type: label(o.types, r.chargeType),
          status: label(o.statuses, r.status),
          materialCode: label(o.materialCodes, r.billingCodeID),
          date: r.datePurchased ?? null,
          author: r.creatorResourceID ? (res.find((x) => x.id === r.creatorResourceID)?.name ?? null) : null,
        }),
      );
    });
  },

  async chargeOptions() {
    const at = await autotask();
    return cached("chargeOptions", 60 * 60_000, async () => {
      const [fields, codeFields] = await Promise.all([fieldsOf(at, "TicketCharges"), fieldsOf(at, "BillingCodes").catch(() => [] as FieldInfo[])]);
      const list = (name: string) => picklist(fields, name).map((v) => ({ value: String(v.value), label: v.label }));
      // Material codes: billing codes whose use type is "Material…"
      const materialUse = picklist(codeFields, "useType")
        .filter((v) => /mat/i.test(v.label))
        .map((v) => Number(v.value));
      const codes = materialUse.length
        ? await at
            .query<{ id: number; name: string }>(
              "BillingCodes",
              [
                { op: "in", field: "useType", value: materialUse },
                { op: "eq", field: "isActive", value: true },
              ],
              { fields: ["id", "name"], max: 500 },
            )
            .catch(() => [] as { id: number; name: string }[])
        : [];
      return {
        types: list("chargeType"),
        statuses: list("status"),
        materialCodes: codes.map((c) => ({ value: String(c.id), label: c.name })).sort((x, y) => x.label.localeCompare(y.label)),
      };
    });
  },

  async products(q) {
    const at = await autotask();
    const text = q.trim();
    return cached(`products:${text.toLowerCase()}`, 2 * 60_000, async () => {
      const fields = await safeFields(at, "Products", [
        "id",
        "name",
        "description",
        "sku",
        "manufacturerName",
        "manufacturerProductName",
        "unitPrice",
        "unitCost",
        "billingCodeID",
        "chargeBillingCodeID",
        "productBillingCodeID",
      ]);
      // Search only the fields this Autotask has (an unknown field fails the query)
      const searchable = ["name", "sku", "manufacturerProductName"].filter((x) => fields.includes(x));
      const rows = await at.query<Record<string, string | number | null> & { id: number }>(
        "Products",
        [
          { op: "eq", field: "isActive", value: true },
          { op: "or", items: searchable.map((field) => ({ op: "contains", field, value: text })) },
        ],
        { fields, max: 25 },
      );
      return rows.map(productOf);
    });
  },

  async addCharge(ticketId, p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const o = await this.chargeOptions();
    const known = (list: { value: string }[], v: string | null) => !v || list.some((x) => x.value === v);
    if (!known(o.types, p.typeId) || !known(o.statuses, p.statusId) || !known(o.materialCodes, p.materialCodeId)) throw new SourceError("invalid_value");
    await at.call(
      "POST",
      `Tickets/${ticketId}/Charges`,
      {
        ticketID: ticketId,
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        unitQuantity: p.quantity,
        ...(p.unitPrice !== null ? { unitPrice: p.unitPrice } : {}),
        ...(p.unitCost !== null ? { unitCost: p.unitCost } : {}),
        isBillableToCompany: p.billable,
        chargeType: Number(p.typeId ?? o.types[0]?.value ?? 1),
        ...((p.statusId ?? approvedStatus(o.statuses)?.value) ? { status: Number(p.statusId ?? approvedStatus(o.statuses).value) } : {}),
        ...(p.materialCodeId ? { billingCodeID: Number(p.materialCodeId) } : {}),
        ...(p.productId ? { productID: Number(p.productId) } : {}),
        datePurchased: p.date ? `${p.date}T12:00:00Z` : new Date().toISOString(),
      },
      { impersonate: actor, asApiUser: signText(a, "description") },
    );
    forget(`charges:${ticketId}`);
  },

  async contactByPhone(phone) {
    const at = await autotask();
    return cached(`contactByPhone:${phone}`, 10 * 60_000, async () => {
      type AtContact = { id: number; companyID: number; firstName?: string; lastName?: string; phone?: string | null; mobilePhone?: string | null; alternatePhone?: string | null };
      const fields = await safeFields(at, "Contacts", ["id", "companyID", "firstName", "lastName", "phone", "mobilePhone", "alternatePhone"]);
      const searchable = ["phone", "mobilePhone", "alternatePhone"].filter((x) => fields.includes(x));
      // numbers are stored in many formats: look for the last 4 digits, then compare all 10
      const rows = await at.query<AtContact>(
        "Contacts",
        [
          { op: "eq", field: "isActive", value: 1 },
          { op: "or", items: searchable.map((field) => ({ op: "contains", field, value: phone.slice(-4) })) },
        ],
        { fields, max: 500 },
      );
      const same = (v?: string | null) => (v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") === phone;
      const hit = rows.find((r) => same(r.mobilePhone) || same(r.phone) || same(r.alternatePhone));
      if (!hit) return null;
      const names = await companyNames(at, [hit.companyID]);
      return {
        contactId: String(hit.id),
        contactName: `${hit.firstName ?? ""} ${hit.lastName ?? ""}`.trim(),
        companyId: hit.companyID,
        companyName: names.get(hit.companyID) ?? `#${hit.companyID}`,
      };
    });
  },

  async addSystemNote(ticketId, text) {
    const at = await autotask();
    const opts = await atOptions();
    const noteType = opts.noteTypes.find((n) => /task|tâche|detail|détail/i.test(n.label)) ?? opts.noteTypes[0];
    const publish = opts.publish.find((x) => /intern/i.test(x.label)) ?? opts.publish[0];
    await at.call("POST", `Tickets/${ticketId}/Notes`, {
      ticketID: ticketId,
      title: text.split("\n")[0].slice(0, 120) || "Texto",
      description: text,
      noteType: noteType ? Number(noteType.value) : 1,
      publish: publish ? Number(publish.value) : 2,
    });
    forget(`detail:${ticketId}:`);
  },

  async createSystem(p) {
    const at = await autotask();
    const opts = await atOptions();
    const fields = await fieldsOf(at, "Tickets").catch(() => [] as FieldInfo[]);
    const source = picklist(fields, "source").find((s) => /sms|text/i.test(s.label));
    const newStatus = opts.statuses.find((s) => s.kind === "new") ?? opts.statuses[0];
    // the portal's own API user: no technician to act for
    const res = await at.call<{ itemId: number }>("POST", "Tickets", {
      companyID: p.companyId,
      contactID: p.contactId ? Number(p.contactId) : null,
      title: p.title,
      description: p.description || undefined,
      status: Number(newStatus.value),
      priority: Number(p.priority),
      queueID: p.queue ? Number(p.queue) : undefined,
      dueDateTime: dueIso(p.dueDate),
      ...(source ? { source: Number(source.value) } : {}),
    });
    await refreshOne(at, res.itemId);
    const t = (await mirrorMap()).get(res.itemId) ?? (await this.get(res.itemId));
    return { id: res.itemId, number: t?.number ?? String(res.itemId) };
  },

  async createServiceCall(p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const t = await this.get(p.ticketId);
    if (!t) throw new SourceError("not_found");
    const status = picklist(await fieldsOf(at, "ServiceCalls").catch(() => [] as FieldInfo[]), "status")[0];
    const sc = await at.call<{ itemId: number }>(
      "POST",
      "ServiceCalls",
      {
        companyID: t.company.id,
        description: p.description.slice(0, 2000),
        startDateTime: p.startsAt.toISOString(),
        endDateTime: p.endsAt.toISOString(),
        ...(status ? { status: Number(status.value) } : {}),
      },
      { impersonate: actor },
    );
    // the ticket on the call, and the technician on that ticket
    const sct = await at.call<{ itemId: number }>("POST", `ServiceCalls/${sc.itemId}/Tickets`, { serviceCallID: sc.itemId, ticketID: p.ticketId }, { impersonate: actor });
    const rid = await resourceIdOf(p.technicianId);
    if (rid) {
      await at.call(
        "POST",
        `ServiceCallTickets/${sct.itemId}/Resources`,
        { serviceCallTicketID: sct.itemId, resourceID: rid, roleID: await roleOf(at, rid) },
        { impersonate: actor },
      );
    }
    return sc.itemId;
  },
  async updateServiceCall(id, p, a) {
    const at = await autotask();
    await at.call("PATCH", "ServiceCalls", { id, startDateTime: p.startsAt.toISOString(), endDateTime: p.endsAt.toISOString() }, { impersonate: await actorResource(a) });
  },
  async deleteServiceCall(id, a) {
    const at = await autotask();
    await at.call("DELETE", `ServiceCalls/${id}`, undefined, { impersonate: await actorResource(a) });
  },

  async workTypes() {
    const at = await autotask();
    return cached("workTypes", 30 * 60_000, async () => {
      // Billing codes of type "work type" (useType 1), active
      const rows = await at
        .query<{ id: number; name: string }>(
          "BillingCodes",
          [
            { op: "eq", field: "useType", value: 1 },
            { op: "eq", field: "isActive", value: true },
          ],
          { fields: ["id", "name"], max: 500 },
        )
        .catch(() => [] as { id: number; name: string }[]);
      return rows.map((r) => ({ value: String(r.id), label: r.name })).sort((x, y) => x.label.localeCompare(y.label));
    });
  },

  async addTimeEntry(ticketId, p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const end = p.endedAt;
    const start = new Date(end.getTime() - Math.round(p.hours * 3_600_000));
    const res = await at.call<{ itemId: number }>(
      "POST",
      "TimeEntries",
      {
        ticketID: ticketId,
        resourceID: actor,
        roleID: await roleOf(at, actor),
        dateWorked: start.toISOString(),
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        hoursWorked: Math.round(p.hours * 100) / 100,
        summaryNotes: p.summary,
        ...(p.internal ? { internalNotes: p.internal } : {}),
        ...(p.workTypeId ? { billingCodeID: Number(p.workTypeId) } : {}),
      },
      { impersonate: actor },
    );
    await rememberAuthor("time", res?.itemId, ticketId, a);
    forget(`detail:${ticketId}:`);
  },

  async addContact(companyId, p, a) {
    const at = await autotask();
    const actor = await actorResource(a);
    const res = await at.call<{ itemId: number }>(
      "POST",
      `Companies/${companyId}/Contacts`,
      { companyID: companyId, firstName: p.firstName, lastName: p.lastName, emailAddress: p.email || undefined, phone: p.phone || undefined, isActive: 1 },
      { impersonate: actor },
    );
    forget(`contacts:${companyId}`);
    return { id: String(res.itemId), companyId, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone };
  },
};
