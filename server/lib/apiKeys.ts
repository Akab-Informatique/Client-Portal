import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { clientIp, rateLimit } from "./http.ts";
import { accountUsable, permissionsOf, type AppEnv, type AuthContext } from "./auth.ts";
import { isPermissionKey, type PermissionKey } from "../../shared/permissions.ts";

export const KEY_PREFIX = "akab_";

/** Rights an API key can never carry, whoever made it: administration, HR, mailboxes, chats, the vault. */
const FORBIDDEN = /^(admin\.|hr\.|passbolt\.|outlook\.|chat\.|clientview\.|timesheets\.manage$|crm\.delete$|tickets\.delete$)/;
export const keyAllowed = (p: string): p is PermissionKey => isPermissionKey(p) && !FORBIDDEN.test(p);

/** Parts of the API a key never reaches (sign-in, security, the person's own account, integrations' secrets). */
const BLOCKED_PATHS = ["/api/auth", "/api/admin", "/api/microsoft", "/api/passbolt", "/api/outlook", "/api/chat", "/api/view-as", "/api/pay"];
const blocked = (path: string, method: string) =>
  BLOCKED_PATHS.some((p) => path === p || path.startsWith(p + "/")) || (path.startsWith("/api/me") && !(method === "GET" && path === "/api/me"));

export function newKey() {
  const key = KEY_PREFIX + randomToken(32);
  return { key, hash: sha256(key), prefix: key.slice(0, 11) };
}

/**
 * Bearer authentication: `Authorization: Bearer akab_…`. Returns the identity for loadAuth, or null when the
 * request has no key. A bad / revoked / expired key is a 401 (never a silent fall back to anonymous).
 */
export async function authFromKey(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<AuthContext | null> {
  const h = c.req.header("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token.startsWith(KEY_PREFIX)) return null;
  const bad = () => new HTTPException(401, { message: "invalid_api_key" });
  const [row] = await db()
    .select({ key: schema.apiKeys, user: schema.users })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
    .where(and(eq(schema.apiKeys.keyHash, sha256(token)), isNull(schema.apiKeys.revokedAt)));
  if (!row || (row.key.expiresAt && row.key.expiresAt.getTime() < Date.now())) throw bad();
  if (row.user.kind !== "staff" || !(await accountUsable(row.user))) throw bad();
  const rl = rateLimit(`apikey:${row.key.id}`, 120, 60_000);
  if (!rl.ok) throw new HTTPException(429, { message: "rate_limited" });
  const method = c.req.method;
  if (blocked(c.req.path, method)) throw new HTTPException(403, { message: "api_key_forbidden_path" });
  if (method !== "GET" && method !== "HEAD" && !row.key.write) throw new HTTPException(403, { message: "api_key_read_only" });
  // the key's rights, never more than the person has today
  const mine = new Set<string>(await permissionsOf(row.user));
  const permissions = row.key.permissions.filter((p) => keyAllowed(p) && mine.has(p)) as PermissionKey[];
  const now = new Date();
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > 60_000) {
    await db().update(schema.apiKeys).set({ lastUsedAt: now, lastIp: clientIp(c) }).where(eq(schema.apiKeys.id, row.key.id));
  }
  return { user: row.user, realUser: row.user, sessionId: `key:${row.key.id}`, mfaVerified: true, permissions, isAdmin: false, viewAs: null };
}
