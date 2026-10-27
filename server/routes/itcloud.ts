import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import {
  applyClientLinks,
  applyServicePlan,
  zeroServiceMoney,
  clientPlan,
  ensureVendor,
  itcloudReady,
  itcloudSettings,
  ItcloudError,
  saveItcloudSettings,
  setCustomerContract,
  setServiceContract,
  serviceStates,
  servicePlan,
  syncItcloud,
  testItcloud,
  validIntegrationKey,
  validPrivateKey,
  VENDOR_NAME,
  type ItcloudSettings,
} from "../lib/itcloud.ts";

/**
 * Admin › Intégrations › ITCloud (admin.integrations): the partner API keys (the private key is sealed and never
 * sent back), a test, the ITCloud customers to match to clients, the ITCloud products to turn into services
 * (reviewed, then applied), and the sync of each matched customer's services onto its contract.
 */
const view = async (s: ItcloudSettings) => ({
  enabled: s.enabled,
  integrationKey: s.integrationKey,
  hasKey: Boolean(s.privateKey),
  autoSync: s.autoSync,
  vendorName: VENDOR_NAME,
  vendorId: s.vendorId,
  lastTest: s.lastTest ?? null,
  lastSync: s.lastSync ?? null,
});

/** The API's own failures, for the screen (never a stack) */
const run = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ItcloudError) throw new HTTPException(e.code === "itcloud_rate_limited" ? 429 : e.code === "itcloud_unauthorized" ? 401 : 502, { message: e.code });
    throw e;
  }
};
const ready = async () => {
  const s = await itcloudSettings();
  if (!s.integrationKey || !s.privateKey) throw new HTTPException(409, { message: "itcloud_incomplete" });
  return s;
};

export const itcloudRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.integrations"))

  .get("/", async (c) => c.json(await view(await itcloudSettings())))

  .put("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ enabled: z.boolean().optional(), integrationKey: z.string().trim().max(60).optional(), privateKey: z.string().trim().max(10_000).optional(), autoSync: z.boolean().optional() }));
    if (p.integrationKey !== undefined && p.integrationKey !== "" && !validIntegrationKey(p.integrationKey)) throw new HTTPException(400, { message: "itcloud_bad_key" });
    if (p.privateKey !== undefined && p.privateKey !== "" && !validPrivateKey(p.privateKey)) throw new HTTPException(400, { message: "itcloud_bad_private_key" });
    const cur = await itcloudSettings();
    const next = { integrationKey: p.integrationKey !== undefined ? p.integrationKey || null : cur.integrationKey, privateKey: p.privateKey !== undefined ? p.privateKey || null : cur.privateKey };
    if (p.enabled && !(next.integrationKey && next.privateKey)) throw new HTTPException(400, { message: "itcloud_incomplete" });
    await saveItcloudSettings(a.user.id, {
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      ...(p.autoSync !== undefined ? { autoSync: p.autoSync } : {}),
      integrationKey: next.integrationKey,
      privateKey: next.privateKey,
    });
    // switching it on makes the vendor
    if (p.enabled) await ensureVendor();
    await audit(a.user.id, "integration.itcloud.updated", null, { enabled: p.enabled, autoSync: p.autoSync, keyChanged: p.integrationKey !== undefined || undefined, privateKeyChanged: p.privateKey !== undefined || undefined });
    return c.json(await view(await itcloudSettings()));
  })

  .post("/test", async (c) => {
    const a = auth(c);
    if (!rateLimit(`itcloud-test:${a.user.id}`, 6, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await ready();
    const r = await testItcloud(s);
    await saveItcloudSettings(a.user.id, { lastTest: { ok: r.ok, at: new Date().toISOString(), ...(r.ok ? { customers: r.customers, products: r.products } : { error: r.error }) } });
    return c.json(await view(await itcloudSettings()));
  })

  // ── customers ↔ clients (a proposal, applied only once reviewed) ──
  .get("/clients", async (c) => c.json(await run(async () => clientPlan(await ready()))))
  .put("/clients", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ links: z.array(z.object({ itcloudId: z.number().int().positive(), clientId: zUuid.nullable() })).max(500) }));
    const changed = await run(() => applyClientLinks(p.links));
    await audit(a.user.id, "itcloud.clients_linked", null, { changed });
    return c.json({ changed });
  })

  /** Pick by hand the contract that carries a customer's services (null: the portal chooses) */
  .put("/clients/:id/contract", async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ contractId: zUuid.nullable() }));
    try {
      await setCustomerContract(id, p.contractId);
    } catch (e) {
      if (e instanceof ItcloudError) throw new HTTPException(e.code === "contract_not_found" || e.code === "customer_not_matched" ? 404 : 400, { message: e.code });
      throw e;
    }
    await audit(a.user.id, "itcloud.contract_picked", String(id), { contractId: p.contractId });
    return c.json({ ok: true });
  })

  // ── products → services (SKU ITC-<id>, vendor ITCloud) ──
  .get("/services/plan", async (c) => c.json(await run(async () => servicePlan(await ready()))))
  .post("/services/plan", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ keys: z.array(z.string().regex(/^\d{1,9}$/)).max(1000) }));
    return c.json(await run(async () => applyServicePlan(await ready(), p.keys, a.user.id)));
  })

  /** One-time clean-up: the price and cost of every ITCloud service (and of its contract lines) back to 0, to type them by hand */
  .post("/services/zero", async (c) => {
    const a = auth(c);
    return c.json(await run(async () => zeroServiceMoney(a.user.id)));
  })

  // ── the services each customer has, and the sync onto contracts ──
  /** Pick by hand the contract of one ITCloud service (over the customer's); null: back to the customer's / automatic */
  .put("/services/:id/contract", async (c) => {
    const a = auth(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid_id" });
    const p = await body(c, z.object({ contractId: zUuid.nullable() }));
    try {
      const r = await setServiceContract(id, p.contractId);
      await audit(a.user.id, "itcloud.service_contract_picked", String(id), { contractId: p.contractId, moved: r.moved });
      return c.json({ moved: r.moved });
    } catch (e) {
      if (e instanceof ItcloudError) throw new HTTPException(e.code === "contract_not_found" || e.code === "service_not_found" || e.code === "customer_not_matched" ? 404 : 400, { message: e.code });
      throw e;
    }
  })
  .get("/services", async (c) => c.json({ rows: await serviceStates(), lastSync: (await itcloudSettings()).lastSync ?? null }))
  .post("/sync", async (c) => {
    const a = auth(c);
    if (!rateLimit(`itcloud-sync:${a.user.id}`, 6, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await itcloudSettings();
    if (!itcloudReady(s)) throw new HTTPException(409, { message: "itcloud_incomplete" });
    const r = await syncItcloud(a.user.id);
    return c.json(r);
  });
