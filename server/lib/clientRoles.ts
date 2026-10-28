import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { SYSTEM_ROLES } from "../../shared/permissions.ts";

/**
 * Client roles belong to one client. Each client has its own copy of the
 * built-in client roles (same slug: client-admin, client-user…) and its own
 * custom ones, so what "client administrator" allows at one client says nothing
 * of another. The built-in definitions in `shared/permissions.ts` are only the
 * starting point of a copy.
 */
export const CLIENT_TEMPLATES = SYSTEM_ROLES.filter((r) => r.audience === "client");
type Role = typeof schema.roles.$inferSelect;

/**
 * The client's built-in roles exist (made from the starting point, or from what
 * the old shared role allowed so nothing is lost), and a right added to a
 * default since is given once — one an admin took away is not given back.
 */
export async function ensureClientRoles(clientId: string, legacy?: Map<string, Role>): Promise<void> {
  const d = db();
  const mine = await d.select().from(schema.roles).where(eq(schema.roles.clientId, clientId));
  const bySlug = new Map(mine.filter((r) => r.slug).map((r) => [r.slug!, r]));
  for (const tpl of CLIENT_TEMPLATES) {
    const have = bySlug.get(tpl.slug);
    if (!have) {
      const old = legacy?.get(tpl.slug);
      await d
        .insert(schema.roles)
        .values({
          slug: tpl.slug,
          audience: "client",
          clientId,
          name: tpl.name.fr,
          description: tpl.description.fr,
          permissions: old?.permissions ?? tpl.permissions,
          defaultsApplied: tpl.permissions,
          isSystem: true,
          locked: false,
        })
        .onConflictDoNothing();
      continue;
    }
    const applied = new Set(have.defaultsApplied ?? []);
    const added = tpl.permissions.filter((p) => !applied.has(p) && !have.permissions.includes(p));
    if (added.length || !have.defaultsApplied) {
      await d
        .update(schema.roles)
        .set({ permissions: [...have.permissions, ...added], defaultsApplied: tpl.permissions, updatedAt: new Date() })
        .where(eq(schema.roles.id, have.id));
    }
  }
}

/** The id of a client's built-in role (made when missing). */
export async function clientRoleId(clientId: string, slug = "client-user"): Promise<string | null> {
  const find = async () => (await db().select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.clientId, clientId), eq(schema.roles.slug, slug))))[0]?.id ?? null;
  return (await find()) ?? (await ensureClientRoles(clientId).then(find));
}

/**
 * Startup: every client has its roles, and the users who still hold an old
 * shared client role (before roles were per client) move to their own client's
 * copy — a custom shared role is copied into each client that used it. The old
 * shared roles are then removed.
 */
export async function ensureAllClientRoles(): Promise<void> {
  const d = db();
  const legacy = await d.select().from(schema.roles).where(and(eq(schema.roles.audience, "client"), isNull(schema.roles.clientId)));
  const legacyBySlug = new Map(legacy.filter((r) => r.slug).map((r) => [r.slug!, r]));
  for (const c of await d.select({ id: schema.clients.id }).from(schema.clients)) await ensureClientRoles(c.id, legacyBySlug);
  if (!legacy.length) return;

  for (const old of legacy) {
    const users = await d.select({ id: schema.users.id, clientId: schema.users.clientId }).from(schema.users).where(eq(schema.users.roleId, old.id));
    const byClient = new Map<string, string[]>();
    for (const u of users) if (u.clientId) byClient.set(u.clientId, [...(byClient.get(u.clientId) ?? []), u.id]);
    for (const [clientId, ids] of byClient) {
      let target = old.slug
        ? (await d.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.clientId, clientId), eq(schema.roles.slug, old.slug))))[0]?.id
        : (await d.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.clientId, clientId), eq(schema.roles.name, old.name))))[0]?.id;
      if (!target) {
        [{ id: target }] = await d
          .insert(schema.roles)
          .values({ slug: old.slug, audience: "client", clientId, name: old.name, description: old.description, permissions: old.permissions, isSystem: Boolean(old.slug), defaultsApplied: old.defaultsApplied })
          .returning({ id: schema.roles.id });
      }
      await d.update(schema.users).set({ roleId: target }).where(inArray(schema.users.id, ids));
    }
  }
  // the shared client roles nobody holds any more
  await d.delete(schema.roles).where(and(eq(schema.roles.audience, "client"), isNull(schema.roles.clientId), notExists(d.select({ one: sql`1` }).from(schema.users).where(eq(schema.users.roleId, schema.roles.id)))));
}
