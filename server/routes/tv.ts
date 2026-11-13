import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, auth, requirePermission, requireStaff } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { clientIp, rateLimit, rateLimitFull } from "../lib/http.ts";
import { body } from "../lib/validate.ts";
import {
  EASTER_NAMES,
  triggerEaster,
  LABELS,
  TV_STATES,
  addBot,
  botByKey,
  botExists,
  deleteBot,
  displayKeyMatches,
  getAubaines,
  getDisplayKey,
  managedBots,
  parseState,
  publicState,
  rotateBotKey,
  rotateDisplayKey,
  setAubaines,
  setStatus,
  updateBot,
} from "../lib/tv.ts";

/**
 * Dashboard TV (tv.view / tv.manage): bots shown as office characters on the lobby TV.
 * The screen and the bots' report links are PUBLIC (a secret key in the URL): they only ever carry bot names and
 * approved generic labels, and a report link only changes that one bot's public status.
 */

const MINUTE = 60_000;
const notFound = (c: Context) => c.json({ error: "not_found" }, 404);
const tooMany = (c: Context, retryAfter: number) => {
  c.header("Retry-After", String(Math.max(1, retryAfter)));
  return c.json({ error: "too_many_requests" }, 429);
};
// Referrer-Policy: no-referrer for these public paths is set in app.ts (the global secure headers would override it here)
const hidden = (c: Context) => c.header("Cache-Control", "no-store");

const zName = z.object({ name: z.string().max(60) });
const zPatch = z.object({ name: z.string().max(60).optional(), sort: z.number().int().min(0).max(1000).optional() });
const zStatus = z.object({ state: z.enum(TV_STATES), label: z.union([z.string().max(200), z.number().int()]).nullish() });

const zEaster = z.object({ name: z.string().max(40).transform((s) => s.trim().toLowerCase()).pipe(z.enum(EASTER_NAMES)) });
// The picture lives in server/assets (never public/, never in dist): only these routes serve it
const PHOTO = path.join(import.meta.dirname, "..", "assets", "tv-easter-camille.jpg");
function photo(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Type", "image/jpeg");
  return c.body(new Uint8Array(readFileSync(PHOTO)));
}

const zAubaines =z.object({ aubaines: z.record(z.string().regex(/^[0-9]{1,2}$/), z.string().max(2000)) });

export const tvRoutes = new Hono<AppEnv>()
  // ── Public: the lobby screen (display key in the URL) ──
  .get("/display/state", async (c) => {
    hidden(c);
    const ip = clientIp(c);
    const all = rateLimit(`tv:display:${ip}`, 120, MINUTE);
    if (!all.ok) return tooMany(c, all.retryAfter);
    if (rateLimitFull(`tv:display:bad:${ip}`, 10)) return tooMany(c, 60);
    const key = c.req.query("key");
    if (!key || key.length > 200 || !(await displayKeyMatches(key))) {
      const bad = rateLimit(`tv:display:bad:${ip}`, 10, MINUTE);
      return bad.ok ? notFound(c) : tooMany(c, bad.retryAfter);
    }
    return c.json(await publicState());
  })

  // ── Public: the easter egg picture, behind the same key and limits as the feed ──
  .get("/display/easter/camille.jpg", async (c) => {
    hidden(c);
    const ip = clientIp(c);
    const all = rateLimit(`tv:display:${ip}`, 120, MINUTE);
    if (!all.ok) return tooMany(c, all.retryAfter);
    if (rateLimitFull(`tv:display:bad:${ip}`, 10)) return tooMany(c, 60);
    const key = c.req.query("key");
    if (!key || key.length > 200 || !(await displayKeyMatches(key))) {
      const bad = rateLimit(`tv:display:bad:${ip}`, 10, MINUTE);
      return bad.ok ? notFound(c) : tooMany(c, bad.retryAfter);
    }
    return photo(c);
  })

  // ── Public: a bot reports its status by opening a link (GET) or posting to it ──
  .on(["GET", "POST"], ["/r/:botKey/:state", "/r/:botKey/:state/:labelIndex"], async (c) => {
    hidden(c);
    const ip = clientIp(c);
    const all = rateLimit(`tv:report:${ip}`, 60, MINUTE);
    if (!all.ok) return tooMany(c, all.retryAfter);
    if (rateLimitFull(`tv:report:bad:${ip}`, 10)) return tooMany(c, 60);
    const key = c.req.param("botKey");
    const bot = key.length <= 200 ? await botByKey(key) : null;
    if (!bot) {
      const bad = rateLimit(`tv:report:bad:${ip}`, 10, MINUTE);
      return bad.ok ? notFound(c) : tooMany(c, bad.retryAfter);
    }
    const state = parseState(c.req.param("state"));
    if (!state) return notFound(c);
    await setStatus(bot.id, state, c.req.param("labelIndex"));
    return c.text(`OK ${bot.name} ${state}`);
  })

  // ── Signed in: the Dashboard TV page ──
  .get("/state", requireStaff, requirePermission("tv.view"), async (c) => {
    const x = c.req.query("xmas");
    const xmas = x && /^[0-9]{1,2}$/.test(x) ? Number(x) : null; // staff preview of a day of the Christmas scene
    return c.json(await publicState({ xmas }));
  })

  .get("/easter/camille.jpg", requireStaff, requirePermission("tv.view"), (c) => {
    hidden(c);
    return photo(c);
  })

  // ── Managers ──
  .post("/easter", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const lim = rateLimit(`tv:easter:${a.user.id}`, 6, MINUTE);
    if (!lim.ok) return tooMany(c, lim.retryAfter);
    const p = await body(c, zEaster);
    const e = triggerEaster(p.name.toLowerCase());
    await audit(a.user.id, "tv.easter", undefined, { name: e.name });
    return c.json({ ok: true, easter: e.name });
  })
  .get("/aubaines", requireStaff, requirePermission("tv.manage"), async (c) => c.json({ aubaines: await getAubaines() }))
  .put("/aubaines", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zAubaines);
    const aubaines = await setAubaines(p.aubaines);
    await audit(a.user.id, "tv.aubaines.updated", undefined, { days: Object.keys(aubaines).length });
    return c.json({ aubaines });
  })
  .get("/bots", requireStaff, requirePermission("tv.manage"), async (c) =>
    c.json({ displayKey: await getDisplayKey(), labels: [...LABELS], bots: await managedBots() }),
  )
  .post("/bots", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, zName);
    const bot = await addBot(p.name);
    await audit(a.user.id, "tv.bot.created", bot.id, { name: bot.name });
    return c.json(bot, 201);
  })
  .patch("/bots/:id", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const id = c.req.param("id");
    const p = await body(c, zPatch);
    await updateBot(id, p);
    await audit(a.user.id, "tv.bot.updated", id, { fields: Object.keys(p) });
    return c.json({ ok: true });
  })
  .delete("/bots/:id", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const id = c.req.param("id");
    const name = await deleteBot(id);
    await audit(a.user.id, "tv.bot.deleted", id, { name });
    return c.json({ ok: true });
  })
  .post("/bots/:id/rotate-key", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const id = c.req.param("id");
    const key = await rotateBotKey(id);
    await audit(a.user.id, "tv.bot.key_rotated", id);
    return c.json({ key });
  })
  .post("/display-key/rotate", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const displayKey = await rotateDisplayKey();
    await audit(a.user.id, "tv.display_key_rotated");
    return c.json({ displayKey });
  })
  .post("/bots/:id/status", requireStaff, requirePermission("tv.manage"), async (c) => {
    const a = auth(c);
    const id = c.req.param("id");
    const p = await body(c, zStatus);
    if (!(await botExists(id))) throw new HTTPException(404, { message: "not_found" });
    await setStatus(id, p.state, p.label);
    await audit(a.user.id, "tv.bot.status_set", id, { state: p.state });
    return c.json({ ok: true });
  });
