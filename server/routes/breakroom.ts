import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { Chess } from "chess.js";
import { db, schema } from "../db/index.ts";
import { auth, permissionsOf, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { notify } from "../lib/notify.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Coffee break (breakroom.use): chess with a colleague who is online (signed
 * in and active in the last minutes), and Orbi the Alien's latest videos (the
 * channel's public feed, read here so the page talks to nobody else).
 *
 * 30 minutes a day: the page sends a beat every 30 s while it is on screen;
 * the time between two beats (a minute at most) counts. Once the day's time is
 * used, everything here but the status answers 403 "break_over" until tomorrow.
 */
export const BREAK_LIMIT_SECONDS = 30 * 60;
const ONLINE_MS = 3 * 60_000;
/** Orbi the Alien — https://www.youtube.com/@orbithealien */
const ORBI_CHANNEL = "UCWwdio93JMiS987S0lo6RXg";
const FEED_TTL = 30 * 60_000;

/** Today in Québec, YYYY-MM-DD */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());

async function usedToday(userId: string) {
  const [u] = await db()
    .select()
    .from(schema.breakroomUsage)
    .where(and(eq(schema.breakroomUsage.userId, userId), eq(schema.breakroomUsage.day, today())));
  return u?.usedSeconds ?? 0;
}
const statusOf = (used: number) => ({
  limitSeconds: BREAK_LIMIT_SECONDS,
  usedSeconds: Math.min(used, BREAK_LIMIT_SECONDS),
  remainingSeconds: Math.max(0, BREAK_LIMIT_SECONDS - used),
});

type Video = { id: string; title: string; published: string };
let feed: { at: number; videos: Video[] } | null = null;
const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** The channel's latest videos (YouTube's public feed: the last 15), kept 30 minutes */
async function orbiVideos(): Promise<Video[]> {
  if (feed && Date.now() - feed.at < FEED_TTL) return feed.videos;
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ORBI_CHANNEL}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const xml = await r.text();
    const videos: Video[] = [];
    for (const entry of xml.split("<entry>").slice(1)) {
      const id = entry.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/)?.[1];
      const title = entry.match(/<title>([^<]*)<\/title>/)?.[1];
      const published = entry.match(/<published>([^<]*)<\/published>/)?.[1];
      if (id && title) videos.push({ id, title: decode(title).slice(0, 200), published: published ?? "" });
    }
    feed = { at: Date.now(), videos };
    return videos;
  } catch (e) {
    console.warn("[breakroom] Orbi feed:", e instanceof Error ? e.message : e);
    return feed?.videos ?? [];
  }
}

type Game = typeof schema.chessGames.$inferSelect;
type Color = "w" | "b";

async function names(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function view(g: Game, me: string, who: Map<string, string>) {
  const myColor: Color = g.whiteId === me ? "w" : "b";
  const chess = new Chess(g.fen);
  const turn = chess.turn();
  const other = myColor === "w" ? g.blackId : g.whiteId;
  return {
    id: g.id,
    status: g.status,
    fen: g.fen,
    pgn: g.pgn,
    lastMove: g.lastMove,
    turn,
    inCheck: g.status === "playing" && chess.inCheck(),
    result: g.result,
    endedBy: g.endedBy,
    myColor,
    myTurn: g.status === "playing" && turn === myColor,
    invitedByMe: g.whiteId === me,
    opponent: { id: other, name: who.get(other) ?? "" },
    updatedAt: g.updatedAt,
  };
}

/** A game this person plays in (nobody else sees it) */
async function myGame(id: string, me: string): Promise<Game> {
  const g = schema.chessGames;
  const [row] = await db()
    .select()
    .from(g)
    .where(and(eq(g.id, zUuid.parse(id)), or(eq(g.whiteId, me), eq(g.blackId, me))));
  if (!row) throw new HTTPException(404, { message: "not_found" });
  return row;
}

async function save(g: Game, set: Partial<Game>) {
  const t = schema.chessGames;
  const [row] = await db()
    .update(t)
    .set({ ...set, updatedAt: new Date() })
    // nobody else changed it since it was read (two clicks, two tabs)
    .where(and(eq(t.id, g.id), eq(t.status, g.status), eq(t.fen, g.fen)))
    .returning();
  if (!row) throw new HTTPException(409, { message: "game_changed" });
  return row;
}

export const breakroomRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("breakroom.use"))

  /** Today's break time */
  .get("/status", async (c) => c.json(statusOf(await usedToday(auth(c).user.id))))

  /** The page is on screen: the time since the last beat counts (a minute at most) */
  .post("/beat", async (c) => {
    const me = auth(c).user.id;
    const now = new Date();
    const day = today();
    const u = schema.breakroomUsage;
    const [cur] = await db()
      .select()
      .from(u)
      .where(and(eq(u.userId, me), eq(u.day, day)));
    const gap = cur?.lastBeatAt ? Math.floor((now.getTime() - cur.lastBeatAt.getTime()) / 1000) : 0;
    // a pause longer than a minute (page hidden, closed) does not count
    const add = gap > 0 && gap <= 60 ? gap : 0;
    await db()
      .insert(u)
      .values({ userId: me, day, usedSeconds: add, lastBeatAt: now })
      .onConflictDoUpdate({ target: [u.userId, u.day], set: { usedSeconds: sql`least(${u.usedSeconds} + ${add}, ${BREAK_LIMIT_SECONDS})`, lastBeatAt: now } });
    return c.json(statusOf(await usedToday(me)));
  })

  // the rest: only while there is break time left today
  .use(async (c, next) => {
    if ((await usedToday(auth(c).user.id)) >= BREAK_LIMIT_SECONDS) throw new HTTPException(403, { message: "break_over" });
    await next();
  })

  /** Colleagues online now (who may also take a break) */
  .get("/online", async (c) => {
    const a = auth(c);
    const since = new Date(Date.now() - ONLINE_MS);
    const rows = await db()
      .selectDistinct({ id: schema.users.id, name: schema.users.name })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(gt(schema.sessions.lastSeenAt, since), eq(schema.users.kind, "staff"), eq(schema.users.active, true), ne(schema.users.id, a.user.id)));
    const out = [];
    for (const r of rows) {
      const [u] = await db().select().from(schema.users).where(eq(schema.users.id, r.id));
      if (u && (await permissionsOf(u)).includes("breakroom.use")) out.push(r);
    }
    return c.json(out.sort((x, y) => x.name.localeCompare(y.name)));
  })

  .get("/videos", async (c) => c.json({ channel: "https://www.youtube.com/@orbithealien", videos: await orbiVideos() }))

  // ── Chess ──
  /** My invitations and games (finished ones for a day) */
  .get("/chess", async (c) => {
    const me = auth(c).user.id;
    const g = schema.chessGames;
    const rows = await db()
      .select()
      .from(g)
      .where(and(or(eq(g.whiteId, me), eq(g.blackId, me)), or(inArray(g.status, ["invited", "playing"]), gt(g.updatedAt, new Date(Date.now() - 86_400_000)))))
      .orderBy(desc(g.updatedAt))
      .limit(30);
    const who = await names([...new Set(rows.flatMap((r) => [r.whiteId, r.blackId]))]);
    return c.json(rows.filter((r) => r.status !== "declined" || r.whiteId === me).map((r) => view(r, me, who)));
  })

  .get("/chess/:id", async (c) => {
    const me = auth(c).user.id;
    const g = await myGame(c.req.param("id"), me);
    return c.json(view(g, me, await names([g.whiteId, g.blackId])));
  })

  /** Invite a colleague: they get a notification; one open game per pair */
  .post("/chess", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ opponentId: zUuid }));
    if (p.opponentId === a.user.id) throw new HTTPException(400, { message: "invalid_opponent" });
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, p.opponentId));
    if (!u || u.kind !== "staff" || !u.active || !(await permissionsOf(u)).includes("breakroom.use"))
      throw new HTTPException(400, { message: "invalid_opponent" });
    const g = schema.chessGames;
    const pair = or(and(eq(g.whiteId, a.user.id), eq(g.blackId, u.id)), and(eq(g.whiteId, u.id), eq(g.blackId, a.user.id)));
    const [open] = await db()
      .select()
      .from(g)
      .where(and(pair, inArray(g.status, ["invited", "playing"])));
    if (open) return c.json(view(open, a.user.id, await names([open.whiteId, open.blackId])));
    const [row] = await db().insert(g).values({ whiteId: a.user.id, blackId: u.id, fen: new Chess().fen() }).returning();
    await notify([u.id], { type: "breakroom.invite", data: { from: a.user.name, gameId: row.id }, link: `/breakroom?game=${row.id}` });
    return c.json(view(row, a.user.id, await names([row.whiteId, row.blackId])), 201);
  })

  /** The one invited accepts or declines */
  .post("/chess/:id/respond", async (c) => {
    const me = auth(c).user.id;
    const p = await body(c, z.object({ accept: z.boolean() }));
    const g = await myGame(c.req.param("id"), me);
    if (g.blackId !== me || g.status !== "invited") throw new HTTPException(409, { message: "game_not_invited" });
    const row = await save(g, { status: p.accept ? "playing" : "declined" });
    return c.json(view(row, me, await names([row.whiteId, row.blackId])));
  })

  /** A move: checked by the rules of chess; the game ends on checkmate, stalemate or a draw */
  .post("/chess/:id/move", async (c) => {
    const me = auth(c).user.id;
    const square = z.string().regex(/^[a-h][1-8]$/);
    const p = await body(c, z.object({ from: square, to: square, promotion: z.enum(["q", "r", "b", "n"]).optional() }));
    const g = await myGame(c.req.param("id"), me);
    const myColor: Color = g.whiteId === me ? "w" : "b";
    if (g.status !== "playing") throw new HTTPException(409, { message: "game_not_playing" });
    // the whole game (threefold repetition is judged on it), or the position alone
    const chess = new Chess();
    try {
      if (g.pgn) chess.loadPgn(g.pgn);
      else chess.load(g.fen);
    } catch {
      chess.load(g.fen);
    }
    if (chess.turn() !== myColor) throw new HTTPException(409, { message: "not_your_turn" });
    try {
      chess.move({ from: p.from, to: p.to, promotion: p.promotion ?? "q" });
    } catch {
      throw new HTTPException(400, { message: "illegal_move" });
    }
    const over = chess.isGameOver();
    const row = await save(g, {
      fen: chess.fen(),
      pgn: chess.pgn(),
      lastMove: `${p.from}${p.to}`,
      ...(over
        ? chess.isCheckmate()
          ? { status: "done", result: myColor, endedBy: "checkmate" }
          : { status: "done", result: "draw", endedBy: chess.isStalemate() ? "stalemate" : "draw" }
        : {}),
    });
    return c.json(view(row, me, await names([row.whiteId, row.blackId])));
  })

  /** Give up (or cancel an invitation not answered yet) */
  .post("/chess/:id/resign", async (c) => {
    const me = auth(c).user.id;
    const g = await myGame(c.req.param("id"), me);
    if (g.status === "invited" && g.whiteId === me) {
      const row = await save(g, { status: "declined" });
      return c.json(view(row, me, await names([row.whiteId, row.blackId])));
    }
    if (g.status !== "playing") throw new HTTPException(409, { message: "game_not_playing" });
    const row = await save(g, { status: "done", result: g.whiteId === me ? "b" : "w", endedBy: "resign" });
    return c.json(view(row, me, await names([row.whiteId, row.blackId])));
  });
