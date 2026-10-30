import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Custom Kanban boards of the Tickets page. **Each technician has their own**: the boards, their order and what sits on them are
 * theirs alone (nobody else sees or changes them) and are saved here, so they follow the person to any computer. They only exist in the
 * Kanban view (custom boards): a ticket carries no board field, and the same ticket can sit on a different board for each person.
 * (The Kanban can also be set by status or by checkpoint date: those columns are the tickets' own fields, nothing is stored here.)
 *
 * Reading needs tickets.view; making, renaming, ordering, deleting boards and moving tickets between them needs tickets.edit.
 */
const MAX_BOARDS = 30;

async function listAll(userId: string) {
  const d = db();
  const [boards, cards] = await Promise.all([
    d.select({ id: schema.ticketBoards.id, name: schema.ticketBoards.name, position: schema.ticketBoards.position }).from(schema.ticketBoards).where(eq(schema.ticketBoards.userId, userId)).orderBy(asc(schema.ticketBoards.position), asc(schema.ticketBoards.createdAt)),
    d.select({ ticketId: schema.ticketBoardCards.ticketId, boardId: schema.ticketBoardCards.boardId, position: schema.ticketBoardCards.position }).from(schema.ticketBoardCards).where(eq(schema.ticketBoardCards.userId, userId)).orderBy(asc(schema.ticketBoardCards.position)),
  ]);
  return { boards, cards };
}

/** One of the person's own boards (someone else's is simply not found) */
async function ownBoard(userId: string, id: string) {
  const [b] = await db().select({ id: schema.ticketBoards.id }).from(schema.ticketBoards).where(and(eq(schema.ticketBoards.id, id), eq(schema.ticketBoards.userId, userId)));
  if (!b) throw new HTTPException(404, { message: "not_found" });
  return b;
}

const zName = z.string().trim().min(1).max(60);

export const ticketBoardRoutes = new Hono<AppEnv>()
  .get("/", requirePermission("tickets.view"), async (c) => c.json(await listAll(auth(c).user.id)))

  .post("/", requirePermission("tickets.edit"), async (c) => {
    const me = auth(c).user.id;
    const { name } = await body(c, z.object({ name: zName }));
    const d = db();
    const [{ n, last }] = await d
      .select({ n: sql<number>`count(*)::int`, last: sql<number>`coalesce(max(${schema.ticketBoards.position}), -1)::int` })
      .from(schema.ticketBoards)
      .where(eq(schema.ticketBoards.userId, me));
    if (n >= MAX_BOARDS) throw new HTTPException(400, { message: "boards_limit" });
    const [row] = await d.insert(schema.ticketBoards).values({ name, position: last + 1, userId: me, createdBy: me }).returning({ id: schema.ticketBoards.id, name: schema.ticketBoards.name, position: schema.ticketBoards.position });
    return c.json(row, 201);
  })

  /** Boards in this order. */
  .put("/order", requirePermission("tickets.edit"), async (c) => {
    const me = auth(c).user.id;
    const { ids } = await body(c, z.object({ ids: z.array(zUuid).max(MAX_BOARDS) }));
    for (const [i, id] of ids.entries()) await db().update(schema.ticketBoards).set({ position: i }).where(and(eq(schema.ticketBoards.id, id), eq(schema.ticketBoards.userId, me)));
    return c.json(await listAll(me));
  })

  .patch("/:id", requirePermission("tickets.edit"), async (c) => {
    const me = auth(c).user.id;
    const { name } = await body(c, z.object({ name: zName }));
    const b = await ownBoard(me, zUuid.parse(c.req.param("id")));
    await db().update(schema.ticketBoards).set({ name }).where(eq(schema.ticketBoards.id, b.id));
    return c.json({ ok: true });
  })

  /** Delete one of my boards: its tickets go back to "not sorted" (nothing happens to the tickets). */
  .delete("/:id", requirePermission("tickets.edit"), async (c) => {
    const b = await ownBoard(auth(c).user.id, zUuid.parse(c.req.param("id")));
    await db().delete(schema.ticketBoards).where(eq(schema.ticketBoards.id, b.id));
    return c.json({ ok: true });
  })

  /**
   * Put a ticket on one of my boards — before another ticket of it (`before`), else at the
   * end —, move it to another of my boards, or take it off (boardId null). Tickets hidden
   * by the filters keep their place, which is why the place is "before this one".
   */
  .put("/cards/:ticketId", requirePermission("tickets.edit"), async (c) => {
    const me = auth(c).user.id;
    const ticketId = Number(c.req.param("ticketId"));
    if (!Number.isInteger(ticketId) || ticketId <= 0) throw new HTTPException(400, { message: "invalid" });
    const p = await body(c, z.object({ boardId: zUuid.nullable(), before: z.number().int().positive().nullable().optional() }));
    const d = db();
    if (p.boardId === null) {
      await d.delete(schema.ticketBoardCards).where(and(eq(schema.ticketBoardCards.userId, me), eq(schema.ticketBoardCards.ticketId, ticketId)));
      return c.json(await listAll(me));
    }
    await ownBoard(me, p.boardId);
    // the target board's other tickets, in order, with this one inserted before the asked one (else at the end)
    const others = await d
      .select({ ticketId: schema.ticketBoardCards.ticketId })
      .from(schema.ticketBoardCards)
      .where(and(eq(schema.ticketBoardCards.userId, me), eq(schema.ticketBoardCards.boardId, p.boardId), ne(schema.ticketBoardCards.ticketId, ticketId)))
      .orderBy(asc(schema.ticketBoardCards.position));
    const order = others.map((x) => x.ticketId);
    const at = p.before != null ? order.indexOf(p.before) : -1;
    order.splice(at >= 0 ? at : order.length, 0, ticketId);
    for (const [i, id] of order.entries()) {
      await d
        .insert(schema.ticketBoardCards)
        .values({ userId: me, ticketId: id, boardId: p.boardId, position: i })
        .onConflictDoUpdate({ target: [schema.ticketBoardCards.userId, schema.ticketBoardCards.ticketId], set: { boardId: p.boardId, position: i, updatedAt: new Date() } });
    }
    return c.json(await listAll(me));
  });
