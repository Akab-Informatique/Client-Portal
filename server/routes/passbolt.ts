import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as openpgp from "openpgp";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { seal, unseal } from "../lib/crypto.ts";
import { body, zUuid } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { forward, passboltSettings } from "../lib/passbolt.ts";

/**
 * Sécurité › Passbolt (passbolt.use). Spike: Passbolt is the vault, the portal is the screen. The server keeps
 * each person's passphrase-protected private key (sealed again with the portal's secret) and forwards a short
 * list of Passbolt calls; the browser signs in with the key and decrypts. The server never has a passphrase or a
 * decrypted secret. Off in production unless PASSBOLT_SPIKE=true.
 */
export const passboltRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("passbolt.use"))
  .use(async (_c, next) => {
    if (!config.passboltEnabled) throw new HTTPException(403, { message: "passbolt_disabled" });
    await next();
  })

  /** Is it set up, and has this person put their key? */
  .get("/status", async (c) => {
    const a = auth(c);
    const [s, [k]] = await Promise.all([passboltSettings(), db().select().from(schema.passboltKeys).where(eq(schema.passboltKeys.userId, a.user.id))]);
    return c.json({ enabled: s.enabled && Boolean(s.baseUrl), baseUrl: s.baseUrl, hasKey: Boolean(k), fingerprint: k?.fingerprint ?? null, passboltUserId: k?.passboltUserId ?? null });
  })

  /** Their own key, still protected by their passphrase, for the browser to unlock. */
  .get("/key", async (c) => {
    const a = auth(c);
    const [k] = await db().select().from(schema.passboltKeys).where(eq(schema.passboltKeys.userId, a.user.id));
    const armored = unseal(k?.armoredSealed);
    if (!k || !armored) throw new HTTPException(404, { message: "not_found" });
    return c.json({ armoredKey: armored, passboltUserId: k.passboltUserId, fingerprint: k.fingerprint });
  })

  /** Keep their private key. Refused when it is not protected by a passphrase (the server must never hold a usable key). */
  .put("/key", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ armoredKey: z.string().trim().min(100).max(40_000), passboltUserId: zUuid }));
    let key: openpgp.PrivateKey;
    try {
      key = await openpgp.readPrivateKey({ armoredKey: p.armoredKey });
    } catch {
      throw new HTTPException(400, { message: "passbolt_bad_key" });
    }
    if (key.isDecrypted()) throw new HTTPException(400, { message: "passbolt_key_unprotected" });
    const fingerprint = key.getFingerprint().toUpperCase();
    const values = { armoredSealed: seal(key.armor()), passboltUserId: p.passboltUserId, fingerprint, updatedAt: new Date() };
    await db()
      .insert(schema.passboltKeys)
      .values({ userId: a.user.id, ...values })
      .onConflictDoUpdate({ target: schema.passboltKeys.userId, set: values });
    await audit(a.user.id, "passbolt.key_saved", a.user.id, { fingerprint });
    return c.json({ ok: true, fingerprint });
  })

  .delete("/key", async (c) => {
    const a = auth(c);
    await db().delete(schema.passboltKeys).where(eq(schema.passboltKeys.userId, a.user.id));
    await audit(a.user.id, "passbolt.key_removed", a.user.id, {});
    return c.json({ ok: true });
  })

  /** A secret was shown: the event only (never the secret, never its name). */
  .post("/reveal-log", async (c) => {
    const a = auth(c);
    if (!rateLimit(`passbolt-reveal:${a.user.id}`, 60, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const p = await body(c, z.object({ resourceId: zUuid }));
    await audit(a.user.id, "passbolt.reveal", p.resourceId, {});
    return c.json({ ok: true });
  })

  /** The forwarding: a short list of Passbolt paths, the person's own bearer token, nothing else. */
  .all("/proxy/*", async (c) => {
    const a = auth(c);
    if (!rateLimit(`passbolt-proxy:${a.user.id}`, 240, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const method = c.req.method;
    if (method !== "GET" && method !== "POST") throw new HTTPException(405, { message: "method_not_allowed" });
    const url = new URL(c.req.url);
    const path = url.pathname.slice(url.pathname.indexOf("/proxy") + "/proxy".length);
    let raw: string | undefined;
    if (method === "POST") {
      raw = await c.req.text();
      if (raw.length > 100_000) throw new HTTPException(413, { message: "too_big" });
    }
    try {
      const r = await forward(method, path, url.search.replace(/^\?/, ""), { authorization: c.req.header("authorization") }, raw);
      return new Response(r.text, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      if (m === "passbolt_path") throw new HTTPException(403, { message: "passbolt_path" });
      if (m === "passbolt_not_ready") throw new HTTPException(409, { message: "passbolt_not_ready" });
      throw new HTTPException(502, { message: "passbolt_unreachable" });
    }
  });
