import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";

/**
 * Knowledge base: articles the team writes and reads. Read with kb.view (published ones, plus one's own drafts),
 * written and changed with kb.edit (own articles), everything of everyone with kb.manage.
 */
const zTitle = z.string().trim().min(1).max(200);
const zCategory = z.string().trim().max(60);
const zText = z.string().max(60_000);
const zTags = z.array(z.string().trim().min(1).max(30)).max(10);
const zCreate = z.object({ title: zTitle, category: zCategory.default(""), body: zText.default(""), tags: zTags.default([]), published: z.boolean().default(false) });
// a change has no defaults (a field not sent is left as it is)
const zChange = z.object({ title: zTitle.optional(), category: zCategory.optional(), body: zText.optional(), tags: zTags.optional(), published: z.boolean().optional() });

const isManager = (c: Context<AppEnv>) => auth(c).permissions.includes("kb.manage");

type Article = typeof schema.kbArticles.$inferSelect;

/** An article the person may see: a published one, their own draft, or any with kb.manage (else it does not exist for them) */
async function articleOr404(c: Context<AppEnv>, id: string): Promise<Article> {
  const parsed = zUuid.safeParse(id);
  if (!parsed.success) throw new HTTPException(404, { message: "not_found" });
  const [row] = await db().select().from(schema.kbArticles).where(eq(schema.kbArticles.id, parsed.data));
  if (!row || (!row.published && row.createdBy !== auth(c).user.id && !isManager(c))) throw new HTTPException(404, { message: "not_found" });
  return row;
}

/** Only the author or a manager changes an article */
function mayChange(c: Context<AppEnv>, a: Article) {
  if (a.createdBy !== auth(c).user.id && !isManager(c)) throw new HTTPException(403, { message: "forbidden" });
}

export const kbRoutes = new Hono<AppEnv>()
  .get("/", requirePermission("kb.view"), async (c) => {
    const a = auth(c);
    const rows = await db()
      .select({ k: schema.kbArticles, author: schema.users.name })
      .from(schema.kbArticles)
      .leftJoin(schema.users, eq(schema.users.id, schema.kbArticles.createdBy))
      .where(isManager(c) ? undefined : or(eq(schema.kbArticles.published, true), eq(schema.kbArticles.createdBy, a.user.id)))
      .orderBy(desc(schema.kbArticles.updatedAt))
      .limit(1000);
    return c.json(rows.map(({ k, author }) => ({ id: k.id, title: k.title, category: k.category, tags: k.tags, published: k.published, excerpt: k.body.replace(/\s+/g, " ").slice(0, 200), author, mine: k.createdBy === a.user.id, createdAt: k.createdAt, updatedAt: k.updatedAt })));
  })
  .get("/:id", requirePermission("kb.view"), async (c) => {
    const a = auth(c);
    const k = await articleOr404(c, c.req.param("id"));
    const [author] = k.createdBy ? await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, k.createdBy)) : [];
    return c.json({ id: k.id, title: k.title, category: k.category, body: k.body, tags: k.tags, published: k.published, author: author?.name ?? null, mine: k.createdBy === a.user.id, createdAt: k.createdAt, updatedAt: k.updatedAt });
  })
  .post("/", requirePermission("kb.edit"), async (c) => {
    const a = auth(c);
    const p = await body(c, zCreate);
    const [row] = await db().insert(schema.kbArticles).values({ ...p, createdBy: a.user.id, updatedBy: a.user.id }).returning();
    await audit(a.user.id, "kb.created", row.id, { title: row.title, published: row.published });
    return c.json({ id: row.id }, 201);
  })
  .patch("/:id", requirePermission("kb.edit"), async (c) => {
    const a = auth(c);
    const k = await articleOr404(c, c.req.param("id"));
    mayChange(c, k);
    const p = await body(c, zChange);
    const [row] = await db()
      .update(schema.kbArticles)
      .set({ ...p, updatedBy: a.user.id, updatedAt: new Date() })
      .where(eq(schema.kbArticles.id, k.id))
      .returning();
    if (p.published !== undefined && p.published !== k.published) await audit(a.user.id, p.published ? "kb.published" : "kb.unpublished", k.id, { title: row.title });
    return c.json({ id: row.id });
  })
  .delete("/:id", requirePermission("kb.edit"), async (c) => {
    const a = auth(c);
    const k = await articleOr404(c, c.req.param("id"));
    mayChange(c, k);
    await db().delete(schema.kbArticles).where(eq(schema.kbArticles.id, k.id));
    await audit(a.user.id, "kb.deleted", k.id, { title: k.title });
    return c.json({ ok: true });
  });
