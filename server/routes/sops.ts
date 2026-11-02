import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Procedures (SOP): step-by-step guides made by recording a screen (the recording itself happens in the browser:
 * only the screenshots of the steps come here). Seen with sops.view (published ones, plus one's own drafts), made
 * and changed with sops.edit (own procedures), everything of everyone with sops.manage.
 */
const MAX_STEPS = 150;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const zTitle = z.string().trim().min(1).max(200);
const zFraction = z.number().min(0).max(1);
const zMark = z.object({ kind: z.enum(["pin", "box"]), x: zFraction, y: zFraction, w: zFraction.optional(), h: zFraction.optional() });
const zMarks = z.array(zMark).max(40);
const zTags = z.array(z.string().trim().min(1).max(30)).max(10);
const zImage = z.object({
  type: z.enum(["image/jpeg", "image/png"]),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
});
const zStepFields = z.object({
  title: z.string().trim().max(200),
  description: z.string().trim().max(4000),
  marks: zMarks,
  source: z.enum(["manual", "auto", "paste", "upload", "text"]),
});

type Sop = typeof schema.sops.$inferSelect;

/** The bytes start like the type says (the browser's word is not enough) */
function imageMatches(type: string, data: string) {
  const head = Buffer.from(data.slice(0, 16), "base64");
  return type === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff : head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
}

const isManager = (c: Context<AppEnv>) => auth(c).permissions.includes("sops.manage");

/** A procedure the person may see: published, their own, or any for a manager */
async function seeOr404(c: Context<AppEnv>, id: string): Promise<Sop> {
  const [s] = await db().select().from(schema.sops).where(eq(schema.sops.id, id));
  if (!s || (s.status !== "published" && s.createdBy !== auth(c).user.id && !isManager(c))) throw new HTTPException(404, { message: "not_found" });
  return s;
}
/** … and may change: its author, or a manager */
async function editOr404(c: Context<AppEnv>, id: string): Promise<Sop> {
  const s = await seeOr404(c, id);
  if (s.createdBy !== auth(c).user.id && !isManager(c)) throw new HTTPException(403, { message: "forbidden" });
  return s;
}

const stepCard = (s: typeof schema.sopSteps.$inferSelect) => ({
  id: s.id,
  position: s.position,
  title: s.title,
  description: s.description,
  marks: s.marks,
  source: s.source,
  hasImage: !!s.image,
  imageWidth: s.imageWidth,
  imageHeight: s.imageHeight,
  updatedAt: s.updatedAt,
});
const stepColumns = {
  id: schema.sopSteps.id,
  position: schema.sopSteps.position,
  title: schema.sopSteps.title,
  description: schema.sopSteps.description,
  marks: schema.sopSteps.marks,
  source: schema.sopSteps.source,
  hasImage: sql<boolean>`${schema.sopSteps.image} is not null`,
  imageWidth: schema.sopSteps.imageWidth,
  imageHeight: schema.sopSteps.imageHeight,
  updatedAt: schema.sopSteps.updatedAt,
};

async function stepOr404(sopId: string, stepId: string) {
  const [st] = await db().select().from(schema.sopSteps).where(and(eq(schema.sopSteps.id, stepId), eq(schema.sopSteps.sopId, sopId)));
  if (!st) throw new HTTPException(404, { message: "not_found" });
  return st;
}
const touch = (id: string) => db().update(schema.sops).set({ updatedAt: new Date() }).where(eq(schema.sops.id, id));

/** Positions 0…n−1 in the order of the ids (one statement per step: a procedure has a hundred and fifty at most) */
async function renumber(ids: string[]) {
  for (let i = 0; i < ids.length; i++) await db().update(schema.sopSteps).set({ position: i }).where(eq(schema.sopSteps.id, ids[i]));
}

export const sopRoutes = new Hono<AppEnv>()
  .use(requireStaff)

  /** The procedures: published ones and one's own drafts (every draft for a manager) */
  .get("/", requirePermission("sops.view"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ s: schema.sops, author: schema.users.name })
      .from(schema.sops)
      .leftJoin(schema.users, eq(schema.users.id, schema.sops.createdBy))
      .where(isManager(c) ? undefined : or(eq(schema.sops.status, "published"), eq(schema.sops.createdBy, a.user.id)))
      .orderBy(desc(schema.sops.updatedAt));
    const ids = rows.map((r) => r.s.id);
    const steps = ids.length
      ? await db()
          .select({ sopId: schema.sopSteps.sopId, id: schema.sopSteps.id, hasImage: sql<boolean>`${schema.sopSteps.image} is not null` })
          .from(schema.sopSteps)
          .where(inArray(schema.sopSteps.sopId, ids))
          .orderBy(asc(schema.sopSteps.position))
      : [];
    return c.json(
      rows.map((r) => {
        const mine = steps.filter((x) => x.sopId === r.s.id);
        return { ...r.s, author: r.author, mine: r.s.createdBy === a.user.id, stepCount: mine.length, coverStepId: mine.find((x) => x.hasImage)?.id ?? null };
      }),
    );
  })

  .post("/", requirePermission("sops.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ title: zTitle, description: z.string().trim().max(4000).default(""), tags: zTags.default([]) }));
    const [row] = await db().insert(schema.sops).values({ title: p.title, description: p.description, tags: p.tags, createdBy: a.user.id }).returning();
    await audit(a.user.id, "sop.created", row.id, { title: row.title });
    return c.json({ ...row, author: a.user.name, mine: true, stepCount: 0, coverStepId: null }, 201);
  })

  .get("/:id", requirePermission("sops.view"), async (c) => {
    const a = auth(c);
    const s = await seeOr404(c, zUuid.parse(c.req.param("id")));
    const steps = await db().select(stepColumns).from(schema.sopSteps).where(eq(schema.sopSteps.sopId, s.id)).orderBy(asc(schema.sopSteps.position));
    const [author] = s.createdBy ? await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, s.createdBy)) : [];
    return c.json({ ...s, author: author?.name ?? null, mine: s.createdBy === a.user.id, canEdit: s.createdBy === a.user.id || isManager(c), steps });
  })

  .patch("/:id", requirePermission("sops.edit"), async (c) => {
    const a = auth(c);
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ title: zTitle, description: z.string().trim().max(4000), status: z.enum(["draft", "published"]), tags: zTags }).partial());
    if (p.status === "published" && s.status !== "published") {
      const [{ n }] = await db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.sopSteps).where(eq(schema.sopSteps.sopId, s.id));
      if (n === 0) throw new HTTPException(409, { message: "sop_empty" });
    }
    const [row] = await db().update(schema.sops).set({ ...p, updatedAt: new Date() }).where(eq(schema.sops.id, s.id)).returning();
    if (p.status && p.status !== s.status) await audit(a.user.id, p.status === "published" ? "sop.published" : "sop.unpublished", s.id, { title: row.title });
    return c.json(row);
  })

  .delete("/:id", requirePermission("sops.edit"), async (c) => {
    const a = auth(c);
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    await db().delete(schema.sops).where(eq(schema.sops.id, s.id));
    await audit(a.user.id, "sop.deleted", s.id, { title: s.title });
    return c.json({ ok: true });
  })

  /** Add a step (last, or right after `after`), with its picture when it has one */
  .post("/:id/steps", requirePermission("sops.edit"), async (c) => {
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, zStepFields.partial().extend({ image: zImage.optional(), after: zUuid.nullable().optional() }));
    if (p.image && !imageMatches(p.image.type, p.image.data)) throw new HTTPException(400, { message: "bad_image" });
    const existing = await db().select({ id: schema.sopSteps.id }).from(schema.sopSteps).where(eq(schema.sopSteps.sopId, s.id)).orderBy(asc(schema.sopSteps.position));
    if (existing.length >= MAX_STEPS) throw new HTTPException(409, { message: "too_many_steps" });
    const at = p.after ? existing.findIndex((x) => x.id === p.after) + 1 : existing.length;
    const [row] = await db()
      .insert(schema.sopSteps)
      .values({
        sopId: s.id,
        position: at,
        title: p.title ?? "",
        description: p.description ?? "",
        marks: p.marks ?? [],
        source: p.source ?? (p.image ? "manual" : "text"),
        image: p.image?.data ?? null,
        imageType: p.image?.type ?? null,
        imageWidth: p.image?.width ?? null,
        imageHeight: p.image?.height ?? null,
      })
      .returning();
    const order = existing.map((x) => x.id);
    order.splice(at, 0, row.id);
    await renumber(order);
    await touch(s.id);
    return c.json({ ...stepCard(row), position: at }, 201);
  })

  /** The order of the steps: every id of the procedure, once */
  .put("/:id/steps/order", requirePermission("sops.edit"), async (c) => {
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    const p = await body(c, z.object({ ids: z.array(zUuid).max(MAX_STEPS) }));
    const have = await db().select({ id: schema.sopSteps.id }).from(schema.sopSteps).where(eq(schema.sopSteps.sopId, s.id));
    if (p.ids.length !== have.length || new Set(p.ids).size !== p.ids.length || !p.ids.every((i) => have.some((h) => h.id === i))) throw new HTTPException(400, { message: "Validation failed" });
    await renumber(p.ids);
    await touch(s.id);
    return c.json({ ok: true });
  })

  .patch("/:id/steps/:sid", requirePermission("sops.edit"), async (c) => {
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    const st = await stepOr404(s.id, zUuid.parse(c.req.param("sid")));
    const p = await body(c, zStepFields.pick({ title: true, description: true, marks: true }).partial().extend({ image: zImage.optional() }));
    if (p.image && !imageMatches(p.image.type, p.image.data)) throw new HTTPException(400, { message: "bad_image" });
    const { image, ...text } = p;
    const [row] = await db()
      .update(schema.sopSteps)
      .set({ ...text, ...(image ? { image: image.data, imageType: image.type, imageWidth: image.width, imageHeight: image.height } : {}), updatedAt: new Date() })
      .where(eq(schema.sopSteps.id, st.id))
      .returning();
    await touch(s.id);
    return c.json(stepCard(row));
  })

  .delete("/:id/steps/:sid", requirePermission("sops.edit"), async (c) => {
    const s = await editOr404(c, zUuid.parse(c.req.param("id")));
    const st = await stepOr404(s.id, zUuid.parse(c.req.param("sid")));
    await db().delete(schema.sopSteps).where(eq(schema.sopSteps.id, st.id));
    const rest = await db().select({ id: schema.sopSteps.id }).from(schema.sopSteps).where(eq(schema.sopSteps.sopId, s.id)).orderBy(asc(schema.sopSteps.position));
    await renumber(rest.map((r) => r.id));
    await touch(s.id);
    return c.json({ ok: true });
  })

  /** A step's picture (type set by the server: a picture of a screen, never a page) */
  .get("/:id/steps/:sid/image", requirePermission("sops.view"), async (c) => {
    const s = await seeOr404(c, zUuid.parse(c.req.param("id")));
    const st = await stepOr404(s.id, zUuid.parse(c.req.param("sid")));
    if (!st.image) throw new HTTPException(404, { message: "not_found" });
    return new Response(Buffer.from(st.image, "base64"), {
      headers: { "content-type": st.imageType === "image/png" ? "image/png" : "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, no-store" },
    });
  });
