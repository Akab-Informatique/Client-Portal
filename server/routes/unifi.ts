import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { saveUnifiSettings, testUnifi, UnifiError, unifiOverview, unifiReady, unifiSettings, type UnifiSettings } from "../lib/unifi.ts";

const adminView = (s: UnifiSettings) => ({ enabled: s.enabled, hasKey: Boolean(s.apiKey), ready: unifiReady(s), lastTest: s.lastTest ?? null });

/** Admin › Intégrations › UniFi (admin.integrations): the API key is sealed and never sent back */
export const unifiAdminRoutes = new Hono<AppEnv>()
  .use("*", requirePermission("admin.integrations"))
  .get("/", async (c) => c.json(adminView(await unifiSettings())))
  .put("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ enabled: z.boolean(), /** only sent when it changes */ apiKey: z.string().trim().min(8).max(300).optional() }));
    const now = await unifiSettings();
    const key = p.apiKey ?? now.apiKey;
    if (p.enabled && !key) throw new HTTPException(400, { message: "unifi_incomplete" });
    await saveUnifiSettings(a.user.id, { enabled: p.enabled, apiKey: key });
    await audit(a.user.id, "integration.unifi.updated", null, { enabled: p.enabled, keyChanged: Boolean(p.apiKey) });
    return c.json(adminView(await unifiSettings()));
  })
  .post("/test", async (c) => {
    const a = auth(c);
    if (!rateLimit(`unifi-test:${a.user.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await unifiSettings();
    if (!s.apiKey) throw new HTTPException(409, { message: "unifi_incomplete" });
    const r = await testUnifi(a.user.id);
    await audit(a.user.id, "integration.unifi.tested", null, { ok: r.ok, hosts: r.hosts ?? null });
    return c.json(r);
  });

/** The console page (unifi.view) */
export const unifiRoutes = new Hono<AppEnv>()
  .use("*", requirePermission("unifi.view"))
  .get("/status", async (c) => {
    const s = await unifiSettings();
    return c.json({ configured: Boolean(s.apiKey), enabled: s.enabled, ready: unifiReady(s), lastTest: s.lastTest ?? null });
  })
  .get("/overview", async (c) => {
    const a = auth(c);
    if (!rateLimit(`unifi-ov:${a.user.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    try {
      return c.json(await unifiOverview());
    } catch (e) {
      if (e instanceof UnifiError) {
        if (e.code === "unifi_not_configured") throw new HTTPException(409, { message: e.code });
        throw new HTTPException(e.code === "unifi_rate_limited" ? 429 : e.code === "unifi_unauthorized" ? 401 : 502, { message: e.code });
      }
      throw e;
    }
  });
