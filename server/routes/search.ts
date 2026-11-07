import { Hono } from "hono";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, type AppEnv } from "../lib/auth.ts";

/**
 * The search of the top bar: clients, contacts, devices (RMM), projects, invoices, quotes, tasks, knowledge base and
 * procedures, each only for the person who has the right to see that kind of thing (tickets are asked from
 * /api/tickets/search by the screen). Nothing is changed; a result carries the address of the page that shows it.
 */
const LIMIT = 6;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export type SearchHit = { kind: "client" | "contact" | "device" | "project" | "invoice" | "quote" | "task" | "kb" | "sop"; id: string; title: string; sub: string; path: string };

export const searchRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const a = auth(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return c.json([] as SearchHit[]);
  const can = (p: string) => (a.permissions as string[]).includes(p);
  const p = like(q);
  const d = db();
  const out: Promise<SearchHit[]>[] = [];

  if (can("crm.view")) {
    out.push(
      d
        .select({ id: schema.clients.id, name: schema.clients.name, city: schema.clients.city, active: schema.clients.active })
        .from(schema.clients)
        .where(or(ilike(schema.clients.name, p), ilike(schema.clients.code, p), ilike(schema.clients.email, p), ilike(schema.clients.phone, p)))
        .orderBy(desc(schema.clients.active), schema.clients.name)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "client" as const, id: r.id, title: r.name, sub: [r.city, r.active ? "" : "inactif"].filter(Boolean).join(" · "), path: `/crm/${r.id}` }))),
    );
    const full = sql`(${schema.clientContacts.firstName} || ' ' || ${schema.clientContacts.lastName})`;
    out.push(
      d
        .select({ id: schema.clientContacts.id, clientId: schema.clientContacts.clientId, first: schema.clientContacts.firstName, last: schema.clientContacts.lastName, email: schema.clientContacts.email, phone: schema.clientContacts.phone, client: schema.clients.name })
        .from(schema.clientContacts)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.clientContacts.clientId))
        .where(or(sql`${full} ilike ${p}`, ilike(schema.clientContacts.email, p), ilike(schema.clientContacts.phone, p), ilike(schema.clientContacts.mobile, p)))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "contact" as const, id: r.id, title: `${r.first} ${r.last}`.trim() || r.email || "—", sub: [r.client, r.email ?? r.phone].filter(Boolean).join(" · "), path: `/crm/${r.clientId}?tab=contacts` }))),
    );
    out.push(
      d
        .select({ id: schema.rmmDevices.id, host: schema.rmmDevices.hostname, user: schema.rmmDevices.lastUser, ip: schema.rmmDevices.ip, os: schema.rmmDevices.os, clientId: schema.rmmSites.clientId, client: schema.clients.name })
        .from(schema.rmmDevices)
        .innerJoin(schema.rmmSites, eq(schema.rmmSites.uid, schema.rmmDevices.siteUid))
        .leftJoin(schema.clients, eq(schema.clients.id, schema.rmmSites.clientId))
        .where(or(ilike(schema.rmmDevices.hostname, p), ilike(schema.rmmDevices.description, p), ilike(schema.rmmDevices.ip, p), ilike(schema.rmmDevices.externalIp, p), ilike(schema.rmmDevices.lastUser, p)))
        .limit(LIMIT)
        .then((rows) => rows.filter((r) => r.clientId).map((r) => ({ kind: "device" as const, id: r.id, title: r.host || r.ip, sub: [r.client, r.user, r.os].filter(Boolean).join(" · "), path: `/crm/${r.clientId}?tab=devices` }))),
    );
  }
  if (can("projects.view")) {
    out.push(
      d
        .select({ id: schema.projects.id, number: schema.projects.number, name: schema.projects.name, client: schema.clients.name })
        .from(schema.projects)
        .leftJoin(schema.clients, eq(schema.clients.id, schema.projects.clientId))
        .where(or(ilike(schema.projects.name, p), ilike(schema.projects.number, p)))
        .orderBy(desc(schema.projects.createdAt))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "project" as const, id: r.id, title: `${r.number} ${r.name}`, sub: r.client ?? "", path: `/projects?project=${r.id}` }))),
    );
  }
  if (can("accounting.view")) {
    out.push(
      d
        .select({ id: schema.clientInvoices.id, number: schema.clientInvoices.number, total: schema.clientInvoices.totalCents, client: schema.clients.name })
        .from(schema.clientInvoices)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.clientInvoices.clientId))
        .where(or(ilike(schema.clientInvoices.number, p), ilike(schema.clientInvoices.poNumber, p)))
        .orderBy(desc(schema.clientInvoices.number))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "invoice" as const, id: r.id, title: `#${r.number}`, sub: `${r.client} · ${(r.total / 100).toLocaleString("fr-CA", { style: "currency", currency: "CAD" })}`, path: `/accounting/invoices?istatus=all&iq=${encodeURIComponent(r.number)}` }))),
    );
  }
  if (can("quotes.view")) {
    out.push(
      d
        .select({ id: schema.quotes.id, number: schema.quotes.number, title: schema.quotes.title, prospect: schema.quotes.prospectName, client: schema.clients.name })
        .from(schema.quotes)
        .leftJoin(schema.clients, eq(schema.clients.id, schema.quotes.clientId))
        .where(or(ilike(schema.quotes.number, p), ilike(schema.quotes.title, p), ilike(schema.quotes.prospectName, p)))
        .orderBy(desc(schema.quotes.createdAt))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "quote" as const, id: r.id, title: `${r.number} ${r.title}`.trim(), sub: r.client ?? r.prospect ?? "", path: `/accounting/quotes/${r.id}` }))),
    );
  }
  if (can("pipeline.view")) {
    // a task is visible to the team, or to the one who made it or who has it (private and chosen ones stay private)
    const mine: SQL = or(eq(schema.pipelineTasks.visibility, "team"), eq(schema.pipelineTasks.createdBy, a.user.id), eq(schema.pipelineTasks.assigneeId, a.user.id))!;
    out.push(
      d
        .select({ id: schema.pipelineTasks.id, title: schema.pipelineTasks.title, status: schema.pipelineTasks.status })
        .from(schema.pipelineTasks)
        .where(and(mine, or(ilike(schema.pipelineTasks.title, p), ilike(schema.pipelineTasks.notes, p))))
        .orderBy(desc(schema.pipelineTasks.createdAt))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "task" as const, id: r.id, title: r.title, sub: r.status === "done" ? "terminée" : "", path: `/pipeline?section=todo&task=${r.id}` }))),
    );
  }
  if (can("kb.view")) {
    const seen: SQL = can("kb.manage") ? sql`true` : or(eq(schema.kbArticles.published, true), eq(schema.kbArticles.createdBy, a.user.id))!;
    out.push(
      d
        .select({ id: schema.kbArticles.id, title: schema.kbArticles.title, category: schema.kbArticles.category })
        .from(schema.kbArticles)
        .where(and(seen, or(ilike(schema.kbArticles.title, p), ilike(schema.kbArticles.category, p), ilike(schema.kbArticles.body, p))))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "kb" as const, id: r.id, title: r.title, sub: r.category, path: `/documentation?section=kb` }))),
    );
  }
  if (can("sops.view")) {
    const seen: SQL = can("sops.manage") ? sql`true` : or(eq(schema.sops.status, "published"), eq(schema.sops.createdBy, a.user.id))!;
    out.push(
      d
        .select({ id: schema.sops.id, title: schema.sops.title })
        .from(schema.sops)
        .where(and(seen, or(ilike(schema.sops.title, p), ilike(schema.sops.description, p))))
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "sop" as const, id: r.id, title: r.title, sub: "", path: `/documentation?sop=${r.id}` }))),
    );
  }
  const hits = (await Promise.all(out)).flat();
  return c.json(hits);
});
