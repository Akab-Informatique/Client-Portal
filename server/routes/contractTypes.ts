import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { CONTRACT_KINDS, KIND_MODE, contractTypes } from "../lib/contracts.ts";

/**
 * Admin › Types de contrats (admin.billing): the kinds of contract a client can have. Each type has a name
 * and one of four ways to bill — recurring service, hourly, banked hours, fixed price — which sets how the
 * work done under it is billed (see lib/contracts.ts).
 */
const zName = z.string().trim().min(1).max(60);
const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "type";

export const contractTypeRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.billing"))

  /** Every type, in order, with the contracts that use it. */
  .get("/", async (c) => {
    const [list, contracts] = await Promise.all([contractTypes(), db().select({ typeKey: schema.clientContracts.typeKey }).from(schema.clientContracts)]);
    const used = new Map<string, number>();
    for (const k of contracts) if (k.typeKey) used.set(k.typeKey, (used.get(k.typeKey) ?? 0) + 1);
    return c.json(list.map((t) => ({ key: t.key, name: t.name, kind: t.kind, mode: KIND_MODE[t.kind as keyof typeof KIND_MODE], active: t.active, position: t.position, contracts: used.get(t.key) ?? 0 })));
  })

  .post("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ name: zName, kind: z.enum(CONTRACT_KINDS) }));
    const list = await contractTypes();
    let key = slug(p.name);
    for (let n = 2; list.some((t) => t.key === key); n++) key = `${slug(p.name)}-${n}`;
    await db().insert(schema.contractTypes).values({ key, name: p.name, kind: p.kind, position: list.length });
    await audit(a.user.id, "contract_type.created", key, { name: p.name, kind: p.kind });
    return c.json({ key }, 201);
  })

  /** Rename, turn on or off. The kind cannot change once contracts use the type. */
  .patch("/:key", async (c) => {
    const a = auth(c);
    const key = c.req.param("key");
    const p = await body(c, z.object({ name: zName.optional(), active: z.boolean().optional(), kind: z.enum(CONTRACT_KINDS).optional() }));
    const [cur] = await db().select().from(schema.contractTypes).where(eq(schema.contractTypes.key, key));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    if (p.kind && p.kind !== cur.kind) {
      const [use] = await db().select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(eq(schema.clientContracts.typeKey, key)).limit(1);
      if (use) throw new HTTPException(409, { message: "type_in_use" });
    }
    await db()
      .update(schema.contractTypes)
      .set({ ...(p.name ? { name: p.name } : {}), ...(p.active !== undefined ? { active: p.active } : {}), ...(p.kind ? { kind: p.kind } : {}), updatedAt: new Date() })
      .where(eq(schema.contractTypes.key, key));
    await audit(a.user.id, "contract_type.updated", key, p);
    return c.json({ ok: true });
  })

  .post("/:key/move", async (c) => {
    const key = c.req.param("key");
    const p = await body(c, z.object({ direction: z.enum(["up", "down"]) }));
    const list = await contractTypes();
    const i = list.findIndex((t) => t.key === key);
    if (i < 0) throw new HTTPException(404, { message: "not_found" });
    const j = p.direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return c.json({ ok: true });
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    await db().transaction(async (tx) => {
      for (const [position, t] of next.entries()) await tx.update(schema.contractTypes).set({ position }).where(eq(schema.contractTypes.key, t.key));
    });
    return c.json({ ok: true });
  })

  /** Only a type no contract uses can go. */
  .delete("/:key", async (c) => {
    const a = auth(c);
    const key = c.req.param("key");
    const [cur] = await db().select().from(schema.contractTypes).where(eq(schema.contractTypes.key, key));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const [use] = await db().select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(eq(schema.clientContracts.typeKey, key)).limit(1);
    if (use) throw new HTTPException(409, { message: "type_in_use" });
    await db().delete(schema.contractTypes).where(eq(schema.contractTypes.key, key));
    await audit(a.user.id, "contract_type.deleted", key, { name: cur.name });
    return c.json({ ok: true });
  });
