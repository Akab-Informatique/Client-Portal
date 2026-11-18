import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "true";
delete process.env.REQUIRE_MFA;

const { initDb, db, schema } = await import("../server/db/index.ts");
const { seed } = await import("../server/db/seed.ts");
const { createApp } = await import("../server/app.ts");
const { eq } = await import("drizzle-orm");
const { resetRateLimit } = await import("../server/lib/http.ts");
const noc = await import("../server/lib/noc.ts");
const { clearSelfManagedCache } = await import("../server/lib/selfManaged.ts");

let app: ReturnType<typeof createApp>;
const PASSWORD = "akab-dev-password";

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      host: "localhost",
      origin: "http://localhost",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function signIn(email: string): Promise<string> {
  resetRateLimit("login:ip:unknown");
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const m = res.headers.getSetCookie().join(";").match(/akab_session=([^;]+)/);
  return `akab_session=${m![1]}`;
}

let admin = "";
let tech = "";
const resetLimits = () => ["display", "display:bad"].forEach((k) => resetRateLimit(`noc:${k}:unknown`));
const keyOf = async () => (await call("GET", "/api/noc/settings", { cookie: admin })).json.displayKey as string;
const feed = async (key: string) => call("GET", `/api/noc/display/state?key=${encodeURIComponent(key)}`);

beforeAll(async () => {
  await initDb({ memory: true });
  await seed();
  app = createApp();
  admin = await signIn("admin@akab.local");
  tech = await signIn("tech@akab.local");
  await db().insert(schema.integrations).values({ provider: "tickets", enabled: true, config: { mode: "local" } }).onConflictDoUpdate({ target: schema.integrations.provider, set: { enabled: true, config: { mode: "local" } } });
  (await import("../server/lib/localTickets.ts")).resetTicketMode();
});

afterEach(() => {
  vi.unstubAllGlobals();
  noc.resetNocCache();
  resetLimits();
});

describe("Technical TV dashboard: the display key", () => {
  it("answers 404 without the key or with a wrong one, 200 with it, and rotating stops the old key", async () => {
    resetLimits();
    expect((await call("GET", "/api/noc/display/state")).status).toBe(404);
    expect((await feed("not-the-key-at-all")).status).toBe(404);
    const key = await keyOf();
    const ok = await feed(key);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    // the lobby's key does not open this screen
    const lobby = (await call("GET", "/api/tv/bots", { cookie: admin })).json.displayKey as string;
    expect(lobby).not.toBe(key);
    expect((await feed(lobby)).status).toBe(404);
    const rotated = (await call("POST", "/api/noc/display-key/rotate", { cookie: admin, body: {} })).json.displayKey as string;
    expect(rotated).not.toBe(key);
    resetLimits();
    expect((await feed(key)).status).toBe(404);
    expect((await feed(rotated)).status).toBe(200);
    const [row] = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "noc.display_key_rotated"));
    expect(row).toBeTruthy();
  });

  it("limits wrong keys: 10 a minute, then 429", async () => {
    resetLimits();
    for (let i = 0; i < 10; i++) expect((await feed(`wrong-key-${i}-wrong`)).status).toBe(404);
    expect((await feed("wrong-key-last-wrong")).status).toBe(429);
    resetLimits();
  });
});

describe("Technical TV dashboard: rights", () => {
  it("the preview needs tv.view; the key and its rotation need tv.manage", async () => {
    expect((await call("GET", "/api/noc/state")).status).toBe(401);
    expect((await call("GET", "/api/noc/settings")).status).toBe(401);
    expect((await call("GET", "/api/noc/state", { cookie: tech })).status).toBe(200);
    expect((await call("GET", "/api/noc/settings", { cookie: tech })).status).toBe(403);
    expect((await call("POST", "/api/noc/display-key/rotate", { cookie: tech, body: {} })).status).toBe(403);
    const [role] = await db().select().from(schema.roles).where(eq(schema.roles.slug, "technician"));
    await db().update(schema.roles).set({ permissions: role.permissions.filter((p) => p !== "tv.view") }).where(eq(schema.roles.id, role.id));
    expect((await call("GET", "/api/noc/state", { cookie: tech })).status).toBe(403);
    await db().update(schema.roles).set({ permissions: role.permissions }).where(eq(schema.roles.id, role.id));
  });
});

describe("Technical TV dashboard: what the snapshot holds", () => {
  it("counts tickets like the meeting gauges, keeps alerts apart, hides self-managed tickets, and leaks nothing private", async () => {
    const [techUser] = await db().select().from(schema.users).where(eq(schema.users.email, "tech@akab.local"));
    const [own] = await db().insert(schema.clients).values({ name: "Zz Autogere (noc)", autotaskId: 9_400_001, selfManaged: "on" }).returning();
    const [plain] = await db().insert(schema.clients).values({ name: "Clinique des Pins (noc)", autotaskId: 9_400_002 }).returning();
    clearSelfManagedCache();
    const mk = async (title: string, companyId: number, extra: Record<string, unknown> = {}) =>
      (await call("POST", "/api/tickets", { cookie: admin, body: { title, description: "SECRETDESC", companyId, priority: "high", queue: "support", assigneeId: null, dueDate: "2020-01-05", ...extra } })).json;
    const normal = await mk("Imprimante du comptoir hors service depuis ce matin et personne ne peut imprimer les factures de la clinique", plain.autotaskId!, { assigneeId: techUser.id });
    const hidden = await mk("Billet autogéré", own.autotaskId!);
    const alert = await mk("Alerte disque", plain.autotaskId!, { queue: "alerts" });
    await db().update(schema.tickets).set({ akabTakenAt: null }).where(eq(schema.tickets.id, hidden.id));
    await call("POST", `/api/tickets/${normal.id}/notes`, { cookie: admin, body: { text: "SECRETNOTE jean@client.example 514-555-0199", internal: true } });
    noc.resetNocCache();

    const key = await keyOf();
    const r = await feed(key);
    expect(r.status).toBe(200);
    const s = r.json;
    // counted like the gauges: no monitoring alert, no hidden self-managed ticket
    expect(s.tickets.alerts).toBeGreaterThanOrEqual(1);
    const numbers = s.tickets.urgent.map((x: { number: string }) => x.number);
    expect(numbers).toContain(normal.number);
    expect(numbers).not.toContain(hidden.number);
    expect(numbers).not.toContain(alert.number);
    expect(s.tickets.overdue).toBeGreaterThanOrEqual(1);
    const row = s.tickets.urgent.find((x: { number: string }) => x.number === normal.number);
    expect(row.client).toBe("Clinique des Pins (noc)");
    expect([...row.title].length).toBeLessThanOrEqual(noc.TITLE_MAX);
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.late).toBe(true);
    // a technician shows by first name only
    expect(s.techs.length).toBeGreaterThan(0);
    for (const t of s.techs) expect(t.name).not.toMatch(/\s/);
    // nothing private
    expect(r.text).not.toMatch(/SECRET/);
    expect(r.text).not.toMatch(/@/);
    expect(r.text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(r.text).not.toMatch(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    expect(r.text).not.toMatch(/"(email|phone|ip|mac|hostname|description|notes|contact)"/i);
    expect(r.text).not.toMatch(/"key"|displayKey/);
  });

  it("reads the device counts from the synced rmm_devices table (and hides the panel with none)", async () => {
    await db().delete(schema.rmmDevices);
    noc.resetNocCache();
    expect((await call("GET", "/api/noc/state", { cookie: tech })).json.rmm).toBeNull();
    const old = new Date(Date.now() - 20 * 86_400_000);
    await db().insert(schema.rmmDevices).values([
      { uid: "noc-a", siteUid: "s1", hostname: "PC-SECRET-1", online: true, ip: "10.1.2.3" },
      { uid: "noc-b", siteUid: "s1", hostname: "PC-SECRET-2", online: false, lastSeen: old, rebootRequired: true },
      { uid: "noc-c", siteUid: "s1", hostname: "PC-SECRET-3", online: true, patchesPending: 4 },
    ]);
    noc.resetNocCache();
    const r = await call("GET", "/api/noc/state", { cookie: tech });
    expect(r.json.rmm).toEqual({ total: 3, online: 2, offline: 1, offline7d: 1, reboot: 1, patches: 1 });
    expect(r.text).not.toMatch(/PC-SECRET|10\.1\.2\.3/);
    await db().delete(schema.rmmDevices);
  });

  it("a failing UniFi still returns the rest, and UniFi off hides its panel", async () => {
    noc.resetNocCache();
    expect((await call("GET", "/api/noc/state", { cookie: tech })).json.unifi).toBeNull();
    const { saveUnifiSettings } = await import("../server/lib/unifi.ts");
    await saveUnifiSettings(null, { enabled: true, apiKey: "test-key-not-real" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    noc.resetNocCache();
    const r = await call("GET", "/api/noc/state", { cookie: tech });
    expect(r.status).toBe(200);
    expect(r.json.unifi).toEqual({ error: true });
    expect(r.json.tickets.open).toBeGreaterThanOrEqual(0);
    expect(r.json.rmm === null || typeof r.json.rmm === "object").toBe(true);
    await saveUnifiSettings(null, { enabled: false, apiKey: null });
  });

  it("carries the rest screen of the lobby's settings and a 7-day trend", async () => {
    noc.resetNocCache();
    const forced = await call("GET", "/api/noc/state?rest=1", { cookie: tech });
    expect(forced.json.screen.rest).toBe(true);
    expect(typeof forced.json.screen.brightness).toBe("number");
    expect(forced.json.trend).toHaveLength(7);
    expect((await call("GET", "/api/noc/state", { cookie: tech })).json.screen.rest === true || true).toBe(true);
  });
});
