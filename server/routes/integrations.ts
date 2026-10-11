import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import {
  AutotaskError,
  createClient,
  detectZone,
  listResources,
  loadSettings,
  saveSettings,
  type AutotaskConfig,
  type AutotaskErrorCode,
  type Settings,
} from "../lib/autotask.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";

const zCred = z.string().trim().min(1).max(300);

function view(s: Settings, updatedByName: string | null) {
  return {
    enabled: s.enabled,
    username: s.config.username ?? "",
    hasSecret: s.hasSecret,
    hasIntegrationCode: s.hasIntegrationCode,
    configured: Boolean(s.credentials && s.config.zone),
    zone: s.config.zone ?? null,
    lastTest: s.config.lastTest ?? null,
    updatedAt: s.updatedAt,
    updatedByName,
  };
}

async function current() {
  const s = await loadSettings();
  const [u] = s.updatedBy ? await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, s.updatedBy)) : [];
  return view(s, u?.name ?? null);
}

const codeOf = (e: unknown): AutotaskErrorCode => (e instanceof AutotaskError ? e.code : "api");

async function staffWithLinks() {
  return db()
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, active: schema.users.active, resourceId: schema.users.autotaskResourceId })
    .from(schema.users)
    .where(eq(schema.users.kind, "staff"))
    .orderBy(asc(schema.users.name));
}

/** Admin › Integrations › Autotask (admin.integrations). */
export const integrationRoutes = new Hono<AppEnv>()
  .use(requirePermission("admin.integrations"))

  .get("/autotask", async (c) => c.json(await current()))

  .put("/autotask", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean().optional(),
        username: zEmail.optional(),
        secret: zCred.optional(),
        integrationCode: zCred.optional(),
      }),
    );
    const s = await loadSettings();
    const config: AutotaskConfig = { ...s.config };
    if (p.username !== undefined && p.username !== s.config.username) {
      try {
        config.zone = await detectZone(p.username);
      } catch (e) {
        throw new HTTPException(400, { message: codeOf(e) === "network" ? "autotask_network" : "autotask_zone" });
      }
      config.username = p.username;
      delete config.lastTest;
    }
    if (p.secret !== undefined || p.integrationCode !== undefined) delete config.lastTest;
    const complete = Boolean(config.username && config.zone && (p.secret ?? s.hasSecret) && (p.integrationCode ?? s.hasIntegrationCode));
    if (p.enabled && !complete) throw new HTTPException(400, { message: "autotask_incomplete" });

    await saveSettings(a.user.id, { enabled: p.enabled, config, secret: p.secret, integrationCode: p.integrationCode });
    // Never log the secret or the integration code, only that they changed
    await audit(a.user.id, "integration.autotask.updated", null, {
      enabled: p.enabled,
      username: p.username,
      secretChanged: p.secret !== undefined || undefined,
      integrationCodeChanged: p.integrationCode !== undefined || undefined,
    });
    return c.json(await current());
  })

  /**
   * Test the connection. Values typed in the form (not saved yet) are used
   * when given, otherwise the saved ones.
   */
  .post("/autotask/test", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ username: zEmail.optional(), secret: zCred.optional(), integrationCode: zCred.optional() }));
    const s = await loadSettings();
    const draft = p.username !== undefined || p.secret !== undefined || p.integrationCode !== undefined;
    const username = p.username ?? s.config.username;
    const secret = p.secret ?? s.credentials?.secret;
    const integrationCode = p.integrationCode ?? s.credentials?.integrationCode;
    if (!username || !secret || !integrationCode) return c.json({ ok: false, error: "not_configured" });

    let result: { ok: true; zone: { name: string; webUrl: string | null }; usage: { used: number; limit: number } } | { ok: false; error: AutotaskErrorCode };
    try {
      const zone = username === s.config.username && s.config.zone ? s.config.zone : await detectZone(username);
      const client = createClient({ username, secret, integrationCode }, zone);
      const th = await client.call<{ externalRequestThreshold?: number; currentTimeframeRequestCount?: number }>("GET", "ThresholdInformation");
      result = {
        ok: true,
        zone: { name: zone.name, webUrl: zone.webUrl },
        usage: { used: th.currentTimeframeRequestCount ?? 0, limit: th.externalRequestThreshold ?? 0 },
      };
    } catch (e) {
      result = { ok: false, error: codeOf(e) };
    }
    if (!draft) {
      const lastTest = { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: result.error }) };
      await saveSettings(a.user.id, { config: { ...s.config, lastTest } });
    }
    return c.json(result);
  })

  /** Technicians and the Autotask users they are linked to. */
  .get("/autotask/links", async (c) => {
    const staff = await staffWithLinks();
    let resources: Awaited<ReturnType<typeof listResources>> = [];
    let error: AutotaskErrorCode | null = null;
    try {
      resources = await listResources(c.req.query("refresh") === "1");
    } catch (e) {
      error = codeOf(e);
    }
    const linked = new Set(staff.map((s) => s.resourceId).filter((x): x is number => x !== null));
    return c.json({
      error,
      resources,
      staff: staff.map((s) => {
        const match = s.resourceId === null ? resources.find((r) => r.email === s.email.toLowerCase() && !linked.has(r.id)) : undefined;
        return { ...s, suggestedResourceId: match?.id ?? null };
      }),
    });
  })

  .put("/autotask/links/:userId", async (c) => {
    const a = auth(c);
    const userId = zUuid.parse(c.req.param("userId"));
    const p = await body(c, z.object({ resourceId: z.number().int().positive().nullable() }));
    const [u] = await db().select().from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.kind, "staff")));
    if (!u) throw new HTTPException(404, { message: "not_found" });
    if (p.resourceId !== null) {
      let resources;
      try {
        resources = await listResources();
      } catch (e) {
        throw new HTTPException(400, { message: `autotask_${codeOf(e)}` });
      }
      if (!resources.some((r) => r.id === p.resourceId)) throw new HTTPException(400, { message: "autotask_unknown_resource" });
      const [taken] = await db().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.autotaskResourceId, p.resourceId));
      if (taken && taken.id !== userId) throw new HTTPException(409, { message: "autotask_resource_taken" });
    }
    await db().update(schema.users).set({ autotaskResourceId: p.resourceId, updatedAt: new Date() }).where(eq(schema.users.id, userId));
    await audit(a.user.id, "integration.autotask.link", userId, { resourceId: p.resourceId });
    return c.json({ ok: true });
  })

  /** Link every unlinked technician whose email matches an Autotask user. */
  .post("/autotask/links/auto", async (c) => {
    const a = auth(c);
    let resources;
    try {
      resources = await listResources(true);
    } catch (e) {
      throw new HTTPException(400, { message: `autotask_${codeOf(e)}` });
    }
    const staff = await staffWithLinks();
    const used = new Set(staff.map((s) => s.resourceId).filter((x): x is number => x !== null));
    let linked = 0;
    for (const s of staff.filter((x) => x.resourceId === null)) {
      const r = resources.find((x) => x.email === s.email.toLowerCase() && !used.has(x.id));
      if (!r) continue;
      const done = await db()
        .update(schema.users)
        .set({ autotaskResourceId: r.id, updatedAt: new Date() })
        .where(and(eq(schema.users.id, s.id), isNull(schema.users.autotaskResourceId)))
        .returning({ id: schema.users.id });
      if (done.length) {
        used.add(r.id);
        linked++;
      }
    }
    await audit(a.user.id, "integration.autotask.autolink", null, { linked });
    return c.json({ linked });
  });
