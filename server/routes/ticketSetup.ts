import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { forgetSources, forgetStatuses, sources, withStatusConfig } from "../lib/queues.ts";
import { saveTicketSyncSettings, syncTicketsNow, ticketCopyInfo, ticketLastRun, ticketSource, ticketSyncSettings, type TicketSource } from "../lib/ticketSource.ts";
import { importFromSource, startTicketImport, ticketMode, ticketsLocal } from "../lib/localTickets.ts";
import { autotaskLinked } from "../lib/ticketSource.ts";
import { run } from "./tickets.ts";

/**
 * Admin › Billets (admin.tickets): where tickets come from (phone, text, email,
 * in person… and your own), how the statuses are named, ordered and offered,
 * and the manual sync with Autotask.
 */
const zName = z.string().trim().min(1).max(40);
const KINDS = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete", "other"] as const;
const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "source";

/** The source's own options, without the portal's wording over them. */
const baseOptions = (src: TicketSource) => (Object.getPrototypeOf(src) as TicketSource).options();

export const ticketSetupRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.tickets"))

  // ── Sources ──
  .get("/sources", async (c) => {
    const src = await ticketSource();
    const [list, tickets] = await run(() => Promise.all([sources(), src.list()]));
    const n = new Map<string, number>();
    for (const t of tickets) n.set(t.source, (n.get(t.source) ?? 0) + 1);
    return c.json(list.map((s) => ({ key: s.key, name: s.name, position: s.position, tickets: n.get(s.key) ?? 0 })));
  })

  .post("/sources", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName }));
    const list = await sources();
    if (list.some((s) => s.name.toLowerCase() === p.name.toLowerCase())) throw new HTTPException(409, { message: "source_exists" });
    let key = slug(p.name);
    for (let i = 2; list.some((s) => s.key === key); i++) key = `${slug(p.name)}-${i}`;
    await db().insert(schema.ticketSources).values({ key, name: p.name, position: list.length });
    forgetSources();
    await audit(a.user.id, "ticket_source.created", key, { name: p.name });
    return c.json({ key }, 201);
  })

  .patch("/sources/:key", async (c) => {
    const a = auth(c);
    const cur = await sourceOf(c.req.param("key"));
    const p = await body(c, z.object({ name: zName }));
    if ((await sources()).some((s) => s.key !== cur.key && s.name.toLowerCase() === p.name.toLowerCase())) throw new HTTPException(409, { message: "source_exists" });
    await db().update(schema.ticketSources).set({ name: p.name, updatedAt: new Date() }).where(eq(schema.ticketSources.key, cur.key));
    forgetSources();
    await audit(a.user.id, "ticket_source.updated", cur.key, { name: p.name });
    return c.json({ ok: true });
  })

  .post("/sources/:key/move", async (c) => {
    const a = auth(c);
    const cur = await sourceOf(c.req.param("key"));
    const p = await body(c, z.object({ direction: z.enum(["up", "down"]) }));
    const keys = (await sources()).map((s) => s.key);
    const i = keys.indexOf(cur.key);
    const j = p.direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= keys.length) return c.json({ ok: true });
    [keys[i], keys[j]] = [keys[j], keys[i]];
    await db().transaction(async (tx) => {
      for (const [n, key] of keys.entries()) await tx.update(schema.ticketSources).set({ position: n }).where(eq(schema.ticketSources.key, key));
    });
    forgetSources();
    await audit(a.user.id, "ticket_source.moved", cur.key, { direction: p.direction });
    return c.json({ ok: true });
  })

  /** Its tickets go back to the usual way (worked out from the source, else phone); the last one cannot go. */
  .delete("/sources/:key", async (c) => {
    const a = auth(c);
    const cur = await sourceOf(c.req.param("key"));
    if ((await sources()).length <= 1) throw new HTTPException(409, { message: "source_last" });
    await db().transaction(async (tx) => {
      await tx.update(schema.ticketMeta).set({ source: null }).where(eq(schema.ticketMeta.source, cur.key));
      await tx.delete(schema.ticketSources).where(eq(schema.ticketSources.key, cur.key));
    });
    forgetSources();
    await audit(a.user.id, "ticket_source.deleted", cur.key, { name: cur.name });
    return c.json({ ok: true });
  })

  // ── Statuses ──
  /** The source's statuses with the portal's wording over them, in order, with their tickets. */
  .get("/statuses", async (c) => {
    const src = await ticketSource();
    const [base, tickets] = await run(() => Promise.all([baseOptions(src), src.list()]));
    const n = new Map<string, number>();
    for (const t of tickets) n.set(t.status, (n.get(t.status) ?? 0) + 1);
    const shown = await withStatusConfig(base.statuses);
    const own = new Map(base.statuses.map((s) => [s.value, s]));
    return c.json({
      kinds: KINDS,
      items: shown.map((s) => ({ value: s.value, sourceLabel: own.get(s.value)?.label ?? s.value, sourceKind: own.get(s.value)?.kind ?? "other", label: s.label, kind: s.kind, hidden: Boolean(s.hidden), tickets: n.get(s.value) ?? 0 })),
    });
  })

  /** The whole list, in order: wording (empty = the source's), kind, and whether it is still offered. */
  .put("/statuses", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        items: z
          .array(z.object({ value: z.string().min(1).max(60), label: z.string().trim().max(60).nullable(), kind: z.enum(KINDS).nullable(), hidden: z.boolean() }))
          .min(1)
          .max(100),
      }),
    );
    const src = await ticketSource();
    const base = await run(() => baseOptions(src));
    const known = new Set(base.statuses.map((s) => s.value));
    if (p.items.some((i) => !known.has(i.value))) throw new HTTPException(400, { message: "invalid_value" });
    // someone must be able to close a ticket: at least one complete status stays offered
    const kindOf = new Map(base.statuses.map((s) => [s.value, s.kind]));
    const stillClosing = p.items.some((i) => (i.kind ?? kindOf.get(i.value)) === "complete" && !i.hidden);
    if (!stillClosing) throw new HTTPException(409, { message: "status_no_complete" });
    await db().transaction(async (tx) => {
      for (const [position, i] of p.items.entries()) {
        const row = { label: i.label || null, kind: i.kind, position, hidden: i.hidden, updatedAt: new Date() };
        await tx.insert(schema.ticketStatuses).values({ value: i.value, ...row }).onConflictDoUpdate({ target: schema.ticketStatuses.value, set: row });
      }
    });
    forgetStatuses();
    await audit(a.user.id, "ticket_statuses.updated", null, { count: p.items.length });
    return c.json({ ok: true });
  })

  // ── Sync with Autotask (by hand) ──
  .get("/sync", async (c) => {
    const src = await ticketSource();
    const [settings, copy, last, local] = await Promise.all([ticketSyncSettings(), ticketCopyInfo(), ticketLastRun(), ticketsLocal()]);
    return c.json({ ...settings, demo: src.demo, copy, lastRun: last, local });
  })

  // ── The tickets of the portal (no longer tied to Autotask) ──
  .get("/local", async (c) => {
    const [mode, linked, [row]] = await Promise.all([
      ticketMode(),
      autotaskLinked(),
      db().select({ n: sql<number>`count(*)::int` }).from(schema.tickets),
    ]);
    return c.json({ mode: mode.mode, linked, switchedAt: mode.switchedAt ?? null, import: mode.import ?? null, tickets: row?.n ?? 0, since: (await ticketSyncSettings()).since });
  })

  /** The one-way switch: the tickets (with notes, time, charges, files) are copied into the portal, which then owns them */
  .post("/local/switch", requirePermission("admin.integrations"), async (c) => {
    const a = auth(c);
    const state = await run(() => startTicketImport(a.user.id));
    return c.json({ mode: state.mode, import: state.import ?? null }, 202);
  })

  /** By hand: copy these tickets (numbers) or a period from Autotask; the portal's version is replaced */
  .post("/local/import", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z
        .object({
          numbers: z.array(z.string().trim().regex(/^T\d{8}\.\d{3,6}$/i)).min(1).max(50).optional(),
          since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
        .refine((v) => Boolean(v.numbers?.length) !== Boolean(v.since)),
    );
    return c.json(await run(() => importFromSource(p, a.user.id)));
  })

  .put("/sync", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ auto: z.boolean().optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).refine((v) => v.since === undefined || (v.since >= "2000-01-01" && v.since <= "2100-01-01")));
    await saveTicketSyncSettings(a.user.id, p);
    await audit(a.user.id, "ticket_sync.settings", null, p);
    return c.json(await ticketSyncSettings());
  })

  /** A full pass now: every ticket since the date, completed ones with their status. */
  .post("/sync/run", async (c) => {
    const a = auth(c);
    // the portal owns the tickets: nothing is pulled by itself (import the ones wanted: /local/import)
    if (await ticketsLocal()) throw new HTTPException(409, { message: "tickets_local" });
    const r = await syncTicketsNow(a.user.id);
    await audit(a.user.id, "ticket_sync.run", null, { ok: r.ok, total: r.total, completed: r.completed });
    return c.json(r, r.ok ? 200 : 502);
  });

async function sourceOf(key: string) {
  const [s] = await db().select().from(schema.ticketSources).where(and(eq(schema.ticketSources.key, key), ne(schema.ticketSources.key, "")));
  if (!s) throw new HTTPException(404, { message: "not_found" });
  return s;
}
