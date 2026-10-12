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
  /** Work types for time entries (Autotask billing codes); empty when not used */
  workTypes(): Promise<{ value: string; label: string }[]>;
  addTimeEntry(ticketId: number, p: NewTimeEntry, a: AuthContext): Promise<void>;
}

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
  async workTypes() {
    return [];
  },
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
    const noteItems: Note[] = notes.map((n) => ({
      id: `n${n.id}`,
      author: resourceName(n.creatorResourceID) ?? (contactOf(n) ? (contactMap.get(contactOf(n)!) ?? "") : "Autotask"),
      at: n.createDateTime,
      text: [n.title, n.description].filter(Boolean).join("\n").trim(),
      internal: internalValues.has(String(n.publish)),
      kind: "note",
    }));
    // Time entries = the work done on the ticket (summary for the client, internal note for the team)
    const timeItems: Note[] = times.map((x) => ({
      id: `t${x.id}`,
      author: resourceName(x.resourceID) ?? "Autotask",
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
    await at.call(
      "POST",
      `Tickets/${id}/Notes`,
      {
        ticketID: id,
        title: p.text.split("\n")[0].slice(0, 120) || "Note",
        description: p.text,
        noteType: noteType ? Number(noteType.value) : 1,
        publish: publish ? Number(publish.value) : p.internal ? 2 : 1,
      },
      { impersonate: actor },
    );
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
      { impersonate: actor },
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
    await at.call(
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
