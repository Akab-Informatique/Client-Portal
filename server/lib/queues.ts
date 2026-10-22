import { openItems } from "./checklist.ts";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import type { Asset } from "./demoTickets.ts";
import { SourceError, type Choice, type HistoryTicket, type NewTicket, type NTicket, type Options, type TicketPatch, type TicketSource } from "./ticketSource.ts";

/**
 * The portal's own ticket queues (Admin › Files d'attente): Support, Alertes
 * and Projets to start. A ticket is in the queue stored on it in the portal;
 * without one, the queue its source suggests (a monitoring alert, a project),
 * else the default.
 */
export type Queue = typeof schema.ticketQueues.$inferSelect;

let cache: { at: number; rows: Queue[] } | null = null;
/** After a change (this instance only: one app instance) */
export const forgetQueues = () => {
  cache = null;
};

export async function queues(): Promise<Queue[]> {
  if (cache && Date.now() - cache.at < 5_000) return cache.rows;
  const rows = await db().select().from(schema.ticketQueues).orderBy(asc(schema.ticketQueues.position), asc(schema.ticketQueues.name));
  cache = { at: Date.now(), rows };
  return rows;
}

export type Source = typeof schema.ticketSources.$inferSelect;
let srcCache: { at: number; rows: Source[] } | null = null;
export const forgetSources = () => {
  srcCache = null;
};
/** Where tickets come from, in order (Admin › Sources). */
export async function sources(): Promise<Source[]> {
  if (srcCache && Date.now() - srcCache.at < 5_000) return srcCache.rows;
  const rows = await db().select().from(schema.ticketSources).orderBy(asc(schema.ticketSources.position), asc(schema.ticketSources.name));
  srcCache = { at: Date.now(), rows };
  return rows;
}

type StatusRow = typeof schema.ticketStatuses.$inferSelect;
let stCache: { at: number; rows: StatusRow[] } | null = null;
export const forgetStatuses = () => {
  stCache = null;
};
export async function statusConfig(): Promise<StatusRow[]> {
  if (stCache && Date.now() - stCache.at < 5_000) return stCache.rows;
  const rows = await db().select().from(schema.ticketStatuses);
  stCache = { at: Date.now(), rows };
  return rows;
}

/** The source's statuses with the portal's wording, kind, order and visibility over them (Admin › Statuts). */
export async function withStatusConfig<T extends { value: string; label: string | null; kind: string; hidden?: boolean }>(list: T[]): Promise<T[]> {
  const cfg = new Map((await statusConfig()).map((r) => [r.value, r]));
  return list
    .map((s, i) => {
      const c = cfg.get(s.value);
      return { s: { ...s, label: c?.label || s.label, kind: (c?.kind as T["kind"]) || s.kind, hidden: c?.hidden ?? s.hidden ?? false } as T, pos: c ? c.position : 1000 + i };
    })
    .sort((x, y) => x.pos - y.pos)
    .map((x) => x.s);
}

/**
 * The portal's source for a ticket without one stored: from the label its own
 * source gives ("Email", "Phone"…). Monitoring alerts keep their label
 * (the alert detection reads it); anything else made by hand is a phone ticket.
 */
function sourceFromLabel(list: Source[], raw: string | undefined): string {
  const has = (k: string) => list.some((x) => x.key === k);
  const v = raw ?? "";
  if (/alert|monitor/i.test(v)) return v;
  const guess = /e-?mail|courriel/i.test(v) ? "email" : /sms|text|texto/i.test(v) ? "sms" : /person|sur place|on-?site|walk/i.test(v) ? "in-person" : "phone";
  return has(guess) ? guess : (list[0]?.key ?? v);
}

const choice = (q: Queue): Choice<"" | "alerts"> => ({ value: q.key, label: q.name, kind: q.alerts ? "alerts" : "" });

/** The queue a ticket falls in when none is stored on it: from what its source says. */
function suggested(list: Queue[], label: string, source: string | undefined): string {
  const fallback = list.find((q) => q.isDefault)?.key ?? list[0]?.key ?? "";
  const alerts = list.find((q) => q.alerts);
  if (alerts && (/alert/i.test(label) || /alert|monitor/i.test(source ?? ""))) return alerts.key;
  if (/projet|project/i.test(label)) return list.find((q) => q.key === "projects")?.key ?? fallback;
  return fallback;
}

/** The ticket source with the portal's queues over it. */
export function withPortalQueues(src: TicketSource): TicketSource {
  const d = Object.create(src) as TicketSource;
  /** The source's own queue labels, used only to suggest a first queue */
  const sourceLabels = async () => new Map((await src.options()).queues.map((q) => [q.value, q.label ?? q.value]));
  const stored = async () => new Map((await db().select({ id: schema.ticketMeta.ticketId, queue: schema.ticketMeta.queue, source: schema.ticketMeta.source }).from(schema.ticketMeta)).map((r) => [r.id, r]));

  /** Maps each ticket (or history row) to its portal queue */
  const mapper = async () => {
    const [list, labels, own, srcs] = await Promise.all([queues(), sourceLabels(), stored(), sources()]);
    const known = new Set(list.map((q) => q.key));
    const knownSources = new Set(srcs.map((x) => x.key));
    return <T extends { id: number; queue: string; source?: string }>(t: T): T => {
      const mine = own.get(t.id);
      const q = mine?.queue;
      const src = mine?.source && knownSources.has(mine.source) ? mine.source : sourceFromLabel(srcs, t.source);
      // the queue is worked out from the source's own label (a monitoring alert…), before the portal's source replaces it
      return { ...t, queue: q && known.has(q) ? q : suggested(list, labels.get(t.queue) ?? t.queue, t.source), source: src };
    };
  };
  const validQueue = async (key: string | undefined) => {
    if (key && !(await queues()).some((q) => q.key === key)) throw new SourceError("invalid_value");
  };
  const remember = async (id: number, key: string | undefined) => {
    if (!key) return;
    await db().insert(schema.ticketMeta).values({ ticketId: id, queue: key }).onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { queue: key, updatedAt: new Date() } });
  };
  const validSource = async (key: string | undefined) => {
    if (key && !(await sources()).some((x) => x.key === key)) throw new SourceError("invalid_value");
  };
  const rememberSource = async (id: number, key: string | undefined) => {
    if (!key) return;
    await db().insert(schema.ticketMeta).values({ ticketId: id, source: key }).onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { source: key, updatedAt: new Date() } });
  };

  d.options = async (): Promise<Options> => {
    const o = await src.options();
    return {
      ...o,
      statuses: await withStatusConfig(o.statuses),
      queues: (await queues()).map(choice),
      ticketSources: (await sources()).map((x) => ({ value: x.key, label: x.name, kind: "" })),
    };
  };
  d.list = async () => {
    const [all, map] = await Promise.all([src.list(), mapper()]);
    return all.map(map);
  };
  d.get = async (id) => {
    const t = await src.get(id);
    if (!t) return null;
    const mapped = (await mapper())(t);
    // a device made in the portal wins over the source's own
    const [m] = await db().select({ a: schema.ticketMeta.localAsset }).from(schema.ticketMeta).where(eq(schema.ticketMeta.ticketId, id));
    return m?.a ? { ...mapped, assetId: LOCAL + m.a } : mapped;
  };
  d.assets = async (companyId) => [...(await src.assets(companyId)), ...(await localAssets(companyId))];
  d.history = async (since): Promise<HistoryTicket[]> => {
    const [rows, map] = await Promise.all([src.history(since), mapper()]);
    return rows.map(map);
  };
  d.companyHistory = async (companyId): Promise<NTicket[]> => {
    const [rows, map] = await Promise.all([src.companyHistory(companyId), mapper()]);
    return rows.map(map);
  };
  d.create = async (p: NewTicket, a) => {
    await validQueue(p.queue);
    await validSource(p.source);
    const id = await src.create({ ...p, queue: "" }, a);
    await remember(id, p.queue);
    // made by hand (or by phone) unless said otherwise
    await rememberSource(id, p.source ?? "phone");
    return id;
  };
  d.createSystem = async (p: NewTicket) => {
    await validQueue(p.queue);
    await validSource(p.source);
    const made = await src.createSystem({ ...p, queue: "" });
    await remember(made.id, p.queue);
    await rememberSource(made.id, p.source ?? "sms");
    return made;
  };
  d.update = async (id: number, p: TicketPatch, a) => {
    await validQueue(p.queue);
    await validSource(p.source);
    // a ticket with an open checklist item cannot be completed (whatever way the status is changed)
    if (p.status !== undefined && (await d.options()).statuses.find((s) => s.value === p.status)?.kind === "complete" && (await openItems(id)) > 0) throw new SourceError("checklist_open");
    const { queue, source, ...r } = p;
    const rest: TicketPatch = { ...r };
    await remember(id, queue);
    await rememberSource(id, source);
    if (p.assetId !== undefined) {
      // a portal device is kept here only (the source's device is cleared); any other pick drops it
      const local = p.assetId?.startsWith(LOCAL) ? p.assetId.slice(LOCAL.length) : null;
      if (local && !(await localAssets()).some((x) => x.id === p.assetId)) throw new SourceError("invalid_value");
      await db().insert(schema.ticketMeta).values({ ticketId: id, localAsset: local }).onConflictDoUpdate({ target: schema.ticketMeta.ticketId, set: { localAsset: local, updatedAt: new Date() } });
      if (local) rest.assetId = null;
    }
    // the queue is the portal's, never sent to the source
    if (Object.keys(rest).length) await src.update(id, rest, a);
  };
  return d;
}

const LOCAL = "local:";

/** The devices made in the portal (one client's, or all), shaped like the source's. */
export async function localAssets(companyId?: number): Promise<Asset[]> {
  const rows = await db().select().from(schema.localAssets).where(companyId === undefined ? undefined : eq(schema.localAssets.companyId, companyId)).orderBy(asc(schema.localAssets.name));
  return rows.map((r) => ({
    id: LOCAL + r.id,
    name: r.name,
    type: r.type,
    serial: r.serial,
    companyId: r.companyId,
    contactId: r.contactId,
    contactName: r.contactName,
    hostname: r.hostname,
    ip: r.ip,
    os: r.os,
    lastUser: null,
    lastSeen: null,
    warrantyEnd: null,
    rmm: { id: null, uid: null },
  }));
}

/** Where a ticket goes when nothing says otherwise. */
export async function defaultQueueKey(): Promise<string> {
  const list = await queues();
  return list.find((q) => q.isDefault)?.key ?? list[0]?.key ?? "";
}
