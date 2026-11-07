import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { acceptProposals, clientSiteCount, DattoError, dattoReady, dattoSettings, devicesOfClient, forgetDattoToken, saveDattoSettings, setSiteClient, sitePlan, syncDatto, testDatto, validApiUrl, type DattoSettings } from "../lib/dattoRmm.ts";

/**
 * Admin › Intégrations › RMM › Datto RMM (admin.integrations): the API address and keys (the secret key is sealed and
 * never sent back), a test, the sync, and the matching of Datto's sites to clients. The devices of a client are read
 * by staff with crm.view (`/api/rmm/clients/:id/devices`).
 */
const view = (s: DattoSettings) => ({
  enabled: s.enabled,
  apiUrl: s.apiUrl,
  apiKey: s.apiKey,
  hasSecret: Boolean(s.apiSecret),
  autoSync: s.autoSync,
  ready: dattoReady(s),
  lastTest: s.lastTest ?? null,
  lastSync: s.lastSync ?? null,
});

const run = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DattoError) throw new HTTPException(e.code === "rmm_rate_limited" ? 429 : e.code === "rmm_unauthorized" ? 401 : e.code === "not_found" || e.code === "client_not_found" ? 404 : e.code === "rmm_incomplete" ? 409 : 502, { message: e.code });
    throw e;
  }
};

export const dattoAdminRoutes = new Hono<AppEnv>()
  .use("*", requirePermission("admin.integrations"))
  .get("/", async (c) => c.json(view(await dattoSettings())))
  .put("/", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        enabled: z.boolean(),
        apiUrl: z.string().trim().max(200).refine(validApiUrl, { message: "rmm_bad_url" }),
        apiKey: z.string().trim().min(1).max(200),
        /** only sent when it changes: the saved one is never shown */
        apiSecret: z.string().trim().min(1).max(300).optional(),
        autoSync: z.boolean().default(true),
      }),
    );
    const now = await dattoSettings();
    const secret = p.apiSecret ?? now.apiSecret;
    if (p.enabled && !secret) throw new HTTPException(400, { message: "rmm_incomplete" });
    forgetDattoToken();
    await saveDattoSettings(a.user.id, { enabled: p.enabled, apiUrl: p.apiUrl.replace(/\/+$/, "").toLowerCase(), apiKey: p.apiKey, apiSecret: secret, autoSync: p.autoSync });
    await audit(a.user.id, "integration.rmm_datto.updated", null, { enabled: p.enabled, apiUrl: p.apiUrl });
    return c.json(view(await dattoSettings()));
  })
  .post("/test", async (c) => {
    const a = auth(c);
    if (!rateLimit(`rmm-test:${a.user.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await dattoSettings();
    if (!s.apiUrl || !s.apiKey || !s.apiSecret) throw new HTTPException(409, { message: "rmm_incomplete" });
    const r = await testDatto(a.user.id);
    return c.json(r);
  })
  .post("/sync", async (c) => {
    const a = auth(c);
    if (!rateLimit(`rmm-sync:${a.user.id}`, 6, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await dattoSettings();
    if (!s.apiUrl || !s.apiKey || !s.apiSecret) throw new HTTPException(409, { message: "rmm_incomplete" });
    const r = await syncDatto(a.user.id);
    await audit(a.user.id, "integration.rmm_datto.synced", null, { ok: r.ok, ...(r.counts ?? {}) });
    return c.json(r);
  })
  .get("/sites", async (c) => c.json(await sitePlan()))
  .put("/sites/:uid/client", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ clientId: zUuid.nullable() }));
    await run(() => setSiteClient(c.req.param("uid"), p.clientId));
    await audit(a.user.id, "integration.rmm_datto.site_matched", c.req.param("uid"), { clientId: p.clientId });
    return c.json({ ok: true });
  })
  .post("/sites/accept", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ uids: z.array(z.string().max(100)).max(2000).optional() }));
    const n = await acceptProposals(p.uids);
    await audit(a.user.id, "integration.rmm_datto.sites_accepted", null, { count: n });
    return c.json({ accepted: n });
  });

export const rmmDeviceRoutes = new Hono<AppEnv>().get("/clients/:id/devices", requirePermission("crm.view"), async (c) => {
  const id = zUuid.safeParse(c.req.param("id"));
  if (!id.success) throw new HTTPException(404, { message: "not_found" });
  const s = await dattoSettings();
  const sites = await clientSiteCount(id.data);
  const devices = sites ? await devicesOfClient(id.data) : [];
  return c.json({ connected: dattoReady(s), sites, syncedAt: s.lastSync?.ok ? s.lastSync.at : null, devices });
});
