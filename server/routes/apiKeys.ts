import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, permissionsOf, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { keyAllowed, newKey } from "../lib/apiKeys.ts";

/**
 * Admin › Intégrations › Clés d'API (admin.integrations, master administrators). A key lets an outside tool
 * (an AI assistant…) read, and optionally write, the portal as the person who made it, with only the rights
 * ticked here. Shown once; only its hash is kept. A key cannot manage keys, sign in, reach /api/admin, HR,
 * mailboxes, chats or the vault (see lib/apiKeys.ts).
 */
const zCreate = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string()).min(1).max(200),
  write: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
});

export const apiKeyRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.integrations"))

  .get("/", async (c) => {
    const a = auth(c);
    const rows = await db().select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt));
    return c.json(
      rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, permissions: r.permissions, write: r.write, expiresAt: r.expiresAt, lastUsedAt: r.lastUsedAt, lastIp: r.lastIp, revokedAt: r.revokedAt, createdAt: r.createdAt, mine: r.userId === a.user.id })),
    );
  })

  /** The rights a new key may carry: the maker's own, minus what a key can never have */
  .get("/rights", (c) => c.json(auth(c).permissions.filter(keyAllowed)))

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, zCreate);
    const mine = new Set<string>(a.permissions);
    const bad = p.permissions.filter((x) => !keyAllowed(x) || !mine.has(x));
    if (bad.length) throw new HTTPException(400, { message: "right_not_allowed" });
    const { key, hash, prefix } = newKey();
    const [row] = await db()
      .insert(schema.apiKeys)
      .values({ name: p.name, prefix, keyHash: hash, userId: a.user.id, permissions: [...new Set(p.permissions)], write: p.write, expiresAt: p.expiresInDays ? new Date(Date.now() + p.expiresInDays * 86400_000) : null })
      .returning();
    await audit(a.user.id, "api_key.created", row.id, { name: p.name, write: p.write, rights: row.permissions.length });
    return c.json({ id: row.id, name: row.name, prefix, key }, 201);
  })

  /** Change a key that already exists (its rights, write switch, name) without making a new one: the key itself stays the same */
  .patch("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const p = await body(c, zCreate.partial().omit({ expiresInDays: true }));
    const [key] = await db().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    if (!key || key.revokedAt) throw new HTTPException(404, { message: "not_found" });
    const patch: Partial<typeof schema.apiKeys.$inferInsert> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.write !== undefined) patch.write = p.write;
    if (p.permissions !== undefined) {
      // never more than the person the key acts as holds today, and never what a key can not carry
      const [owner] = await db().select().from(schema.users).where(eq(schema.users.id, key.userId));
      const held = new Set<string>(owner ? await permissionsOf(owner) : []);
      if (p.permissions.some((x) => !keyAllowed(x) || !held.has(x))) throw new HTTPException(400, { message: "right_not_allowed" });
      patch.permissions = [...new Set(p.permissions)];
    }
    if (!Object.keys(patch).length) return c.json({ ok: true });
    await db().update(schema.apiKeys).set(patch).where(eq(schema.apiKeys.id, id));
    await audit(a.user.id, "api_key.updated", id, { name: patch.name ?? key.name, write: patch.write ?? key.write, rights: (patch.permissions ?? key.permissions).length });
    return c.json({ ok: true });
  })

  .delete("/:id", async (c) => {
    const a = auth(c);
    const id = zUuid.parse(c.req.param("id"));
    const [row] = await db().update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id)).returning({ name: schema.apiKeys.name });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "api_key.revoked", id, { name: row.name });
    return c.json({ ok: true });
  });
