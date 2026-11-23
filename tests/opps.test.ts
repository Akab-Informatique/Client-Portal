import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "true";
process.env.REQUIRE_MFA = "true";

const { initDb, db, schema } = await import("../server/db/index.ts");
const { seed } = await import("../server/db/seed.ts");
const { createApp } = await import("../server/app.ts");
const { and, eq } = await import("drizzle-orm");
const { resetRateLimit } = await import("../server/lib/http.ts");
const { devOutbox } = await import("../server/lib/mail.ts");

let app: ReturnType<typeof createApp>;
const PASSWORD = "akab-dev-password";

/** Minimal browser: keeps the session cookie, sends JSON + same-origin headers (as in api.test.ts). */
class Agent {
  cookie = "";
  async req(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: {
        host: "localhost",
        origin: "http://localhost",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const set of res.headers.getSetCookie()) {
      const m = set.match(/^akab_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `akab_session=${m[1]}` : "";
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  del = (p: string) => this.req("DELETE", p);
}

const secrets = new Map<string, string>();
let stepOffset = 0;
function code(secret: string, offsetSteps = 0) {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

async function signIn(email: string): Promise<Agent> {
  const a = new Agent();
  resetRateLimit("login:ip:unknown");
  const r = await a.post("/api/auth/login", { email, password: PASSWORD });
  expect(r.status).toBe(200);
  if (r.json.stage === "mfa-setup") {
    const s = await a.post("/api/auth/mfa/setup");
    expect(s.status).toBe(200);
    secrets.set(email, s.json.secret);
  }
  stepOffset = stepOffset === 0 ? -1 : stepOffset === -1 ? 1 : 0;
  await db().update(schema.users).set({ mfaLastStep: null }).where(eq(schema.users.email, email));
  const v = await a.post("/api/auth/mfa/verify", { code: code(secrets.get(email)!, stepOffset) });
  expect(v.status).toBe(200);
  return a;
}

const sessions = new Map<string, Agent>();
const session = async (email: string) => sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;

const userId = async (email: string) => (await db().select().from(schema.users).where(eq(schema.users.email, email)))[0]!.id;

/** Two clients with a contact each; the first one's ticket company is 880001, the second's 880002 */
let c1: { client: string; contact: string };
let c2: { client: string; contact: string };
/** The seeded people, by name (read from the database, not assumed) */
let adminName = "";
let techName = "";

beforeAll(async () => {
  await initDb({ memory: true });
  await seed();
  app = createApp();
  const [a] = await db()
    .insert(schema.clients)
    .values({ name: "Garage Opps", autotaskId: 880001, active: true })
    .returning();
  const [b] = await db()
    .insert(schema.clients)
    .values({ name: "Autre Opps", autotaskId: 880002, active: true })
    .returning();
  const [k1] = await db()
    .insert(schema.clientContacts)
    .values({ clientId: a!.id, firstName: "Anne", lastName: "Roy", email: "anne@garage.test", active: true })
    .returning();
  const [k2] = await db()
    .insert(schema.clientContacts)
    .values({ clientId: b!.id, firstName: "Luc", lastName: "Dion", email: "luc@autre.test", active: true })
    .returning();
  c1 = { client: a!.id, contact: k1!.id };
  c2 = { client: b!.id, contact: k2!.id };
  adminName = (await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local")))[0]!.name;
  techName = (await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local")))[0]!.name;
});

afterAll(async () => {
  const local = await import("../server/lib/localTickets.ts");
  await db().delete(schema.integrations).where(eq(schema.integrations.provider, "tickets"));
  local.resetTicketMode();
});

describe("opportunités: flagged from a client, taken, linked, closed and archived", () => {
  it("a technician flags an opportunity; the number, the first system note and the list", async () => {
    const tech = await session("tech@akab.local");
    const r = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Veut migrer le courriel vers Microsoft 365", source: "sales_call", handling: "needs_call" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ number: "O-1001", status: "new", source: "sales_call", handling: "needs_call", open: true, owner: null, client: { id: c1.client, name: "Garage Opps" }, contact: { name: "Anne Roy" } });
    expect(r.json.notes.map((n: any) => [n.kind, n.text])).toEqual([["system", expect.stringMatching(/^Signalée par /)]]);
    // the next number follows the highest
    const second = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Deuxième demande" });
    expect(second.json.number).toBe("O-1002");
    expect(second.json.source).toBe("other");
    expect(second.json.handling).toBe("quote_only");
    // in the list, the badge counts it
    const list = (await tech.get("/api/opps?status=open")).json;
    expect(list.items.map((o: any) => o.number)).toEqual(["O-1002", "O-1001"]);
    expect(list.counts).toMatchObject({ open: 2, new: 2, closed: 0 });
    expect((await tech.get("/api/opps/badge")).json).toEqual({ new: 2, mine: 0 });
  });

  it("the contact must belong to the client (400 contact_invalid) and the client must be active", async () => {
    const tech = await session("tech@akab.local");
    const r = await tech.post("/api/opps", { clientId: c1.client, contactId: c2.contact, description: "Mauvais contact" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("contact_invalid");
    const none = await tech.post("/api/opps", { clientId: "00000000-0000-4000-8000-000000000000", contactId: c1.contact, description: "x" });
    expect(none.json.error).toBe("client_invalid");
    expect((await tech.post("/api/opps", { clientId: "pas-un-id", contactId: c1.contact, description: "x" })).status).toBe(400);
  });

  it("a technician without opps.manage cannot give an owner, take, change, link or close (403)", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const id = (await tech.get("/api/opps?status=all")).json.items.find((o: any) => o.number === "O-1001").id;
    expect((await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "x", ownerId: await userId("tech@akab.local") })).json.error).toBe("forbidden");
    expect((await tech.post(`/api/opps/${id}/take`)).status).toBe(403);
    expect((await tech.patch(`/api/opps/${id}`, { description: "changé" })).status).toBe(403);
    expect((await tech.post(`/api/opps/${id}/close`, { status: "canceled" })).status).toBe(403);
    expect((await tech.post(`/api/opps/${id}/links`, { kind: "quote", refId: id })).status).toBe(403);
    // but a note is his to add
    expect((await tech.post(`/api/opps/${id}/notes`, { text: "Rappeler mardi" })).status).toBe(201);
    expect((await admin.get(`/api/opps/${id}`)).json.notes.map((n: any) => n.text)).toContain("Rappeler mardi");
  });

  it("the managers are told by bell when someone flags one, the flagger is not", async () => {
    const admin = await userId("admin@akab.local");
    const tech = await userId("tech@akab.local");
    const rows = await db().select().from(schema.notifications).where(eq(schema.notifications.type, "opp.new"));
    expect(rows.map((n) => n.userId)).toContain(admin);
    expect(rows.map((n) => n.userId)).not.toContain(tech);
    expect(rows[0]!.link).toMatch(/^\/opps\?opp=/);
  });

  it("taking an opportunity: the manager owns it, working; the notes are kept", async () => {
    const admin = await session("admin@akab.local");
    const list = (await admin.get("/api/opps?status=open")).json.items;
    const id = list.find((o: any) => o.number === "O-1001").id;
    const taken = await admin.post(`/api/opps/${id}/take`);
    expect(taken.status).toBe(200);
    expect(taken.json).toMatchObject({ status: "working", owner: { name: adminName } });
    expect(taken.json.notes.some((n: any) => n.kind === "system" && /Prise en charge par/.test(n.text))).toBe(true);
    // the owner filter
    expect((await admin.get("/api/opps?owner=me")).json.items.map((o: any) => o.number)).toEqual(["O-1001"]);
    expect((await admin.get("/api/opps?owner=none")).json.items.map((o: any) => o.number)).toEqual(["O-1002"]);
  });

  it("an opportunity from a ticket takes the number and title from the source; another client's ticket is refused", async () => {
    const local = await import("../server/lib/localTickets.ts");
    await db()
      .insert(schema.integrations)
      .values({ provider: "tickets", enabled: true, config: { mode: "local" } })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: { mode: "local" } } });
    local.resetTicketMode();
    const tech = await session("tech@akab.local");
    const mine = await tech.post("/api/tickets", { title: "Imprimante en panne", description: "Ne répond plus", companyId: 880001, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    expect(mine.status).toBe(201);
    const ticket = (await tech.get(`/api/tickets/${mine.json.id}`)).json;
    const other = await tech.post("/api/tickets", { title: "Autre client", description: "x", companyId: 880002, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    expect(other.status).toBe(201);

    // the title sent by the browser is ignored: the source's is kept, and the source is "ticket"
    const r = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Suite du billet", source: "email", ticketId: mine.json.id, ticketTitle: "Faux titre" } as any);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ source: "ticket", ticket: { id: mine.json.id, number: ticket.number, title: "Imprimante en panne" } });

    const refused = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Billet d'un autre client", ticketId: other.json.id });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("ticket_other_client");
    expect((await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "x", ticketId: 987654321 })).status).toBe(404);

    const byTicket = (await tech.get(`/api/opps/by-ticket/${mine.json.id}`)).json;
    expect(byTicket.map((o: any) => o.number)).toEqual([r.json.number]);
    expect((await tech.get("/api/opps?ticket=" + ticket.number)).json.items.map((o: any) => o.number)).toEqual([r.json.number]);
    // a hidden or unknown ticket: not found
    expect((await tech.get("/api/opps/by-ticket/987654321")).status).toBe(404);
  });

  it("links: a quote of the same client; another client's quote, an unknown one and a duplicate are refused", async () => {
    const admin = await session("admin@akab.local");
    const q1 = (await admin.post("/api/quotes", { clientId: c1.client, title: "Serveur", lines: [
      { description: "Serveur", quantityX100: 100, unitPriceCents: 500000, unitCostCents: 300000, taxable: true, recurrence: "once" },
      { description: "Soutien", quantityX100: 100, unitPriceCents: 10000, unitCostCents: 0, taxable: true, recurrence: "monthly" },
    ] })).json;
    expect(q1.id).toBeTruthy();
    const q2 = (await admin.post("/api/quotes", { clientId: c2.client, title: "Autre", lines: [] })).json;
    const id = (await admin.get("/api/opps?owner=me")).json.items[0].id;

    const linked = await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: q1.id, label: "Faux libellé" } as any);
    expect(linked.status).toBe(201);
    expect(linked.json.links).toEqual([expect.objectContaining({ kind: "quote", refId: q1.id, label: `${q1.number} - Serveur` })]);
    expect(linked.json.notes.some((n: any) => /Lien ajouté \(soumission\)/.test(n.text))).toBe(true);

    expect((await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: q2.id })).json.error).toBe("target_other_client");
    expect((await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: q1.id })).json.error).toBe("link_exists");
    expect((await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: "pas-un-id" })).status).toBe(400);
  });

  it("closing: won needs a link, lost needs a reason; a closed one cannot be edited, taken or closed again, but takes notes, links and reopening", async () => {
    const admin = await session("admin@akab.local");
    const id = (await admin.get("/api/opps?owner=me")).json.items[0].id;
    const notYet = await admin.post(`/api/opps/${id}/close`, { status: "won" });
    expect(notYet.status).toBe(200); // the quote link is there already: won is allowed

    // a fresh one for the other cases
    const fresh = (await admin.post("/api/opps", { clientId: c2.client, contactId: c2.contact, description: "Pour perdre" })).json;
    expect((await admin.post(`/api/opps/${fresh.id}/close`, { status: "won" })).json.error).toBe("link_required");
    expect((await admin.post(`/api/opps/${fresh.id}/close`, { status: "lost" })).json.error).toBe("lost_reason_required");
    const lost = await admin.post(`/api/opps/${fresh.id}/close`, { status: "lost", lostReason: "price", closeNote: "Trop cher" });
    expect(lost.status).toBe(200);
    expect(lost.json).toMatchObject({ status: "lost", lostReason: "price", closeNote: "Trop cher", open: false });
    expect(lost.json.closedAt).toBeTruthy();
    expect(lost.json.owner).not.toBeNull();

    // closed: no edit, no take, no second close
    expect((await admin.patch(`/api/opps/${fresh.id}`, { description: "changé" })).json.error).toBe("opp_closed");
    expect((await admin.post(`/api/opps/${fresh.id}/take`)).json.error).toBe("opp_closed");
    expect((await admin.post(`/api/opps/${fresh.id}/close`, { status: "canceled" })).json.error).toBe("opp_closed");
    // but notes stay possible, and reopening goes back to working
    expect((await admin.post(`/api/opps/${fresh.id}/notes`, { text: "Note après coup" })).status).toBe(201);
    expect((await admin.post(`/api/opps/${fresh.id}/reopen`)).json).toMatchObject({ status: "working", closedAt: null, lostReason: null });
    expect((await admin.post(`/api/opps/${fresh.id}/reopen`)).json.error).toBe("opp_open");

    // the won one: closed, then a link can still be added to it
    const q = (await admin.post("/api/quotes", { clientId: c1.client, title: "Licence", lines: [] })).json;
    const won = await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: q.id });
    expect(won.status).toBe(201);
    const closed = (await admin.get(`/api/opps/${id}`)).json;
    expect(closed.status).toBe("won");
    expect((await admin.post(`/api/opps/${id}/links`, { kind: "quote", refId: q.id })).json.error).toBe("link_exists");
    // a won one keeps its last link
    const links = (await admin.get(`/api/opps/${id}`)).json.links as { id: string }[];
    for (const l of links.slice(1)) expect((await admin.del(`/api/opps/${id}/links/${l.id}`)).status).toBe(200);
    expect((await admin.del(`/api/opps/${id}/links/${links[0].id}`)).json.error).toBe("link_required");
  });

  it("the archive is never deleted: no route removes an opportunity", async () => {
    const admin = await session("admin@akab.local");
    const id = (await admin.get("/api/opps?owner=me")).json.items[0].id;
    expect((await admin.del(`/api/opps/${id}`)).status).toBe(404);
    expect((await admin.get(`/api/opps/${id}`)).status).toBe(200);
    expect((await admin.get("/api/opps/not-a-uuid")).status).toBe(404);
  });

  it("the report counts by status and source, the technician who flagged, and money only for who may see it", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const rep = (await admin.get("/api/opps/report")).json;
    expect(rep.money).toBe(true);
    // O-1001 won, O-1002 and the ticket one still new, the one reopened is working
    expect(rep.totals.byStatus).toMatchObject({ new: 2, working: 1, won: 1, lost: 0, canceled: 0 });
    expect(rep.totals.conversionPct).toBe(100);
    expect(rep.bySource).toMatchObject({ ticket: 1, sales_call: 1, other: 2 });
    expect(rep.byTechnician.map((t: any) => t.name)).toEqual(expect.arrayContaining([techName, adminName]));
    // the won one: a quote of 5 000 $ implementation + 12 × 100 $ support, margin 2 000 $ + 12 × 100 $
    const won = rep.closed.find((o: any) => o.status === "won");
    expect(won.valueCents).toBe(500000 + 12 * 10000);
    expect(won.marginCents).toBe(200000 + 12 * 10000);
    expect(rep.totals.wonValueCents).toBe(620000);
    // a technician sees no money
    const hidden = (await tech.get("/api/opps/report")).json;
    expect(hidden.money).toBe(false);
    expect(hidden.totals.wonValueCents).toBeNull();
    expect(hidden.closed.find((o: any) => o.status === "won").valueCents).toBeNull();
    // a range before anything is empty
    expect((await admin.get("/api/opps/report?from=2000-01-01&to=2000-01-31")).json.totals.total).toBe(0);
  });

  it("the sidebar badge counts new ones and mine; the candidates for a notice flag the managers", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    // new: O-1002 and the ticket one; mine (admin): the reopened O-1004
    expect((await admin.get("/api/opps/badge")).json).toEqual({ new: 2, mine: 1 });
    expect((await tech.get("/api/opps/badge")).json).toEqual({ new: 2, mine: 0 });
    const cands = (await tech.get("/api/opps/notify-candidates")).json;
    expect(cands.find((p: any) => p.name === adminName)).toMatchObject({ sales: true });
    expect(cands.find((p: any) => p.name === techName)).toMatchObject({ sales: false });
    expect((await tech.get("/api/opps/notify-candidates")).status).toBe(200);
  });

  it("chosen people are told by bell and email; an unknown person is refused; the flagger is left out", async () => {
    const admin = await userId("admin@akab.local");
    const tech = await session("tech@akab.local");
    const told = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Demande pour Sophie", handling: "needs_call", notifyUserIds: [admin] });
    expect(told.status).toBe(201);
    expect(told.json).toMatchObject({ notified: 1, notifyFailed: 0 });
    // the outbox keeps only its last messages: look for this one by its text
    const mail = [...devOutbox].reverse().find((m) => m.to === "admin@akab.local" && m.text.includes("Demande pour Sophie"));
    expect(mail).toBeTruthy();
    expect(mail!.subject).toMatch(/^\[O-\d+\] Garage Opps$/);
    expect(mail!.text).toContain("Appeler le client pour faire la vente");
    // nobody else got it by email
    expect(devOutbox.filter((m) => m.text.includes("Demande pour Sophie")).map((m) => m.to)).toEqual(["admin@akab.local"]);
    const bell = await db().select().from(schema.notifications).where(and(eq(schema.notifications.userId, admin), eq(schema.notifications.type, "opp.new")));
    expect(bell.length).toBeGreaterThanOrEqual(2);

    // the flagger picked himself: nobody is told
    const self = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "Pour moi", notifyUserIds: [await userId("tech@akab.local")] });
    expect(self.json).toMatchObject({ notified: 0, notifyFailed: 0 });
    // a random id is not a person who sees opportunities
    const bad = await tech.post("/api/opps", { clientId: c1.client, contactId: c1.contact, description: "x", notifyUserIds: ["00000000-0000-4000-8000-000000000000"] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("person_invalid");
  });
});

describe("opportunités: pickers and creation from a ticket", () => {
  it("the client and contact pickers show active records only, with display fields", async () => {
    const tech = await session("tech@akab.local");
    const byName = (await tech.get("/api/opps/clients?q=garage")).json;
    expect(byName).toEqual([expect.objectContaining({ id: c1.client, name: "Garage Opps", autotaskId: 880001 })]);
    expect((await tech.get("/api/opps/clients?q=autre%20opps")).json.map((c: any) => c.id)).toEqual([c2.client]);
    expect((await tech.get("/api/opps/clients?q=rien-de-tel")).json).toEqual([]);
    const contacts = (await tech.get(`/api/opps/clients/${c1.client}/contacts`)).json;
    expect(contacts).toEqual([expect.objectContaining({ id: c1.contact, name: "Anne Roy", email: "anne@garage.test" })]);
    // an inactive client is not offered
    await db().update(schema.clients).set({ active: false }).where(eq(schema.clients.id, c2.client));
    expect((await tech.get("/api/opps/clients?q=autre")).json).toEqual([]);
    expect((await tech.get(`/api/opps/clients/${c2.client}/contacts`)).status).toBe(404);
    await db().update(schema.clients).set({ active: true }).where(eq(schema.clients.id, c2.client));
  });

  it("the linkables are the client's items with the labels the link route stores; technicians cannot list them", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const q = (await admin.post("/api/quotes", { clientId: c1.client, title: "Migration", lines: [] })).json;
    const quotes = (await admin.get(`/api/opps/clients/${c1.client}/linkables?kind=quote`)).json;
    expect(quotes).toEqual(expect.arrayContaining([{ id: q.id, label: `${q.number} - Migration` }]));
    expect(quotes.every((x: any) => x.id !== undefined && x.label !== undefined)).toBe(true);
    expect((await admin.get(`/api/opps/clients/${c1.client}/linkables?kind=contract`)).status).toBe(200);
    expect((await admin.get(`/api/opps/clients/${c1.client}/linkables?kind=project`)).json).toEqual([]);
    expect((await admin.get(`/api/opps/clients/${c1.client}/linkables?kind=charge`)).json.error).toBe("invalid_kind");
    expect((await tech.get(`/api/opps/clients/${c1.client}/linkables?kind=quote`)).status).toBe(403);
  });

  it("from a ticket the client comes from the ticket; the contact is the one sent or the ticket's; a clash is refused", async () => {
    const tech = await session("tech@akab.local");
    const made = await tech.post("/api/tickets", { title: "Sans contact", description: "x", companyId: 880001, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    expect(made.status).toBe(201);
    const t = made.json.id;

    // no client sent, no contact, and the ticket names no contact: refused
    expect((await tech.post("/api/opps", { ticketId: t, description: "Depuis le billet" })).json.error).toBe("contact_required");
    // no client and no contact sent without a ticket
    expect((await tech.post("/api/opps", { description: "x" })).json.error).toBe("client_required");
    expect((await tech.post("/api/opps", { clientId: c1.client, description: "x" })).json.error).toBe("contact_required");

    // the client comes from the ticket; the contact is the one sent
    const sent = await tech.post("/api/opps", { ticketId: t, contactId: c1.contact, description: "Depuis le billet" });
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({ source: "ticket", client: { id: c1.client, name: "Garage Opps" }, contact: { id: c1.contact } });
    // a client sent must be the ticket's
    expect((await tech.post("/api/opps", { ticketId: t, clientId: c2.client, contactId: c2.contact, description: "x" })).json.error).toBe("ticket_other_client");
    // the same client sent is fine
    expect((await tech.post("/api/opps", { ticketId: t, clientId: c1.client, contactId: c1.contact, description: "x" })).status).toBe(201);

    // the ticket names its contact: that contact is used when none is sent
    await db().update(schema.clientContacts).set({ autotaskId: "AT-ANNE-OPPS" }).where(eq(schema.clientContacts.id, c1.contact));
    await db().update(schema.tickets).set({ contactId: "AT-ANNE-OPPS" }).where(eq(schema.tickets.id, t));
    const named = await tech.post("/api/opps", { ticketId: t, description: "Contact du billet" });
    expect(named.status).toBe(201);
    expect(named.json.contact).toMatchObject({ id: c1.contact, name: "Anne Roy" });
  });
});
