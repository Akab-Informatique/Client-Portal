import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * A staff member's private notes and quick reminders (the panel of the To do icon). Everything is scoped to the signed-in person:
 * nobody else, administrators included, ever reads or changes them.
 */
const zWhen = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "bad_date");
const view = (n: typeof schema.personalNotes.$inferSelect) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, remindAt: n.remindAt?.toISOString() ?? null, notified: n.notifiedAt !== null, done: n.doneAt !== null, updatedAt: n.updatedAt.toISOString(), createdAt: n.createdAt.toISOString() });

export const myNotesRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("pipeline.view"))
  .get("/", async (c) => {
    const rows = await db()
      .select()
      .from(schema.personalNotes)
      .where(eq(schema.personalNotes.userId, auth(c).user.id))
      // reminders still to do first (the soonest on top), then notes and finished reminders, newest first
      .orderBy(sql`(${schema.personalNotes.kind} = 'reminder' and ${schema.personalNotes.doneAt} is null) desc`, sql`case when ${schema.personalNotes.kind} = 'reminder' and ${schema.personalNotes.doneAt} is null then ${schema.personalNotes.remindAt} end asc`, desc(schema.personalNotes.updatedAt))
      .limit(300);
    return c.json(rows.map(view));
  })
  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ kind: z.enum(["note", "reminder"]).default("note"), title: z.string().trim().max(120).default(""), body: z.string().max(4000).default(""), remindAt: zWhen.nullable().default(null) }));
    if (!p.title.trim() && !p.body.trim()) throw new HTTPException(400, { message: "note_empty" });
    if (p.kind === "reminder" && !p.remindAt) throw new HTTPException(400, { message: "reminder_needs_time" });
    const [row] = await db()
      .insert(schema.personalNotes)
      .values({ userId: a.user.id, kind: p.kind, title: p.title, body: p.body, remindAt: p.kind === "reminder" && p.remindAt ? new Date(p.remindAt) : null })
      .returning();
    return c.json(view(row), 201);
  })
  .patch("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, z.object({ title: z.string().trim().max(120).optional(), body: z.string().max(4000).optional(), remindAt: zWhen.nullable().optional(), done: z.boolean().optional() }));
    const [cur] = await db().select().from(schema.personalNotes).where(and(eq(schema.personalNotes.id, id), eq(schema.personalNotes.userId, a.user.id)));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const set: Partial<typeof schema.personalNotes.$inferInsert> = { updatedAt: new Date() };
    if (p.title !== undefined) set.title = p.title;
    if (p.body !== undefined) set.body = p.body;
    if (p.done !== undefined) set.doneAt = p.done ? new Date() : null;
    // a new time rings again
    if (p.remindAt !== undefined && cur.kind === "reminder") {
      if (!p.remindAt) throw new HTTPException(400, { message: "reminder_needs_time" });
      set.remindAt = new Date(p.remindAt);
      set.notifiedAt = null;
    }
    const [row] = await db().update(schema.personalNotes).set(set).where(eq(schema.personalNotes.id, id)).returning();
    return c.json(view(row));
  })
  .delete("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const gone = await db().delete(schema.personalNotes).where(and(eq(schema.personalNotes.id, id), eq(schema.personalNotes.userId, a.user.id))).returning({ id: schema.personalNotes.id });
    if (!gone.length) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  });
