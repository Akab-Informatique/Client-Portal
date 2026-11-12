import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { db, schema } from "../db/index.ts";
import { auth, type AppEnv } from "./auth.ts";
import { queues, sources } from "./queues.ts";
import { SourceError, type HistoryTicket, type NTicket, type TicketSource } from "./ticketSource.ts";

/**
 * Self-managed clients: a client company (or a child of one) whose own delegated
 * technicians work its tickets. Our staff do not see those tickets until AKAB
 * takes them (tickets.akab_taken_at set). Alerts are never hidden.
 *
 * Hidden is computed when read (no bulk update): switching the flag changes
 * what is visible at once. The client set is cached for 30 s.
 */

/** Who may see what of the tickets: all (clients, background jobs, accounting), or staff (default: hidden tickets are hidden). */
export type TicketScope = { all: true } | { right?: boolean; include?: number[] };

const ALERT_SOURCE = /alert|monitor/i;
const ALERT_LABEL = /alert/i;

type ClientRow = { id: string; parentId: string | null; selfManaged: "on" | "off" | null; autotaskId: number | null; active: boolean };

/** A client is self-managed when its own flag says so, else the nearest flag up its parents (an "off" stops it). */
function effectiveOn(row: ClientRow, byId: Map<string, ClientRow>): boolean {
  const seen = new Set<string>();
  let cur: ClientRow | undefined = row;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.selfManaged) return cur.selfManaged === "on";
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

let cache: { at: number; clients: Set<string>; companies: Set<number> } | null = null;

/** After a change of a client's self-managed flag or parent (this instance only). */
export function clearSelfManagedCache(): void {
  cache = null;
}

async function loaded() {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const rows: ClientRow[] = await db()
    .select({ id: schema.clients.id, parentId: schema.clients.parentId, selfManaged: schema.clients.selfManaged, autotaskId: schema.clients.autotaskId, active: schema.clients.active })
    .from(schema.clients);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const clients = new Set<string>();
  const companies = new Set<number>();
  for (const r of rows) {
    if (!effectiveOn(r, byId)) continue;
    clients.add(r.id);
    if (r.active && r.autotaskId != null) companies.add(r.autotaskId);
  }
  cache = { at: Date.now(), clients, companies };
  return cache;
}

/** Ids of the clients that are effectively self-managed (active or not). */
export async function selfManagedClientIds(): Promise<Set<string>> {
  return (await loaded()).clients;
}

/** Company ids (the tickets' company id) of the active self-managed clients. */
export async function selfManagedCompanyIds(): Promise<Set<number>> {
  return (await loaded()).companies;
}

export async function isSelfManagedClient(clientId: string): Promise<boolean> {
  return (await loaded()).clients.has(clientId);
}

/**
 * The hidden tickets, with their company: open to AKAB only when not taken
 * (akab_taken_at), not an alert. One query, none when no company is self-managed.
 */
async function hiddenTickets(): Promise<Map<number, number>> {
  const companies = await selfManagedCompanyIds();
  if (companies.size === 0) return new Map();
  const rows = await db()
    .select({
      id: schema.tickets.id,
      companyId: schema.tickets.companyId,
      queue: schema.tickets.queue,
      source: schema.tickets.source,
      metaQueue: schema.ticketMeta.queue,
      metaSource: schema.ticketMeta.source,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketMeta, eq(schema.ticketMeta.ticketId, schema.tickets.id))
    .where(and(inArray(schema.tickets.companyId, [...companies]), isNull(schema.tickets.akabTakenAt)));
  if (rows.length === 0) return new Map();
  const [queueRows, sourceRows] = await Promise.all([queues(), sources()]);
  const knownQueues = new Map(queueRows.map((q) => [q.key, q]));
  const knownSources = new Set(sourceRows.map((s) => s.key));
  const hasAlertQueue = queueRows.some((q) => q.alerts);
  const out = new Map<number, number>();
  for (const r of rows) {
    // mirrors withPortalQueues (the queue) and isAlert (routes/tickets.ts)
    const effSource = r.metaSource && knownSources.has(r.metaSource) ? r.metaSource : r.source;
    const queueAlert = r.metaQueue && knownQueues.has(r.metaQueue) ? !!knownQueues.get(r.metaQueue)!.alerts : hasAlertQueue && (ALERT_LABEL.test(r.queue) || ALERT_SOURCE.test(r.source));
    if (queueAlert || ALERT_SOURCE.test(effSource)) continue;
    out.set(r.id, r.companyId);
  }
  return out;
}

/** Ids of the tickets hidden from our staff right now. */
export async function hiddenTicketIds(): Promise<Set<number>> {
  return new Set((await hiddenTickets()).keys());
}

/** Whether one ticket is hidden from our staff right now. */
export async function isTicketHidden(ticketId: number): Promise<boolean> {
  return (await hiddenTickets()).has(ticketId);
}

/** Whether a by-id route must answer as if the ticket did not exist for this scope (staff with the right may act on any ticket). */
export async function hiddenFromCaller(scope: TicketScope, ticketId: number): Promise<boolean> {
  if ("all" in scope) return false;
  if (scope.right) return false;
  return isTicketHidden(ticketId);
}

/** The ids a caller must not see in a list (same rule as the lists of ticketSource: with the right, the included companies stay) */
export async function hiddenIdsFor(scope: TicketScope): Promise<Set<number>> {
  if ("all" in scope) return new Set();
  const right = !!scope.right;
  const include = new Set(scope.include ?? []);
  const out = new Set<number>();
  for (const [id, company] of await hiddenTickets()) if (!(right && include.has(company))) out.add(id);
  return out;
}

/** The scope of a staff request: the tickets.selfManaged right, and the "Clients autogérés" companies picked in the query (`selfManaged=<ids>`, only with the right). */
export function ticketScopeOf(c: Context<AppEnv>): TicketScope {
  const a = auth(c);
  if (!a.permissions.includes("tickets.selfManaged")) return {};
  const include = (c.req.query("selfManaged") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { right: true, include };
}

const notFound = () => new SourceError("not_found");

/** The staff view without any right: one per source, so a spy or a cache on the source sees the same object */
const plainViews = new WeakMap<TicketSource, TicketSource>();

/**
 * A thin view of a ticket source that hides the self-managed tickets from the
 * caller's scope. Hidden tickets look missing (same error as a missing id).
 * The hidden set is read once per call (never per row, never kept).
 */
export function scopedSource(base: TicketSource, scope: TicketScope): TicketSource {
  if ("all" in scope) return base;
  const right = !!scope.right;
  const include = new Set(scope.include ?? []);
  const isPlain = !right && include.size === 0;
  if (isPlain && plainViews.has(base)) return plainViews.get(base)!;
  /** Whether the caller may act on this ticket id (writes and by-id reads) */
  const refused = async (id: number) => !right && (await hiddenTickets()).has(id);
  /** Whether a ticket id appears in lists for this caller, given the hidden set read for the call */
  const listed = (m: Map<number, number>, id: number) => {
    const company = m.get(id);
    return company === undefined || (right && include.has(company));
  };
  const keep = async <T extends { id: number }>(rows: T[]) => {
    const m = await hiddenTickets();
    return rows.filter((r) => listed(m, r.id));
  };

  const w = Object.create(base) as TicketSource;
  w.get = async (id) => ((await refused(id)) ? null : base.get(id));
  w.list = async () => keep(await base.list());
  w.history = async (since): Promise<HistoryTicket[]> => keep(await base.history(since));
  w.companyHistory = async (companyId): Promise<NTicket[]> => keep(await base.companyHistory(companyId));
  w.searchArchive = async (q): Promise<NTicket[]> => keep(await base.searchArchive(q));
  w.ticketsWithOtherContact = async (contactId) => {
    const ids = await base.ticketsWithOtherContact(contactId);
    const m = await hiddenTickets();
    return ids.filter((id) => listed(m, id));
  };
  w.update = async (id, p, a) => {
    if (await refused(id)) throw notFound();
    return base.update(id, p, a);
  };
  w.addNote = async (id, p, a) => {
    if (await refused(id)) throw notFound();
    return base.addNote(id, p, a);
  };
  w.charges = async (id) => {
    if (await refused(id)) throw notFound();
    return base.charges(id);
  };
  w.addCharge = async (id, p, a) => {
    if (await refused(id)) throw notFound();
    return base.addCharge(id, p, a);
  };
  w.removeCharge = async (id, chargeId) => {
    if (await refused(id)) throw notFound();
    return base.removeCharge(id, chargeId);
  };
  w.addAttachment = async (id, p, a) => {
    if (await refused(id)) throw notFound();
    return base.addAttachment(id, p, a);
  };
  w.addTimeEntry = async (id, p, a) => {
    if (await refused(id)) throw notFound();
    return base.addTimeEntry(id, p, a);
  };
  w.addSmsNote = async (id, title, text) => {
    if (await refused(id)) throw notFound();
    return base.addSmsNote(id, title, text);
  };
  w.addMailReply = async (id, from, text) => {
    if (await refused(id)) throw notFound();
    return base.addMailReply(id, from, text);
  };
  w.markNeedsAttention = async (id, opts) => {
    if (await refused(id)) throw notFound();
    return base.markNeedsAttention(id, opts);
  };
  if (isPlain) plainViews.set(base, w);
  return w;
}
