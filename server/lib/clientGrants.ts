import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * Client users may enter other companies of their chain (the ancestors and the descendants of their home
 * company, through clients.parent_id) with a role of that company, granted in client_user_grants. Siblings and
 * unrelated companies are never in the chain. The home company and role stay on the user row.
 */

const MAX_DEPTH = 20;

export type ChainLink = {
  id: string;
  relation: "parent" | "grandparent" | "ancestor" | "child" | "grandchild" | "descendant";
};

/** The ancestors and descendants of a company (the company itself and its siblings are not in it). */
export async function chainOf(homeClientId: string): Promise<ChainLink[]> {
  const d = db();
  const out: ChainLink[] = [];
  const seen = new Set<string>([homeClientId]);

  let cur = [homeClientId];
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const rows = await d.select({ parentId: schema.clients.parentId }).from(schema.clients).where(inArray(schema.clients.id, cur));
    const next = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => Boolean(x) && !seen.has(x as string)))];
    if (!next.length) break;
    for (const id of next) {
      seen.add(id);
      out.push({ id, relation: depth === 1 ? "parent" : depth === 2 ? "grandparent" : "ancestor" });
    }
    cur = next;
  }

  cur = [homeClientId];
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const rows = await d.select({ id: schema.clients.id }).from(schema.clients).where(inArray(schema.clients.parentId, cur));
    const next = [...new Set(rows.map((r) => r.id).filter((x) => !seen.has(x)))];
    if (!next.length) break;
    for (const id of next) {
      seen.add(id);
      out.push({ id, relation: depth === 1 ? "child" : depth === 2 ? "grandchild" : "descendant" });
    }
    cur = next;
  }
  return out;
}

/** The grants of a user, with the company and role names. */
export async function grantsOf(userId: string) {
  return db()
    .select({
      clientId: schema.clientUserGrants.clientId,
      clientName: schema.clients.name,
      roleId: schema.roles.id,
      roleName: schema.roles.name,
    })
    .from(schema.clientUserGrants)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientUserGrants.clientId))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.clientUserGrants.roleId))
    .where(eq(schema.clientUserGrants.userId, userId))
    .orderBy(asc(schema.clients.name));
}

/**
 * The grant that lets a client user enter `target` now: in their chain, the company active and its portal open,
 * the granted role still a role of that company (audience client). Null when any of that fails.
 */
export async function usableGrant(user: { id: string; kind: string; clientId: string | null }, target: string): Promise<{ roleId: string; clientName: string } | null> {
  if (user.kind !== "client" || !user.clientId || target === user.clientId) return null;
  const d = db();
  const [grant] = await d
    .select()
    .from(schema.clientUserGrants)
    .where(and(eq(schema.clientUserGrants.userId, user.id), eq(schema.clientUserGrants.clientId, target)));
  if (!grant) return null;
  const chain = await chainOf(user.clientId);
  if (!chain.some((x) => x.id === target)) return null;
  const [company] = await d.select({ name: schema.clients.name, active: schema.clients.active, portal: schema.clients.portalEnabled }).from(schema.clients).where(eq(schema.clients.id, target));
  if (!company?.active || !company.portal) return null;
  const [role] = await d.select({ id: schema.roles.id, audience: schema.roles.audience, clientId: schema.roles.clientId }).from(schema.roles).where(eq(schema.roles.id, grant.roleId));
  if (!role || role.audience !== "client" || role.clientId !== target) return null;
  return { roleId: role.id, clientName: company.name };
}

/** May this client user work in `target` now? Their home company always; another one through a usable grant. */
export async function canEnter(user: { id: string; kind: string; clientId: string | null }, target: string): Promise<boolean> {
  if (user.kind === "client" && user.clientId && target === user.clientId) return true;
  return (await usableGrant(user, target)) !== null;
}

export type CompanyChoice = { id: string; name: string; parentName: string | null; home: boolean; roleName: string };

/** The companies this client user may enter, home first, then the usable grants by name. */
export async function companiesOf(user: { id: string; kind: string; clientId: string | null; roleId: string | null }): Promise<CompanyChoice[]> {
  if (user.kind !== "client" || !user.clientId) return [];
  const d = db();
  const [home] = await d.select({ name: schema.clients.name, parentId: schema.clients.parentId }).from(schema.clients).where(eq(schema.clients.id, user.clientId));
  const [homeRole] = user.roleId ? await d.select({ name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.id, user.roleId)) : [];
  if (!home) return [];
  const grants = await grantsOf(user.id);
  const usable: { id: string; name: string; parentId: string | null; roleName: string }[] = [];
  for (const g of grants) {
    if (!(await usableGrant(user, g.clientId))) continue;
    const [row] = await d.select({ parentId: schema.clients.parentId }).from(schema.clients).where(eq(schema.clients.id, g.clientId));
    usable.push({ id: g.clientId, name: g.clientName, parentId: row?.parentId ?? null, roleName: g.roleName });
  }
  const parentIds = [...new Set([home.parentId, ...usable.map((u) => u.parentId)].filter((x): x is string => Boolean(x)))];
  const parents = parentIds.length ? await d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, parentIds)) : [];
  const parentName = (id: string | null) => (id ? parents.find((p) => p.id === id)?.name ?? null : null);
  return [
    { id: user.clientId, name: home.name, parentName: parentName(home.parentId), home: true, roleName: homeRole?.name ?? "" },
    ...usable.map((u) => ({ id: u.id, name: u.name, parentName: parentName(u.parentId), home: false, roleName: u.roleName })),
  ];
}
