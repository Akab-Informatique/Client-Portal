import { beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "true";
delete process.env.REQUIRE_MFA;

const { initDb, db, schema } = await import("../server/db/index.ts");
const { seed } = await import("../server/db/seed.ts");
const { createApp } = await import("../server/app.ts");
const { eq } = await import("drizzle-orm");
const { resetRateLimit } = await import("../server/lib/http.ts");
const tv = await import("../server/lib/tv.ts");
const { MODULES, SYSTEM_ROLES } = await import("../shared/permissions.ts");

let app: ReturnType<typeof createApp>;
const PASSWORD = "akab-dev-password";

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      host: "localhost",
      origin: "http://localhost",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
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
const resetLimits = () => ["display", "display:bad", "report", "report:bad"].forEach((k) => resetRateLimit(`tv:${k}:unknown`));

type Managed = { displayKey: string; labels: string[]; bots: { id: string; name: string; key: string; sort: number; state: string; label: string | null }[] };
const manage = async () => (await call("GET", "/api/tv/bots", { cookie: admin })).json as Managed;
const botNamed = async (name: string) => (await manage()).bots.find((b) => b.name === name)!;

beforeAll(async () => {
  await initDb({ memory: true });
  await seed();
  app = createApp();
  admin = await signIn("admin@akab.local");
  tech = await signIn("tech@akab.local");
});

describe("Dashboard TV: unassigned tickets", () => {
  it("both feeds carry the number of unassigned new tickets, and nothing else about them", async () => {
    resetLimits();
    const key = (await manage()).displayKey;
    const display = await call("GET", `/api/tv/display/state?key=${encodeURIComponent(key)}`);
    expect(display.status).toBe(200);
    expect(typeof display.json.unassigned).toBe("number");
    expect(display.json.unassigned).toBeGreaterThanOrEqual(0);
    const signed = await call("GET", "/api/tv/state", { cookie: tech });
    expect(typeof signed.json.unassigned).toBe("number");
    expect(display.text).not.toMatch(/"(title|number|company)"/);
  });
});

describe("Dashboard TV: rights", () => {
  it("has tv.view and tv.manage, given to administrators; technicians only view", () => {
    const keys = MODULES.find((m) => m.key === "tv")!.permissions.map((p) => p.key);
    expect(keys).toEqual(["tv.view", "tv.manage"]);
    const role = (slug: string) => SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions as string[];
    expect(role("administrator")).toEqual(expect.arrayContaining(keys));
    expect(role("global-admin")).toEqual(expect.arrayContaining(keys));
    expect(role("technician")).toContain("tv.view");
    expect(role("technician")).not.toContain("tv.manage");
  });

  it("guards every signed-in route", async () => {
    // not signed in
    for (const [m, p] of [
      ["GET", "/api/tv/state"],
      ["GET", "/api/tv/bots"],
      ["POST", "/api/tv/bots"],
      ["PATCH", "/api/tv/bots/clicky"],
      ["DELETE", "/api/tv/bots/clicky"],
      ["POST", "/api/tv/bots/clicky/rotate-key"],
      ["POST", "/api/tv/display-key/rotate"],
      ["POST", "/api/tv/bots/clicky/status"],
    ]) {
      expect((await call(m, p, { body: m === "GET" ? undefined : {} })).status, `${m} ${p}`).toBe(401);
    }
    // a technician sees the page but manages nothing
    expect((await call("GET", "/api/tv/state", { cookie: tech })).status).toBe(200);
    for (const [m, p, b] of [
      ["GET", "/api/tv/bots", undefined],
      ["POST", "/api/tv/bots", { name: "Nouveau" }],
      ["PATCH", "/api/tv/bots/clicky", { sort: 3 }],
      ["DELETE", "/api/tv/bots/clicky", undefined],
      ["POST", "/api/tv/bots/clicky/rotate-key", {}],
      ["POST", "/api/tv/display-key/rotate", {}],
      ["POST", "/api/tv/bots/clicky/status", { state: "idle" }],
    ] as const) {
      expect((await call(m, p, { cookie: tech, body: b })).status, `${m} ${p}`).toBe(403);
    }
    // without tv.view, no state
    const [role] = await db().select().from(schema.roles).where(eq(schema.roles.slug, "technician"));
    await db().update(schema.roles).set({ permissions: role.permissions.filter((p) => p !== "tv.view") }).where(eq(schema.roles.id, role.id));
    expect((await call("GET", "/api/tv/state", { cookie: tech })).status).toBe(403);
    await db().update(schema.roles).set({ permissions: role.permissions }).where(eq(schema.roles.id, role.id));
    expect((await call("GET", "/api/tv/state", { cookie: tech })).status).toBe(200);
  });

  it("blocks a cross-site change by a signed-in manager", async () => {
    const r = await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "Evil" }, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("Dashboard TV: bots and state", () => {
  it("starts with the 9 bots, idle, in order", async () => {
    const r = await call("GET", "/api/tv/state", { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("portal");
    expect(r.json.stale).toBe(false);
    expect(new Date(r.json.updatedAt).getTime()).not.toBeNaN();
    expect(r.json.bots.map((b: any) => b.name)).toEqual(["Clicky", "Finance", "Adjointe", "Portail AKAB", "Boss", "Facebook", "Légale", "Vidéaste", "L'artiste"]);
    expect(r.json.bots.map((b: any) => b.id)).toContain("legale");
    for (const b of r.json.bots) {
      expect(b.state).toBe("idle");
      expect(b.label).toBeNull();
      expect(Object.keys(b).sort()).toEqual(["id", "label", "name", "since", "state"]);
    }
  });

  it("lists the 45 approved labels and the keys for managers", async () => {
    const m = await manage();
    expect(m.labels).toHaveLength(45);
    expect(new Set(m.labels).size).toBe(45);
    expect(m.displayKey.length).toBeGreaterThanOrEqual(32);
    for (const b of m.bots) expect(b.key.length).toBeGreaterThanOrEqual(32);
    expect(new Set(m.bots.map((b) => b.key)).size).toBe(9);
  });

  it("validates names", () => {
    expect(tv.cleanName("  Légale ")).toBe("Légale");
    expect(tv.cleanName("L’artiste")).toBe("L'artiste");
    expect(tv.cleanName("Bot-2 Prod")).toBe("Bot-2 Prod");
    for (const bad of ["", "   ", "x".repeat(13), "a'b'c", "<b>", "Bot;", "a/b", "'", "---", 5, null, "Bot\nX"]) expect(tv.cleanName(bad), String(bad)).toBeNull();
  });

  it("adds, renames, reorders and removes bots; names are unique ignoring case and accents", async () => {
    let r = await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "Zébulon" } });
    expect(r.status).toBe(201);
    const id = r.json.id;
    expect((await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "zebulon" } })).status).toBe(409);
    expect((await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "CLICKY" } })).status).toBe(409);
    expect((await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "Mauvais!" } })).status).toBe(400);
    expect((await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "x".repeat(13) } })).status).toBe(400);
    r = await call("PATCH", `/api/tv/bots/${id}`, { cookie: admin, body: { name: "Zeb", sort: 100 } });
    expect(r.status).toBe(200);
    expect((await call("PATCH", `/api/tv/bots/${id}`, { cookie: admin, body: { name: "boss" } })).status).toBe(409);
    expect((await call("PATCH", "/api/tv/bots/nope", { cookie: admin, body: { sort: 1 } })).status).toBe(404);
    const state = (await call("GET", "/api/tv/state", { cookie: admin })).json;
    expect(state.bots.at(-1).name).toBe("Zeb");
    expect((await call("DELETE", `/api/tv/bots/${id}`, { cookie: admin })).status).toBe(200);
    expect((await call("DELETE", `/api/tv/bots/${id}`, { cookie: admin })).status).toBe(404);
  });

  it("allows at most 12 bots", async () => {
    let count = (await manage()).bots.length;
    const added: string[] = [];
    for (; count < 12; count++) {
      const r = await call("POST", "/api/tv/bots", { cookie: admin, body: { name: `Extra ${count}` } });
      expect(r.status).toBe(201);
      added.push(r.json.id);
    }
    const over = await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "Treizième" } });
    expect(over.status).toBe(409);
    expect(over.json.error).toBe("too_many_bots");
    for (const id of added) await call("DELETE", `/api/tv/bots/${id}`, { cookie: admin });
    expect((await manage()).bots.map((b) => b.name)).toHaveLength(9);
  });

  it("lets a manager set a status by hand, with the same sanitising", async () => {
    const id = (await botNamed("Boss")).id;
    expect((await call("POST", `/api/tv/bots/${id}/status`, { cookie: admin, body: { state: "working", label: "Revue des priorités" } })).status).toBe(200);
    let b = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((x: any) => x.id === id);
    expect([b.state, b.label]).toEqual(["working", "Revue des priorités"]);
    await call("POST", `/api/tv/bots/${id}/status`, { cookie: admin, body: { state: "needs_human", label: "Facture de Dupont inc. impayée" } });
    b = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((x: any) => x.id === id);
    expect([b.state, b.label]).toEqual(["needs_human", "Besoin d'aide"]);
    expect((await call("POST", `/api/tv/bots/${id}/status`, { cookie: admin, body: { state: "bogus" } })).status).toBe(400);
    expect((await call("POST", "/api/tv/bots/nope/status", { cookie: admin, body: { state: "idle" } })).status).toBe(404);
    await call("POST", `/api/tv/bots/${id}/status`, { cookie: admin, body: { state: "idle", label: "Tri des courriels" } });
    b = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((x: any) => x.id === id);
    expect([b.state, b.label]).toEqual(["idle", null]);
  });

  it("writes the changes to the audit log, never a key", async () => {
    const rows = await db().select().from(schema.auditLog);
    const tvRows = rows.filter((r) => r.action.startsWith("tv."));
    expect(tvRows.length).toBeGreaterThan(3);
    const keys = (await manage()).bots.map((b) => b.key).concat((await manage()).displayKey);
    const dump = JSON.stringify(tvRows);
    for (const k of keys) expect(dump).not.toContain(k);
  });
});

describe("Dashboard TV: the public screen", () => {
  it("answers with the right display key only, and hides every secret", async () => {
    resetLimits();
    const m = await manage();
    const ok = await call("GET", `/api/tv/display/state?key=${encodeURIComponent(m.displayKey)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.json.source).toBe("portal");
    expect(ok.json.bots).toHaveLength(9);
    for (const secret of [m.displayKey, ...m.bots.map((b) => b.key)]) expect(ok.text).not.toContain(secret);
    expect(ok.text).not.toMatch(/"key"|displayKey/);

    const other404 = await call("GET", "/api/tv/nothing-here");
    const wrong = await call("GET", "/api/tv/display/state?key=wrong");
    const missing = await call("GET", "/api/tv/display/state");
    for (const r of [wrong, missing]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(other404.text);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
    // a bot's report key is not the display key
    expect((await call("GET", `/api/tv/display/state?key=${m.bots[0].key}`)).status).toBe(404);
  });

  it("needs no session and ignores one", async () => {
    resetLimits();
    const m = await manage();
    expect((await call("GET", `/api/tv/display/state?key=${m.displayKey}`)).status).toBe(200);
    expect((await call("GET", `/api/tv/display/state?key=${m.displayKey}`, { cookie: tech })).status).toBe(200);
  });

  it("limits wrong keys to 10 a minute, then 429 even for the right key", async () => {
    resetLimits();
    const m = await manage();
    for (let i = 0; i < 10; i++) expect((await call("GET", `/api/tv/display/state?key=bad${i}`)).status).toBe(404);
    const blocked = await call("GET", "/api/tv/display/state?key=bad-again");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await call("GET", `/api/tv/display/state?key=${m.displayKey}`)).status).toBe(429);
    resetLimits();
    expect((await call("GET", `/api/tv/display/state?key=${m.displayKey}`)).status).toBe(200);
  });

  it("limits requests to 120 a minute per address", async () => {
    resetLimits();
    const m = await manage();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await call("GET", `/api/tv/display/state?key=${m.displayKey}`)).status;
    expect(last).toBe(429);
    resetLimits();
  });

  it("stops working with the old display key once rotated", async () => {
    resetLimits();
    const m = await manage();
    const r = await call("POST", "/api/tv/display-key/rotate", { cookie: admin, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.displayKey).not.toBe(m.displayKey);
    expect((await call("GET", `/api/tv/display/state?key=${m.displayKey}`)).status).toBe(404);
    expect((await call("GET", `/api/tv/display/state?key=${r.json.displayKey}`)).status).toBe(200);
    expect((await manage()).displayKey).toBe(r.json.displayKey);
    resetLimits();
  });
});

describe("Dashboard TV: report links", () => {
  const publicBots = async () => {
    const m = await manage();
    const s = await call("GET", `/api/tv/display/state?key=${m.displayKey}`);
    return { m, s: s.json, text: s.text };
  };

  it("takes the state aliases, in GET and POST, with a plain text answer", async () => {
    resetLimits();
    const { key } = await botNamed("Clicky");
    const get = await call("GET", `/api/tv/r/${key}/travail`);
    expect(get.status).toBe(200);
    expect(get.text).toBe("OK Clicky working");
    expect(get.headers.get("content-type")).toContain("text/plain");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    for (const [alias, state] of [
      ["WORKING", "working"],
      ["repos", "idle"],
      ["idle", "idle"],
      ["aide", "needs_human"],
      ["humain", "needs_human"],
      ["help", "needs_human"],
      ["needs_human", "needs_human"],
      ["travail", "working"],
    ]) {
      const r = await call("POST", `/api/tv/r/${key}/${alias}`);
      expect(r.text, alias).toBe(`OK Clicky ${state}`);
    }
    expect((await call("GET", `/api/tv/r/${key}/nonsense`)).status).toBe(404);
    resetLimits();
  });

  it("shows an approved label by its index, and the generic text otherwise", async () => {
    resetLimits();
    const { key } = await botNamed("Finance");
    const { m } = await publicBots();
    const idx = m.labels.indexOf("Rapprochement bancaire");
    expect(idx).toBeGreaterThan(11);
    await call("GET", `/api/tv/r/${key}/working/${idx}`);
    let f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect([f.state, f.label]).toEqual(["working", "Rapprochement bancaire"]);
    await call("GET", `/api/tv/r/${key}/working/999`);
    f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect(f.label).toBe("Tâche en cours");
    await call("GET", `/api/tv/r/${key}/working/Facture%20de%20Dupont%20inc`);
    f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect(f.label).toBe("Tâche en cours");
    await call("GET", `/api/tv/r/${key}/aide/-1`);
    f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect([f.state, f.label]).toEqual(["needs_human", "Besoin d'aide"]);
    await call("GET", `/api/tv/r/${key}/aide/${idx}`);
    f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect(f.label).toBe("Rapprochement bancaire");
    await call("GET", `/api/tv/r/${key}/repos/${idx}`);
    f = (await publicBots()).s.bots.find((b: any) => b.name === "Finance");
    expect([f.state, f.label]).toEqual(["idle", null]);
    // never any free text in the database
    const stored = await db().select().from(schema.tvStatus);
    for (const s of stored) if (s.label) expect(m.labels.concat(["Tâche en cours", "Besoin d'aide"])).toContain(s.label);
    resetLimits();
  });

  it("works for bots with an accent or an apostrophe in their name", async () => {
    resetLimits();
    const a = await botNamed("L'artiste");
    const b = await botNamed("Légale");
    expect((await call("GET", `/api/tv/r/${a.key}/working/${(await manage()).labels.indexOf("Création graphique")}`)).text).toBe("OK L'artiste working");
    expect((await call("GET", `/api/tv/r/${b.key}/aide`)).text).toBe("OK Légale needs_human");
    const { s } = await publicBots();
    expect(s.bots.find((x: any) => x.name === "L'artiste").label).toBe("Création graphique");
    expect(s.bots.find((x: any) => x.name === "Légale").state).toBe("needs_human");
    resetLimits();
  });

  it("keeps the 'since' time while the state does not change", async () => {
    resetLimits();
    const { key } = await botNamed("Adjointe");
    await call("GET", `/api/tv/r/${key}/repos`);
    await call("GET", `/api/tv/r/${key}/working`);
    const first = (await publicBots()).s.bots.find((x: any) => x.name === "Adjointe").since;
    await new Promise((r) => setTimeout(r, 15));
    await call("GET", `/api/tv/r/${key}/working/2`);
    expect((await publicBots()).s.bots.find((x: any) => x.name === "Adjointe").since).toBe(first);
    resetLimits();
  });

  it("answers an unknown key like any other 404", async () => {
    resetLimits();
    const other404 = await call("GET", "/api/tv/nothing-here");
    const unknown = await call("GET", "/api/tv/r/not-a-real-key/working");
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe(other404.text);
    expect(unknown.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await call("POST", "/api/tv/r/not-a-real-key/working")).status).toBe(404);
    resetLimits();
  });

  it("limits unknown keys to 10 a minute, then 429", async () => {
    resetLimits();
    const { key } = await botNamed("Clicky");
    for (let i = 0; i < 10; i++) expect((await call("GET", `/api/tv/r/guess${i}/working`)).status).toBe(404);
    expect((await call("GET", "/api/tv/r/guess-more/working")).status).toBe(429);
    expect((await call("GET", `/api/tv/r/${key}/working`)).status).toBe(429);
    resetLimits();
  });

  it("limits reports to 60 a minute per address", async () => {
    resetLimits();
    const { key } = await botNamed("Clicky");
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call("GET", `/api/tv/r/${key}/idle`)).status;
    expect(last).toBe(429);
    resetLimits();
  });

  it("never puts a key in the public body", async () => {
    resetLimits();
    const { m, text } = await publicBots();
    for (const secret of [m.displayKey, ...m.bots.map((b) => b.key)]) expect(text).not.toContain(secret);
    resetLimits();
  });

  it("invalidates the old report key at once when rotated", async () => {
    resetLimits();
    const before = await botNamed("Boss");
    const r = await call("POST", `/api/tv/bots/${before.id}/rotate-key`, { cookie: admin, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.key).not.toBe(before.key);
    expect((await call("GET", `/api/tv/r/${before.key}/working`)).status).toBe(404);
    expect((await call("GET", `/api/tv/r/${r.json.key}/working`)).text).toBe("OK Boss working");
    expect((await botNamed("Boss")).key).toBe(r.json.key);
    expect((await call("POST", "/api/tv/bots/nope/rotate-key", { cookie: admin, body: {} })).status).toBe(404);
    resetLimits();
  });

  it("stops a deleted bot's link", async () => {
    resetLimits();
    const made = await call("POST", "/api/tv/bots", { cookie: admin, body: { name: "Temp" } });
    const key = (await botNamed("Temp")).key;
    expect((await call("GET", `/api/tv/r/${key}/working`)).status).toBe(200);
    await call("DELETE", `/api/tv/bots/${made.json.id}`, { cookie: admin });
    expect((await call("GET", `/api/tv/r/${key}/working`)).status).toBe(404);
    resetLimits();
  });
});

describe("Dashboard TV: staleness", () => {
  const MIN = 60_000;
  const at = (state: string, ageMin: number, label: string | null = "Planification") => {
    const updatedAt = new Date(Date.now() - ageMin * MIN);
    return tv.effectiveStatus({ state, label, since: new Date(updatedAt.getTime() - MIN), updatedAt });
  };

  it("shows working as idle after 30 minutes without a report", () => {
    expect(at("working", 29).state).toBe("working");
    const old = at("working", 31);
    expect([old.state, old.label]).toEqual(["idle", null]);
  });

  it("holds needs_human for 4 hours, then idle", () => {
    expect(at("needs_human", 60, "Besoin d'aide").state).toBe("needs_human");
    expect(at("needs_human", 239, "Besoin d'aide").state).toBe("needs_human");
    expect(at("needs_human", 241, "Besoin d'aide").state).toBe("idle");
  });

  it("applies to what the public screen shows", async () => {
    resetLimits();
    const bot = await botNamed("Facebook");
    const old = new Date(Date.now() - 45 * MIN);
    await db().update(schema.tvStatus).set({ state: "working", label: "Montage vidéo", since: old, updatedAt: old }).where(eq(schema.tvStatus.botId, bot.id));
    let f = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((b: any) => b.id === bot.id);
    expect([f.state, f.label]).toEqual(["idle", null]);
    await db().update(schema.tvStatus).set({ state: "needs_human", label: "Besoin d'aide" }).where(eq(schema.tvStatus.botId, bot.id));
    f = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((b: any) => b.id === bot.id);
    expect(f.state).toBe("needs_human");
  });

  it("never shows a label that is not approved, even if one reached the table", async () => {
    const bot = await botNamed("Vidéaste");
    await db().update(schema.tvStatus).set({ state: "working", label: "Secret client X", since: new Date(), updatedAt: new Date() }).where(eq(schema.tvStatus.botId, bot.id));
    const f = (await call("GET", "/api/tv/state", { cookie: admin })).json.bots.find((b: any) => b.id === bot.id);
    expect(f.label).toBe("Tâche en cours");
  });
});

describe("Dashboard TV: labels", () => {
  it("has the 45 labels and finds them ignoring case and accents", () => {
    expect(tv.LABELS).toHaveLength(45);
    expect(tv.resolveLabel("TRI DES COURRIELS", "working")).toBe("Tri des courriels");
    expect(tv.resolveLabel("edition d’une video", "working")).toBe("Édition d'une vidéo");
    expect(tv.resolveLabel("3", "working")).toBe(tv.LABELS[3]);
    expect(tv.resolveLabel("anything", "needs_human")).toBe("Besoin d'aide");
    expect(tv.resolveLabel("anything", "idle")).toBeNull();
    for (const l of Object.values(tv.LABELS_BY_BOT).flat()) expect(tv.LABELS).toContain(l);
  });
});

describe("Dashboard TV: logs", () => {
  it("hides the secret report link in anything that is logged", async () => {
    const { logPath } = await import("../server/lib/http.ts");
    expect(logPath("/api/tv/r/SECRETKEY/working/3")).toBe("/api/tv/r/***");
    expect(logPath("/api/tv/state")).toBe("/api/tv/state");
  });
});

describe("Dashboard TV: Christmas, Octet", () => {
  it("computes the Christmas day in Québec time: null outside 1-25 December", async () => {
    expect(tv.quebecChristmasDay(new Date("2026-11-30T12:00:00Z"))).toBeNull();
    expect(tv.quebecChristmasDay(new Date("2026-12-01T12:00:00Z"))).toBe(1);
    expect(tv.quebecChristmasDay(new Date("2026-12-01T03:00:00Z"))).toBeNull(); // still 30 November evening in Québec
    expect(tv.quebecChristmasDay(new Date("2026-12-25T20:00:00Z"))).toBe(25);
    expect(tv.quebecChristmasDay(new Date("2026-12-26T12:00:00Z"))).toBeNull();
    expect(await tv.christmasOf(new Date("2026-06-15T12:00:00Z"))).toBeNull();
    const c = await tv.christmasOf(new Date("2026-12-08T15:00:00Z"));
    expect(c).toMatchObject({ day: 8, shirt: true });
    expect((await tv.christmasOf(new Date("2026-12-07T15:00:00Z")))?.shirt).toBe(false);
  });

  it("the feeds carry christmas: null today (outside the window) and the preview works for staff only", async () => {
    resetLimits();
    const key = (await manage()).displayKey;
    const inWindow = tv.quebecChristmasDay() != null;
    const signed = await call("GET", "/api/tv/state", { cookie: tech });
    expect(signed.json).toHaveProperty("christmas");
    if (!inWindow) expect(signed.json.christmas).toBeNull();
    const preview = await call("GET", "/api/tv/state?xmas=12", { cookie: tech });
    expect(preview.json.christmas).toMatchObject({ day: 12, shirt: true });
    expect((await call("GET", "/api/tv/state?xmas=26", { cookie: tech })).json.christmas?.day ?? null).toBe(inWindow ? tv.quebecChristmasDay() : null);
    const display = await call("GET", `/api/tv/display/state?key=${encodeURIComponent(key)}&xmas=12`);
    expect(display.status).toBe(200);
    expect(display.json).toHaveProperty("christmas");
    if (!inWindow) expect(display.json.christmas).toBeNull(); // the public screen ignores the preview
  });

  it("aubaines: managers only, trimmed, capped at 80, shown for their day", async () => {
    expect((await call("GET", "/api/tv/aubaines", { cookie: tech })).status).toBe(403);
    expect((await call("PUT", "/api/tv/aubaines", { cookie: tech, body: { aubaines: { "1": "x" } } })).status).toBe(403);
    const long = "A".repeat(120);
    const put = await call("PUT", "/api/tv/aubaines", { cookie: admin, body: { aubaines: { "5": "   -20 % sur les portables   ", "6": long, "7": "   ", "30": "hors fenetre" } } });
    expect(put.status).toBe(200);
    expect(put.json.aubaines["5"]).toBe("-20 % sur les portables");
    expect(put.json.aubaines["6"]).toHaveLength(80);
    expect(put.json.aubaines["7"]).toBeUndefined();
    expect(put.json.aubaines["30"]).toBeUndefined();
    expect((await call("GET", "/api/tv/aubaines", { cookie: admin })).json.aubaines["5"]).toBe("-20 % sur les portables");
    expect((await call("GET", "/api/tv/state?xmas=5", { cookie: tech })).json.christmas).toEqual({ day: 5, shirt: false, aubaine: "-20 % sur les portables" });
    expect((await call("GET", "/api/tv/state?xmas=9", { cookie: tech })).json.christmas.aubaine).toBeNull();
    // the display key still works after the settings row was updated
    resetLimits();
    const k = (await manage()).displayKey;
    expect((await call("GET", `/api/tv/display/state?key=${encodeURIComponent(k)}`)).status).toBe(200);
  });
});
