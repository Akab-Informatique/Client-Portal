import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, isNull, gte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, permissionsOf, requirePermission, type AppEnv } from "../lib/auth.ts";
import { exportFile, FinalSyncError, finalSyncState, startFinalSync } from "../lib/finalSync.ts";
import { autotaskLinked } from "../lib/ticketSource.ts";
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
import { microsoftRedirectUri } from "./microsoft.ts";
import { AI_FEATURE_KEYS, DEFAULT_FEATURE_MODELS, AI_MODELS, AI_PRICES, AiError, aiSettings, askClaude, saveAiSettings, startOfToday, type AiErrorCode, type AiSettings } from "../lib/ai.ts";

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
/** The Claude settings for the admin page (never the key). */
const aiView = (s: AiSettings) => ({
  enabled: s.enabled,
  model: s.model,
  models: AI_MODELS,
  hasKey: Boolean(s.apiKey),
  lastTest: s.lastTest ?? null,
  /** Per part: its own model, or null (the general one) */
  features: AI_FEATURE_KEYS.map((k) => ({ key: k, model: s.featureModels[k] ?? null, default: DEFAULT_FEATURE_MODELS[k] ?? null })),
  allowChoice: s.allowChoice,
  dailyLimitUsd: s.dailyLimitUsd,
  prices: AI_PRICES,
});
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
  // ── The last sync, before the connection is closed ──
  .get("/autotask/final-sync", async (c) => c.json({ linked: await autotaskLinked(), state: await finalSyncState() }))

  /** Tickets, expense reports (with their status) since a date, and the time sheets as CSV files */
  .post("/autotask/final-sync", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-09-01"),
        parts: z.array(z.enum(["tickets", "expenses", "timesheets"])).min(1).optional(),
      }),
    );
    if (p.since < "2000-01-01" || p.since > "2100-01-01") throw new HTTPException(400, { message: "invalid_range" });
    try {
      await startFinalSync(p, a.user.id);
    } catch (e) {
      if (e instanceof FinalSyncError) throw new HTTPException(e.code === "running" ? 409 : 400, { message: e.code === "running" ? "final_sync_running" : "invalid_range" });
      throw e;
    }
    return c.json({ ok: true }, 202);
  })

  /** A file kept by the final sync (always a download) */
  .get("/autotask/final-sync/files/:id", async (c) => {
    const file = await exportFile(zUuid.parse(c.req.param("id")));
    if (!file) throw new HTTPException(404, { message: "not_found" });
    // the UTF-8 mark makes Excel read the accents
    return new Response(`${String.fromCharCode(0xfeff)}${file.content}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename.replace(/[^\w.-]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  })

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
  // with the address to register in Entra for the technicians' own sign-in
  .get("/o365", async (c) => {
    const origin = `${c.req.header("x-forwarded-proto") ?? "http"}://${c.req.header("x-forwarded-host") ?? c.req.header("host") ?? ""}`;
    return c.json({ ...o365View(await o365Settings()), redirectUri: microsoftRedirectUri(origin) });
  })
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
    // kept when it tested the saved values (typed values equal to them included)
    const saved = settings.tenantId === s.tenantId && settings.clientId === s.clientId && settings.secret === s.secret;
    if (saved) await saveO365Settings(a.user.id, { lastTest: { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: result.error }) } });
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
        autoReplyCooldownHours: z.number().int().min(0).max(24 * 30).optional(),
        longAsMms: z.boolean().optional(),
        autoReply: z.string().trim().min(1).max(600).optional(),
        ticketOpened: z.string().trim().min(1).max(600).optional(),
        askDetails: z.string().trim().min(1).max(600).optional(),
        detailsMinutes: z.number().int().min(1).max(24 * 60).optional(),
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
  .get("/ai", async (c) => c.json(aiView(await aiSettings())))
  .put("/ai", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean().optional(),
        model: z.enum(AI_MODELS).optional(),
        apiKey: zCred.optional(),
        featureModels: z.partialRecord(z.enum(AI_FEATURE_KEYS), z.enum(AI_MODELS)).optional(),
        allowChoice: z.boolean().optional(),
        dailyLimitUsd: z.number().min(0).max(1000).nullable().optional(),
      }),
    );
    const s = await aiSettings();
    if (p.enabled && !(p.apiKey ?? s.apiKey)) throw new HTTPException(400, { message: "ai_incomplete" });
    await saveAiSettings(a.user.id, p as Partial<AiSettings> & { apiKey?: string });
    await audit(a.user.id, "integration.ai.updated", null, {
      enabled: p.enabled,
      model: p.model,
      keyChanged: p.apiKey !== undefined || undefined,
      featureModels: p.featureModels,
      allowChoice: p.allowChoice,
      dailyLimitUsd: p.dailyLimitUsd,
    });
    return c.json(aiView(await aiSettings()));
  })
  /** One person's daily limit (null: the general one). */
  .put("/ai/limits/:userId", async (c) => {
    const a = auth(c);
    const userId = zUuid.parse(c.req.param("userId"));
    const p = await body(c, z.object({ limitUsd: z.number().min(0).max(1000).nullable() }));
    const s = await aiSettings();
    const userLimits = { ...s.userLimits };
    if (p.limitUsd === null) delete userLimits[userId];
    else userLimits[userId] = p.limitUsd;
    await saveAiSettings(a.user.id, { userLimits });
    await audit(a.user.id, "integration.ai.user_limit", userId, { limitUsd: p.limitUsd });
    return c.json({ ok: true });
  })

  /** Usage summary: today and the last days, per day, person, part of the portal and model. */
  .get("/ai/usage", async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 30));
    const since = new Date(startOfToday().getTime() - (days - 1) * 86_400_000);
    const today = startOfToday();
    const s = await aiSettings();
    const rows = await db()
      .select({ userId: schema.aiUsage.userId, feature: schema.aiUsage.feature, model: schema.aiUsage.model, input: schema.aiUsage.inputTokens, output: schema.aiUsage.outputTokens, micros: schema.aiUsage.costMicros, at: schema.aiUsage.createdAt })
      .from(schema.aiUsage)
      .where(gte(schema.aiUsage.createdAt, since));
    const staff = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.kind, "staff"));
    const name = (id: string | null) => (id ? (staff.find((u) => u.id === id)?.name ?? "—") : null);
    const dayOf = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Toronto" }).format(d);
    const add = <K extends string>(m: Map<K, { requests: number; micros: number; input: number; output: number }>, k: K, r: (typeof rows)[number]) => {
      const v = m.get(k) ?? { requests: 0, micros: 0, input: 0, output: 0 };
      v.requests++;
      v.micros += r.micros;
      v.input += r.input;
      v.output += r.output;
      m.set(k, v);
    };
    const byDay = new Map<string, { requests: number; micros: number; input: number; output: number }>();
    const byUser = new Map<string, { requests: number; micros: number; input: number; output: number }>();
    const byUserToday = new Map<string, { requests: number; micros: number; input: number; output: number }>();
    const byFeature = new Map<string, { requests: number; micros: number; input: number; output: number }>();
    const byModel = new Map<string, { requests: number; micros: number; input: number; output: number }>();
    const total = new Map<"all" | "today", { requests: number; micros: number; input: number; output: number }>();
    for (const r of rows) {
      add(byDay, dayOf(r.at), r);
      add(byUser, r.userId ?? "", r);
      add(byFeature, r.feature, r);
      add(byModel, r.model, r);
      add(total, "all", r);
      if (r.at >= today) {
        add(total, "today", r);
        add(byUserToday, r.userId ?? "", r);
      }
    }
    const usd = (v?: { micros: number }) => (v?.micros ?? 0) / 1_000_000;
    const list = (days2: number) =>
      Array.from({ length: days2 }, (_, i) => {
        const d = dayOf(new Date(today.getTime() - (days2 - 1 - i) * 86_400_000 + 43_200_000));
        const v = byDay.get(d);
        return { day: d, costUsd: usd(v), requests: v?.requests ?? 0 };
      });
    // every technician with the AI right shows, with their limit, even without use
    const people = await db().select().from(schema.users).where(eq(schema.users.kind, "staff"));
    const withAi: { id: string; name: string }[] = [];
    for (const u of people) if (u.active && (await permissionsOf(u)).includes("tickets.ai")) withAi.push({ id: u.id, name: u.name });
    const ids = new Set([...withAi.map((u) => u.id), ...[...byUser.keys()].filter(Boolean)]);
    return c.json({
      days,
      prices: AI_PRICES,
      dailyLimitUsd: s.dailyLimitUsd,
      total: { costUsd: usd(total.get("all")), requests: total.get("all")?.requests ?? 0, inputTokens: total.get("all")?.input ?? 0, outputTokens: total.get("all")?.output ?? 0 },
      today: { costUsd: usd(total.get("today")), requests: total.get("today")?.requests ?? 0 },
      byDay: list(days),
      byUser: [...ids]
        .map((id) => ({
          userId: id,
          name: name(id) ?? withAi.find((u) => u.id === id)?.name ?? "—",
          todayUsd: usd(byUserToday.get(id)),
          periodUsd: usd(byUser.get(id)),
          requests: byUser.get(id)?.requests ?? 0,
          limitUsd: id in s.userLimits ? s.userLimits[id] : null,
        }))
        .sort((x, y) => y.periodUsd - x.periodUsd || x.name.localeCompare(y.name)),
      admin: { costUsd: usd(byUser.get("")), requests: byUser.get("")?.requests ?? 0 },
      byFeature: [...byFeature].map(([feature, v]) => ({ feature, costUsd: usd(v), requests: v.requests })).sort((x, y) => y.costUsd - x.costUsd),
      byModel: [...byModel].map(([model, v]) => ({ model, costUsd: usd(v), requests: v.requests, inputTokens: v.input, outputTokens: v.output })).sort((x, y) => y.costUsd - x.costUsd),
    });
  })

  .post("/ai/test", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ apiKey: zCred.optional(), model: z.enum(AI_MODELS).optional() }));
    const s = await aiSettings();
    const apiKey = p.apiKey ?? s.apiKey;
    if (!apiKey) return c.json({ ok: false, error: "not_configured" });
    let result: { ok: true } | { ok: false; error: string; detail?: string };
    try {
      await askClaude({ system: "Test de connexion.", prompt: "Réponds OK.", maxTokens: 200 }, { apiKey, model: p.model ?? s.model });
      result = { ok: true };
    } catch (e) {
      result = { ok: false, error: e instanceof AiError ? e.code : "api", detail: e instanceof AiError ? e.detail : undefined };
    }
    if (!p.apiKey) await saveAiSettings(a.user.id, { lastTest: { ok: result.ok, at: new Date().toISOString(), ...(result.ok ? {} : { error: (result as { error: AiErrorCode }).error }) } });
    return c.json(result);
  });
