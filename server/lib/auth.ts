import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { clientIp } from "./http.ts";
import {
  effectivePermissions,
  isAdmin,
  isPermissionKey,
  permissionsFor,
  type Override,
  type PermissionKey,
} from "../../shared/permissions.ts";

export const SESSION_COOKIE = "akab_session";
const SESSION_HOURS = 12;
const IDLE_HOURS = 4;

export type User = typeof schema.users.$inferSelect;

export type AuthContext = {
  /** Effective identity. During "view as client" this is a read-only client identity. */
  user: User;
  /** The person actually signed in (same as user unless viewing as a client). */
  realUser: User;
  sessionId: string;
  mfaVerified: boolean;
  permissions: PermissionKey[];
  isAdmin: boolean;
  /** Set while a technician views the portal as a client (read only). */
  viewAs: { clientId: string; clientName: string } | null;
};

export type AppEnv = { Variables: { auth: AuthContext | null } };

export async function permissionsOf(user: User): Promise<PermissionKey[]> {
  const d = db();
  let rolePerms: string[] = [];
  if (user.roleId) {
    const [role] = await d.select().from(schema.roles).where(eq(schema.roles.id, user.roleId));
    if (role && role.audience === user.kind) rolePerms = role.permissions ?? [];
  }
  const rows = await d.select().from(schema.userPermissions).where(eq(schema.userPermissions.userId, user.id));
  const overrides: Override[] = rows
    .filter((r) => isPermissionKey(r.permission))
    .map((r) => ({ key: r.permission as PermissionKey, effect: r.effect }));
  return effectivePermissions(user.kind, rolePerms, overrides);
}

export async function createSession(c: Context, userId: string, mfaVerified: boolean): Promise<void> {
  const token = randomToken();
  await db()
    .insert(schema.sessions)
    .values({
      id: sha256(token),
      userId,
      mfaVerified,
      ip: clientIp(c),
      userAgent: (c.req.header("user-agent") || "").slice(0, 300),
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000),
    });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function destroySession(c: Context, opts: { keepCookie?: boolean } = {}): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db().delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  if (!opts.keepCookie) deleteCookie(c, SESSION_COOKIE, { path: "/", secure: config.cookieSecure });
}

/** Revoke every session of a user (password change, deactivation, MFA reset). */
export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  const all = await db().select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, userId));
  for (const s of all) {
    if (s.id !== exceptSessionId) await db().delete(schema.sessions).where(eq(schema.sessions.id, s.id));
  }
}

export async function markSessionMfaVerified(sessionId: string): Promise<void> {
  await db().update(schema.sessions).set({ mfaVerified: true }).where(eq(schema.sessions.id, sessionId));
}

/** Loads the session (if any) into c.var.auth. Never throws for anonymous requests. */
export const loadAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("auth", null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const id = sha256(token);
    const now = new Date();
    const [row] = await db()
      .select({ session: schema.sessions, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)));
    const idle = row && now.getTime() - row.session.lastSeenAt.getTime() > IDLE_HOURS * 3600_000;
    if (row && row.user.active && !idle && (await accountUsable(row.user))) {
      const permissions = await permissionsOf(row.user);
      const base: AuthContext = {
        user: row.user,
        realUser: row.user,
        sessionId: id,
        mfaVerified: row.session.mfaVerified,
        permissions,
        isAdmin: row.user.kind === "staff" && isAdmin(permissions),
        viewAs: null,
      };
      c.set("auth", await applyViewAs(base, row.session.viewAsClientId));
      if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
        await db().update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id));
      }
    } else if (row) {
      await db().delete(schema.sessions).where(eq(schema.sessions.id, id));
    }
  }
  await next();
};

/** An active account — and, for a client user, an active client (a client turned off closes its users' access). */
export async function accountUsable(u: { active: boolean; kind: string; clientId: string | null }) {
  if (!u.active) return false;
  if (u.kind !== "client") return true;
  if (!u.clientId) return false;
  const [cl] = await db().select({ active: schema.clients.active }).from(schema.clients).where(eq(schema.clients.id, u.clientId));
  return Boolean(cl?.active);
}

/**
 * "View as client": a technician holding clientview.use sees the portal as the
 * chosen client — client identity with every client right — and the request
 * is read-only (see readOnlyViewAs). Re-checked on every request: losing the
 * right or the client becoming inactive ends the client view.
 */
async function applyViewAs(a: AuthContext, clientId: string | null): Promise<AuthContext> {
  if (!clientId) return a;
  const allowed = a.realUser.kind === "staff" && a.permissions.includes("clientview.use");
  const [client] = allowed ? await db().select().from(schema.clients).where(eq(schema.clients.id, clientId)) : [];
  if (!client || !client.active) {
    await db().update(schema.sessions).set({ viewAsClientId: null }).where(eq(schema.sessions.id, a.sessionId));
    return a;
  }
  return {
    ...a,
    user: { ...a.realUser, kind: "client", clientId: client.id, roleId: null },
    permissions: permissionsFor("client"),
    isAdmin: false,
    viewAs: { clientId: client.id, clientName: client.name },
  };
}

/** Client view is read-only: only leaving it and signing out are allowed. */
export const readOnlyViewAs: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = c.var.auth;
  const m = c.req.method;
  if (a?.viewAs && m !== "GET" && m !== "HEAD") {
    const p = c.req.path;
    if (!p.startsWith("/api/view-as") && p !== "/api/auth/logout") {
      throw new HTTPException(403, { message: "read_only_view" });
    }
  }
  await next();
};

/** Fully signed-in: session valid, MFA done (when required), password not pending. */
export function isFullySignedIn(a: AuthContext | null): a is AuthContext {
  if (!a) return false;
  if (a.user.mustChangePassword) return false;
  if (config.requireMfa && !a.mfaVerified) return false;
  return true;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isFullySignedIn(c.var.auth)) throw new HTTPException(401, { message: "Authentication required" });
  await next();
};

export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = c.var.auth;
  if (!isFullySignedIn(a)) throw new HTTPException(401, { message: "Authentication required" });
  if (a.user.kind !== "staff") throw new HTTPException(403, { message: "Forbidden" });
  await next();
};

export function requirePermission(...keys: PermissionKey[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = c.var.auth;
    if (!isFullySignedIn(a)) throw new HTTPException(401, { message: "Authentication required" });
    if (!keys.some((k) => a.permissions.includes(k))) throw new HTTPException(403, { message: "Forbidden" });
    await next();
  };
}

export function auth(c: Context<AppEnv>): AuthContext {
  const a = c.var.auth;
  if (!a) throw new HTTPException(401, { message: "Authentication required" });
  return a;
}

export async function purgeExpiredSessions(): Promise<void> {
  await db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}
