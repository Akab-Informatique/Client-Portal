import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { AuthContext } from "./auth.ts";
import { autotask, AutotaskError, listResources, loadSettings, type Client } from "./autotask.ts";
import {
  addDemoContact,
  addDemoNote,
  addDemoTicket,
  demoCompanies,
  demoContact,
  demoContacts,
  demoTickets,
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
export type Note = { id: string; author: string; at: string; text: string; internal: boolean };
export type Company = { id: number; name: string };
export type Contact = { id: string; companyId: number; name: string; email: string | null; phone: string | null };
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
};
export type TicketPatch = {
  status?: string;
  priority?: string;
  queue?: string;
  assigneeId?: string | null;
  dueDate?: string;
  companyId?: number;
  contactId?: string | null;
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
  async contacts(companyId) {
    return demoContacts(companyId);
  },
  async addContact(companyId, p) {
    if (!demoCompanies().some((x) => x.id === companyId)) throw new SourceError("invalid_company");
    return addDemoContact({ companyId, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone });
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
  source: number | null;
};
const TICKET_FIELDS = [
  "id",
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
export const clearTicketCache = () => {
  cache.clear();
  loading.clear();
};

/**
 * Keep the Autotask ticket list warm: load it at start-up and refresh it in
 * the background while the portal is being used (stops after 15 min idle).
 */
let lastUse = 0;
let warmTimer: ReturnType<typeof setInterval> | null = null;
export function keepTicketsWarm() {
  if (warmTimer) return;
  const tick = async () => {
    if (Date.now() - lastUse > 15 * 60_000 && cache.has("list")) return;
    const src = await ticketSource();
    if (src.demo) return;
    await load("list", () => loadList()).catch((e) => console.warn("[autotask] warm-up failed:", e instanceof Error ? e.message : e));
  };
  void tick();
  warmTimer = setInterval(() => void tick(), 25_000);
  warmTimer.unref?.();
}

const picklist = (fields: FieldInfo[], name: string) =>
  (fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.picklistValues ?? [])
    .filter((v) => v.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

async function fieldsOf(at: Client, entity: string): Promise<FieldInfo[]> {
  return cached(`fields:${entity}`, 10 * 60_000, async () => (await at.call<{ fields: FieldInfo[] }>("GET", `${entity}/entityInformation/fields`)).fields ?? []);
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

async function companyNames(at: Client, ids: number[]): Promise<Map<number, string>> {
  const all = await autotaskSource.companies().catch(() => [] as Company[]);
  const map = new Map(all.map((c) => [c.id, c.name]));
  const missing = [...new Set(ids)].filter((id) => !map.has(id));
  for (const part of chunks(missing, 200)) {
    const rows = await at.query<{ id: number; companyName: string }>("Companies", [{ op: "in", field: "id", value: part }], { fields: ["id", "companyName"] });
    for (const r of rows) map.set(r.id, r.companyName);
  }
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
    });
  }
  return out;
}

/**
 * After a change: reload just this ticket and put it in the cached list
 * (instead of reloading the whole list from Autotask).
 */
async function refreshOne(at: Client, id: number): Promise<void> {
  const hit = cache.get("list");
  if (!hit) return;
  try {
    const item = (await at.call<{ item: AtTicket | null }>("GET", `Tickets/${id}`)).item;
    const listNow = (cache.get("list")?.value as NTicket[] | undefined) ?? [];
    const others = listNow.filter((x) => x.id !== id);
    const next = item ? [...others, (await normalize(at, [item], true))[0]] : others;
    cache.set("list", { at: hit.at, value: next });
  } catch {
    forget("list");
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
  return cached("options", 10 * 60_000, async () => {
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

  /** Open tickets + those completed in the last 14 days (cached 30 s for everyone). */
  async list() {
    lastUse = Date.now();
    return cached("list", 30_000, loadList, { stale: true });
  },

  async get(id) {
    const at = await autotask();
    const fromList = (cache.get("list")?.value as NTicket[] | undefined)?.find((x) => x.id === id);
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
    const [t, notes, times, res] = await Promise.all([
      loadTicket(),
      at.query<{ id: number; title: string; description: string; createDateTime: string; creatorResourceID: number | null; creatorContactID: number | null; publish: number }>(
        "TicketNotes",
        [{ op: "eq", field: "ticketID", value: id }],
        { fields: ["id", "title", "description", "createDateTime", "creatorResourceID", "creatorContactID", "publish"], max: 200 },
      ),
      at.query<{ hoursWorked: number }>("TimeEntries", [{ op: "eq", field: "ticketID", value: id }], { fields: ["hoursWorked"], max: 500 }).catch(() => []),
      listResources(),
    ]);
    if (!t) return null;
    const internalValues = new Set((await atOptions()).publish.filter((p) => /intern/i.test(p.label)).map((p) => String(p.value)));
    const contactIds = notes.map((n) => n.creatorContactID).filter((x): x is number => Boolean(x));
    const contactMap = contactIds.length ? await contactNames(at, contactIds) : new Map<number, string>();
    t.notes = notes
      .map((n) => ({
        id: String(n.id),
        author: n.creatorResourceID
          ? (res.find((r) => r.id === n.creatorResourceID)?.name ?? `#${n.creatorResourceID}`)
          : n.creatorContactID
            ? (contactMap.get(n.creatorContactID) ?? "")
            : "Autotask",
        at: n.createDateTime,
        text: [n.title, n.description].filter(Boolean).join("\n").trim(),
        internal: internalValues.has(String(n.publish)),
      }))
      .sort((x, y) => x.at.localeCompare(y.at));
    t.hours = Math.round(times.reduce((s, x) => s + (x.hoursWorked ?? 0), 0) * 100) / 100;
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
    await at.call("PATCH", "Tickets", patch, { impersonate: actor });
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
    return cached("companies", 10 * 60_000, async () =>
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
