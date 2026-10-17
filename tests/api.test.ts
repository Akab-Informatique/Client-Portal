import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "true";
process.env.REQUIRE_MFA = "true";

const { initDb, db, schema } = await import("../server/db/index.ts");
const { seed } = await import("../server/db/seed.ts");
const { createApp } = await import("../server/app.ts");
const { eq } = await import("drizzle-orm");
const { resetRateLimit } = await import("../server/lib/http.ts");

let app: ReturnType<typeof createApp>;
const PASSWORD = "akab-dev-password";

/** Minimal browser: keeps the session cookie, sends JSON + same-origin headers. */
class Agent {
  cookie = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: {
        host: "localhost",
        origin: "http://localhost",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Apply Set-Cookie headers in order, like a browser
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
    return { status: res.status, json, location: res.headers.get("location") };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  put = (p: string, b: unknown) => this.req("PUT", p, b);
  del = (p: string) => this.req("DELETE", p);
}

const secrets = new Map<string, string>();
let stepOffset = 0;
function code(secret: string, offsetSteps = 0) {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

/** Full sign-in incl. MFA enrollment/challenge. Each call uses a fresh time-step. */
async function signIn(email: string, password = PASSWORD): Promise<Agent> {
  const a = new Agent();
  // The suite signs in more often than the per-IP login limit allows (tests share one IP)
  resetRateLimit("login:ip:unknown");
  const r = await a.post("/api/auth/login", { email, password });
  expect(r.status).toBe(200);
  if (r.json.stage === "mfa-setup") {
    const s = await a.post("/api/auth/mfa/setup");
    expect(s.status).toBe(200);
    secrets.set(email, s.json.secret);
  }
  // codes are single-use: move to a fresh window (verify accepts ±1 step)
  stepOffset = stepOffset === 0 ? -1 : stepOffset === -1 ? 1 : 0;
  await db().update(schema.users).set({ mfaLastStep: null }).where(eq(schema.users.email, email));
  const v = await a.post("/api/auth/mfa/verify", { code: code(secrets.get(email)!, stepOffset) });
  expect(v.status).toBe(200);
  return a;
}

beforeAll(async () => {
  await initDb({ memory: true });
  await seed();
  app = createApp();
});

describe("authentication", () => {
  it("rejects a wrong password with a generic error", async () => {
    const r = await new Agent().post("/api/auth/login", { email: "admin@akab.local", password: "nope" });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("invalid_credentials");
  });

  it("requires MFA before anything else", async () => {
    const a = new Agent();
    const r = await a.post("/api/auth/login", { email: "admin@akab.local", password: PASSWORD });
    expect(r.json.stage).toBe("mfa-setup");
    expect((await a.get("/api/auth/me")).json.stage).toBe("mfa-setup");
    expect((await a.get("/api/dashboard/summary")).status).toBe(401);
    expect((await a.get("/api/admin/staff")).status).toBe(401);
  });

  it("enrolls MFA, then a used code cannot be replayed", async () => {
    const a = await signIn("admin@akab.local");
    expect((await a.get("/api/auth/me")).json.stage).toBe("ready");
    const replay = new Agent();
    await replay.post("/api/auth/login", { email: "admin@akab.local", password: PASSWORD });
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    // same step as the one just accepted
    const used = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secrets.get("admin@akab.local")!) }).generate({
      timestamp: u.mfaLastStep! * 30_000,
    });
    expect((await replay.post("/api/auth/mfa/verify", { code: used })).status).toBe(401);
  });

  it("challenge cookie cannot re-run MFA setup once enabled", async () => {
    const a = new Agent();
    await a.post("/api/auth/login", { email: "admin@akab.local", password: PASSWORD });
    expect((await a.post("/api/auth/mfa/setup")).status).toBe(409);
  });

  it("blocks cross-site and non-JSON posts", async () => {
    const a = new Agent();
    expect((await a.req("POST", "/api/auth/login", { email: "x@y.z", password: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    const form = await app.request("/api/auth/login", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" },
      body: "email=a&password=b",
    });
    expect(form.status).toBe(415);
  });

  it("locks the account after 10 wrong passwords", async () => {
    const email = "employe3@client.example";
    for (let i = 0; i < 10; i++) await new Agent().post("/api/auth/login", { email, password: `bad-${i}` });
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, email));
    expect(u.lockedUntil && u.lockedUntil > new Date()).toBe(true);
    await db().update(schema.users).set({ lockedUntil: null, failedLogins: 0 }).where(eq(schema.users.email, email));
  });
});

describe("permissions", () => {
  it("technician has no admin access; admin does", async () => {
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json;
    expect(me.isAdmin).toBe(false);
    expect(me.permissions).toContain("messages.post");
    expect((await tech.get("/api/admin/staff")).status).toBe(403);
    expect((await tech.post("/api/admin/roles", { name: "x", audience: "staff", permissions: [] })).status).toBe(403);
    const admin = await signIn("admin@akab.local");
    const ame = (await admin.get("/api/me")).json;
    expect(ame.isAdmin).toBe(true);
    expect((await admin.get("/api/admin/staff")).status).toBe(200);
  });

  it("weekly meeting dashboard: administrators get it, technicians do not by default", async () => {
    const admin = await signIn("admin@akab.local");
    expect((await admin.get("/api/me")).json.permissions).toContain("meetings.view");
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/me")).json.permissions).not.toContain("meetings.view");
    expect((await tech.get("/api/meetings/overdue")).status).toBe(403);
  });

  it("weekly meeting: overdue open tickets, grouped by technician", async () => {
    const admin = await signIn("admin@akab.local");
    const r = await admin.get("/api/meetings/overdue");
    expect(r.status).toBe(200);
    const all = (await admin.get("/api/tickets?view=all")).json.items;
    const until = new Date(r.json.until).getTime();
    const expected = all.filter((t: any) => t.statusKind !== "complete" && new Date(t.dueAt).getTime() <= until);
    const listed = [...r.json.technicians.flatMap((p: any) => p.tickets), ...r.json.unassigned];
    const late = expected.filter((t: any) => new Date(t.dueAt).getTime() < Date.now());
    expect(r.json.total).toBe(late.length);
    expect(r.json.dueThisWeek).toBe(expected.length - late.length);
    expect(new Set(listed.filter((t: any) => t.overdue).map((t: any) => t.id))).toEqual(new Set(late.map((t: any) => t.id)));
    expect(listed.map((t: any) => t.id).sort()).toEqual(expected.map((t: any) => t.id).sort());
    // every technician is listed, even with nothing overdue
    expect(r.json.technicians.length).toBeGreaterThan(1);
    for (const p of r.json.technicians) for (const t of p.tickets) expect(expected.find((e: any) => e.id === t.id).assignee.id).toBe(p.id);
    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/meetings/overdue")).status).toBe(403);
  });

  it("weekly meeting: absences calendar", async () => {
    const admin = await signIn("admin@akab.local");
    const team = (await admin.get("/api/meetings/team")).json;
    const alex = team.find((u: any) => u.name === "Alex Tremblay");
    const r = await admin.post("/api/meetings/absences", { userId: alex.id, startDate: "2026-11-02", endDate: "2026-11-06", kind: "vacation", note: "Floride" });
    expect(r.status).toBe(201);
    // end before start, impossible day, unknown person
    expect((await admin.post("/api/meetings/absences", { userId: alex.id, startDate: "2026-11-06", endDate: "2026-11-02" })).status).toBe(400);
    expect((await admin.post("/api/meetings/absences", { userId: alex.id, startDate: "2026-02-30", endDate: "2026-03-01" })).status).toBe(400);
    const client = (await signIn("responsable1@client.example").then((c) => c.get("/api/me"))).json;
    expect((await admin.post("/api/meetings/absences", { userId: client.id, startDate: "2026-11-02", endDate: "2026-11-02" })).status).toBe(400);

    // the range returns absences that overlap it
    const inRange = (from: string, to: string) => admin.get(`/api/meetings/absences?from=${from}&to=${to}`).then((x) => x.json.map((a: any) => a.id));
    expect(await inRange("2026-10-26", "2026-11-02")).toContain(r.json.id);
    expect(await inRange("2026-11-06", "2026-11-30")).toContain(r.json.id);
    expect(await inRange("2026-11-07", "2026-11-30")).not.toContain(r.json.id);
    const [a] = (await admin.get("/api/meetings/absences?from=2026-11-01&to=2026-11-30")).json;
    expect(a).toMatchObject({ name: "Alex Tremblay", kind: "vacation", note: "Floride" });
    expect((await admin.get("/api/meetings/absences?from=2026-11-30&to=2026-11-01")).status).toBe(400);

    // the Tickets planning calendar shows the same absences, and warns when time is booked on one
    const plan = (await admin.get(`/api/planning/absences?technicianId=${alex.id}&from=2026-11-02T05:00:00.000Z&to=2026-11-09T05:00:00.000Z`)).json;
    expect(plan.map((x: any) => x.id)).toEqual([r.json.id]);
    const booked = await admin.post("/api/planning/calendar", { technicianId: alex.id, kind: "slot", title: "Inventaire", startsAt: "2026-11-04T14:00:00.000Z", endsAt: "2026-11-04T15:00:00.000Z" });
    expect(booked.status).toBe(201);
    expect(booked.json.warnings).toContain("absent");
    const free = await admin.post("/api/planning/calendar", { technicianId: alex.id, kind: "slot", title: "Inventaire", startsAt: "2026-11-09T14:00:00.000Z", endsAt: "2026-11-09T15:00:00.000Z" });
    expect(free.json.warnings).not.toContain("absent");
    // Thanksgiving 2026 (Monday 12 Oct): a Quebec holiday
    const onHoliday = await admin.post("/api/planning/calendar", { technicianId: alex.id, kind: "slot", title: "Inventaire", startsAt: "2026-10-12T14:00:00.000Z", endsAt: "2026-10-12T15:00:00.000Z" });
    expect(onHoliday.json.warnings).toContain("holiday");
    expect(free.json.warnings).not.toContain("holiday");
    await admin.del(`/api/planning/calendar/${onHoliday.json.id}`);
    await admin.del(`/api/planning/calendar/${booked.json.id}`);
    await admin.del(`/api/planning/calendar/${free.json.id}`);

    expect((await admin.put(`/api/meetings/absences/${r.json.id}`, { userId: alex.id, startDate: "2026-11-03", endDate: "2026-11-03", kind: "sick" })).status).toBe(200);
    expect(await inRange("2026-11-04", "2026-11-30")).not.toContain(r.json.id);

    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/meetings/absences?from=2026-11-01&to=2026-11-30")).status).toBe(403);
    expect((await admin.del(`/api/meetings/absences/${r.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/absences/${r.json.id}`)).status).toBe(404);
  });

  it("weekly meeting: points to discuss", async () => {
    const admin = await signIn("admin@akab.local");
    const a = await admin.post("/api/meetings/points", { text: "Les paies doivent être envoyées avant mardi" });
    const b = await admin.post("/api/meetings/points", { text: "Camille sera absente" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await admin.post("/api/meetings/points", { text: " " })).status).toBe(400);
    let list = (await admin.get("/api/meetings/points")).json;
    expect(list.map((p: any) => p.text)).toEqual(["Les paies doivent être envoyées avant mardi", "Camille sera absente"]);
    expect(list[0].authorName).toBe("Administrateur AKAB");
    expect((await admin.patch(`/api/meetings/points/${a.json.id}`, { done: true })).status).toBe(200);
    list = (await admin.get("/api/meetings/points")).json;
    expect(list.find((p: any) => p.id === a.json.id).doneAt).toBeTruthy();
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/meetings/points")).status).toBe(403);
    expect((await tech.post("/api/meetings/points", { text: "x" })).status).toBe(403);
    expect((await admin.del(`/api/meetings/points/${b.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/points/${b.json.id}`)).status).toBe(404);
    await admin.del(`/api/meetings/points/${a.json.id}`);
  });

  it("weekly meeting: projects in progress with due dates and notes", async () => {
    const admin = await signIn("admin@akab.local");
    const created = await admin.post("/api/meetings/projects", { title: "Installation de caméras", client: "AKAB Informatique", dueDate: "2026-11-15" });
    expect(created.status).toBe(201);
    const id = created.json.id;
    expect((await admin.post("/api/meetings/projects", { title: "Sans date", client: "", dueDate: "" })).status).toBe(201);
    expect((await admin.post("/api/meetings/projects", { title: "x", dueDate: "15/11/2026" })).status).toBe(400);
    expect((await admin.post("/api/meetings/projects", { title: "  " })).status).toBe(400);

    expect((await admin.post(`/api/meetings/projects/${id}/notes`, { text: "Caméras commandées" })).status).toBe(201);
    let list = (await admin.get("/api/meetings/projects")).json;
    const p = list.items.find((x: any) => x.id === id);
    expect(p).toMatchObject({ title: "Installation de caméras", client: "AKAB Informatique", dueDate: "2026-11-15" });
    expect(p.notes.map((n: any) => [n.text, n.authorName])).toEqual([["Caméras commandées", "Administrateur AKAB"]]);
    // a dated project comes before one without a date
    expect(list.items.findIndex((x: any) => x.id === id)).toBeLessThan(list.items.findIndex((x: any) => x.title === "Sans date"));

    expect((await admin.patch(`/api/meetings/projects/${id}`, { dueDate: "2026-11-20", done: true })).status).toBe(200);
    list = (await admin.get("/api/meetings/projects")).json;
    expect(list.items.some((x: any) => x.id === id)).toBe(false);
    expect(list.doneCount).toBe(1);
    const done = (await admin.get("/api/meetings/projects?done=1")).json.items;
    expect(done.find((x: any) => x.id === id).dueDate).toBe("2026-11-20");

    // technicians: no access by default; viewing alone cannot change anything
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/meetings/projects")).status).toBe(403);
    const staff = (await admin.get("/api/admin/staff")).json;
    const techUser = staff.find((u: any) => u.email === "tech@akab.local");
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [{ key: "meetings.view", effect: "allow" }] });
    const viewer = await signIn("tech@akab.local");
    expect((await viewer.get("/api/meetings/projects")).status).toBe(200);
    expect((await viewer.post("/api/meetings/projects", { title: "x" })).status).toBe(403);
    expect((await viewer.post(`/api/meetings/projects/${id}/notes`, { text: "x" })).status).toBe(403);
    expect((await viewer.del(`/api/meetings/projects/${id}`)).status).toBe(403);
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [] });

    // team members: active staff only
    const team = (await admin.get("/api/meetings/team")).json;
    expect(team.map((u: any) => u.name)).toEqual(expect.arrayContaining(["Administrateur AKAB", "Alex Tremblay"]));
    const withTeam = await admin.post("/api/meetings/projects", { title: "Migration", memberIds: [techUser.id] });
    expect(withTeam.status).toBe(201);
    const members = () => admin.get("/api/meetings/projects").then((r) => r.json.items.find((x: any) => x.id === withTeam.json.id).members.map((m: any) => m.name));
    expect(await members()).toEqual(["Alex Tremblay"]);
    const adminUser = staff.find((u: any) => u.email === "admin@akab.local");
    expect((await admin.patch(`/api/meetings/projects/${withTeam.json.id}`, { memberIds: [techUser.id, adminUser.id] })).status).toBe(200);
    expect(await members()).toEqual(["Administrateur AKAB", "Alex Tremblay"]);
    const clientUser = (await signIn("responsable1@client.example").then((c) => c.get("/api/me"))).json;
    expect((await admin.patch(`/api/meetings/projects/${withTeam.json.id}`, { memberIds: [clientUser.id] })).status).toBe(400);
    expect((await admin.patch(`/api/meetings/projects/${withTeam.json.id}`, { memberIds: [] })).status).toBe(200);
    expect(await members()).toEqual([]);

    expect((await admin.del(`/api/meetings/projects/${id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/projects/${id}`)).status).toBe(404);
    expect((await admin.patch("/api/meetings/projects/not-a-uuid", { title: "x" })).status).toBe(404);
  });

  it("client users cannot reach staff APIs", async () => {
    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/messages")).status).toBe(403);
    expect((await client.get("/api/admin/clients")).status).toBe(403);
    expect((await client.get("/api/dashboard/summary")).status).toBe(403);
    expect((await client.get("/api/board")).status).toBe(200);
  });

  it("a direct deny removes a right; a direct allow adds one", async () => {
    const admin = await signIn("admin@akab.local");
    const staff = (await admin.get("/api/admin/staff")).json;
    const tech = staff.find((u: any) => u.email === "tech@akab.local");
    expect(
      (await admin.put(`/api/admin/users/${tech.id}/permissions`, { overrides: [{ key: "messages.post", effect: "deny" }, { key: "admin.clients", effect: "allow" }] })).status,
    ).toBe(200);
    const t = await signIn("tech@akab.local");
    const perms = (await t.get("/api/me")).json.permissions;
    expect(perms).not.toContain("messages.post");
    expect(perms).toContain("admin.clients");
    expect((await t.post("/api/messages", { title: "x", body: "y", audience: "all" })).status).toBe(403);
    expect((await t.get("/api/admin/clients")).status).toBe(200);
    // client-only rights cannot be granted to a technician
    expect((await admin.put(`/api/admin/users/${tech.id}/permissions`, { overrides: [{ key: "board.view", effect: "allow" }] })).status).toBe(400);
    await admin.put(`/api/admin/users/${tech.id}/permissions`, { overrides: [] });
  });

  it("custom roles: create from a selection; system admin role is locked", async () => {
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const adminRole = roles.find((r: any) => r.slug === "administrator");
    expect((await admin.patch(`/api/admin/roles/${adminRole.id}`, { permissions: [] })).status).toBe(409);
    const created = await admin.post("/api/admin/roles", {
      name: "Répartiteur",
      audience: "staff",
      permissions: ["dashboard.view", "messages.view", "messages.post"],
    });
    expect(created.status).toBe(201);
    expect((await admin.post("/api/admin/roles", { name: "Bad", audience: "staff", permissions: ["board.view"] })).status).toBe(400);
    expect((await admin.del(`/api/admin/roles/${created.json.id}`)).status).toBe(200);
  });

  it("counts users per role, per client and email-opted-in recipients", async () => {
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    expect(roles.find((r: any) => r.slug === "administrator").userCount).toBeGreaterThanOrEqual(1);
    expect(roles.find((r: any) => r.slug === "client-user").userCount).toBe(3);
    const clients = (await admin.get("/api/admin/clients")).json;
    expect(clients.every((c: any) => c.userCount === 2)).toBe(true);
    const options = (await admin.get("/api/messages/client-options")).json;
    // demo: 1 opted-in "responsable" per client (employees opted out)
    expect(options.every((c: any) => c.notifyCount === 1)).toBe(true);
  });

  it("cannot lock everyone out of admin", async () => {
    const admin = await signIn("admin@akab.local");
    const me = (await admin.get("/api/me")).json;
    expect((await admin.patch(`/api/admin/users/${me.id}`, { active: false })).status).toBe(409);
    const viewer = (await admin.get("/api/admin/roles")).json.find((r: any) => r.slug === "viewer");
    expect((await admin.patch(`/api/admin/users/${me.id}`, { roleId: viewer.id })).json.error).toBe("last_admin");
  });

  it("creates technicians and client users with a one-time password", async () => {
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const techRole = roles.find((r: any) => r.slug === "technician");
    const r = await admin.post("/api/admin/staff", { email: "New.Tech@AKAB.local", name: "Nouveau Tech", roleId: techRole.id });
    expect(r.status).toBe(201);
    expect(r.json.user.email).toBe("new.tech@akab.local");
    expect(r.json.temporaryPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
    expect((await admin.post("/api/admin/staff", { email: "new.tech@akab.local", name: "Dup" })).json.error).toBe("email_taken");
    // a client role cannot be given to a technician
    const clientRole = roles.find((r: any) => r.slug === "client-user");
    expect((await admin.post("/api/admin/staff", { email: "x2@akab.local", name: "X", roleId: clientRole.id })).json.error).toBe("invalid_role");

    const fresh = new Agent();
    const login = await fresh.post("/api/auth/login", { email: "new.tech@akab.local", password: r.json.temporaryPassword });
    expect(login.json.stage).toBe("mfa-setup");
    const s = await fresh.post("/api/auth/mfa/setup");
    await fresh.post("/api/auth/mfa/verify", { code: code(s.json.secret) });
    expect((await fresh.get("/api/auth/me")).json.stage).toBe("password");
    expect((await fresh.get("/api/messages")).status).toBe(401);
    expect((await fresh.post("/api/auth/password", { current: r.json.temporaryPassword, next: "short" })).json.error).toBe("password_short");
    expect((await fresh.post("/api/auth/password", { current: r.json.temporaryPassword, next: "a-much-longer-password-2026" })).status).toBe(200);
    expect((await fresh.get("/api/auth/me")).json.stage).toBe("ready");
  });
});

describe("message board", () => {
  it("targets selected clients only, and pin/email need their rights", async () => {
    const admin = await signIn("admin@akab.local");
    const clients = (await admin.get("/api/messages/client-options")).json;
    const [c1, c2] = clients;
    const post = await admin.post("/api/messages", {
      title: "Pour un seul client",
      body: "Message ciblé",
      audience: "selected",
      clientIds: [c1.id],
      pinned: true,
      emailCopy: true,
    });
    expect(post.status).toBe(201);
    expect(post.json.clients).toHaveLength(1);
    expect(post.json.pinned).toBe(true);

    const inC1 = await signIn(`responsable${clients.findIndex((x: any) => x.id === c1.id) + 1}@client.example`);
    const board1 = (await inC1.get("/api/board")).json;
    expect(board1.some((m: any) => m.title === "Pour un seul client")).toBe(true);

    const allUsers = await db().select().from(schema.users).where(eq(schema.users.clientId, c2.id));
    const otherEmail = allUsers.find((u) => u.email.startsWith("responsable"))!.email;
    const inC2 = await signIn(otherEmail);
    const board2 = (await inC2.get("/api/board")).json;
    expect(board2.some((m: any) => m.title === "Pour un seul client")).toBe(false);
    expect((await inC2.post(`/api/board/${post.json.id}/read`)).status).toBe(404);
    expect((await inC1.post(`/api/board/${post.json.id}/read`)).status).toBe(200);

    // email copies: only opted-in users of the targeted client (1 responsable)
    await new Promise((r) => setTimeout(r, 50));
    const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, post.json.id));
    expect(m.emailSent).toBe(1);
  });

  it("a read-only user cannot post", async () => {
    const admin = await signIn("admin@akab.local");
    const viewer = (await admin.get("/api/admin/roles")).json.find((r: any) => r.slug === "viewer");
    const created = await admin.post("/api/admin/staff", { email: "viewer@akab.local", name: "Viewer", roleId: viewer.id });
    await db()
      .update(schema.users)
      .set({ mustChangePassword: false, passwordHash: (await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local")))[0].passwordHash })
      .where(eq(schema.users.id, created.json.user.id));
    const v = await signIn("viewer@akab.local");
    expect((await v.get("/api/messages")).status).toBe(200);
    expect((await v.post("/api/messages", { title: "x", body: "y", audience: "all" })).status).toBe(403);
  });
});

describe("view as client", () => {
  it("technicians need the clientview.use right (grantable per user)", async () => {
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/view-as/clients")).status).toBe(403);
    const admin = await signIn("admin@akab.local");
    const techUser = (await admin.get("/api/admin/staff")).json.find((u: any) => u.email === "tech@akab.local");
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [{ key: "clientview.use", effect: "allow" }] });
    const tech2 = await signIn("tech@akab.local");
    expect((await tech2.get("/api/view-as/clients")).status).toBe(200);
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [] });
  });

  it("shows exactly the chosen client's view, read-only, and switches back", async () => {
    const admin = await signIn("admin@akab.local");
    const clients = (await admin.get("/api/view-as/clients")).json;
    const [c1, c2] = clients;
    const only2 = await admin.post("/api/messages", { title: "Seulement client 2", body: "x", audience: "selected", clientIds: [c2.id] });
    expect(only2.status).toBe(201);

    expect((await admin.post("/api/view-as", { clientId: c1.id })).status).toBe(200);
    const me = (await admin.get("/api/auth/me")).json;
    expect(me.stage).toBe("ready");
    expect(me.me.kind).toBe("client");
    expect(me.me.client.id).toBe(c1.id);
    expect(me.me.viewAs.clientName).toBe(c1.name);
    expect(me.me.realUser.email).toBe("admin@akab.local");

    const board = (await admin.get("/api/board")).json;
    expect(board.some((m: any) => m.title === "Seulement client 2")).toBe(false);
    // staff areas are closed while viewing as a client
    expect((await admin.get("/api/admin/staff")).status).toBe(403);
    expect((await admin.get("/api/messages")).status).toBe(403);
    // read only: no writes on the client's behalf
    expect((await admin.post(`/api/board/${board[0].id}/read`)).json.error).toBe("read_only_view");
    expect((await admin.patch("/api/me", { name: "Hacked" })).json.error).toBe("read_only_view");

    // switch to another client, then back to the technician view
    expect((await admin.post("/api/view-as", { clientId: c2.id })).status).toBe(200);
    const board2 = (await admin.get("/api/board")).json;
    expect(board2.some((m: any) => m.title === "Seulement client 2")).toBe(true);
    expect((await admin.del("/api/view-as")).status).toBe(200);
    const back = (await admin.get("/api/auth/me")).json;
    expect(back.me.kind).toBe("staff");
    expect(back.me.viewAs).toBeNull();
    expect((await admin.get("/api/admin/staff")).status).toBe(200);

    const log = (await admin.get("/api/admin/audit")).json.map((e: any) => e.action);
    expect(log).toContain("clientview.start");
    expect(log).toContain("clientview.stop");
  });

  it("ends the client view if the right is removed or the client deactivated", async () => {
    const admin = await signIn("admin@akab.local");
    const techUser = (await admin.get("/api/admin/staff")).json.find((u: any) => u.email === "tech@akab.local");
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [{ key: "clientview.use", effect: "allow" }] });
    const tech = await signIn("tech@akab.local");
    const [c1] = (await tech.get("/api/view-as/clients")).json;
    await tech.post("/api/view-as", { clientId: c1.id });
    expect((await tech.get("/api/auth/me")).json.me.kind).toBe("client");
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [] });
    expect((await tech.get("/api/auth/me")).json.me.kind).toBe("staff");

    // inactive clients cannot be viewed
    const created = await admin.post("/api/admin/clients", { name: "Client inactif" });
    await admin.patch(`/api/admin/clients/${created.json.id}`, { active: false });
    expect((await admin.post("/api/view-as", { clientId: created.json.id })).json.error).toBe("invalid_client");
  });
});

describe("notifications", () => {
  it("a new message notifies the targeted clients and the other technicians, not the author", async () => {
    const admin = await signIn("admin@akab.local");
    const clients = (await admin.get("/api/messages/client-options")).json;
    const target = clients[0];
    const post = await admin.post("/api/messages", { title: "Notif test", body: "x", audience: "selected", clientIds: [target.id] });
    expect(post.status).toBe(201);

    const users = await db().select().from(schema.users);
    const inTarget = users.find((u) => u.clientId === target.id && u.email.startsWith("responsable"))!;
    const elsewhere = users.find((u) => u.clientId && u.clientId !== target.id && u.email.startsWith("responsable"))!;

    const c1 = await signIn(inTarget.email);
    const n1 = (await c1.get("/api/notifications")).json;
    const mine = n1.items.find((n: any) => n.data.title === "Notif test");
    expect(mine.type).toBe("message.new");
    expect(mine.link).toBe(`/?message=${post.json.id}`);
    expect(n1.unread).toBeGreaterThan(0);

    const c2 = await signIn(elsewhere.email);
    expect((await c2.get("/api/notifications")).json.items.some((n: any) => n.data.title === "Notif test")).toBe(false);

    const tech = await signIn("tech@akab.local");
    const tn = (await tech.get("/api/notifications")).json.items.find((n: any) => n.data.title === "Notif test");
    expect(tn.link).toBe(`/messages?message=${post.json.id}`);
    expect((await admin.get("/api/notifications")).json.items.some((n: any) => n.data.title === "Notif test")).toBe(false);

    // mark one read; nobody else can touch it; mark all read
    expect((await c2.post(`/api/notifications/${mine.id}/read`)).status).toBe(404);
    expect((await c1.post(`/api/notifications/${mine.id}/read`)).status).toBe(200);
    expect((await c1.post("/api/notifications/read-all")).status).toBe(200);
    expect((await c1.get("/api/notifications")).json.unread).toBe(0);
  });

  it("an account lockout notifies the admins with a link to that user", async () => {
    const email = "employe2@client.example";
    for (let i = 0; i < 10; i++) await new Agent().post("/api/auth/login", { email, password: `nope-${i}` });
    const admin = await signIn("admin@akab.local");
    const n = (await admin.get("/api/notifications")).json.items.find((x: any) => x.type === "user.locked" && x.data.email === email);
    expect(n).toBeTruthy();
    expect(n.link).toMatch(/^\/\?admin=clients&client=[0-9a-f-]+&user=[0-9a-f-]+$/);
    await db().update(schema.users).set({ lockedUntil: null, failedLogins: 0 }).where(eq(schema.users.email, email));
  });
});

describe("notifications cleanup", () => {
  it("deleting a message removes its notifications for everyone", async () => {
    const admin = await signIn("admin@akab.local");
    const post = await admin.post("/api/messages", { title: "Bientôt supprimé", body: "x", audience: "all" });
    const tech = await signIn("tech@akab.local");
    const has = async () => (await tech.get("/api/notifications")).json.items.some((n: any) => n.data.messageId === post.json.id);
    expect(await has()).toBe(true);
    expect((await admin.del(`/api/messages/${post.json.id}`)).status).toBe(200);
    expect(await has()).toBe(false);
  });
});

describe("dashboards", () => {
  // Reuse sessions: signing in again for every test would hit the login rate limit
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;

  it("built-in Security/Clients/Finance are admin-only until an admin shares them", async () => {
    const admin = await session("admin@akab.local");
    const list = (await admin.get("/api/dashboards")).json;
    expect(list.map((d: any) => d.slug).filter(Boolean)).toEqual(["akab", "security", "clients", "finance"]);
    expect(list[0].isDefault).toBe(true);
    const security = list.find((d: any) => d.slug === "security");
    expect(security.visibility).toBe("admins");
    expect(security.canDelete).toBe(false);

    const tech = await session("tech@akab.local");
    const techList = (await tech.get("/api/dashboards")).json;
    expect(techList.map((d: any) => d.slug).filter(Boolean)).toEqual(["akab"]);
    expect(techList[0].canEdit).toBe(false); // visible to the team, but read-only
    expect(techList[0].canAdminister).toBe(false);

    expect((await admin.patch(`/api/dashboards/${security.id}`, { visibility: "team" })).status).toBe(200);
    const seen = (await tech.get("/api/dashboards")).json.find((d: any) => d.slug === "security");
    expect(seen).toBeTruthy();
    expect(seen.canEdit).toBe(false);
    expect((await tech.patch(`/api/dashboards/${security.id}`, { layout: [] })).status).toBe(403);
    expect((await tech.patch(`/api/dashboards/${security.id}`, { visibility: "admins" })).status).toBe(403);
    expect((await admin.del(`/api/dashboards/${security.id}`)).status).toBe(403);
    await admin.patch(`/api/dashboards/${security.id}`, { visibility: "admins" });
    expect((await tech.get("/api/dashboards")).json.some((d: any) => d.slug === "security")).toBe(false);
  });

  it("private dashboards are owner-only; team dashboards are shared read-only", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const priv = await tech.post("/api/dashboards", { name: "Mes suivis", visibility: "private" });
    expect(priv.status).toBe(201);
    expect((await admin.get("/api/dashboards")).json.some((d: any) => d.id === priv.json.id)).toBe(false);
    expect((await admin.patch(`/api/dashboards/${priv.json.id}`, { layout: [] })).status).toBe(404);

    const team = await tech.post("/api/dashboards", { name: "Équipe support", visibility: "team" });
    const layout = [{ id: "w1", type: "clock", size: "sm" }];
    expect((await tech.patch(`/api/dashboards/${team.json.id}`, { layout })).json.layout).toEqual(layout);
    const asAdmin = (await admin.get("/api/dashboards")).json.find((d: any) => d.id === team.json.id);
    expect(asAdmin.ownerName).toBe("Alex Tremblay");
    expect(asAdmin.canEdit).toBe(true); // dashboard.manage
    expect(asAdmin.visibilityOptions).toEqual([]); // only the owner shares/unshares it

    // a technician without dashboard.manage can view but not edit someone else's team dashboard
    const roles = (await admin.get("/api/admin/roles")).json;
    const techRole = roles.find((r: any) => r.slug === "technician");
    const other = await admin.post("/api/admin/staff", { email: "tech2@akab.local", name: "Tech Deux", roleId: techRole.id });
    await db().update(schema.users).set({ mustChangePassword: false, passwordHash: (await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local")))[0].passwordHash }).where(eq(schema.users.id, other.json.user.id));
    const t2 = await signIn("tech2@akab.local");
    const seen = (await t2.get("/api/dashboards")).json.find((d: any) => d.id === team.json.id);
    expect(seen.canEdit).toBe(false);
    expect((await t2.del(`/api/dashboards/${team.json.id}`)).status).toBe(403);

    expect((await tech.del(`/api/dashboards/${priv.json.id}`)).status).toBe(200);
    expect((await tech.del(`/api/dashboards/${team.json.id}`)).status).toBe(200);
  });

  it("team rights: technicians personalize only when allowed; the default is the admin's", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const akab = (await admin.get("/api/dashboards")).json.find((d: any) => d.slug === "akab");
    const clock = [{ id: "w1", type: "clock", size: "sm" }];
    const mine = [{ id: "w2", type: "welcome", size: "lg" }];
    expect((await tech.patch(`/api/dashboards/${akab.id}`, { layout: [] })).status).toBe(403);
    expect((await tech.put(`/api/dashboards/${akab.id}/my-layout`, { layout: mine })).status).toBe(403);
    expect((await tech.patch(`/api/dashboards/${akab.id}`, { teamAccess: "edit" })).status).toBe(403);

    // admin saves a new default layout: everyone sees it
    expect((await admin.patch(`/api/dashboards/${akab.id}`, { layout: clock })).status).toBe(200);
    let seen = (await tech.get("/api/dashboards")).json.find((d: any) => d.slug === "akab");
    expect(seen.layout).toEqual(clock);
    expect(seen.canEdit).toBe(false);
    expect(seen.canCustomize).toBe(false);

    // allowed to personalize: own layout, the default does not change
    expect((await admin.patch(`/api/dashboards/${akab.id}`, { teamAccess: "edit" })).json.teamAccess).toBe("edit");
    const saved = (await tech.put(`/api/dashboards/${akab.id}/my-layout`, { layout: mine })).json;
    expect(saved).toMatchObject({ layout: mine, defaultLayout: clock, personalLayout: true, canCustomize: true, canEdit: false });
    expect((await tech.patch(`/api/dashboards/${akab.id}`, { layout: mine })).status).toBe(403);
    expect((await admin.get("/api/dashboards")).json.find((d: any) => d.slug === "akab").layout).toEqual(clock);

    // personalizing switched off again: back to the default
    await admin.patch(`/api/dashboards/${akab.id}`, { teamAccess: "view" });
    seen = (await tech.get("/api/dashboards")).json.find((d: any) => d.slug === "akab");
    expect(seen).toMatchObject({ layout: clock, personalLayout: false });
    await admin.patch(`/api/dashboards/${akab.id}`, { teamAccess: "edit" });
    // the personal layout was kept; resetting it shows the default again
    expect((await tech.get("/api/dashboards")).json.find((d: any) => d.slug === "akab").layout).toEqual(mine);
    expect((await tech.del(`/api/dashboards/${akab.id}/my-layout`)).json).toMatchObject({ layout: clock, personalLayout: false });
    // editing widgets is not administering: still no rename/visibility/members
    expect((await tech.patch(`/api/dashboards/${akab.id}`, { visibility: "admins" })).status).toBe(403);
    expect((await tech.put(`/api/dashboards/${akab.id}/members`, { members: [] })).status).toBe(403);
    await admin.patch(`/api/dashboards/${akab.id}`, { teamAccess: "view" });
  });

  it("dashboards can be given to specific people, read-only or editable", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const people = (await tech.get("/api/dashboards/people")).json;
    const techId = people.find((p: any) => p.email === "tech@akab.local").id;
    const security = (await admin.get("/api/dashboards")).json.find((d: any) => d.slug === "security");

    // admins-only dashboard shared with one technician, read-only
    let r = await admin.put(`/api/dashboards/${security.id}/members`, { members: [{ userId: techId, access: "view" }] });
    expect(r.status).toBe(200);
    expect(r.json.members).toEqual([{ userId: techId, name: "Alex Tremblay", access: "view" }]);
    let seen = (await tech.get("/api/dashboards")).json.find((d: any) => d.id === security.id);
    expect(seen.canEdit).toBe(false);
    expect(seen.members).toEqual([]); // only administrators see the list
    expect((await tech.patch(`/api/dashboards/${security.id}`, { layout: [] })).status).toBe(403);

    // upgraded to edit: may personalize, not change the default
    await admin.put(`/api/dashboards/${security.id}/members`, { members: [{ userId: techId, access: "edit" }] });
    expect((await tech.put(`/api/dashboards/${security.id}/my-layout`, { layout: [] })).status).toBe(200);
    expect((await tech.patch(`/api/dashboards/${security.id}`, { layout: [] })).status).toBe(403);

    // client users or unknown ids cannot be added
    const client = (await db().select().from(schema.users).where(eq(schema.users.kind, "client")))[0];
    expect((await admin.put(`/api/dashboards/${security.id}/members`, { members: [{ userId: client.id, access: "view" }] })).status).toBe(400);

    await admin.put(`/api/dashboards/${security.id}/members`, { members: [] });
    expect((await tech.get("/api/dashboards")).json.some((d: any) => d.id === security.id)).toBe(false);
  });

  it("each person picks their default dashboard (Akab otherwise)", async () => {
    const tech = await session("tech@akab.local");
    const mine = (await tech.post("/api/dashboards", { name: "Mon défaut", visibility: "private" })).json;
    expect((await tech.put("/api/dashboards/default", { id: mine.id })).status).toBe(200);
    const list = (await tech.get("/api/dashboards")).json;
    expect(list.filter((d: any) => d.isDefault).map((d: any) => d.id)).toEqual([mine.id]);

    // someone else's private dashboard cannot be a default
    const admin = await session("admin@akab.local");
    expect((await admin.put("/api/dashboards/default", { id: mine.id })).status).toBe(404);

    // deleted → back to Akab
    await tech.del(`/api/dashboards/${mine.id}`);
    const after = (await tech.get("/api/dashboards")).json;
    expect(after.find((d: any) => d.isDefault).slug).toBe("akab");
  });
});

describe("autotask integration", () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
        calls.push({ url, headers });
        if (url.startsWith("https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation")) {
          return json({ zoneName: "Zone 99", url: "https://webservices99.autotask.net/ATServicesRest/", webUrl: "https://ww99.autotask.net/" });
        }
        if (headers.secret !== "good-secret" || headers.apiintegrationcode !== "TRACKING-ID") return json({ errors: ["Unauthorized"] }, 401);
        if (url === "https://webservices99.autotask.net/ATServicesRest/V1.0/ThresholdInformation") {
          return json({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 42 });
        }
        if (url === "https://webservices99.autotask.net/ATServicesRest/V1.0/Resources/query") {
          return json({
            items: [
              { id: 29682885, firstName: "Alex", lastName: "Tremblay", email: "TECH@akab.local" },
              { id: 29682886, firstName: "Autre", lastName: "Personne", email: "autre@example.com" },
            ],
            pageDetails: { nextPageUrl: null },
          });
        }
        return json({ errors: ["not found"] }, 404);
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Back to sample tickets for the next tests
    await db().update(schema.integrations).set({ enabled: false }).where(eq(schema.integrations.provider, "autotask"));
  });

  const sessions = new Map<string, Agent>();
  const session = async (email: string) => sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;

  it("is reserved to admin.integrations", async () => {
    const tech = await session("tech@akab.local");
    expect((await tech.get("/api/admin/integrations/autotask")).status).toBe(403);
    expect((await tech.put("/api/admin/integrations/autotask", { enabled: false })).status).toBe(403);
  });

  it("stores the credentials sealed and never returns or logs them", async () => {
    const admin = await session("admin@akab.local");
    expect((await admin.put("/api/admin/integrations/autotask", { enabled: true })).json.error).toBe("autotask_incomplete");

    const r = await admin.put("/api/admin/integrations/autotask", {
      username: "portal-api@akab.ca",
      secret: "good-secret",
      integrationCode: "TRACKING-ID",
      enabled: true,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, configured: true, username: "portal-api@akab.ca", hasSecret: true, hasIntegrationCode: true });
    expect(r.json.zone.url).toBe("https://webservices99.autotask.net/ATServicesRest/");
    expect(JSON.stringify(r.json)).not.toContain("good-secret");
    expect(JSON.stringify(r.json)).not.toContain("TRACKING-ID");

    const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "autotask"));
    expect(row.secret).toMatch(/^v1./);
    expect(JSON.stringify(row)).not.toContain("good-secret");
    expect(JSON.stringify(row)).not.toContain("TRACKING-ID");
    const logs = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "integration.autotask.updated"));
    expect(JSON.stringify(logs)).not.toContain("good-secret");
    expect(JSON.stringify(logs)).not.toContain("TRACKING-ID");

    // Saving without the secret keeps the stored one
    expect((await admin.put("/api/admin/integrations/autotask", { enabled: true })).json.hasSecret).toBe(true);
  });

  it("tests the connection with the saved or the typed credentials", async () => {
    const admin = await session("admin@akab.local");
    calls.length = 0;
    const ok = await admin.post("/api/admin/integrations/autotask/test", {});
    expect(ok.json).toEqual({ ok: true, zone: { name: "Zone 99", webUrl: "https://ww99.autotask.net/" }, usage: { used: 42, limit: 10000 } });
    const sent = calls.find((x) => x.url.endsWith("/ThresholdInformation"))!;
    expect(sent.headers).toMatchObject({ username: "portal-api@akab.ca", secret: "good-secret", apiintegrationcode: "TRACKING-ID" });
    expect((await admin.get("/api/admin/integrations/autotask")).json.lastTest.ok).toBe(true);

    const bad = await admin.post("/api/admin/integrations/autotask/test", { secret: "wrong" });
    expect(bad.json).toEqual({ ok: false, error: "auth" });
    // a draft test does not change the saved status
    expect((await admin.get("/api/admin/integrations/autotask")).json.lastTest.ok).toBe(true);
  });

  it("links technicians to their Autotask user", async () => {
    const admin = await session("admin@akab.local");
    const links = (await admin.get("/api/admin/integrations/autotask/links")).json;
    expect(links.error).toBeNull();
    expect(links.resources).toHaveLength(2);
    const tech = links.staff.find((s: any) => s.email === "tech@akab.local");
    expect(tech.suggestedResourceId).toBe(29682885);

    expect((await admin.post("/api/admin/integrations/autotask/links/auto", {})).json.linked).toBe(1);
    const [row] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect(row.autotaskResourceId).toBe(29682885);

    const adminRow = links.staff.find((s: any) => s.email === "admin@akab.local");
    expect((await admin.put(`/api/admin/integrations/autotask/links/${adminRow.id}`, { resourceId: 29682885 })).status).toBe(409);
    expect((await admin.put(`/api/admin/integrations/autotask/links/${adminRow.id}`, { resourceId: 123 })).json.error).toBe("autotask_unknown_resource");
    expect((await admin.put(`/api/admin/integrations/autotask/links/${adminRow.id}`, { resourceId: 29682886 })).status).toBe(200);
    expect((await admin.put(`/api/admin/integrations/autotask/links/${adminRow.id}`, { resourceId: null })).status).toBe(200);
  });
});

describe("forgotten password and email", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;
  const outbox = async () => (await import("../server/lib/mail.ts")).devOutbox;
  const lastLink = async (to: string) => {
    const m = [...(await outbox())].reverse().find((x) => x.to === to);
    return m?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  };
  const wait = () => new Promise((r) => setTimeout(r, 50));

  it("answers the same for unknown addresses and emails a single-use link", async () => {
    const anon = new Agent();
    const box = await outbox();
    const before = box.length;
    expect((await anon.post("/api/auth/forgot", { email: "nobody@nowhere.test" })).json).toEqual({ ok: true });
    await wait();
    expect(box.length).toBe(before);

    expect((await anon.post("/api/auth/forgot", { email: "TECH@akab.local" })).json).toEqual({ ok: true });
    await wait();
    const mail = box[box.length - 1];
    expect(mail.to).toBe("tech@akab.local");
    expect(mail.subject).toBe("Réinitialisation de votre mot de passe");
    expect(mail.html).toContain("Réinitialiser mon mot de passe");
    const token = (await lastLink("tech@akab.local"))!;
    expect(token).toBeTruthy();
    // only the hash is stored
    const rows = await db().select().from(schema.passwordTokens);
    expect(JSON.stringify(rows)).not.toContain(token);

    expect((await anon.post("/api/auth/reset/check", { token })).json).toEqual({ valid: true, purpose: "reset" });
    expect((await anon.post("/api/auth/reset", { token, password: "court" })).json.error).toBe("password_short");
    expect((await anon.post("/api/auth/reset", { token, password: "un-nouveau-mot-de-passe" })).status).toBe(200);
    expect((await anon.post("/api/auth/reset", { token, password: "encore-un-autre-mdp" })).json.error).toBe("invalid_token");
    expect((await anon.post("/api/auth/reset/check", { token })).json).toEqual({ valid: false });
    await wait();
    expect(box[box.length - 1].subject).toBe("Votre mot de passe a été modifié");

    // the new password works (MFA still applies), then put the demo password back
    const again = new Agent();
    expect((await again.post("/api/auth/login", { email: "tech@akab.local", password: "un-nouveau-mot-de-passe" })).status).toBe(200);
    await anon.post("/api/auth/forgot", { email: "tech@akab.local" });
    await wait();
    expect((await anon.post("/api/auth/reset", { token: await lastLink("tech@akab.local"), password: PASSWORD })).status).toBe(200);
  });

  it("sends a welcome link when creating an account, and admins can send a reset link", async () => {
    const admin = await session("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const techRole = roles.find((r: any) => r.slug === "technician");
    const r = await admin.post("/api/admin/staff", { email: "nouveau@akab.local", name: "Nouveau Tech", roleId: techRole.id, sendWelcome: true });
    expect(r.json.welcomeSent).toBe(true);
    await wait();
    const box = await outbox();
    expect(box[box.length - 1]).toMatchObject({ to: "nouveau@akab.local", subject: "Bienvenue sur le portail AKAB" });
    const token = (await lastLink("nouveau@akab.local"))!;
    expect((await new Agent().post("/api/auth/reset/check", { token })).json.purpose).toBe("welcome");

    expect((await admin.post(`/api/admin/users/${r.json.user.id}/send-reset-link`)).status).toBe(200);
    // the new link replaces the welcome link
    expect((await new Agent().post("/api/auth/reset/check", { token })).json.valid).toBe(false);
  });

  it("email settings: admin.email only, password never returned, templates editable", async () => {
    const tech = await session("tech@akab.local");
    expect((await tech.get("/api/admin/email/smtp")).status).toBe(403);
    const admin = await session("admin@akab.local");

    const s = await admin.put("/api/admin/email/smtp", {
      host: "smtp.example.com", port: 587, security: "starttls", user: "portail@akab.ca", pass: "smtp-secret-value", from: "portail@akab.ca", fromName: "AKAB",
    });
    expect(s.json).toMatchObject({ source: "database", host: "smtp.example.com", hasPassword: true });
    expect(JSON.stringify(s.json)).not.toContain("smtp-secret-value");
    const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "smtp"));
    expect(JSON.stringify(row)).not.toContain("smtp-secret-value");
    expect((await admin.del("/api/admin/email/smtp")).json.source).toBe("none");

    const list = (await admin.get("/api/admin/email/templates")).json;
    expect(list.map((x: any) => x.key)).toEqual(["welcome", "passwordReset", "passwordChanged", "boardMessage"]);

    const edited = { subject: "Bonjour {{name}}", body: "Allo {{name}} <script>", action: "Go" };
    const prev = (await admin.post("/api/admin/email/templates/passwordReset/fr/preview", edited)).json;
    expect(prev.subject).toBe("Bonjour Marie Tremblay");
    expect(prev.html).toContain("Allo Marie Tremblay &lt;script&gt;");
    expect((await admin.put("/api/admin/email/templates/passwordReset/fr", edited)).status).toBe(200);
    const one = (await admin.get("/api/admin/email/templates/passwordReset")).json;
    expect(one.locales.fr.edited).toBe(true);
    expect(one.locales.fr.current.subject).toBe("Bonjour {{name}}");
    expect(one.locales.en.edited).toBe(false);
    expect((await admin.del("/api/admin/email/templates/passwordReset/fr")).status).toBe(200);
    expect((await admin.get("/api/admin/email/templates/passwordReset")).json.locales.fr.current.subject).toBe("Réinitialisation de votre mot de passe");
    expect((await admin.get("/api/admin/email/templates/nope")).status).toBe(404);
  });
});

describe("tickets (sample data)", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;

  it("lists by view and filters on the portal-only start date", async () => {
    const tech = await session("tech@akab.local");
    const all = (await tech.get("/api/tickets?view=all")).json;
    expect(all.demo).toBe(true);
    expect(all.items.length).toBeGreaterThan(10);
    const mine = (await tech.get("/api/tickets?view=mine")).json.items;
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const isMine = (t: any) => t.assignee?.id === techRow.id || t.secondary.some((p: any) => p.id === techRow.id);
    expect(mine.every((t: any) => isMine(t) && t.statusKind !== "complete")).toBe(true);
    // secondary tickets count as mine too
    expect(mine.some((t: any) => t.assignee?.id !== techRow.id)).toBe(true);

    const target = all.items[0];
    expect((await tech.put(`/api/tickets/${target.id}/start-date`, { startDate: "2026-11-02" })).status).toBe(200);
    const filtered = (await tech.get("/api/tickets?view=all&startFrom=2026-11-01&startTo=2026-11-03")).json.items;
    expect(filtered.map((t: any) => t.id)).toEqual([target.id]);
    expect(filtered[0].startDate).toBe("2026-11-02");
    expect((await tech.put(`/api/tickets/${target.id}/start-date`, { startDate: "02/11/2026" })).status).toBe(400);
  });

  it("tells who else has a ticket open", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const id = (await tech.get("/api/tickets?view=all")).json.items[1].id;
    expect((await tech.post(`/api/tickets/${id}/presence`)).json.viewers).toEqual([]);
    const seen = (await admin.post(`/api/tickets/${id}/presence`)).json.viewers;
    expect(seen.map((v: any) => v.name)).toEqual(["Alex Tremblay"]);
    expect((await admin.get(`/api/tickets/${id}`)).json.viewers.map((v: any) => v.name)).toEqual(["Alex Tremblay"]);
    await tech.del(`/api/tickets/${id}/presence`);
    expect((await admin.post(`/api/tickets/${id}/presence`)).json.viewers).toEqual([]);
  });

  it("is staff only and creating needs tickets.edit", async () => {
    const client = new Agent();
    resetRateLimit("login:ip:unknown");
    const clientUser = (await db().select().from(schema.users).where(eq(schema.users.kind, "client")))[0];
    await signIn(clientUser.email).then((a) => a.get("/api/tickets").then((r) => expect(r.status).toBe(403)));
    void client;
    const tech = await session("tech@akab.local");
    const r = await tech.post("/api/tickets", {
      title: "Test", description: "", companyId: 300, contact: "", priority: "medium", queue: "Support niveau 1", assigneeId: null, dueDate: "2026-12-01", startDate: "2026-11-30",
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ title: "Test", status: "new", startDate: "2026-11-30" });
  });
});

describe("tickets: technicians added later", () => {
  it("get their share of the sample tickets", async () => {
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const techRole = roles.find((r: any) => r.slug === "technician");
    await admin.get("/api/tickets"); // sample tickets already generated
    const created = await admin.post("/api/admin/staff", { email: "tard@akab.local", name: "Arrivé Tard", roleId: techRole.id });
    await db()
      .update(schema.users)
      .set({ mustChangePassword: false, passwordHash: (await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local")))[0].passwordHash })
      .where(eq(schema.users.id, created.json.user.id));
    const late = await signIn("tard@akab.local");
    const mine = (await late.get("/api/tickets?view=mine")).json;
    expect(mine.counts.mine).toBeGreaterThan(0);
    const uid = created.json.user.id;
    expect(mine.items.every((t: any) => t.assignee?.id === uid || t.secondary.some((p: any) => p.id === uid))).toBe(true);
  });
});

describe("tickets: metrics and saved filters", () => {
  it("returns tile metrics and keeps each technician's filters private", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const list = (await tech.get("/api/tickets")).json;
    expect(Object.keys(list.metrics).sort()).toEqual(["attention", "attentionBreakdown", "mine", "statusAttention", "unassigned"]);
    const needs = (await tech.get("/api/tickets?view=all&status=needsAttention")).json.items;
    expect(needs).toHaveLength(list.metrics.statusAttention);
    expect(needs.every((t: any) => t.status === "needsAttention")).toBe(true);
    const attention = (await tech.get("/api/tickets?view=all&attention=1")).json.items;
    expect(attention).toHaveLength(list.metrics.attention);
    expect(attention.every((t: any) => t.status !== "complete" && (t.priority === "critical" || new Date(t.dueAt).getTime() <= new Date().setHours(23, 59, 59, 999)))).toBe(true);
    expect(list.metrics.mine).toBe(list.counts.mine);

    const saved = await tech.post("/api/tickets/filters", { name: "Critiques réseau", query: "view=all&priority=critical&queue=R%C3%A9seau&evil=1" });
    expect(saved.status).toBe(201);
    expect(saved.json.query).toBe("view=all&priority=critical&queue=R%C3%A9seau");
    expect((await tech.get("/api/tickets/filters")).json.map((f: any) => f.name)).toEqual(["Critiques réseau"]);

    const admin = await signIn("admin@akab.local");
    expect((await admin.get("/api/tickets/filters")).json).toEqual([]);
    await admin.del(`/api/tickets/filters/${saved.json.id}`); // not theirs: no effect
    expect((await tech.get("/api/tickets/filters")).json).toHaveLength(1);
    await tech.del(`/api/tickets/filters/${saved.json.id}`);
    expect((await tech.get("/api/tickets/filters")).json).toEqual([]);
  });
});

describe("tickets: inline edit, notes, team filter and AI", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => {
    resetRateLimit("login:ip:unknown");
    return sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;
  };

  it("edits a ticket inline and adds notes", async () => {
    const tech = await session("tech@akab.local");
    const list = (await tech.get("/api/tickets?view=all")).json;
    const tk = list.items.find((t: any) => t.status !== "complete");
    const admin = list.facets.technicians.find((p: any) => p.name === "Administrateur AKAB");
    const r = await tech.patch(`/api/tickets/${tk.id}`, { status: "waitingCustomer", priority: "low", assigneeId: admin.id, dueDate: "2026-12-24" });
    expect(r.json).toMatchObject({ status: "waitingCustomer", priority: "low", assignee: { id: admin.id } });
    expect(r.json.dueAt.slice(0, 10)).toBe("2026-12-24");
    expect((await tech.patch(`/api/tickets/${tk.id}`, { status: "nope" })).status).toBe(400);

    const byAdmin = (await tech.get(`/api/tickets?view=all&assignee=${admin.id}`)).json.items;
    expect(byAdmin.some((t: any) => t.id === tk.id)).toBe(true);
    expect(byAdmin.every((t: any) => t.assignee?.id === admin.id)).toBe(true);

    expect((await tech.post(`/api/tickets/${tk.id}/notes`, { text: "Rappel prévu demain", internal: true })).status).toBe(201);
    const detail = (await tech.get(`/api/tickets/${tk.id}`)).json;
    expect(detail.notes.at(-1)).toMatchObject({ author: "Alex Tremblay", text: "Rappel prévu demain", internal: true });
  });

  it("AI needs its right, a configured key, and never exposes the key", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const id = (await admin.get("/api/tickets?view=all")).json.items[0].id;
    expect((await tech.post(`/api/tickets/${id}/ai/analyze`)).status).toBe(403); // technician role has no tickets.ai
    expect((await admin.post(`/api/tickets/${id}/ai/analyze`)).json.error).toBe("ai_not_configured");

    const s = await admin.put("/api/admin/integrations/ai", { apiKey: "sk-ant-test-secret", enabled: true, model: "claude-haiku-5-5" });
    expect(s.json).toMatchObject({ enabled: true, hasKey: true, model: "claude-haiku-5-5" });
    expect(JSON.stringify(s.json)).not.toContain("sk-ant-test-secret");
    expect((await admin.get("/api/tickets")).json.ai).toBe(true);

    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
      const text = JSON.stringify({ summary: "Imprimante hors ligne.", nextSteps: ["Vérifier le câble", "Redémarrer"], risks: [], questions: ["Depuis quand ?"], suggestedPriority: "medium" });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "```json\n" + text + "\n```" }] }), { status: 200 });
    }));
    try {
      const a = await admin.post(`/api/tickets/${id}/ai/analyze`);
      expect(a.status).toBe(201);
      expect(a.json.content.nextSteps).toEqual(["Vérifier le câble", "Redémarrer"]);
      expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(sent[0].headers["x-api-key"]).toBe("sk-ant-test-secret");
      expect(sent[0].body.model).toBe("claude-haiku-5-5");
      expect((await admin.get(`/api/tickets/${id}/ai`)).json[0].content.summary).toBe("Imprimante hors ligne.");
    } finally {
      vi.unstubAllGlobals();
    }
    await admin.put("/api/admin/integrations/ai", { enabled: false });
  });
});

describe("tickets: client and contact", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => {
    resetRateLimit("login:ip:unknown");
    return sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;
  };
  it("lists and creates contacts, and changes a ticket's client and contact", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const contacts = (await tech.get("/api/tickets/companies/301/contacts")).json;
    expect(contacts.length).toBe(3);
    expect(contacts.every((c: any) => c.companyId === 301)).toBe(true);

    const created = await tech.post("/api/tickets/companies/301/contacts", { firstName: "Nadia", lastName: "Gélinas", email: "nadia@exemple.ca", phone: "450-555-0000" });
    expect(created.status).toBe(201);
    expect(created.json.name).toBe("Nadia Gélinas");
    expect((await tech.post("/api/tickets/companies/301/contacts", { firstName: "X", lastName: "Y", email: "pas-un-courriel" })).status).toBe(400);

    const tk = (await tech.get("/api/tickets?view=all")).json.items.find((t: any) => t.company.id !== 301);
    let r = await tech.patch(`/api/tickets/${tk.id}`, { companyId: 301 });
    expect(r.json).toMatchObject({ company: { id: 301 }, contact: "", contactId: null });
    r = await tech.patch(`/api/tickets/${tk.id}`, { contactId: created.json.id });
    expect(r.json).toMatchObject({ contact: "Nadia Gélinas", contactId: created.json.id });
    // a contact of another client is refused
    expect((await tech.patch(`/api/tickets/${tk.id}`, { contactId: "c-300-0" })).json.error).toBe("invalid_contact");

    const nt = await tech.post("/api/tickets", { title: "Avec contact", companyId: 301, contactId: created.json.id, priority: "low", queue: "Support niveau 1", assigneeId: null, dueDate: "2026-12-01" });
    expect(nt.json).toMatchObject({ contact: "Nadia Gélinas", contactId: created.json.id });
  });

  it("edits title, description and secondary technicians", async () => {
    const tech = await session("tech@akab.local");
    const tk = (await tech.get("/api/tickets?view=all")).json.items[3];
    const [admin] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    const r = await tech.patch(`/api/tickets/${tk.id}`, { title: "Nouveau titre", description: "Nouvelle description", secondaryIds: [admin.id] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ title: "Nouveau titre", description: "Nouvelle description", secondary: [{ id: admin.id }] });
    expect((await tech.patch(`/api/tickets/${tk.id}`, { secondaryIds: [] })).json.secondary).toEqual([]);
    expect((await tech.patch(`/api/tickets/${tk.id}`, { secondaryIds: ["nobody"] })).json.error).toBe("invalid_assignee");
    expect((await tech.patch(`/api/tickets/${tk.id}`, { title: "  " })).status).toBe(400);
  });

  it("global search: every ticket, accents ignored, ticket number first", async () => {
    const tech = await session("tech@akab.local");
    const all = (await tech.get("/api/tickets?view=all")).json.items;
    const target = all[5];
    const r = (await tech.get(`/api/tickets/search?q=${encodeURIComponent(target.number)}`)).json;
    expect(r.items[0].id).toBe(target.id);
    // words in any order, no accents needed
    const word = target.title.split(" ").find((w: string) => w.length > 4)!;
    const plain = word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    const found = (await tech.get(`/api/tickets/search?q=${encodeURIComponent(plain)}`)).json;
    expect(found.items.some((x: any) => x.id === target.id)).toBe(true);
    expect(found.archive).toEqual([]);
    expect((await tech.get("/api/tickets/search?q=a")).json.items).toEqual([]);
  });

  it("devices: listed per client, linked to the ticket, with RMM links", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const tk = (await tech.get("/api/tickets?view=all")).json.items.find((x: any) => x.company.id === 300);
    const assets = (await tech.get("/api/tickets/companies/300/assets")).json;
    expect(assets).toHaveLength(3);
    expect(assets[0].links).toEqual({ rmm: null, device: null, remote: null });
    const laptop = assets.find((x: any) => x.id === "a-300-0");
    expect(laptop.contactId).toBe("c-300-0");

    // RMM: admin only, https templates with known placeholders
    expect((await tech.get("/api/admin/integrations/rmm")).status).toBe(403);
    expect((await admin.put("/api/admin/integrations/rmm", { enabled: true, name: "Datto RMM", deviceUrl: "http://rmm.example/{uid}", remoteUrl: "" })).status).toBe(400);
    expect((await admin.put("/api/admin/integrations/rmm", { enabled: true, name: "Datto RMM", deviceUrl: "https://rmm.example/x/{nope}", remoteUrl: "" })).status).toBe(400);
    const saved = await admin.put("/api/admin/integrations/rmm", {
      enabled: true,
      name: "Datto RMM",
      deviceUrl: "https://rmm.example/device/{uid}",
      remoteUrl: "https://rmm.example/remote/{uid}?host={hostname}",
    });
    expect(saved.status).toBe(200);

    const r = await tech.patch(`/api/tickets/${tk.id}`, { assetId: "a-300-0" });
    expect(r.json.asset).toMatchObject({
      id: "a-300-0",
      contactId: "c-300-0",
      links: { rmm: "Datto RMM", device: `https://rmm.example/device/${laptop.rmm.uid}`, remote: `https://rmm.example/remote/${laptop.rmm.uid}?host=${laptop.hostname}` },
    });
    // a device of another client is refused; null removes it
    expect((await tech.patch(`/api/tickets/${tk.id}`, { assetId: "a-301-0" })).json.error).toBe("invalid_value");
    expect((await tech.patch(`/api/tickets/${tk.id}`, { assetId: null })).json.asset).toBeNull();
    await admin.put("/api/admin/integrations/rmm", { enabled: false, name: "", deviceUrl: "", remoteUrl: "" });
  });

  it("charges: listed per ticket, added by technicians with tickets.edit", async () => {
    const tech = await session("tech@akab.local");
    const tk = (await tech.get("/api/tickets?view=all")).json.items[2];
    expect((await tech.get(`/api/tickets/${tk.id}/charges`)).json).toEqual([]);
    const o = (await tech.get("/api/tickets/charge-options")).json;
    expect(o.materialCodes.length).toBeGreaterThan(0);
    const r = await tech.post(`/api/tickets/${tk.id}/charges`, {
      name: "Disque SSD 1 To",
      quantity: 2,
      unitPrice: 149.99,
      unitCost: 95,
      billable: true,
      materialCodeId: o.materialCodes[0].value,
    });
    expect(r.status).toBe(201);
    expect(r.json).toEqual([
      expect.objectContaining({ name: "Disque SSD 1 To", quantity: 2, unitPrice: 149.99, billable: true, materialCode: o.materialCodes[0].label, author: "Alex Tremblay", status: "Approuvé" }),
    ]);
    expect((await tech.post(`/api/tickets/${tk.id}/charges`, { name: "x", quantity: 1, materialCodeId: "999" })).json.error).toBe("invalid_value");
    expect((await tech.post(`/api/tickets/${tk.id}/charges`, { name: "", quantity: 0 })).status).toBe(400);

    // from the catalogue / the inventory
    const found = (await tech.get("/api/tickets/products?q=ssd%20samsung")).json;
    expect(found.map((p: any) => p.sku)).toEqual(["MZ-V9P1T0"]);
    expect((await tech.get("/api/tickets/products?q=s")).json).toEqual([]);
    expect((await tech.post(`/api/tickets/${tk.id}/charges`, { name: found[0].name, quantity: 1, unitPrice: found[0].unitPrice, productId: found[0].id })).status).toBe(201);
    expect((await tech.post(`/api/tickets/${tk.id}/charges`, { name: "x", quantity: 1, productId: "nope" })).json.error).toBe("invalid_value");
  });

  it("store inventory: admins manage it; technicians take stock on a ticket charge", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    // reserved to store.view / store.manage (technicians have neither by default)
    expect((await tech.get("/api/store")).status).toBe(403);
    const loc = (await admin.post("/api/store/locations", { name: "Entrepôt" })).json;
    expect((await admin.post("/api/store/locations", { name: "Entrepôt" })).json.error).toBe("location_taken");
    const ssd = (await admin.post("/api/store/products", { sku: "SSD-1T", name: "SSD 1 To", priceCents: 18999, costCents: 12950, minQuantity: 2 })).json;
    expect((await admin.post("/api/store/products", { sku: "SSD-1T", name: "Autre", priceCents: 1 })).json.error).toBe("sku_taken");
    const rec = await admin.post(`/api/store/products/${ssd.id}/receive`, { locationId: loc.id, quantity: 5, unitCostCents: 12500, supplier: "Ingram Micro", reference: "F-123", purchasedAt: "2026-10-10" });
    expect(rec.json.quantity).toBe(5);
    expect((await admin.post(`/api/store/products/${ssd.id}/adjust`, { locationId: loc.id, quantity: 4, note: "Décompte" })).json.quantity).toBe(4);
    // the purchase is kept: supplier, invoice, cost (and the product cost follows)
    expect((await admin.get(`/api/store/products/${ssd.id}/receipts`)).json).toEqual([expect.objectContaining({ quantity: 5, unitCostCents: 12500, supplier: "Ingram Micro", reference: "F-123", purchasedAt: "2026-10-10", location: "Entrepôt" })]);
    expect((await admin.get("/api/store/suppliers")).json).toEqual(["Ingram Micro"]);
    let store = (await admin.get("/api/store")).json;
    expect(store.products.find((p: any) => p.id === ssd.id)).toMatchObject({ total: 4, low: false, stock: [{ location: "Entrepôt", quantity: 4 }] });
    expect(store.stats).toMatchObject({ active: 1, units: 4, valueCents: 4 * 12500 });

    // the charge form searches the portal inventory; taking 3 lowers the stock and logs the ticket
    const found = (await tech.get("/api/tickets/store-products?q=ssd")).json;
    expect(found).toEqual([expect.objectContaining({ id: ssd.id, unitPrice: 189.99, total: 4, stock: [{ locationId: loc.id, location: "Entrepôt", quantity: 4 }] })]);
    const tk = (await tech.get("/api/tickets?view=all")).json.items[4];
    const take = (quantity: number) => tech.post(`/api/tickets/${tk.id}/charges`, { name: "SSD 1 To", quantity, unitPrice: 189.99, storeProductId: ssd.id, locationId: loc.id });
    expect((await take(3)).status).toBe(201);
    expect((await take(2)).json.error).toBe("insufficient_stock");
    expect((await take(0.5)).status).toBe(400);
    // without taking stock (bought for this client)
    expect((await tech.post(`/api/tickets/${tk.id}/charges`, { name: "SSD 1 To", quantity: 2, unitPrice: 189.99, storeProductId: ssd.id })).status).toBe(201);
    // a technician adds a product that does not exist yet
    const made = await tech.post("/api/tickets/store-products", { name: "Câble HDMI 2 m", sku: "HDMI-2M", priceCents: 1999, costCents: 600 });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ name: "Câble HDMI 2 m", unitPrice: 19.99, total: 0, stock: [] });
    expect((await tech.post("/api/tickets/store-products", { name: "Autre", sku: "HDMI-2M", priceCents: 1 })).json.error).toBe("sku_taken");
    store = (await admin.get("/api/store")).json;
    expect(store.products.find((p: any) => p.id === ssd.id)).toMatchObject({ total: 1, low: true });
    const moves = (await admin.get(`/api/store/products/${ssd.id}/movements`)).json;
    expect(moves.map((m: any) => [m.kind, m.delta, m.ticketNumber])).toEqual([
      ["ticket", -3, tk.number],
      ["adjust", -1, null],
      ["receive", 5, null],
    ]);
    expect(moves[0].user).toBe("Alex Tremblay");
  });

  it("serialized products: received by serial number, the ones taken are chosen on the ticket", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const [loc] = (await admin.get("/api/store")).json.locations;
    const fw = (await admin.post("/api/store/products", { sku: "FG-40F", name: "Pare-feu FortiGate 40F", priceCents: 79900, costCents: 60000, serialized: true })).json;
    const receive = (serials: string[]) => admin.post(`/api/store/products/${fw.id}/receive`, { locationId: loc.id, serials, unitCostCents: 61000, supplier: "Synnex", reference: "PO-77" });
    expect((await receive([])).json.error).toBe("serials_required");
    expect((await receive(["FGT40F-A", "fgt40f-a"])).json).toMatchObject({ error: "serial_exists", fields: [{ path: "serial", message: "fgt40f-a" }] });
    expect((await receive(["FGT40F-A", "FGT40F-B", " FGT40F-C "])).json.quantity).toBe(3);
    expect((await receive(["FGT40F-B"])).json).toMatchObject({ error: "serial_exists", fields: [{ message: "FGT40F-B" }] });
    // cannot stop being serialized while units are in stock
    expect((await admin.patch(`/api/store/products/${fw.id}`, { serialized: false })).json.error).toBe("has_stock");

    // the charge form lists the serials in stock; the chosen ones go to the ticket
    const inStock = (await tech.get(`/api/tickets/store-products/${fw.id}/serials?locationId=${loc.id}`)).json;
    expect(inStock.map((s: any) => s.serial)).toEqual(["FGT40F-A", "FGT40F-B", "FGT40F-C"]);
    const tk = (await tech.get("/api/tickets?view=all")).json.items[6];
    const charge = (serialIds: string[], quantity = serialIds.length) =>
      tech.post(`/api/tickets/${tk.id}/charges`, { name: fw.name, quantity, unitPrice: 799, storeProductId: fw.id, locationId: loc.id, serialIds });
    expect((await charge([inStock[0].id], 2)).json.error).toBe("serials_required");
    const r = await charge([inStock[1].id]);
    expect(r.status).toBe(201);
    expect(r.json.at(-1).description).toContain("N° de série : FGT40F-B");
    expect((await charge([inStock[1].id])).json.error).toBe("serial_unavailable");

    // a broken unit is taken out with a note
    expect((await admin.post(`/api/store/products/${fw.id}/adjust`, { locationId: loc.id, removeSerialIds: [inStock[2].id], note: "Brisé à la réception" })).json.quantity).toBe(1);
    const serials = (await admin.get(`/api/store/products/${fw.id}/serials`)).json;
    expect(serials.map((s: any) => [s.serial, s.status, s.ticketNumber, s.supplier])).toEqual([
      ["FGT40F-A", "in_stock", null, "Synnex"],
      ["FGT40F-C", "removed", null, "Synnex"],
      ["FGT40F-B", "used", tk.number, "Synnex"],
    ]);
    const moves = (await admin.get(`/api/store/products/${fw.id}/movements`)).json;
    expect(moves.map((m: any) => [m.kind, m.delta, m.serials])).toEqual([
      ["adjust", -1, ["FGT40F-C"]],
      ["ticket", -1, ["FGT40F-B"]],
      ["receive", 3, ["FGT40F-A", "FGT40F-B", "FGT40F-C"]],
    ]);
    expect(moves[2]).toMatchObject({ supplier: "Synnex", reference: "PO-77", unitCostCents: 61000 });
  });

  it("priorities of the day / week: given by an admin, carried over until done, on the calendar", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [a, b, c] = (await tech.get("/api/tickets?view=all")).json.items;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    const plus = (days: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

    // only planners give priorities; a technician only sees their own
    expect((await tech.post("/api/planning/pins", { ticketId: a.id, technicianId: techRow.id })).status).toBe(403);
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    expect((await tech.get(`/api/planning/pins?technicianId=${adminRow.id}`)).status).toBe(403);

    expect((await admin.post("/api/planning/pins", { ticketId: a.id, technicianId: techRow.id, horizon: "day", note: "Rappeler le client avant midi" })).status).toBe(201);
    expect((await admin.post("/api/planning/pins", { ticketId: b.id, technicianId: techRow.id, horizon: "week", note: "Finir la migration" })).status).toBe(201);
    const mine = (await tech.get("/api/planning/pins")).json;
    expect(mine.map((p: any) => [p.ticketId, p.bucket, p.note])).toEqual([
      [a.id, "day", "Rappeler le client avant midi"],
      [b.id, "week", "Finir la migration"],
    ]);
    expect(mine[0]).toMatchObject({ pinnedByName: "Administrateur AKAB", status: { kind: expect.any(String) } });
    const bell = (await tech.get("/api/notifications")).json.items.find((n: any) => n.type === "ticket.pinned");
    expect(bell).toMatchObject({ link: `/tickets?ticket=${b.id}`, data: { number: b.number, horizon: "week" } });
    // marked in the list
    const listed = (await tech.get("/api/tickets?view=all")).json.items;
    expect(listed.find((x: any) => x.id === a.id).myPriority).toBe("day");

    // next week: both carried over until done
    const later = (await tech.get(`/api/planning/pins?date=${plus(8)}`)).json;
    expect(later.map((p: any) => p.bucket)).toEqual(["carried", "carried"]);
    expect((await tech.post(`/api/planning/pins/${mine[0].id}/done`, { done: true })).status).toBe(200);
    expect((await tech.get(`/api/planning/pins?date=${plus(8)}`)).json.map((p: any) => p.ticketId)).toEqual([b.id]);
    expect((await tech.get(`/api/planning/pins/ticket/${b.id}`)).json).toEqual([expect.objectContaining({ technician: "Alex Tremblay", note: "Finir la migration", horizon: "week" })]);

    // calendar: reserving time for a ticket makes it a priority of that week
    const start = new Date(`${plus(1)}T13:00:00Z`);
    const block = (body: object) => admin.post("/api/planning/calendar", { technicianId: techRow.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3_600_000).toISOString(), ...body });
    expect((await tech.post("/api/planning/calendar", { technicianId: techRow.id, ticketId: c.id, startsAt: start.toISOString(), endsAt: start.toISOString() })).status).toBe(403);
    expect((await admin.post("/api/planning/calendar", { technicianId: techRow.id, ticketId: c.id, startsAt: start.toISOString(), endsAt: start.toISOString() })).json.error).toBe("invalid_time");
    const r = await block({ ticketId: c.id, note: "Sur place" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ticketNumber: c.number, title: c.title });
    expect((await block({ kind: "slot", title: "Formation interne" })).status).toBe(201);
    const from = new Date(`${plus(-7)}T00:00:00Z`).toISOString();
    const to = new Date(`${plus(14)}T00:00:00Z`).toISOString();
    const cal = (await tech.get(`/api/planning/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json;
    expect(cal.map((x: any) => x.title)).toEqual([c.title, "Formation interne"]);
    const nowPins = (await tech.get(`/api/planning/pins?date=${plus(1)}`)).json;
    expect(nowPins.some((p: any) => p.ticketId === c.id)).toBe(true);
  });

  it("own planning (planSelf), service calls on site, alerts before an event", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    const items = (await tech.get("/api/tickets?view=all")).json.items;
    const tk = items[8];
    const soon = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

    // admins plan their own time by default; a technician only once allowed
    expect((await admin.post("/api/planning/pins", { ticketId: tk.id, technicianId: adminRow.id, horizon: "day" })).status).toBe(201);
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: techRow.id, horizon: "day" })).status).toBe(403);
    expect((await tech.get("/api/planning/technicians")).json).toEqual([{ id: techRow.id, name: "Alex Tremblay" }]);
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [{ key: "tickets.planSelf", effect: "allow" }] });
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: techRow.id, horizon: "day", note: "Moi-même" })).status).toBe(201);
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: adminRow.id })).status).toBe(403);

    // block kinds: on site needs a ticket; reserved slot does not
    const block = (body: object) => tech.post("/api/planning/calendar", { technicianId: techRow.id, startsAt: soon(10), endsAt: soon(70), ...body });
    expect((await block({ kind: "onsite", title: "Visite" })).status).toBe(400);
    const onsite = await block({ kind: "onsite", ticketId: tk.id, reminderMinutes: 15 });
    expect(onsite.status).toBe(201);
    expect(onsite.json).toMatchObject({ kind: "onsite", companyName: tk.company.name, reminderMinutes: 15, autotaskServiceCallId: null, warnings: [] });
    expect((await block({ kind: "slot", title: "Route", reminderMinutes: 0 })).json.kind).toBe("slot");

    // the alert: once, when the start is within the reminder delay
    const { sendReminders } = await import("../server/lib/planning.ts");
    await sendReminders();
    await sendReminders();
    const alerts = (await tech.get("/api/notifications")).json.items.filter((n: any) => n.type === "calendar.reminder");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ link: `/tickets?ticket=${tk.id}`, data: { kind: "onsite", number: tk.number, company: tk.company.name } });
    // moved later: the alert is due again then
    await tech.patch(`/api/planning/calendar/${onsite.json.id}`, { startsAt: soon(120), endsAt: soon(180) });
    const [moved] = await db().select().from(schema.calendarBlocks).where(eq(schema.calendarBlocks.id, onsite.json.id));
    expect(moved.reminderSentAt).toBeNull();
    // without Microsoft 365, nothing from Outlook
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await tech.get(`/api/planning/calendar/outlook?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json).toEqual({ synced: false, events: [] });
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [] });
  });

  it("technicians enter their mobile; only admins switch Microsoft 365 sync and its mailbox", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect((await tech.patch("/api/me", { mobile: "+1 (450) 555-0199" })).status).toBe(200);
    expect((await tech.get("/api/me")).json).toMatchObject({ mobile: "+1 (450) 555-0199", o365: null });
    expect((await tech.patch("/api/me", { mobile: "appelle-moi" })).status).toBe(400);
    expect((await tech.patch("/api/me", { mobile: "" })).status).toBe(200);
    expect((await tech.get("/api/me")).json.mobile).toBeNull();
    // a technician cannot switch sync or choose a mailbox
    expect((await tech.put(`/api/admin/users/${techRow.id}/o365`, { enabled: true })).status).toBe(403);
    expect((await admin.get(`/api/admin/users/${techRow.id}/o365`)).json).toMatchObject({ enabled: false, mailbox: null, integrationReady: false, signIn: null, links: [] });
    expect((await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: true, mailbox: "alex@akab.ca" })).json).toMatchObject({ enabled: true, mailbox: "alex@akab.ca" });
    expect((await tech.get("/api/me")).json.o365).toEqual({ mailbox: "alex@akab.ca", active: false });
    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: false, mailbox: null });
    expect((await tech.get("/api/me")).json.permissions).not.toContain("tickets.o365");
    // admins have it by role; switching it off is a deny for that admin only
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    await admin.put(`/api/admin/users/${adminRow.id}/o365`, { enabled: false });
    expect((await admin.get("/api/me")).json.permissions).not.toContain("tickets.o365");
    await admin.put(`/api/admin/users/${adminRow.id}/o365`, { enabled: true });
    expect((await admin.get("/api/me")).json.permissions).toContain("tickets.o365");
  });

  it("timers: one running at a time, closed tab becomes an entry to validate", async () => {
    const tech = await session("tech@akab.local");
    const other = await session("tech2@akab.local");
    const [a, b] = (await tech.get("/api/tickets?view=all")).json.items;
    let timers = (await tech.post(`/api/tickets/${a.id}/timer/start`)).json;
    expect(timers).toMatchObject([{ ticketId: a.id, ticketNumber: a.number, state: "running" }]);
    // starting another one pauses the first
    timers = (await tech.post(`/api/tickets/${b.id}/timer/start`)).json;
    expect(timers.map((x: any) => [x.ticketId, x.state])).toEqual([
      [a.id, "paused"],
      [b.id, "running"],
    ]);
    expect((await tech.post(`/api/tickets/${b.id}/timer/pause`)).json.every((x: any) => x.state === "paused")).toBe(true);
    // timers are personal
    expect((await other.get("/api/tickets/timers")).json).toEqual([]);
    expect((await other.del(`/api/tickets/timers/${timers[0].id}`)).status).toBe(404);

    // the page stopped beating two minutes ago (tab closed): pending + bell
    await tech.post(`/api/tickets/${a.id}/timer/start`);
    const old = new Date(Date.now() - 120_000);
    await db()
      .update(schema.ticketTimers)
      .set({ runningSince: new Date(old.getTime() - 600_000), lastBeatAt: old })
      .where(eq(schema.ticketTimers.ticketId, a.id));
    const { sweepTimers } = await import("../server/lib/timers.ts");
    expect(await sweepTimers()).toBe(1);
    const pending = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === a.id);
    expect(pending.state).toBe("pending");
    expect(pending.elapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(pending.elapsedMs).toBeLessThan(660_000); // stops at the last beat, not now
    const bell = (await tech.get("/api/notifications")).json.items.find((n: any) => n.type === "timer.pending");
    expect(bell).toMatchObject({ link: "/tickets?timers=1", data: { number: a.number } });
    expect((await tech.post(`/api/tickets/${a.id}/timer/start`)).json.error).toBe("timer_pending");

    // validating creates the time entry in the ticket
    expect((await tech.post(`/api/tickets/timers/${pending.id}/submit`, { hours: 0.25, summary: "Diagnostic à distance", internal: "Vérifier le RAID" })).status).toBe(201);
    const d = (await tech.get(`/api/tickets/${a.id}`)).json;
    expect(d.notes.at(-1)).toMatchObject({ kind: "time", hours: 0.25, text: "Diagnostic à distance", internalText: "Vérifier le RAID", author: "Alex Tremblay" });
    expect((await tech.get("/api/tickets/timers")).json.map((x: any) => x.ticketId)).toEqual([b.id]);

    // stop → pending; "later" → paused again, then it resumes
    await tech.post(`/api/tickets/${b.id}/timer/stop`);
    const stopped = (await tech.get("/api/tickets/timers")).json[0];
    expect(stopped.state).toBe("pending");
    const back = (await tech.post(`/api/tickets/timers/${stopped.id}/later`)).json[0];
    expect(back).toMatchObject({ state: "paused", elapsedMs: stopped.elapsedMs });
    expect((await tech.post(`/api/tickets/${b.id}/timer/start`)).json[0].state).toBe("running");

    // stop → pending, discard → gone
    await tech.post(`/api/tickets/${b.id}/timer/stop`);
    const bt = (await tech.get("/api/tickets/timers")).json[0];
    expect(bt.state).toBe("pending");
    expect((await tech.post(`/api/tickets/timers/${bt.id}/submit`, { hours: 0, summary: "x" })).status).toBe(400);
    expect((await tech.del(`/api/tickets/timers/${bt.id}`)).status).toBe(200);
    expect((await tech.get("/api/tickets/timers")).json).toEqual([]);
  });
});

describe("tickets from Autotask", () => {
  let linkedTech = "";
  let inFlight = 0;
  let peak = 0;
  let throttleNext = 0;
  const base = "https://webservices99.autotask.net/ATServicesRest/V1.0/";
  const sent: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const pick = (values: [number, string][]) => values.map(([value, label]) => ({ value: String(value), label, isActive: true }));
  const ticket = (over: Record<string, unknown>) => ({
    id: 9001,
    ticketNumber: "T20261012.0001",
    title: "Serveur réel en panne",
    description: "Le serveur ne répond plus.\nDepuis ce matin.",
    status: 1,
    priority: 4,
    queueID: 29683,
    companyID: 77,
    contactID: 501,
    assignedResourceID: 29682885,
    dueDateTime: "2026-10-01T17:00:00Z",
    createDate: "2026-09-30T12:00:00Z",
    lastActivityDate: "2026-09-30T13:00:00Z",
    source: 4,
    ...over,
  });

  beforeAll(async () => {
    const { clearTicketCache } = await import("../server/lib/ticketSource.ts");
    await clearTicketCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 3));
          if (throttleNext > 0) {
            throttleNext--;
            sent.push({ method: init.method ?? "GET", url: String(input), headers: {}, body: "429" });
            return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
          }
          return await answer(input, init);
        } finally {
          inFlight--;
        }
      }),
    );
    async function answer(input: unknown, init: RequestInit) {
        const url = String(input);
        const method = init.method ?? "GET";
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
        sent.push({ method, url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("zoneInformation")) return json({ zoneName: "Zone 99", url: "https://webservices99.autotask.net/ATServicesRest/", webUrl: "https://ww99.autotask.net/" });
        const path = url.slice(base.length);
        if (path === "Resources/query") {
          return json({
            items: [
              { id: 29682885, firstName: "Alex", lastName: "Tremblay", email: "tech@akab.local" },
              { id: 29682999, firstName: "Autre", lastName: "Tech", email: "x@y.ca" },
            ],
            pageDetails: {},
          });
        }
        if (path === "Tickets/entityInformation/fields") {
          return json({
            fields: [
              { name: "status", isPickList: true, picklistValues: pick([[1, "New"], [8, "Needs Attention"], [2, "In Progress"], [5, "Complete"]]) },
              { name: "priority", isPickList: true, picklistValues: pick([[1, "High"], [2, "Medium"], [3, "Low"], [4, "Critical"]]) },
              { name: "queueID", isPickList: true, picklistValues: pick([[29683, "Triage"]]) },
              { name: "source", isPickList: true, picklistValues: pick([[4, "Phone"]]) },
            ],
          });
        }
        if (path === "TicketNotes/entityInformation/fields") {
          return json({
            fields: [
              ...["id", "ticketID", "title", "description", "createDateTime", "creatorResourceID", "createdByContactID"].map((name) => ({ name })),
              { name: "noteType", picklistValues: pick([[1, "Task Detail"]]) },
              { name: "publish", picklistValues: pick([[1, "All Autotask Users"], [2, "Internal Only"]]) },
            ],
          });
        }
        if (path === "Tickets/query" && String(init.body).includes('"field":"ticketNumber"')) {
          return json({ items: [ticket({ id: 7001, ticketNumber: "T20250101.0001", title: "Ancien billet", status: 5 })], pageDetails: {} });
        }
        if (path === "Tickets/query") {
          return json({
            items: [ticket({}), ticket({ id: 9002, ticketNumber: "T20261012.0002", title: "Client a répondu", status: 8, priority: 2, assignedResourceID: null, contactID: null })],
            pageDetails: {},
          });
        }
        if (path === "ServiceCalls/entityInformation/fields") return json({ fields: [{ name: "status", picklistValues: pick([[1, "New"]]) }] });
        if (path === "ServiceCalls" && method === "POST") return json({ itemId: 901 });
        if (path === "ServiceCalls/901/Tickets" && method === "POST") return json({ itemId: 902 });
        if (path === "ServiceCallTickets/902/Resources" && method === "POST") return json({ itemId: 903 });
        if (path === "ServiceCalls/901" && method === "DELETE") return json({ itemId: 901 });
        if (path === "Products/entityInformation/fields") {
          return json({ fields: ["id", "name", "description", "sku", "manufacturerName", "manufacturerProductName", "unitPrice", "unitCost", "chargeBillingCodeID", "isActive"].map((name) => ({ name })) });
        }
        if (path === "Products/query") {
          return json({ items: [{ id: 601, name: "SSD Samsung 1 To", description: "NVMe", sku: "MZ-V9P1T0", manufacturerName: "Samsung", unitPrice: 189.99, unitCost: 129.5, chargeBillingCodeID: 501 }], pageDetails: {} });
        }
        if (path === "InventoryItems/query") return json({ items: [{ id: 701, productID: 601, inventoryLocationID: 9, quantityOnHand: 4 }], pageDetails: {} });
        if (path === "InventoryLocations/query") return json({ items: [{ id: 9, locationName: "Entrepôt" }], pageDetails: {} });
        if (path === "TicketCharges/entityInformation/fields") {
          return json({
            fields: [
              ...["id", "ticketID", "name", "description", "unitQuantity", "unitPrice", "unitCost", "isBillableToCompany", "billingCodeID", "datePurchased"].map((name) => ({ name })),
              { name: "chargeType", picklistValues: pick([[1, "Operational"], [2, "Capitalized"]]) },
              { name: "status", picklistValues: pick([[1, "Pending"], [2, "Approved"]]) },
            ],
          });
        }
        if (path === "BillingCodes/entityInformation/fields") {
          return json({ fields: [{ name: "useType", picklistValues: pick([[1, "Work Type"], [4, "Material Cost Code"]]) }] });
        }
        if (path === "BillingCodes/query" && String(init.body).includes('"field":"useType","value":[4]')) {
          return json({ items: [{ id: 501, name: "Hardware" }], pageDetails: {} });
        }
        if (path === "TicketCharges/query") {
          return json({ items: [{ id: 81, name: "SSD", unitQuantity: 1, unitPrice: 120, isBillableToCompany: true, chargeType: 1, status: 1, billingCodeID: 501 }], pageDetails: {} });
        }
        if (path === "Tickets/9001/Charges" && method === "POST" && JSON.parse(String(init.body)).name === "REFUSE") return json({ errors: ["Material code required"] }, 500);
        if (path === "Tickets/9001/Charges" && method === "POST") return json({ itemId: 82 });
        if (path === "ConfigurationItems/entityInformation/fields") {
          return json({
            fields: [
              ...["id", "referenceTitle", "serialNumber", "contactID", "rmmDeviceID", "rmmDeviceUID", "rmmDeviceAuditHostname", "rmmDeviceAuditIPAddress"].map((name) => ({ name })),
              { name: "configurationItemType", picklistValues: pick([[2, "Workstation"]]) },
            ],
          });
        }
        if (path === "ConfigurationItems/query") {
          return json({
            items: [{ id: 3001, referenceTitle: "Poste d'Ann", serialNumber: "SN1", configurationItemType: 2, contactID: 501, rmmDeviceID: 77, rmmDeviceUID: "uid-77", rmmDeviceAuditHostname: "REEL-PT01", rmmDeviceAuditIPAddress: "10.0.0.5" }],
            pageDetails: {},
          });
        }
        if (path === "TicketSecondaryResources/query" && String(init.body).includes('"op":"eq"')) {
          return json({ items: [{ id: 401, ticketID: 9001, resourceID: 29682999 }], pageDetails: {} });
        }
        if (path === "Tickets/9001/SecondaryResources/401" && method === "DELETE") return json({ itemId: 401 });
        if (path === "Tickets/9001/SecondaryResources" && method === "POST") return json({ itemId: 402 });
        if (path === "TimeEntries" && method === "POST") return json({ itemId: 71 });
        if (path === "TicketSecondaryResources/query") return json({ items: [{ ticketID: 9001, resourceID: 29682999 }, { ticketID: 9002, resourceID: 29682885 }], pageDetails: {} });
        if (path === "Companies/query") return json({ items: [{ id: 77, companyName: "Client Réel inc." }], pageDetails: {} });
        if (path === "Contacts/query") return json({ items: [{ id: 501, firstName: "Ann", lastName: "Réelle", emailAddress: "ann@reel.ca", phone: null }], pageDetails: {} });
        if (path === "Tickets/9001" && method === "GET") return json({ item: ticket({}) });
        if (path === "TicketNotes/query" && JSON.stringify(init.body ?? "").includes("9002")) return json({ errors: ["Notes indisponibles"] }, 500);
        if (path === "TicketNotes/query") {
          return json({
            items: [{ id: 1, title: "Appel", description: "Client rappelé", createDateTime: "2026-09-30T14:00:00Z", creatorResourceID: 29682885, creatorContactID: null, publish: 2 }],
            pageDetails: {},
          });
        }
        if (path === "TimeEntries/entityInformation/fields") {
          return json({ fields: ["id", "ticketID", "resourceID", "dateWorked", "startDateTime", "hoursWorked", "summaryNotes", "internalNotes"].map((name) => ({ name })) });
        }
        if (path === "TimeEntries/query") {
          return json({
            items: [{ id: 70, resourceID: 29682885, dateWorked: "2026-09-30T00:00:00Z", startDateTime: "2026-09-30T15:00:00Z", hoursWorked: 1.5, summaryNotes: "Serveur redémarré", internalNotes: "RAID à surveiller" }],
            pageDetails: {},
          });
        }
        if (path === "ResourceRoles/query") return json({ items: [{ roleID: 29683461 }], pageDetails: {} });
        // refused only in a technician's name (impersonation), accepted for the API user itself
        if (path === "Tickets" && method === "PATCH" && JSON.parse(String(init.body)).priority === 3 && headers.impersonationresourceid) {
          return json({ errors: ["The logged in Resource does not have the adequate permissions to update this entity type."] }, 500);
        }
        if (path === "Tickets" && method === "PATCH") return json({ itemId: 9001 });
        if (path === "Tickets/9001/Notes" && method === "POST" && headers.impersonationresourceid && String(init.body).includes("REFUSED-AS-TECH")) {
          return json({ errors: ["The logged in Resource does not have the adequate permissions to create this entity type."] }, 500);
        }
        if (path === "Tickets/9001/Notes" && method === "POST") return json({ itemId: 55 });
        if (path === "Companies/77/Contacts" && method === "POST") return json({ itemId: 777 });
        return json({ errors: [`unexpected ${method} ${path}`] }, 500);
    }
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    await admin.put("/api/admin/integrations/autotask", { username: "portal-api@akab.ca", secret: "good-secret", integrationCode: "TRACKING-ID", enabled: true });
    const staff = (await admin.get("/api/admin/integrations/autotask/links")).json.staff;
    const techId = staff.find((s: any) => s.email === "tech@akab.local").id;
    linkedTech = techId;
    const adminId = staff.find((s: any) => s.email === "admin@akab.local").id;
    await admin.put(`/api/admin/integrations/autotask/links/${adminId}`, { resourceId: null });
    expect((await admin.put(`/api/admin/integrations/autotask/links/${techId}`, { resourceId: 29682885 })).status).toBe(200);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db().update(schema.integrations).set({ enabled: false }).where(eq(schema.integrations.provider, "autotask"));
    await (await import("../server/lib/ticketSource.ts")).clearTicketCache();
  });

  it("lists Autotask tickets with the Autotask statuses and the linked technician view", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const r = (await tech.get("/api/tickets")).json;
    expect(r.demo).toBe(false);
    expect(r.notLinked).toBe(false);
    expect(r.facets.statuses.map((s: any) => [s.label, s.kind])).toEqual([
      ["New", "new"],
      ["Needs Attention", "needsAttention"],
      ["In Progress", "inProgress"],
      ["Complete", "complete"],
    ]);
    expect(r.items.map((t: any) => t.id)).toEqual([9001, 9002]); // mine = assigned to me, or I am secondary (9002)
    expect(r.items[0]).toMatchObject({
      company: { id: 77, name: "Client Réel inc." },
      contact: "Ann Réelle",
      statusLabel: "New",
      statusKind: "new",
      priorityLabel: "Critical",
      priorityKind: "critical",
      queueLabel: "Triage",
      excerpt: "Le serveur ne répond plus.",
      secondary: [{ id: "at-29682999", name: "Autre Tech" }],
    });
    expect(r.metrics).toMatchObject({ mine: 2, unassigned: 1, statusAttention: 1 });
    expect((await tech.get("/api/tickets?view=all&statusKind=needsAttention")).json.items.map((t: any) => t.id)).toEqual([9002]);

    const d = (await tech.get("/api/tickets/9001")).json;
    expect(d.hours).toBe(1.5);
    expect(d.notes).toEqual([
      { id: "n1", author: "Alex Tremblay", at: "2026-09-30T14:00:00Z", text: "Appel\nClient rappelé", internal: true, kind: "note" },
      { id: "t70", author: "Alex Tremblay", at: "2026-09-30T15:00:00Z", text: "Serveur redémarré", internal: false, kind: "time", hours: 1.5, internalText: "RAID à surveiller" },
    ]);
    // the note query only asks for fields TicketNotes really has (no creatorContactID)
    const noteQuery = sent.find((s) => s.url.endsWith("TicketNotes/query"))!;
    expect(noteQuery.body.IncludeFields).not.toContain("creatorContactID");
    expect(noteQuery.body.IncludeFields).toContain("createdByContactID");
  });

  it("writes to Autotask on behalf of the technician", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    sent.length = 0;
    expect((await tech.patch("/api/tickets/9001", { status: "2", priority: "1", assigneeId: "at-29682999" })).status).toBe(200);
    const patch = sent.find((s) => s.method === "PATCH")!;
    expect(patch.headers.impersonationresourceid).toBe("29682885");
    expect(patch.body).toEqual({ id: 9001, status: 2, priority: 1, assignedResourceID: 29682999, assignedResourceRoleID: 29683461 });
    expect((await tech.patch("/api/tickets/9001", { status: "999" })).json.error).toBe("invalid_value");
    // Autotask refuses in the technician's name: a clear code, Autotask's text kept
    const refused = await tech.patch("/api/tickets/9001", { priority: "3" });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe("autotask_permission");

    // admin switch: then saved as the API user (no impersonation)
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    expect((await admin.put("/api/admin/integrations/autotask", { fallbackToApiUser: true })).json.fallbackToApiUser).toBe(true);
    sent.length = 0;
    expect((await tech.patch("/api/tickets/9001", { priority: "3" })).status).toBe(200);
    const patches = sent.filter((s) => s.method === "PATCH");
    expect(patches.map((p) => p.headers.impersonationresourceid ?? null)).toEqual(["29682885", null]);

    // saved as the API user: the text says which technician wrote it, and the portal remembers it
    sent.length = 0;
    expect((await tech.post("/api/tickets/9001/notes", { text: "REFUSED-AS-TECH réponse", internal: false })).status).toBe(201);
    const posts = sent.filter((s) => s.url.endsWith("Tickets/9001/Notes"));
    expect(posts.map((p) => p.headers.impersonationresourceid ?? null)).toEqual(["29682885", null]);
    expect(posts[1].body.description).toBe("REFUSED-AS-TECH réponse\n\n— Alex Tremblay (via le portail AKAB)");
    const [author] = await db().select().from(schema.autotaskAuthors).where(eq(schema.autotaskAuthors.autotaskId, 55));
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect(author).toMatchObject({ entity: "note", ticketId: 9001, userId: techRow.id });
    sent.length = 0;
    await admin.put("/api/admin/integrations/autotask", { fallbackToApiUser: false });

    expect((await tech.post("/api/tickets/9001/notes", { text: "Rappel demain", internal: true })).status).toBe(201);
    const note = sent.find((s) => s.url.endsWith("Tickets/9001/Notes"))!;
    expect(note.body).toMatchObject({ ticketID: 9001, description: "Rappel demain", noteType: 1, publish: 2 });
    expect(note.headers.impersonationresourceid).toBe("29682885");

    const c = await tech.post("/api/tickets/companies/77/contacts", { firstName: "Bob", lastName: "Neuf", email: "bob@reel.ca" });
    expect(c.json).toMatchObject({ id: "777", name: "Bob Neuf" });

    // secondary technicians: removes the old one, adds the new one
    sent.length = 0;
    expect((await tech.patch("/api/tickets/9001", { secondaryIds: [linkedTech] })).status).toBe(200);
    expect(sent.some((s) => s.method === "PATCH")).toBe(false); // nothing else changed
    expect(sent.find((s) => s.method === "DELETE")!.url).toMatch(/Tickets\/9001\/SecondaryResources\/401$/);
    expect(sent.find((s) => s.method === "POST" && s.url.endsWith("Tickets/9001/SecondaryResources"))!.body).toEqual({ ticketID: 9001, resourceID: 29682885, roleID: 29683461 });

    // a validated timer becomes a time entry under the technician
    sent.length = 0;
    await tech.post("/api/tickets/9001/timer/start");
    await tech.post("/api/tickets/9001/timer/stop");
    const timer = (await tech.get("/api/tickets/timers")).json[0];
    expect((await tech.post(`/api/tickets/timers/${timer.id}/submit`, { hours: 1.25, summary: "Remplacement du disque", internal: "Garantie Dell", workTypeId: "12" })).status).toBe(201);
    const entry = sent.find((s) => s.method === "POST" && s.url.endsWith("TimeEntries"))!;
    expect(entry.headers.impersonationresourceid).toBe("29682885");
    expect(entry.body).toMatchObject({ ticketID: 9001, resourceID: 29682885, roleID: 29683461, hoursWorked: 1.25, summaryNotes: "Remplacement du disque", internalNotes: "Garantie Dell", billingCodeID: 12 });
    expect(new Date(entry.body.endDateTime).getTime() - new Date(entry.body.startDateTime).getTime()).toBe(4_500_000);
  });

  it("opens a ticket even when its notes cannot be loaded, with a warning", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    await tech.get("/api/tickets?view=all");
    const d = await tech.get("/api/tickets/9002");
    expect(d.status).toBe(200);
    expect(d.json.title).toBe("Client a répondu");
    // notes failed, but the work done (time entries) is still shown
    expect(d.json.notes.map((n: any) => n.kind)).toEqual(["time"]);
    expect(d.json.warnings).toEqual([{ part: "notes", detail: "Notes indisponibles" }]);
  });

  it("keeps a local copy: lists read it, syncs only ask what changed", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    await tech.get("/api/tickets?view=all");
    const rows = await db().select().from(schema.autotaskTickets);
    expect(rows.map((r) => r.id).sort()).toEqual([9001, 9002]);

    // a list read does not call Autotask (copy is fresh)
    sent.length = 0;
    expect((await tech.get("/api/tickets?view=all&q=serveur")).json.items.map((x: any) => x.id)).toEqual([9001]);
    expect(sent.filter((s) => s.url.endsWith("Tickets/query"))).toEqual([]);

    // incremental pass: only tickets with recent activity; unchanged ones are not re-read
    const { syncTickets } = await import("../server/lib/ticketSource.ts");
    sent.length = 0;
    await syncTickets();
    const q = sent.filter((s) => s.url.endsWith("Tickets/query"));
    expect(q).toHaveLength(1);
    expect(JSON.stringify(q[0].body.filter)).toContain("lastActivityDate");
    expect(sent.some((s) => s.url.endsWith("Contacts/query") || s.url.endsWith("TicketSecondaryResources/query"))).toBe(false);
  });

  it("never sends more than 3 requests at once and retries when Autotask says 429", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const { resetAutotaskUsage, autotaskUsage } = await import("../server/lib/autotask.ts");
    resetAutotaskUsage();
    peak = 0;
    // many tickets opened at once
    await Promise.all([9001, 9002, 9001, 9002].map((id) => tech.get(`/api/tickets/${id}`)));
    expect(peak).toBeLessThanOrEqual(3);

    throttleNext = 1;
    const r = await tech.get("/api/tickets/companies");
    expect(r.status).toBe(200);
    expect(r.json.map((c: any) => c.name)).toEqual(["Client Réel inc."]);
    expect(autotaskUsage()).toMatchObject({ throttled: 1, limit: 10_000 });
    expect(autotaskUsage().lastHour).toBeGreaterThan(1);
  });

  it("devices from Autotask configuration items; older tickets by number", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const assets = (await tech.get("/api/tickets/companies/77/assets")).json;
    expect(assets).toEqual([
      expect.objectContaining({ id: "3001", name: "Poste d'Ann", type: "Workstation", contactId: "501", contactName: "Ann Réelle", hostname: "REEL-PT01", rmm: { id: "77", uid: "uid-77" } }),
    ]);
    sent.length = 0;
    expect((await tech.patch("/api/tickets/9001", { assetId: "3001" })).status).toBe(200);
    expect(sent.find((s) => s.method === "PATCH")!.body).toEqual({ id: 9001, configurationItemID: 3001 });

    const r = (await tech.get("/api/tickets/search?q=T20250101.0001")).json;
    expect(r.items).toEqual([]);
    expect(r.archive.map((x: any) => [x.id, x.title])).toEqual([[7001, "Ancien billet"]]);
  });

  it("charges from Autotask TicketCharges; a new one is posted in the technician's name", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const o = (await tech.get("/api/tickets/charge-options")).json;
    expect(o).toEqual({ types: [{ value: "1", label: "Operational" }, { value: "2", label: "Capitalized" }], statuses: [{ value: "1", label: "Pending" }, { value: "2", label: "Approved" }], materialCodes: [{ value: "501", label: "Hardware" }] });
    expect((await tech.get("/api/tickets/9001/charges")).json).toEqual([expect.objectContaining({ id: "81", name: "SSD", materialCode: "Hardware", type: "Operational", status: "Pending" })]);
    sent.length = 0;
    const r = await tech.post("/api/tickets/9001/charges", { name: "Câble réseau", quantity: 3, unitPrice: 12.5, billable: false, materialCodeId: "501", date: "2026-10-12" });
    expect(r.status).toBe(201);
    const post = sent.find((s) => s.method === "POST" && s.url.endsWith("Tickets/9001/Charges"))!;
    expect(post.headers.impersonationresourceid).toBe("29682885");
    expect(post.body).toMatchObject({ ticketID: 9001, name: "Câble réseau", unitQuantity: 3, unitPrice: 12.5, isBillableToCompany: false, chargeType: 1, status: 2, billingCodeID: 501, datePurchased: "2026-10-12T12:00:00Z" }); // approved by default

    // catalogue search only on the fields this Autotask has; product linked on the charge
    sent.length = 0;
    const products = (await tech.get("/api/tickets/products?q=samsung")).json;
    expect(products).toEqual([{ id: "601", name: "SSD Samsung 1 To", description: "NVMe", sku: "MZ-V9P1T0", manufacturer: "Samsung", unitPrice: 189.99, unitCost: 129.5, materialCodeId: "501" }]);
    const search = sent.find((s) => s.url.endsWith("Products/query"))!;
    expect(search.body.filter[1].items.map((x: any) => x.field)).toEqual(["name", "sku", "manufacturerProductName"]);
    sent.length = 0;
    await tech.post("/api/tickets/9001/charges", { name: products[0].name, quantity: 1, unitPrice: 189.99, materialCodeId: "501", productId: "601" });
    expect(sent.find((s) => s.method === "POST" && s.url.endsWith("Tickets/9001/Charges"))!.body).toMatchObject({ productID: 601, billingCodeID: 501 });

    // from the portal inventory: the linked Autotask product goes on the charge;
    // if Autotask refuses, the items go back in stock
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const loc = (await admin.post("/api/store/locations", { name: "Camion" })).json;
    const item = (await admin.post("/api/store/products", { name: "SSD lié", priceCents: 18999, autotaskProductId: 601, materialCodeId: "501" })).json;
    await admin.post(`/api/store/products/${item.id}/receive`, { locationId: loc.id, quantity: 2, unitCostCents: 12000 });
    const from = { storeProductId: item.id, locationId: loc.id };
    sent.length = 0;
    expect((await tech.post("/api/tickets/9001/charges", { name: "SSD lié", quantity: 1, unitPrice: 189.99, materialCodeId: "501", ...from })).status).toBe(201);
    expect(sent.find((s) => s.method === "POST" && s.url.endsWith("Tickets/9001/Charges"))!.body).toMatchObject({ productID: 601 });
    expect((await tech.post("/api/tickets/9001/charges", { name: "REFUSE", quantity: 1, ...from })).status).toBe(502);
    const left = (await admin.get("/api/store")).json.products.find((p: any) => p.id === item.id);
    expect(left.total).toBe(1);
  });

  it("an on-site visit creates the Autotask service call for the ticket and the technician", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    // the admin acts as the linked technician here (impersonation)
    const tech = await signIn("tech@akab.local");
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [{ key: "tickets.planSelf", effect: "allow" }] });
    sent.length = 0;
    const start = new Date(Date.now() + 3 * 86_400_000);
    const r = await tech.post("/api/planning/calendar", { technicianId: techRow.id, kind: "onsite", ticketId: 9001, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 7_200_000).toISOString() });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ autotaskServiceCallId: 901, companyName: "Client Réel inc.", warnings: [] });
    const posts = sent.filter((s) => s.method === "POST" && /ServiceCall/.test(s.url));
    expect(posts.map((s) => s.url.split("V1.0/")[1])).toEqual(["ServiceCalls", "ServiceCalls/901/Tickets", "ServiceCallTickets/902/Resources"]);
    expect(posts[0].body).toMatchObject({ companyID: 77, status: 1, startDateTime: start.toISOString() });
    expect(posts[2].body).toMatchObject({ serviceCallTicketID: 902, resourceID: 29682885, roleID: 29683461 });
    sent.length = 0;
    await tech.del(`/api/planning/calendar/${r.json.id}`);
    expect(sent.some((s) => s.method === "DELETE" && s.url.endsWith("ServiceCalls/901"))).toBe(true);
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [] });
  });

  it("refuses writes from an account not linked to Autotask", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const r = (await admin.get("/api/tickets")).json;
    expect(r.notLinked).toBe(true);
    expect(r.items).toEqual([]);
    expect((await admin.patch("/api/tickets/9001", { status: "2" })).json.error).toBe("autotask_not_linked");
  });
});

describe("Microsoft 365 calendar", () => {
  const graphSent: { method: string; url: string; body: any }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url.includes("login.microsoftonline.com")) {
          const form = new URLSearchParams(String(init.body));
          return form.get("client_secret") === "good-secret" ? json({ access_token: "tok", expires_in: 3600 }) : json({ error_description: "AADSTS7000215: Invalid client secret" }, 401);
        }
        graphSent.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("/calendarView")) {
          return json({
            value: [
              { id: "ev1", subject: "Rencontre fournisseur", isAllDay: false, start: { dateTime: "2026-10-14T09:00:00.0000000" }, end: { dateTime: "2026-10-14T10:00:00.0000000" }, categories: [] },
              { id: "ev2", subject: "[T1] déjà dans le portail", start: { dateTime: "2026-10-14T11:00:00" }, end: { dateTime: "2026-10-14T12:00:00" }, categories: ["Portail AKAB"] },
            ],
          });
        }
        if (url.endsWith("/calendar?$select=id,name")) return json({ id: "cal", name: "Calendrier" });
        if (url.includes("/calendars?$select=")) return json({ value: [{ id: "cal-main", name: "Calendrier", isDefaultCalendar: true, canEdit: true, owner: { address: "admin@akab.local" } }, { id: "cal-team", name: "Équipe", canEdit: true }] });
        if (url.endsWith("/events") && method === "POST") return json({ id: `new-${graphSent.length}` }, 201);
        if (method === "PATCH" || method === "DELETE") return new Response(null, { status: 204 });
        return json({ error: { message: "unexpected" } }, 500);
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db().update(schema.integrations).set({ enabled: false }).where(eq(schema.integrations.provider, "o365"));
  });

  it("admin connects it; technicians with the right see Outlook and get the portal blocks in it", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect((await admin.put("/api/admin/integrations/o365", { enabled: true })).json.error).toBe("o365_incomplete");
    expect((await admin.post("/api/admin/integrations/o365/test", { tenantId: "akab.onmicrosoft.com", clientId: "abc-123", secret: "bad" })).json).toMatchObject({ ok: false, error: "auth" });
    const saved = await admin.put("/api/admin/integrations/o365", { tenantId: "akab.onmicrosoft.com", clientId: "abc-123", secret: "good-secret", enabled: true });
    expect(saved.json).toEqual({ enabled: true, tenantId: "akab.onmicrosoft.com", clientId: "abc-123", hasSecret: true, lastTest: null });
    expect(JSON.stringify(saved.json)).not.toContain("good-secret");
    expect((await admin.post("/api/admin/integrations/o365/test", {})).json).toEqual({ ok: true });

    // a technician without the right: nothing synced
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const from = "2026-10-12T04:00:00.000Z";
    const to = "2026-10-19T04:00:00.000Z";
    const outlook = () => tech.get(`/api/planning/calendar/outlook?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect((await outlook()).json).toEqual({ synced: false, events: [] });

    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: true });
    const r = (await outlook()).json;
    expect(r.synced).toBe(true);
    // its own events are not shown twice; Québec time is kept
    expect(r.events).toEqual([expect.objectContaining({ id: "ev1", title: "Rencontre fournisseur", startsAt: "2026-10-14T13:00:00.000Z", allDay: false })]);

    // a reserved block goes to Outlook, moves with it, and leaves with it
    graphSent.length = 0;
    const start = new Date("2026-10-15T14:00:00.000Z");
    const b = await admin.post("/api/planning/calendar", { technicianId: techRow.id, kind: "slot", title: "Formation Veeam", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), reminderMinutes: 30 });
    expect(b.json.warnings).toEqual([]);
    const created = graphSent.find((s) => s.method === "POST" && s.url.endsWith("/events"))!;
    expect(created.url).toContain("users/tech%40akab.local/events");
    expect(created.body).toMatchObject({ subject: "Formation Veeam", categories: ["Portail AKAB"], start: { dateTime: "2026-10-15T10:00:00", timeZone: "America/Toronto" }, reminderMinutesBeforeStart: 30 });
    const [row] = await db().select().from(schema.calendarBlocks).where(eq(schema.calendarBlocks.id, b.json.id));
    expect(row.o365EventId).toMatch(/^new-/);
    await admin.patch(`/api/planning/calendar/${b.json.id}`, { startsAt: new Date(start.getTime() + 3_600_000).toISOString(), endsAt: new Date(start.getTime() + 7_200_000).toISOString() });
    expect(graphSent.some((s) => s.method === "PATCH" && s.url.includes(encodeURIComponent(row.o365EventId!)))).toBe(true);
    await admin.del(`/api/planning/calendar/${b.json.id}`);
    expect(graphSent.some((s) => s.method === "DELETE" && s.url.includes(encodeURIComponent(row.o365EventId!)))).toBe(true);

    // a priority of the day: an all-day event, removed when done
    graphSent.length = 0;
    const tk = (await tech.get("/api/tickets?view=all")).json.items[9];
    const pin = await admin.post("/api/planning/pins", { ticketId: tk.id, technicianId: techRow.id, horizon: "day", forDate: "2026-10-16", note: "Urgent" });
    const allDay = graphSent.find((s) => s.method === "POST")!;
    expect(allDay.body).toMatchObject({ isAllDay: true, start: { dateTime: "2026-10-16T00:00:00" }, end: { dateTime: "2026-10-17T00:00:00" } });
    expect(allDay.body.subject).toContain(tk.number);
    await tech.post(`/api/planning/pins/${pin.json.id}/done`, { done: true });
    expect(graphSent.some((s) => s.method === "DELETE")).toBe(true);

    // another mailbox chosen by the admin is the one read
    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: true, mailbox: "alex.tremblay@akab.ca" });
    graphSent.length = 0;
    await outlook();
    expect(graphSent[0].url).toContain("users/alex.tremblay%40akab.ca/calendarView");
    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: false, mailbox: null });
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [] });
  });

  it("a master admin chooses the calendars of each planning, and what each shows", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: true });

    // a calendar of a mailbox is picked from its list (organisation access)
    const cals = (await admin.get(`/api/admin/users/${techRow.id}/o365/calendars?source=app&mailbox=admin%40akab.local`)).json;
    expect(cals.map((x: any) => x.name)).toEqual(["Calendrier", "Équipe"]);
    // the admin's own calendar in the technician's planning: busy times only, with the admin's name
    let view = (await admin.post(`/api/admin/users/${techRow.id}/calendar-links`, { source: "app", mailbox: "admin@akab.local", display: "busy" })).json;
    expect(view.links).toEqual([expect.objectContaining({ label: "Administrateur AKAB", display: "busy", push: false })]);
    // the technician's own, in detail, in its "Équipe" calendar, receiving the portal's blocks
    view = (await admin.post(`/api/admin/users/${techRow.id}/calendar-links`, { source: "app", mailbox: "tech@akab.local", calendarId: "cal-team", calendarName: "Équipe", display: "details", push: true })).json;
    expect(view.links.map((l: any) => [l.label, l.display, l.push])).toEqual([
      ["Administrateur AKAB", "busy", false],
      ["Alex Tremblay", "details", true],
    ]);
    // through someone's own sign-in: only once they signed in
    expect((await admin.post(`/api/admin/users/${techRow.id}/calendar-links`, { source: "user", ownerId: adminRow.id, display: "details" })).json.error).toBe("o365_not_signed_in");

    const from = "2026-10-12T04:00:00.000Z";
    const to = "2026-10-19T04:00:00.000Z";
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    // the technician sees the admin as busy, and their own events in detail
    const mine = (await tech.get(`/api/planning/calendar/outlook?${q}`)).json;
    expect(mine.events.map((e: any) => [e.calendar, e.title])).toEqual([
      ["Administrateur AKAB", "Occupé — Administrateur AKAB"],
      ["Alex Tremblay", "Rencontre fournisseur"],
    ]);
    expect(mine.events[0]).toMatchObject({ masked: true, location: null });
    // the admin looking at that planning sees their own calendar in detail
    const asOwner = (await admin.get(`/api/planning/calendar/outlook?${q}&technicianId=${techRow.id}`)).json;
    expect(asOwner.events[0]).toMatchObject({ title: "Rencontre fournisseur", masked: false });

    // a block goes to the calendar chosen to receive them
    graphSent.length = 0;
    const start = new Date("2026-10-15T14:00:00.000Z");
    await admin.post("/api/planning/calendar", { technicianId: techRow.id, kind: "slot", title: "Formation", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() });
    expect(graphSent.find((s) => s.method === "POST")!.url).toContain("users/tech%40akab.local/calendars/cal-team/events");

    // a global admin cannot do any of it
    const roles = (await admin.get("/api/admin/roles")).json;
    const global = roles.find((r: any) => r.slug === "global-admin");
    await db().update(schema.users).set({ roleId: global.id }).where(eq(schema.users.id, techRow.id));
    expect((await tech.get(`/api/admin/users/${techRow.id}/o365`)).status).toBe(403);
    expect((await tech.post(`/api/admin/users/${techRow.id}/calendar-links`, { source: "app", mailbox: "ceo@akab.local", display: "details" })).status).toBe(403);
    expect((await tech.del(`/api/admin/calendar-links/${view.links[0].id}`)).status).toBe(403);
    await db().update(schema.users).set({ roleId: roles.find((r: any) => r.slug === "technician").id }).where(eq(schema.users.id, techRow.id));

    for (const l of view.links) await admin.del(`/api/admin/calendar-links/${l.id}`);
    expect((await admin.get(`/api/admin/users/${techRow.id}/o365`)).json.links).toEqual([]);
    await admin.put(`/api/admin/users/${techRow.id}/o365`, { enabled: false });
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [] });
  });
});

describe("built-in roles", () => {
  it("master admin, global admin and technician; a global admin cannot take over a master admin", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const by = (slug: string) => roles.find((r: any) => r.slug === slug);
    expect(by("administrator")).toMatchObject({ name: "Administrateur principal", locked: true });
    expect(by("global-admin")).toMatchObject({ name: "Administrateur global", locked: false });
    expect(by("technician")).toMatchObject({ name: "Technicien" });
    // the global admin manages people and work, not the keys of the portal
    expect(by("global-admin").permissions).toEqual(expect.arrayContaining(["admin.staff", "admin.clients", "tickets.plan", "meetings.manage"]));
    for (const p of ["admin.roles", "admin.integrations", "admin.email", "admin.o365", "outlook.anyMailbox"]) expect(by("global-admin").permissions).not.toContain(p);
    expect(by("administrator").permissions).toEqual(expect.arrayContaining(["admin.roles", "admin.o365"]));

    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    await db().update(schema.users).set({ roleId: by("global-admin").id }).where(eq(schema.users.id, techRow.id));
    resetRateLimit("login:ip:unknown");
    const global = await signIn("tech@akab.local");
    // manages technicians…
    expect((await global.get("/api/admin/staff")).status).toBe(200);
    // …but not master administrators, nor becomes one
    expect((await global.patch(`/api/admin/users/${adminRow.id}`, { title: "x" })).json.error).toBe("master_only");
    expect((await global.post(`/api/admin/users/${adminRow.id}/reset-password`)).json.error).toBe("master_only");
    expect((await global.post(`/api/admin/users/${adminRow.id}/reset-mfa`)).json.error).toBe("master_only");
    expect((await global.patch(`/api/admin/users/${techRow.id}`, { roleId: by("administrator").id })).json.error).toBe("master_only");
    expect((await global.post("/api/admin/staff", { email: "nouveau@akab.local", name: "Nouveau", roleId: by("administrator").id })).json.error).toBe("master_only");
    expect((await global.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [{ key: "admin.roles", effect: "allow" }] })).status).toBe(403);
    expect((await global.get("/api/admin/integrations/o365")).status).toBe(403);
    // a master admin can
    expect((await admin.patch(`/api/admin/users/${techRow.id}`, { roleId: by("technician").id })).status).toBe(200);
  });
});

describe("text messages (VoIP.ms)", () => {
  const sms: { method: string; dst?: string; message?: string; did?: string }[] = [];
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        if (!url.startsWith("https://voip.ms/api/v1/rest.php")) return new Response("{}", { status: 500 });
        // VoIP.ms REST: GET with the parameters in the address (POST is SOAP)
        expect(init.method ?? "GET").toBe("GET");
        const p = new URL(url).searchParams;
        if (p.get("api_password") !== "api-secret") return new Response(JSON.stringify({ status: "invalid_credentials" }), { headers: { "content-type": "application/json" } });
        sms.push({ method: p.get("method")!, dst: p.get("dst") ?? undefined, message: p.get("message") ?? undefined, did: p.get("did") ?? undefined });
        return new Response(JSON.stringify({ status: "success", sms: sms.length }), { headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db().update(schema.integrations).set({ enabled: false }).where(eq(schema.integrations.provider, "voipms"));
  });

  it("receives texts, answers automatically, opens tickets on request or when nobody replies", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");

    // settings: the password never comes back; the callback address carries the token
    expect((await admin.put("/api/admin/integrations/voipms", { enabled: true })).json.error).toBe("sms_incomplete");
    expect((await admin.post("/api/admin/integrations/voipms/test", { username: "akab@akab.ca", password: "wrong" })).json).toMatchObject({ ok: false, error: "api", detail: "invalid_credentials" });
    const saved = (await admin.put("/api/admin/integrations/voipms", { username: "akab@akab.ca", password: "api-secret", did: "+1 (450) 555-9000", enabled: true, defaultCompanyId: 301, defaultCompanyName: "Client par défaut" })).json;
    // 4 hours by default before a ticket opens by itself
    expect(saved).toMatchObject({ enabled: true, did: "4505559000", hasPassword: true, autoTicketMinutes: 240 });
    expect(JSON.stringify(saved)).not.toContain("api-secret");
    const token = new URL(saved.callbackUrl.replace("{FROM}", "x"), "http://h").searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);
    // the status follows the saved account: a test of the typed (same) values counts; a text sent clears an old failure
    expect((await admin.get("/api/admin/integrations/voipms")).json.lastTest ?? null).toBeNull();
    expect((await admin.post("/api/admin/integrations/voipms/test", { username: "akab@akab.ca", password: "api-secret" })).json).toEqual({ ok: true });
    expect((await admin.get("/api/admin/integrations/voipms")).json.lastTest).toMatchObject({ ok: true });
    const { saveSmsSettings, sendSms } = await import("../server/lib/voipms.ts");
    await saveSmsSettings(null, { lastTest: { ok: false, at: new Date().toISOString(), error: "api" } });
    await sendSms("5145559999", "test");
    expect((await admin.get("/api/admin/integrations/voipms")).json.lastTest).toMatchObject({ ok: true });
    const hook = (q: Record<string, string>) => admin.get(`/api/sms/hook/voipms?${new URLSearchParams(q)}`);
    // texts of a ticket are copied as internal notes (Autotask)
    const { ticketSource } = await import("../server/lib/ticketSource.ts");
    const notes = vi.spyOn(await ticketSource(), "addSmsNote");

    // wrong token: "ok", nothing kept
    expect((await hook({ token: "nope", from: "5145550000", message: "x", id: "z" })).status).toBe(200);
    expect((await tech.get("/api/sms/conversations")).json).toEqual([]);

    // an unknown number: a conversation waiting, the automatic reply (in two parts, it is long)
    sms.length = 0;
    await hook({ token, from: "15145550000", message: "Mon imprimante ne marche plus", id: "m1" });
    await hook({ token, from: "15145550000", message: "Mon imprimante ne marche plus", id: "m1" }); // twice: kept once
    let convs = (await tech.get("/api/sms/conversations")).json;
    expect(convs).toEqual([expect.objectContaining({ phone: "5145550000", status: "waiting", contactName: null, unread: 1, lastPreview: "Mon imprimante ne marche plus" })]);
    expect(sms.every((s) => s.method === "sendSMS" && s.dst === "5145550000" && s.did === "4505559000" && s.message!.length <= 160)).toBe(true);
    expect(sms.map((s) => s.message).join(" ")).toContain("Répondez 1");
    expect(sms.map((s) => s.message).join(" ")).toContain("d'ici 4 h");
    const bell = (await tech.get("/api/notifications")).json.items.find((n: any) => n.type === "sms.received");
    expect(bell).toMatchObject({ link: `/tickets?sms=${convs[0].id}`, data: { preview: "Mon imprimante ne marche plus" } });
    expect((await tech.get("/api/sms/summary")).json).toMatchObject({ waiting: 1, unread: 1, ready: true });

    // a technician answers: no automatic ticket for this one
    sms.length = 0;
    expect((await tech.post(`/api/sms/conversations/${convs[0].id}/messages`, { body: "Bonjour, je regarde ça." })).status).toBe(201);
    expect(sms).toEqual([expect.objectContaining({ dst: "5145550000", message: "Bonjour, je regarde ça." })]);
    const thread = (await tech.get(`/api/sms/conversations/${convs[0].id}`)).json;
    expect(thread).toMatchObject({ status: "open", autoTicketAt: null, unread: 0 });
    expect(thread.messages.map((m: any) => [m.direction, m.auto, m.author])).toEqual([
      ["in", false, null],
      ["out", true, null], // the automatic reply (sent in two parts, kept once)
      ["out", false, "Alex Tremblay"],
    ]);

    // a known contact answers 1: a ticket at once for their client, and its number by text
    await hook({ token, from: "450-555-1000", message: "Le serveur est lent", id: "m2" });
    convs = (await tech.get("/api/sms/conversations")).json;
    const known = convs.find((c: any) => c.phone === "4505551000");
    expect(known).toMatchObject({ contactId: "c-300-0", companyId: 300, status: "waiting" });
    sms.length = 0;
    await hook({ token, from: "4505551000", message: " 1 ", id: "m3" });
    const opened = (await tech.get(`/api/sms/conversations/${known.id}`)).json;
    expect(opened.status).toBe("ticket");
    expect(sms[0].message).toContain(opened.ticketNumber);
    const ticket = (await tech.get(`/api/tickets/${opened.ticketId}`)).json;
    expect(ticket).toMatchObject({ company: { id: 300 }, contactId: "c-300-0" });
    expect(ticket.description).toContain("Le serveur est lent");
    // the ticket number sent to the client, and later texts, go in the ticket as internal notes…
    expect(notes).toHaveBeenCalledWith(opened.ticketId, expect.stringContaining("Texto automatique"), expect.stringContaining(opened.ticketNumber));
    await hook({ token, from: "4505551000", message: "Merci!", id: "m4" });
    expect(notes).toHaveBeenLastCalledWith(opened.ticketId, expect.stringContaining("Texto reçu"), "Merci!");
    // …that the portal does not list (it shows the texts themselves)
    expect(JSON.stringify((await tech.get(`/api/tickets/${opened.ticketId}`)).json.notes)).not.toContain("Merci!");

    // nobody answers in time: a ticket by itself (default client for an unknown number), and the client is told
    await hook({ token, from: "8195550123", message: "Besoin d'aide urgente", id: "m5" });
    const late = (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === "8195550123");
    await db().update(schema.smsConversations).set({ autoTicketAt: new Date(Date.now() - 1000) }).where(eq(schema.smsConversations.id, late.id));
    sms.length = 0;
    const { autoTickets } = await import("../server/lib/sms.ts");
    expect(await autoTickets()).toBe(1);
    const auto = (await tech.get(`/api/sms/conversations/${late.id}`)).json;
    expect(auto.status).toBe("ticket");
    expect((await tech.get(`/api/tickets/${auto.ticketId}`)).json.company.id).toBe(301);
    expect(sms[0]).toMatchObject({ dst: "8195550123", message: expect.stringContaining(auto.ticketNumber) });
    // the client is told nobody could answer in time (not the same as when they asked)
    expect(sms.map((s) => s.message).join(" ")).toContain("aucun technicien");

    // from a ticket: a text to the contact, kept with the ticket
    const tk = (await tech.get("/api/tickets?view=all")).json.items[0];
    expect((await tech.post(`/api/sms/ticket/${tk.id}`, { phone: "nope", body: "x" })).json.error).toBe("invalid_phone");
    expect((await tech.post(`/api/sms/ticket/${tk.id}`, { phone: "514 555 7777", body: "Je passe à 14 h." })).status).toBe(201);
    const forTicket = (await tech.get(`/api/sms/ticket/${tk.id}`)).json;
    expect(forTicket.messages.map((m: any) => m.body)).toEqual(["Je passe à 14 h."]);
    expect(notes).toHaveBeenLastCalledWith(tk.id, expect.stringContaining("Texto envoyé par Alex Tremblay"), "Je passe à 14 h.");
    notes.mockRestore();

    // closed: the next text starts a new conversation
    const first = (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === "5145550000");
    await tech.post(`/api/sms/conversations/${first.id}/close`);
    await hook({ token, from: "5145550000", message: "Encore moi", id: "m6" });
    expect((await tech.get("/api/sms/conversations")).json.filter((c: any) => c.phone === "5145550000").map((c: any) => c.status)).toEqual(["waiting"]);
  });

  it("is for technicians only", async () => {
    resetRateLimit("login:ip:unknown");
    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/sms/conversations")).status).toBe(403);
  });

  it("gives a right added to a built-in role's defaults to existing installs, once", async () => {
    const { seed } = await import("../server/db/seed.ts");
    const tech = () => db().select().from(schema.roles).where(eq(schema.roles.slug, "technician")).then((r) => r[0]);
    const before = await tech();
    // an install made before texts existed
    await db().update(schema.roles).set({ permissions: before.permissions.filter((p) => p !== "sms.view"), defaultsApplied: before.permissions.filter((p) => p !== "sms.view") }).where(eq(schema.roles.id, before.id));
    await seed();
    expect((await tech()).permissions).toContain("sms.view");
    // an admin removes it: not given back
    await db().update(schema.roles).set({ permissions: before.permissions.filter((p) => p !== "sms.view") }).where(eq(schema.roles.id, before.id));
    await seed();
    expect((await tech()).permissions).not.toContain("sms.view");
    await db().update(schema.roles).set({ permissions: before.permissions }).where(eq(schema.roles.id, before.id));
  });
});

describe("Outlook (Microsoft 365 mail)", () => {
  const sent: { method: string; url: string; body: any; bearer?: string }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const G = "https://graph.microsoft.com/v1.0/";
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = decodeURIComponent(String(input));
        const method = init.method ?? "GET";
        if (url.includes("login.microsoftonline.com")) {
          const form = new URLSearchParams(String(init.body));
          if (form.get("grant_type") === "authorization_code") {
            expect(form.get("code_verifier")?.length).toBeGreaterThan(40);
            return form.get("code") === "good-code" ? json({ access_token: "user-tok", refresh_token: "r1", expires_in: 3600, scope: "User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite" }) : json({ error: "invalid_grant" }, 400);
          }
          if (form.get("grant_type") === "refresh_token") return json({ access_token: "user-tok", refresh_token: "r2", expires_in: 3600 });
          return json({ access_token: "tok", expires_in: 3600 });
        }
        const bearer = String((init.headers as Record<string, string> | undefined)?.authorization ?? "");
        sent.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, bearer });
        if (url.endsWith("/me?$select=id,displayName,mail,userPrincipalName")) return json({ id: "oid-tech", displayName: "Alex Tremblay", mail: "Tech@akab.local" });
        if (url.includes("users/ghost@akab.local")) return json({ error: { message: "mailbox not found" } }, 404);
        if (/users\/[^/]+\?\$select=displayName$/.test(url)) return json({ displayName: "Boîte" });
        if (url.includes("/mailFolders/inbox?$select=id")) return json({ id: "inbox-id" });
        if (/mailFolders\/(drafts|sentitems|deleteditems|archive|junkemail)\?/.test(url)) return json({ error: { message: "nope" } }, 404);
        if (url.includes("/mailFolders?$top=100")) {
          return json({
            value: [
              { id: "f2", displayName: "Clients", unreadItemCount: 0, totalItemCount: 4, childFolderCount: 1 },
              { id: "inbox-id", displayName: "Boîte de réception", unreadItemCount: 2, totalItemCount: 10, childFolderCount: 0 },
            ],
          });
        }
        if (url.includes("/messages?") && method === "GET") {
          return json({
            value: [{ id: "m1", subject: "Imprimante", from: { emailAddress: { name: "Marie", address: "marie@client.example" } }, receivedDateTime: "2026-10-13T12:00:00Z", bodyPreview: "Bonjour", isRead: false, flag: { flagStatus: "notFlagged" }, hasAttachments: true }],
            "@odata.nextLink": `${G}${url.startsWith(`${G}me/`) ? "me" : "users/tech%40akab.local"}/mailFolders/inbox-id/messages?$skiptoken=abc`,
          });
        }
        if (url.includes("/messages/m1/attachments/a1")) return json({ "@odata.type": "#microsoft.graph.fileAttachment", name: "photo.png", contentType: "image/png", contentId: "<img1>", contentBytes: "aGk=" });
        if (url.includes("/messages/m1/attachments/a2")) return json({ "@odata.type": "#microsoft.graph.fileAttachment", name: "facture é.pdf", contentType: "application/pdf", contentBytes: "JVBERg==" });
        if (url.includes("/messages/m1/attachments?")) {
          return json({
            value: [
              { id: "a1", name: "photo.png", contentType: "image/png", size: 2, isInline: true },
              { id: "a2", name: "facture é.pdf", contentType: "application/pdf", size: 4, isInline: false },
            ],
          });
        }
        if (url.includes("/messages/m1?$select=") && url.includes("parentFolderId")) {
          return json({ id: "m1", subject: "Imprimante", from: { emailAddress: { name: "Marie", address: "marie@client.example" } }, isRead: false, hasAttachments: true, toRecipients: [{ emailAddress: { address: "tech@akab.local" } }], body: { contentType: "html", content: '<p>Bonjour</p><img src="cid:img1">' }, parentFolderId: "inbox-id" });
        }
        if (url.includes("/messages/m1?$select=")) {
          return json({ id: "m1", subject: "Imprimante", from: { emailAddress: { name: "Marie", address: "marie@client.example" } }, receivedDateTime: "2026-10-13T12:00:00Z", toRecipients: [{ emailAddress: { address: "tech@akab.local" } }], body: { contentType: "text", content: "Bonjour\r\nL'imprimante est brisée." } });
        }
        if (url.endsWith("/messages/m1/move")) return json({ id: "m1-moved" }, 201);
        if (url.endsWith("/messages/m1/createReply")) return json({ id: "d1", toRecipients: [{ emailAddress: { address: "marie@client.example" } }] }, 201);
        if (url.endsWith("/messages/d1/attachments")) return json({ id: "x" }, 201);
        if (url.endsWith("/messages/d1/send") || url.endsWith("/sendMail")) return new Response(null, { status: 202 });
        if (method === "PATCH" || method === "DELETE") return json({});
        return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db().update(schema.integrations).set({ enabled: false }).where(eq(schema.integrations.provider, "o365"));
  });

  it("links only one's own mailbox (others need a right), and only the owner can open it", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    // off until the technician turns it on in their profile
    expect((await tech.get("/api/me")).json.preferences.outlook).toBe(false);
    expect((await tech.get("/api/outlook/status")).json.error).toBe("outlook_off");
    expect((await tech.put("/api/me/preferences", { outlook: true })).status).toBe(200);
    expect((await tech.get("/api/me")).json.preferences.outlook).toBe(true);
    await admin.put("/api/me/preferences", { outlook: true });
    await admin.put("/api/admin/integrations/o365", { enabled: false });
    expect((await tech.post("/api/microsoft/connect", {})).json.error).toBe("microsoft_not_configured");
    await admin.put("/api/admin/integrations/o365", { tenantId: "akab.onmicrosoft.com", clientId: "abc-123", secret: "good-secret", enabled: true });
    // the address to register in Entra for the sign-in
    expect((await admin.get("/api/admin/integrations/o365")).json.redirectUri).toBe("http://localhost/api/microsoft/callback");

    // one's own mailbox: the technician signs in to Microsoft first (on their side)
    let status = (await tech.get("/api/outlook/status")).json;
    expect(status).toMatchObject({ ready: true, signedIn: null, accounts: [], ownAddresses: ["tech@akab.local"], canLinkAny: false, canSend: true });
    expect((await tech.post("/api/outlook/accounts", { address: "tech@akab.local" })).json.error).toBe("outlook_sign_in_first");
    const start = (await tech.post("/api/microsoft/connect", {})).json.url as string;
    const auth = new URL(start);
    expect(auth.origin + auth.pathname).toBe("https://login.microsoftonline.com/akab.onmicrosoft.com/oauth2/v2.0/authorize");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost/api/microsoft/callback");
    expect(auth.searchParams.get("scope")).toContain("Mail.Send");
    const state = auth.searchParams.get("state")!;
    // the answer only counts for the person who started it, once
    expect((await admin.get(`/api/microsoft/callback?state=${state}&code=good-code`)).location).toBe("/?microsoft=error");
    const state2 = new URL((await tech.post("/api/microsoft/connect", {})).json.url).searchParams.get("state")!;
    const back = await tech.get(`/api/microsoft/callback?state=${state2}&code=good-code`);
    expect(back).toMatchObject({ status: 302, location: "/?microsoft=connected" });
    expect((await tech.get(`/api/microsoft/callback?state=${state2}&code=good-code`)).location).toBe("/?microsoft=error");
    expect((await tech.get("/api/microsoft")).json).toMatchObject({ available: true, connection: { email: "tech@akab.local", displayName: "Alex Tremblay" } });
    const [conn] = await db().select().from(schema.msConnections);
    expect(conn.refreshToken).not.toContain("r1"); // sealed
    // signing in linked their mailbox, through their own access
    status = (await tech.get("/api/outlook/status")).json;
    expect(status.signedIn).toMatchObject({ email: "tech@akab.local" });
    expect(status.accounts).toEqual([expect.objectContaining({ address: "tech@akab.local", via: "user" })]);
    const linked = { json: status.accounts[0] };
    expect((await tech.post("/api/outlook/accounts", { address: "tech@akab.local" })).json.error).toBe("outlook_already_linked");
    expect((await tech.post("/api/outlook/accounts", { address: "support@akab.local" })).json.error).toBe("outlook_not_own_mailbox");
    sent.length = 0;
    await tech.get(`/api/outlook/accounts/${linked.json.id}/folders`);
    expect(sent.every((s) => s.bearer === "Bearer user-tok" && s.url.startsWith(`${G}me/`))).toBe(true);

    // admins may link shared mailboxes (organisation access); a mailbox that does not exist is refused
    const shared = await admin.post("/api/outlook/accounts", { address: "support@akab.local" });
    expect(shared.json).toMatchObject({ via: "app" });
    sent.length = 0;
    await admin.get(`/api/outlook/accounts/${shared.json.id}/folders`);
    expect(sent.every((s) => s.bearer === "Bearer tok" && s.url.includes("users/support@akab.local/"))).toBe(true);
    expect((await admin.post("/api/outlook/accounts", { address: "ghost@akab.local" })).status).toBe(404);
    // nobody else can open the technician's mailbox, not even an admin
    expect((await admin.get(`/api/outlook/accounts/${linked.json.id}/folders`)).status).toBe(404);
    expect((await admin.get(`/api/outlook/accounts/${linked.json.id}/messages?folder=inbox`)).status).toBe(404);
    // client users have no Outlook
    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/outlook/status")).status).toBe(403);
  });

  it("reads folders, pages and messages; inline images embedded, files downloaded safely", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const acc = (await tech.get("/api/outlook/status")).json.accounts[0];
    const folders = (await tech.get(`/api/outlook/accounts/${acc.id}/folders`)).json;
    expect(folders[0]).toMatchObject({ id: "inbox-id", wellKnown: "inbox", unread: 2 });
    const page = (await tech.get(`/api/outlook/accounts/${acc.id}/messages?folder=inbox-id`)).json;
    expect(page.items[0]).toMatchObject({ id: "m1", subject: "Imprimante", isRead: false, from: { address: "marie@client.example" } });
    expect(page.next).toBe("me/mailFolders/inbox-id/messages?$skiptoken=abc");
    // a page cursor cannot point at another mailbox
    const other = encodeURIComponent("users/ceo%40akab.local/messages");
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/messages?folder=inbox-id&cursor=${other}`)).json.error).toBe("outlook_not_found");

    sent.length = 0;
    const m = (await tech.get(`/api/outlook/accounts/${acc.id}/messages/m1`)).json;
    expect(m.html).toContain("data:image/png;base64,aGk=");
    expect(m.html).not.toContain("cid:");
    expect(m.attachments).toEqual([{ id: "a2", name: "facture é.pdf", contentType: "application/pdf", size: 4, isInline: false }]);
    expect(sent.some((s) => s.method === "PATCH" && s.body?.isRead === true)).toBe(true);

    const res = await app.request(`/api/outlook/accounts/${acc.id}/messages/m1/attachments/a2`, { headers: { host: "localhost", cookie: tech.cookie } });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''facture%20%C3%A9.pdf");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF");

    expect((await tech.patch(`/api/outlook/accounts/${acc.id}/messages/m1`, { flagged: true })).status).toBe(200);
    expect(sent.at(-1)?.body).toEqual({ flag: { flagStatus: "flagged" } });
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/move`, { destination: "archive" })).json).toEqual({ ok: true, id: "m1-moved" });
    expect((await tech.del(`/api/outlook/accounts/${acc.id}/messages/m1`)).status).toBe(200);
    expect(sent.at(-1)?.body).toEqual({ destinationId: "deleteditems" });
  });

  it("sends and replies with files; sending needs its right; too-large files are refused", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const acc = (await tech.get("/api/outlook/status")).json.accounts[0];
    sent.length = 0;
    const file = { name: "note.txt", contentType: "text/plain", data: Buffer.from("allo").toString("base64") };
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/send`, { to: ["marie@client.example"], subject: "Suivi", text: "Bonjour <Marie>\nC'est réglé.", attachments: [file] })).status).toBe(201);
    const mail = sent.find((s) => s.url.endsWith("/sendMail"))!;
    expect(mail.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail"); // as the technician
    expect(mail.body.message.toRecipients).toEqual([{ emailAddress: { address: "marie@client.example" } }]);
    // the technician's text is escaped, line breaks kept
    expect(mail.body.message.body.content).toContain("Bonjour &lt;Marie&gt;<br>C'est réglé.");
    expect(mail.body.message.attachments[0]).toMatchObject({ name: "note.txt", contentBytes: file.data });

    const big = { name: "big.bin", contentType: "application/octet-stream", data: "A".repeat(4_200_000) };
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/send`, { to: ["marie@client.example"], attachments: [big] })).json.error).toBe("outlook_attachments_too_large");
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/respond`, { mode: "forward", text: "voir" })).json.error).toBe("outlook_no_recipient");

    sent.length = 0;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/respond`, { mode: "reply", text: "Merci", attachments: [file] })).status).toBe(201);
    expect(sent.map((s) => `${s.method} ${s.url.split("/messages/")[1]}`)).toEqual(["POST m1/createReply", "POST d1/attachments", "POST d1/send"]);

    const techUser = (await admin.get("/api/admin/staff")).json.find((u: any) => u.email === "tech@akab.local");
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [{ key: "outlook.send", effect: "deny" }] });
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/send`, { to: ["marie@client.example"] })).status).toBe(403);
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/folders`)).status).toBe(200);
    await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [] });
  });

  it("copies an email into a ticket as an internal note, and unlinking ends access", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const acc = (await tech.get("/api/outlook/status")).json.accounts[0];
    const ticketId = (await tech.get("/api/tickets?view=all")).json.items[0].id;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/to-ticket`, { ticketId })).status).toBe(201);
    const note = (await tech.get(`/api/tickets/${ticketId}`)).json.notes.at(-1);
    expect(note).toMatchObject({ internal: true });
    expect(note.text).toContain("De : Marie <marie@client.example>");
    expect(note.text).toContain("L'imprimante est brisée.");
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/messages/m1/text`)).json).toMatchObject({ subject: "Imprimante" });

    expect((await tech.del(`/api/outlook/accounts/${acc.id}`)).status).toBe(200);
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/folders`)).status).toBe(404);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const log = await db().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, u.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["outlook.linked", "outlook.sent", "outlook.reply", "outlook.to_ticket", "outlook.unlinked"]));
  });
});
