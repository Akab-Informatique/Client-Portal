import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";
import nodeCrypto from "node:crypto";

// web push: nothing leaves the tests; what would be sent is recorded
const pushed = vi.hoisted(() => [] as { sub: unknown; payload: any }[]);
const pushFail = vi.hoisted(() => ({ next: null as null | { statusCode?: number; body?: string } }));
vi.mock("web-push", async (orig) => {
  const real: any = await orig();
  const wp = real.default ?? real;
  return { default: { ...wp, setVapidDetails: () => undefined, sendNotification: async (sub: unknown, payload: string) => {
        if (pushFail.next) throw Object.assign(new Error("Received unexpected response code"), pushFail.next);
        pushed.push({ sub, payload: JSON.parse(payload) });
        return { statusCode: 201 };
      } } };
});

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "true";
process.env.REQUIRE_MFA = "true";

const { initDb, db, schema } = await import("../server/db/index.ts");
const { seed } = await import("../server/db/seed.ts");
const { createApp } = await import("../server/app.ts");
const { eq, sql, isNotNull } = await import("drizzle-orm");
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
    const everything = (await admin.get("/api/tickets?view=all")).json.items;
    const isAlertT = (t: any) => /alert/i.test(t.queueLabel) || /alert|monitor/i.test(t.source ?? "");
    const all = everything.filter((t: any) => !isAlertT(t));
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
    // open tickets nobody has, past "new" (whatever their due date)
    const stray = all.filter((t: any) => t.statusKind !== "complete" && t.statusKind !== "new" && !t.assignee);
    expect(r.json.stray.total).toBe(stray.length);
    expect(r.json.stray.byStatus.reduce((s: number, x: any) => s + x.count, 0)).toBe(stray.length);
    expect(r.json.stray.tickets.map((x: any) => x.id).sort()).toEqual(stray.map((x: any) => x.id).sort());
    // each gauge's "Open in Tickets" filter gives the same tickets
    const ids = (items: any[]) => items.map((x: any) => x.id).sort();
    const open = "new,inProgress,needsAttention,waitingCustomer,waitingVendor,scheduled,other";
    expect(ids((await admin.get("/api/tickets?view=due&due=overdue&alerts=0")).json.items)).toEqual(ids(listed.filter((t: any) => t.overdue)));
    expect(ids((await admin.get(`/api/tickets?view=all&statusKind=${open}&due=week&alerts=0`)).json.items)).toEqual(ids(listed.filter((t: any) => !t.overdue)));
    expect(ids((await admin.get(`/api/tickets?view=unassigned&statusKind=${open.replace("new,", "")}&alerts=0`)).json.items)).toEqual(ids(stray));
    // the gauges count only the chosen queues (default: every queue but alerts)
    expect(r.json.queues.custom).toBe(false);
    expect(r.json.queues.counted.length).toBe(r.json.queues.all.filter((q: any) => !/alert/i.test(q.label)).length);
    const q1 = r.json.queues.all[0].value;
    expect((await admin.put("/api/meetings/gauge-queues", { queues: [q1] })).status).toBe(200);
    const only = (await admin.get("/api/meetings/overdue")).json;
    expect(only.queues).toMatchObject({ custom: true, counted: [q1] });
    expect(only.total).toBe(late.filter((t: any) => t.queue === q1).length);
    expect(only.stray.total).toBe(stray.filter((t: any) => t.queue === q1).length);
    expect((await admin.put("/api/meetings/gauge-queues", { queues: ["no-such-queue"] })).status).toBe(400);
    expect((await admin.put("/api/meetings/gauge-queues", { queues: [] })).status).toBe(400);
    expect((await admin.put("/api/meetings/gauge-queues", { queues: null })).status).toBe(200);
    expect((await admin.get("/api/meetings/overdue")).json.total).toBe(late.length);
    // monitoring alerts: their own list (open ones, newest first), and the same in Tickets
    const alerts = everything.filter((t: any) => isAlertT(t) && t.statusKind !== "complete");
    expect(alerts.length).toBeGreaterThan(0);
    expect(ids(r.json.alerts)).toEqual(ids(alerts));
    expect(r.json.completeStatus).toBeTruthy();
    expect(ids((await admin.get(`/api/tickets?view=all&statusKind=${open}&alerts=1`)).json.items)).toEqual(ids(alerts));
    // resolved from the meeting: it leaves the list
    expect((await admin.patch(`/api/tickets/${alerts[0].id}`, { status: r.json.completeStatus })).status).toBe(200);
    expect((await admin.get("/api/meetings/overdue")).json.alerts.map((x: any) => x.id)).not.toContain(alerts[0].id);
    await admin.patch(`/api/tickets/${alerts[0].id}`, { status: alerts[0].status });
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
    // a detailed point: a title and bullet points, then edited
    const c = await admin.post("/api/meetings/points", { text: "Nouveau client", details: "- Contrat signé\n- Installation lundi" });
    expect(c.status).toBe(201);
    list = (await admin.get("/api/meetings/points")).json;
    expect(list.find((p: any) => p.id === c.json.id).details).toBe("- Contrat signé\n- Installation lundi");
    expect((await admin.patch(`/api/meetings/points/${c.json.id}`, { details: "Tout est prêt" })).status).toBe(200);
    expect((await admin.patch(`/api/meetings/points/${c.json.id}`, { details: "x".repeat(8001) })).status).toBe(400);
    list = (await admin.get("/api/meetings/points")).json;
    expect(list.find((p: any) => p.id === c.json.id)).toMatchObject({ text: "Nouveau client", details: "Tout est prêt" });
    expect((await tech.patch(`/api/meetings/points/${c.json.id}`, { details: "x" })).status).toBe(403);
    await admin.del(`/api/meetings/points/${c.json.id}`);
    expect((await admin.del(`/api/meetings/points/${b.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/points/${b.json.id}`)).status).toBe(404);
    await admin.del(`/api/meetings/points/${a.json.id}`);
  });

  it("weekly meeting: notes on points, archive, put off to a later day", async () => {
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const day = (n: number) => {
      const d = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date())}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const ids = (path: string) => admin.get(path).then((r) => r.json.map((p: any) => p.id));
    const p = (await admin.post("/api/meetings/points", { text: "Renouvellement des licences" })).json.id;

    // notes, oldest first, signed
    expect((await admin.post(`/api/meetings/points/${p}/notes`, { text: "Devis demandé" })).status).toBe(201);
    const n2 = await admin.post(`/api/meetings/points/${p}/notes`, { text: "Réponse attendue vendredi" });
    expect((await admin.post(`/api/meetings/points/${p}/notes`, { text: " " })).status).toBe(400);
    expect((await tech.post(`/api/meetings/points/${p}/notes`, { text: "x" })).status).toBe(403);
    let point = (await admin.get("/api/meetings/points")).json.find((x: any) => x.id === p);
    expect(point.notes.map((x: any) => x.text)).toEqual(["Devis demandé", "Réponse attendue vendredi"]);
    expect(point.notes[0].authorName).toBe("Administrateur AKAB");
    expect((await admin.del(`/api/meetings/points/${p}/notes/${n2.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/points/${p}/notes/${n2.json.id}`)).status).toBe(404);

    // put off: gone from the list until that day, listed as "later"; not today or before
    expect((await admin.patch(`/api/meetings/points/${p}`, { snoozeUntil: day(0) })).status).toBe(400);
    expect((await admin.patch(`/api/meetings/points/${p}`, { snoozeUntil: "2026-02-30" })).status).toBe(400);
    expect((await admin.patch(`/api/meetings/points/${p}`, { snoozeUntil: day(3) })).status).toBe(200);
    expect(await ids("/api/meetings/points")).not.toContain(p);
    point = (await admin.get("/api/meetings/points/later")).json.find((x: any) => x.id === p);
    expect(point).toMatchObject({ snoozeUntil: day(3), notes: [{ text: "Devis demandé" }] });
    expect((await admin.patch(`/api/meetings/points/${p}`, { snoozeUntil: null })).status).toBe(200);
    expect(await ids("/api/meetings/points")).toContain(p);

    // archive: out of the list, in the archive with its notes; restored, back on the list
    expect((await tech.patch(`/api/meetings/points/${p}`, { archived: true })).status).toBe(403);
    expect((await admin.patch(`/api/meetings/points/${p}`, { archived: true })).status).toBe(200);
    expect(await ids("/api/meetings/points")).not.toContain(p);
    point = (await admin.get("/api/meetings/points/archive")).json.find((x: any) => x.id === p);
    expect(point.archivedAt).toBeTruthy();
    expect(point.notes).toHaveLength(1);
    expect((await tech.get("/api/meetings/points/archive")).status).toBe(403);
    await admin.patch(`/api/meetings/points/${p}`, { snoozeUntil: day(5) });
    expect((await admin.patch(`/api/meetings/points/${p}`, { archived: false })).status).toBe(200);
    expect(await ids("/api/meetings/points")).toContain(p);
    expect(await ids("/api/meetings/points/archive")).not.toContain(p);
    await admin.del(`/api/meetings/points/${p}`);
  });

  it("weekly meeting: ticket trends", async () => {
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/meetings/trends")).status).toBe(403);
    expect((await admin.get("/api/meetings/trends?weeks=2")).status).toBe(400);
    const r = await admin.get("/api/meetings/trends?weeks=8");
    expect(r.status).toBe(200);
    expect(r.json.weeks).toHaveLength(8);
    expect(r.json.past).toHaveLength(8);
    expect(r.json.weeks[0].current).toBe(true);
    // weeks start on Monday, one week apart, the newest first
    const mondays = r.json.weeks.map((w: any) => w.monday);
    for (const m of mondays) expect(new Date(`${m}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(Date.parse(mondays[0]) - Date.parse(mondays[1])).toBe(7 * 86_400_000);
    for (const w of [...r.json.weeks, r.json.live, ...r.json.past]) {
      expect(w.created).toBeGreaterThanOrEqual(0);
      expect(w.resolved).toBeGreaterThanOrEqual(0);
      expect(w.backlog).toBeGreaterThanOrEqual(0);
      if (w.resolved) expect(w.medianHours).toBeGreaterThanOrEqual(0);
      else expect(w.avgHours).toBeNull();
    }
    // the sample history has tickets every week
    expect(r.json.weeks[1].created).toBeGreaterThan(0);
  });

  it("weekly meeting: the week calendar, day by day", async () => {
    const admin = await signIn("admin@akab.local");
    const team = (await admin.get("/api/meetings/team")).json;
    const ab = await admin.post("/api/meetings/absences", { userId: team[0].id, startDate: "2026-11-09", endDate: "2026-11-10", kind: "training" });
    const pr = await admin.post("/api/meetings/projects", { title: "Livraison serveur", dueDate: "2026-11-12" });
    const late = await admin.post("/api/meetings/projects", { title: "Plus tard", dueDate: "2026-11-30" });
    const week = await admin.get("/api/meetings/week?from=2026-11-09");
    expect(week.status).toBe(200);
    expect(week.json).toMatchObject({ from: "2026-11-09", to: "2026-11-15", ticketsError: false });
    expect(week.json.absences.map((x: any) => x.id)).toContain(ab.json.id);
    expect(week.json.projects.map((x: any) => x.title)).toContain("Livraison serveur");
    expect(week.json.projects.map((x: any) => x.title)).not.toContain("Plus tard");
    expect(Array.isArray(week.json.blocks) && Array.isArray(week.json.tickets)).toBe(true);
    expect((await admin.get("/api/meetings/week?from=2026-13-01")).status).toBe(400);
    expect((await (await signIn("tech@akab.local")).get("/api/meetings/week?from=2026-11-09")).status).toBe(403);
    // things added to the week: whole day or with hours, for the team or one person
    const ev = await admin.post("/api/meetings/events", { date: "2026-11-11", title: "Dîner d'équipe", startTime: "12:00", endTime: "13:00", userId: null });
    expect(ev.status).toBe(201);
    const ev2 = await admin.post("/api/meetings/events", { date: "2026-11-13", title: "Visite client", startTime: "", endTime: "", userId: team[0].id });
    expect(ev2.status).toBe(201);
    expect((await admin.post("/api/meetings/events", { date: "2026-11-11", title: "x", startTime: "14:00", endTime: "13:00" })).status).toBe(400);
    expect((await admin.post("/api/meetings/events", { date: "2026-11-11", title: "x", startTime: "25:00" })).status).toBe(400);
    expect((await admin.post("/api/meetings/events", { date: "2026-11-11", title: " " })).status).toBe(400);
    let events = (await admin.get("/api/meetings/week?from=2026-11-09")).json.events;
    expect(events.map((x: any) => [x.title, x.startTime, x.endTime, x.name])).toEqual([
      ["Dîner d'équipe", "12:00", "13:00", null],
      ["Visite client", null, null, team[0].name],
    ]);
    // linked to a ticket: number and title come from the ticket source, not the browser
    const tk = (await admin.get("/api/tickets?view=all")).json.items[0];
    expect((await admin.put(`/api/meetings/events/${ev2.json.id}`, { date: "2026-11-13", title: "Visite client", ticketId: tk.id, ticketNumber: "faux" })).status).toBe(200);
    expect((await admin.get("/api/meetings/week?from=2026-11-09")).json.events.find((x: any) => x.id === ev2.json.id)).toMatchObject({
      ticketId: tk.id,
      ticketNumber: tk.number,
      ticketTitle: tk.title,
      userId: null,
    });
    expect((await admin.put(`/api/meetings/events/${ev2.json.id}`, { date: "2026-11-13", title: "Visite client", ticketId: 987654321 })).status).toBe(400);
    expect((await admin.put(`/api/meetings/events/${ev2.json.id}`, { date: "2026-11-13", title: "Visite client", userId: team[0].id })).status).toBe(200);
    expect((await admin.put(`/api/meetings/events/${ev.json.id}`, { date: "2026-11-20", title: "Dîner reporté" })).status).toBe(200);
    events = (await admin.get("/api/meetings/week?from=2026-11-09")).json.events;
    expect(events.map((x: any) => x.title)).toEqual(["Visite client"]);
    expect((await (await signIn("tech@akab.local")).post("/api/meetings/events", { date: "2026-11-11", title: "x" })).status).toBe(403);
    expect((await admin.del(`/api/meetings/events/${ev.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/meetings/events/${ev.json.id}`)).status).toBe(404);
    await admin.del(`/api/meetings/events/${ev2.json.id}`);
    await admin.del(`/api/meetings/absences/${ab.json.id}`);
    await admin.del(`/api/meetings/projects/${pr.json.id}`);
    await admin.del(`/api/meetings/projects/${late.json.id}`);
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
    expect(list.map((x: any) => x.key)).toEqual(["welcome", "passwordReset", "passwordChanged", "boardMessage", "ticketReceived"]);

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

    // the restriction: off by default; on, no timer before the start date
    expect(filtered[0].startLocked).toBe(false);
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await tech.put(`/api/tickets/${target.id}/start-date`, { startDate: future });
    expect((await tech.put(`/api/tickets/${target.id}/start-date`, { startLocked: true })).json).toMatchObject({ startDate: future, startLocked: true });
    expect((await tech.get(`/api/tickets/${target.id}`)).json).toMatchObject({ startDate: future, startLocked: true });
    const refused = await tech.post(`/api/tickets/${target.id}/timer/start`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("ticket_not_started");
    // the start date reached (or past): work allowed
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await tech.put(`/api/tickets/${target.id}/start-date`, { startDate: past });
    expect((await tech.post(`/api/tickets/${target.id}/timer/start`)).status).toBe(200);
    await tech.post(`/api/tickets/${target.id}/timer/stop`);
    const pend = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === target.id);
    if (pend) await tech.del(`/api/tickets/timers/${pend.id}`);
    expect((await tech.put(`/api/tickets/${target.id}/start-date`, { startLocked: false })).json.startLocked).toBe(false);

    // the default order is the due date (my priorities first is its own choice)
    const due = (await tech.get("/api/tickets?view=mine")).json.items.map((x: any) => x.dueAt);
    expect(due).toEqual([...due].sort());
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
      title: "Test", description: "", companyId: 300, contact: "", priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01", startDate: "2026-11-30",
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ title: "Test", status: "new", startDate: "2026-11-30" });

    // a due date with its time, and a start time
    const timed = await tech.post("/api/tickets", {
      title: "Avec heures", companyId: 300, priority: "medium", queue: "support", assigneeId: null,
      dueDate: "2026-12-02", dueAt: "2026-12-02T09:30:00-05:00", startDate: "2026-12-01", startTime: "08:15",
    });
    expect(timed.status).toBe(201);
    expect(timed.json).toMatchObject({ dueAt: "2026-12-02T14:30:00.000Z", startDate: "2026-12-01", startTime: "08:15" });
    expect((await tech.get(`/api/tickets/${timed.json.id}`)).json).toMatchObject({ startDate: "2026-12-01", startTime: "08:15" });
    expect((await tech.post("/api/tickets", { title: "x", companyId: 300, priority: "medium", assigneeId: null, dueDate: "2026-12-02", startDate: "2026-12-01", startTime: "8h" })).status).toBe(400);
    // the start time is changed alone, and goes with the day
    expect((await tech.put(`/api/tickets/${timed.json.id}/start-date`, { startTime: "13:00" })).json).toMatchObject({ startDate: "2026-12-01", startTime: "13:00" });
    expect((await tech.put(`/api/tickets/${timed.json.id}/start-date`, { startDate: null })).json).toMatchObject({ startDate: null, startTime: null });
    // the restriction holds until the start time of the day (in Québec)
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    const hour = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    if (hour < 23) {
      await tech.put(`/api/tickets/${timed.json.id}/start-date`, { startDate: today, startTime: "23:59", startLocked: true });
      expect((await tech.post(`/api/tickets/${timed.json.id}/timer/start`)).json.error).toBe("ticket_not_started");
    }
    if (hour > 0) {
      await tech.put(`/api/tickets/${timed.json.id}/start-date`, { startDate: today, startTime: "00:00", startLocked: true });
      expect((await tech.post(`/api/tickets/${timed.json.id}/timer/start`)).status).toBe(200);
      await tech.post(`/api/tickets/${timed.json.id}/timer/stop`);
      const pend = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === timed.json.id);
      if (pend) await tech.del(`/api/tickets/timers/${pend.id}`);
    }
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
    expect(Object.keys(list.metrics).sort()).toEqual(["attention", "attentionBreakdown", "breakdown", "fresh", "mine", "statusAttention", "unassigned"]);
    const needs = (await tech.get("/api/tickets?view=all&status=needsAttention")).json.items;
    expect(needs).toHaveLength(list.metrics.statusAttention);
    expect(needs.every((t: any) => t.status === "needsAttention")).toBe(true);
    const attention = (await tech.get("/api/tickets?view=all&attention=1")).json.items;
    expect(attention).toHaveLength(list.metrics.attention);
    expect(attention.every((t: any) => t.status !== "complete" && (t.priority === "critical" || new Date(t.dueAt).getTime() <= new Date().setHours(23, 59, 59, 999)))).toBe(true);
    expect(list.metrics.mine).toBe(list.counts.mine);
    // each tile's details add up to its number (by status, priority, technician)
    const sum = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    expect(sum(list.metrics.breakdown.mine)).toBe(list.metrics.mine);
    expect(sum(list.metrics.breakdown.unassigned)).toBe(list.metrics.unassigned);
    expect(sum(list.metrics.breakdown.statusAttention)).toBe(list.metrics.statusAttention);
    expect(list.metrics.breakdown.unassigned.every((r: any) => typeof r.kind === "string" && r.count > 0)).toBe(true);

    const saved = await tech.post("/api/tickets/filters", { name: "Critiques réseau", query: "view=all&priority=critical&queue=R%C3%A9seau&evil=1" });
    expect(saved.status).toBe(201);
    expect(saved.json.query).toBe("view=all&priority=critical&queue=R%C3%A9seau");
    expect((await tech.get("/api/tickets/filters")).json.map((f: any) => f.name)).toEqual(["Critiques réseau"]);

    // a saved filter as a button above the list: its count is the list it opens
    expect((await tech.get("/api/tickets")).json.buttons).toEqual([]);
    expect((await tech.patch(`/api/tickets/filters/${saved.json.id}`, { pinned: true })).json).toMatchObject({ pinned: true });
    const button = (await tech.get("/api/tickets")).json.buttons[0];
    expect(button).toMatchObject({ id: saved.json.id, name: "Critiques réseau", query: saved.json.query });
    expect(button.count).toBe((await tech.get(`/api/tickets?${saved.json.query}`)).json.items.length);
    const quick = await tech.post("/api/tickets/filters", { name: "Non assignés critiques", query: "view=unassigned&priority=critical", pinned: true });
    expect((await tech.get("/api/tickets")).json.buttons.map((b: any) => b.name)).toEqual(["Critiques réseau", "Non assignés critiques"]);
    await tech.del(`/api/tickets/filters/${quick.json.id}`);

    const admin = await signIn("admin@akab.local");
    expect((await admin.get("/api/tickets/filters")).json).toEqual([]);
    expect((await admin.patch(`/api/tickets/filters/${saved.json.id}`, { pinned: false })).status).toBe(404); // not theirs
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
    // a day alone: 17:00 in Québec, winter (-05:00) or summer (-04:00) time
    expect(r.json.dueAt).toBe("2026-12-24T22:00:00.000Z");
    expect((await tech.patch(`/api/tickets/${tk.id}`, { dueDate: "2026-07-15" })).json.dueAt).toBe("2026-07-15T21:00:00.000Z");
    // the exact date and time
    expect((await tech.patch(`/api/tickets/${tk.id}`, { dueAt: "2026-12-23T10:30:00-05:00" })).json.dueAt).toBe("2026-12-23T15:30:00.000Z");
    expect((await tech.patch(`/api/tickets/${tk.id}`, { dueAt: "demain" })).status).toBe(400);
    expect((await tech.patch(`/api/tickets/${tk.id}`, { dueAt: "3026-01-01T10:00:00Z" })).status).toBe(400);
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
      // routine tasks think little, with room for the reasoning
      expect(sent[0].body.output_config).toEqual({ effort: "low" });
      expect(sent[0].body.max_tokens).toBeGreaterThanOrEqual(4000);
      expect((await admin.get(`/api/tickets/${id}/ai`)).json[0].content.summary).toBe("Imprimante hors ligne.");
    } finally {
      vi.unstubAllGlobals();
    }

    // Anthropic's reason is kept: a new account without credit says so
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 })),
    );
    try {
      expect((await admin.post("/api/admin/integrations/ai/test", {})).json).toEqual({ ok: false, error: "billing", detail: "Your credit balance is too low to access the Anthropic API." });
      expect((await admin.post(`/api/tickets/${id}/ai/analyze`)).json.error).toBe("ai_billing");
    } finally {
      vi.unstubAllGlobals();
    }

    // a model per part of the portal, another one picked next to the button, usage and cost, daily limits
    await db().delete(schema.aiUsage);
    await admin.put("/api/admin/integrations/ai", { enabled: true, featureModels: { "ticket.reply": "claude-haiku-5-5" }, dailyLimitUsd: null });
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init: RequestInit = {}) => {
        models.push(JSON.parse(String(init.body)).model);
        return new Response(JSON.stringify({ content: [{ type: "text", text: "Bonjour, c'est réglé." }], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }), { status: 200 });
      }),
    );
    try {
      expect((await admin.get("/api/tickets/ai/options")).json).toMatchObject({ allowChoice: true, features: { "ticket.reply": "claude-haiku-5-5", "ticket.analyze": "claude-haiku-5-5" }, today: { spentUsd: 0, limitUsd: null } });
      await admin.post(`/api/tickets/${id}/ai/reply`);
      await admin.post(`/api/tickets/${id}/ai/reply`, { model: "claude-opus-5-5" });
      expect(models).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
      // the choice can be turned off: the part's model is used
      await admin.put("/api/admin/integrations/ai", { allowChoice: false });
      await admin.post(`/api/tickets/${id}/ai/reply`, { model: "claude-opus-5-5" });
      expect(models.at(-1)).toBe("claude-haiku-5-5");
      // cost: Haiku $0.10 + $0.05, Opus $4 + $2 (1 M in, 0.1 M out)
      const u = (await admin.get("/api/admin/integrations/ai/usage?days=7")).json;
      expect(u.today.requests).toBe(3);
      expect(u.today.costUsd).toBeCloseTo(0.15 + 6 + 0.15, 5);
      expect(u.byFeature).toEqual([{ feature: "ticket.reply", costUsd: expect.closeTo(6.3, 5), requests: 3 }]);
      expect(u.byModel.map((m: any) => m.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
      expect(u.byDay).toHaveLength(7);
      const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
      expect(u.byUser.find((x: any) => x.userId === adminRow.id)).toMatchObject({ name: "Administrateur AKAB", todayUsd: expect.closeTo(6.3, 5), requests: 3 });
      // a daily limit per person: reached, no more AI today
      await admin.put("/api/admin/integrations/ai", { dailyLimitUsd: 5 });
      expect((await admin.post(`/api/tickets/${id}/ai/reply`)).json.error).toBe("ai_daily_limit");
      // one person may get more (or nothing: 0)
      await admin.put(`/api/admin/integrations/ai/limits/${adminRow.id}`, { limitUsd: 20 });
      expect((await admin.post(`/api/tickets/${id}/ai/reply`)).status).toBe(200);
      await admin.put(`/api/admin/integrations/ai/limits/${adminRow.id}`, { limitUsd: 0 });
      expect((await admin.post(`/api/tickets/${id}/ai/reply`)).json.error).toBe("ai_daily_limit");
      await admin.put(`/api/admin/integrations/ai/limits/${adminRow.id}`, { limitUsd: null });
      expect((await admin.get("/api/tickets/ai/options")).json.today).toMatchObject({ limitUsd: 5 });
      // the settings and the summary are for admins
      expect((await tech.get("/api/admin/integrations/ai/usage")).status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      await admin.put("/api/admin/integrations/ai", { allowChoice: true, dailyLimitUsd: null, featureModels: {} });
    }
    await admin.put("/api/admin/integrations/ai", { enabled: false });
  });

  it("AI text correction: French by default, needs tickets.ai, HTML sanitized", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    expect((await tech.post("/api/tickets/ai/polish", { text: "bonjour" })).status).toBe(403);
    expect((await admin.post("/api/tickets/ai/polish", { text: "bonjour" })).json.error).toBe("ai_disabled");
    // whatever the general model, the correction uses Haiku (the cheapest) until an admin picks another one for it
    await admin.put("/api/admin/integrations/ai", { apiKey: "sk-ant-test-secret", enabled: true, model: "claude-opus-5-5", featureModels: {} });
    const sent: any[] = [];
    let reply = "Bonjour, l'imprimante est réparée.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init: RequestInit = {}) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), { status: 200 });
      }),
    );
    try {
      expect((await admin.post("/api/tickets/ai/polish", { text: "   " })).status).toBe(400);
      const r = await admin.post("/api/tickets/ai/polish", { text: "bonjour limprimante est reparer" });
      expect(r.status).toBe(200);
      expect(r.json.text).toBe("Bonjour, l'imprimante est réparée.");
      expect(sent[0].system).toContain("français");
      expect(sent[0].model).toBe("claude-haiku-5-5");
      await admin.post("/api/tickets/ai/polish", { text: "salut", model: "claude-opus-5-5" });
      expect(sent.at(-1).model).toBe("claude-haiku-5-5");
      expect(sent.at(-1).system).toContain("français");
      sent.splice(1);
      expect((await admin.get("/api/admin/integrations/ai")).json.features.find((x: any) => x.key === "text.polish")).toMatchObject({ default: "claude-haiku-5-5", model: null });
      // an admin may change it (Admin › AI); a model asked with the request still does not
      await admin.put("/api/admin/integrations/ai", { featureModels: { "text.polish": "claude-sonnet-5-5" } });
      await admin.post("/api/tickets/ai/polish", { text: "salut", model: "claude-opus-5-5" });
      expect(sent.at(-1).model).toBe("claude-sonnet-5-5");
      sent.splice(1);
      // and only an admin
      expect((await tech.put("/api/admin/integrations/ai", { featureModels: { "text.polish": "claude-opus-5-5" } })).status).toBe(403);
      expect(sent[0].messages[0].content).toContain("limprimante");
      await admin.post("/api/tickets/ai/polish", { text: "hello", lang: "en" });
      expect(sent[1].system).toContain("anglais");
      // an email body comes back as safe HTML
      reply = '```html\n<p>Bonjour<script>alert(1)</script></p><p onclick="x()">Merci</p>\n```';
      const h = await admin.post("/api/tickets/ai/polish", { text: "<p>bonjour</p>", format: "html" });
      expect(h.json.text).toBe("<p>Bonjour</p><p>Merci</p>");
    } finally {
      vi.unstubAllGlobals();
      await admin.put("/api/admin/integrations/ai", { enabled: false, model: "claude-haiku-5-5", featureModels: {} });
    }
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

    const nt = await tech.post("/api/tickets", { title: "Avec contact", companyId: 301, contactId: created.json.id, priority: "low", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    expect(nt.json).toMatchObject({ contact: "Nadia Gélinas", contactId: created.json.id });
  });

  it("new ticket: a new client (with the right), its contract, no queue, and attachments", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    // creating a client is a right of its own (not a technician's by default)
    expect((await tech.post("/api/tickets/companies", { name: "Quincaillerie Berthier", phone: "450-555-7777" })).status).toBe(403);
    const co = await admin.post("/api/tickets/companies", { name: "Quincaillerie Berthier", phone: "450-555-7777" });
    expect(co.status).toBe(201);
    expect((await admin.get("/api/tickets/companies")).json.some((c: any) => c.id === co.json.id)).toBe(true);
    expect((await admin.post("/api/tickets/companies", { name: "quincaillerie berthier", phone: "450-555-7777" })).json.error).toBe("company_exists");
    expect((await admin.post("/api/tickets/companies", { name: "Sans téléphone", phone: "" })).status).toBe(400);
    expect((await admin.get(`/api/tickets/companies/${co.json.id}/contracts`)).json).toEqual([]);

    // the client's contracts, the default one first
    const contracts = (await tech.get("/api/tickets/companies/302/contracts")).json;
    expect(contracts[0]).toMatchObject({ isDefault: true });
    const base = { title: "Avec contrat", companyId: 302, priority: "medium", assigneeId: null, dueDate: "2026-12-01" };
    // no queue any more; a contract of another client is refused
    expect((await tech.post("/api/tickets", { ...base, contractId: "k-300-1" })).json.error).toBe("invalid_contract");
    const nt = await tech.post("/api/tickets", { ...base, contractId: contracts[1].id });
    expect(nt.status).toBe(201);
    const { ticketSource } = await import("../server/lib/ticketSource.ts");
    const src = await ticketSource();
    expect((await src.get(nt.json.id))?.contractId).toBe(contracts[1].id);
    // a ticket for the new client, with no contract
    expect((await admin.post("/api/tickets", { ...base, companyId: co.json.id, contractId: null })).status).toBe(201);

    // files, one per request
    const file = { name: "capture écran.png", contentType: "image/png", data: Buffer.from("png-data").toString("base64") };
    expect((await tech.post(`/api/tickets/${nt.json.id}/attachments`, file)).status).toBe(201);
    expect((await src.get(nt.json.id))?.attachments).toMatchObject([{ name: "capture écran.png", size: 8 }]);
    expect((await tech.post(`/api/tickets/${nt.json.id}/attachments`, { ...file, data: "pas du base64 !" })).status).toBe(400);
    expect((await tech.post(`/api/tickets/${nt.json.id}/attachments`, { ...file, data: "A".repeat(7_000_000) })).status).toBe(400);
    expect((await tech.post(`/api/tickets/999999/attachments`, file)).status).toBe(404);
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
    // stock taken without serial numbers shows on the label too: the ticket and its client
    const plain = (await admin.get(`/api/store/products/${ssd.id}/label`)).json;
    expect(plain.assignments).toEqual([expect.objectContaining({ ticketId: tk.id, ticketNumber: tk.number, serial: null, client: tk.company.name })]);
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

  it("quotes: lines from the inventory or typed on the spot, totals, statuses, a line saved to the inventory", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    // reserved to quotes.view / quotes.manage (technicians have neither by default)
    expect((await tech.get("/api/quotes")).status).toBe(403);
    const dock = (await admin.post("/api/store/products", { sku: "DOCK-USBC", name: "Station d'accueil USB-C", priceCents: 14999, costCents: 9000 })).json;
    const [client] = (await admin.get("/api/quotes/clients")).json;
    expect(client).toMatchObject({ id: expect.any(String), taxes: true });
    // nobody to quote for
    expect((await admin.post("/api/quotes", { title: "Vide", lines: [] })).json.error).toBe("quote_who_required");
    expect((await admin.post("/api/quotes", { prospectName: "X", lines: [{ productId: "00000000-0000-4000-8000-000000000000", description: "?", quantityX100: 100, unitPriceCents: 1 }] })).json.error).toBe("product_not_found");

    // a quote with an inventory product (qty 2), a device typed on the spot, and an option
    const made = await admin.post("/api/quotes", {
      clientId: client.id,
      title: "Remplacement de postes",
      lines: [
        { productId: dock.id, sku: "DOCK-USBC", description: dock.name, quantityX100: 200, unitPriceCents: 14999, unitCostCents: 9000 },
        { description: "Portable Latitude 5450", quantityX100: 100, unitPriceCents: 129900, unitCostCents: 98000 },
        { description: "Garantie 3 ans (option)", quantityX100: 100, unitPriceCents: 20000, optional: true },
      ],
    });
    expect(made.status).toBe(201);
    const q = made.json;
    expect(q.number).toMatch(/^S-\d+$/);
    expect(q.status).toBe("draft");
    // (2 × 149.99) + 1299.00 = 1598.98 ; GST 5 % and QST 9.975 % ; the option is shown but not counted
    expect(q.totals).toMatchObject({ subtotalCents: 159898, gstCents: 7995, qstCents: 15950, totalCents: 183843, optionalCents: 20000, marginCents: 159898 - (2 * 9000 + 98000) });
    expect(q.lines.map((l: any) => l.description)).toEqual([dock.name, "Portable Latitude 5450", "Garantie 3 ans (option)"]);
    // the next one gets the next number
    expect(Number((await admin.post("/api/quotes", { prospectName: "Prospect inc." })).json.number.slice(2))).toBe(Number(q.number.slice(2)) + 1);

    // the inventory search: the product used in a quote, by SKU or name
    expect((await admin.get("/api/quotes/products?q=dock")).json).toEqual([expect.objectContaining({ id: dock.id, sku: "DOCK-USBC", priceCents: 14999, costCents: 9000, uses: 1 })]);

    // edit: replace the lines, no taxes
    const saved = await admin.put(`/api/quotes/${q.id}`, { clientId: client.id, title: "Remplacement", taxes: false, lines: [{ description: "Portable", quantityX100: 150, unitPriceCents: 100000 }] });
    expect(saved.json.totals).toMatchObject({ subtotalCents: 150000, gstCents: 0, qstCents: 0, totalCents: 150000 });
    expect((await tech.put(`/api/quotes/${q.id}`, {})).status).toBe(403);

    // statuses: not an empty quote; accepted is locked
    const empty = (await admin.post("/api/quotes", { prospectName: "Vide" })).json;
    expect((await admin.post(`/api/quotes/${empty.id}/status`, { status: "sent" })).json.error).toBe("quote_empty");
    expect((await admin.post(`/api/quotes/${q.id}/status`, { status: "sent" })).json).toMatchObject({ status: "sent", sentAt: expect.any(String) });
    expect((await admin.post(`/api/quotes/${q.id}/status`, { status: "accepted" })).json).toMatchObject({ status: "accepted", decidedAt: expect.any(String) });
    expect((await admin.put(`/api/quotes/${q.id}`, { clientId: client.id, lines: [] })).json.error).toBe("quote_locked");
    expect((await admin.del(`/api/quotes/${q.id}`)).json.error).toBe("quote_locked");

    // a copy is a new draft with the same lines
    const copy = (await admin.post(`/api/quotes/${q.id}/duplicate`, {})).json;
    expect(copy).toMatchObject({ status: "draft", clientId: client.id, taxes: false });
    expect(copy.lines).toHaveLength(1);

    // a line typed on the spot goes to the inventory, tied to the product; the SKU cannot be taken twice
    const line = copy.lines[0];
    expect((await admin.post(`/api/quotes/${copy.id}/lines/${line.id}/to-inventory`, { sku: "DOCK-USBC" })).json.error).toBe("sku_taken");
    const added = await admin.post(`/api/quotes/${copy.id}/lines/${line.id}/to-inventory`, { sku: "LAT-5450" });
    expect(added.status).toBe(201);
    expect((await admin.get(`/api/quotes/${copy.id}`)).json.lines[0]).toMatchObject({ productId: added.json.productId, sku: "LAT-5450" });
    expect((await admin.post(`/api/quotes/${copy.id}/lines/${line.id}/to-inventory`, {})).json.error).toBe("already_in_inventory");
    expect((await admin.get("/api/store")).json.products.find((p: any) => p.sku === "LAT-5450")).toMatchObject({ name: "Portable", priceCents: 100000 });

    // who prepared it: the creator by default, a technician chosen from the staff list, traced on the sheet's data
    const staff = (await admin.get("/api/quotes/staff")).json;
    const me = staff.find((x: any) => x.id === q.preparedById);
    expect(me).toBeTruthy();
    expect(q.preparedBy).toBe(me.name);
    const techUser = staff.find((x: any) => x.id !== q.preparedById);
    expect((await admin.put(`/api/quotes/${empty.id}`, { prospectName: "Vide", preparedById: "00000000-0000-4000-8000-000000000000" })).json.error).toBe("prepared_by_invalid");
    const handed = await admin.put(`/api/quotes/${empty.id}`, { prospectName: "Vide", preparedById: techUser.id });
    expect(handed.json).toMatchObject({ preparedById: techUser.id, preparedBy: techUser.name });
    // the printed sheet takes AKAB's address and phone from the set-up (or its default)
    expect(handed.json.company).toMatchObject({ phone: "450-834-3344", address: expect.stringContaining("J0K 3H0") });

    // quote → project: a ticket in the Projets queue and a point for the weekly meeting, once
    const proj = (await admin.post("/api/quotes", { clientId: client.id, title: "Migration du bureau", lines: [{ description: "Portable", quantityX100: 200, unitPriceCents: 100000 }] })).json;
    expect(proj.clientId ?? proj).toBe(client.id);
    expect((await tech.post(`/api/quotes/${proj.id}/to-project`, {})).status).toBe(403);
    expect((await admin.post(`/api/quotes/${(await admin.post("/api/quotes", { prospectName: "Sans client", lines: [{ description: "x", unitPriceCents: 1 }] })).json.id}/to-project`, {})).json.error).toBe("project_needs_client");
    const pointsBefore = (await admin.get("/api/meetings/points")).json.length;
    // the client is tied to a company of the ticket source (the CRM keeps its id)
    const tk0 = (await admin.get("/api/tickets?view=all")).json.items[0];
    await db().update(schema.clients).set({ autotaskId: tk0.company.id }).where(eq(schema.clients.id, client.id));
    const made2 = await admin.post(`/api/quotes/${proj.id}/to-project`, {});
    expect(made2.status).toBe(201);
    expect(made2.json).toMatchObject({ ticketId: expect.any(Number), ticketNumber: expect.any(String), meetingPointId: expect.any(String) });
    expect((await admin.post(`/api/quotes/${proj.id}/to-project`, {})).json.error).toBe("already_project");
    expect((await admin.get(`/api/quotes/${proj.id}`)).json).toMatchObject({ projectTicketId: made2.json.ticketId, projectTicketNumber: made2.json.ticketNumber });
    const pts = (await admin.get("/api/meetings/points")).json;
    expect(pts.length).toBe(pointsBefore + 1);
    expect(pts.find((x: any) => x.id === made2.json.meetingPointId)).toMatchObject({ text: expect.stringContaining("Migration du bureau") });
    const tk2 = (await admin.get(`/api/tickets/${made2.json.ticketId}`)).json;
    expect(tk2.title).toBe("Projet: Migration du bureau");
    expect(tk2.queue).toBe("projects");

    // a new client's site visit: the checklist answers are kept with the quote, sent with it only, and copied
    const visit = (await admin.post("/api/quotes", { kind: "site_visit", prospectName: "Clinique du Nord", survey: { "general.users": "14", "devices.laptop.qty": "9", "security.mfa_admin": "no" } })).json;
    expect(visit).toMatchObject({ kind: "site_visit", survey: { "general.users": "14", "devices.laptop.qty": "9", "security.mfa_admin": "no" } });
    expect((await admin.put(`/api/quotes/${visit.id}`, { prospectName: "Clinique du Nord", survey: { "general.users": "15" } })).json).toMatchObject({ kind: "site_visit", survey: { "general.users": "15" } });
    expect((await admin.get("/api/quotes")).json.find((x: any) => x.id === visit.id)).toMatchObject({ kind: "site_visit" });
    expect((await admin.get("/api/quotes")).json.find((x: any) => x.id === visit.id).survey).toBeUndefined();
    expect((await admin.post(`/api/quotes/${visit.id}/duplicate`, {})).json).toMatchObject({ kind: "site_visit", survey: { "general.users": "15" } });
    expect((await admin.post("/api/quotes", { kind: "nope", prospectName: "X" })).status).toBe(400);

    // list and filters; deleting a draft
    expect((await admin.get("/api/quotes?status=accepted")).json.map((x: any) => x.id)).toEqual([q.id]);
    expect((await admin.get("/api/quotes?q=prospect")).json).toHaveLength(1);
    expect((await admin.del(`/api/quotes/${copy.id}`)).status).toBe(200);
    expect((await admin.get(`/api/quotes/${copy.id}`)).status).toBe(404);
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

    // the label: the product, and where units and stock went (ticket and client)
    const label = (await admin.get(`/api/store/products/${fw.id}/label`)).json;
    expect(label.product).toMatchObject({ name: fw.name, sku: "FG-40F", priceCents: 79900 });
    expect(label.assignments).toEqual([expect.objectContaining({ ticketId: tk.id, ticketNumber: tk.number, serial: "FGT40F-B", client: tk.company.name })]);
    expect((await tech.get(`/api/store/products/${fw.id}/label`)).status).toBe(403);
    expect((await admin.get("/api/store/products/00000000-0000-4000-8000-000000000000/label")).status).toBe(404);
  });

  it("priorities of the day / week: given by an admin, carried over until done, on the calendar", async () => {
    const admin = await session("admin@akab.local");
    const tech = await session("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [a, b, c] = (await tech.get("/api/tickets?view=all")).json.items;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    const plus = (days: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

    // only planners give priorities to others; a technician only sees their own
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    expect((await tech.post("/api/planning/pins", { ticketId: a.id, technicianId: adminRow.id })).status).toBe(403);
    expect((await tech.get(`/api/planning/pins?technicianId=${adminRow.id}`)).status).toBe(200); // everyone sees everyone's priorities (read only)

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
    // a technician reserves time for themselves only
    expect((await tech.post("/api/planning/calendar", { technicianId: adminRow.id, ticketId: c.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() })).status).toBe(403);
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

    // admins and technicians plan their own time by default (a technician: only their own)
    expect((await admin.post("/api/planning/pins", { ticketId: tk.id, technicianId: adminRow.id, horizon: "day" })).status).toBe(201);
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [{ key: "tickets.planSelf", effect: "deny" }] });
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: techRow.id, horizon: "day" })).status).toBe(403); // when an admin takes the right away
    // everyone's calendar can be looked at; in full only one's own (or as a planner)
    const team = (await tech.get("/api/planning/technicians")).json;
    expect(team).toEqual(expect.arrayContaining([expect.objectContaining({ id: techRow.id, name: "Alex Tremblay", full: true, admin: false }), expect.objectContaining({ id: adminRow.id, name: "Administrateur AKAB", full: false, admin: true })]));
    expect(new Set(team.map((p: any) => p.slot)).size).toBe(team.length); // a color each
    expect((await admin.get("/api/planning/technicians")).json.every((p: any) => p.full)).toBe(true);
    // a colleague's calendar: only when they are busy
    const at = soon(24 * 60);
    const theirs = await admin.post("/api/planning/calendar", { technicianId: adminRow.id, kind: "work", ticketId: tk.id, note: "Confidentiel", startsAt: at, endsAt: new Date(new Date(at).getTime() + 3_600_000).toISOString() });
    expect(theirs.status).toBe(201);
    const range = `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 86_400_000).toISOString())}`;
    const seen = (await tech.get(`/api/planning/calendar?technicianId=${adminRow.id}&${range}`)).json.find((b: any) => b.id === theirs.json.id);
    expect(seen).toMatchObject({ busy: true, title: "", note: "", ticketId: null, ticketNumber: null, companyName: null, startsAt: theirs.json.startsAt });
    expect(JSON.stringify(seen)).not.toContain("Confidentiel");
    const asPlanner = (await admin.get(`/api/planning/calendar?technicianId=${adminRow.id}&${range}`)).json.find((b: any) => b.id === theirs.json.id);
    expect(asPlanner).toMatchObject({ note: "Confidentiel", ticketId: tk.id });
    // the team calendar: an admin's time is busy for a technician, in full for an admin
    const teamTech = (await tech.get(`/api/planning/calendar/team?${range}`)).json.find((b: any) => b.id === theirs.json.id);
    expect(teamTech).toMatchObject({ busy: true, title: "", technicianId: adminRow.id });
    const teamAdmin = (await admin.get(`/api/planning/calendar/team?${range}`)).json.find((b: any) => b.id === theirs.json.id);
    expect(teamAdmin).toMatchObject({ note: "Confidentiel", ticketId: tk.id });
    // an appointment can leave the ticket out of the priorities
    const other = items[3];
    const noPin = await admin.post("/api/planning/calendar", { technicianId: adminRow.id, kind: "work", ticketId: other.id, priority: "none", startsAt: at, endsAt: new Date(new Date(at).getTime() + 1_800_000).toISOString() });
    expect(noPin.status).toBe(201);
    expect((await admin.get(`/api/planning/pins/ticket/${other.id}`)).json).toEqual([]);
    await admin.del(`/api/planning/calendar/${noPin.json.id}`);
    // the whole team's priorities (big view, Everyone)
    const teamPins = (await tech.get("/api/planning/pins?technicianId=all")).json;
    expect(teamPins.some((p: any) => p.technicianId === adminRow.id)).toBe(true);
    // giving one to someone else stays for planners
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: adminRow.id })).status).toBe(403);
    expect((await tech.get(`/api/planning/pins?technicianId=${adminRow.id}`)).status).toBe(200); // everyone sees everyone's priorities (read only)
    await admin.del(`/api/planning/calendar/${theirs.json.id}`);
    await admin.put(`/api/admin/users/${techRow.id}/permissions`, { overrides: [{ key: "tickets.planSelf", effect: "allow" }] });
    expect((await tech.post("/api/planning/pins", { ticketId: tk.id, technicianId: techRow.id, horizon: "day", note: "Moi-même" })).status).toBe(201);
    // "my priorities first" (its own sort): of the day, then of the week; the default order is the due date
    const myList = (await tech.get("/api/tickets")).json.items;
    const last = myList.at(-1);
    const lastPin = await tech.post("/api/planning/pins", { ticketId: last.id, technicianId: techRow.id, horizon: "day" });
    expect(lastPin.status).toBe(201);
    const rank = (x: any) => (x.myPriority === "day" ? 0 : x.myPriority === "week" ? 1 : 2);
    const byDue = (await tech.get("/api/tickets")).json.items.map((x: any) => x.dueAt);
    expect(byDue).toEqual([...byDue].sort());
    for (const q of ["?sort=priorities"]) {
      const list = (await tech.get(`/api/tickets${q}`)).json.items;
      // of the day, then of the week, then the others
      expect(list.map(rank)).toEqual([...list.map(rank)].sort((a: number, b: number) => a - b));
      expect(list.find((x: any) => x.id === last.id)).toMatchObject({ myPriority: "day" });
      expect(rank(list[0])).toBe(0);
    }
    const all = (await tech.get("/api/tickets?view=all")).json.items;
    expect(all.findIndex((x: any) => x.id === last.id)).toBeGreaterThan(1);
    await tech.del(`/api/planning/pins/${lastPin.json.id}`);
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

  it("timers: several can run at once, closed tab becomes an entry to validate", async () => {
    const tech = await session("tech@akab.local");
    const other = await session("tech2@akab.local");
    const [a, b] = (await tech.get("/api/tickets?view=all")).json.items;
    let timers = (await tech.post(`/api/tickets/${a.id}/timer/start`)).json;
    expect(timers).toMatchObject([{ ticketId: a.id, ticketNumber: a.number, state: "running" }]);
    // starting another one keeps the first going (several tickets minimized at once)
    timers = (await tech.post(`/api/tickets/${b.id}/timer/start`)).json;
    expect(timers.map((x: any) => [x.ticketId, x.state])).toEqual([
      [a.id, "running"],
      [b.id, "running"],
    ]);
    await tech.post(`/api/tickets/${a.id}/timer/pause`);
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
    expect(d.notes.at(-1)).toMatchObject({ kind: "time", hours: 0.25, text: "Diagnostic à distance", internalText: "Vérifier le RAID", author: "Alex Tremblay", billable: true });
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
  it("a time entry can send its description by email to the ticket contact and other addresses (never the internal note)", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const { devOutbox } = await import("../server/lib/mail.ts");
    const items = (await tech.get("/api/tickets?view=all")).json.items as any[];
    let tk: any = null;
    for (const x of items) {
      const d = (await tech.get(`/api/tickets/${x.id}`)).json;
      if (d.contactInfo?.email && d.statusKind !== "complete") {
        tk = d;
        break;
      }
    }
    expect(tk).toBeTruthy();
    await tech.post(`/api/tickets/${tk.id}/timer/start`);
    await tech.post(`/api/tickets/${tk.id}/timer/stop`);
    const timer = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === tk.id);
    const entry = { hours: 0.5, summary: "Imprimante réinstallée, test d'impression réussi.", internal: "Pilote v3 seulement" };
    expect((await tech.post(`/api/tickets/timers/${timer.id}/submit`, { ...entry, notify: { contact: true, others: ["pas-une-adresse"] } })).status).toBe(400);
    devOutbox.length = 0;
    const r = await tech.post(`/api/tickets/timers/${timer.id}/submit`, { ...entry, notify: { contact: true, others: ["Patron@Client.example", tk.contactInfo.email] } });
    expect(r.status).toBe(201);
    // one message each, the contact once
    expect(r.json).toMatchObject({ notified: 2, notifyFailed: 0, noContactEmail: false });
    expect(devOutbox.map((m) => m.to).sort()).toEqual([tk.contactInfo.email.toLowerCase(), "patron@client.example"].sort());
    const mail = devOutbox[0];
    expect(mail.subject).toContain(tk.number);
    expect(mail.text).toContain(entry.summary);
    expect(mail.text).toContain("Alex Tremblay");
    expect(mail.text + mail.html).not.toContain("Pilote v3");
    // a reply (not an internal note) can also go to other addresses, one message each
    devOutbox.length = 0;
    const rep = await tech.post(`/api/tickets/${tk.id}/notes`, { text: "Voici la marche à suivre.", internal: false, others: ["Collegue@Client.example"] });
    expect(rep.json).toMatchObject({ emailed: true });
    expect(devOutbox.map((m) => m.to).sort()).toEqual([tk.contactInfo.email.toLowerCase(), "collegue@client.example"].sort());
    expect(devOutbox[0].text).toContain("Voici la marche à suivre.");
    // the contact switched off: only the others
    devOutbox.length = 0;
    await tech.post(`/api/tickets/${tk.id}/notes`, { text: "Pour toi seulement.", internal: false, email: false, others: ["collegue@client.example"] });
    expect(devOutbox.map((m) => m.to)).toEqual(["collegue@client.example"]);
    // never an internal note; a wrong address is refused
    devOutbox.length = 0;
    await tech.post(`/api/tickets/${tk.id}/notes`, { text: "Note privée", internal: true, others: ["x@y.example"] });
    expect(devOutbox).toHaveLength(0);
    expect((await tech.post(`/api/tickets/${tk.id}/notes`, { text: "Mauvaise adresse", internal: false, others: ["pas-une-adresse"] })).status).toBe(400);
    // not asked: nothing sent
    await tech.post(`/api/tickets/${tk.id}/timer/start`);
    await tech.post(`/api/tickets/${tk.id}/timer/stop`);
    const t2 = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === tk.id);
    devOutbox.length = 0;
    expect((await tech.post(`/api/tickets/timers/${t2.id}/submit`, { hours: 0.1, summary: "Suivi" })).json).toMatchObject({ notified: 0 });
    expect(devOutbox).toEqual([]);

    // the client portal too: a portal user of that company with an address that got the email sees it on their bell
    const [portalUser] = await db().select().from(schema.users).where(eq(schema.users.email, "responsable1@client.example"));
    await db().update(schema.clients).set({ autotaskId: tk.company.id }).where(eq(schema.clients.id, portalUser.clientId!));
    await tech.post(`/api/tickets/${tk.id}/timer/start`);
    await tech.post(`/api/tickets/${tk.id}/timer/stop`);
    const t3 = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === tk.id);
    const shared = await tech.post(`/api/tickets/timers/${t3.id}/submit`, { hours: 0.25, summary: "Mise à jour appliquée.", internal: "Reboot nécessaire", notify: { contact: false, others: ["Responsable1@client.example", "inconnu@ailleurs.example"] } });
    expect(shared.json).toMatchObject({ notified: 2, notifiedInPortal: 1 });
    const bell = await db().select().from(schema.notifications).where(eq(schema.notifications.userId, portalUser.id));
    const work = bell.filter((n) => n.type === "ticket.work");
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ link: `/tickets?t=${tk.id}`, data: { number: tk.number, from: "Alex Tremblay", preview: "Mise à jour appliquée." } });
    expect(JSON.stringify(work[0])).not.toContain("Reboot");
    // not shared with the client: no notification
    await tech.post(`/api/tickets/${tk.id}/timer/start`);
    await tech.post(`/api/tickets/${tk.id}/timer/stop`);
    const t4 = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === tk.id);
    expect((await tech.post(`/api/tickets/timers/${t4.id}/submit`, { hours: 0.1, summary: "Interne" })).json).toMatchObject({ notified: 0, notifiedInPortal: 0 });
    expect((await db().select().from(schema.notifications).where(eq(schema.notifications.userId, portalUser.id))).filter((n) => n.type === "ticket.work")).toHaveLength(1);
  });
});

describe("workflows: automatic reply to a new ticket", () => {
  it("starts off; once on, a new ticket gets one email to its contact; nothing before, nothing twice, nothing once off", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const { devOutbox } = await import("../server/lib/mail.ts");
    const { workflowTick } = await import("../server/lib/workflows.ts");
    const make = (title: string, contactId: string | null) =>
      admin.post("/api/tickets", { title, description: "", companyId: 300, contactId, priority: "medium", assigneeId: null, dueDate: "2026-12-01" }).then((r) => r.json);

    // the right is the administrators': a technician cannot see or switch anything
    expect((await tech.get("/api/admin/workflows")).status).toBe(403);
    expect((await tech.put("/api/admin/workflows/new-ticket-reply", { enabled: true })).status).toBe(403);
    // off by default
    const first = (await admin.get("/api/admin/workflows")).json;
    expect(first.workflows).toEqual([expect.objectContaining({ key: "new-ticket-reply", template: "ticketReceived", enabled: false, enabledAt: null })]);
    expect((await admin.put("/api/admin/workflows/nope", { enabled: true })).status).toBe(404);

    // a ticket made while it is off: never answered, even after it is switched on
    const before = await make("Avant le flux", "c-300-0");
    devOutbox.length = 0;
    await workflowTick();
    expect(devOutbox).toEqual([]);
    await new Promise((r) => setTimeout(r, 15));
    expect((await admin.put("/api/admin/workflows/new-ticket-reply", { enabled: true })).json).toMatchObject({ enabled: true, enabledAt: expect.any(String) });
    expect((await admin.get("/api/admin/workflows")).json.workflows[0].enabled).toBe(true);
    await workflowTick();
    expect(devOutbox).toEqual([]);

    // a new ticket: one email to the contact, in the "Billet reçu" template
    const contact = (await admin.get("/api/tickets/companies/300/contacts")).json.find((x: any) => x.id === "c-300-0");
    const made = await make("Imprimante hors ligne", "c-300-0");
    expect(await workflowTick()).toBe(1);
    expect(devOutbox).toHaveLength(1);
    expect(devOutbox[0].to).toBe(contact.email.toLowerCase());
    expect(devOutbox[0].subject).toContain(made.number);
    expect(devOutbox[0].text).toContain("Imprimante hors ligne");
    expect(devOutbox[0].text).toContain(contact.name);
    // not twice, not for the one from before
    expect(await workflowTick()).toBe(0);
    expect(devOutbox).toHaveLength(1);

    // no contact: nothing to write to, noted once and not retried
    const nobody = await make("Sans contact", null);
    devOutbox.length = 0;
    expect(await workflowTick()).toBe(0);
    expect(await workflowTick()).toBe(0);
    expect(devOutbox).toEqual([]);

    const runs = (await admin.get("/api/admin/workflows/new-ticket-reply/runs")).json;
    expect(runs.find((x: any) => x.ticketId === made.id)).toMatchObject({ status: "sent", toEmail: contact.email.toLowerCase(), ticketNumber: made.number });
    expect(runs.find((x: any) => x.ticketId === nobody.id)).toMatchObject({ status: "skipped", reason: "no_contact" });
    expect(runs.some((x: any) => x.ticketId === before.id)).toBe(false);
    expect((await admin.get("/api/admin/workflows")).json.workflows[0].counts).toMatchObject({ sent: 1, skipped: 1 });

    // the test message goes to the administrator, marked as a test
    devOutbox.length = 0;
    expect((await admin.post("/api/admin/workflows/new-ticket-reply/test")).json).toMatchObject({ ok: true, to: "admin@akab.local" });
    expect(devOutbox[0]).toMatchObject({ to: "admin@akab.local" });
    expect(devOutbox[0].subject).toMatch(/^\[TEST\]/);
    expect((await tech.post("/api/admin/workflows/new-ticket-reply/test")).status).toBe(403);

    // off again: a new ticket gets nothing
    expect((await admin.put("/api/admin/workflows/new-ticket-reply", { enabled: false })).json).toMatchObject({ enabled: false, enabledAt: null });
    devOutbox.length = 0;
    await make("Après", "c-300-0");
    expect(await workflowTick()).toBe(0);
    expect(devOutbox).toEqual([]);
    // switching it on again starts from that moment, not before
    await admin.put("/api/admin/workflows/new-ticket-reply", { enabled: true });
    expect(await workflowTick()).toBe(0);
    await admin.put("/api/admin/workflows/new-ticket-reply", { enabled: false });
  });
});

describe("ticket queues (the portal's own)", () => {
  it("Support, Alertes and Projets to start; a technician picks one; an admin manages them", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    // the right: administrators only
    expect((await tech.get("/api/admin/queues")).status).toBe(403);
    expect((await tech.post("/api/admin/queues", { name: "X" })).status).toBe(403);
    const start = (await admin.get("/api/admin/queues")).json;
    expect(start.map((q: any) => [q.key, q.name, q.alerts, q.isDefault])).toEqual([
      ["support", "Support", false, true],
      ["alerts", "Alertes", true, false],
      ["projects", "Projets", false, false],
    ]);
    // what the tickets pages offer
    const options = (await tech.get("/api/tickets")).json.facets.queues;
    expect(options).toEqual([
      { value: "support", label: "Support", kind: "" },
      { value: "alerts", label: "Alertes", kind: "alerts" },
      { value: "projects", label: "Projets", kind: "" },
    ]);

    // a ticket made in a queue; changed to another; an unknown one refused
    const make = (queue: string) =>
      tech.post("/api/tickets", { title: `File ${queue}`, companyId: 300, priority: "medium", queue, assigneeId: null, dueDate: "2026-12-01" });
    const proj = await make("projects");
    expect(proj.json).toMatchObject({ queue: "projects", queueLabel: "Projets" });
    expect((await make("Support niveau 1")).status).toBe(400);
    expect((await tech.patch(`/api/tickets/${proj.json.id}`, { queue: "nope" })).status).toBe(400);
    const none = await tech.post("/api/tickets", { title: "Sans file", companyId: 300, priority: "medium", assigneeId: null, dueDate: "2026-12-01" });
    expect(none.json).toMatchObject({ queue: "support", queueLabel: "Support" });
    const inQueue = async (key: string) => (await tech.get(`/api/tickets?view=all&queue=${key}`)).json.items.map((t: any) => t.id);
    expect(await inQueue("projects")).toContain(proj.json.id);
    expect(await inQueue("support")).not.toContain(proj.json.id);

    // a queue marked as alerts: its tickets are alerts (out of the gauges and the list without alerts)
    expect((await tech.patch(`/api/tickets/${proj.json.id}`, { queue: "alerts" })).status).toBe(200);
    expect((await tech.get("/api/tickets?view=all&alerts=0")).json.items.map((t: any) => t.id)).not.toContain(proj.json.id);
    expect((await tech.get("/api/tickets?view=all&alerts=1")).json.items.map((t: any) => t.id)).toContain(proj.json.id);

    // managing: create (a name once), rename, order, default, alerts flag
    const created = await admin.post("/api/admin/queues", { name: "Réseau" });
    expect(created.json.key).toBe("reseau");
    expect((await admin.post("/api/admin/queues", { name: "réseau" })).json.error).toBe("queue_exists");
    expect((await admin.post("/api/admin/queues", { name: " " })).status).toBe(400);
    expect((await admin.patch("/api/admin/queues/reseau", { name: "Réseau et sécurité" })).status).toBe(200);
    expect((await admin.patch("/api/admin/queues/reseau", { name: "Support" })).json.error).toBe("queue_exists");
    expect((await tech.get("/api/tickets")).json.facets.queues.map((q: any) => q.label)).toEqual(["Support", "Alertes", "Projets", "Réseau et sécurité"]);
    expect((await admin.post("/api/admin/queues/reseau/move", { direction: "up" })).status).toBe(200);
    expect((await admin.get("/api/admin/queues")).json.map((q: any) => q.key)).toEqual(["support", "alerts", "reseau", "projects"]);
    expect((await admin.patch("/api/admin/queues/alerts", { isDefault: true })).json.error).toBe("queue_default_alerts");
    expect((await admin.patch("/api/admin/queues/support", { alerts: true })).json.error).toBe("queue_default_alerts");
    expect((await admin.patch("/api/admin/queues/missing", { name: "x" })).status).toBe(404);

    // deleting: its tickets go to the default queue; the default queue cannot go
    await tech.patch(`/api/tickets/${none.json.id}`, { queue: "reseau" });
    expect((await admin.get("/api/admin/queues")).json.find((q: any) => q.key === "reseau").openTickets).toBeGreaterThan(0);
    expect((await admin.del("/api/admin/queues/support")).json.error).toBe("queue_is_default");
    expect((await admin.del("/api/admin/queues/reseau")).status).toBe(200);
    expect((await tech.get(`/api/tickets/${none.json.id}`)).json.queue).toBe("support");
    // a queue that is the default cannot go either; the built-in ones stay (the other tests use them)
    await admin.post("/api/admin/queues", { name: "Temp" });
    expect((await admin.patch("/api/admin/queues/temp", { isDefault: true })).status).toBe(200);
    expect((await admin.del("/api/admin/queues/temp")).json.error).toBe("queue_is_default");
    expect((await admin.patch("/api/admin/queues/support", { isDefault: true })).status).toBe(200);
    expect((await admin.del("/api/admin/queues/temp")).status).toBe(200);
    expect((await admin.get("/api/admin/queues")).json.map((q: any) => [q.key, q.isDefault])).toEqual([["support", true], ["alerts", false], ["projects", false]]);
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
        // VoIP.ms refuses this one (the server IP not allowed in its API settings)
        if (p.get("dst") === "5145558888") return new Response(JSON.stringify({ status: "ip_not_enabled" }), { headers: { "content-type": "application/json" } });
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
    const { receivedSettled } = await import("../server/lib/sms.ts");
    // the callback answers at once; the text is handled just after
    const hook = async (q: Record<string, string>) => {
      const r = await admin.get(`/api/sms/hook/voipms?${new URLSearchParams(q)}`);
      await receivedSettled();
      return r;
    };
    // texts of a ticket are copied as internal notes (Autotask)
    const { ticketSource } = await import("../server/lib/ticketSource.ts");
    const notes = vi.spyOn(await ticketSource(), "addSmsNote");

    // wrong token: "ok", nothing kept
    expect((await hook({ token: "nope", from: "5145550000", message: "x", id: "z" })).status).toBe(200);
    expect((await tech.get("/api/sms/conversations")).json).toEqual([]);

    // an unknown number: a conversation waiting, the automatic reply (long: one MMS rather than several texts)
    sms.length = 0;
    await hook({ token, from: "15145550000", message: "Mon imprimante ne marche plus", id: "m1" });
    await hook({ token, from: "15145550000", message: "Mon imprimante ne marche plus", id: "m1" }); // twice: kept once
    let convs = (await tech.get("/api/sms/conversations")).json;
    expect(convs).toEqual([expect.objectContaining({ phone: "5145550000", status: "waiting", contactName: null, unread: 1, lastPreview: "Mon imprimante ne marche plus" })]);
    expect(sms.map((s) => [s.method, s.dst, s.did])).toEqual([["sendMMS", "5145550000", "4505559000"]]);
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

    // a known contact answers 1: we ask what it is about, then the ticket opens with the answer
    await hook({ token, from: "450-555-1000", message: "Le serveur est lent", id: "m2" });
    convs = (await tech.get("/api/sms/conversations")).json;
    const known = convs.find((c: any) => c.phone === "4505551000");
    expect(known).toMatchObject({ contactId: "c-300-0", companyId: 300, status: "waiting" });
    sms.length = 0;
    await hook({ token, from: "4505551000", message: " 1 ", id: "m3" });
    expect((await tech.get(`/api/sms/conversations/${known.id}`)).json.status).toBe("details");
    expect(sms.map((s) => s.message).join(" ")).toContain("quelle est votre demande");
    sms.length = 0;
    await hook({ token, from: "4505551000", message: "Depuis ce matin, sur le poste de Julie", id: "m3b" });
    const opened = (await tech.get(`/api/sms/conversations/${known.id}`)).json;
    // the ticket is made, the client thanked with its number and request, and the conversation ends
    expect(opened.status).toBe("closed");
    const thanks = sms.map((s) => s.message).join(" ");
    expect(thanks).toContain(opened.ticketNumber);
    expect(thanks).toContain("Depuis ce matin");
    const ticket = (await tech.get(`/api/tickets/${opened.ticketId}`)).json;
    expect(ticket).toMatchObject({ company: { id: 300 }, contactId: "c-300-0" });
    expect(ticket.title).toContain("Depuis ce matin, sur le poste de Julie");
    expect(ticket.description).toContain("Le serveur est lent");
    expect(ticket.description).toContain("Depuis ce matin, sur le poste de Julie");
    // the message to the client goes in the ticket as an internal note…
    expect(notes).toHaveBeenCalledWith(opened.ticketId, expect.stringContaining("Texto automatique"), expect.stringContaining(opened.ticketNumber));
    // …and the next text starts a new conversation (no second automatic reply within 24 h)
    sms.length = 0;
    await hook({ token, from: "4505551000", message: "Merci!", id: "m4" });
    expect((await tech.get("/api/sms/conversations")).json.filter((c: any) => c.phone === "4505551000").map((c: any) => c.status)).toEqual(["waiting"]);
    expect(notes).not.toHaveBeenLastCalledWith(opened.ticketId, expect.anything(), "Merci!");
    expect(sms).toEqual([]);
    // the texts are kept with the ticket, not as notes the portal lists
    expect(JSON.stringify((await tech.get(`/api/tickets/${opened.ticketId}`)).json.notes)).not.toContain("Depuis ce matin");
    expect((await tech.get(`/api/sms/ticket/${opened.ticketId}`)).json.messages.some((m: any) => m.body === "Depuis ce matin, sur le poste de Julie")).toBe(true);

    // nobody answers in time: a ticket by itself (default client for an unknown number), and the client is told
    await hook({ token, from: "8195550123", message: "Besoin d'aide urgente", id: "m5" });
    const late = (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === "8195550123");
    await db().update(schema.smsConversations).set({ autoTicketAt: new Date(Date.now() - 1000) }).where(eq(schema.smsConversations.id, late.id));
    sms.length = 0;
    const { autoTickets } = await import("../server/lib/sms.ts");
    expect(await autoTickets()).toBe(1);
    const auto = (await tech.get(`/api/sms/conversations/${late.id}`)).json;
    // made a ticket because nobody answered: the conversation is closed (kept with its ticket)
    expect(auto.status).toBe("closed");
    expect(auto.ticketId).toBeTruthy();
    expect((await tech.get(`/api/tickets/${auto.ticketId}`)).json.company.id).toBe(301);
    expect(sms[0]).toMatchObject({ dst: "8195550123", message: expect.stringContaining(auto.ticketNumber) });
    // the client is told nobody could answer in time (not the same as when they asked)
    expect(sms.map((s) => s.message).join(" ")).toContain("aucun technicien");
    // the next text from that number: a new conversation (a new ticket if nobody answers), no second automatic reply within 24 h
    sms.length = 0;
    await hook({ token, from: "8195550123", message: "Toujours en panne", id: "m5b" });
    const again2 = (await tech.get("/api/sms/conversations")).json.filter((c: any) => c.phone === "8195550123");
    expect(again2.map((c: any) => c.status)).toEqual(["waiting"]);
    expect(sms).toEqual([]);
    expect(await autoTickets(new Date(Date.now() + 5 * 3_600_000))).toBe(2); // this one and the "Merci!" conversation above
    const second = (await tech.get(`/api/sms/conversations/${again2[0].id}`)).json;
    expect(second.ticketId).toBeTruthy();
    expect(second.ticketId).not.toBe(auto.ticketId);

    // from a ticket: a text to the contact, kept with the ticket
    const tk = (await tech.get("/api/tickets?view=all")).json.items[0];
    expect((await tech.post(`/api/sms/ticket/${tk.id}`, { phone: "nope", body: "x" })).json.error).toBe("invalid_phone");
    expect((await tech.post(`/api/sms/ticket/${tk.id}`, { phone: "514 555 7777", body: "Je passe à 14 h." })).status).toBe(201);
    const forTicket = (await tech.get(`/api/sms/ticket/${tk.id}`)).json;
    expect(forTicket.messages.map((m: any) => m.body)).toEqual(["Je passe à 14 h."]);
    expect(notes).toHaveBeenLastCalledWith(tk.id, expect.stringContaining("Texto envoyé par Alex Tremblay"), "Je passe à 14 h.");
    // refused by VoIP.ms: the reason comes back, and stays on the failed text
    const refused = await tech.post(`/api/sms/ticket/${tk.id}`, { phone: "514 555 8888", body: "Allo?" });
    expect(refused.status).toBe(502);
    expect(refused.json).toMatchObject({ error: "sms_api", fields: [{ path: "sms", message: "ip_not_enabled" }] });
    expect((await tech.get(`/api/sms/ticket/${tk.id}`)).json.messages.at(-1)).toMatchObject({ body: "Allo?", status: "failed", error: "api: ip_not_enabled" });

    // a text from the client of a ticket: the ticket needs attention (like a new client reply), the texts count as unread until looked at
    const open = (await tech.get("/api/tickets?view=all")).json.items.find((x: any) => x.statusKind === "inProgress");
    await tech.post(`/api/sms/ticket/${open.id}`, { phone: "514 555 6600", body: "Bonjour, je passe à 15 h." });
    expect((await tech.get(`/api/tickets/${open.id}`)).json.statusKind).toBe("inProgress");
    await hook({ token, from: "5145556600", message: "Parfait, merci !", id: "att1" });
    expect((await tech.get(`/api/tickets/${open.id}`)).json.statusKind).toBe("needsAttention");
    let linked = (await tech.get(`/api/sms/ticket/${open.id}`)).json;
    expect(linked.conversations[0].unread).toBe(1);
    expect((await tech.post(`/api/sms/ticket/${open.id}/read`)).status).toBe(200);
    expect((await tech.get(`/api/sms/ticket/${open.id}`)).json.conversations[0].unread).toBe(0);
    // a resolved ticket stays resolved
    const done = (await tech.get("/api/tickets?view=all&statusKind=complete")).json.items[0];
    if (done) {
      await tech.post(`/api/sms/ticket/${done.id}`, { phone: "514 555 6601", body: "Terminé ?" });
      await hook({ token, from: "5145556601", message: "Oui merci", id: "att2" });
      expect((await tech.get(`/api/tickets/${done.id}`)).json.statusKind).toBe("complete");
    }

    // a group text: the same text to several people, each in their own conversation, one group key
    const group = await tech.post(`/api/sms/ticket/${open.id}`, {
      recipients: [{ phone: "514 555 6610", name: "Marc Roy" }, { phone: "514 555 6611", name: "Julie Fortin" }],
      body: "Panne réseau, on s'en occupe.",
    });
    expect(group.status).toBe(201);
    expect(group.json.groupKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(group.json.sent.map((x: any) => x.ok)).toEqual([true, true]);
    linked = (await tech.get(`/api/sms/ticket/${open.id}`)).json;
    const groupMsgs = linked.messages.filter((m: any) => m.groupKey === group.json.groupKey);
    expect(groupMsgs.map((m: any) => m.body)).toEqual(["Panne réseau, on s'en occupe.", "Panne réseau, on s'en occupe."]);
    expect(new Set(groupMsgs.map((m: any) => m.conversationId)).size).toBe(2);
    expect(linked.conversations.filter((c: any) => ["5145556610", "5145556611"].includes(c.phone)).map((c: any) => c.contactName).sort()).toEqual(["Julie Fortin", "Marc Roy"]);
    // the same person twice, a bad number, nobody: refused; one person alone is not a group
    expect((await tech.post(`/api/sms/ticket/${open.id}`, { recipients: [{ phone: "514 555 6610" }, { phone: "(514) 555-6610" }], body: "x" })).json.error).toBe("duplicate_recipient");
    expect((await tech.post(`/api/sms/ticket/${open.id}`, { recipients: [{ phone: "nope" }, { phone: "514 555 6611" }], body: "x" })).json.error).toBe("invalid_phone");
    expect((await tech.post(`/api/sms/ticket/${open.id}`, { recipients: [], body: "x" })).status).toBe(400);
    expect((await tech.post(`/api/sms/ticket/${open.id}`, { recipients: [{ phone: "514 555 6612" }], body: "Seul" })).json.groupKey).toBeNull();
    notes.mockRestore();

    // closed: the next text starts a new conversation
    const first = (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === "5145550000");
    await tech.post(`/api/sms/conversations/${first.id}/close`);
    sms.length = 0;
    await hook({ token, from: "5145550000", message: "Encore moi", id: "m6" });
    expect((await tech.get("/api/sms/conversations")).json.filter((c: any) => c.phone === "5145550000").map((c: any) => c.status)).toEqual(["waiting"]);
    // it got the automatic reply less than 24 h ago: not again
    expect(sms).toEqual([]);
    // after the cool-down (or with it at 0): again
    await db().update(schema.smsConversations).set({ autoRepliedAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(schema.smsConversations.phone, "5145550000"));
    const third = (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === "5145550000");
    await tech.post(`/api/sms/conversations/${third.id}/close`);
    await hook({ token, from: "5145550000", message: "Le lendemain", id: "m7" });
    expect(sms.map((s) => s.dst)).toContain("5145550000");

    // deleted for good, texts and all (open or closed); every closed one at once
    const all = (await tech.get("/api/sms/conversations?all=1")).json;
    const mine = all.filter((c: any) => c.phone === "5145550000");
    expect(mine.length).toBeGreaterThan(1);
    const closed = mine.find((c: any) => c.status === "closed");
    expect((await tech.del(`/api/sms/conversations/${closed.id}`)).status).toBe(200);
    expect((await tech.get(`/api/sms/conversations/${closed.id}`)).status).toBe(404);
    expect((await tech.del(`/api/sms/conversations/${closed.id}`)).status).toBe(404);
    const live = mine.find((c: any) => c.status !== "closed");
    expect((await tech.del(`/api/sms/conversations/${live.id}`)).status).toBe(200);
    expect((await tech.del("/api/sms/conversations")).status).toBe(400);
    const left = (await tech.del("/api/sms/conversations?closed=1")).json;
    expect(left.ok).toBe(true);
    expect((await tech.get("/api/sms/conversations?all=1")).json.some((c: any) => c.status === "closed")).toBe(false);
  });

  it("unknown numbers: AKAB when no default client; a technician picks the client first; 1 without details still opens", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const { receivedSettled, autoTickets } = await import("../server/lib/sms.ts");
    const { saveSmsSettings, smsSettings } = await import("../server/lib/voipms.ts");
    const token = (await smsSettings()).token!;
    const hook = async (q: Record<string, string>) => {
      await tech.get(`/api/sms/hook/voipms?${new URLSearchParams({ token, ...q })}`);
      await receivedSettled();
    };
    const conv = async (phone: string) => (await tech.get("/api/sms/conversations")).json.find((c: any) => c.phone === phone);
    await saveSmsSettings(null, { defaultCompanyId: null, defaultCompanyName: null });
    try {
      // nobody answers an unknown number, no default client: the ticket goes to AKAB
      await hook({ from: "8195550301", message: "Mon imprimante", id: "u1" });
      const c1 = await conv("8195550301");
      expect(await autoTickets(new Date(Date.now() + 5 * 3_600_000))).toBeGreaterThanOrEqual(1);
      const t1 = (await tech.get(`/api/sms/conversations/${c1.id}`)).json;
      expect((await tech.get(`/api/tickets/${t1.ticketId}`)).json.company).toMatchObject({ id: 299, name: "AKAB Informatique" });

      // 1, then no answer to the question: it opens anyway after the delay (30 min), and the conversation ends
      await hook({ from: "8195550302", message: "Allo", id: "u2" });
      await hook({ from: "8195550302", message: "1", id: "u3" });
      const c2 = await conv("8195550302");
      expect(c2.status).toBe("details");
      expect(await autoTickets(new Date(Date.now() + 31 * 60_000))).toBe(1);
      const t2 = (await tech.get(`/api/sms/conversations/${c2.id}`)).json;
      expect(t2).toMatchObject({ status: "closed", ticketId: expect.any(Number) });

      // a technician opens the ticket of a number nobody knows: the client (and contact) first
      await hook({ from: "8195550303", message: "Besoin d'un technicien", id: "u4" });
      const c3 = await conv("8195550303");
      expect((await tech.post(`/api/sms/conversations/${c3.id}/ticket`, {})).json.error).toBe("sms_needs_client");
      expect((await tech.post(`/api/sms/conversations/${c3.id}/ticket`, { companyId: 99999 })).json.error).toBe("sms_unknown_client");
      expect((await tech.post(`/api/sms/conversations/${c3.id}/ticket`, { companyId: 302, contactId: "c-300-0" })).json.error).toBe("sms_unknown_contact");
      const made = await tech.post(`/api/sms/conversations/${c3.id}/ticket`, { companyId: 302, contactId: "c-302-0" });
      expect(made.status).toBe(201);
      const t3 = (await tech.get(`/api/tickets/${made.json.id}`)).json;
      expect(t3).toMatchObject({ company: { id: 302 }, contactId: "c-302-0" });
      // the conversation keeps who it is, and stays with the ticket (a technician opened it)
      expect((await tech.get(`/api/sms/conversations/${c3.id}`)).json).toMatchObject({ status: "ticket", companyId: 302, contactId: "c-302-0" });
    } finally {
      await saveSmsSettings(null, { defaultCompanyId: 301, defaultCompanyName: null });
    }
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
  /** Unread ids the next "unread messages" query returns (then none) */
  const unread: { id: string }[] = [];
  /** Ids the next "messages of the folder" query returns (then none) */
  const inFolder: { id: string }[] = [];
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
        // a mailbox the technician has no access to in Exchange (e.g. accounting)
        if (url.includes("users/compta@akab.local") && bearer === "Bearer user-tok") return json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403);
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
        // folder options
        if (url.includes("$filter=isRead eq false")) return json({ value: unread.splice(0) });
        if (url.includes("/messages?$select=id&$top=100")) return json({ value: inFolder.splice(0) });
        if (url.endsWith("/$batch") && method === "POST") return json({ responses: (init.body ? JSON.parse(String(init.body)).requests : []).map((r: any) => ({ id: r.id, status: 200 })) });
        if (url.endsWith("/mailFolders") && method === "POST") return json({ id: "new-folder", displayName: "Clients 2026" }, 201);
        if (/mailFolders\/[^/]+\/move$/.test(url) && method === "POST") return json({ id: "f2" }, 201);
        if (url.includes("/messages?") && method === "GET") {
          return json({
            value: [{ id: "m1", subject: "Imprimante", from: { emailAddress: { name: "Marie", address: "marie@client.example" } }, receivedDateTime: "2026-10-13T12:00:00Z", bodyPreview: "Bonjour", isRead: false, flag: { flagStatus: "notFlagged" }, hasAttachments: true, singleValueExtendedProperties: [{ id: "Integer 0x1081", value: "103" }, { id: "SystemTime 0x1082", value: "2026-10-13T13:00:00Z" }] }],
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
    // sealed (random ciphertext: checking for "r1" inside it would fail by chance)
    expect(conn.refreshToken).not.toBe("r1");
    expect(conn.refreshToken).toMatch(/^v1\./);
    // signing in linked their mailbox, through their own access
    status = (await tech.get("/api/outlook/status")).json;
    expect(status.signedIn).toMatchObject({ email: "tech@akab.local" });
    expect(status.accounts).toEqual([expect.objectContaining({ address: "tech@akab.local", via: "user" })]);
    const linked = { json: status.accounts[0] };
    expect((await tech.post("/api/outlook/accounts", { address: "tech@akab.local" })).json.error).toBe("outlook_already_linked");
    // signed in before shared mailboxes: one more sign-in is asked
    expect((await tech.post("/api/outlook/accounts", { address: "support@akab.local" })).json.error).toBe("outlook_reconnect_shared");
    await db().update(schema.msConnections).set({ scopes: "User.Read Mail.ReadWrite Mail.Send Mail.ReadWrite.Shared Mail.Send.Shared Calendars.ReadWrite offline_access" });
    // a mailbox shared with them: linked through their own access (Exchange checks it on every call)
    const sharedMine = await tech.post("/api/outlook/accounts", { address: "support@akab.local" });
    expect(sharedMine.json).toMatchObject({ via: "user", address: "support@akab.local" });
    sent.length = 0;
    await tech.get(`/api/outlook/accounts/${sharedMine.json.id}/folders`);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.bearer === "Bearer user-tok" && s.url.includes("users/support@akab.local/"))).toBe(true);
    // a mailbox they cannot open in Outlook (accounting, an admin) is refused, and noted
    expect((await tech.post("/api/outlook/accounts", { address: "compta@akab.local" })).json.error).toBe("outlook_no_access");
    expect((await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "outlook.link_refused"))).length).toBe(1);
    expect((await tech.del(`/api/outlook/accounts/${sharedMine.json.id}`)).status).toBe(200);
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
    expect(page.items[0]).toMatchObject({ id: "m1", subject: "Imprimante", isRead: false, from: { address: "marie@client.example" }, lastVerb: "replyAll", lastVerbAt: "2026-10-13T13:00:00Z" });
    expect(sent.some((s) => s.url.includes("$expand=singleValueExtendedProperties"))).toBe(true);
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

    // folder options: mark all read (patched by batches of 20), create, rename, delete — Outlook's own folders stay
    unread.push(...Array.from({ length: 25 }, (_, i) => ({ id: `u${i}` })));
    sent.length = 0;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/inbox-id/read`)).json).toEqual({ ok: true, marked: 25 });
    const batches = sent.filter((s) => s.url.endsWith("/$batch"));
    expect(batches.map((b) => b.body.requests.length)).toEqual([20, 5]);
    expect(batches[0].body.requests[0]).toMatchObject({ method: "PATCH", url: "/me/messages/u0", body: { isRead: true } });
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders`, { name: "Clients 2026" })).json).toMatchObject({ id: "new-folder", name: "Clients 2026" });
    expect((await tech.patch(`/api/outlook/accounts/${acc.id}/folders/f2`, { name: "Clients actifs" })).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ method: "PATCH", body: { displayName: "Clients actifs" } });
    expect((await tech.del(`/api/outlook/accounts/${acc.id}/folders/inbox-id`)).json.error).toBe("outlook_forbidden");
    expect((await tech.del(`/api/outlook/accounts/${acc.id}/folders/f2`)).status).toBe(200);

    // empty a folder: to Deleted Items; in Deleted Items, deleted
    inFolder.push({ id: "e1" }, { id: "e2" });
    sent.length = 0;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/f2/empty`)).json).toEqual({ ok: true, removed: 2 });
    expect(sent.find((s) => s.url.endsWith("/$batch"))!.body.requests[0]).toMatchObject({ method: "POST", url: "/me/messages/e1/move", body: { destinationId: "deleteditems" } });
    inFolder.push({ id: "e3" });
    sent.length = 0;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/deleteditems/empty`)).json).toEqual({ ok: true, removed: 1 });
    expect(sent.find((s) => s.url.endsWith("/$batch"))!.body.requests[0]).toMatchObject({ method: "DELETE", url: "/me/messages/e3" });

    // drag and drop: a folder inside another one, or back to the top; Outlook's own folders stay
    sent.length = 0;
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/f2/move`, { destination: "new-folder" })).json).toEqual({ ok: true, id: "f2" });
    expect(sent.at(-1)).toMatchObject({ method: "POST", body: { destinationId: "new-folder" } });
    await tech.post(`/api/outlook/accounts/${acc.id}/folders/f2/move`, { destination: "root" });
    expect(sent.at(-1)).toMatchObject({ body: { destinationId: "msgfolderroot" } });
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/inbox-id/move`, { destination: "f2" })).json.error).toBe("outlook_forbidden");
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/folders/f2/move`, { destination: "f2" })).json.error).toBe("outlook_forbidden");

    // the folder order is kept
    expect((await tech.put(`/api/outlook/accounts/${acc.id}/folder-prefs`, { pinned: [], hidden: [], order: ["f2", "inbox-id", "f2"] })).json.order).toEqual(["f2", "inbox-id"]);
  });

  it("sends and replies with files, cc/bcc and options; signature and address book; sending needs its right", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const acc = (await tech.get("/api/outlook/status")).json.accounts[0];
    sent.length = 0;
    const file = { name: "note.txt", contentType: "text/plain", data: Buffer.from("allo").toString("base64") };
    const html = '<p>Bonjour <b>Marie</b></p><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">lien</a>';
    expect(
      (
        await tech.post(`/api/outlook/accounts/${acc.id}/send`, {
          to: ["Marie@client.example"],
          cc: ["paul@client.example"],
          bcc: ["archive@akab.local"],
          subject: "Suivi",
          html,
          importance: "high",
          readReceipt: true,
          attachments: [file],
        })
      ).status,
    ).toBe(201);
    const mail = sent.find((s) => s.url.endsWith("/sendMail"))!;
    expect(mail.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail"); // as the technician
    expect(mail.body.message).toMatchObject({
      toRecipients: [{ emailAddress: { address: "marie@client.example" } }],
      ccRecipients: [{ emailAddress: { address: "paul@client.example" } }],
      bccRecipients: [{ emailAddress: { address: "archive@akab.local" } }],
      importance: "high",
      isReadReceiptRequested: true,
    });
    // formatting kept, anything active removed
    const content = mail.body.message.body.content as string;
    expect(content).toContain("<p>Bonjour <b>Marie</b></p>");
    expect(content).not.toMatch(/script|onerror|javascript:/i);
    expect(mail.body.message.attachments[0]).toMatchObject({ name: "note.txt", contentBytes: file.data });
    // everyone written to is in the address book, the most used first
    const contacts = (await tech.get("/api/outlook/contacts")).json;
    expect(contacts.map((x: any) => x.address).sort()).toEqual(["archive@akab.local", "marie@client.example", "paul@client.example"]);
    expect(contacts.every((x: any) => x.source === "sent" && x.timesUsed === 1)).toBe(true);

    const big = { name: "big.bin", contentType: "application/octet-stream", data: "A".repeat(4_200_000) };
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/send`, { to: ["marie@client.example"], attachments: [big] })).json.error).toBe("outlook_attachments_too_large");
    expect((await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/respond`, { mode: "forward", html: "voir" })).json.error).toBe("outlook_no_recipient");

    // a reply: the recipients, subject and options chosen in the window are set on Outlook's draft
    sent.length = 0;
    expect(
      (
        await tech.post(`/api/outlook/accounts/${acc.id}/messages/m1/respond`, {
          mode: "reply",
          to: ["marie@client.example"],
          bcc: ["boss@akab.local"],
          subject: "RE: Imprimante (réglé)",
          html: "<p>Merci</p>",
          attachments: [file],
        })
      ).status,
    ).toBe(201);
    expect(sent.map((s) => `${s.method} ${s.url.split("/messages/")[1]}`)).toEqual(["POST m1/createReply", "PATCH d1", "POST d1/attachments", "POST d1/send", "PATCH m1"]);
    // the original is marked as answered (Outlook's "You replied")
    expect(sent[4].body.singleValueExtendedProperties).toEqual([{ id: "Integer 0x1081", value: "102" }, { id: "SystemTime 0x1082", value: expect.any(String) }]);
    expect(sent[1].body).toMatchObject({
      toRecipients: [{ emailAddress: { address: "marie@client.example" } }],
      bccRecipients: [{ emailAddress: { address: "boss@akab.local" } }],
      subject: "RE: Imprimante (réglé)",
      importance: "normal",
    });
    expect(sent[1].body.body.content).toContain("<p>Merci</p>");
    const again = (await tech.get("/api/outlook/contacts?q=marie")).json;
    expect(again).toEqual([expect.objectContaining({ address: "marie@client.example", timesUsed: 2 })]);

    // the address book: added and named by hand, only for its owner
    const added = await tech.post("/api/outlook/contacts", { address: "Luc@Fournisseur.ca", name: "Luc Gagnon" });
    expect(added.status).toBe(201);
    expect((await tech.get("/api/outlook/contacts?q=gagnon")).json).toEqual([expect.objectContaining({ address: "luc@fournisseur.ca", name: "Luc Gagnon", source: "manual" })]);
    expect((await tech.patch(`/api/outlook/contacts/${added.json.id}`, { name: "Luc G." })).status).toBe(200);
    expect((await admin.patch(`/api/outlook/contacts/${added.json.id}`, { name: "x" })).status).toBe(404);
    expect((await admin.del(`/api/outlook/contacts/${added.json.id}`)).status).toBe(404);
    expect((await admin.get("/api/outlook/contacts")).json.some((x: any) => x.address === "luc@fournisseur.ca")).toBe(false);
    expect((await tech.del(`/api/outlook/contacts/${added.json.id}`)).status).toBe(200);
    expect((await tech.post("/api/outlook/contacts", { address: "pas-une-adresse" })).status).toBe(400);

    // the signature: sanitized, given to the compose window
    const sig = await tech.put("/api/outlook/signature", { html: '<p><b>Alex Tremblay</b><br>AKAB Informatique</p><img src="javascript:alert(1)"><iframe src="x"></iframe>' });
    expect(sig.json.html).toBe("<p><b>Alex Tremblay</b><br />AKAB Informatique</p>");
    expect((await tech.get("/api/outlook/status")).json.signature).toBe(sig.json.html);
    expect((await tech.put("/api/outlook/signature", { html: "<p> </p>" })).json.html).toBe("");

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
    // an unknown sender: no contact; a client's contact: the ticket opens for them
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/messages/m1/text`)).json.contact).toBeNull();
    const { demoContacts } = await import("../server/lib/demoTickets.ts");
    const { ticketSource } = await import("../server/lib/ticketSource.ts");
    const known = demoContacts(300)[0];
    expect(await (await ticketSource()).contactByEmail(known.email!.toUpperCase())).toMatchObject({ contactId: known.id, companyId: 300 });

    // the folder layout: favourites in order, hidden folders; the owner's only
    const prefs = { pinned: [{ id: "f2", name: "Clients" }, { id: "inbox-id", name: "Boîte de réception" }], hidden: ["junk-id", "junk-id"] };
    expect((await tech.put(`/api/outlook/accounts/${acc.id}/folder-prefs`, prefs)).json).toEqual({ pinned: prefs.pinned, hidden: ["junk-id"], order: [] });
    expect((await tech.get("/api/outlook/status")).json.accounts.find((x: any) => x.id === acc.id).folderPrefs).toEqual({ pinned: prefs.pinned, hidden: ["junk-id"], order: [] });
    resetRateLimit("login:ip:unknown");
    const other = await signIn("admin@akab.local");
    expect((await other.put(`/api/outlook/accounts/${acc.id}/folder-prefs`, prefs)).status).toBe(404);

    expect((await tech.del(`/api/outlook/accounts/${acc.id}`)).status).toBe(200);
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/folders`)).status).toBe(404);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const log = await db().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, u.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["outlook.linked", "outlook.sent", "outlook.reply", "outlook.to_ticket", "outlook.unlinked"]));
  });
});

describe("crm: the portal's own copy of the clients", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => {
    resetRateLimit("login:ip:unknown");
    return sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;
  };

  it("copies clients, contacts and contracts from the source, once per sync", async () => {
    const tech = await session("tech@akab.local");
    expect((await tech.get("/api/crm/status")).json).toMatchObject({ mode: "sample" });
    const list = (await tech.get("/api/crm/clients")).json;
    const clinique = list.find((c: any) => c.autotaskId === 300);
    expect(clinique).toMatchObject({ name: "Clinique dentaire Joliette", contacts: 3, active: true });
    expect(clinique.openTickets).toBeGreaterThan(0);
    // portal clients that are not in the source are kept as they are
    expect(list.find((c: any) => c.name === "Clinique Rawdon")).toMatchObject({ autotaskId: null });
    const status = (await tech.get("/api/crm/status")).json;
    expect(status).toMatchObject({ ok: true, counts: { contacts: expect.any(Number), contracts: expect.any(Number) } });
    expect(status.lastSync).toBeTruthy();

    // a technician may look, not sync or change
    expect((await tech.post("/api/crm/sync")).status).toBe(403);
    expect((await tech.patch(`/api/crm/clients/${clinique.id}`, { phone: "450-555-9999" })).status).toBe(403);
    const admin = await session("admin@akab.local");
    expect((await admin.post("/api/crm/sync")).json.ok).toBe(true);
    // a second sync adds nothing
    expect((await tech.get("/api/crm/clients")).json.length).toBe(list.length);

    expect((await tech.get(`/api/crm/clients/${clinique.id}/contracts`)).json[0]).toMatchObject({ isDefault: true, active: true });
    const tickets = (await tech.get(`/api/crm/clients/${clinique.id}/tickets`)).json;
    expect(tickets.items.length).toBeGreaterThan(0);
    expect(tickets.items.every((t: any) => t.company === "Clinique dentaire Joliette")).toBe(true);
  });

  it("parent companies, details, invoice settings and contacts", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const list = (await admin.get("/api/crm/clients")).json;
    const parent = list.find((c: any) => c.autotaskId === 301);
    const child = list.find((c: any) => c.autotaskId === 302);
    expect((await admin.patch(`/api/crm/clients/${child.id}`, { parentId: parent.id, notes: "Filiale" })).status).toBe(200);
    // no loop: the parent cannot become its child's child
    expect((await admin.patch(`/api/crm/clients/${parent.id}`, { parentId: child.id })).json.error).toBe("parent_loop");
    expect((await admin.patch(`/api/crm/clients/${parent.id}`, { parentId: parent.id })).json.error).toBe("parent_loop");
    const p = (await admin.get(`/api/crm/clients/${parent.id}`)).json;
    expect(p.children.map((x: any) => x.id)).toEqual([child.id]);
    const ch = (await admin.get(`/api/crm/clients/${child.id}`)).json;
    expect(ch).toMatchObject({ parent: { id: parent.id }, notes: "Filiale" });
    // the parent's tickets can include its child companies'
    const own = (await tech.get(`/api/crm/clients/${parent.id}/tickets`)).json.items.length;
    expect((await tech.get(`/api/crm/clients/${parent.id}/tickets?children=1`)).json.items.length).toBeGreaterThan(own);
    // a sync keeps portal-only fields
    await admin.post("/api/crm/sync");
    expect((await admin.get(`/api/crm/clients/${child.id}`)).json.notes).toBe("Filiale");
    // and the parent company chosen in the portal (sent to the source, so the sync keeps it)
    expect((await admin.get(`/api/crm/clients/${child.id}`)).json.parent).toMatchObject({ id: parent.id });
    expect((await admin.patch(`/api/crm/clients/${child.id}`, { name: parent.name })).json.error).toBe("company_exists");

    // invoice settings: their own right
    expect((await tech.get(`/api/crm/clients/${parent.id}`)).json.invoice).toBeNull();
    expect((await tech.put(`/api/crm/clients/${parent.id}/invoice`, { termsDays: 30 })).status).toBe(403);
    expect((await admin.put(`/api/crm/clients/${parent.id}/invoice`, { billingEmail: "compta@client.example", termsDays: 30, taxes: true, delivery: "email" })).status).toBe(200);
    expect((await admin.get(`/api/crm/clients/${parent.id}`)).json.invoice).toMatchObject({ billingEmail: "compta@client.example", termsDays: 30 });

    // contacts: added in the source and in the copy, deactivated
    const made = await admin.post(`/api/crm/clients/${parent.id}/contacts`, { firstName: "Hélène", lastName: "Dubé", email: "helene@client.example", mobile: "450-555-4444", title: "Directrice" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ firstName: "Hélène", mobile: "450-555-4444", active: true });
    expect((await tech.get("/api/tickets/companies/301/contacts")).json.some((x: any) => x.name === "Hélène Dubé")).toBe(true);
    expect((await admin.patch(`/api/crm/clients/${parent.id}/contacts/${made.json.id}`, { active: false })).json.active).toBe(false);
    expect((await admin.patch(`/api/crm/clients/${child.id}/contacts/${made.json.id}`, { active: true })).status).toBe(404);

    // a new client from the CRM
    const co = await admin.post("/api/crm/clients", { name: "Érablière du Nord", phone: "450-555-3030" });
    expect(co.status).toBe(201);
    expect(co.json.autotaskId).toEqual(expect.any(Number));
    expect((await admin.post("/api/crm/clients", { name: "érablière du nord", phone: "450-555-3030" })).json.error).toBe("company_exists");
    expect((await tech.post("/api/crm/clients", { name: "Autre", phone: "450-555-3030" })).status).toBe(403);
  });

  it("invoices of a client: due dates, paid or not (accounting right)", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const list = (await admin.get("/api/crm/clients")).json;
    const late = list.find((c: any) => c.autotaskId === 301);
    // money: not for technicians
    expect((await tech.get(`/api/crm/clients/${late.id}/invoices`)).status).toBe(403);
    const r = (await admin.get(`/api/crm/clients/${late.id}/invoices`)).json;
    // only the invoices from September 2026 on, numbered 10000 and up (Admin › Facturation)
    expect(r.items.length).toBe(2);
    expect(r.items.every((v: any) => v.issuedOn >= "2026-09-01" && Number(v.number) >= 10000)).toBe(true);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    for (const v of r.items) {
      const expected = v.paidOn ? "paid" : v.dueOn < today ? "overdue" : "due";
      if (v.status !== "voided") expect(v.status).toBe(expected);
    }
    const unpaid = r.items.filter((v: any) => v.status === "due" || v.status === "overdue");
    expect(r.summary.dueCents).toBe(unpaid.reduce((s: number, v: any) => s + v.totalCents, 0));
    expect(r.summary.overdueCount).toBe(r.items.filter((v: any) => v.status === "overdue").length);
    // newest first; a second sync adds nothing
    expect(r.items[0].issuedOn >= r.items[1].issuedOn).toBe(true);
    await admin.post("/api/crm/sync");
    expect((await admin.get(`/api/crm/clients/${late.id}/invoices`)).json.items.length).toBe(2);
    // a parent company can include its subsidiaries (302 was made a subsidiary of 301 above)
    expect((await admin.get(`/api/crm/clients/${late.id}/invoices?children=1`)).json.items.length).toBe(4);
  });
});

describe("billing: settings, chart of accounts, QuickBooks, Stripe, payments", () => {
  const sessions = new Map<string, Agent>();
  const session = async (email: string) => {
    resetRateLimit("login:ip:unknown");
    return sessions.get(email) ?? sessions.set(email, await signIn(email)).get(email)!;
  };
  afterAll(() => vi.unstubAllGlobals());

  it("numbering, taxes and the chart of accounts (admins only)", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    expect((await tech.get("/api/billing/settings")).status).toBe(403);
    expect((await admin.get("/api/billing/settings")).json).toMatchObject({ preview: "10000", taxes: { gstRate: 5, qstRate: 9.975 } });
    const s = await admin.put("/api/billing/settings", { numbering: { prefix: "AK-", next: 42, digits: 4 }, taxes: { gstNumber: "123456789 RT0001" } });
    expect(s.json).toMatchObject({ preview: "AK-0042", taxes: { gstNumber: "123456789 RT0001", qstRate: 9.975 } });
    expect((await admin.put("/api/billing/settings", { numbering: { prefix: "A B" } })).status).toBe(400);

    // a starter chart the first time, with the default accounts pointed at it
    const ledger = (await admin.get("/api/billing/ledger")).json;
    expect(ledger.find((x: any) => x.number === "1200")).toMatchObject({ type: "asset" });
    const settings = (await admin.get("/api/billing/settings")).json;
    expect(settings.accounts.receivable).toBe(ledger.find((x: any) => x.number === "1200").id);
    expect((await admin.post("/api/billing/ledger", { number: "1200", name: "Doublon", type: "asset" })).json.error).toBe("billing_account_exists");
    const added = await admin.post("/api/billing/ledger", { number: "4300", name: "Revenus — projets", type: "revenue" });
    expect(added.status).toBe(201);
    expect((await admin.patch(`/api/billing/ledger/${settings.accounts.receivable}`, { active: false })).json.error).toBe("billing_account_in_use");
    expect((await admin.patch(`/api/billing/ledger/${added.json.id}`, { active: false })).json.active).toBe(false);
    expect((await admin.put("/api/billing/settings", { accounts: { labour: crypto.randomUUID() } })).json.error).toBe("billing_unknown_account");
  });

  it("Stripe keys stay sealed; test and live are not mixed", async () => {
    const admin = await session("admin@akab.local");
    expect((await admin.put("/api/billing/stripe", { enabled: true })).json.error).toBe("stripe_incomplete");
    expect((await admin.put("/api/billing/stripe", { secretKey: "sk_test_abc123", publishableKey: "pk_live_xyz" })).json.error).toBe("stripe_mode_mismatch");
    const s = await admin.put("/api/billing/stripe", { secretKey: "sk_test_abc123", publishableKey: "pk_test_xyz", webhookSecret: "whsec_789", enabled: true });
    expect(s.json).toMatchObject({ enabled: true, hasSecretKey: true, hasWebhookSecret: true, mode: "test" });
    expect(JSON.stringify(s.json)).not.toContain("sk_test_abc123");
    const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "stripe"));
    expect(row.secret).not.toContain("sk_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit = {}) => {
        const ok = (init.headers as any).authorization === "Bearer sk_test_abc123";
        // the balance proves the key; the account says whose it is
        if (String(url) === "https://api.stripe.com/v1/account") return new Response(JSON.stringify({ id: "acct_1AKAB", country: "CA", business_profile: { name: "AKAB Informatique" } }), { status: ok ? 200 : 401 });
        expect(String(url)).toBe("https://api.stripe.com/v1/balance");
        return new Response(JSON.stringify({ object: "balance" }), { status: ok ? 200 : 401 });
      }),
    );
    expect((await admin.post("/api/billing/stripe/test")).json).toEqual({ ok: true, mode: "test", account: { id: "acct_1AKAB", name: "AKAB Informatique", country: "CA" } });
    // the account is kept with the last test, and the webhook address and events are given for Stripe's dashboard
    const view = (await admin.get("/api/billing/stripe")).json;
    expect(view.lastTest).toMatchObject({ ok: true, account: { id: "acct_1AKAB", name: "AKAB Informatique" } });
    expect(view.webhookUrl).toBe("http://localhost/api/stripe/hook");
    expect(view.events).toContain("checkout.session.completed");
    // a technician cannot see any of it
    const tech = await session("tech@akab.local");
    expect((await tech.get("/api/billing/stripe")).status).toBe(403);
    vi.unstubAllGlobals();
  });

  it("QuickBooks: connects with the Intuit sign-in, keeps the token sealed", async () => {
    const admin = await session("admin@akab.local");
    expect((await admin.post("/api/billing/quickbooks/connect")).json.error).toBe("quickbooks_incomplete");
    const q = await admin.put("/api/billing/quickbooks", { clientId: "ABqb", clientSecret: "qb-secret", environment: "sandbox" });
    expect(q.json).toMatchObject({ clientId: "ABqb", hasSecret: true, connected: false, redirectUri: "http://localhost/api/billing/quickbooks/callback" });
    const url = new URL((await admin.post("/api/billing/quickbooks/connect")).json.url);
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    const state = url.searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        const s = String(u);
        if (s.startsWith("https://oauth.platform.intuit.com/")) return new Response(JSON.stringify({ access_token: "qb-access", refresh_token: "qb-refresh-1" }), { status: 200 });
        if (s.includes("/v3/company/9130/companyinfo/9130")) return new Response(JSON.stringify({ CompanyInfo: { CompanyName: "AKAB Informatique inc." } }), { status: 200 });
        return new Response("{}", { status: 500 });
      }),
    );
    // someone else cannot use the answer
    const tech = await session("tech@akab.local");
    expect((await tech.get(`/api/billing/quickbooks/callback?state=${state}&code=c1&realmId=9130`)).status).toBe(403);
    const back = await admin.get(`/api/billing/quickbooks/callback?state=${state}&code=c1&realmId=9130`);
    expect(back.location).toBe("/?admin=integrations&integration=quickbooks&quickbooks=connected");
    expect((await admin.get(`/api/billing/quickbooks/callback?state=${state}&code=c1&realmId=9130`)).location).toContain("quickbooks=error");
    expect((await admin.get("/api/billing/quickbooks")).json).toMatchObject({ connected: true, realmId: "9130", companyName: "AKAB Informatique inc." });
    expect((await admin.post("/api/billing/quickbooks/test")).json).toMatchObject({ ok: true });
    const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "quickbooks"));
    expect(row.secret).not.toContain("qb-refresh");
    vi.unstubAllGlobals();
    expect((await admin.del("/api/billing/quickbooks/connection")).json).toMatchObject({ connected: false });
  });

  it("partial payments on an invoice", async () => {
    const tech = await session("tech@akab.local");
    const admin = await session("admin@akab.local");
    const client = (await admin.get("/api/crm/clients")).json.find((c: any) => c.autotaskId === 303);
    const inv = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((v: any) => v.status === "due" || v.status === "overdue");
    const half = Math.round(inv.totalCents / 2);
    const pay = { amountCents: half, paidOn: "2026-10-15", method: "cheque", reference: "Chèque 1043", note: "" };
    expect((await tech.post(`/api/crm/invoices/${inv.id}/payments`, pay)).status).toBe(403);
    expect((await admin.post(`/api/crm/invoices/${inv.id}/payments`, pay)).status).toBe(201);
    let v = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((x: any) => x.id === inv.id);
    expect(v).toMatchObject({ status: "partial", paidCents: half, balanceCents: inv.totalCents - half, payments: [{ amountCents: half, method: "cheque", reference: "Chèque 1043", source: "portal" }] });
    // never more than the balance
    expect((await admin.post(`/api/crm/invoices/${inv.id}/payments`, { ...pay, amountCents: inv.totalCents })).json.error).toBe("payment_too_much");
    expect((await admin.post(`/api/crm/invoices/${inv.id}/payments`, { ...pay, amountCents: inv.totalCents - half, method: "transfer" })).status).toBe(201);
    v = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((x: any) => x.id === inv.id);
    expect(v).toMatchObject({ status: "paid", balanceCents: 0, paidOn: "2026-10-15" });
    // a payment can be removed (the invoice is partly paid again)
    expect((await admin.del(`/api/crm/invoices/${inv.id}/payments/${v.payments[1].id}`)).status).toBe(200);
    expect((await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((x: any) => x.id === inv.id).status).toBe("partial");
  });
});

describe("client portal access for contacts", () => {
  it("none by default; given: an account to set up at first sign-in; removed: turned off", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const client = (await admin.get("/api/crm/clients")).json.find((c: any) => c.autotaskId === 304);
    const contacts = (await admin.get(`/api/crm/clients/${client.id}/contacts`)).json;
    expect(contacts.every((x: any) => x.portal === null)).toBe(true);
    const ct = contacts[0];
    // giving access is an admin right (it creates a sign-in)
    expect((await tech.put(`/api/crm/clients/${client.id}/contacts/${ct.id}/portal`, { enabled: true })).status).toBe(403);
    const r = await admin.put(`/api/crm/clients/${client.id}/contacts/${ct.id}/portal`, { enabled: true });
    expect(r.status).toBe(200);
    expect(r.json.enabled).toBe(true);
    const [u] = await db().select().from(schema.users).where(sql`lower(${schema.users.email}) = ${ct.email.toLowerCase()}`);
    expect(u).toMatchObject({ kind: "client", clientId: client.id, active: true, mustChangePassword: true });
    expect(u.passwordHash).toBeTruthy();
    const [link] = await db().select().from(schema.passwordTokens).where(eq(schema.passwordTokens.userId, u.id));
    expect(link).toBeTruthy(); // the welcome email's "choose your password" link
    expect((await admin.get(`/api/crm/clients/${client.id}/contacts`)).json.find((x: any) => x.id === ct.id).portal).toMatchObject({ pending: true, role: "client-user" });

    // no email, or an address already used by someone else: refused
    const noMail = await admin.post(`/api/crm/clients/${client.id}/contacts`, { firstName: "Sans", lastName: "Courriel" });
    expect((await admin.put(`/api/crm/clients/${client.id}/contacts/${noMail.json.id}/portal`, { enabled: true })).json.error).toBe("portal_no_email");
    const staffMail = await admin.post(`/api/crm/clients/${client.id}/contacts`, { firstName: "Faux", lastName: "Tech", email: "tech@akab.local" });
    expect((await admin.put(`/api/crm/clients/${client.id}/contacts/${staffMail.json.id}/portal`, { enabled: true })).json.error).toBe("email_taken");

    // removed: the account is off
    expect((await admin.put(`/api/crm/clients/${client.id}/contacts/${ct.id}/portal`, { enabled: false })).json.enabled).toBe(false);
    const [off] = await db().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(off.active).toBe(false);
    expect((await admin.get(`/api/crm/clients/${client.id}/contacts`)).json.find((x: any) => x.id === ct.id).portal).toBeNull();
  });
});

describe("QuickBooks through its API: customers, chart, items, invoices, payments", () => {
  const sent: { method: string; url: string; body: any }[] = [];
  let payments: any[] = [];
  let qbInvoices: any[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  beforeAll(async () => {
    const { saveQuickBooksSettings } = await import("../server/lib/billing.ts");
    await saveQuickBooksSettings(null, { clientId: "ABqb", clientSecret: "qb-secret", environment: "sandbox", realmId: "9130", refreshToken: "qb-refresh", connectedAt: new Date().toISOString(), enabled: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = decodeURIComponent(String(input));
        const method = init.method ?? "GET";
        if (url.startsWith("https://oauth.platform.intuit.com/")) return json({ access_token: "qb-access", refresh_token: "qb-refresh-2" });
        expect(url.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/9130/")).toBe(true);
        sent.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("select * from Customer")) {
          return json({
            QueryResponse: {
              Customer: [
                { Id: "58", DisplayName: "Clinique dentaire Joliette inc." },
                { Id: "59", DisplayName: "Transport Lanaudière" },
                { Id: "60", DisplayName: "Autre compagnie" },
              ],
            },
          });
        }
        if (url.includes("select * from Account")) {
          return json({
            QueryResponse: {
              Account: [
                { Id: "1", Name: "Accounts Receivable (A/R)", AcctNum: "1200", Classification: "Asset" },
                { Id: "2", Name: "Ventes de services", AcctNum: "4050", Classification: "Revenue" },
                { Id: "3", Name: "TPS à payer", Classification: "Liability" },
              ],
            },
          });
        }
        if (url.includes("select * from Item")) {
          return json({
            QueryResponse: {
              Item: [
                { Id: "10", Name: "Services", Type: "Category" },
                { Id: "11", Name: "Support TI", FullyQualifiedName: "Services:Support TI", Type: "Service", ParentRef: { value: "10" }, UnitPrice: 125 },
                { Id: "12", Name: "Disque SSD", FullyQualifiedName: "Services:Disque SSD", Sku: "MZ-V9P1T0", Type: "Inventory", ParentRef: { value: "10" }, UnitPrice: 189.99 },
              ],
            },
          });
        }
        if (url.includes("select * from TaxCode")) return json({ QueryResponse: { TaxCode: [{ Id: "5", Name: "TPS/TVQ QC - 9,975" }, { Id: "6", Name: "Exonéré" }] } });
        if (url.includes("select * from Invoice")) return json({ QueryResponse: qbInvoices.length ? { Invoice: qbInvoices } : {} });
        if (url.includes("select * from Vendor")) return json({ QueryResponse: { Vendor: [{ Id: "v1", DisplayName: "Distributeur TI" }, { Id: "v2", DisplayName: "Bureau en gros" }] } });
        if (url.includes("select * from Payment")) return json({ QueryResponse: { Payment: payments } });
        if (url.includes("/customer?") && method === "POST") return json({ Customer: { Id: "61", DisplayName: JSON.parse(String(init.body)).DisplayName } });
        if (url.includes("/invoice/500?")) return json({ Invoice: { Id: "500", SyncToken: "0" } });
        if (url.includes("/invoice?") && method === "POST") return json({ Invoice: { Id: "500" } });
        return json({ Fault: { Error: [{ Message: `unexpected ${method} ${url}` }] } }, 400);
      }),
    );
  });
  afterAll(() => vi.unstubAllGlobals());

  it("maps clients to customers without doubles, creates the missing ones", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const m = (await admin.get("/api/billing/quickbooks/mapping")).json;
    const clinique = m.clients.find((c: any) => c.name === "Clinique dentaire Joliette");
    // "inc." and accents do not stop the match
    expect(clinique).toMatchObject({ suggestion: "58", reason: "name", quickbooksId: null });
    // proposals are only applied once accepted: the admin keeps one, leaves the other
    const transport = m.clients.find((c: any) => c.name === "Transport Lanaudière");
    expect(transport.suggestion).toBe("59");
    expect((await admin.post("/api/billing/quickbooks/mapping/accept", { accept: [{ clientId: transport.id, quickbooksId: "59" }] })).json).toEqual({ mapped: 1, skipped: [] });
    let after = (await admin.get("/api/billing/quickbooks/mapping")).json.clients;
    expect(after.find((c: any) => c.name === "Transport Lanaudière").quickbooksId).toBe("59");
    expect(after.find((c: any) => c.name === "Clinique dentaire Joliette").quickbooksId).toBeNull();
    // accepting a customer already used by another client: skipped, not doubled
    expect((await admin.post("/api/billing/quickbooks/mapping/accept", { accept: [{ clientId: clinique.id, quickbooksId: "59" }] })).json.skipped).toEqual([clinique.id]);
    await admin.post("/api/billing/quickbooks/mapping/accept", { accept: [{ clientId: clinique.id, quickbooksId: "58" }] });
    after = (await admin.get("/api/billing/quickbooks/mapping")).json.clients;
    // a customer already used: refused for another client
    const other = after.find((c: any) => !c.quickbooksId);
    expect((await admin.put(`/api/billing/quickbooks/mapping/${other.id}`, { quickbooksId: "58" })).json.error).toBe("quickbooks_customer_taken");
    // a client missing in QuickBooks: created there and mapped
    const made = await admin.post(`/api/billing/quickbooks/mapping/${other.id}/create`);
    expect(made.status).toBe(201);
    expect(sent.find((s) => s.method === "POST" && s.url.includes("/customer?"))!.body.DisplayName).toBe(other.name);
    expect((await admin.get("/api/billing/quickbooks/mapping")).json.clients.find((c: any) => c.id === other.id).quickbooksId).toBe("61");
    // one with the same name as a QuickBooks customer is not created twice
    const clin = after.find((c: any) => c.name === "Clinique dentaire Joliette");
    await admin.put(`/api/billing/quickbooks/mapping/${clin.id}`, { quickbooksId: null });
    expect((await admin.post(`/api/billing/quickbooks/mapping/${clin.id}/create`)).json.error).toBe("quickbooks_customer_exists");
    await admin.put(`/api/billing/quickbooks/mapping/${clin.id}`, { quickbooksId: "58" });
  });

  it("brings in the QuickBooks invoices from the chosen number with their status; vendors are mapped by hand", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const line = { DetailType: "SalesItemLineDetail", Amount: 500, Description: "Soutien", SalesItemLineDetail: { Qty: 4, UnitPrice: 125, TaxCodeRef: { value: "5" } } };
    qbInvoices = [
      { Id: "900", DocNumber: "9999", TxnDate: "2026-08-30", CustomerRef: { value: "59" }, TotalAmt: 100, Balance: 100 },
      { Id: "901", DocNumber: "30001", TxnDate: "2026-09-02", DueDate: "2026-10-02", CustomerRef: { value: "59" }, TotalAmt: 500, Balance: 0, TxnTaxDetail: { TotalTax: 65 }, MetaData: { LastUpdatedTime: "2026-09-20T10:00:00Z" }, Line: [line] },
      { Id: "902", DocNumber: "30002", TxnDate: "2026-09-05", CustomerRef: { value: "58" }, TotalAmt: 300, Balance: 200, Line: [line] },
      { Id: "903", DocNumber: "30003", TxnDate: "2026-09-06", CustomerRef: { value: "58" }, TotalAmt: 0, Balance: 0, PrivateNote: "Voided" },
      { Id: "904", DocNumber: "30004", TxnDate: "2026-09-07", CustomerRef: { value: "60" }, TotalAmt: 50, Balance: 50 },
    ];
    expect((await tech.post("/api/billing/quickbooks/invoices/pull")).status).toBe(403);
    // below 10000: left out; a customer not mapped to a client: skipped
    expect((await admin.post("/api/billing/quickbooks/invoices/pull")).json).toMatchObject({ added: 3, updated: 0, unmapped: 1, total: 4 });
    const list = async () => (await admin.get("/api/crm/invoices?source=quickbooks")).json.items;
    let invoices = await list();
    const by = (n: string) => invoices.find((v: any) => v.number === n);
    expect(invoices.map((v: any) => v.number).sort()).toEqual(["30001", "30002", "30003"]);
    expect(by("30001")).toMatchObject({ status: "paid", totalCents: 50000, paidCents: 50000, balanceCents: 0, source: "quickbooks", issuedOn: "2026-09-02", dueOn: "2026-10-02" });
    expect(by("30002")).toMatchObject({ status: "partial", totalCents: 30000, paidCents: 10000, balanceCents: 20000 });
    expect(by("30003")).toMatchObject({ status: "voided" });
    // again: nothing doubled; the status follows QuickBooks (the rest was paid)
    qbInvoices[2] = { ...qbInvoices[2], Balance: 0 };
    expect((await admin.post("/api/billing/quickbooks/invoices/pull")).json).toMatchObject({ added: 0, updated: 3 });
    invoices = await list();
    expect(invoices).toHaveLength(3);
    expect(by("30002")).toMatchObject({ status: "paid", paidCents: 30000 });
    expect((await db().select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, by("30001").id)))).toHaveLength(1);
    expect(await db().select().from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, by("30002").id))).toHaveLength(1);
    // the number it starts from is a setting
    expect((await admin.put("/api/billing/quickbooks", { invoicesFromNumber: 30002 })).json.invoicesFromNumber).toBe(30002);
    expect((await admin.post("/api/billing/quickbooks/invoices/pull")).json.total).toBe(3);
    await admin.put("/api/billing/quickbooks", { invoicesFromNumber: 10000 });
    qbInvoices = [];

    // vendors: made here, mapped by hand to a QuickBooks vendor, never two on the same one
    expect((await tech.get("/api/admin/vendors")).status).toBe(403);
    const v1 = (await admin.post("/api/admin/vendors", { name: "Distributeur TI", email: "ventes@dist.test" })).json;
    const v2 = (await admin.post("/api/admin/vendors", { name: "Autre fournisseur" })).json;
    expect((await admin.get("/api/admin/vendors/quickbooks/list")).json.map((x: any) => x.id)).toEqual(["v2", "v1"]);
    expect((await admin.put(`/api/admin/vendors/${v1.id}/quickbooks`, { quickbooksId: "v1" })).json.quickbooksId).toBe("v1");
    expect((await admin.put(`/api/admin/vendors/${v2.id}/quickbooks`, { quickbooksId: "v1" })).json.error).toBe("quickbooks_vendor_taken");
    expect((await admin.put(`/api/admin/vendors/${v1.id}/quickbooks`, { quickbooksId: null })).json.quickbooksId).toBeNull();
    expect((await admin.patch(`/api/admin/vendors/${v2.id}`, { name: "Renommé" })).json.name).toBe("Renommé");
    expect((await admin.del(`/api/admin/vendors/${v2.id}`)).status).toBe(200);
    // nothing was copied from QuickBooks
    expect((await admin.get("/api/admin/vendors")).json.map((x: any) => x.name)).toEqual(["Distributeur TI"]);
  });

  it("syncs the chart of accounts and the categories only as reviewed and accepted", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const before = (await admin.get("/api/billing/ledger")).json;
    // proposals first: nothing changes yet
    const plan = (await admin.get("/api/billing/quickbooks/plan/accounts")).json;
    const by = (k: string) => plan.find((p: any) => p.key === k);
    // 1200 by its number (renamed like QuickBooks), "TPS à payer" by its name, 4050 only in QuickBooks
    expect(by("qb:1")).toMatchObject({ action: "link", reason: "number", local: { number: "1200" }, changes: { name: { from: "Comptes clients", to: "Accounts Receivable (A/R)" } } });
    expect(by("qb:3")).toMatchObject({ action: "link", reason: "name", local: { number: "2310" } });
    expect(by("qb:2")).toMatchObject({ action: "create", changes: { number: { to: "4050" } } });
    // only in the portal: to turn off, except the ones used by default
    const inv = before.find((a: any) => a.number === "1300");
    const bank = before.find((a: any) => a.number === "1000");
    expect(by(`local:${inv.id}`)).toMatchObject({ action: "deactivate" });
    expect(by(`local:${bank.id}`)).toMatchObject({ action: "deactivate", blocked: "in_use" });
    expect((await admin.get("/api/billing/ledger")).json).toEqual(before);

    // accepted: 1200, 4050, 1300 (not "TPS à payer"); a blocked one is ignored
    const r = (await admin.post("/api/billing/quickbooks/plan/accounts", { accept: ["qb:1", "qb:2", `local:${inv.id}`, `local:${bank.id}`] })).json;
    expect(r).toEqual({ linked: 1, updated: 0, created: 1, deactivated: 1 });
    const ledger = (await admin.get("/api/billing/ledger")).json;
    expect(ledger.length).toBe(before.length + 1);
    expect(ledger.find((a: any) => a.number === "1200")).toMatchObject({ quickbooksId: "1", name: "Accounts Receivable (A/R)" });
    expect(ledger.find((a: any) => a.number === "4050")).toMatchObject({ type: "revenue", quickbooksId: "2" });
    expect(ledger.find((a: any) => a.number === "1300").active).toBe(false);
    expect(ledger.find((a: any) => a.number === "1000").active).toBe(true);
    expect(ledger.find((a: any) => a.number === "2310").quickbooksId).toBeNull();
    // the next proposals: done ones are "same", the one left still proposed — never a double
    const again = (await admin.get("/api/billing/quickbooks/plan/accounts")).json;
    expect(again.find((p: any) => p.key === "qb:1").action).toBe("same");
    expect(again.find((p: any) => p.key === "qb:2").action).toBe("same");
    expect(again.find((p: any) => p.key === "qb:3").action).toBe("link");
    await admin.post("/api/billing/quickbooks/plan/accounts", { accept: ["qb:3"] });
    expect((await admin.get("/api/billing/ledger")).json.length).toBe(before.length + 1);

    // categories and products: an inventory product with the same SKU gets QuickBooks' category once accepted
    const [prod] = await db().insert(schema.storeProducts).values({ sku: "mz-v9p1t0", name: "SSD 1 To" }).returning();
    const items = (await admin.get("/api/billing/quickbooks/plan/items")).json;
    expect(items.categories).toEqual([{ id: "10", name: "Services", isNew: true, products: 2 }]);
    expect(items.products).toEqual([expect.objectContaining({ key: `product:${prod.id}`, action: "link", changes: { link: { from: null, to: "12" }, category: { from: null, to: "Services" } } })]);
    expect((await admin.post("/api/billing/quickbooks/plan/items", { accept: [] })).json).toMatchObject({ items: 2, categories: 1, products: 0 });
    expect((await db().select().from(schema.storeProducts).where(eq(schema.storeProducts.id, prod.id)))[0].quickbooksItemId).toBeNull();
    expect((await admin.post("/api/billing/quickbooks/plan/items", { accept: [`product:${prod.id}`] })).json.products).toBe(1);
    expect((await db().select().from(schema.storeProducts).where(eq(schema.storeProducts.id, prod.id)))[0]).toMatchObject({ quickbooksItemId: "12", category: "Services" });
    // copied by their QuickBooks id: never twice
    expect((await db().select().from(schema.quickbooksItems)).length).toBe(3);
    const d = (await admin.get("/api/billing/quickbooks/invoice-defaults")).json;
    expect(d.items.map((i: any) => i.id).sort()).toEqual(["11", "12"]);
    expect(d.taxCodes).toHaveLength(2);
    expect((await admin.put("/api/billing/quickbooks/invoice-defaults", { itemId: "11", taxCodeId: "5", exemptTaxCodeId: "6" })).json).toMatchObject({ itemId: "11", taxCodeId: "5" });
  });

  it("sends an invoice by hand, and brings back its payment from QuickBooks", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const client = (await admin.get("/api/crm/clients")).json.find((c: any) => c.name === "Clinique dentaire Joliette");
    const inv = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((v: any) => v.status === "due" || v.status === "overdue");
    expect((await tech.post(`/api/crm/invoices/${inv.id}/quickbooks`)).status).toBe(403);
    sent.length = 0;
    expect((await admin.post(`/api/crm/invoices/${inv.id}/quickbooks`)).json).toEqual({ quickbooksId: "500" });
    const body = sent.find((s) => s.method === "POST" && s.url.includes("/invoice?"))!.body;
    expect(body).toMatchObject({ DocNumber: inv.number, CustomerRef: { value: "58" }, TxnDate: inv.issuedOn });
    expect(body.Line[0]).toMatchObject({ Amount: (inv.totalCents - inv.taxCents) / 100, SalesItemLineDetail: { ItemRef: { value: "11" }, TaxCodeRef: { value: "5" } } });
    let v = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((x: any) => x.id === inv.id);
    expect(v.quickbooks).toMatchObject({ id: "500", error: null });
    // sent again: the same QuickBooks invoice is changed, not doubled
    sent.length = 0;
    await admin.post(`/api/crm/invoices/${inv.id}/quickbooks`);
    expect(sent.find((s) => s.method === "POST" && s.url.includes("/invoice?"))!.body).toMatchObject({ Id: "500", SyncToken: "0", sparse: true });

    // a client not mapped: a clear error, kept on the invoice
    const unmapped = (await admin.get("/api/billing/quickbooks/mapping")).json.clients.find((c: any) => !c.quickbooksId);
    const inv2 = (await admin.get(`/api/crm/clients/${unmapped.id}/invoices`)).json.items.find((x: any) => x.status !== "voided");
    if (inv2) {
      expect((await admin.post(`/api/crm/invoices/${inv2.id}/quickbooks`)).json.error).toBe("quickbooks_not_mapped");
      expect((await admin.get(`/api/crm/clients/${unmapped.id}/invoices`)).json.items.find((x: any) => x.id === inv2.id).quickbooks.error).toContain("not_mapped");
    }

    // part paid in QuickBooks: comes back on the invoice, once
    payments = [{ Id: "900", TxnDate: "2026-10-16", PaymentRefNum: "1055", PaymentMethodRef: { name: "Chèque" }, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "500", TxnType: "Invoice" }] }] }];
    expect((await admin.post("/api/billing/quickbooks/payments/pull")).json).toMatchObject({ added: 1, updated: 0 });
    expect((await admin.post("/api/billing/quickbooks/payments/pull")).json).toMatchObject({ added: 0, updated: 0 });
    v = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((x: any) => x.id === inv.id);
    expect(v).toMatchObject({ status: "partial", paidCents: 10000 });
    expect(v.payments[0]).toMatchObject({ source: "quickbooks", method: "cheque", reference: "1055", paidOn: "2026-10-16" });
    // a payment from QuickBooks cannot be removed in the portal
    expect((await admin.del(`/api/crm/invoices/${inv.id}/payments/${v.payments[0].id}`)).status).toBe(404);
    // changed in QuickBooks: changed here
    payments[0].Line[0].Amount = 150;
    expect((await admin.post("/api/billing/quickbooks/payments/pull")).json).toMatchObject({ added: 0, updated: 1 });
  });
});

describe("work to bill: copied from Autotask, approved, posted as invoices", () => {
  it("copies labour, charges, expenses, contracts and milestones not posted yet; approves; posts one invoice per client", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/billables")).status).toBe(403);
    // numbers like the Autotask ones (an earlier test set a prefix)
    await admin.put("/api/billing/settings", { numbering: { prefix: "", next: 10000, digits: 5 } });
    const s = (await admin.post("/api/billables/import")).json;
    expect(s.counts).toMatchObject({ labour: expect.any(Number), charge: expect.any(Number), expense: expect.any(Number), contract: expect.any(Number), milestone: expect.any(Number) });
    expect(s.errors).toEqual({});
    // copied once: a second import adds nothing
    const before = (await admin.get("/api/billables")).json.length;
    await admin.post("/api/billables/import");
    expect((await admin.get("/api/billables")).json.length).toBe(before);

    const clients = (await admin.get("/api/crm/clients")).json;
    const clinique = clients.find((c: any) => c.autotaskId === 300);
    const mine = (await admin.get("/api/billables")).json.filter((i: any) => i.clientId === clinique.id);
    expect(new Set(mine.map((i: any) => i.kind))).toEqual(new Set(["labour", "charge", "expense", "contract", "milestone"]));
    // labour with no rate in the source: the usual rate (115 $/h)
    const labour = mine.find((i: any) => i.kind === "labour");
    expect(labour).toMatchObject({ status: "pending", unitPriceCents: 11500, amountCents: Math.round((labour.quantityX100 * 11500) / 100) });

    // a change made here survives the next import
    expect((await tech.patch(`/api/billables/${labour.id}`, { quantity: 1 })).status).toBe(403);
    expect((await admin.patch(`/api/billables/${labour.id}`, { quantity: 1.25, description: "Diagnostic imprimante" })).json).toMatchObject({ quantityX100: 125, amountCents: 14375, edited: true });
    await admin.post("/api/billables/import");
    expect((await admin.get("/api/billables?kind=labour")).json.find((i: any) => i.id === labour.id)).toMatchObject({ quantityX100: 125, description: "Diagnostic imprimante" });

    // approve all of this client except the expense (excluded: not billed)
    const expense = mine.find((i: any) => i.kind === "expense");
    expect((await admin.post("/api/billables/status", { ids: mine.filter((i: any) => i.id !== expense.id).map((i: any) => i.id), status: "approved" })).json.changed).toBe(mine.length - 1);
    // excluded as "already billed" (e.g. in Autotask): it says so, and an import neither brings it back nor drops it
    expect((await admin.post("/api/billables/status", { ids: [expense.id], status: "excluded", reason: "billed" })).json.changed).toBe(1);
    expect((await tech.post("/api/billables/status", { ids: [expense.id], status: "excluded", reason: "billed" })).status).toBe(403);
    await admin.post("/api/billables/import");
    expect((await admin.get("/api/billables?status=excluded")).json.find((i: any) => i.id === expense.id)).toMatchObject({ status: "excluded", excludedReason: "billed" });

    const preview = (await admin.get("/api/billables/post")).json;
    const g = preview.find((x: any) => x.client.id === clinique.id);
    const approved = mine.filter((i: any) => i.id !== expense.id);
    const subtotal = (await admin.get("/api/billables?status=approved")).json.filter((i: any) => i.clientId === clinique.id).reduce((x: number, i: any) => x + i.amountCents, 0);
    expect(g).toMatchObject({ count: approved.length, subtotalCents: subtotal, gstCents: Math.round(subtotal * 0.05), qstCents: Math.round(subtotal * 0.09975) });

    // posted: one invoice, its lines, the next number after the Autotask ones
    const numbers = (await admin.get(`/api/crm/clients/${clinique.id}/invoices`)).json.items.map((v: any) => Number(v.number));
    const made = (await admin.post("/api/billables/post", { clientIds: [clinique.id] })).json;
    expect(made).toHaveLength(1);
    expect(Number(made[0].number)).toBeGreaterThan(Math.max(...numbers));
    const inv = (await admin.get(`/api/crm/clients/${clinique.id}/invoices`)).json.items.find((v: any) => v.id === made[0].id);
    expect(inv).toMatchObject({ source: "portal", totalCents: g.totalCents, taxCents: g.gstCents + g.qstCents, status: "due" });
    expect(inv.lines).toHaveLength(approved.length);
    expect(inv.lines.find((l: any) => l.kind === "labour" && l.description.includes("Diagnostic imprimante"))).toMatchObject({ quantity: 1.25, amountCents: 14375 });
    // the items are posted (and stay so through the next import); a posted item cannot be changed
    const after = (await admin.get("/api/billables")).json.filter((i: any) => i.clientId === clinique.id);
    expect(after.filter((i: any) => i.status === "posted").every((i: any) => i.invoiceNumber === made[0].number)).toBe(true);
    await admin.post("/api/billables/import");
    expect((await admin.get("/api/billables?status=posted")).json.filter((i: any) => i.clientId === clinique.id)).toHaveLength(approved.length);
    expect((await admin.patch(`/api/billables/${labour.id}`, { quantity: 9 })).json.error).toBe("billing_item_posted");
    // nothing left to post for this client; the next posting takes the next number
    expect((await admin.get("/api/billables/post")).json.find((x: any) => x.client.id === clinique.id)).toBeUndefined();
    const other = (await admin.get("/api/billables?status=pending")).json.find((i: any) => i.clientId !== clinique.id);
    await admin.post("/api/billables/status", { ids: [other.id], status: "approved" });
    const second = (await admin.post("/api/billables/post", {})).json;
    expect(Number(second[0].number)).toBe(Number(made[0].number) + 1);
  });
});

describe("billing rules and the invoice editor", () => {
  it("approves automatically by client (kinds) or by contract; makes an invoice from chosen kinds with dates, terms, PO and notes", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    await admin.post("/api/billables/import");
    const clients = (await admin.get("/api/crm/clients")).json;
    const garage = clients.find((c: any) => c.autotaskId === 306);
    const items = () => admin.get(`/api/billables?clientId=${garage.id}`).then((r) => r.json);
    expect((await items()).every((i: any) => i.status === "pending")).toBe(true);

    // per contract: everything under it, right away (what waits already, and what comes next)
    const contracts = (await admin.get(`/api/crm/clients/${garage.id}/contracts`)).json;
    const managed = contracts.find((k: any) => k.isDefault);
    expect((await tech.patch(`/api/crm/clients/${garage.id}/contracts/${managed.id}`, { autoApprove: true })).status).toBe(403);
    expect((await admin.patch(`/api/crm/clients/${garage.id}/contracts/${managed.id}`, { autoApprove: true })).json).toMatchObject({ autoApprove: true, approved: 1 });
    let all = await items();
    expect(all.find((i: any) => i.kind === "contract")).toMatchObject({ status: "approved", autoApproved: true });
    expect(all.find((i: any) => i.kind === "labour").status).toBe("pending");

    // per client: the labour
    const inv = (await admin.get(`/api/crm/clients/${garage.id}`)).json.invoice;
    await admin.put(`/api/crm/clients/${garage.id}/invoice`, { ...inv, termsDays: 15, autoApprove: ["labour"] });
    all = await items();
    expect(all.filter((i: any) => i.kind === "labour").every((i: any) => i.status === "approved")).toBe(true);
    expect(all.find((i: any) => i.kind === "charge").status).toBe("pending");
    // new imports follow the rules too
    await db().delete(schema.billingItems).where(eq(schema.billingItems.clientId, garage.id));
    await admin.post("/api/billables/import");
    all = await items();
    expect(all.filter((i: any) => i.kind === "labour" || i.kind === "contract").every((i: any) => i.status === "approved")).toBe(true);
    expect(all.find((i: any) => i.kind === "charge").status).toBe("pending");

    // the editor: what can be invoiced, by kind
    const ready = (await admin.get("/api/billables/clients")).json.find((g: any) => g.client.id === garage.id);
    expect(ready.kinds.map((k: any) => k.kind).sort()).toEqual(["contract", "labour"]);
    // a preview of only the labour: client terms (15 days), a due date, a PO, notes; nothing saved
    const pv = (await admin.post("/api/billables/invoice/preview", { clientId: garage.id, kinds: ["labour"], issuedOn: "2026-10-20", poNumber: "PO-778", notes: "Merci !" })).json;
    const labour = all.filter((i: any) => i.kind === "labour");
    expect(pv).toMatchObject({ issuedOn: "2026-10-20", dueOn: "2026-11-04", termsDays: 15, poNumber: "PO-778", notes: "Merci !", subtotalCents: labour.reduce((x: number, i: any) => x + i.amountCents, 0) });
    expect(pv.lines).toHaveLength(labour.length);
    expect((await items()).filter((i: any) => i.status === "posted")).toHaveLength(0);
    // an exact due date instead of terms; an item of another client or not approved: refused
    expect((await admin.post("/api/billables/invoice/preview", { clientId: garage.id, kinds: ["labour"], issuedOn: "2026-10-20", dueOn: "2026-12-01" })).json).toMatchObject({ dueOn: "2026-12-01", termsDays: null });
    const charge = all.find((i: any) => i.kind === "charge");
    expect((await admin.post("/api/billables/invoice/preview", { clientId: garage.id, itemIds: [charge.id] })).json.error).toBe("billing_items_invalid");
    expect((await admin.post("/api/billables/invoice/preview", { clientId: garage.id, kinds: ["milestone"] })).json.error).toBe("billing_nothing");

    // made: only the labour; the contract waits for another invoice
    expect((await tech.post("/api/billables/invoice", { clientId: garage.id, kinds: ["labour"] })).status).toBe(403);
    const made = (await admin.post("/api/billables/invoice", { clientId: garage.id, kinds: ["labour"], issuedOn: "2026-10-20", poNumber: "PO-778", notes: "Merci !" })).json;
    expect(made.number).toBe(pv.number);
    const invoice = (await admin.get(`/api/crm/clients/${garage.id}/invoices`)).json.items.find((v: any) => v.id === made.id);
    expect(invoice).toMatchObject({ source: "portal", issuedOn: "2026-10-20", dueOn: "2026-11-04", poNumber: "PO-778", notes: "Merci !" });
    expect(invoice.lines).toHaveLength(labour.length);
    const after = await items();
    expect(after.filter((i: any) => i.kind === "labour").every((i: any) => i.status === "posted")).toBe(true);
    expect(after.find((i: any) => i.kind === "contract").status).toBe("approved");
    expect((await admin.get("/api/billables/clients")).json.find((g: any) => g.client.id === garage.id).kinds.map((k: any) => k.kind)).toEqual(["contract"]);

    // a time frame: only the work of those days is listed, counted and invoiced
    const item = (date: string, cents: number) => ({
      clientId: garage.id,
      kind: "charge",
      source: "portal",
      sourceId: `test:period:${date}`,
      date,
      description: `Pièce du ${date}`,
      quantityX100: 100,
      unitPriceCents: cents,
      amountCents: cents,
      status: "approved",
      approvedAt: new Date(),
    });
    const [sep, oct] = await db().insert(schema.billingItems).values([item("2026-09-15", 1000), item("2026-10-05", 2500)]).returning();
    const october = "from=2026-10-01&to=2026-10-31";
    const listed = (await admin.get(`/api/billables?clientId=${garage.id}&kind=charge&status=approved&${october}`)).json.map((i: any) => i.id);
    expect(listed).toContain(oct.id);
    expect(listed).not.toContain(sep.id);
    const readyOct = (await admin.get(`/api/billables/clients?${october}`)).json.find((g: any) => g.client.id === garage.id);
    expect(readyOct.kinds.find((k: any) => k.kind === "charge")).toMatchObject({ count: 1, cents: 2500 });
    expect((await admin.get(`/api/billables/summary?${october}`)).status).toBe(200);
    expect((await admin.get("/api/billables?from=2026-10-31&to=2026-10-01")).json.error).toBe("invalid_period");
    expect((await admin.get("/api/billables?from=octobre")).status).toBe(400);
    // an item outside the time frame cannot go on its invoice
    expect((await admin.post("/api/billables/invoice/preview", { clientId: garage.id, itemIds: [sep.id], from: "2026-10-01", to: "2026-10-31" })).json.error).toBe("billing_items_invalid");
    // posting the month: the September item waits
    await admin.post("/api/billables/post", { clientIds: [garage.id], from: "2026-10-01", to: "2026-10-31" });
    const [sepAfter] = await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, sep.id));
    const [octAfter] = await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, oct.id));
    expect([sepAfter.status, octAfter.status]).toEqual(["approved", "posted"]);

    // every invoice, filtered: status, client, dates, number or PO, sent by email, QuickBooks
    const [paidInv, lateInv] = await db()
      .insert(schema.clientInvoices)
      .values([
        { clientId: garage.id, number: "T-9001", issuedOn: "2026-08-01", dueOn: "2026-08-31", totalCents: 10000, paidOn: "2026-08-15", emailedAt: new Date(), quickbooksId: "qb-t-9001", source: "portal" },
        { clientId: garage.id, number: "T-9002", issuedOn: "2026-10-02", dueOn: "2026-10-03", totalCents: 5000, poNumber: "PO-ABC", source: "portal" },
      ])
      .returning();
    const find = (qs: string) => admin.get(`/api/crm/invoices?clientId=${garage.id}&q=T-900&${qs}`).then((r) => r.json.items.map((x: any) => x.number).sort());
    expect(await find("")).toEqual(["T-9001", "T-9002"]);
    expect(await find("status=paid")).toEqual(["T-9001"]);
    expect(await find("status=overdue")).toEqual(["T-9002"]);
    expect(await find("status=open")).toEqual(["T-9002"]);
    expect(await find("emailed=yes")).toEqual(["T-9001"]);
    expect(await find("emailed=no")).toEqual(["T-9002"]);
    expect(await find("quickbooks=synced")).toEqual(["T-9001"]);
    expect(await find("quickbooks=unsynced")).toEqual(["T-9002"]);
    expect(await find("from=2026-10-01&to=2026-10-31")).toEqual(["T-9002"]);
    expect((await admin.get(`/api/crm/invoices?q=po-abc`)).json.items.map((x: any) => x.id)).toEqual([lateInv.id]);
    // % is a character, not "anything"
    expect((await admin.get(`/api/crm/invoices?q=${encodeURIComponent("%")}`)).json.items).toEqual([]);
    expect((await admin.get("/api/crm/invoices?status=lost")).status).toBe(400);
    const one = (await admin.get(`/api/crm/invoices?clientId=${garage.id}&q=T-9002`)).json;
    expect(one.summary).toMatchObject({ count: 1, dueCents: 5000, overdueCount: 1 });
    expect(one.items[0]).toMatchObject({ clientId: garage.id, company: garage.name, status: "overdue", emailedAt: null });
    expect(one.clients.some((x: any) => x.id === garage.id)).toBe(true);
    // marked sent by email (accounting.manage)
    expect((await tech.get("/api/crm/invoices")).status).toBe(403);
    expect((await tech.post(`/api/crm/invoices/${lateInv.id}/emailed`, { emailed: true })).status).toBe(403);
    expect((await admin.post(`/api/crm/invoices/${lateInv.id}/emailed`, { emailed: true })).json.emailedAt).toBeTruthy();
    expect(await find("emailed=yes")).toEqual(["T-9001", "T-9002"]);
    await admin.post(`/api/crm/invoices/${paidInv.id}/emailed`, { emailed: false });
    expect(await find("emailed=no")).toEqual(["T-9001"]);
  });
});

describe("timesheets and expenses, approved and sent to QuickBooks", () => {
  const sent: { url: string; body: any }[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const { saveQuickBooksSettings } = await import("../server/lib/billing.ts");
    await saveQuickBooksSettings(null, { enabled: false });
  });

  it("ticket time lands on the timesheet; other hours by hand; the approver sees totals only", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    // types: the built-in ticket time and the others; set in Admin
    const types = (await tech.get("/api/time/types")).json;
    const labour = types.time.find((x: any) => x.kind === "labour");
    const training = types.time.find((x: any) => x.name === "Formation");
    expect(labour && training).toBeTruthy();
    expect(types.expense.find((x: any) => x.name === "Kilométrage")).toMatchObject({ unit: "km", unitPriceCents: 68 });
    expect((await tech.get("/api/time/admin/types")).status).toBe(403);
    expect((await admin.post("/api/time/admin/timesheet-types", { name: "Garde" })).status).toBe(201);
    expect((await admin.patch(`/api/time/admin/timesheet-types/${labour.id}`, { active: false })).json.error).toBe("time_type_builtin");

    // a timer validated on a ticket: on the timesheet, with the ticket
    const tk = (await tech.get("/api/tickets?view=all")).json.items[5];
    await tech.post(`/api/tickets/${tk.id}/timer/start`);
    await tech.post(`/api/tickets/${tk.id}/timer/stop`);
    const timer = (await tech.get("/api/tickets/timers")).json.find((x: any) => x.ticketId === tk.id);
    expect((await tech.post(`/api/tickets/timers/${timer.id}/submit`, { hours: 1.5, summary: "Remplacement du disque" })).status).toBe(201);
    let week = (await tech.get("/api/time/week")).json;
    expect(week.entries.find((e: any) => e.ticketId === tk.id)).toMatchObject({ source: "ticket", kind: "labour", hours: 1.5, ticketNumber: tk.number, ticketTitle: tk.title });
    // hours by hand: not as ticket time
    expect((await tech.post("/api/time/entries", { date: week.weekStart, typeId: labour.id, hours: 2 })).json.error).toBe("time_type_unknown");
    expect((await tech.post("/api/time/entries", { date: week.weekStart, typeId: training.id, hours: 2, note: "Cours Intune" })).status).toBe(201);
    week = (await tech.get("/api/time/week")).json;
    expect(week.types.find((x: any) => x.kind === "labour").hours).toBeGreaterThanOrEqual(1.5);
    expect(week.types.find((x: any) => x.type === "Formation").hours).toBe(2);

    // submitted: locked
    expect((await tech.post("/api/time/week/submit", { weekStart: week.weekStart })).json.status).toBe("submitted");
    expect((await tech.post("/api/time/entries", { date: week.weekStart, typeId: training.id, hours: 1 })).json.error).toBe("timesheet_locked");

    // the approver: hours per type only, no ticket nor note
    expect((await tech.get("/api/time/approvals/timesheets")).status).toBe(403);
    const list = (await admin.get("/api/time/approvals/timesheets")).json;
    const mine = list.find((x: any) => x.userName === "Alex Tremblay" && x.weekStart === week.weekStart);
    expect(mine).toMatchObject({ status: "submitted", labourHours: week.labourHours, totalHours: week.totalHours });
    expect(mine.types.map((x: any) => x.type)).toEqual(expect.arrayContaining(["Formation"]));
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain(tk.number);
    expect(raw).not.toContain("Cours Intune");
    expect(raw).not.toContain("Remplacement du disque");
    globalThis.__sheet = mine.id;
  });

  it("favourite expenses: kept per person, priced like an expense, one click to reuse", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const other = await signIn("tech2@akab.local");
    const types = (await tech.get("/api/time/types")).json.expense;
    const km = types.find((x: any) => x.name === "Kilométrage");
    const parking = types.find((x: any) => x.name === "Stationnement");
    const trip = await tech.post("/api/time/expense-favorites", { name: "Joliette", typeId: km.id, description: "Aller-retour Joliette", quantity: 42 });
    expect(trip.status).toBe(201);
    expect(trip.json).toMatchObject({ quantityX100: 4200, amountCents: null, billable: false });
    const park = (await tech.post("/api/time/expense-favorites", { name: "Stationnement", typeId: parking.id, description: "Centre-ville", amountCents: 1200, quantity: 3 })).json;
    expect(park).toMatchObject({ quantityX100: null, amountCents: 1200 });
    // a quantity by unit and an amount otherwise, as for an expense
    expect((await tech.post("/api/time/expense-favorites", { name: "Vide", typeId: km.id })).status).toBe(400);
    expect((await tech.post("/api/time/expense-favorites", { name: "", typeId: parking.id, amountCents: 100 })).status).toBe(400);
    const mine = (await tech.get("/api/time/expense-favorites")).json;
    expect(mine.map((x: any) => x.name)).toEqual(["Joliette", "Stationnement"]);
    expect(mine[0]).toMatchObject({ type: "Kilométrage", description: "Aller-retour Joliette" });
    // only its owner sees or removes it
    expect((await other.get("/api/time/expense-favorites")).json).toEqual([]);
    expect((await other.del(`/api/time/expense-favorites/${park.id}`)).status).toBe(404);
    expect((await tech.del(`/api/time/expense-favorites/${park.id}`)).status).toBe(200);
    expect((await tech.del(`/api/time/expense-favorites/${trip.json.id}`)).status).toBe(200);
    expect((await tech.get("/api/time/expense-favorites")).json).toEqual([]);
  });

  it("trips (mileage): where from and to, shown in kilometres, never in money", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const types = (await tech.get("/api/time/types")).json.expense;
    const km = types.find((x: any) => x.name === "Kilométrage");
    const parking = types.find((x: any) => x.name === "Stationnement");
    const report = (await tech.post("/api/time/expense-reports", { title: "Déplacements", periodStart: "2026-10-01", periodEnd: "2026-10-31" })).json;
    const trip = { reportId: report.id, date: "2026-10-12", typeId: km.id, quantity: 42 };
    // both places are needed
    expect((await tech.post("/api/time/expenses", { ...trip, fromPlace: "Bureau" })).json.error).toBe("mileage_places_required");
    const ok = await tech.post("/api/time/expenses", { ...trip, fromPlace: " Bureau ", toPlace: "Joliette" });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ fromPlace: "Bureau", toPlace: "Joliette", description: "Bureau → Joliette", quantityX100: 4200 });
    await tech.post("/api/time/expenses", { reportId: report.id, date: "2026-10-13", typeId: parking.id, description: "Stationnement", amountCents: 1200 });
    // a normal expense still needs its description
    expect((await tech.post("/api/time/expenses", { reportId: report.id, date: "2026-10-13", typeId: parking.id, amountCents: 100 })).status).toBe(400);
    const r = (await tech.get("/api/time/expense-reports")).json.find((x: any) => x.id === report.id);
    expect(r).toMatchObject({ totalKm: 42, moneyCents: 1200 });
    expect(r.items.find((x: any) => x.id === ok.json.id).mileage).toBe(true);
    // changing the places rewrites the description
    const upd = await tech.patch(`/api/time/expenses/${ok.json.id}`, { toPlace: "Montréal" });
    expect(upd.json).toMatchObject({ toPlace: "Montréal", description: "Bureau → Montréal" });
    // a favourite remembers the places
    const fav = await tech.post("/api/time/expense-favorites", { name: "Joliette", typeId: km.id, quantity: 42, fromPlace: "Bureau", toPlace: "Joliette" });
    expect(fav.json).toMatchObject({ fromPlace: "Bureau", toPlace: "Joliette" });
    await tech.del(`/api/time/expense-favorites/${fav.json.id}`);
  });

  it("expenses with receipts; approved: billable ones go on the client's invoice; all sent to QuickBooks", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const other = await signIn("tech2@akab.local");
    const types = (await tech.get("/api/time/types")).json.expense;
    const km = types.find((x: any) => x.name === "Kilométrage");
    const material = types.find((x: any) => x.name === "Matériel pour un client");
    const client = (await admin.get("/api/crm/clients")).json.find((c: any) => c.autotaskId === 307);
    const receipt = { name: "reçu.png", contentType: "image/png", data: Buffer.from("png").toString("base64") };
    const a1 = (await tech.post("/api/time/expenses", { date: "2026-10-15", typeId: km.id, description: "Aller-retour Joliette", quantity: 42, fromPlace: "Bureau", toPlace: "Joliette", receipt })).json;
    expect(a1).toMatchObject({ amountCents: 2856, hasReceipt: true, status: "draft", billable: false });
    expect(a1.receiptData).toBeUndefined();
    const a2 = (await tech.post("/api/time/expenses", { date: "2026-10-16", typeId: material.id, description: "Câble HDMI", amountCents: 4599, clientId: client.id })).json;
    expect(a2).toMatchObject({ billable: true, amountCents: 4599 });
    // the receipt: its owner and the approver, nobody else
    expect((await tech.get(`/api/time/expenses/${a1.id}/receipt`)).status).toBe(200);
    expect((await other.get(`/api/time/expenses/${a1.id}/receipt`)).status).toBe(404);
    expect((await admin.get(`/api/time/expenses/${a1.id}/receipt`)).status).toBe(200);
    for (const x of [a1, a2]) await tech.post(`/api/time/expenses/${x.id}/submit`);
    expect((await tech.patch(`/api/time/expenses/${a1.id}`, { description: "x" })).json.error).toBe("expense_locked");

    // QuickBooks on: what is approved goes there by itself
    const { saveQuickBooksSettings } = await import("../server/lib/billing.ts");
    const { forgetQuickBooksToken } = await import("../server/lib/quickbooks.ts");
    forgetQuickBooksToken();
    await saveQuickBooksSettings(null, { clientId: "ABqb", clientSecret: "qb-secret", environment: "sandbox", realmId: "9130", refreshToken: "qb-refresh", enabled: true, sync: { invoices: true, payments: false, customers: true, timesheets: true, expenses: true }, invoice: { itemId: "11", taxCodeId: "5", exemptTaxCodeId: "6" } });
    await db().update(schema.ledgerAccounts).set({ quickbooksId: "Q5100" }).where(eq(schema.ledgerAccounts.number, "5100"));
    await db().update(schema.ledgerAccounts).set({ quickbooksId: "Q5000" }).where(eq(schema.ledgerAccounts.number, "5000"));
    await db().update(schema.ledgerAccounts).set({ quickbooksId: "Q1000" }).where(eq(schema.ledgerAccounts.number, "1000"));
    await db().update(schema.clients).set({ quickbooksId: "60" }).where(eq(schema.clients.id, client.id));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = decodeURIComponent(String(input));
        if (url.startsWith("https://oauth.platform.intuit.com/")) return json({ access_token: "qb-access", refresh_token: "qb-refresh" });
        sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("select * from Employee")) return json({ QueryResponse: { Employee: [{ Id: "77", DisplayName: "Alex Tremblay", PrimaryEmailAddr: { Address: "tech@akab.local" } }] } });
        if (url.includes("select * from Invoice")) return json({ QueryResponse: {} });
        if (url.includes("/timeactivity?")) return json({ TimeActivity: { Id: "T1" } });
        if (url.includes("/purchase?")) return json({ Purchase: { Id: `P${sent.length}` } });
        if (url.includes("/invoice?")) return json({ Invoice: { Id: "700" } });
        return new Response(JSON.stringify({ Fault: { Error: [{ Message: `unexpected ${url}` }] } }), { status: 400 });
      }),
    );

    // for now, approved weeks and expenses are not sent to QuickBooks (even with the sync on)
    expect((await admin.post(`/api/time/approvals/timesheets/${globalThis.__sheet}`, { decision: "approve" })).json.status).toBe("approved");
    expect(sent.filter((s) => s.url.includes("/timeactivity?"))).toHaveLength(0);
    expect((await tech.post("/api/time/approvals/expenses", { ids: [a1.id], decision: "approve" })).status).toBe(403);
    expect((await admin.post("/api/time/approvals/expenses", { ids: [a1.id, a2.id], decision: "approve" })).json.changed).toBe(2);
    expect(sent.filter((s) => s.url.includes("/purchase?") || s.url.includes("/timeactivity?"))).toHaveLength(0);
    const mineNow = (await tech.get("/api/time/expenses")).json;
    expect(mineNow.find((x: any) => x.id === a1.id)).toMatchObject({ status: "approved", quickbooksId: null });

    // accounting marks them paid once paid (only approved ones; only with accounting.manage)
    expect((await tech.post("/api/time/approvals/timesheets/paid", { ids: [globalThis.__sheet], paid: true })).status).toBe(403);
    expect((await admin.post("/api/time/approvals/timesheets/paid", { ids: [globalThis.__sheet], paid: true })).json.changed).toBe(1);
    expect((await admin.post("/api/time/approvals/timesheets/paid", { ids: [globalThis.__sheet], paid: true })).json.changed).toBe(0);
    const paidWeeks = (await admin.get("/api/time/approvals/timesheets?status=paid")).json;
    expect(paidWeeks.find((w: any) => w.id === globalThis.__sheet)).toMatchObject({ status: "paid", paidAt: expect.any(String) });
    expect((await admin.get("/api/time/approvals/timesheets?status=approved")).json.some((w: any) => w.id === globalThis.__sheet)).toBe(false);
    expect((await tech.post("/api/time/approvals/expenses/paid", { ids: [a1.id], paid: true })).status).toBe(403);
    expect((await admin.post("/api/time/approvals/expenses/paid", { ids: [a1.id, a2.id], paid: true })).json.changed).toBe(2);
    expect((await tech.get("/api/time/expenses")).json.find((x: any) => x.id === a1.id)).toMatchObject({ status: "paid", paidAt: expect.any(String) });
    // a paid expense is locked for its owner
    expect((await tech.del(`/api/time/expenses/${a1.id}`)).status).toBe(409);
    // a mistake: back to approved
    expect((await admin.post("/api/time/approvals/expenses/paid", { ids: [a2.id], paid: false })).json.changed).toBe(1);
    expect((await admin.get("/api/time/approvals/expenses?status=approved")).json.find((x: any) => x.id === a2.id)).toMatchObject({ status: "approved", paidAt: null });
    expect((await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "expense.paid"))).length).toBeGreaterThan(0);
    const item = (await admin.get(`/api/billables?clientId=${client.id}&status=approved`)).json.find((i: any) => i.kind === "expense" && i.description.includes("Câble HDMI"));
    expect(item).toMatchObject({ amountCents: 4599, source: "portal" });

    // an invoice made in the portal: sent to QuickBooks right away
    sent.length = 0;
    const made = (await admin.post("/api/billables/invoice", { clientId: client.id, itemIds: [item.id] })).json;
    expect(sent.find((s) => s.url.includes("/invoice?"))!.body).toMatchObject({ DocNumber: made.number, CustomerRef: { value: "60" } });
    const inv = (await admin.get(`/api/crm/clients/${client.id}/invoices`)).json.items.find((v: any) => v.id === made.id);
    expect(inv.quickbooks).toMatchObject({ id: "700" });
  });
});

describe("submitting: timesheets (when required) and expenses", () => {
  it("only submitted weeks and expenses reach the approver; an admin can say a technician has no timesheet to submit", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech2 = await signIn("tech2@akab.local");
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech2@akab.local"));
    // by default, a timesheet is to submit
    expect((await tech2.get("/api/time/week")).json.required).toBe(true);
    // a draft expense is not in the approver's list
    const types = (await tech2.get("/api/time/types")).json.expense;
    const x = (await tech2.post("/api/time/expenses", { date: "2026-10-17", typeId: types.find((t: any) => t.name === "Stationnement").id, description: "Stationnement centre-ville", amountCents: 1200 })).json;
    expect((await admin.get("/api/time/approvals/expenses")).json.some((e: any) => e.id === x.id)).toBe(false);
    await tech2.post(`/api/time/expenses/${x.id}/submit`);
    expect((await admin.get("/api/time/approvals/expenses")).json.some((e: any) => e.id === x.id)).toBe(true);

    // the admin says this technician has no timesheet to submit
    expect((await tech2.patch(`/api/admin/users/${u.id}`, { timesheetRequired: false })).status).toBe(403);
    expect((await admin.patch(`/api/admin/users/${u.id}`, { timesheetRequired: false })).json.timesheetRequired).toBe(false);
    const week = (await tech2.get("/api/time/week")).json;
    expect(week.required).toBe(false);
    expect((await tech2.post("/api/time/week/submit", { weekStart: week.weekStart })).json.error).toBe("timesheet_not_required");
    // the sidebar hides the timesheet for them (the flag is on /me)
    expect((await tech2.get("/api/me")).json.timesheetRequired).toBe(false);
    await admin.patch(`/api/admin/users/${u.id}`, { timesheetRequired: true });
    expect((await tech2.get("/api/me")).json.timesheetRequired).toBe(true);
  });

  it("timesheets.manage: an admin picks anyone and manages their timesheet; nobody else can", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech2 = await signIn("tech2@akab.local");
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech2@akab.local"));
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    // the team list, for managers only
    const people = (await admin.get("/api/time/people")).json;
    expect(people.some((p: any) => p.id === u.id && p.timesheetRequired === true)).toBe(true);
    expect((await tech2.get("/api/time/people")).status).toBe(403);
    // a technician cannot open or change someone else's
    expect((await tech2.get(`/api/time/week?userId=${adminRow.id}`)).status).toBe(403);
    const typeId = (await admin.get("/api/time/types")).json.time.find((x: any) => x.kind === "other").id;
    expect((await tech2.post("/api/time/entries", { date: "2026-11-03", typeId, hours: 1, userId: adminRow.id })).status).toBe(403);

    // the admin adds hours on the technician's week, removes them, then submits it for them
    const added = await admin.post("/api/time/entries", { date: "2026-11-03", typeId, hours: 2.5, note: "Formation Fortinet", userId: u.id });
    expect(added.status).toBe(201);
    expect(added.json.userId).toBe(u.id);
    let week = (await admin.get(`/api/time/week?start=2026-11-03&userId=${u.id}`)).json;
    expect(week).toMatchObject({ userId: u.id, weekStart: "2026-11-02", totalHours: 2.5 });
    // the technician sees them on their own week
    expect((await tech2.get("/api/time/week?start=2026-11-03")).json.entries.some((e: any) => e.id === added.json.id)).toBe(true);
    // their own entry: only a manager removes someone else's
    expect((await tech2.post("/api/time/entries", { date: "2026-11-04", typeId, hours: 1 })).status).toBe(201);
    const own = (await tech2.get("/api/time/week?start=2026-11-03")).json.entries.find((e: any) => e.hours === 1);
    expect((await admin.del(`/api/time/entries/${own.id}`)).status).toBe(200);
    expect((await admin.post("/api/time/week/submit", { weekStart: "2026-11-02", userId: u.id })).json.status).toBe("submitted");
    week = (await tech2.get("/api/time/week?start=2026-11-03")).json;
    expect(week).toMatchObject({ status: "submitted", totalHours: 2.5 });
    const log = await db().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, adminRow.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["timesheet.entry_added_for", "timesheet.entry_removed_for", "timesheet.submitted"]));
    // a client account is never a timesheet
    const [client] = await db().select().from(schema.users).where(eq(schema.users.kind, "client"));
    expect((await admin.get(`/api/time/week?userId=${client.id}`)).status).toBe(404);
  });

  it("expense reports: items added while open, sent together, approved one by one; a refused item opens the report again", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech2 = await signIn("tech2@akab.local");
    const tech = await signIn("tech@akab.local");
    const types = (await tech2.get("/api/time/types")).json.expense;
    const parking = types.find((t: any) => t.name === "Stationnement").id;
    const october = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };
    const report = await tech2.post("/api/time/expense-reports", { title: "Tournée Joliette — octobre", ...october });
    expect(report.status).toBe(201);
    expect(report.json).toMatchObject(october);
    expect((await tech2.post("/api/time/expense-reports", { title: " ", ...october })).status).toBe(400);
    // the days it covers: both, in order, a year at most
    expect((await tech2.post("/api/time/expense-reports", { title: "x" })).status).toBe(400);
    expect((await tech2.post("/api/time/expense-reports", { title: "x", periodStart: "2026-10-31", periodEnd: "2026-10-01" })).status).toBe(400);
    expect((await tech2.post("/api/time/expense-reports", { title: "x", periodStart: "2026-01-01", periodEnd: "2027-06-01" })).status).toBe(400);
    const add = (description: string, amountCents: number) =>
      tech2.post("/api/time/expenses", { reportId: report.json.id, date: "2026-10-17", typeId: parking, description, amountCents });
    const [i1, i2, i3] = [(await add("Stationnement A", 1200)).json, (await add("Stationnement B", 800)).json, (await add("Stationnement C", 500)).json];
    // only days within the report
    const outside = await tech2.post("/api/time/expenses", { reportId: report.json.id, date: "2026-11-02", typeId: parking, description: "Novembre", amountCents: 100 });
    expect(outside.json.error).toBe("expense_out_of_period");
    expect((await tech2.patch(`/api/time/expenses/${i1.id}`, { date: "2026-09-30" })).json.error).toBe("expense_out_of_period");
    // the period cannot leave items out; a rename alone is fine
    expect((await tech2.patch(`/api/time/expense-reports/${report.json.id}`, { periodStart: "2026-10-18", periodEnd: "2026-10-31" })).json.error).toBe("report_period_items");
    expect((await tech2.patch(`/api/time/expense-reports/${report.json.id}`, { periodStart: "2026-10-18" })).status).toBe(400);
    expect((await tech2.patch(`/api/time/expense-reports/${report.json.id}`, { periodStart: "2026-10-10", periodEnd: "2026-10-24" })).status).toBe(200);
    // not someone else's report
    expect((await tech.post("/api/time/expenses", { reportId: report.json.id, date: "2026-10-17", typeId: parking, description: "x", amountCents: 1 })).status).toBe(404);
    expect((await tech.post(`/api/time/expense-reports/${report.json.id}/submit`)).status).toBe(404);
    // an item removed while open
    expect((await tech2.del(`/api/time/expenses/${i3.id}`)).status).toBe(200);
    let mine = (await tech2.get("/api/time/expense-reports")).json.find((r: any) => r.id === report.json.id);
    expect(mine).toMatchObject({ status: "open", totalCents: 2000, title: "Tournée Joliette — octobre", periodStart: "2026-10-10", periodEnd: "2026-10-24" });
    expect(mine.items.map((x: any) => x.id).sort()).toEqual([i1.id, i2.id].sort());
    expect((await tech2.patch(`/api/time/expense-reports/${report.json.id}`, { title: "Tournée Joliette" })).status).toBe(200);

    // sent together: locked, nothing more can be added
    expect((await tech2.post(`/api/time/expense-reports/${report.json.id}/submit`)).json.submitted).toBe(2);
    expect((await add("Trop tard", 100)).json.error).toBe("report_submitted");
    expect((await tech2.patch(`/api/time/expense-reports/${report.json.id}`, { title: "x" })).json.error).toBe("report_submitted");
    expect((await tech2.del(`/api/time/expense-reports/${report.json.id}`)).json.error).toBe("report_submitted");
    const pending = (await admin.get("/api/time/approvals/expenses")).json.filter((e: any) => e.reportId === report.json.id);
    expect(pending).toHaveLength(2);
    expect(pending[0].reportTitle).toBe("Tournée Joliette");

    // one approved, one refused: the report is open again for the refused one (and new items)
    await admin.post("/api/time/approvals/expenses", { ids: [i1.id], decision: "approve" });
    await admin.post("/api/time/approvals/expenses", { ids: [i2.id], decision: "reject", comment: "Reçu illisible" });
    mine = (await tech2.get("/api/time/expense-reports")).json.find((r: any) => r.id === report.json.id);
    expect(mine).toMatchObject({ status: "open", rejected: 1 });
    expect((await tech2.patch(`/api/time/expenses/${i1.id}`, { description: "x" })).json.error).toBe("expense_locked");
    expect((await tech2.del(`/api/time/expense-reports/${report.json.id}`)).json.error).toBe("expense_locked");
    expect((await add("Oublié", 300)).status).toBe(201);
    expect((await tech2.post(`/api/time/expense-reports/${report.json.id}/submit`)).json.submitted).toBe(2);
    await admin.post("/api/time/approvals/expenses", { ids: mine.items.map((x: any) => x.id).concat((await tech2.get("/api/time/expenses")).json.map((x: any) => x.id)), decision: "approve" });
    mine = (await tech2.get("/api/time/expense-reports")).json.find((r: any) => r.id === report.json.id);
    expect(mine.status).toBe("approved");

    // an empty report cannot be sent; an open one is deleted with its items
    const empty = (await tech2.post("/api/time/expense-reports", { title: "Vide", ...october })).json;
    expect((await tech2.post(`/api/time/expense-reports/${empty.id}/submit`)).json.error).toBe("report_empty");
    expect((await tech2.del(`/api/time/expense-reports/${empty.id}`)).status).toBe(200);
  });
});

describe("coffee break", () => {
  it("chess with a colleague online: invitation, moves checked on the server, checkmate, resign; nobody else sees it", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    // both signed in just now: online for each other (never oneself)
    const online = (await tech.get("/api/breakroom/online")).json;
    expect(online.some((p: any) => p.id === adminRow.id)).toBe(true);
    expect(online.some((p: any) => p.id === techRow.id)).toBe(false);

    // the invitation: a notification; asking again gives the same game
    const g = await tech.post("/api/breakroom/chess", { opponentId: adminRow.id });
    expect(g.status).toBe(201);
    expect(g.json).toMatchObject({ status: "invited", myColor: "w", invitedByMe: true, opponent: { id: adminRow.id } });
    expect((await tech.post("/api/breakroom/chess", { opponentId: adminRow.id })).json.id).toBe(g.json.id);
    expect((await tech.post("/api/breakroom/chess", { opponentId: techRow.id })).status).toBe(400);
    const bell = (await admin.get("/api/notifications")).json.items.find((n: any) => n.type === "breakroom.invite");
    expect(bell).toMatchObject({ link: `/breakroom?game=${g.json.id}`, data: { from: "Alex Tremblay" } });
    // only the one invited answers; no move before
    expect((await tech.post(`/api/breakroom/chess/${g.json.id}/respond`, { accept: true })).status).toBe(409);
    expect((await tech.post(`/api/breakroom/chess/${g.json.id}/move`, { from: "e2", to: "e4" })).json.error).toBe("game_not_playing");
    expect((await admin.post(`/api/breakroom/chess/${g.json.id}/respond`, { accept: true })).json.status).toBe("playing");

    // white (the one who invited) plays first; the rules of chess are checked
    const mv = (who: any, from: string, to: string) => who.post(`/api/breakroom/chess/${g.json.id}/move`, { from, to });
    expect((await mv(admin, "e7", "e5")).json.error).toBe("not_your_turn");
    expect((await mv(tech, "e2", "e5")).json.error).toBe("illegal_move");
    expect((await tech.post(`/api/breakroom/chess/${g.json.id}/move`, { from: "z9", to: "e4" })).status).toBe(400);
    // the fool's mate: 1. f3 e5 2. g4 Qh4#
    expect((await mv(tech, "f2", "f3")).json).toMatchObject({ turn: "b", myTurn: false, lastMove: "f2f3" });
    expect((await admin.get(`/api/breakroom/chess/${g.json.id}`)).json).toMatchObject({ myColor: "b", myTurn: true });
    await mv(admin, "e7", "e5");
    await mv(tech, "g2", "g4");
    const mate = await mv(admin, "d8", "h4");
    expect(mate.json).toMatchObject({ status: "done", result: "b", endedBy: "checkmate" });
    expect((await tech.get(`/api/breakroom/chess/${g.json.id}`)).json).toMatchObject({ status: "done", result: "b", myColor: "w" });

    // someone else cannot see or play a game
    const g2 = (await tech.post("/api/breakroom/chess", { opponentId: adminRow.id })).json;
    expect(g2.id).not.toBe(g.json.id);
    const tech2 = await signIn("tech2@akab.local");
    expect((await tech2.get(`/api/breakroom/chess/${g2.id}`)).status).toBe(404);
    expect((await tech2.post(`/api/breakroom/chess/${g2.id}/move`, { from: "e2", to: "e4" })).status).toBe(404);
    // cancelling an invitation not answered yet
    expect((await tech.post(`/api/breakroom/chess/${g2.id}/resign`)).json.status).toBe("declined");

    // clients have no coffee break
    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/breakroom/online")).status).toBe(403);
  });

  it("Complots: a table of colleagues, the host starts with those who said yes; each one sees only their cards; moves checked; leaving ends it", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    const tech2 = await signIn("tech2@akab.local");
    const id = async (email: string) => (await db().select().from(schema.users).where(eq(schema.users.email, email)))[0].id;
    const [techId, adminId, tech2Id] = [await id("tech@akab.local"), await id("admin@akab.local"), await id("tech2@akab.local")];
    const chars = ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"];
    // one character per clan
    expect((await tech.post("/api/breakroom/complots", { invite: [adminId], chars: ["duchesse", "assassin", "bourreau", "capitaine", "ambassadeur"] })).status).toBe(400);
    const made = await tech.post("/api/breakroom/complots", { invite: [adminId, tech2Id], chars });
    expect(made.status).toBe(201);
    const gid = made.json.id;
    const bell = (await admin.get("/api/notifications")).json.items.find((n: any) => n.type === "breakroom.complots");
    expect(bell).toMatchObject({ link: `/breakroom?complots=${gid}` });
    expect((await admin.get("/api/breakroom/complots")).json.find((x: any) => x.id === gid)).toMatchObject({ invited: true, status: "lobby" });
    // only the host starts, with at least one yes
    expect((await tech.post(`/api/breakroom/complots/${gid}/start`)).json.error).toBe("not_enough_players");
    expect((await admin.post(`/api/breakroom/complots/${gid}/respond`, { accept: true })).status).toBe(200);
    expect((await tech2.post(`/api/breakroom/complots/${gid}/respond`, { accept: false })).status).toBe(200);
    expect((await admin.post(`/api/breakroom/complots/${gid}/start`)).json.error).toBe("game_not_lobby");
    const started = await tech.post(`/api/breakroom/complots/${gid}/start`);
    expect(started.json.status).toBe("playing");
    // two players (tech2 said no): the draft first
    const g = started.json.game;
    expect(g.players.map((p: any) => p.id).sort()).toEqual([techId, adminId].sort());
    expect(g.phase.k).toBe("draft");
    // tech2 left the table: nothing to see any more
    expect((await tech2.get(`/api/breakroom/complots`)).json.some((x: any) => x.id === gid)).toBe(false);
    // each one sees only their own card
    const mine = g.players.find((p: any) => p.id === techId);
    const theirs = g.players.find((p: any) => p.id === adminId);
    expect(mine.cards[0].c).toBeTruthy();
    expect(theirs.cards[0].c).toBeNull();
    for (const [agent, me] of [[tech, techId], [admin, adminId]] as const) {
      const v = (await agent.get(`/api/breakroom/complots/${gid}`)).json.game;
      expect((await agent.post(`/api/breakroom/complots/${gid}/play`, { input: { t: "draft", char: v.phase.options[0] } })).status).toBe(200);
      expect(me).toBeTruthy();
    }
    const v = (await tech.get(`/api/breakroom/complots/${gid}`)).json.game;
    expect(v.phase.k).toBe("turn");
    const first = v.turn === techId ? tech : admin;
    const second = v.turn === techId ? admin : tech;
    expect((await second.post(`/api/breakroom/complots/${gid}/play`, { input: { t: "action", kind: "income" } })).json.error).toBe("complots_not_your_turn");
    expect((await first.post(`/api/breakroom/complots/${gid}/play`, { input: { t: "action", kind: "fly" } })).status).toBe(400);
    const after = (await first.post(`/api/breakroom/complots/${gid}/play`, { input: { t: "action", kind: "income" } })).json.game;
    expect(after.turn).not.toBe(v.turn);
    // someone else's table: not found
    expect((await tech2.get(`/api/breakroom/complots/${gid}`)).status).toBe(404);
    // one leaves: the other wins
    const end = (await first.post(`/api/breakroom/complots/${gid}/leave`)).json;
    expect(end.status).toBe("done");
    expect(end.winnerId).toBe(v.turn === techId ? adminId : techId);
  });

  it("30 minutes a day: the time on screen counts (a minute at most between beats), then everything closes until tomorrow", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    await db().delete(schema.breakroomUsage).where(eq(schema.breakroomUsage.userId, techRow.id));
    expect((await tech.get("/api/breakroom/status")).json).toEqual({ limitSeconds: 1800, usedSeconds: 0, remainingSeconds: 1800 });
    // the first beat starts the clock; 40 s later, 40 s count
    await tech.post("/api/breakroom/beat");
    await db().update(schema.breakroomUsage).set({ lastBeatAt: new Date(Date.now() - 40_000) }).where(eq(schema.breakroomUsage.userId, techRow.id));
    expect((await tech.post("/api/breakroom/beat")).json.usedSeconds).toBe(40);
    // a long pause (page hidden or closed) does not count
    await db().update(schema.breakroomUsage).set({ lastBeatAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.breakroomUsage.userId, techRow.id));
    expect((await tech.post("/api/breakroom/beat")).json.usedSeconds).toBe(40);
    // the day's time used: everything but the status is closed
    await db().update(schema.breakroomUsage).set({ usedSeconds: 1790, lastBeatAt: new Date(Date.now() - 30_000) }).where(eq(schema.breakroomUsage.userId, techRow.id));
    expect((await tech.post("/api/breakroom/beat")).json).toMatchObject({ usedSeconds: 1800, remainingSeconds: 0 });
    expect((await tech.get("/api/breakroom/online")).json.error).toBe("break_over");
    expect((await tech.get("/api/breakroom/videos")).json.error).toBe("break_over");
    expect((await tech.get("/api/breakroom/chess")).status).toBe(403);
    expect((await tech.get("/api/breakroom/status")).json.remainingSeconds).toBe(0);
    // tomorrow is another day
    await db().update(schema.breakroomUsage).set({ day: "2000-01-01" }).where(eq(schema.breakroomUsage.userId, techRow.id));
    expect((await tech.get("/api/breakroom/status")).json.remainingSeconds).toBe(1800);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("security review fixes", () => {
  it("a Graph path never climbs out of its mailbox (%2e%2e, %2f, backslash)", async () => {
    const { safeGraphPath } = await import("../server/lib/o365.ts");
    expect(safeGraphPath("users/tech%40akab.local/mailFolders/inbox/messages?$top=25")).toBe(true);
    expect(safeGraphPath("me/messages/AAMkAD%3D%3D/attachments")).toBe(true);
    expect(safeGraphPath("users/tech%40akab.local/%2e%2e/ceo%40akab.local/messages")).toBe(false);
    expect(safeGraphPath("users/tech%40akab.local/.%2E/ceo%40akab.local/messages")).toBe(false);
    expect(safeGraphPath("me/%2e%2e/%2e%2e/beta/users")).toBe(false);
    expect(safeGraphPath("users/x/mailFolders/..")).toBe(false);
    expect(safeGraphPath("users/x/mailFolders/a%2Fb")).toBe(false);
    expect(safeGraphPath("users/x/mailFolders/a%5Cb")).toBe(false);
    // the URL parser drops tabs and newlines: ".\t." would become ".."
    expect(safeGraphPath("users/tech%40akab.local/.\t./ceo%40akab.local/messages")).toBe(false);
    expect(safeGraphPath("users/tech%40akab.local/..\n/ceo%40akab.local/messages")).toBe(false);
    expect(safeGraphPath("users/tech%40akab.local/%09../ceo%40akab.local/messages")).toBe(false);
    expect(safeGraphPath("$batch")).toBe(true);
    expect(safeGraphPath("users/x/messages/AAA%3D/attachments/BBB/$value")).toBe(true);
  });

  it("a mailbox linked through the organisation access needs the right every time", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    await db().insert(schema.userPreferences).values({ userId: u.id, outlook: true }).onConflictDoUpdate({ target: schema.userPreferences.userId, set: { outlook: true } });
    const [acc] = await db().insert(schema.mailAccounts).values({ userId: u.id, address: "compta@akab.local", via: "app" }).returning();
    expect((await tech.get(`/api/outlook/accounts/${acc.id}/folders`)).json.error).toBe("outlook_no_access");
    // it can still be unlinked
    expect((await tech.del(`/api/outlook/accounts/${acc.id}`)).status).toBe(200);
    expect((await db().select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, acc.id))).length).toBe(0);
  });

  it("a global admin cannot give or take over master-only rights", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json;
    const by = (slug: string) => roles.find((r: any) => r.slug === slug);
    const [lead] = await db().insert(schema.roles).values({ slug: "it-lead-test", audience: "staff", name: "IT Lead", permissions: ["tickets.view", "admin.integrations"] }).returning();
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [tech2Row] = await db().select().from(schema.users).where(eq(schema.users.email, "tech2@akab.local"));
    await db().update(schema.users).set({ roleId: by("global-admin").id }).where(eq(schema.users.id, techRow.id));
    resetRateLimit("login:ip:unknown");
    const global = await signIn("tech@akab.local");
    // a role carrying a master-only right: not given by a global admin (not even to themselves)
    expect((await global.patch(`/api/admin/users/${techRow.id}`, { roleId: lead.id })).json.error).toBe("master_only");
    expect((await global.patch(`/api/admin/users/${tech2Row.id}`, { roleId: lead.id })).json.error).toBe("master_only");
    // someone holding one (here through their own rights) is not reset nor changed by a global admin
    await admin.put(`/api/admin/users/${tech2Row.id}/permissions`, { overrides: [{ key: "outlook.anyMailbox", effect: "allow" }] });
    expect((await global.post(`/api/admin/users/${tech2Row.id}/reset-password`)).json.error).toBe("master_only");
    expect((await global.post(`/api/admin/users/${tech2Row.id}/reset-mfa`)).json.error).toBe("master_only");
    expect((await global.patch(`/api/admin/users/${tech2Row.id}`, { active: false })).json.error).toBe("master_only");
    await admin.put(`/api/admin/users/${tech2Row.id}/permissions`, { overrides: [] });
    expect((await global.patch(`/api/admin/users/${tech2Row.id}`, { title: "Technicien" })).status).toBe(200);
    await db().update(schema.users).set({ roleId: by("technician").id }).where(eq(schema.users.id, techRow.id));
    await db().delete(schema.roles).where(eq(schema.roles.id, lead.id));
  });

  it("users of a client turned off cannot sign in; old password links die with a password or email change", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const [cu] = await db().select().from(schema.users).where(eq(schema.users.email, "responsable2@client.example"));
    // still works while the client is active
    resetRateLimit("login:ip:unknown");
    expect((await new Agent().post("/api/auth/login", { email: cu.email, password: PASSWORD })).status).toBe(200);
    await db().update(schema.clients).set({ active: false }).where(eq(schema.clients.id, cu.clientId!));
    resetRateLimit("login:ip:unknown");
    expect((await new Agent().post("/api/auth/login", { email: cu.email, password: PASSWORD })).json.error).toBe("invalid_credentials");
    await db().update(schema.clients).set({ active: true }).where(eq(schema.clients.id, cu.clientId!));

    // a reset link sent to the old address stops working when an admin changes the email
    const { issuePasswordLink } = await import("../server/lib/passwordLinks.ts");
    const token = await issuePasswordLink(cu, "reset");
    expect((await new Agent().post("/api/auth/reset/check", { token })).json.valid).toBe(true);
    await admin.patch(`/api/admin/users/${cu.id}`, { email: "nouveau.responsable@client.example" });
    expect((await new Agent().post("/api/auth/reset/check", { token })).json.valid).toBe(false);
    await admin.patch(`/api/admin/users/${cu.id}`, { email: cu.email });
  });

  it("a successful login does not count against the shared IP; an approver cannot approve their own expense", async () => {
    resetRateLimit("login:ip:unknown");
    for (let i = 0; i < 70; i++) {
      const r = await new Agent().post("/api/auth/login", { email: "tech2@akab.local", password: PASSWORD });
      expect(r.status).toBe(200);
    }
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const types = (await admin.get("/api/time/types")).json.expense;
    const mine = (await admin.post("/api/time/expenses", { date: "2026-10-17", typeId: types[1].id, description: "Moi-même", amountCents: 500000 })).json;
    await admin.post(`/api/time/expenses/${mine.id}/submit`);
    expect((await admin.post("/api/time/approvals/expenses", { ids: [mine.id], decision: "approve" })).json.changed).toBe(0);
    // a client to bill must exist
    expect((await admin.post("/api/time/expenses", { date: "2026-10-17", typeId: types[1].id, description: "x", amountCents: 100, clientId: crypto.randomUUID() })).json.error).toBe("client_unknown");
  });

  it("a partial product change keeps the fields not sent", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const made = (await admin.post("/api/store/products", { name: "Souris sans fil", sku: "MOUSE-SEC-1", priceCents: 2999, costCents: 1500, active: false })).json;
    const r = (await admin.patch(`/api/store/products/${made.id}`, { priceCents: 3499 })).json;
    expect(r).toMatchObject({ priceCents: 3499, costCents: 1500, active: false, sku: "MOUSE-SEC-1" });
  });
});

describe("client portal: message board questions", () => {
  it("clients read the board, cannot post on it, and ask a question as a ticket for their company", async () => {
    resetRateLimit("login:ip:unknown");
    const { saveBillingSettings } = await import("../server/lib/billing.ts");
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    await saveBillingSettings(adminRow.id, { company: { phone: "450 555-0199", email: "support@akab.example" } });

    const client = await signIn("responsable1@client.example");
    expect((await client.get("/api/board/contact")).json).toEqual({ phone: "450 555-0199", email: "support@akab.example" });
    // the board is read-only for clients
    expect((await client.post("/api/messages", { title: "x", body: "y", audience: "all" })).status).toBe(403);

    const board = (await client.get("/api/board")).json;
    const msg = board[0];
    expect((await client.post(`/api/board/${msg.id}/ticket`, { question: "  " })).status).toBe(400);
    const r = await client.post(`/api/board/${msg.id}/ticket`, { question: "Est-ce que la maintenance touche nos imprimantes ?" });
    expect(r.status).toBe(201);
    expect(r.json.number).toMatch(/^T\d{8}\.\d{3,5}$/);

    // the technicians see it as a new ticket for that client's company
    const tech = await signIn("tech@akab.local");
    const t = (await tech.get(`/api/tickets/${r.json.id}`)).json;
    const [me] = await db().select().from(schema.users).where(eq(schema.users.email, "responsable1@client.example"));
    const [company] = await db().select().from(schema.clients).where(eq(schema.clients.id, me.clientId!));
    expect(t.title).toBe(`Question — ${msg.title}`);
    expect(t.company.name).toBe(company.name);
    expect(t.description).toContain("Est-ce que la maintenance touche nos imprimantes ?");
    expect(t.description).toContain(`Au sujet du message du babillard « ${msg.title} »`);
    const log = await db().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, me.id));
    expect(log.some((l) => l.action === "board.ticket" && l.target === String(r.json.id))).toBe(true);
  });

  it("only about messages of their company, with the right, and never from the client view", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const clients = (await admin.get("/api/messages/client-options")).json;
    const [me] = await db().select().from(schema.users).where(eq(schema.users.email, "responsable1@client.example"));
    const other = clients.find((x: any) => x.id !== me.clientId);
    const elsewhere = await admin.post("/api/messages", { title: "Pour un autre client", body: "x", audience: "selected", clientIds: [other.id] });
    const client = await signIn("responsable1@client.example");
    expect((await client.post(`/api/board/${elsewhere.json.id}/ticket`, { question: "?" })).status).toBe(404);

    const mine = (await client.get("/api/board")).json[0];
    await admin.put(`/api/admin/users/${me.id}/permissions`, { overrides: [{ key: "board.ticket", effect: "deny" }] });
    expect((await client.post(`/api/board/${mine.id}/ticket`, { question: "Une question" })).status).toBe(403);
    expect((await client.get("/api/board")).status).toBe(200);
    await admin.put(`/api/admin/users/${me.id}/permissions`, { overrides: [] });

    // a technician viewing the portal as this client cannot open a ticket in their name
    expect((await admin.post("/api/view-as", { clientId: me.clientId })).status).toBe(200);
    expect((await admin.post(`/api/board/${mine.id}/ticket`, { question: "Une question" })).json.error).toBe("read_only_view");
    await admin.del("/api/view-as");
  });
});

describe("client portal: sections, default roles and per-user rights", () => {
  it("client companies get Admin, Accounting and Tech roles by default", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const roles = (await admin.get("/api/admin/roles")).json.filter((r: any) => r.audience === "client");
    const bySlug = Object.fromEntries(roles.map((r: any) => [r.slug, r.permissions.slice().sort()]));
    expect(bySlug["client-admin"]).toEqual(["board.ticket", "board.view", "clientAdmin.company", "clientAdmin.users", "clientDevices.view", "clientDocs.view", "clientInvoices.view", "clientQuotes.view", "clientTickets.all", "clientTickets.attach", "clientTickets.comment", "clientTickets.escalate", "clientTickets.view"]);
    expect(bySlug["client-accounting"]).toEqual(["board.ticket", "board.view", "clientInvoices.view", "clientQuotes.view", "clientTickets.attach", "clientTickets.comment", "clientTickets.escalate", "clientTickets.view"]);
    expect(bySlug["client-tech"]).toEqual(["board.ticket", "board.view", "clientDevices.view", "clientDocs.view", "clientTickets.all", "clientTickets.attach", "clientTickets.comment", "clientTickets.escalate", "clientTickets.view"]);
    expect(bySlug["client-user"]).toEqual(["board.ticket", "board.view", "clientTickets.attach", "clientTickets.comment", "clientTickets.escalate", "clientTickets.view"]);
    expect(bySlug["client-config"]).toEqual(["board.ticket", "board.view", "clientAdmin.company", "clientAdmin.users", "clientTickets.attach", "clientTickets.comment", "clientTickets.escalate", "clientTickets.view"]);
  });

  it("any right can be given to (or taken from) one person directly, without changing their role", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const [emp] = await db().select().from(schema.users).where(eq(schema.users.email, "employe1@client.example"));
    const before = (await (await signIn("employe1@client.example")).get("/api/me")).json.permissions;
    expect(before).not.toContain("clientInvoices.view");
    expect((await admin.put(`/api/admin/users/${emp.id}/permissions`, { overrides: [{ key: "clientInvoices.view", effect: "allow" }, { key: "board.ticket", effect: "deny" }] })).status).toBe(200);
    const after = (await (await signIn("employe1@client.example")).get("/api/me")).json.permissions;
    expect(after).toContain("clientInvoices.view");
    expect(after).not.toContain("board.ticket");
    // a client right cannot be given to a technician
    const tech = (await admin.get("/api/admin/staff")).json.find((u: any) => u.email === "tech@akab.local");
    expect((await admin.put(`/api/admin/users/${tech.id}/permissions`, { overrides: [{ key: "clientInvoices.view", effect: "allow" }] })).status).toBe(400);
    await admin.put(`/api/admin/users/${emp.id}/permissions`, { overrides: [] });
  });
});

describe("client portal: admin settings", () => {
  it("a client admin sees their own company and its users only; others are refused", async () => {
    resetRateLimit("login:ip:unknown");
    const [me] = await db().select().from(schema.users).where(eq(schema.users.email, "responsable1@client.example"));
    await db().update(schema.clients).set({ notes: "Interne : ne pas montrer", city: "Joliette" }).where(eq(schema.clients.id, me.clientId!));
    const admin = await signIn("responsable1@client.example");
    const company = (await admin.get("/api/portal/company")).json;
    expect(company).toMatchObject({ city: "Joliette" });
    expect(JSON.stringify(company)).not.toContain("Interne");
    const users = (await admin.get("/api/portal/users")).json;
    const mates = await db().select().from(schema.users).where(eq(schema.users.clientId, me.clientId!));
    expect(users.map((u: any) => u.email).sort()).toEqual(mates.map((u) => u.email).sort());
    expect(users.find((u: any) => u.email === me.email).role).toEqual({ fr: "Administrateur client", en: "Client administrator" });
    expect(JSON.stringify(users)).not.toMatch(/password|mfa/i);

    // a plain client user, and a technician, do not have these pages
    const emp = await signIn("employe1@client.example");
    expect((await emp.get("/api/portal/company")).status).toBe(403);
    expect((await emp.get("/api/portal/users")).status).toBe(403);
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/portal/users")).status).toBe(403);
  });
});

describe("client portal: tickets", () => {
  it("a user sees their own tickets; the company scope needs its right; internal notes never shown", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const [emp] = await db().select().from(schema.users).where(eq(schema.users.email, "employe1@client.example"));
    const [company] = await db().select().from(schema.clients).where(eq(schema.clients.id, emp.clientId!));
    // the sample ticket company of this client (created by the board question test, else here)
    let co = (await tech.get("/api/tickets/companies")).json.find((x: any) => x.name === company.name);
    if (!co) {
      const owner = await signIn("responsable1@client.example");
      const msg = (await owner.get("/api/board")).json[0];
      await owner.post(`/api/board/${msg.id}/ticket`, { question: "Initialisation" });
      co = (await tech.get("/api/tickets/companies")).json.find((x: any) => x.name === company.name);
    }
    const contact = (await tech.post(`/api/tickets/companies/${co.id}/contacts`, { firstName: "Jean", lastName: "Côté", email: emp.email })).json;
    const facets = (await tech.get("/api/tickets?view=all")).json.facets;
    const base = { companyId: co.id, priority: facets.priorities[0].value, queue: facets.queues[0].value, assigneeId: null, dueDate: "2026-12-01" };
    const his = (await tech.post("/api/tickets", { ...base, title: "Écran noir au poste 3", contactId: contact.id })).json;
    const other = (await tech.post("/api/tickets", { ...base, title: "Imprimante comptabilité", contactId: null })).json;
    await tech.post(`/api/tickets/${his.id}/notes`, { text: "Pièce commandée, installation jeudi.", internal: false });
    await tech.post(`/api/tickets/${his.id}/notes`, { text: "SECRET interne: client difficile", internal: true });

    const jean = await signIn("employe1@client.example");
    const mine = (await jean.get("/api/portal/tickets")).json;
    expect(mine).toMatchObject({ linked: true, canSeeAll: false });
    expect(mine.items.map((t: any) => t.id)).toContain(his.id);
    expect(mine.items.map((t: any) => t.id)).not.toContain(other.id);
    expect((await jean.get("/api/portal/tickets?scope=company")).status).toBe(403);
    expect((await jean.get(`/api/portal/tickets/${other.id}`)).status).toBe(404);
    const detail = (await jean.get(`/api/portal/tickets/${his.id}`)).json;
    expect(detail.activity.map((n: any) => n.text)).toContain("Pièce commandée, installation jeudi.");
    expect(JSON.stringify(detail)).not.toContain("SECRET");
    expect(JSON.stringify(detail)).not.toMatch(/"hours"|internalText/);

    // the client admin sees the whole company with the filter
    const marie = await signIn("responsable1@client.example");
    const all = (await marie.get("/api/portal/tickets?scope=company")).json;
    expect(all.canSeeAll).toBe(true);
    expect(all.items.map((t: any) => t.id)).toEqual(expect.arrayContaining([his.id, other.id]));
    expect((await marie.get(`/api/portal/tickets/${other.id}`)).status).toBe(200);

    // another company never sees them; technicians use their own Tickets page
    const elsewhere = await signIn("responsable2@client.example");
    const theirs = (await elsewhere.get("/api/portal/tickets?scope=company")).json.items.map((t: any) => t.id);
    expect(theirs).not.toContain(his.id);
    expect((await elsewhere.get(`/api/portal/tickets/${his.id}`)).status).toBe(404);
    expect((await tech.get("/api/portal/tickets")).status).toBe(403);
  });
});

describe("client portal: a question asked on the board", () => {
  it("shows in the asker's own tickets, with them as the contact", async () => {
    resetRateLimit("login:ip:unknown");
    resetRateLimit("login:email:employe2@client.example"); // locked on purpose by an earlier test
    const sam = await signIn("employe2@client.example");
    const msg = (await sam.get("/api/board")).json[0];
    const r = await sam.post(`/api/board/${msg.id}/ticket`, { question: "Question de Paul" });
    expect(r.status).toBe(201);
    const mine = (await sam.get("/api/portal/tickets")).json.items;
    expect(mine.find((t: any) => t.id === r.json.id)).toMatchObject({ mine: true });
    expect((await sam.get(`/api/portal/tickets/${r.json.id}`)).json.description).toContain("Question de Paul");
  });
});

describe("client portal: working on a ticket", () => {
  it("replies, files and escalations reach the technicians; the client sees who has it open", async () => {
    resetRateLimit("login:ip:unknown");
    resetRateLimit("login:email:employe1@client.example");
    const tech = await signIn("tech@akab.local");
    const jean = await signIn("employe1@client.example");
    const mine = (await jean.get("/api/portal/tickets")).json.items;
    const tk = mine.find((t: any) => t.title === "Écran noir au poste 3");
    expect(tk).toBeTruthy();
    // the technician takes it and opens it
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    await tech.patch(`/api/tickets/${tk.id}`, { assigneeId: techRow.id });
    await tech.post(`/api/tickets/${tk.id}/presence`);
    await tech.put(`/api/tickets/${tk.id}/start-date`, { startDate: "2026-11-20" });
    const seen = (await jean.get(`/api/portal/tickets/${tk.id}`)).json;
    expect(seen.viewing).toEqual(["Alex"]);
    expect(seen.technicians).toEqual([{ name: "Alex Tremblay", primary: true, viewing: true }]);
    expect(seen).toMatchObject({ startDate: "2026-11-20", statusKind: expect.any(String) });
    expect(seen.dueAt).toMatch(/^2026-12-01/);
    // closing the ticket in the technician's window: no longer "on it"
    await tech.del(`/api/tickets/${tk.id}/presence`);
    expect((await jean.get(`/api/portal/tickets/${tk.id}`)).json.technicians[0].viewing).toBe(false);
    await tech.post(`/api/tickets/${tk.id}/presence`);

    expect((await jean.post(`/api/portal/tickets/${tk.id}/comments`, { text: "Oui, l'écran reste noir même après redémarrage." })).status).toBe(201);
    const file = { name: "photo-ecran.jpg", contentType: "image/jpeg", data: Buffer.from("fake-jpeg").toString("base64") };
    expect((await jean.post(`/api/portal/tickets/${tk.id}/attachments`, file)).status).toBe(201);
    expect((await jean.post(`/api/portal/tickets/${tk.id}/escalate`, { reason: "Tout le service est bloqué" })).status).toBe(201);
    expect((await jean.post(`/api/portal/tickets/${tk.id}/escalate`, { reason: "Encore" })).json.error).toBe("portal_already_escalated");

    const detail = (await jean.get(`/api/portal/tickets/${tk.id}`)).json;
    expect(detail.activity.map((n: any) => n.text)).toEqual(expect.arrayContaining(["Oui, l'écran reste noir même après redémarrage.", "Demande d'escalade de priorité par le client :\nTout le service est bloqué"]));
    expect(detail.activity.find((n: any) => n.text.startsWith("Oui,")).author).toBe("Jean Côté");
    expect(detail.attachments.map((f: any) => f.name)).toContain("photo-ecran.jpg");

    // the assigned technician is told, with a link to the ticket
    const feed = (await tech.get("/api/notifications")).json.items.filter((n: any) => n.type === "ticket.client" && n.data.number === tk.number);
    expect(feed.map((n: any) => n.data.kind).sort()).toEqual(["comment", "escalation", "file"]);
    expect(feed[0].link).toBe(`/tickets?ticket=${tk.id}`);
  });

  it("needs the rights, only on their tickets, and never from the client view", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const jean = await signIn("employe1@client.example");
    const [emp] = await db().select().from(schema.users).where(eq(schema.users.email, "employe1@client.example"));
    const tk = (await jean.get("/api/portal/tickets")).json.items[0];
    await admin.put(`/api/admin/users/${emp.id}/permissions`, { overrides: [{ key: "clientTickets.comment", effect: "deny" }] });
    expect((await jean.post(`/api/portal/tickets/${tk.id}/comments`, { text: "x" })).status).toBe(403);
    await admin.put(`/api/admin/users/${emp.id}/permissions`, { overrides: [] });
    const other = await signIn("responsable2@client.example");
    expect((await other.post(`/api/portal/tickets/${tk.id}/comments`, { text: "x" })).status).toBe(404);
    expect((await admin.post("/api/view-as", { clientId: emp.clientId })).status).toBe(200);
    expect((await admin.post(`/api/portal/tickets/${tk.id}/comments`, { text: "x" })).json.error).toBe("read_only_view");
    await admin.del("/api/view-as");
  });
});

describe("client portal: whose tickets", () => {
  it("a ticket is mine when I opened it or I am one of its other contacts; the company filter can pick one contact", async () => {
    resetRateLimit("login:ip:unknown");
    resetRateLimit("login:email:employe1@client.example");
    const { setDemoOtherContacts } = await import("../server/lib/demoTickets.ts");
    const marie = await signIn("responsable1@client.example");
    const company = (await marie.get("/api/portal/tickets?scope=company")).json;
    const jeanContact = company.contacts.find((x: any) => x.name === "Jean Côté");
    expect(jeanContact).toBeTruthy();
    const printer = company.items.find((t: any) => t.title === "Imprimante comptabilité");

    const jean = await signIn("employe1@client.example");
    const before = (await jean.get("/api/portal/tickets")).json;
    expect(before.contacts).toEqual([]); // the contact list is only for whom may see everyone's tickets
    expect(before.items.map((t: any) => t.id)).not.toContain(printer.id);
    // Jean is added as one of the other contacts of the printer ticket
    setDemoOtherContacts(printer.id, [jeanContact.id]);
    const after = (await jean.get("/api/portal/tickets")).json.items;
    expect(after.find((t: any) => t.id === printer.id)).toMatchObject({ mine: true });
    expect((await jean.get(`/api/portal/tickets/${printer.id}`)).status).toBe(200);

    // Marie picks Jean in the filter: the tickets he opened and the ones he is on
    const his = (await marie.get(`/api/portal/tickets?scope=contact&contact=${jeanContact.id}`)).json.items.map((t: any) => t.title);
    expect(his).toEqual(expect.arrayContaining(["Écran noir au poste 3", "Imprimante comptabilité"]));
    // without the right, or with another company's contact: refused
    expect((await jean.get(`/api/portal/tickets?scope=contact&contact=${jeanContact.id}`)).status).toBe(403);
    const other = await signIn("responsable2@client.example");
    expect((await other.get(`/api/portal/tickets?scope=contact&contact=${jeanContact.id}`)).status).toBe(404);
    setDemoOtherContacts(printer.id, []);
  });
});

describe("Stripe card payments (Accounting › Paiements)", () => {
  const SECRET = "whsec_testsecret123";
  /** The webhook as Stripe sends it: the raw body signed with the endpoint secret */
  const hook = async (event: unknown, opts: { secret?: string; at?: number; header?: string } = {}) => {
    const raw = JSON.stringify(event);
    const t = String(opts.at ?? Math.floor(Date.now() / 1000));
    const sig = nodeCrypto.createHmac("sha256", opts.secret ?? SECRET).update(`${t}.${raw}`).digest("hex");
    const res = await app.request("/api/stripe/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": opts.header ?? `t=${t},v1=${sig}` },
      body: raw,
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const session = (id: string, extra: Record<string, unknown> = {}) => ({ id, object: "checkout.session", livemode: false, currency: "cad", payment_intent: `pi_${id}`, ...extra });
  const event = (type: string, object: unknown) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });

  it("makes a payment link, records the payment from Stripe's signed webhook, once", async () => {
    const admin = await signIn("admin@akab.local");
    const [garage] = await db().select().from(schema.clients).limit(1);
    const [inv] = await db().insert(schema.clientInvoices).values({ clientId: garage.id, number: "S-1001", issuedOn: "2026-10-01", dueOn: "2026-10-31", totalCents: 114975, source: "portal" }).returning();

    // nothing set up: no link (earlier tests may have saved keys)
    await db().delete(schema.integrations).where(eq(schema.integrations.provider, "stripe"));
    expect((await admin.get("/api/billing/payments/status")).json).toMatchObject({ ready: false });
    expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id })).json.error).toBe("stripe_not_configured");

    // keys saved, but no webhook secret yet: still no link (a payment would never reach the invoice)
    expect((await admin.put("/api/billing/stripe", { enabled: true, publishableKey: "pk_test_abc", secretKey: "sk_test_abc123" })).status).toBe(200);
    expect((await admin.get("/api/billing/payments/status")).json).toMatchObject({ ready: true, mode: "test", hasWebhookSecret: false });
    expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id })).json.error).toBe("stripe_no_webhook_secret");
    expect((await admin.put("/api/billing/stripe", { webhookSecret: SECRET })).status).toBe(200);
    expect((await admin.get("/api/billing/payments/status")).json).toMatchObject({ hasWebhookSecret: true, webhookUrl: "http://localhost/api/stripe/hook", minCents: 50 });

    // the amount: a part of the balance, never more, at least 0,50 $
    expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id, amountCents: 0 })).status).toBe(400);
    expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id, amountCents: 114976 })).json.error).toBe("stripe_amount");
    expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id, amountCents: 49 })).json.error).toBe("stripe_amount");

    const calls: { url: string; auth: string | null; body: URLSearchParams }[] = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: new URLSearchParams(String(init?.body ?? "")) });
        n++;
        return new Response(JSON.stringify({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, livemode: false, expires_at: Math.floor(Date.now() / 1000) + 82_800 }), { headers: { "content-type": "application/json" } });
      }),
    );
    try {
      const first = await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id, amountCents: 50000 });
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ url: "https://checkout.stripe.com/c/pay/cs_test_1", amountCents: 50000, live: false });
      // what was asked of Stripe: the exact amount in CAD, tied to the invoice, with the secret key
      expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
      expect(calls[0].auth).toBe("Bearer sk_test_abc123");
      expect(Object.fromEntries(calls[0].body)).toMatchObject({
        mode: "payment",
        "line_items[0][price_data][currency]": "cad",
        "line_items[0][price_data][unit_amount]": "50000",
        "line_items[0][quantity]": "1",
        "metadata[invoice_id]": inv.id,
        "metadata[invoice_number]": "S-1001",
        success_url: "http://localhost/paiement-recu",
        cancel_url: "http://localhost/paiement-recu?annule=1",
      });
      const listed = (await admin.get("/api/billing/payments/checkouts")).json;
      expect(listed[0]).toMatchObject({ id: first.json.id, number: "S-1001", status: "open", amountCents: 50000, url: first.json.url });

      // Stripe's call, checked: another secret, an old signature, no signature
      const paid = event("checkout.session.completed", session("cs_test_1", { payment_status: "paid", amount_total: 50000 }));
      expect((await hook(paid, { secret: "whsec_other" })).status).toBe(400);
      expect((await hook(paid, { at: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
      expect((await hook(paid, { header: "" })).status).toBe(400);
      expect((await admin.get("/api/crm/invoices?q=S-1001")).json.items[0]).toMatchObject({ paidCents: 0, balanceCents: 114975 });

      // paid: recorded on the invoice, as a Stripe payment
      expect(await hook(paid)).toMatchObject({ status: 200, json: { result: "paid" } });
      expect((await admin.get("/api/crm/invoices?q=S-1001")).json.items[0]).toMatchObject({ paidCents: 50000, balanceCents: 64975, status: "partial" });
      const [pay] = await db().select().from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, inv.id));
      expect(pay).toMatchObject({ amountCents: 50000, method: "stripe", source: "stripe", reference: "pi_cs_test_1", externalId: "stripe:cs_test_1" });
      expect((await admin.get("/api/billing/payments/checkouts")).json[0]).toMatchObject({ status: "paid", url: null });
      // Stripe sends events again: nothing is counted twice
      expect(await hook(paid)).toMatchObject({ status: 200, json: { result: "ignored" } });
      expect((await db().select().from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, inv.id))).length).toBe(1);
      // a session this portal did not make is not ours
      expect((await hook(event("checkout.session.completed", session("cs_other", { payment_status: "paid", amount_total: 999 })))).json.result).toBe("ignored");

      // the rest, paid by bank debit: confirmed later
      const second = await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id });
      expect(second.json.amountCents).toBe(64975);
      expect((await hook(event("checkout.session.completed", session("cs_test_2", { payment_status: "unpaid", amount_total: 64975 })))).json.result).toBe("waiting");
      expect((await admin.get("/api/crm/invoices?q=S-1001")).json.items[0].balanceCents).toBe(64975);
      expect((await hook(event("checkout.session.async_payment_succeeded", session("cs_test_2", { payment_status: "paid", amount_total: 64975 })))).json.result).toBe("paid");
      expect((await admin.get("/api/crm/invoices?q=S-1001")).json.items[0]).toMatchObject({ balanceCents: 0, status: "paid" });
      // nothing left to pay
      expect((await admin.post("/api/billing/payments/checkouts", { invoiceId: inv.id })).json.error).toBe("stripe_nothing_to_pay");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes a link, takes failures and expiry from Stripe, and is for accounting rights only", async () => {
    const admin = await signIn("admin@akab.local");
    const [inv] = await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.number, "S-1001"));
    const [other] = await db().insert(schema.clientInvoices).values({ clientId: inv.clientId, number: "S-1002", issuedOn: "2026-10-02", totalCents: 20000, source: "portal" }).returning();
    const asked: string[] = [];
    let n = 100;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        asked.push(String(url));
        n++;
        return new Response(JSON.stringify({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, livemode: false, expires_at: Math.floor(Date.now() / 1000) + 82_800 }), { headers: { "content-type": "application/json" } });
      }),
    );
    try {
      const a = (await admin.post("/api/billing/payments/checkouts", { invoiceId: other.id })).json;
      const b = (await admin.post("/api/billing/payments/checkouts", { invoiceId: other.id, amountCents: 5000 })).json;
      const c = (await admin.post("/api/billing/payments/checkouts", { invoiceId: other.id, amountCents: 6000 })).json;
      const status = async () => (await admin.get("/api/billing/payments/checkouts")).json.reduce((m: any, x: any) => ({ ...m, [x.id]: x.status }), {});

      // closed by hand: Stripe is told, and the link no longer shows
      expect((await admin.post(`/api/billing/payments/checkouts/${a.id}/expire`)).json).toMatchObject({ ok: true, status: "expired" });
      expect(asked.at(-1)).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_101/expire");
      expect((await status())[a.id]).toBe("expired");
      // Stripe says another expired, and that a bank debit failed
      await hook(event("checkout.session.expired", session("cs_test_102")));
      await hook(event("checkout.session.async_payment_failed", session("cs_test_103")));
      expect(await status()).toMatchObject({ [a.id]: "expired", [b.id]: "expired", [c.id]: "failed" });

      // rights: view alone sees but cannot make or close links; no accounting right sees nothing
      const tech = await signIn("tech@akab.local");
      expect((await tech.get("/api/billing/payments/status")).status).toBe(403);
      const staff = (await admin.get("/api/admin/staff")).json;
      const techUser = staff.find((u: any) => u.email === "tech@akab.local");
      await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [{ key: "accounting.view", effect: "allow" }] });
      const viewer = await signIn("tech@akab.local");
      expect((await viewer.get("/api/billing/payments/checkouts")).status).toBe(200);
      expect((await viewer.post("/api/billing/payments/checkouts", { invoiceId: other.id })).status).toBe(403);
      expect((await viewer.post(`/api/billing/payments/checkouts/${a.id}/expire`)).status).toBe(403);
      // Stripe's keys stay for master administrators
      expect((await viewer.get("/api/billing/stripe")).status).toBe(403);
      await admin.put(`/api/admin/users/${techUser.id}/permissions`, { overrides: [] });
      expect((await new Agent().post("/api/billing/payments/checkouts", { invoiceId: other.id })).status).toBe(401);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("local devices (made in the portal)", () => {
  it("a device the RMM does not know is created, listed with the synced ones and linked to a ticket", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const before = (await tech.get("/api/tickets/companies/300/assets")).json;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((a: any) => a.origin === "rmm")).toBe(true);

    expect((await tech.post("/api/tickets/companies/300/assets", { name: "" })).status).toBe(400);
    const made = await tech.post("/api/tickets/companies/300/assets", { name: "PC-COMPTA-01", type: "Poste", hostname: "pc-compta-01" });
    expect(made.status).toBe(201);
    expect(made.json.origin).toBe("local");
    expect(made.json.id).toMatch(/^local:/);
    const after = (await tech.get("/api/tickets/companies/300/assets")).json;
    expect(after.length).toBe(before.length + 1);
    // another company does not see it
    expect((await tech.get("/api/tickets/companies/301/assets")).json.some((a: any) => a.id === made.json.id)).toBe(false);

    const t = await tech.post("/api/tickets", { title: "Appareil local", companyId: 300, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    const id = t.json.id;
    expect((await tech.patch(`/api/tickets/${id}`, { assetId: "local:00000000-0000-0000-0000-000000000000" })).status).toBeGreaterThanOrEqual(400);
    expect((await tech.patch(`/api/tickets/${id}`, { assetId: made.json.id })).status).toBe(200);
    const d = (await tech.get(`/api/tickets/${id}`)).json;
    expect(d.assetId).toBe(made.json.id);
    expect(d.asset.origin).toBe("local");
    // picking a synced device (or none) takes the local one off
    expect((await tech.patch(`/api/tickets/${id}`, { assetId: before[0].id })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${id}`)).json.asset.origin).toBe("rmm");
  });
});

describe("client classifications and the client's hours", () => {
  it("admins manage the classes; a client carries one; the ticket shows it with this month's hours", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const start = (await admin.get("/api/admin/client-classes")).json;
    expect(start.map((k: any) => k.key)).toEqual(["break-fix", "msp", "bronze", "silver", "gold"]);
    // technicians read them, only admins change them
    expect((await tech.get("/api/admin/client-classes")).status).toBe(200);
    expect((await tech.post("/api/admin/client-classes", { name: "X" })).status).toBe(403);
    const made = await admin.post("/api/admin/client-classes", { name: "Platine", color: "violet" });
    expect(made.status).toBe(201);
    expect((await admin.post("/api/admin/client-classes", { name: "platine" })).json.error).toBe("class_exists");
    expect((await admin.post("/api/admin/client-classes", { name: "Z", color: "pink" })).status).toBe(400);
    expect((await admin.patch("/api/admin/client-classes/platine", { name: "Platine +" })).status).toBe(200);
    expect((await admin.post("/api/admin/client-classes/platine/move", { direction: "up" })).status).toBe(200);

    // a client carries one (CRM), an unknown one is refused
    const clients = (await admin.get("/api/crm/clients")).json;
    const list = clients.items ?? clients;
    const c = list.find((x: any) => x.autotaskId === 300);
    expect((await admin.patch(`/api/crm/clients/${c.id}`, { classKey: "nope" })).status).toBe(400);
    expect((await admin.patch(`/api/crm/clients/${c.id}`, { classKey: "platine" })).json.classKey).toBe("platine");

    // the ticket view: the class, and hours counted from this month's time entries of the client's tickets
    const t = (await admin.get("/api/tickets?view=all")).json.items.find((x: any) => x.company.id === 300);
    const detail = (await admin.get(`/api/tickets/${t.id}`)).json;
    expect(detail.client.class).toMatchObject({ key: "platine", name: "Platine +", color: "violet" });
    const hoursBefore = detail.client.hours;
    expect(detail.client.goal).toBeNull();
    await admin.post(`/api/tickets/${t.id}/timer/start`, {});
    const timers = (await admin.get("/api/tickets/timers")).json;
    const mine = (timers.timers ?? timers.items ?? timers).find((x: any) => (x.ticketId ?? x.ticket?.id) === t.id);
    expect((await admin.post(`/api/tickets/timers/${mine.id}/submit`, { hours: 2.5, summary: "Test" })).status).toBe(201);
    expect((await admin.get(`/api/tickets/${t.id}`)).json.client.hours).toBe(hoursBefore + 2.5);

    // deleting a class leaves its clients without one
    expect((await admin.del("/api/admin/client-classes/platine")).status).toBe(200);
    expect((await admin.get(`/api/tickets/${t.id}`)).json.client.class).toBeNull();
  });
});

describe("a contact's open tickets", () => {
  it("lists the last five open tickets of a contact, newest first, without the one being viewed", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const all = (await tech.get("/api/tickets?view=all")).json.items;
    const contactId = all.find((t: any) => t.contactId && all.filter((x: any) => x.contactId === t.contactId).length > 1)?.contactId;
    expect(contactId).toBeTruthy();
    const r = (await tech.get(`/api/tickets/contacts/${contactId}/open`)).json;
    expect(r.items.length).toBeLessThanOrEqual(5);
    expect(r.total).toBeGreaterThanOrEqual(r.items.length);
    expect(r.items.every((x: any) => x.statusKind !== "complete")).toBe(true);
    const dates = r.items.map((x: any) => x.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    const skip = r.items[0].id;
    expect((await tech.get(`/api/tickets/contacts/${contactId}/open?exclude=${skip}`)).json.items.some((x: any) => x.id === skip)).toBe(false);
  });
});

describe("estimated time to resolve", () => {
  it("a technician sets, changes and clears it; the ticket detail carries it; the AI estimate needs the AI", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const t = (await tech.get("/api/tickets?view=all")).json.items[0];
    expect((await tech.get(`/api/tickets/${t.id}`)).json.estimate).toBeNull();
    expect((await tech.put(`/api/tickets/${t.id}/estimate`, { minutes: 0 })).status).toBe(400);
    expect((await tech.put(`/api/tickets/${t.id}/estimate`, { minutes: 45 })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${t.id}`)).json.estimate).toEqual({ minutes: 45, source: "tech" });
    expect((await tech.put(`/api/tickets/${t.id}/estimate`, { minutes: 90 })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${t.id}`)).json.estimate.minutes).toBe(90);
    // not configured here: refused, nothing changes
    const ai = await tech.post(`/api/tickets/${t.id}/ai/estimate`, {});
    expect(ai.status).toBeGreaterThanOrEqual(400);
    expect((await tech.get(`/api/tickets/${t.id}`)).json.estimate.minutes).toBe(90);
    expect((await tech.put(`/api/tickets/${t.id}/estimate`, { minutes: null })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${t.id}`)).json.estimate).toBeNull();
  });
});

describe("contracts: default support contract, billing modes and rates", () => {
  it("a client has a default contract; billing modes and rates are set; a ticket and its time follow its contract", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const clients = (await admin.get("/api/crm/clients")).json;
    const client = (clients.items ?? clients).find((x: any) => x.autotaskId === 300);
    const contracts = (await admin.get(`/api/crm/clients/${client.id}/contracts`)).json;
    expect(contracts.length).toBeGreaterThan(1);
    expect(contracts.filter((k: any) => k.isSupportDefault && k.active).length).toBe(1);
    expect(contracts.every((k: any) => k.billingMode === "hourly" && k.hourlyRateCents === null && k.usualRateCents > 0)).toBe(true);

    // technicians cannot change billing; an admin picks the default, a mode and rates
    const [first, second] = contracts.filter((k: any) => k.active);
    expect((await tech.patch(`/api/crm/clients/${client.id}/contracts/${second.id}`, { billingMode: "none" })).status).toBe(403);
    expect((await admin.patch(`/api/crm/clients/${client.id}/contracts/${second.id}`, { billingMode: "weekly" })).status).toBe(400);
    expect((await admin.patch(`/api/crm/clients/${client.id}/contracts/${second.id}`, { supportDefault: true, hourlyRate: 135 })).status).toBe(200);
    const after = (await admin.get(`/api/crm/clients/${client.id}/contracts`)).json;
    expect(after.filter((k: any) => k.isSupportDefault).map((k: any) => k.id)).toEqual([second.id]);
    expect(after.find((k: any) => k.id === second.id).hourlyRateCents).toBe(13500);

    // a ticket of the client: its contract is the default one, changeable; an unknown one is refused
    const t = (await tech.get("/api/tickets?view=all")).json.items.find((x: any) => x.company.id === 300);
    let d = (await tech.get(`/api/tickets/${t.id}`)).json;
    expect(d.contract.id).toBe(second.id);
    expect(d.contract.rateCents).toBe(13500);
    expect(d.contracts.length).toBe(after.filter((k: any) => k.active).length);
    expect((await tech.put(`/api/tickets/${t.id}/contract`, { contractId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await tech.put(`/api/tickets/${t.id}/contract`, { contractId: first.id })).status).toBe(200);
    d = (await tech.get(`/api/tickets/${t.id}`)).json;
    expect(d.contract.id).toBe(first.id);
    // no own rate: the usual one of Admin › Facturation
    expect(d.contract.rateCents).toBe(first.usualRateCents);

    // a contract that does not bill by the hour: its time is never billable
    expect((await admin.patch(`/api/crm/clients/${client.id}/contracts/${first.id}`, { billingMode: "none" })).status).toBe(200);
    d = (await tech.get(`/api/tickets/${t.id}`)).json;
    expect(d.contract.billed).toBe(false);
    expect(d.contract.rateCents).toBeNull();
    await tech.post(`/api/tickets/${t.id}/timer/start`, {});
    const timers = (await tech.get("/api/tickets/timers")).json;
    const mine = (timers.timers ?? timers.items ?? timers).find((x: any) => (x.ticketId ?? x.ticket?.id) === t.id);
    expect((await tech.post(`/api/tickets/timers/${mine.id}/submit`, { hours: 1, summary: "Inclus", billable: true, contractId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await tech.post(`/api/tickets/timers/${mine.id}/submit`, { hours: 1, summary: "Inclus", billable: true, contractId: first.id })).status).toBe(201);
  });
});

describe("ticket sources, statuses and the manual sync (Admin › Billets)", () => {
  it("sources: phone by hand, the email one from an email; admins manage them", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/admin/ticket-setup/sources")).status).toBe(403);
    const list = (await admin.get("/api/admin/ticket-setup/sources")).json;
    expect(list.map((s: any) => s.key)).toEqual(["phone", "sms", "email", "in-person"]);
    // what the tickets pages offer
    expect((await tech.get("/api/tickets")).json.facets.sources.map((s: any) => s.value)).toEqual(["phone", "sms", "email", "in-person"]);

    const make = (source?: string) => tech.post("/api/tickets", { title: `Source ${source ?? "défaut"}`, companyId: 300, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01", ...(source ? { source } : {}) });
    const byHand = await make();
    expect(byHand.status).toBe(201);
    expect((await tech.get(`/api/tickets/${byHand.json.id}`)).json.source).toBe("phone");
    const fromMail = await make("email");
    expect((await tech.get(`/api/tickets/${fromMail.json.id}`)).json.source).toBe("email");
    expect((await make("nope")).status).toBeGreaterThanOrEqual(400);
    // changed afterwards
    expect((await tech.patch(`/api/tickets/${byHand.json.id}`, { source: "in-person" })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${byHand.json.id}`)).json.source).toBe("in-person");

    const made = await admin.post("/api/admin/ticket-setup/sources", { name: "Portail client" });
    expect(made.status).toBe(201);
    expect((await admin.post("/api/admin/ticket-setup/sources", { name: "portail client" })).json.error).toBe("source_exists");
    expect((await admin.patch("/api/admin/ticket-setup/sources/portail-client", { name: "Portail" })).status).toBe(200);
    expect((await admin.post("/api/admin/ticket-setup/sources/portail-client/move", { direction: "up" })).status).toBe(200);
    // deleting one sends its tickets back to the usual way
    expect((await admin.del("/api/admin/ticket-setup/sources/in-person")).status).toBe(200);
    expect((await tech.get(`/api/tickets/${byHand.json.id}`)).json.source).not.toBe("in-person");
    expect((await admin.del("/api/admin/ticket-setup/sources/portail-client")).status).toBe(200);
  });

  it("statuses: renamed, retyped, ordered and hidden over the source's list; one closing status stays", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    expect((await tech.get("/api/admin/ticket-setup/statuses")).status).toBe(403);
    const { items, kinds } = (await admin.get("/api/admin/ticket-setup/statuses")).json;
    expect(kinds).toContain("complete");
    expect(items.length).toBeGreaterThan(3);
    const put = (rows: any[]) => admin.put("/api/admin/ticket-setup/statuses", { items: rows.map((r: any) => ({ value: r.value, label: r.label === r.sourceLabel ? null : r.label, kind: r.kind === r.sourceKind ? null : r.kind, hidden: r.hidden })) });
    const [first, second, ...rest] = items;
    const inProgress = items.find((s: any) => s.kind === "inProgress");
    // renamed + the order changed + one hidden
    const next = [second, { ...first, label: "À traiter" }, ...rest].map((r: any) => (r.value === inProgress.value ? { ...r, hidden: true } : r));
    expect((await put(next)).status).toBe(200);
    const o = (await tech.get("/api/tickets")).json.facets.statuses;
    expect(o[0].value).toBe(second.value);
    expect(o.find((s: any) => s.value === first.value).label).toBe("À traiter");
    expect(o.find((s: any) => s.value === inProgress.value).hidden).toBe(true);
    // unknown status refused; hiding every closing status refused
    expect((await put([{ value: "nope", label: null, kind: null, hidden: false, sourceLabel: "", sourceKind: "other" }])).status).toBe(400);
    const noClose = next.map((r: any) => (r.kind === "complete" ? { ...r, hidden: true } : r));
    expect((await put(noClose)).json.error).toBe("status_no_complete");
    // back as it was
    expect((await put(items)).status).toBe(200);
  });

});

describe("tickets from the support mailbox (Admin › Courriel entrant)", () => {
  it("a known sender opens a ticket once; a domain finds the client; strangers wait; a ticket number is a reply; machines are skipped", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const { processIncoming } = await import("../server/lib/mailIntake.ts");
    // the CRM copy (clients and contacts) is what the domain match reads
    const clients = (await admin.get("/api/crm/clients")).json;
    const client = (clients.items ?? clients).find((x: any) => x.autotaskId === 300);
    const contacts = (await admin.get(`/api/crm/clients/${client.id}/contacts`)).json;
    const known = contacts.find((x: any) => x.email);
    expect(known).toBeTruthy();
    const domain = known.email.split("@")[1];
    const mail = (id: string, from: string | null, subject: string, text = "Bonjour,\nLe poste ne démarre plus.") => ({
      id,
      mailbox: "support@akab.ca",
      subject,
      from: from ? { name: "Quelqu'un", address: from } : null,
      receivedAt: new Date().toISOString(),
      text,
    });

    // their contact: a ticket for them, once
    const first = await processIncoming(mail("m-1", known.email, "RE: Imprimante en panne"));
    expect(first.outcome).toBe("ticket");
    const detail = (await tech.get(`/api/tickets/${first.ticket!.id}`)).json;
    expect(detail.title).toBe("Imprimante en panne");
    expect(detail.description).toContain("Le poste ne démarre plus.");
    expect(detail.company.id).toBe(300);
    expect(detail.source).toBe("email");
    expect((await processIncoming(mail("m-1", known.email, "RE: Imprimante en panne"))).outcome).toBe("duplicate");

    // a new address on the same domain: the client is found, no contact
    const viaDomain = await processIncoming(mail("m-2", `nouveau.employe@${domain}`, "Nouvel employé"));
    expect(viaDomain.outcome).toBe("ticket");
    const d2 = (await tech.get(`/api/tickets/${viaDomain.ticket!.id}`)).json;
    expect(d2.company.id).toBe(300);
    expect(d2.contactId).toBeNull();

    // their name (another address), or their phone number written in the email: the contact is found
    // (a contact whose name and phone are theirs alone: the sample ones repeat between clients)
    expect((await admin.post(`/api/crm/clients/${client.id}/contacts`, { firstName: "Zoé", lastName: "Quantique", email: "zoe@quantique-inc.test", phone: "450-555-9123" })).status).toBe(201);
    const named = await processIncoming({ ...mail("m-3a", "autre.adresse@exemple-inconnu.org", "Même personne"), from: { name: "Quantique, Zoé", address: "autre.adresse@exemple-inconnu.org" } });
    expect(named.outcome).toBe("ticket");
    const nd = (await tech.get(`/api/tickets/${named.ticket!.id}`)).json;
    expect(nd.company.id).toBe(300);
    expect(nd.contact).toBe("Zoé Quantique");
    const byPhone = await processIncoming(mail("m-3b", "quelquun@exemple-inconnu.org", "Par téléphone", "Bonjour,\nRappelez-moi au (450) 555-9123, merci."));
    expect(byPhone.outcome).toBe("ticket");
    expect((await tech.get(`/api/tickets/${byPhone.ticket!.id}`)).json.contact).toBe("Zoé Quantique");

    // a stranger: the ticket is opened for AKAB itself, flagged, to be changed later
    const stranger = await processIncoming(mail("m-3", "inconnu@exemple-inconnu.org", "Besoin d'aide"));
    expect(stranger.outcome).toBe("ticket");
    const sd = (await tech.get(`/api/tickets/${stranger.ticket!.id}`)).json;
    expect(sd.company.name).toMatch(/akab/i);
    expect(sd.description).toContain("Expéditeur non reconnu");
    expect(sd.description).toContain("inconnu@exemple-inconnu.org");
    expect(sd.source).toBe("email");

    // naming a ticket: the client's message on it, the ticket needs attention
    const reply = await processIncoming(mail("m-4", known.email, `RE: [${first.ticket!.number}] Imprimante en panne`, "C'est revenu, merci."));
    expect(reply.outcome).toBe("reply");
    expect(reply.ticket!.id).toBe(first.ticket!.id);
    const after = (await tech.get(`/api/tickets/${first.ticket!.id}`)).json;
    expect(after.notes.some((n: any) => n.text.includes("C'est revenu, merci."))).toBe(true);

    // machines and loops
    expect((await processIncoming(mail("m-5", "no-reply@service.com", "Votre facture"))).outcome).toBe("skipped");
    expect((await processIncoming(mail("m-6", known.email, "Réponse automatique : absent"))).outcome).toBe("skipped");
    expect((await processIncoming(mail("m-7", "support@akab.ca", "Boucle"))).outcome).toBe("skipped");
    expect((await processIncoming(mail("m-8", null, "Sans expéditeur"))).outcome).toBe("skipped");

    // the settings: master admins only, off by default, needs Microsoft 365
    expect((await tech.get("/api/admin/mail-intake")).status).toBe(403);
    const s = (await admin.get("/api/admin/mail-intake")).json;
    expect(s).toMatchObject({ enabled: false, mailbox: "", markRead: true, replies: true, o365Ready: false });
    expect(s.counts.ticket).toBeGreaterThanOrEqual(2);
    expect((await admin.put("/api/admin/mail-intake", { enabled: true })).json.error).toBe("intake_no_mailbox");
    expect((await admin.put("/api/admin/mail-intake", { enabled: true, mailbox: "support@akab.ca" })).json.error).toBe("intake_no_o365");
    expect((await admin.post("/api/admin/mail-intake/run", {})).json.error).toBe("intake_off");
  });
});

describe("unassigned and new tickets leave out monitoring alerts", () => {
  it("the unassigned view and the New tile skip the alerts queue; New = new status and nobody on it", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    // an alert nobody has taken, and an ordinary new ticket nobody has taken
    const make = (title: string, queue: string) => tech.post("/api/tickets", { title, companyId: 300, priority: "medium", queue, assigneeId: null, dueDate: "2026-12-01" });
    const alert = await make("Alerte disque plein", "alerts");
    const plain = await make("Demande ordinaire", "support");
    expect(alert.status).toBe(201);
    const before = (await tech.get("/api/tickets?view=unassigned")).json;
    expect(before.items.some((x: any) => x.id === alert.json.id)).toBe(false);
    expect(before.items.some((x: any) => x.id === plain.json.id)).toBe(true);
    expect(before.items.every((x: any) => x.queue !== "alerts")).toBe(true);
    // still reachable as alerts
    expect((await tech.get("/api/tickets?view=all&alerts=1")).json.items.some((x: any) => x.id === alert.json.id)).toBe(true);

    // New: new status, nobody on it
    const fresh = (await tech.get("/api/tickets?view=unassigned&statusKind=new")).json;
    expect(fresh.items.every((x: any) => x.statusKind === "new" && !x.assignee && x.queue !== "alerts")).toBe(true);
    expect(fresh.metrics.fresh).toBeGreaterThanOrEqual(fresh.items.length);
    expect(fresh.metrics.fresh).toBeLessThanOrEqual(fresh.metrics.unassigned);
    expect(fresh.items.some((x: any) => x.id === plain.json.id)).toBe(true);
    expect(admin).toBeTruthy();
  });
});

describe("tickets owned by the portal (Admin › Billets)", () => {
  afterAll(async () => {
    const local = await import("../server/lib/localTickets.ts");
    await db().delete(schema.integrations).where(eq(schema.integrations.provider, "tickets"));
    await db().delete(schema.tickets);
    await db().delete(schema.deletedTickets);
    local.resetTicketMode();
  });

  it("switch: tickets are copied with their notes and time; new ones are the portal's; a deleted one is gone from lists and the meeting numbers", async () => {
    resetRateLimit("login:ip:unknown");
    const local = await import("../server/lib/localTickets.ts");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    // sample data: nothing can be deleted
    const first = (await admin.get("/api/tickets?view=all")).json.items[0];
    const refused = await admin.del(`/api/tickets/${first.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("tickets_not_local");

    // the portal's own tickets (development: chosen in the tickets integration row)
    await db()
      .insert(schema.integrations)
      .values({ provider: "tickets", enabled: true, config: { mode: "local" } })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: { mode: "local" } } });
    local.resetTicketMode();
    expect((await admin.get("/api/tickets?view=all")).json.items).toEqual([]);

    // a new ticket: the portal's own id and number; notes and time are the portal's
    const made = await tech.post("/api/tickets", { title: "Billet du portail", description: "Test local", companyId: 300, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-01-05" });
    expect(made.status).toBe(201);
    const id = made.json.id;
    expect(id).toBeGreaterThanOrEqual(1_000_000_000);
    const mine = (await tech.get(`/api/tickets/${id}`)).json;
    expect(mine.number).toMatch(/^T\d{8}\.\d{4}$/);
    expect((await tech.post(`/api/tickets/${id}/notes`, { text: "Premier suivi", internal: false })).status).toBe(201);
    expect((await tech.post(`/api/tickets/${id}/notes`, { text: "Note interne", internal: true })).status).toBe(201);
    expect((await tech.get(`/api/tickets/${id}`)).json.notes.map((n: any) => [n.text, n.internal])).toEqual([["Premier suivi", false], ["Note interne", true]]);
    // status and assignee changes are kept (and a complete status sets the completion)
    expect((await tech.patch(`/api/tickets/${id}`, { priority: "high" })).status).toBe(200);
    expect((await tech.get(`/api/tickets/${id}`)).json.priority).toBe("high");

    // it is overdue (due in the past): counted in the weekly meeting
    const overdueWith = (await admin.get("/api/meetings/overdue")).json;
    const listed = (r: any) => [...r.technicians.flatMap((p: any) => p.tickets), ...r.unassigned].map((t: any) => t.id);
    expect(listed(overdueWith)).toContain(id);
    const trendsWith = (await admin.get("/api/meetings/trends?weeks=8")).json;
    const createdWith = [trendsWith.weeks[0].created, trendsWith.live.created];

    // only the right to delete; then it is gone for good
    const refusedTech = await tech.del(`/api/tickets/${id}`);
    expect(refusedTech.status).toBe(403);
    const gone = await admin.del(`/api/tickets/${id}`);
    expect(gone.status).toBe(200);
    expect(gone.json).toMatchObject({ ok: true, number: mine.number });
    expect((await admin.get(`/api/tickets/${id}`)).status).toBe(404);
    expect((await admin.get("/api/tickets?view=all")).json.items.some((t: any) => t.id === id)).toBe(false);
    // …and out of every count: the overdue gauge, the trends
    expect(listed((await admin.get("/api/meetings/overdue")).json)).not.toContain(id);
    expect((await admin.get("/api/meetings/overdue")).json.total).toBe(overdueWith.total - 1);
    const trendsWithout = (await admin.get("/api/meetings/trends?weeks=8")).json;
    expect([trendsWithout.weeks[0].created, trendsWithout.live.created]).toEqual(createdWith.map((n: number) => n - 1));
    expect((await admin.del(`/api/tickets/${id}`)).status).toBe(404);
    const audited = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "ticket.deleted"));
    expect(audited.some((x) => x.target === String(id))).toBe(true);
  });
});

describe("the portal on its own: no Autotask, no sample data", () => {
  afterAll(async () => {
    const local = await import("../server/lib/localTickets.ts");
    await db().delete(schema.integrations).where(eq(schema.integrations.provider, "tickets"));
    await db().delete(schema.tickets);
    await db().delete(schema.clients).where(eq(schema.clients.name, "Client Autonome inc."));
    local.resetTicketMode();
  });

  it("clients, contacts and tickets live in the database; a sync never touches them; the badge says so", async () => {
    resetRateLimit("login:ip:unknown");
    const local = await import("../server/lib/localTickets.ts");
    const { ticketSource } = await import("../server/lib/ticketSource.ts");
    const { syncCrm } = await import("../server/lib/crm.ts");
    const admin = await signIn("admin@akab.local");
    await db().delete(schema.tickets);
    await db()
      .insert(schema.integrations)
      .values({ provider: "tickets", enabled: true, config: { mode: "local", switchedAt: new Date().toISOString() } })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: { mode: "local", switchedAt: new Date().toISOString() } } });
    local.resetTicketMode();

    // not the sample source, and no tickets made up
    const src = await ticketSource();
    expect(src.demo).toBe(false);
    expect(await src.list()).toEqual([]);

    // a client, a contact and a ticket made in the portal
    const made = await admin.post("/api/crm/clients", { name: "Client Autonome inc.", phone: "450-555-0188" });
    expect(made.status).toBe(201);
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.name, "Client Autonome inc."));
    expect(client.autotaskId).toBeGreaterThanOrEqual(1_000_000_000);
    const c = await admin.post(`/api/crm/clients/${client.id}/contacts`, { firstName: "Lou", lastName: "Autonome", email: "lou@autonome.test" });
    expect(c.status).toBe(201);
    const [contact] = await db().select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, client.id));
    expect(contact.autotaskId).toMatch(/^local-/);
    expect((await src.contactByEmail("LOU@autonome.test"))?.companyId).toBe(client.autotaskId);
    expect((await admin.get("/api/tickets/companies")).json.map((x: { name: string }) => x.name)).toContain("Client Autonome inc.");
    const ticket = await admin.post("/api/tickets", { title: "Premier billet autonome", description: "", companyId: client.autotaskId, contactId: contact.autotaskId, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01" });
    expect(ticket.status).toBe(201);
    expect(ticket.json.id).toBeGreaterThanOrEqual(1_000_000_000);
    expect((await admin.get("/api/tickets?view=all")).json.items.map((x: { title: string }) => x.title)).toEqual(["Premier billet autonome"]);

    // a sync copies nothing and removes nothing
    const state = await syncCrm();
    expect(state.source).toBe("local");
    expect(state.ok).toBe(true);
    const [after] = await db().select().from(schema.clients).where(eq(schema.clients.id, client.id));
    expect(after.active).toBe(true);
    expect((await admin.get("/api/crm/status")).json).toMatchObject({ mode: "local", ok: true });
  });
});

describe("un-post: take back an invoice made by the portal", () => {
  it("voids it (number kept) and approves its items again; refused with payments, in QuickBooks, or already voided", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const [client] = await db().select().from(schema.clients).where(eq(schema.clients.name, "Client Autonome inc."));
    const [c] = client ? [client] : await db().select().from(schema.clients).limit(1);
    const [it] = await db()
      .insert(schema.billingItems)
      .values({ clientId: c.id, kind: "charge", source: "portal", sourceId: "test:unpost:1", date: "2026-10-10", description: "Pièce à reprendre", quantityX100: 100, unitPriceCents: 5000, amountCents: 5000, status: "approved", approvedAt: new Date() })
      .returning();
    const made = (await admin.post("/api/billables/invoice", { clientId: c.id, itemIds: [it.id] })).json;
    expect(made.id).toBeTruthy();
    await db().update(schema.clientInvoices).set({ quickbooksId: null }).where(eq(schema.clientInvoices.id, made.id));
    expect((await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, it.id)))[0].status).toBe("posted");

    // a payment received: refused
    await db().insert(schema.invoicePayments).values({ invoiceId: made.id, amountCents: 100, paidOn: "2026-10-12", method: "cheque" });
    expect((await admin.post("/api/billables/unpost", { invoiceId: made.id })).json.error).toBe("invoice_has_payments");
    await db().delete(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, made.id));
    // in QuickBooks: refused
    await db().update(schema.clientInvoices).set({ quickbooksId: "9" }).where(eq(schema.clientInvoices.id, made.id));
    expect((await admin.post("/api/billables/unpost", { invoiceId: made.id })).json.error).toBe("invoice_in_quickbooks");
    await db().update(schema.clientInvoices).set({ quickbooksId: null }).where(eq(schema.clientInvoices.id, made.id));

    // accounting only
    expect((await tech.post("/api/billables/unpost", { invoiceId: made.id })).status).toBe(403);
    const back = await admin.post("/api/billables/unpost", { invoiceId: made.id });
    expect(back.json).toMatchObject({ number: made.number, items: 1 });
    expect((await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, it.id)))[0]).toMatchObject({ status: "approved", invoiceId: null, postedAt: null });
    expect((await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.id, made.id)))[0]).toMatchObject({ voided: true, number: made.number });
    expect((await admin.post("/api/billables/unpost", { invoiceId: made.id })).json.error).toBe("invoice_voided");
    // the items can be invoiced again
    expect((await admin.post("/api/billables/invoice", { clientId: c.id, itemIds: [it.id] })).json.number).not.toBe(made.number);
  });
});

describe("un-post ready items", () => {
  it("approved items go back to pending without any invoice", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const [c] = await db().select().from(schema.clients).limit(1);
    const [it] = await db()
      .insert(schema.billingItems)
      .values({ clientId: c.id, kind: "charge", source: "portal", sourceId: "test:unpost:items", date: "2026-10-11", description: "Prêt à facturer", quantityX100: 100, unitPriceCents: 1000, amountCents: 1000, status: "approved", approvedAt: new Date() })
      .returning();
    // ready to invoice -> back to pending: no invoice, nothing voided
    const invoicesBefore = (await db().select().from(schema.clientInvoices)).length;
    expect((await admin.post("/api/billables/status", { ids: [it.id], status: "pending" })).json.changed).toBe(1);
    expect((await db().select().from(schema.billingItems).where(eq(schema.billingItems.id, it.id)))[0]).toMatchObject({ status: "pending", invoiceId: null });
    expect((await db().select().from(schema.clientInvoices)).length).toBe(invoicesBefore);

  });
});

describe("contract types, contracts made by hand, services", () => {
  it("the four starter types; admins manage them; a contract takes its billing from its type; erase by kind; services CRUD", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const [client] = await db().select().from(schema.clients).limit(1);

    // starter types (recurring service, hourly, banked hours, fixed price); only billing admins manage them
    const types = (await admin.get("/api/admin/contract-types")).json;
    expect(types.map((x: any) => x.kind)).toEqual(["recurring", "hourly", "banked", "fixed"]);
    expect((await tech.get("/api/admin/contract-types")).status).toBe(403);
    expect((await tech.get("/api/crm/contract-types")).json.length).toBe(4);
    const added = await admin.post("/api/admin/contract-types", { name: "Soutien géré", kind: "recurring" });
    expect(added.json.key).toBe("soutien-gere");

    // contracts by hand: the kind sets the billing mode
    const term = { startDate: "2026-10-01", endDate: "2027-09-30" };
    const mk = async (body: any) => (await admin.post(`/api/crm/clients/${client.id}/contracts`, { ...term, ...body })).json;
    const hourly = await mk({ name: "Horaire A", typeKey: "hourly", hourlyRate: 120 });
    const recurring = await mk({ name: "Mensuel A", typeKey: "soutien-gere", monthlyRate: 450 });
    const banked = await mk({ name: "Banque A", typeKey: "banked", bankedHours: 40 });
    const fixed = await mk({ name: "Fixe A", typeKey: "fixed", fixedPrice: 3000 });
    expect([hourly, recurring, banked, fixed].map((k) => k.billingMode)).toEqual(["hourly", "monthly", "banked", "fixed"]);
    expect(hourly.hourlyRateCents).toBe(12000);
    expect(banked.bankedHoursX100).toBe(4000);
    expect(fixed.fixedPriceCents).toBe(300000);
    expect((await tech.post(`/api/crm/clients/${client.id}/contracts`, { name: "x", typeKey: "hourly", ...term })).status).toBe(403);
    expect((await admin.post(`/api/crm/clients/${client.id}/contracts`, { name: "x", typeKey: "inconnu", ...term })).json.error).toBe("invalid_type");
    // a contract has a term: both days, the end not before the start
    expect((await admin.post(`/api/crm/clients/${client.id}/contracts`, { name: "Sans dates", typeKey: "hourly" })).status).toBe(400);
    expect((await admin.post(`/api/crm/clients/${client.id}/contracts`, { name: "Sans fin", typeKey: "hourly", startDate: "2026-10-01" })).status).toBe(400);
    expect((await admin.post(`/api/crm/clients/${client.id}/contracts`, { name: "A l'envers", typeKey: "hourly", startDate: "2026-10-01", endDate: "2026-09-01" })).json.error).toBe("contract_dates");
    // changing the type changes the billing
    expect((await admin.patch(`/api/crm/clients/${client.id}/contracts/${hourly.id}`, { typeKey: "fixed", fixedPrice: 99 })).json).toMatchObject({ billingMode: "fixed", typeKey: "fixed", fixedPriceCents: 9900 });
    const listed = (await admin.get(`/api/crm/clients/${client.id}/contracts`)).json;
    expect(listed.find((k: any) => k.id === banked.id)).toMatchObject({ usedHours: 0, bankedHoursX100: 4000 });

    // a type in use cannot be deleted or change kind; an unused one can go
    expect((await admin.del("/api/admin/contract-types/banked")).json.error).toBe("type_in_use");
    expect((await admin.patch("/api/admin/contract-types/banked", { kind: "hourly" })).json.error).toBe("type_in_use");
    const extra = await admin.post("/api/admin/contract-types", { name: "Temporaire", kind: "hourly" });
    expect((await admin.del(`/api/admin/contract-types/${extra.json.key}`)).status).toBe(200);

    // services: anyone with services.view reads, services.manage changes
    const s = await admin.post("/api/services", { name: "Surveillance 24/7", kind: "recurring", priceCents: 9900, description: "Par poste" });
    expect(s.status).toBe(201);
    expect((await admin.get("/api/services")).json.some((x: any) => x.id === s.json.id)).toBe(true);
    expect((await tech.post("/api/services", { name: "Interdit", priceCents: 1 })).status).toBe(403);
    expect((await admin.patch(`/api/services/${s.json.id}`, { priceCents: 10900, active: false })).json).toMatchObject({ priceCents: 10900, active: false });
    // monthly or yearly, with its cost and price (the margin is worked out on screen)
    const y = await admin.post("/api/services", { name: "Licence annuelle", kind: "recurring_yearly", priceCents: 12000, costCents: 9000 });
    expect(y.status).toBe(201);
    expect(y.json).toMatchObject({ kind: "recurring_yearly", priceCents: 12000, costCents: 9000 });
    expect((await admin.post("/api/services", { name: "Sans type", priceCents: 100 })).json.kind).toBe("recurring");
    expect((await admin.post("/api/services", { name: "Faux", kind: "weekly", priceCents: 100 })).status).toBe(400);
    expect((await admin.del(`/api/services/${s.json.id}`)).status).toBe(200);
    expect((await admin.del(`/api/services/${s.json.id}`)).status).toBe(404);
  });
});

describe("timesheet: work day, billable and non billable time, ratio", () => {
  it("a work day (start, end, lunch) is not counted in the hours worked; types are marked billable; the ratio is billable over worked", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const types = (await tech.get("/api/time/types")).json.time;
    const workday = types.find((x: any) => x.kind === "workday");
    expect(workday).toBeTruthy();
    const other = types.filter((x: any) => x.kind === "other");
    const admin1 = other.find((x: any) => /admin/i.test(x.name)) ?? other[0];
    const meeting = other.find((x: any) => x.id !== admin1.id);

    // marking types billable (admin); the built-in ones cannot be
    expect((await tech.patch(`/api/time/admin/timesheet-types/${admin1.id}`, { billable: true })).status).toBe(403);
    expect((await admin.patch(`/api/time/admin/timesheet-types/${admin1.id}`, { billable: true })).json.billable).toBe(true);
    expect((await admin.patch(`/api/time/admin/timesheet-types/${workday.id}`, { billable: true })).json.error).toBe("time_type_builtin");
    expect((await admin.patch(`/api/time/admin/timesheet-types/${workday.id}`, { active: false })).json.error).toBe("time_type_builtin");

    const day = "2026-12-08";
    // a work day needs its start and end; the lunch is 1 h, 30 min paid: 30 min come off
    expect((await tech.post("/api/time/entries", { date: day, typeId: workday.id, hours: 7 })).json.error).toBe("workday_times");
    expect((await tech.post("/api/time/entries", { date: day, typeId: workday.id, start: "16:00", end: "08:00" })).json.error).toBe("workday_times");
    const wd = await tech.post("/api/time/entries", { date: day, typeId: workday.id, start: "08:00", end: "16:30" });
    expect(wd.status).toBe(201);
    expect(wd.json).toMatchObject({ startTime: "08:00", endTime: "16:30", lunchMinutes: 30, hoursX100: 800 });
    // one a day
    expect((await tech.post("/api/time/entries", { date: day, typeId: workday.id, start: "09:00", end: "12:00" })).json.error).toBe("workday_exists");
    // 8 to 16 = 7.5 h
    expect((await tech.post("/api/time/entries", { date: "2026-12-09", typeId: workday.id, start: "08:00", end: "16:00" })).json.hoursX100).toBe(750);
    // under 5 h without the lunch hour (8 to 13 = 4 h): no lunch taken off
    expect((await tech.post("/api/time/entries", { date: "2026-11-03", typeId: workday.id, start: "08:00", end: "13:00" })).json.hoursX100).toBe(500);
    // exactly 5 h without the lunch hour (8 to 14): 30 min off
    expect((await tech.post("/api/time/entries", { date: "2026-11-04", typeId: workday.id, start: "08:00", end: "14:00" })).json.hoursX100).toBe(550);

    // 3 h of a billable type, 1 h of a non billable one
    expect((await tech.post("/api/time/entries", { date: day, typeId: admin1.id, hours: 3 })).status).toBe(201);
    expect((await tech.post("/api/time/entries", { date: day, typeId: meeting.id, hours: 1 })).status).toBe(201);
    const week = (await tech.get(`/api/time/week?start=${day}`)).json;
    // the work days (15.5 h) are apart: the hours worked are the 4 h
    expect(week.workdayHours).toBe(15.5);
    expect(week.totalHours).toBe(4);
    expect(week.billableHours).toBe(3);
    expect(week.nonBillableHours).toBe(1);
    expect(week.billableRatio).toBe(75);
    expect(week.types.some((x: any) => x.kind === "workday")).toBe(false);
    expect(week.entries.find((e: any) => e.kind === "workday").billableHours).toBe(0);
    expect(week.entries.find((e: any) => e.typeId === admin1.id).billableHours).toBe(3);
    expect(week.entries.find((e: any) => e.typeId === meeting.id).billableHours).toBe(0);
    // back to non billable
    await admin.patch(`/api/time/admin/timesheet-types/${admin1.id}`, { billable: false });
    expect((await tech.get(`/api/time/week?start=${day}`)).json).toMatchObject({ billableHours: 0, billableRatio: 0 });
  });
});

describe("hours bank and the time report", () => {
  it("hours are banked by profile default or per entry; the report shows worked, billable, banked and the bank; banked hours are not paid", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    const other = (await tech.get("/api/time/types")).json.time.filter((x: any) => x.kind === "other");
    const type = other[0];
    const day = "2027-01-12";

    // the profile default
    expect((await tech.get("/api/me")).json.preferences.bankHours).toBe(false);
    // not banked unless said: paid
    expect((await tech.post("/api/time/entries", { date: day, typeId: type.id, hours: 2 })).json.banked).toBe(false);
    expect((await tech.post("/api/time/entries", { date: day, typeId: type.id, hours: 1, banked: true })).json.banked).toBe(true);
    expect((await tech.put("/api/me/preferences", { bankHours: true })).status).toBe(200);
    expect((await tech.get("/api/me")).json.preferences.bankHours).toBe(true);
    // the default now banks an entry that does not say; an entry can still say no
    expect((await tech.post("/api/time/entries", { date: day, typeId: type.id, hours: 4 })).json.banked).toBe(true);
    expect((await tech.post("/api/time/entries", { date: day, typeId: type.id, hours: 0.5, banked: false })).json.banked).toBe(false);
    // the work day is never banked
    const wd = (await tech.get("/api/time/types")).json.time.find((x: any) => x.kind === "workday");
    expect((await tech.post("/api/time/entries", { date: day, typeId: wd.id, start: "08:00", end: "16:00" })).json.banked).toBe(false);
    await tech.put("/api/me/preferences", { bankHours: false });

    // the week: 7.5 h worked, 5 h of it banked
    const week = (await tech.get(`/api/time/week?start=${day}`)).json;
    expect(week.totalHours).toBe(7.5);
    expect(week.bankedHours).toBe(5);

    // the report of a period: own, or anyone's for a manager
    const rep = (await tech.get(`/api/time/report?from=2027-01-11&to=2027-01-17`)).json;
    expect(rep).toMatchObject({ workedHours: 7.5, bankedHours: 5, paidHours: 2.5, workdayHours: 7.5, billableHours: 0 });
    expect(rep.bankBalanceHours).toBeGreaterThanOrEqual(5);
    expect(rep.weeks).toHaveLength(1);
    expect(rep.types[0]).toMatchObject({ bankedHours: 5 });
    expect((await tech.get("/api/time/report?from=2027-01-17&to=2027-01-11")).status).toBe(400);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect((await tech.get(`/api/time/report?userId=${u.id}`)).status).toBe(200);
    const [adm] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    expect((await tech.get(`/api/time/report?userId=${adm.id}`)).status).toBe(403);
    expect((await admin.get(`/api/time/report?from=2027-01-11&to=2027-01-17&userId=${u.id}`)).json.bankedHours).toBe(5);

    // paying hours out of the bank: a built-in type that takes them off, never more than it holds
    const types = (await tech.get("/api/time/types")).json.time;
    const pay = types.find((x: any) => x.kind === "bankpay");
    expect(pay).toBeTruthy();
    expect((await admin.patch(`/api/time/admin/timesheet-types/${pay.id}`, { active: false })).json.error).toBe("time_type_builtin");
    const before = (await tech.get(`/api/time/week?start=${day}`)).json.bankBalanceHours;
    expect(before).toBeGreaterThanOrEqual(5);
    expect((await tech.post("/api/time/entries", { date: "2027-01-14", typeId: pay.id, hours: before + 1 })).json.error).toBe("bank_insufficient");
    const paid = await tech.post("/api/time/entries", { date: "2027-01-14", typeId: pay.id, hours: 3 });
    expect(paid.status).toBe(201);
    expect(paid.json.banked).toBe(false);
    const wk = (await tech.get(`/api/time/week?start=${day}`)).json;
    // not hours worked, not billable: the week still has its 7.5 h worked; the bank went down by 3
    expect(wk).toMatchObject({ totalHours: 7.5, bankedHours: 5, bankPaidHours: 3, bankBalanceHours: before - 3 });
    expect(wk.types.some((x: any) => x.kind === "bankpay")).toBe(false);
    const rep2 = (await tech.get("/api/time/report?from=2027-01-11&to=2027-01-17")).json;
    expect(rep2).toMatchObject({ workedHours: 7.5, bankPaidHours: 3, bankBalanceHours: before - 3 });
    // banked hours already paid out cannot be taken back (here the bank would go below zero); removing the payout frees them
    const banked4 = wk.entries.find((e: any) => e.banked && e.hours === 4);
    if (before - 3 - 4 < 0) expect((await tech.del(`/api/time/entries/${banked4.id}`)).json.error).toBe("bank_in_use");
    const payout = wk.entries.find((e: any) => e.kind === "bankpay");
    expect((await tech.del(`/api/time/entries/${payout.id}`)).status).toBe(200);
    expect((await tech.get(`/api/time/week?start=${day}`)).json.bankBalanceHours).toBe(before);
    expect((await tech.del(`/api/time/entries/${banked4.id}`)).status).toBe(200);
    expect((await tech.get(`/api/time/week?start=${day}`)).json.bankBalanceHours).toBe(before - 4);
  });
});

describe("sort by the order the AI planned", () => {
  it("applying a plan keeps its order for the sort 'ai'; a new plan replaces it; others see their own", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    const mine = (await tech.get("/api/tickets?view=all")).json;
    // nothing planned yet: no plan offered
    expect(mine.aiPlan).toBeNull();
    const ids: number[] = mine.items.filter((x: any) => x.statusKind !== "complete").slice(0, 4).map((x: any) => x.id);
    expect(ids.length).toBe(4);

    // a plan applied: its order, then the others by due date
    const plan = [ids[2], ids[0], ids[3]];
    expect((await tech.post("/api/tickets/start-dates", { items: plan.map((id) => ({ id, startDate: "2026-12-01" })), plan: true })).status).toBe(200);
    const sorted = (await tech.get("/api/tickets?view=all&sort=ai")).json;
    expect(sorted.aiPlan).toMatchObject({ count: 3 });
    expect(sorted.items.slice(0, 3).map((x: any) => x.id)).toEqual(plan);
    // the default sort is still the due date
    const byDue = (await tech.get("/api/tickets?view=all")).json.items.map((x: any) => x.dueAt);
    expect([...byDue].sort()).toEqual(byDue);

    // dates alone (no plan) leave the kept order alone
    await tech.post("/api/tickets/start-dates", { items: [{ id: ids[1], startDate: "2026-12-02" }] });
    expect((await tech.get("/api/tickets?view=all&sort=ai")).json.items.slice(0, 3).map((x: any) => x.id)).toEqual(plan);

    // a new plan replaces it
    const plan2 = [ids[1], ids[3]];
    await tech.post("/api/tickets/start-dates", { items: plan2.map((id) => ({ id, startDate: "2026-12-03" })), plan: true });
    const again = (await tech.get("/api/tickets?view=all&sort=ai")).json;
    expect(again.aiPlan).toMatchObject({ count: 2 });
    expect(again.items.slice(0, 2).map((x: any) => x.id)).toEqual(plan2);

    // someone else has none of it
    expect((await admin.get("/api/tickets?view=all")).json.aiPlan).toBeNull();
  });
});

describe("services on a contract, with their prorata", () => {
  it("a service is added from a day; the first period and the term are prorated; the dates are checked", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const clients = (await admin.get("/api/crm/clients")).json;
    const client = (clients.items ?? clients).find((x: any) => x.autotaskId === 300);
    const types = (await admin.get("/api/crm/contract-types")).json;
    const typeKey = types.find((x: any) => x.kind === "recurring")?.key ?? types[0].key;
    const contract = (await admin.post(`/api/crm/clients/${client.id}/contracts`, { name: "Services gérés 2026-27", typeKey, startDate: "2026-10-01", endDate: "2026-12-15", monthlyRate: 0 })).json;
    const monthly = (await admin.post("/api/services", { name: "Surveillance serveur", kind: "recurring", priceCents: 30_000, costCents: 12_000 })).json;
    const yearly = (await admin.post("/api/services", { name: "Licence antivirus", kind: "recurring_yearly", priceCents: 36_500 })).json;
    const once = (await admin.post("/api/services", { name: "Installation", kind: "one_time", priceCents: 5_000 })).json;
    const base = `/api/crm/clients/${client.id}/contracts/${contract.id}/services`;

    // the catalogue to pick from: recurring ones only
    const catalog = (await tech.get("/api/crm/services-catalog")).json;
    expect(catalog.some((x: any) => x.id === monthly.id)).toBe(true);
    expect(catalog.some((x: any) => x.id === once.id)).toBe(false);

    // monthly, added on 16 October: 16/31 of October, then November, then 15 days of December
    const added = await admin.post(base, { serviceId: monthly.id, addedOn: "2026-10-16" });
    expect(added.status).toBe(201);
    expect(added.json.firstCents).toBe(15_484);
    expect(added.json.totalCents).toBe(60_000);
    expect(added.json.periods.map((p: any) => [p.from, p.to, p.full, p.amountCents])).toEqual([
      ["2026-10-16", "2026-10-31", false, 15_484],
      ["2026-11-01", "2026-11-30", true, 30_000],
      ["2026-12-01", "2026-12-15", false, 14_516],
    ]);
    // yearly: the days left of the (short) term
    const y = await admin.post(base, { serviceId: yearly.id, addedOn: "2026-11-01" });
    expect(y.json.firstCents).toBe(4_500); // 45 days of 365: 1 Nov to 15 Dec
    // a price agreed for this contract
    expect((await admin.post(base, { serviceId: monthly.id, addedOn: "2026-10-01", priceCents: 20_000 })).json.firstCents).toBe(20_000);

    // dates and kinds are checked
    expect((await admin.post(base, { serviceId: monthly.id, addedOn: "2026-09-30" })).json.error).toBe("service_outside_term");
    expect((await admin.post(base, { serviceId: monthly.id, addedOn: "2027-01-01" })).json.error).toBe("service_outside_term");
    expect((await admin.post(base, { serviceId: once.id, addedOn: "2026-10-16" })).json.error).toBe("service_not_recurring");
    // only billing managers add or remove; anyone on CRM reads
    expect((await tech.post(base, { serviceId: monthly.id, addedOn: "2026-10-16" })).status).toBe(403);
    const list = (await tech.get(base)).json;
    expect(list).toHaveLength(3);
    expect(list.find((x: any) => x.id === added.json.id)).toMatchObject({ name: "Surveillance serveur", priceCents: 30_000, totalCents: 60_000 });
    expect((await tech.del(`${base}/${added.json.id}`)).status).toBe(403);
    expect((await admin.del(`${base}/${added.json.id}`)).status).toBe(200);
    expect((await admin.del(`${base}/${added.json.id}`)).status).toBe(404);
    expect((await tech.get(base)).json).toHaveLength(2);
  });
});

describe("a reply to the client is also emailed to the ticket's contact", () => {
  it("emailed by default with the ticket number in the subject; not for notes, nor when switched off, nor without an email", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const { devOutbox } = await import("../server/lib/mail.ts");
    const items = (await tech.get("/api/tickets?view=all")).json.items;
    const withContact = items.find((x: any) => x.contactId && x.company.id === 300);
    const detail = (await tech.get(`/api/tickets/${withContact.id}`)).json;
    expect(detail.contactInfo.email).toBeTruthy();

    // a reply: saved in the portal and emailed
    devOutbox.length = 0;
    const r = await tech.post(`/api/tickets/${withContact.id}/notes`, { text: "Le correctif est en place, redémarrez le poste.", internal: false });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ok: true, emailed: true, to: detail.contactInfo.email.toLowerCase() });
    expect(devOutbox).toHaveLength(1);
    expect(devOutbox[0]).toMatchObject({ to: detail.contactInfo.email.toLowerCase() });
    expect(devOutbox[0]!.subject).toContain(`[${withContact.number}]`);
    expect(devOutbox[0]!.text).toContain("Le correctif est en place");
    const notes = (await tech.get(`/api/tickets/${withContact.id}`)).json.notes;
    expect(notes.some((n: any) => n.text.includes("Le correctif est en place") && !n.internal)).toBe(true);

    // an internal note, or a reply with the email switched off: nothing goes out
    devOutbox.length = 0;
    expect((await tech.post(`/api/tickets/${withContact.id}/notes`, { text: "Note d'équipe", internal: true })).json.emailed).toBeUndefined();
    const off = await tech.post(`/api/tickets/${withContact.id}/notes`, { text: "Réponse sans courriel", internal: false, email: false });
    expect(off.status).toBe(201);
    expect(off.json.emailed).toBeUndefined();
    expect(devOutbox).toHaveLength(0);

    // no contact on the ticket: the reply stays in the portal, and the screen is told
    const noContact = items.find((x: any) => !x.contactId);
    if (noContact) {
      const n = await tech.post(`/api/tickets/${noContact.id}/notes`, { text: "Réponse sans contact", internal: false });
      expect(n.json).toMatchObject({ ok: true, emailed: false, noContactEmail: true });
      expect(devOutbox).toHaveLength(0);
    }
  });
});

describe("time entry: the ticket's status and due date can change with it", () => {
  it("saves the time and moves the ticket's status and due date when asked; a bad status refuses before the time is kept", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const items = (await tech.get("/api/tickets?view=all")).json.items.filter((x: any) => x.statusKind !== "complete");
    const t = items[0];
    const detail = (await tech.get(`/api/tickets/${t.id}`)).json;
    const other = detail.options.statuses.find((s: any) => s.value !== detail.status && s.kind === "inProgress") ?? detail.options.statuses.find((s: any) => s.value !== detail.status && s.kind !== "complete");
    const timers = async () => {
      await tech.post(`/api/tickets/${t.id}/timer/start`, {});
      await tech.post(`/api/tickets/${t.id}/timer/stop`, {});
      const l = (await tech.get("/api/tickets/timers")).json;
      return (l.timers ?? l.items ?? l).find((x: any) => (x.ticketId ?? x.ticket?.id) === t.id);
    };
    // a status that does not exist: refused, the ticket untouched
    let timer = await timers();
    const bad = await tech.post(`/api/tickets/timers/${timer.id}/submit`, { hours: 1, summary: "Test", status: "nope-status" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await tech.get(`/api/tickets/${t.id}`)).json.status).toBe(detail.status);

    // the status and due date change with the time
    const due = "2027-03-05T21:00:00.000Z";
    timer = (await tech.get("/api/tickets/timers")).json.timers?.find?.((x: any) => x.id === timer.id) ?? timer;
    const ok = await tech.post(`/api/tickets/timers/${timer.id}/submit`, { hours: 1, summary: "Test", status: other.value, dueAt: due });
    expect(ok.status).toBe(201);
    const after = (await tech.get(`/api/tickets/${t.id}`)).json;
    expect(after.status).toBe(other.value);
    expect(after.dueAt).toBe(due);
  });
});

describe("merge tickets", () => {
  afterAll(async () => {
    const local = await import("../server/lib/localTickets.ts");
    await db().delete(schema.integrations).where(eq(schema.integrations.provider, "tickets"));
    await db().delete(schema.tickets);
    local.resetTicketMode();
  });

  it("moves the work to the other ticket and closes this one as merged", async () => {
    resetRateLimit("login:ip:unknown");
    const local = await import("../server/lib/localTickets.ts");
    const tech = await signIn("tech@akab.local");
    // options saved before merging existed (production): no "merged" status in them
    const saved = await (await import("../server/lib/ticketSource.ts")).sourceOptions();
    const cfg = { mode: "local", options: { ...saved, statuses: saved.statuses.filter((x) => x.value !== "merged") } };
    await db()
      .insert(schema.integrations)
      .values({ provider: "tickets", enabled: true, config: cfg })
      .onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: cfg } });
    local.resetTicketMode();
    const mk = async (title: string, companyId: number) => (await tech.post("/api/tickets", { title, description: `Texte ${title}`, companyId, priority: "medium", queue: "support", assigneeId: null, dueDate: "2027-01-05" })).json.id as number;
    const a = await mk("Doublon", 300);
    const b = await mk("Principal", 300);
    const companies = (await tech.get("/api/tickets/companies")).json as { id: number }[];
    const other = companies.find((x) => x.id !== 300)!.id;
    const c = await mk("Autre client", other);
    await tech.post(`/api/tickets/${a}/notes`, { text: "Message du client", internal: false, email: false });

    // not with itself, not with another client
    expect((await tech.post(`/api/tickets/${a}/merge`, { intoId: a })).json.error).toBe("merge_same");
    expect((await tech.post(`/api/tickets/${a}/merge`, { intoId: c })).json.error).toBe("merge_other_client");

    const done = await tech.post(`/api/tickets/${a}/merge`, { intoId: b });
    expect(done.status).toBe(200);
    const merged = (await tech.get(`/api/tickets/${a}`)).json;
    expect(merged.status).toBe("merged");
    expect(merged.statusKind).toBe("complete");
    expect(merged.statusLabel).toBe("Fusionné");
    expect(merged.mergedInto.id).toBe(b);
    // the client's message and the original description are on the main ticket
    const texts = (await tech.get(`/api/tickets/${b}`)).json.notes.map((n: any) => n.text) as string[];
    expect(texts).toContain("Message du client");
    expect(texts.some((x) => x.includes("Texte Doublon"))).toBe(true);
    // what came from the merged ticket says so, and the merged tickets are listed on the main one
    const detail = (await tech.get(`/api/tickets/${b}`)).json;
    expect(detail.notes.filter((n: any) => n.mergedFrom === merged.number).length).toBeGreaterThanOrEqual(2);
    expect(detail.mergedTickets.map((m: any) => m.id)).toEqual([a]);
    expect(detail.mergedTickets[0].description).toBe("Texte Doublon");
    // already merged: neither side again; and it is out of the open list
    expect((await tech.post(`/api/tickets/${a}/merge`, { intoId: b })).json.error).toBe("merge_already");
    expect((await tech.post(`/api/tickets/${b}/merge`, { intoId: a })).json.error).toBe("merge_target_merged");
    const open = (await tech.get("/api/tickets?view=all&statusKind=new,inProgress,needsAttention")).json.items.map((x: any) => x.id);
    expect(open).not.toContain(a);
  });
});

describe("my tickets: secondary technician", () => {
  it("secondary=0 leaves out the tickets where I am only secondary", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const mine = (await tech.get("/api/tickets?view=mine")).json;
    const without = (await tech.get("/api/tickets?view=mine&secondary=0")).json;
    const me = (await tech.get("/api/me")).json.id as string;
    expect(without.items.every((t: any) => t.assignee?.id === me)).toBe(true);
    expect(without.items.length).toBeLessThanOrEqual(mine.items.length);
    expect(without.metrics.mine).toBe(without.items.length);
  });
});

describe("pipeline: shared to-dos and the day", () => {
  it("tasks: assign, checklist, subtasks and waiting-for rules, notes", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    const boss = (await admin.get("/api/me")).json.id as string;

    // made by the administrator for the technician (who is told), with a checklist
    const parent = (await admin.post("/api/pipeline/tasks", { title: "Migrer le serveur", assigneeId: me, dueDate: "2026-01-05", estimateMinutes: 120, checklist: ["Sauvegarde", "Copie"], notes: "Voir la procédure" })).json;
    expect(parent).toMatchObject({ title: "Migrer le serveur", assignee: expect.any(String), checklist: { done: 0, total: 2 } });
    expect((await tech.get("/api/notifications")).json.items.some((n: any) => n.type === "pipeline.assigned")).toBe(true);
    const sub = (await tech.post("/api/pipeline/tasks", { title: "Tester", parentId: parent.id, assigneeId: me })).json;
    const wait = (await tech.post("/api/pipeline/tasks", { title: "Annoncer", blockedById: sub.id })).json;
    expect(wait.waiting).toBe(true);

    // a parent is done only when its subtasks are; a task waiting for another cannot start or finish
    expect((await tech.patch(`/api/pipeline/tasks/${parent.id}`, { status: "done" })).json.error).toBe("task_open_children");
    expect((await tech.patch(`/api/pipeline/tasks/${wait.id}`, { status: "doing" })).json.error).toBe("task_blocked");
    // no loops
    expect((await tech.patch(`/api/pipeline/tasks/${parent.id}`, { parentId: sub.id })).json.error).toBe("task_cycle");
    expect((await tech.patch(`/api/pipeline/tasks/${sub.id}`, { blockedById: wait.id })).json.error).toBe("task_cycle");
    expect((await tech.patch(`/api/pipeline/tasks/${sub.id}`, { status: "done" })).status).toBe(200);
    expect((await tech.patch(`/api/pipeline/tasks/${wait.id}`, { status: "doing" })).status).toBe(200);
    expect((await tech.patch(`/api/pipeline/tasks/${parent.id}`, { status: "done" })).status).toBe(200);

    // the checklist and the notes
    const full = (await tech.get(`/api/pipeline/tasks/${parent.id}`)).json;
    expect(full.notes).toBe("Voir la procédure");
    expect(full.subtaskList.map((x: any) => x.title)).toEqual(["Tester"]);
    expect((await tech.patch(`/api/pipeline/tasks/${parent.id}/checklist/${full.checklistItems[0].id}`, { done: true })).json.done).toBe(true);
    expect((await tech.post(`/api/pipeline/tasks/${parent.id}/checklist`, { text: "Valider" })).status).toBe(201);
    expect((await tech.post(`/api/pipeline/tasks/${parent.id}/notes`, { text: "Fait hier soir" })).status).toBe(201);
    expect((await tech.get(`/api/pipeline/tasks/${parent.id}`)).json).toMatchObject({ checklist: { done: 1, total: 3 }, comments: [expect.objectContaining({ text: "Fait hier soir" })] });

    // the shared list: mine / team, open / done
    const mine = (await tech.get("/api/pipeline/tasks?scope=mine&status=all")).json.map((x: any) => x.title);
    expect(mine).toContain("Tester");
    expect((await tech.get("/api/pipeline/tasks?status=done")).json.map((x: any) => x.title)).toEqual(expect.arrayContaining(["Migrer le serveur", "Tester"]));
    // only the author or a manager deletes
    const boss1 = (await admin.post("/api/pipeline/tasks", { title: "Du patron" })).json;
    expect((await tech.del(`/api/pipeline/tasks/${boss1.id}`)).status).toBe(403);
    expect((await admin.del(`/api/pipeline/tasks/${boss1.id}`)).status).toBe(200);
    expect((await tech.patch(`/api/pipeline/tasks/${parent.id}`, { assigneeId: "00000000-0000-4000-8000-000000000000" })).json.error).toBe("invalid_assignee");
    expect(boss).toBeTruthy();
  });

  it("my day: a plan with time blocks, the summary, and the morning run (no texts unless asked)", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    await tech.post("/api/pipeline/tasks", { title: "Appeler le fournisseur", assigneeId: me, dueDate: "2000-01-03", priority: "high", estimateMinutes: 45 });
    const day = (await tech.get("/api/pipeline/day?date=2026-03-04")).json;
    expect(day.plan.source).toBe("rules");
    expect(day.plan.capacityMinutes).toBe(480);
    const first = day.plan.blocks.find((b: any) => b.title === "Appeler le fournisseur");
    expect(first).toMatchObject({ kind: "task", start: "08:00", end: "08:45" });
    // never in the lunch hour
    expect(day.plan.blocks.filter((b: any) => b.kind !== "break" && !b.overflow).every((b: any) => b.end <= "12:00" || b.start >= "13:00")).toBe(true);
    expect(day.items.some((i: any) => i.title === "Appeler le fournisseur" && i.overdue)).toBe(true);
    // planning again without the AI set up still gives a plan
    const again = (await tech.post("/api/pipeline/day/plan", { date: "2026-03-04" })).json;
    expect(again.plan.source).toBe("rules");
    expect(["not_configured", "disabled"]).toContain(again.aiError);
    // a weekend or a holiday plans nothing
    const sat = (await tech.get("/api/pipeline/day?date=2026-03-07")).json;
    expect(sat.plan.blocks.filter((b: any) => b.kind === "task")).toEqual([]);
    // someone else's day: managers only
    expect((await tech.get(`/api/pipeline/day?userId=${(await admin.get("/api/me")).json.id}`)).status).toBe(403);
    expect((await admin.get(`/api/pipeline/day?userId=${me}`)).status).toBe(200);

    // settings and the morning run: managers only
    expect((await tech.get("/api/pipeline/settings")).status).toBe(403);
    expect((await admin.put("/api/pipeline/settings", { auto: true, time: "06:45", sms: true, workStart: "08:00", workEnd: "17:00", lunchStart: "12:00", lunchEnd: "13:00" })).json.time).toBe("06:45");
    expect((await admin.put("/api/pipeline/settings", { auto: true, time: "06:45", sms: true, workStart: "17:00", workEnd: "08:00", lunchStart: "12:00", lunchEnd: "13:00" })).status).toBe(400);
    const run = (await admin.post("/api/pipeline/morning/run", { sms: false })).json;
    expect(run.planned).toBeGreaterThanOrEqual(1);
    expect(run.texted).toBe(0);
    expect((await tech.post("/api/pipeline/morning/run", {})).status).toBe(403);
    // the test text: managers only; a person with no number, or no SMS line, gets a clear refusal
    expect((await tech.post("/api/pipeline/morning/test-sms", { userId: me })).status).toBe(403);
    expect((await tech.get("/api/pipeline/test-targets")).status).toBe(403);
    const targets = (await admin.get("/api/pipeline/test-targets")).json;
    expect(targets.some((x: any) => x.id === me)).toBe(true);
    expect(["no_phone", "sms_not_ready"]).toContain((await admin.post("/api/pipeline/morning/test-sms", { userId: me, mode: "short" })).json.error);
    expect((await admin.post("/api/pipeline/morning/test-sms", { userId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });
});

describe("pipeline: times, files, recurring and private tasks", () => {
  it("start / due times, files, and a recurring task that makes the next one", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    // a time needs its day
    const t1 = (await tech.post("/api/pipeline/tasks", { title: "Heures", assigneeId: me, dueTime: "15:30", startTime: "09:00" })).json;
    expect(t1).toMatchObject({ dueDate: null, dueTime: null, startDate: null, startTime: null });
    const t2 = (await tech.patch(`/api/pipeline/tasks/${t1.id}`, { dueDate: "2026-03-04", dueTime: "15:30", startDate: "2026-03-04", startTime: "10:00", tags: ["urgent", "client", "urgent"] })).json;
    expect(t2).toMatchObject({ dueDate: "2026-03-04", dueTime: "15:30", startDate: "2026-03-04", startTime: "10:00", tags: ["urgent", "client"] });
    // clearing the day clears its time
    expect((await tech.patch(`/api/pipeline/tasks/${t1.id}`, { dueDate: null })).json).toMatchObject({ dueDate: null, dueTime: null });

    // the plan does not start it before its time
    await tech.patch(`/api/pipeline/tasks/${t1.id}`, { dueDate: "2026-03-04", dueTime: "15:30", estimateMinutes: 60 });
    const day = (await tech.get("/api/pipeline/day?date=2026-03-04")).json;
    const block = day.plan.blocks.find((b: any) => b.title === "Heures");
    expect(block.start >= "10:00").toBe(true);

    // files
    const up = await tech.post(`/api/pipeline/tasks/${t1.id}/files`, { name: "plan.txt", contentType: "text/plain", data: Buffer.from("bonjour").toString("base64") });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ name: "plan.txt", size: 7 });
    expect((await tech.post(`/api/pipeline/tasks/${t1.id}/files`, { name: "x", data: "***" })).status).toBe(400);
    const full = (await tech.get(`/api/pipeline/tasks/${t1.id}`)).json;
    expect(full.files).toBe(1);
    expect(full.fileList[0]).toMatchObject({ name: "plan.txt", size: 7 });
    const dl = await tech.get(`/api/pipeline/tasks/${t1.id}/files/${up.json.id}`);
    expect(dl.status).toBe(200);
    expect((await tech.del(`/api/pipeline/tasks/${t1.id}/files/${up.json.id}`)).status).toBe(200);
    expect((await tech.get(`/api/pipeline/tasks/${t1.id}`)).json.files).toBe(0);

    // recurring: completing it makes the next one, after today, with a fresh checklist
    const rec = (await tech.post("/api/pipeline/tasks", { title: "Vérifier les sauvegardes", assigneeId: me, dueDate: "2020-01-06", dueTime: "09:00", recurrence: { freq: "weekly", interval: 1, weekdays: [1] }, checklist: ["Serveur", "NAS"] })).json;
    expect(rec.recurrence).toMatchObject({ freq: "weekly", interval: 1 });
    const first = (await tech.get(`/api/pipeline/tasks/${rec.id}`)).json;
    await tech.patch(`/api/pipeline/tasks/${rec.id}/checklist/${first.checklistItems[0].id}`, { done: true });
    const done = (await tech.patch(`/api/pipeline/tasks/${rec.id}`, { status: "done" })).json;
    expect(done.next).toEqual(expect.any(String));
    const next = (await tech.get(`/api/pipeline/tasks/${done.next}`)).json;
    expect(next).toMatchObject({ title: "Vérifier les sauvegardes", status: "todo", dueTime: "09:00", seriesId: rec.id, assigneeId: me });
    expect(next.dueDate > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(new Date(`${next.dueDate}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(next.checklistItems.map((i: any) => [i.text, i.done])).toEqual([["Serveur", false], ["NAS", false]]);
    // a task without a rule makes none
    const plain = (await tech.post("/api/pipeline/tasks", { title: "Une fois", assigneeId: me })).json;
    expect((await tech.patch(`/api/pipeline/tasks/${plain.id}`, { status: "done" })).json.next).toBeNull();
  });

  it("private tasks: only who made it, who has it and the people chosen — not even a manager", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    const boss = (await admin.get("/api/me")).json.id as string;
    const priv = (await tech.post("/api/pipeline/tasks", { title: "Évaluation de Jean", visibility: "private", assigneeId: me, dueDate: "2000-01-03" })).json;
    const shared = (await tech.post("/api/pipeline/tasks", { title: "Budget du projet", visibility: "selected", viewerIds: [boss], assigneeId: me, dueDate: "2000-01-03" })).json;
    const team = (await tech.post("/api/pipeline/tasks", { title: "Pour tous", assigneeId: me, dueDate: "2000-01-03" })).json;
    const names = async (s: typeof admin) => (await s.get("/api/pipeline/tasks?status=all")).json.map((x: any) => x.title);
    expect(await names(tech)).toEqual(expect.arrayContaining(["Évaluation de Jean", "Budget du projet", "Pour tous"]));
    const seen = await names(admin);
    expect(seen).toEqual(expect.arrayContaining(["Budget du projet", "Pour tous"]));
    expect(seen).not.toContain("Évaluation de Jean");
    // and not by its address, nor to change it
    expect((await admin.get(`/api/pipeline/tasks/${priv.id}`)).status).toBe(404);
    expect((await admin.patch(`/api/pipeline/tasks/${priv.id}`, { title: "x" })).status).toBe(404);
    expect((await admin.post(`/api/pipeline/tasks/${priv.id}/notes`, { text: "x" })).status).toBe(404);
    expect((await admin.del(`/api/pipeline/tasks/${priv.id}`)).status).toBe(404);
    expect((await admin.get(`/api/pipeline/tasks/${shared.id}`)).json.viewerIds).toEqual([boss]);
    expect((await admin.get(`/api/pipeline/tasks/${team.id}`)).status).toBe(200);
    // the manager looking at the technician's day sees no private title
    const day = (await admin.get(`/api/pipeline/day?date=2026-03-04&userId=${me}`)).json;
    expect(JSON.stringify(day)).not.toContain("Évaluation de Jean");
    expect(day.items.some((i: any) => i.masked)).toBe(true);
    // the technician's own day shows it
    expect(JSON.stringify((await tech.get("/api/pipeline/day?date=2026-03-04")).json)).toContain("Évaluation de Jean");
    // a subtask of a private task: the manager does not see the parent's title
    await tech.post("/api/pipeline/tasks", { title: "Sous-tâche publique", parentId: priv.id, assigneeId: me });
    const sub = (await admin.get("/api/pipeline/tasks?status=all")).json.find((x: any) => x.title === "Sous-tâche publique");
    expect(sub.parentTitle).toBeNull();
  });
});

describe("QuickBooks: clients, chart of accounts and vendors kept in step both ways", () => {
  type Rec = Record<string, any>;
  const store = { Customer: new Map<string, Rec>(), Account: new Map<string, Rec>(), Vendor: new Map<string, Rec>(), Invoice: new Map<string, Rec>() };
  const real = globalThis.fetch;
  let seq = 100;
  // a change on either side is later than the last sync, by a clear margin
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const stamp = (r: Rec, at = Date.now()) => {
    r.MetaData = { LastUpdatedTime: new Date(at).toISOString() };
    r.SyncToken = String(Number(r.SyncToken ?? "0") + 1);
    return r;
  };
  const mock = async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "oauth.platform.intuit.com") return Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    if (!url.hostname.endsWith("intuit.com")) return real(input, init);
    const path = url.pathname.replace(/^\/v3\/company\/[^/]+\//, "");
    if (path === "query") {
      const entity = /from (\w+)/.exec(url.searchParams.get("query") ?? "")![1] as keyof typeof store;
      // the one filter the portal uses on invoices: from a day on
      const since = /TxnDate >= '([0-9]{4}-[0-9]{2}-[0-9]{2})'/.exec(url.searchParams.get("query") ?? "")?.[1];
      const rows = [...store[entity].values()].filter((r) => !since || r.TxnDate >= since);
      return Response.json({ QueryResponse: { [entity]: rows } });
    }
    const [what, id] = path.split("/");
    const entity = (what[0].toUpperCase() + what.slice(1)) as keyof typeof store;
    if (init?.method === "POST") {
      const b = JSON.parse(init.body);
      if (b.Id) {
        const cur = store[entity].get(b.Id)!;
        if (cur.SyncToken !== b.SyncToken) return Response.json({ Fault: { Error: [{ Message: "stale" }] } }, { status: 400 });
        Object.assign(cur, b);
        stamp(cur);
        return Response.json({ [entity]: cur });
      }
      const r = stamp({ Id: String(++seq), Active: true, ...b });
      store[entity].set(r.Id, r);
      return Response.json({ [entity]: r });
    }
    return Response.json({ [entity]: store[entity].get(id)! });
  };

  it("clients: mapped customers follow each other; accounts and chosen vendors too", async () => {
    resetRateLimit("login:ip:unknown");
    vi.stubGlobal("fetch", mock);
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const billing = await import("../server/lib/billing.ts");
    const { saveQuickBooksSettings, quickbooksSettings } = billing;
    const { syncAll } = await import("../server/lib/qbSync.ts");
    const { forgetQuickBooksToken } = await import("../server/lib/quickbooks.ts");
    // the app first (a new app resets the connection), then the connection
    await saveQuickBooksSettings(null, { clientId: "x", clientSecret: "y", environment: "sandbox" });
    await saveQuickBooksSettings(null, { enabled: true, realmId: "123", refreshToken: "r" });
    forgetQuickBooksToken();
    try {
      // ── clients ──
      const [cl] = await db().insert(schema.clients).values({ name: "Garage Test QB", phone: "450-111-1111", email: "info@garage.test" }).returning();
      const cust = stamp({ Id: "77", DisplayName: "Garage Test QB", PrimaryPhone: { FreeFormNumber: "450-999-0000" }, PrimaryEmailAddr: { Address: "info@garage.test" }, Active: true }, Date.now() - 86_400_000);
      store.Customer.set("77", cust);
      expect((await admin.put(`/api/billing/quickbooks/mapping/${cl.id}`, { quickbooksId: "77" })).status).toBe(200);
      // mapped just now: the portal is the newer side, so its phone goes to QuickBooks
      let r = (await syncAll(null))!;
      expect(r.clients).toMatchObject({ pushed: 1, pulled: 0, failed: 0 });
      expect(store.Customer.get("77")!.PrimaryPhone.FreeFormNumber).toBe("450-111-1111");
      // a change in QuickBooks comes in
      await tick();
      Object.assign(store.Customer.get("77")!, { PrimaryEmailAddr: { Address: "compta@garage.test" } });
      stamp(store.Customer.get("77")!, Date.now());
      r = (await syncAll(null))!;
      expect(r.clients).toMatchObject({ pulled: 1, pushed: 0 });
      expect((await db().select().from(schema.clients).where(eq(schema.clients.id, cl.id)))[0].email).toBe("compta@garage.test");
      // nothing changed: nothing is written either way
      expect((await syncAll(null))!.clients).toMatchObject({ pulled: 0, pushed: 0 });
      // a change here goes out (the edit sends it at once; the pass also would)
      await tick();
      expect((await admin.patch(`/api/crm/clients/${cl.id}`, { phone: "450-222-2222" })).status).toBe(200);
      await syncAll(null);
      expect(store.Customer.get("77")!.PrimaryPhone.FreeFormNumber).toBe("450-222-2222");
      // switched off: the pass leaves clients alone
      await saveQuickBooksSettings(null, { sync: { ...(await quickbooksSettings()).sync, customers: false } });
      expect((await syncAll(null))!.clients).toBeUndefined();
      await saveQuickBooksSettings(null, { sync: { ...(await quickbooksSettings()).sync, customers: true } });

      // ── chart of accounts ──
      store.Account.set("501", stamp({ Id: "501", Name: "Frais bancaires QB", Classification: "Expense", Active: true }, Date.now() - 86_400_000));
      store.Account.set("502", stamp({ Id: "502", Name: "Revenus QB", AcctNum: "4999", Classification: "Revenue", Active: true }, Date.now() - 86_400_000));
      r = (await syncAll(null))!;
      expect(r.accounts!.created).toBeGreaterThanOrEqual(2);
      const acct = async (qbId: string) => (await db().select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.quickbooksId, qbId)))[0];
      expect(await acct("501")).toMatchObject({ name: "Frais bancaires QB", type: "expense", number: "QB-501" });
      expect(await acct("502")).toMatchObject({ name: "Revenus QB", type: "revenue", number: "4999" });
      // renamed in QuickBooks → here; renamed here → QuickBooks
      await tick();
      Object.assign(store.Account.get("501")!, { Name: "Frais de banque" });
      stamp(store.Account.get("501")!, Date.now());
      await syncAll(null);
      expect((await acct("501")).name).toBe("Frais de banque");
      const a502 = await acct("502");
      await tick();
      expect((await admin.patch(`/api/billing/ledger/${a502.id}`, { name: "Revenus de services" })).status).toBe(200);
      await syncAll(null);
      expect(store.Account.get("502")!.Name).toBe("Revenus de services");
      // an account made here since the sync started is made in QuickBooks
      const made = (await admin.post("/api/billing/ledger", { number: "9100", name: "Compte neuf", type: "expense" })).json;
      await syncAll(null);
      const inQb = [...store.Account.values()].find((x) => x.Name === "Compte neuf");
      expect(inQb).toMatchObject({ AccountType: "Expense", AcctNum: "9100" });
      expect((await db().select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, made.id)))[0].quickbooksId).toBe(inQb!.Id);

      // ── vendors: the ones chosen ──
      store.Vendor.set("601", stamp({ Id: "601", DisplayName: "Ingram Micro QB", PrimaryPhone: { FreeFormNumber: "514-000-0001" }, Active: true }, Date.now() - 86_400_000));
      store.Vendor.set("602", stamp({ Id: "602", DisplayName: "Synnex QB", Active: true }, Date.now() - 86_400_000));
      await admin.post("/api/admin/vendors", { name: "Ingram Micro QB" });
      expect((await tech.get("/api/billing/quickbooks/vendors")).status).toBe(403);
      const choices = (await admin.get("/api/billing/quickbooks/vendors")).json;
      expect(choices.vendors.map((v: any) => [v.name, v.selected])).toEqual([["Ingram Micro QB", false], ["Synnex QB", false]]);
      const sel = (await admin.put("/api/billing/quickbooks/vendors/selection", { ids: ["601", "602"] })).json;
      expect(sel).toMatchObject({ tied: 1, created: 1, untied: 0 });
      const vend = async (qbId: string) => (await db().select().from(schema.vendors).where(eq(schema.vendors.quickbooksId, qbId)))[0];
      expect(await vend("602")).toMatchObject({ name: "Synnex QB" });
      await tick();
      Object.assign(store.Vendor.get("602")!, { PrimaryPhone: { FreeFormNumber: "514-555-0102" } });
      stamp(store.Vendor.get("602")!, Date.now());
      await syncAll(null);
      expect((await vend("602")).phone).toBe("514-555-0102");
      // a vendor not chosen any more is untied, never deleted
      expect((await admin.put("/api/billing/quickbooks/vendors/selection", { ids: ["601"] })).json).toMatchObject({ untied: 1 });
      expect((await db().select().from(schema.vendors).where(eq(schema.vendors.name, "Synnex QB")))[0].quickbooksId).toBeNull();
      // a vendor made here is made in QuickBooks on request
      const mine = (await admin.post("/api/admin/vendors", { name: "Nouveau fournisseur", email: "a@b.test" })).json;
      expect((await admin.post(`/api/billing/quickbooks/vendors/${mine.id}/create`, {})).status).toBe(200);
      expect([...store.Vendor.values()].find((x) => x.DisplayName === "Nouveau fournisseur")).toMatchObject({ PrimaryEmailAddr: { Address: "a@b.test" } });
      // the sync button: managers only
      expect((await tech.post("/api/billing/quickbooks/sync", {})).status).toBe(403);
      expect((await admin.post("/api/billing/quickbooks/sync", {})).json.runs.vendors).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      await saveQuickBooksSettings(null, { enabled: false, refreshToken: null, realmId: null });
      forgetQuickBooksToken();
    }
  });

  it("invoices: the first copy starts from a number or a date, and the next number is never behind QuickBooks", async () => {
    resetRateLimit("login:ip:unknown");
    vi.stubGlobal("fetch", mock);
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const billing = await import("../server/lib/billing.ts");
    const { forgetQuickBooksToken } = await import("../server/lib/quickbooks.ts");
    await billing.saveQuickBooksSettings(null, { clientId: "x", clientSecret: "y", environment: "sandbox" });
    await billing.saveQuickBooksSettings(null, { enabled: true, realmId: "123", refreshToken: "r" });
    forgetQuickBooksToken();
    try {
      const [cl] = await db().insert(schema.clients).values({ name: "Client Factures QB", quickbooksId: "880" }).returning();
      const inv = (n: string, day: string, customer = "880") => store.Invoice.set(n, stamp({ Id: n, DocNumber: n, TxnDate: day, DueDate: day, TotalAmt: 100, Balance: 100, CustomerRef: { value: customer }, Line: [] }));
      inv("20001", "2026-01-10");
      inv("20002", "2026-02-10");
      inv("20007", "2026-03-10");
      inv("20008", "2026-03-11", "999");
      // from a number
      await admin.put("/api/billing/quickbooks", { invoicesMode: "number", invoicesFromNumber: 20002 });
      let p = (await admin.get("/api/billing/quickbooks/invoices/preview")).json;
      expect(p).toMatchObject({ total: 3, unmapped: 1, firstNumber: 20002, lastNumber: 20008 });
      // from a date
      await admin.put("/api/billing/quickbooks", { invoicesMode: "date", invoicesFromDate: "2026-03-01" });
      p = (await admin.get("/api/billing/quickbooks/invoices/preview")).json;
      expect(p).toMatchObject({ total: 2, firstNumber: 20007, lastNumber: 20008, firstDate: "2026-03-10" });
      expect((await admin.get("/api/billing/quickbooks")).json).toMatchObject({ invoicesMode: "date", invoicesFromDate: "2026-03-01" });
      const pulled = (await admin.post("/api/billing/quickbooks/invoices/pull", {})).json;
      expect(pulled).toMatchObject({ added: 1, unmapped: 1, total: 2 });
      expect((await db().select().from(schema.clientInvoices).where(eq(schema.clientInvoices.clientId, cl.id))).map((x) => x.number)).toEqual(["20007"]);
      // the next number: QuickBooks is at 20009; the portal is brought to it (never lowered)
      const n = (await admin.get("/api/billing/quickbooks/numbering")).json;
      expect(n).toMatchObject({ qbNext: 20009, qbHighest: 20008 });
      await billing.saveBillingSettings(null, { numbering: { next: 100 } });
      expect((await admin.get("/api/billing/quickbooks/numbering")).json).toMatchObject({ portalNext: 100, status: "behind" });
      expect((await tech.post("/api/billing/quickbooks/numbering/align", {})).status).toBe(403);
      expect((await admin.post("/api/billing/quickbooks/numbering/align", {})).json).toMatchObject({ portalNext: 20009, raised: true });
      expect((await admin.get("/api/billing/quickbooks/numbering")).json).toMatchObject({ status: "aligned" });
      // already ahead: never lowered
      await billing.saveBillingSettings(null, { numbering: { next: 30000 } });
      expect((await admin.post("/api/billing/quickbooks/numbering/align", {})).json).toMatchObject({ portalNext: 30000, raised: false });
      expect((await admin.get("/api/billing/quickbooks/numbering")).json.status).toBe("ahead");
    } finally {
      vi.unstubAllGlobals();
      await billing.saveQuickBooksSettings(null, { enabled: false, refreshToken: null, realmId: null, invoicesMode: "number" });
      forgetQuickBooksToken();
    }
  });
});

describe("pipeline: pinned priorities in my day", () => {
  it("the tickets pinned to me (of the day, of the week) are on my day first, even when assigned to someone else", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    const all = (await tech.get("/api/tickets?view=all")).json.items as any[];
    const open = all.filter((x) => x.statusKind !== "complete" && x.assignee?.id !== me);
    // pins left by earlier tests
    await db().delete(schema.ticketPins);
    const dayPinned = open[0];
    const weekPinned = open[1];
    const date = "2026-03-04"; // a Wednesday: its week starts 2026-03-02
    await db().insert(schema.ticketPins).values([
      { ticketId: dayPinned.id, ticketNumber: dayPinned.number, ticketTitle: dayPinned.title, technicianId: me, note: "Appeler le client avant midi", horizon: "day", forDate: date, rank: 1 },
      { ticketId: weekPinned.id, ticketNumber: weekPinned.number, ticketTitle: weekPinned.title, technicianId: me, note: "", horizon: "week", forDate: "2026-03-02", rank: 2 },
    ]);
    const day = (await tech.get(`/api/pipeline/day?date=${date}`)).json;
    const dp = day.items.find((i: any) => i.refId === String(dayPinned.id));
    const wp = day.items.find((i: any) => i.refId === String(weekPinned.id));
    expect(dp).toMatchObject({ pin: "day", pinNote: "Appeler le client avant midi" });
    expect(wp).toMatchObject({ pin: "week" });
    // the first block of the day is the priority of the day, with its direction
    const first = day.plan.blocks.find((b: any) => b.kind === "ticket" && !b.overflow);
    expect(first).toMatchObject({ refId: String(dayPinned.id), pinned: "day", note: "Appeler le client avant midi" });
    // another day of the same week still has the week's priority, but not the day's
    const thursday = (await tech.get("/api/pipeline/day?date=2026-03-05")).json;
    expect(thursday.items.find((i: any) => i.refId === String(weekPinned.id))).toMatchObject({ pin: "week" });
    expect(thursday.items.find((i: any) => i.refId === String(dayPinned.id))?.pin).toBeUndefined();
    // a done pin is no longer a priority
    await db().update(schema.ticketPins).set({ doneAt: new Date() }).where(eq(schema.ticketPins.ticketId, dayPinned.id));
    expect((await tech.get(`/api/pipeline/day?date=${date}`)).json.items.find((i: any) => i.refId === String(dayPinned.id))).toBeUndefined();
    await db().delete(schema.ticketPins);
  });
});

describe("weekly meeting: the week ahead summary", () => {
  it("is written from the week's absences, events, projects, tickets and each technician's load; managers regenerate it", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const team = (await admin.get("/api/meetings/team")).json as { id: string; name: string }[];
    const alex = team.find((x) => x.name.includes("Alex"))!;
    const from = "2026-03-02"; // a Monday
    await admin.post("/api/meetings/absences", { userId: alex.id, startDate: "2026-03-03", endDate: "2026-03-04", kind: "vacation", note: "" });
    await admin.post("/api/meetings/events", { date: "2026-03-05", title: "Formation Microsoft", startTime: "09:00", endTime: "12:00", userId: null });
    await admin.post("/api/meetings/projects", { title: "Livraison réseau", dueDate: "2026-03-06" });
    // technicians do not see the meeting page by default
    expect((await tech.get(`/api/meetings/brief?from=${from}`)).status).toBe(403);
    const brief = (await admin.get(`/api/meetings/brief?from=${from}`)).json;
    expect(brief).toMatchObject({ weekStart: from, source: "rules" });
    const text = [...brief.bullets, ...brief.suggestions].join(" | ");
    expect(brief.bullets.length).toBeGreaterThanOrEqual(3);
    expect(brief.bullets.length).toBeLessThanOrEqual(8);
    expect(text).toContain("Alex");
    expect(text).toContain("Formation Microsoft");
    expect(text).toContain("Livraison réseau");
    expect(brief.suggestions.length).toBeGreaterThanOrEqual(1);
    // no week asked: the current one (or the next over a weekend)
    expect((await admin.get("/api/meetings/brief")).json.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await admin.get("/api/meetings/brief?from=2026-13-40")).status).toBe(400);
    // regenerating: managers only; without the AI it falls back to the rules and says why
    expect((await tech.post("/api/meetings/brief", { from })).status).toBe(403);
    const again = (await admin.post("/api/meetings/brief", { from })).json;
    expect(again.brief.source).toBe("rules");
    expect(["not_configured", "disabled"]).toContain(again.aiError);
  });
});

describe("notify a technician from a ticket", () => {
  afterAll(() => vi.unstubAllGlobals());
  it("the bell always; email, text and Teams as ticked; defaults in the profile; the Teams webhook is a sealed secret", async () => {
    resetRateLimit("login:ip:unknown");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");
    const [adminRow] = await db().select().from(schema.users).where(eq(schema.users.email, "admin@akab.local"));
    const ticketId = (await tech.get("/api/tickets?view=all")).json.items[0].id;
    const { devOutbox } = await import("../server/lib/mail.ts");

    // the channels ticked by default: email only, set per person in the profile
    expect((await tech.get("/api/me")).json.preferences.notify).toEqual({ email: true, sms: false, teams: false });
    expect((await tech.put("/api/me/preferences", { notify: { email: false, sms: true, teams: true } })).status).toBe(200);
    expect((await tech.get("/api/me")).json.preferences.notify).toEqual({ email: false, sms: true, teams: true });
    await tech.put("/api/me/preferences", { notify: { email: true, sms: false, teams: false } });

    // Teams: one webhook, only Microsoft's addresses, never sent back
    expect((await tech.put("/api/admin/integrations/teams", { enabled: true, webhookUrl: "https://prod.westus.logic.azure.com/x" })).status).toBe(403);
    expect((await admin.put("/api/admin/integrations/teams", { webhookUrl: "http://evil.example/hook" })).json.error).toBe("teams_bad_url");
    expect((await admin.put("/api/admin/integrations/teams", { webhookUrl: "https://evil.example/hook" })).json.error).toBe("teams_bad_url");
    expect((await admin.put("/api/admin/integrations/teams", { enabled: true })).json.error).toBe("teams_incomplete");
    const posts: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("", { status: 202 });
    }));
    const set = await admin.put("/api/admin/integrations/teams", { enabled: true, webhookUrl: "https://prod.westus.logic.azure.com/workflows/abc" });
    expect(set.json).toMatchObject({ enabled: true, hasUrl: true });
    expect(JSON.stringify(set.json)).not.toContain("logic.azure.com");
    expect((await db().select().from(schema.integrations).where(eq(schema.integrations.provider, "teams")))[0].secret).not.toContain("logic.azure.com");

    // notify: the bell, the email and Teams (the text line is not set up here)
    devOutbox.length = 0;
    const r = await tech.post(`/api/tickets/${ticketId}/notify-tech`, { userIds: [adminRow.id], message: "Urgent pour 15 h", channels: { email: true, sms: true, teams: true } });
    expect(r.status).toBe(200);
    expect(r.json.people).toMatchObject([{ id: adminRow.id, bell: true, email: "sent", sms: "not_ready", teams: "sent" }]);
    expect(devOutbox.map((m) => m.to)).toEqual([adminRow.email]);
    expect(devOutbox[0].text).toContain("Urgent pour 15 h");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://prod.westus.logic.azure.com/workflows/abc");
    expect(JSON.stringify(posts[0].body)).toContain(adminRow.email);
    const bell = (await admin.get("/api/notifications")).json.items.find((n: any) => n.type === "ticket.notify");
    expect(bell).toMatchObject({ data: { message: "Urgent pour 15 h" } });
    expect(bell.link).toBe(`/tickets?t=${ticketId}`);

    // nothing ticked: the bell only
    devOutbox.length = 0;
    posts.length = 0;
    const bellOnly = await tech.post(`/api/tickets/${ticketId}/notify-tech`, { userIds: [adminRow.id], channels: { email: false, sms: false, teams: false } });
    expect(bellOnly.json.people[0]).toEqual({ id: adminRow.id, name: adminRow.name, bell: true });
    expect(devOutbox).toHaveLength(0);
    expect(posts).toHaveLength(0);

    // not yourself, not a stranger
    const [techRow] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    expect((await tech.post(`/api/tickets/${ticketId}/notify-tech`, { userIds: [techRow.id], channels: { email: true, sms: false, teams: false } })).json.error).toBe("no_recipient");
    expect((await tech.post(`/api/tickets/${ticketId}/notify-tech`, { userIds: ["00000000-0000-4000-8000-000000000000"], channels: { email: true, sms: false, teams: false } })).json.error).toBe("no_recipient");
    await admin.put("/api/admin/integrations/teams", { enabled: false });
  });
});

describe("Sécurité › Passbolt (spike): the server only keeps a protected key and forwards a few calls", () => {
  afterAll(() => vi.unstubAllGlobals());
  it("integration address; the right; the key must be protected; only listed Passbolt paths go through; off when the spike is off", async () => {
    resetRateLimit("login:ip:unknown");
    const openpgp = await import("openpgp");
    const { config } = await import("../server/config.ts");
    const admin = await signIn("admin@akab.local");
    const tech = await signIn("tech@akab.local");

    // the integration: only the address, https only, admins only
    expect((await tech.put("/api/admin/integrations/passbolt", { baseUrl: "https://pb.test" })).status).toBe(403);
    expect((await admin.put("/api/admin/integrations/passbolt", { baseUrl: "http://pb.example.com" })).json.error).toBe("passbolt_bad_url");
    expect((await admin.put("/api/admin/integrations/passbolt", { baseUrl: "https://user:pw@pb.test" })).json.error).toBe("passbolt_bad_url");
    expect((await admin.put("/api/admin/integrations/passbolt", { enabled: true })).json.error).toBe("passbolt_incomplete");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/healthcheck/status.json")) return new Response(JSON.stringify({ body: "OK" }), { status: 200 });
      return new Response(JSON.stringify({ header: { code: 200 }, body: [{ id: "x" }] }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "pb=1" } });
    }));
    expect((await admin.put("/api/admin/integrations/passbolt", { enabled: true, baseUrl: "https://pb.test/" })).json).toMatchObject({ enabled: true, baseUrl: "https://pb.test", spikeAllowed: true });
    expect((await admin.post("/api/admin/integrations/passbolt/test")).json.lastTest).toMatchObject({ ok: true });

    // the right: administrators have it, a technician does not
    expect((await admin.get("/api/passbolt/status")).json).toMatchObject({ enabled: true, baseUrl: "https://pb.test", hasKey: false });
    expect((await tech.get("/api/passbolt/status")).status).toBe(403);
    // the trigger: while it is on (the start) nothing of Sécurité shows; off, it shows
    expect((await admin.get("/api/passbolt/status")).json).toMatchObject({ enabled: true });
    expect((await admin.get("/api/admin/integrations/passbolt")).json.hideMenu).toBe(true);
    expect((await admin.get("/api/me")).json.features).toEqual({ passbolt: false });
    expect((await tech.put("/api/admin/integrations/passbolt", { hideMenu: false })).status).toBe(403);
    expect((await admin.put("/api/admin/integrations/passbolt", { hideMenu: false })).json.hideMenu).toBe(false);
    expect((await admin.get("/api/me")).json.features).toEqual({ passbolt: true });

    // the key: must be protected by a passphrase; kept sealed; given back to its owner only
    const protectedKey = (await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "Test", email: "t@test.example" }], passphrase: "pass phrase here", format: "armored" })).privateKey;
    const openKey = (await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "Open", email: "o@test.example" }], format: "armored" })).privateKey;
    const uid = "11111111-2222-4333-8444-555555555555";
    expect((await admin.put("/api/passbolt/key", { armoredKey: "x".repeat(200), passboltUserId: uid })).json.error).toBe("passbolt_bad_key");
    expect((await admin.put("/api/passbolt/key", { armoredKey: openKey, passboltUserId: uid })).json.error).toBe("passbolt_key_unprotected");
    const saved = await admin.put("/api/passbolt/key", { armoredKey: protectedKey, passboltUserId: uid });
    expect(saved.status).toBe(200);
    const row = (await db().select().from(schema.passboltKeys))[0];
    expect(row.armoredSealed.startsWith("v1.")).toBe(true);
    expect(row.armoredSealed).not.toContain("PGP");
    const back = (await admin.get("/api/passbolt/key")).json;
    expect(back).toMatchObject({ passboltUserId: uid, fingerprint: saved.json.fingerprint });
    expect(back.armoredKey).toContain("BEGIN PGP PRIVATE KEY BLOCK");
    expect((await admin.get("/api/passbolt/status")).json).toMatchObject({ hasKey: true, fingerprint: saved.json.fingerprint });

    // the forwarding: a listed path, the person's own bearer token, no cookie of the portal, no cookie back
    calls.length = 0;
    const list = await admin.get("/api/passbolt/proxy/resources.json?api-version=v2&contain[permission]=1");
    expect(list.status).toBe(200);
    expect(list.json.body).toEqual([{ id: "x" }]);
    expect(calls[0].url).toBe("https://pb.test/resources.json?api-version=v2&contain[permission]=1");
    expect((calls[0].init.headers as Record<string, string>).cookie).toBeUndefined();
    // anything else: refused before it leaves
    calls.length = 0;
    expect((await admin.get("/api/passbolt/proxy/users.json")).json.error).toBe("passbolt_path");
    expect((await admin.get("/api/passbolt/proxy/resources/not-a-uuid.json")).json.error).toBe("passbolt_path");
    expect((await admin.get("/api/passbolt/proxy/../../etc/passwd")).status).toBeGreaterThanOrEqual(400);
    expect((await admin.get("/api/passbolt/proxy/resources.json?x=a;b")).json.error).toBe("passbolt_path");
    expect((await admin.del("/api/passbolt/proxy/resources.json")).status).toBe(405);
    expect(calls).toHaveLength(0);
    // a secret read is logged as an event, never with the secret
    expect((await admin.post("/api/passbolt/reveal-log", { resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).status).toBe(200);
    expect((await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "passbolt.reveal"))).length).toBe(1);

    // the key goes with its owner's choice
    expect((await admin.del("/api/passbolt/key")).status).toBe(200);
    expect((await admin.get("/api/passbolt/key")).status).toBe(404);

    // off (production, unless PASSBOLT_SPIKE=true): nothing works, the menu is hidden
    (config as { passboltEnabled: boolean }).passboltEnabled = false;
    try {
      expect((await admin.get("/api/passbolt/status")).json.error).toBe("passbolt_disabled");
      expect((await admin.get("/api/passbolt/proxy/resources.json")).status).toBe(403);
      // even with the trigger off, nothing shows while the spike is off on the server
      expect((await admin.get("/api/me")).json.features).toEqual({ passbolt: false });
    } finally {
      (config as { passboltEnabled: boolean }).passboltEnabled = true;
    }
    await admin.put("/api/admin/integrations/passbolt", { enabled: false, hideMenu: true });
  });
});

describe("ticket checklist: items to complete, with dependencies, before the ticket can be", () => {
  it("made with the ticket; an item waits for another; the ticket cannot be completed while one is open", async () => {
    resetRateLimit("login:ip:unknown");
    const tech = await signIn("tech@akab.local");
    const readOnly = await signIn("viewer@akab.local").catch(() => null);
    const companyId = (await tech.get("/api/tickets/companies")).json[0].id;
    const made = await tech.post("/api/tickets", {
      title: "Installation poste",
      description: "",
      companyId,
      priority: "medium",
      queue: "support",
      assigneeId: null,
      dueDate: "2026-12-01",
      checklist: [{ text: "Préparer le poste" }, { text: "Installer les logiciels", dependsOn: 0 }, { text: "Remettre au client" }],
    });
    expect(made.status).toBe(201);
    const id = made.json.id;
    const detail = async () => (await tech.get(`/api/tickets/${id}`)).json;
    let d = await detail();
    expect(d.checklist.map((x: any) => x.text)).toEqual(["Préparer le poste", "Installer les logiciels", "Remettre au client"]);
    const [a, b, c] = d.checklist;
    expect(b).toMatchObject({ dependsOnId: a.id, blockedBy: { id: a.id } });
    expect(a.blockedBy).toBeNull();
    // the list shows done / total
    expect((await tech.get("/api/tickets?view=all")).json.items.find((x: any) => x.id === id).checklist).toEqual({ done: 0, total: 3 });
    // a dependency can only point at an earlier item when the ticket is made
    const bad = await tech.post("/api/tickets", { title: "x", description: "", companyId, priority: "medium", queue: "support", assigneeId: null, dueDate: "2026-12-01", checklist: [{ text: "a", dependsOn: 0 }] });
    expect(bad.status).toBe(400);

    // an item cannot be ticked before the one it waits for
    expect((await tech.patch(`/api/tickets/${id}/checklist/${b.id}`, { done: true })).json.error).toBe("item_blocked");
    // no loop: a waits for b while b waits for a
    expect((await tech.patch(`/api/tickets/${id}/checklist/${a.id}`, { dependsOnId: b.id })).json.error).toBe("item_cycle");
    expect((await tech.patch(`/api/tickets/${id}/checklist/${a.id}`, { dependsOnId: a.id })).json.error).toBe("item_cycle");

    // the ticket cannot be completed while an item is open (the same rule for every way the status changes)
    const complete = d.options.statuses.find((s: any) => s.kind === "complete").value;
    expect((await tech.patch(`/api/tickets/${id}`, { status: complete })).json.error).toBe("checklist_open");
    expect((await tech.patch(`/api/tickets/${id}`, { priority: "high" })).status).toBe(200);

    // tick in order; an item cannot be un-ticked while one that waited for it is done
    expect((await tech.patch(`/api/tickets/${id}/checklist/${a.id}`, { done: true })).status).toBe(200);
    expect((await tech.patch(`/api/tickets/${id}/checklist/${b.id}`, { done: true })).status).toBe(200);
    expect((await tech.patch(`/api/tickets/${id}/checklist/${a.id}`, { done: false })).json.error).toBe("item_has_done_dependents");
    d = await detail();
    expect(d.checklist.find((x: any) => x.id === b.id)).toMatchObject({ done: true, blockedBy: null, doneBy: expect.any(String) });
    expect((await tech.patch(`/api/tickets/${id}`, { status: complete })).json.error).toBe("checklist_open");

    // add an item (waiting for the last one), delete one: the ones that waited for it are freed
    const added = (await tech.post(`/api/tickets/${id}/checklist`, { text: "Facturer", dependsOnId: c.id })).json;
    const extra = added.find((x: any) => x.text === "Facturer");
    expect(extra).toMatchObject({ dependsOnId: c.id, blockedBy: { id: c.id } });
    expect((await tech.post(`/api/tickets/${id}/checklist`, { text: "x", dependsOnId: "00000000-0000-4000-8000-000000000000" })).json.error).toBe("item_dependency_invalid");
    const afterDelete = (await tech.del(`/api/tickets/${id}/checklist/${c.id}`)).json;
    expect(afterDelete.find((x: any) => x.id === extra.id)).toMatchObject({ dependsOnId: null, blockedBy: null });
    expect((await tech.del(`/api/tickets/${id}/checklist/${c.id}`)).json.error).toBe("item_not_found");
    // reorder
    const order = (await tech.post(`/api/tickets/${id}/checklist/reorder`, { ids: [extra.id, b.id, a.id] })).json.map((x: any) => x.text);
    expect(order).toEqual(["Facturer", "Installer les logiciels", "Préparer le poste"]);

    // everything done: the ticket can be completed
    expect((await tech.patch(`/api/tickets/${id}/checklist/${extra.id}`, { done: true })).status).toBe(200);
    expect((await tech.patch(`/api/tickets/${id}`, { status: complete })).status).toBe(200);
    expect(readOnly === null || (await readOnly.post(`/api/tickets/${id}/checklist`, { text: "interdit" })).status === 403).toBe(true);
  });
});

// ── Sign-in approved on the phone: push + passkey ──
/** A phone's secure hardware, in software: makes a passkey and signs challenges (ES256, user verified) */
function cbor(v: any): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor");
}
class Phone {
  keys = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  credId = nodeCrypto.randomBytes(32);
  counter = 0;
  deviceId = "";
  token = "";
  constructor(public origin = "http://localhost", public rpId = "localhost") {}
  private rpHash = () => nodeCrypto.createHash("sha256").update(this.rpId).digest();
  private clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  /** The passkey made on the phone (attestation "none") */
  register(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const count = Buffer.alloc(4);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credId.length);
    // flags: user present + user verified + attested credential data
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), count, Buffer.alloc(16), idLen, this.credId, cose]);
    const attestationObject = cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.credId.toString("base64url"),
      rawId: this.credId.toString("base64url"),
      type: "public-key",
      response: { clientDataJSON: this.clientData("webauthn.create", challenge).toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
  /** Unlock the passkey (the person is verified on the phone) and sign the challenge; `key` signs with another key to test a forgery */
  sign(challenge: string, opts: { key?: nodeCrypto.KeyObject; verified?: boolean } = {}) {
    this.counter++;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([opts.verified === false ? 0x01 : 0x05]), count]);
    const clientDataJSON = this.clientData("webauthn.get", challenge);
    const signature = nodeCrypto.sign("sha256", Buffer.concat([authData, nodeCrypto.createHash("sha256").update(clientDataJSON).digest()]), opts.key ?? this.keys.privateKey);
    return {
      id: this.credId.toString("base64url"),
      rawId: this.credId.toString("base64url"),
      type: "public-key",
      response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
      clientExtensionResults: {},
    };
  }
}

describe("sign-in approved on the phone (push + passkey)", () => {
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: nodeCrypto.randomBytes(65).toString("base64url"), auth: nodeCrypto.randomBytes(16).toString("base64url") } };

  /** The limits of one person are reset between tests (they share the same account) */
  async function freshLimits(email = "tech@akab.local") {
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, email));
    for (const k of ["enroll", "test", "notify"]) resetRateLimit(`push:${k}:${u.id}`);
  }

  /** A browser that gave the password and waits for the second step */
  async function waiting(email = "tech@akab.local") {
    resetRateLimit("login:ip:unknown");
    const a = new Agent();
    const r = await a.post("/api/auth/login", { email, password: PASSWORD });
    expect(r.json.stage).toBe("mfa");
    return a;
  }

  it("enrolling a phone: the password again, a full session, a real passkey; removing it", async () => {
    resetRateLimit("login:ip:unknown");
    await freshLimits();
    const tech = await signIn("tech@akab.local");
    await db().delete(schema.pushDevices);
    // a session that only gave the password cannot enroll
    const early = await waiting();
    expect((await early.post("/api/auth/push/enroll/options", { password: PASSWORD })).status).toBe(401);
    // the password is asked again
    expect((await tech.post("/api/auth/push/enroll/options", { password: "wrong password" })).status).toBe(401);
    const opts = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    expect(opts).toMatchObject({ rp: { id: "localhost" }, authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" } });
    const phone = new Phone();
    // a passkey made for another site is refused
    const stranger = new Phone("https://evil.example", "evil.example");
    expect((await tech.post("/api/auth/push/enroll/verify", { label: "x", subscription, response: stranger.register(opts.challenge) })).status).toBe(400);
    // a push address that is not one of the browsers' push services is refused (the portal sends to it): an internal address, a look-alike, a port, http
    for (const endpoint of ["https://internal.example/x", "https://fcm.googleapis.com.attacker.example/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://localhost/x"]) {
      expect((await tech.post("/api/auth/push/enroll/verify", { label: "x", subscription: { ...subscription, endpoint }, response: phone.register(opts.challenge) })).status).toBe(400);
    }
    // a push endpoint that is not https is refused
    const opts2 = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    expect((await tech.post("/api/auth/push/enroll/verify", { label: "x", subscription: { ...subscription, endpoint: "http://insecure.test/x" }, response: phone.register(opts2.challenge) })).status).toBe(400);
    const opts3 = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    const done = await tech.post("/api/auth/push/enroll/verify", { label: "Mon cellulaire", subscription, response: phone.register(opts3.challenge) });
    expect(done.status).toBe(201);
    expect(done.json.token.length).toBeGreaterThan(30);
    // the challenge is single use
    expect((await tech.post("/api/auth/push/enroll/verify", { label: "x", subscription, response: phone.register(opts3.challenge) })).status).toBe(400);
    const list = (await tech.get("/api/auth/push/devices")).json;
    expect(list.vapidPublicKey.length).toBeGreaterThan(40);
    expect(list.devices).toEqual([expect.objectContaining({ label: "Mon cellulaire" })]);
    // only the hash of the token and a sealed subscription are kept
    const [row] = await db().select().from(schema.pushDevices);
    expect(row.tokenHash).not.toContain(done.json.token);
    expect(row.subscription).not.toContain("fcm.googleapis.com");
    // removing it
    expect((await tech.del(`/api/auth/push/devices/${done.json.id}`)).status).toBe(200);
    expect((await tech.get("/api/auth/push/devices")).json.devices).toEqual([]);
    expect((await tech.del(`/api/auth/push/devices/${done.json.id}`)).status).toBe(404);
  });

  it("signing in: number matching, the passkey signature, one session only, once", async () => {
    resetRateLimit("login:ip:unknown");
    await freshLimits();
    const tech = await signIn("tech@akab.local");
    await db().delete(schema.pushDevices);
    await db().delete(schema.pushChallenges);
    pushed.length = 0;
    const phone = new Phone();
    const opts = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    const enrolled = (await tech.post("/api/auth/push/enroll/verify", { label: "Cellulaire", subscription, response: phone.register(opts.challenge) })).json;
    phone.deviceId = enrolled.id;
    phone.token = enrolled.token;
    const dev = { deviceId: phone.deviceId, token: phone.token };

    // password given: the browser waits; it learns that a phone can approve
    const browser = await waiting();
    expect((await browser.get("/api/auth/me")).json).toMatchObject({ stage: "mfa", push: 1 });
    // nothing else can be done meanwhile
    expect((await browser.get("/api/tickets")).status).toBe(401);
    const start = (await browser.post("/api/auth/push/start")).json;
    expect(start).toMatchObject({ sent: 1, devices: 1 });
    expect(start.number).toBeGreaterThanOrEqual(10);
    expect(start.number).toBeLessThanOrEqual(99);
    // the push carries no secret, only which request
    const push = pushed.at(-1);
    expect(push.payload).toMatchObject({ type: "signin", challengeId: start.id, deviceId: phone.deviceId });
    // the number is not in it (checked by name: a 2-digit number can sit inside an id by chance)
    expect(Object.keys(push.payload).sort()).toEqual(["body", "challengeId", "deviceId", "title", "type"]);
    expect((await browser.post("/api/auth/push/start")).status).toBe(429);
    expect((await browser.get("/api/auth/push/status")).json).toMatchObject({ status: "pending", number: start.number });

    // the phone: a wrong token is refused; the right one sees where the request comes from and three numbers
    expect((await new Agent().post("/api/auth/push/device/challenge", { deviceId: phone.deviceId, token: "x".repeat(40) })).status).toBe(401);
    const view = (await new Agent().post("/api/auth/push/device/challenge", dev)).json;
    expect(view).toMatchObject({ pending: true, challengeId: start.id });
    expect(view.numbers).toHaveLength(3);
    expect(view.numbers).toContain(start.number);
    expect(view.where.agent).toBeTruthy();
    expect(view.options.challenge).toBeTruthy();
    const respond = (number: number, response: any, id = start.id) => new Agent().post("/api/auth/push/device/respond", { ...dev, challengeId: id, number, response });
    // the wrong number: refused (twice closes the request)
    const wrong = view.numbers.find((n: number) => n !== start.number);
    expect((await respond(wrong, phone.sign(view.options.challenge))).json.error).toBe("push_wrong_number");
    // a signature from another key, or without the person verified on the phone: refused
    const other = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect((await respond(start.number, phone.sign(view.options.challenge, { key: other.privateKey }))).json.error).toBe("push_bad_assertion");
    expect((await respond(start.number, phone.sign(view.options.challenge, { verified: false }))).json.error).toBe("push_bad_assertion");
    // a signature of another challenge: refused
    expect((await respond(start.number, phone.sign("QUJD"))).json.error).toBe("push_bad_assertion");
    expect((await browser.get("/api/auth/me")).json.stage).toBe("mfa");

    // another browser with the password, waiting too: an approval of the first never unlocks it
    const second = await waiting();
    // the right answer
    const ok = await respond(start.number, phone.sign(view.options.challenge));
    expect(ok.json).toMatchObject({ ok: true });
    expect((await browser.get("/api/auth/push/status")).json.status).toBe("approved");
    expect((await browser.get("/api/auth/me")).json.stage).toBe("ready");
    expect((await browser.get("/api/tickets")).status).toBe(200);
    expect((await second.get("/api/auth/me")).json.stage).toBe("mfa");
    // single use: the same answer again is refused, and replaying the signature too
    expect((await respond(start.number, phone.sign(view.options.challenge))).status).toBe(409);
    // the audit trail
    const log = (await db().select().from(schema.auditLog)).map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(["push.device_added", "push.challenge_sent", "push.signin_approved", "push.wrong_number", "push.bad_assertion"]));
    // the counter moved on and the phone's last use is kept
    const [row] = await db().select().from(schema.pushDevices);
    expect(row.counter).toBeGreaterThan(0);
    expect(row.lastUsedAt).toBeTruthy();
  });

  it("the portal's notifications reach the enrolled phone: the kind only by default, the detail on request, a switch per phone, a test", async () => {
    resetRateLimit("login:ip:unknown");
    await freshLimits();
    const tech = await signIn("tech@akab.local");
    const admin = await signIn("admin@akab.local");
    const me = (await tech.get("/api/me")).json.id as string;
    await db().delete(schema.pushDevices);
    const phone = new Phone();
    const opts = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    const enrolled = (await tech.post("/api/auth/push/enroll/verify", { label: "Cellulaire", subscription, response: phone.register(opts.challenge) })).json;
    const settle = () => new Promise((r) => setTimeout(r, 150));
    const assign = async (title: string) => (await admin.post("/api/pipeline/tasks", { title, assigneeId: me })).json;
    const notices = () => pushed.filter((p) => p.payload.type === "notify" && p.payload.notifType === "pipeline.assigned");

    // by default: what kind it is, never the title
    pushed.length = 0;
    const t1 = await assign("Changer le mot de passe du NAS de Garage Bouchard");
    await settle();
    expect(notices()).toHaveLength(1);
    expect(notices()[0].payload).toMatchObject({ title: "Tâche pour vous", body: "Touchez pour ouvrir le portail.", url: `/pipeline?task=${t1.id}` });
    expect(JSON.stringify(notices()[0].payload)).not.toContain("NAS");
    // the detail on the lock screen, when asked for
    expect((await tech.put("/api/me/preferences", { pushDetails: true })).status).toBe(200);
    expect((await tech.get("/api/me")).json.preferences.pushDetails).toBe(true);
    pushed.length = 0;
    await assign("Appeler Garage Bouchard");
    await settle();
    expect(notices()[0].payload.body).toContain("Appeler Garage Bouchard");
    // a phone that does not take the notifications gets none (the sign-in approvals stay)
    expect((await tech.patch(`/api/auth/push/devices/${enrolled.id}`, { notify: false })).status).toBe(200);
    pushed.length = 0;
    await assign("Rien sur le téléphone");
    await settle();
    expect(notices()).toHaveLength(0);
    expect((await tech.get("/api/auth/push/devices")).json.devices[0].notify).toBe(false);
    expect((await admin.patch(`/api/auth/push/devices/${enrolled.id}`, { notify: true })).status).toBe(404);
    expect((await tech.patch(`/api/auth/push/devices/${enrolled.id}`, { notify: true })).status).toBe(200);
    // the test button: only the person's own phone
    pushed.length = 0;
    expect((await tech.post(`/api/auth/push/devices/${enrolled.id}/test`, {})).json).toEqual({ sent: true });
    expect(pushed.at(-1)!.payload).toMatchObject({ type: "notify", notifType: "test" });
    expect((await admin.post(`/api/auth/push/devices/${enrolled.id}/test`, {})).status).toBe(404);
    // a link is only ever a path of the portal
    const { safePath } = await import("../server/lib/pushNotify.ts");
    expect(safePath("/tickets?t=1")).toBe("/tickets?t=1");
    expect(safePath("//evil.example/x")).toBe("/");
    expect(safePath("https://evil.example")).toBe("/");
    expect(safePath("/\\evil.example")).toBe("/");
    await tech.put("/api/me/preferences", { pushDetails: false });
    await db().delete(schema.pushDevices);
  });

  it("when the push service refuses, the sign-in page and the log say why; a phone it no longer knows is removed", async () => {
    resetRateLimit("login:ip:unknown");
    await freshLimits();
    const tech = await signIn("tech@akab.local");
    await db().delete(schema.pushDevices);
    await db().delete(schema.pushChallenges);
    const phone = new Phone();
    const opts = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    const e = (await tech.post("/api/auth/push/enroll/verify", { label: "Cellulaire", subscription, response: phone.register(opts.challenge) })).json;
    try {
      // refused (a key problem on our side): nothing sent, the reason is told, the phone stays
      pushFail.next = { statusCode: 403, body: "BadJwtToken" };
      const b1 = await waiting();
      const r1 = (await b1.post("/api/auth/push/start")).json;
      expect(r1).toMatchObject({ sent: 0, devices: 1 });
      expect(r1.failures[0]).toMatchObject({ status: 403 });
      expect(r1.failures[0].reason).toContain("refused");
      expect(r1.failures[0].reason).toContain("BadJwtToken");
      expect((await tech.get("/api/auth/push/devices")).json.devices).toHaveLength(1);
      // the test button says why too
      expect((await tech.post(`/api/auth/push/devices/${e.id}/test`, {})).json).toMatchObject({ sent: false, status: 403 });
      // the audit trail has it
      const sentLog = (await db().select().from(schema.auditLog)).filter((r) => r.action === "push.challenge_sent").at(-1);
      expect(JSON.stringify(sentLog?.details)).toContain("BadJwtToken");
      // no answer at all (the server cannot reach the push service)
      pushFail.next = {};
      const b2 = await waiting();
      expect((await b2.post("/api/auth/push/start")).json.failures[0]).toMatchObject({ status: null });
      // the push service no longer knows the phone: it is removed, and the next sign-in says there is none
      pushFail.next = { statusCode: 410 };
      const b3 = await waiting();
      expect((await b3.post("/api/auth/push/start")).json.failures[0].reason).toBe("gone");
      expect((await tech.get("/api/auth/push/devices")).json.devices).toEqual([]);
      pushFail.next = null;
      const b4 = await waiting();
      expect((await b4.post("/api/auth/push/start")).json.error).toBe("push_no_device");
      expect((await b4.get("/api/auth/me")).json.push).toBe(0);
    } finally {
      pushFail.next = null;
      await db().delete(schema.pushChallenges);
      await db().delete(schema.pushDevices);
    }
  });

  it("two wrong numbers close the request; \"not me\" closes the session and rests the account; an old request is refused", async () => {
    resetRateLimit("login:ip:unknown");
    await freshLimits();
    const [user] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    // a phone object bound to the stored device: its token is not kept, so enroll a fresh one
    const tech = await signIn("tech@akab.local");
    await db().delete(schema.pushDevices);
    const phone = new Phone();
    const opts = (await tech.post("/api/auth/push/enroll/options", { password: PASSWORD })).json;
    const e = (await tech.post("/api/auth/push/enroll/verify", { label: "Cellulaire", subscription, response: phone.register(opts.challenge) })).json;
    const dev = { deviceId: e.id, token: e.token };

    // two wrong numbers
    const b1 = await waiting();
    const s1 = (await b1.post("/api/auth/push/start")).json;
    const v1 = (await new Agent().post("/api/auth/push/device/challenge", dev)).json;
    const wrongs = v1.numbers.filter((n: number) => n !== s1.number);
    for (const n of wrongs) await new Agent().post("/api/auth/push/device/respond", { ...dev, challengeId: s1.id, number: n, response: phone.sign(v1.options.challenge) });
    expect((await b1.get("/api/auth/push/status")).json.status).toBe("failed");
    expect((await new Agent().post("/api/auth/push/device/challenge", dev)).json.pending).toBe(false);

    // an expired request: refused, and the status says so
    const b2 = await waiting();
    const s2 = (await b2.post("/api/auth/push/start")).json;
    await db().update(schema.pushChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.pushChallenges.id, s2.id));
    expect((await b2.get("/api/auth/push/status")).json.status).toBe("expired");
    const v2 = await new Agent().post("/api/auth/push/device/challenge", dev);
    expect(v2.json.pending).toBe(false);

    // "not me": the session that asked is closed and the account rests
    const b3 = await waiting();
    const s3 = (await b3.post("/api/auth/push/start")).json;
    expect((await new Agent().post("/api/auth/push/device/deny", { ...dev, challengeId: s3.id })).status).toBe(200);
    expect((await b3.get("/api/auth/me")).json.stage).toBe("anonymous");
    resetRateLimit("login:ip:unknown");
    expect((await new Agent().post("/api/auth/login", { email: "tech@akab.local", password: PASSWORD })).status).toBe(429);
    const alerts = (await db().select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).filter((n) => n.type === "security.alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    await db().update(schema.users).set({ lockedUntil: null }).where(eq(schema.users.id, user.id));

    // an administrator resetting the MFA removes the phones
    const admin = await signIn("admin@akab.local");
    expect((await admin.post(`/api/admin/users/${user.id}/reset-mfa`, {})).status).toBe(200);
    expect((await new Agent().post("/api/auth/push/device/challenge", dev)).status).toBe(401);
    // the secret of the authenticator was reset: the next sign-in sets it up again
    secrets.delete("tech@akab.local");
    await db().delete(schema.pushChallenges);
  });
});
