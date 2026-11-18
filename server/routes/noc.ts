import { Hono, type Context } from "hono";
import { type AppEnv, auth, requirePermission, requireStaff } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { clientIp, rateLimit, rateLimitFull } from "../lib/http.ts";
import { getNocKey, nocKeyMatches, nocSnapshot, rotateNocKey } from "../lib/noc.ts";

/**
 * Technical TV dashboard (tv.view / tv.manage). The kiosk feed is PUBLIC behind its own display key (never the lobby's):
 * same limits as the lobby feed (120 a minute per address, 10 wrong keys a minute then 429, no-store, no-referrer in app.ts).
 */
const MINUTE = 60_000;
const notFound = (c: Context) => c.json({ error: "not_found" }, 404);
const tooMany = (c: Context, retryAfter: number) => {
  c.header("Retry-After", String(Math.max(1, retryAfter)));
  return c.json({ error: "too_many_requests" }, 429);
};

export const nocRoutes = new Hono<AppEnv>()
  .get("/display/state", async (c) => {
    c.header("Cache-Control", "no-store");
    const ip = clientIp(c);
    const all = rateLimit(`noc:display:${ip}`, 120, MINUTE);
    if (!all.ok) return tooMany(c, all.retryAfter);
    if (rateLimitFull(`noc:display:bad:${ip}`, 10)) return tooMany(c, 60);
    const key = c.req.query("key");
    if (!key || key.length > 200 || !(await nocKeyMatches(key))) {
      const bad = rateLimit(`noc:display:bad:${ip}`, 10, MINUTE);
      return bad.ok ? notFound(c) : tooMany(c, bad.retryAfter);
    }
    return c.json(await nocSnapshot());
  })
  .get("/state", requireStaff, requirePermission("tv.view"), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await nocSnapshot({ rest: c.req.query("rest") === "1" }));
  })
  .get("/settings", requireStaff, requirePermission("tv.manage"), async (c) => c.json({ displayKey: await getNocKey() }))
  .post("/display-key/rotate", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const displayKey = await rotateNocKey();
    await audit(a.user.id, "noc.display_key_rotated");
    return c.json({ displayKey });
  });
