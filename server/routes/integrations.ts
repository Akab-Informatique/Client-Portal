import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import {
  AutotaskError,
  autotaskUsage,
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
import { clearTicketCache } from "../lib/ticketSource.ts";
import { RMM_PLACEHOLDERS, rmmSettings, saveRmmSettings, validTemplate } from "../lib/rmm.ts";
import { O365Error, o365Settings, saveO365Settings, testO365 } from "../lib/o365.ts";
import { normalizePhone, saveSmsSettings, sendSms, SmsError, smsSettings, testVoipms, type SmsSettings } from "../lib/voipms.ts";
import { config } from "../config.ts";
import { AI_MODELS, AiError, aiSettings, askClaude, saveAiSettings, type AiErrorCode } from "../lib/ai.ts";

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
    fallbackToApiUser: Boolean(s.config.fallbackToApiUser),
    /** API calls made by the portal in the last hour (Autotask allows 10,000 per hour) */
    usage: autotaskUsage(),
    updatedAt: s.updatedAt,
    updatedByName,
  };
}

async function current() {
  const s = await loadSettings();
  const [u] = s.updatedBy ? await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, s.updatedBy)) : [];
  return view(s, u?.name ?? null);
}

/** Microsoft 365 settings as shown to the admin (never the secret). */
const o365View = (s: Awaited<ReturnType<typeof o365Settings>>) => ({ enabled: s.enabled, tenantId: s.tenantId, clientId: s.clientId, hasSecret: Boolean(s.secret), lastTest: s.lastTest ?? null });

/** VoIP.ms settings as shown to the admin: never the API password; the callback address to paste in VoIP.ms. */
function voipmsView(s: SmsSettings) {
  const { password, token, ...rest } = s;
  const base = config.publicUrl || "";
  return {
    ...rest,
    hasPassword: Boolean(password),
    callbackUrl: token ? `${base}/api/sms/hook/voipms?token=${token}&from={FROM}&message={MESSAGE}&id={ID}` : null,
    publicUrlSet: Boolean(config.publicUrl),
  };
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
        fallbackToApiUser: z.boolean().optional(),
      }),
    );
    const s = await loadSettings();
    const config: AutotaskConfig = { ...s.config };
    if (p.fallbackToApiUser !== undefined) config.fallbackToApiUser = p.fallbackToApiUser;
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
    // Another Autotask account: its tickets are not ours, start the local copy again
    if (p.username !== undefined && p.username !== s.config.username) await clearTicketCache();
    // Never log the secret or the integration code, only that they changed
    await audit(a.user.id, "integration.autotask.updated", null, {
      enabled: p.enabled,
      username: p.username,
      secretChanged: p.secret !== undefined || undefined,
      integrationCodeChanged: p.integrationCode !== undefined || undefined,
      fallbackToApiUser: p.fallbackToApiUser,
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
  })

  // ── Microsoft 365 calendars (Azure app registration, Calendars.ReadWrite) ──
  .get("/o365", async (c) => c.json(o365View(await o365Settings())))
  .put("/o365", async (c) => {
    const a = auth(c);
    const zId = z.string().trim().regex(/^[0-9a-z][0-9a-z.-]{1,100}$/i);
    const p = await body(c, z.object({ enabled: z.boolean().optional(), tenantId: zId.optional(), clientId: zId.optional(), secret: zCred.optional() }));
    const s = await o365Settings();
    const complete = (p.tenantId ?? s.tenantId) && (p.clientId ?? s.clientId) && (p.secret ?? s.secret);
    if (p.enabled && !complete) throw new HTTPException(400, { message: "o365_incomplete" });
    await saveO365Settings(a.user.id, p);
    await audit(a.user.id, "integration.o365.updated", null, { enabled: p.enabled, tenantId: p.tenantId, clientId: p.clientId, secretChanged: p.secret !== undefined || undefined });
    return c.json(o365View(await o365Settings()));
  })
  /** Test: read a mailbox calendar (the admin's by default) with the typed or saved values. */
  .post("/o365/test", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ email: zEmail.optional(), tenantId: z.string().trim().max(100).optional(), clientId: z.string().trim().max(100).optional(), secret: zCred.optional() }));
    const s = await o365Settings();
    const settings = { tenantId: p.tenantId || s.tenantId, clientId: p.clientId || s.clientId, secret: p.secret ?? s.secret };
    let result: { ok: true } | { ok: false; error: string; detail?: string };
    try {
      await testO365(p.email ?? a.user.email, settings);
      result = { ok: true };
    } catch (e) {
      result = { ok: false, error: e instanceof O365Error ? e.code : "api", detail: e instanceof O365Error ? e.detail : undefined };
    }
    if (!p.secret && !p.tenantId && !p.clientId) await saveO365Settings(a.user.id, { lastTest: { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: result.error }) } });
    return c.json(result);
  })

  // ── VoIP.ms text messages ──
  .get("/voipms", async (c) => c.json(voipmsView(await smsSettings())))
  .put("/voipms", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean().optional(),
        username: zEmail.optional(),
        password: zCred.optional(),
        did: z.string().max(30).optional(),
        autoTicketMinutes: z.number().int().min(1).max(24 * 60).optional(),
        autoReply: z.string().trim().min(1).max(600).optional(),
        ticketOpened: z.string().trim().min(1).max(600).optional(),
        ticketTimeout: z.string().trim().min(1).max(600).optional(),
        defaultCompanyId: z.number().int().positive().nullable().optional(),
        defaultCompanyName: z.string().trim().max(200).nullable().optional(),
        queue: z.string().max(40).nullable().optional(),
        priority: z.string().max(40).nullable().optional(),
        newToken: z.boolean().optional(),
      }),
    );
    if (p.did !== undefined && p.did !== "" && !normalizePhone(p.did)) throw new HTTPException(400, { message: "sms_invalid_did" });
    const s = await smsSettings();
    const next = { ...s, ...p, did: p.did !== undefined ? (normalizePhone(p.did) ?? "") : s.did };
    if (p.enabled && !(next.username && (p.password ?? s.password) && next.did)) throw new HTTPException(400, { message: "sms_incomplete" });
    // new account details: the last test no longer says anything about them
    const changed = (p.username !== undefined && p.username !== s.username) || (p.password !== undefined && p.password !== s.password) || next.did !== s.did;
    await saveSmsSettings(a.user.id, { ...p, did: next.did, ...(changed ? { lastTest: null } : {}) } as Partial<SmsSettings> & { newToken?: boolean });
    await audit(a.user.id, "integration.voipms.updated", null, { enabled: p.enabled, username: p.username, did: next.did, passwordChanged: p.password !== undefined || undefined, newToken: p.newToken });
    return c.json(voipmsView(await smsSettings()));
  })
  /** Test the account (and optionally send a text to a number). */
  .post("/voipms/test", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ username: zEmail.optional(), password: zCred.optional(), sendTo: z.string().max(30).optional() }));
    const s = await smsSettings();
    let result: { ok: true } | { ok: false; error: string; detail?: string };
    try {
      await testVoipms({ username: p.username ?? s.username, password: p.password ?? s.password });
      if (p.sendTo) {
        if (!normalizePhone(p.sendTo)) throw new HTTPException(400, { message: "invalid_phone" });
        await sendSms(p.sendTo, "Test du portail AKAB : les textos fonctionnent.");
      }
      result = { ok: true };
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      result = { ok: false, error: e instanceof SmsError ? e.code : "api", detail: e instanceof SmsError ? e.detail : undefined };
    }
    // kept when it tested the saved account (typed values equal to the saved ones included)
    const savedAccount = (p.username ?? s.username) === s.username && (p.password ?? s.password) === s.password;
    if (savedAccount) await saveSmsSettings(a.user.id, { lastTest: { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: result.error }) } });
    return c.json(result);
  })

  // ── RMM (links to the device page and web remote control) ──
  .get("/rmm", async (c) => c.json({ ...(await rmmSettings()), placeholders: RMM_PLACEHOLDERS }))
  .put("/rmm", async (c) => {
    const a = auth(c);
    const zTemplate = z
      .string()
      .trim()
      .max(500)
      .refine(validTemplate, { message: "rmm_template" });
    const p = await body(c, z.object({ enabled: z.boolean(), name: z.string().trim().max(60), deviceUrl: zTemplate, remoteUrl: zTemplate }));
    if (p.enabled && !p.deviceUrl && !p.remoteUrl) throw new HTTPException(400, { message: "rmm_incomplete" });
    await saveRmmSettings(a.user.id, p);
    await audit(a.user.id, "integration.rmm.updated", null, { enabled: p.enabled, name: p.name });
    return c.json({ ...(await rmmSettings()), placeholders: RMM_PLACEHOLDERS });
  })

  // ── AI assistant (Anthropic Claude) ──
  .get("/ai", async (c) => {
    const s = await aiSettings();
    return c.json({ enabled: s.enabled, model: s.model, models: AI_MODELS, hasKey: Boolean(s.apiKey), lastTest: s.lastTest ?? null });
  })
  .put("/ai", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ enabled: z.boolean().optional(), model: z.enum(AI_MODELS).optional(), apiKey: zCred.optional() }));
    const s = await aiSettings();
    if (p.enabled && !(p.apiKey ?? s.apiKey)) throw new HTTPException(400, { message: "ai_incomplete" });
    await saveAiSettings(a.user.id, p);
    await audit(a.user.id, "integration.ai.updated", null, { enabled: p.enabled, model: p.model, keyChanged: p.apiKey !== undefined || undefined });
    const n = await aiSettings();
    return c.json({ enabled: n.enabled, model: n.model, models: AI_MODELS, hasKey: Boolean(n.apiKey), lastTest: n.lastTest ?? null });
  })
  .post("/ai/test", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ apiKey: zCred.optional(), model: z.enum(AI_MODELS).optional() }));
    const s = await aiSettings();
    const apiKey = p.apiKey ?? s.apiKey;
    if (!apiKey) return c.json({ ok: false, error: "not_configured" });
    let result: { ok: true } | { ok: false; error: string };
    try {
      await askClaude({ system: "Test de connexion.", prompt: "Réponds OK.", maxTokens: 5 }, { apiKey, model: p.model ?? s.model });
      result = { ok: true };
    } catch (e) {
      result = { ok: false, error: e instanceof AiError ? e.code : "api" };
    }
    if (!p.apiKey) await saveAiSettings(a.user.id, { lastTest: { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: (result as { error: AiErrorCode }).error }) } });
    return c.json(result);
  });
