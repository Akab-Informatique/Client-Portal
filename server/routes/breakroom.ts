import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq, gt, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, permissionsOf, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { notify } from "../lib/notify.ts";
import { body, zUuid } from "../lib/validate.ts";
import { play, startState, winnerOf, type GameState, type Side } from "../../shared/checkers.ts";

/**
 * Coffee break (breakroom.use): checkers with a colleague who is online
 * (signed in and active in the last minutes), and Orbi the Alien's latest
 * videos (the channel's public feed, read here so the page talks to nobody else).
 */
const ONLINE_MS = 3 * 60_000;
/** Orbi the Alien — https://www.youtube.com/@orbithealien */
const ORBI_CHANNEL = "UCWwdio93JMiS987S0lo6RXg";
const FEED_TTL = 30 * 60_000;

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
    // the last list known, if any
    return feed?.videos ?? [];
  }
}

type Game = typeof schema.checkersGames.$inferSelect;
const stateOf = (g: Game): GameState => ({ board: g.board, turn: g.turn as Side, mustFrom: g.mustFrom });

async function names(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function view(g: Game, me: string, who: Map<string, string>) {
  const mySide: Side = g.redId === me ? "r" : "b";
  return {
    id: g.id,
    status: g.status,
    board: g.board,
    turn: g.turn,
    mustFrom: g.mustFrom,
    winner: g.winner,
    endedBy: g.endedBy,
    mySide,
    myTurn: g.status === "playing" && g.turn === mySide,
    invitedByMe: g.redId === me,
    opponent: { id: mySide === "r" ? g.blackId : g.redId, name: who.get(mySide === "r" ? g.blackId : g.redId) ?? "" },
    updatedAt: g.updatedAt,
  };
}

/** A game this person plays in (nobody else sees it) */
async function myGame(id: string, me: string): Promise<Game> {
  const [g] = await db()
    .select()
    .from(schema.checkersGames)
    .where(and(eq(schema.checkersGames.id, zUuid.parse(id)), or(eq(schema.checkersGames.redId, me), eq(schema.checkersGames.blackId, me))));
  if (!g) throw new HTTPException(404, { message: "not_found" });
  return g;
}

async function save(g: Game, set: Partial<Game>) {
  const [row] = await db()
    .update(schema.checkersGames)
    .set({ ...set, updatedAt: new Date() })
    // nobody else changed it since it was read (two clicks, two tabs)
    .where(
      and(
        eq(schema.checkersGames.id, g.id),
        eq(schema.checkersGames.status, g.status),
        eq(schema.checkersGames.board, g.board),
        eq(schema.checkersGames.turn, g.turn),
      ),
    )
    .returning();
  if (!row) throw new HTTPException(409, { message: "game_changed" });
  return row;
}

export const breakroomRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("breakroom.use"))

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

  // ── Checkers ──
  /** My invitations and games (finished ones for a day) */
  .get("/checkers", async (c) => {
    const me = auth(c).user.id;
    const g = schema.checkersGames;
    const rows = await db()
      .select()
      .from(g)
      .where(and(or(eq(g.redId, me), eq(g.blackId, me)), or(inArray(g.status, ["invited", "playing"]), gt(g.updatedAt, new Date(Date.now() - 86_400_000)))))
      .orderBy(desc(g.updatedAt))
      .limit(30);
    const who = await names([...new Set(rows.flatMap((r) => [r.redId, r.blackId]))]);
    return c.json(rows.filter((r) => r.status !== "declined" || r.redId === me).map((r) => view(r, me, who)));
  })

  .get("/checkers/:id", async (c) => {
    const me = auth(c).user.id;
    const g = await myGame(c.req.param("id"), me);
    return c.json(view(g, me, await names([g.redId, g.blackId])));
  })

  /** Invite a colleague: they get a notification; one open game per pair */
  .post("/checkers", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ opponentId: zUuid }));
    if (p.opponentId === a.user.id) throw new HTTPException(400, { message: "invalid_opponent" });
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, p.opponentId));
    if (!u || u.kind !== "staff" || !u.active || !(await permissionsOf(u)).includes("breakroom.use"))
      throw new HTTPException(400, { message: "invalid_opponent" });
    const g = schema.checkersGames;
    const pair = or(and(eq(g.redId, a.user.id), eq(g.blackId, u.id)), and(eq(g.redId, u.id), eq(g.blackId, a.user.id)));
    const [open] = await db()
      .select()
      .from(g)
      .where(and(pair, inArray(g.status, ["invited", "playing"])));
    if (open) return c.json(view(open, a.user.id, await names([open.redId, open.blackId])));
    const s = startState();
    const [row] = await db().insert(g).values({ redId: a.user.id, blackId: u.id, board: s.board, turn: s.turn }).returning();
    await notify([u.id], { type: "breakroom.invite", data: { from: a.user.name, gameId: row.id }, link: `/breakroom?game=${row.id}` });
    return c.json(view(row, a.user.id, await names([row.redId, row.blackId])), 201);
  })

  /** The one invited accepts or declines */
  .post("/checkers/:id/respond", async (c) => {
    const me = auth(c).user.id;
    const p = await body(c, z.object({ accept: z.boolean() }));
    const g = await myGame(c.req.param("id"), me);
    if (g.blackId !== me || g.status !== "invited") throw new HTTPException(409, { message: "game_not_invited" });
    const row = await save(g, { status: p.accept ? "playing" : "declined" });
    return c.json(view(row, me, await names([row.redId, row.blackId])));
  })

  /** A move: checked against the rules; the game ends when the other side cannot play */
  .post("/checkers/:id/move", async (c) => {
    const me = auth(c).user.id;
    const p = await body(c, z.object({ from: z.number().int().min(0).max(63), to: z.number().int().min(0).max(63) }));
    const g = await myGame(c.req.param("id"), me);
    const mySide: Side = g.redId === me ? "r" : "b";
    if (g.status !== "playing") throw new HTTPException(409, { message: "game_not_playing" });
    if (g.turn !== mySide) throw new HTTPException(409, { message: "not_your_turn" });
    const next = play(stateOf(g), p.from, p.to);
    if (!next) throw new HTTPException(400, { message: "illegal_move" });
    const winner = winnerOf(next);
    const row = await save(g, {
      board: next.board,
      turn: next.turn,
      mustFrom: next.mustFrom,
      ...(winner ? { status: "done", winner, endedBy: "win" } : {}),
    });
    return c.json(view(row, me, await names([row.redId, row.blackId])));
  })

  /** Give up (or cancel an invitation not answered yet) */
  .post("/checkers/:id/resign", async (c) => {
    const me = auth(c).user.id;
    const g = await myGame(c.req.param("id"), me);
    if (g.status === "invited" && g.redId === me) {
      const row = await save(g, { status: "declined" });
      return c.json(view(row, me, await names([row.redId, row.blackId])));
    }
    if (g.status !== "playing") throw new HTTPException(409, { message: "game_not_playing" });
    const row = await save(g, { status: "done", winner: g.redId === me ? "b" : "r", endedBy: "resign" });
    return c.json(view(row, me, await names([row.redId, row.blackId])));
  });
