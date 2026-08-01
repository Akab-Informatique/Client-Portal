import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import type { SessionUser, UserRole } from "@/lib/types";
import {
  hasPermission,
  type PermissionMap,
  type StaffPermission,
} from "@/lib/permissions";
import { resolvePermissionsForUser } from "@/lib/roles";

const SESSION_KEY = "soluti-portal-session";

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  /** Update the in-memory session after a self-profile edit */
  patchSession: (patch: Partial<SessionUser>) => void;
  /** Check a staff section permission (clients always false). */
  can: (permission: StaffPermission) => boolean;
  permissions: PermissionMap | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function toSessionUser(row: {
  id: number;
  email: string;
  name: string;
  role: string;
  company_id: number | null;
  active: boolean;
  staff_role_id?: number | null;
  job_title?: string | null;
  phone?: string | null;
  mobile?: string | null;
  bio?: string | null;
  locale?: string | null;
  itglue_user_id?: string | null;
  board_email_opt_in?: boolean | null;
  created_at: Date | string;
}): Promise<SessionUser> {
  const resolved = await resolvePermissionsForUser({
    role: row.role,
    staff_role_id: row.staff_role_id ?? null,
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    company_id: row.company_id,
    active: row.active,
    staff_role_id: row.staff_role_id ?? null,
    job_title: row.job_title ?? null,
    phone: row.phone ?? null,
    mobile: row.mobile ?? null,
    bio: row.bio ?? null,
    locale: row.locale ?? null,
    itglue_user_id: row.itglue_user_id ?? null,
    board_email_opt_in:
      row.board_email_opt_in === false ? false : true,
    created_at: row.created_at,
    permissions: resolved.permissions,
    staff_role_name: resolved.staff_role_name,
    staff_role_slug: resolved.staff_role_slug,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await dbReady;
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { id?: number };
        if (!parsed?.id) return;
        const rows = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, parsed.id))
          .limit(1);
        const found = rows[0];
        if (!cancelled && found && found.active) {
          setUser(await toSessionUser(found));
        } else if (!cancelled) {
          localStorage.removeItem(SESSION_KEY);
        }
      } catch {
        localStorage.removeItem(SESSION_KEY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await dbReady;
    const normalized = email.trim().toLowerCase();
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalized))
      .limit(1);
    const found = rows[0];
    if (!found || found.password !== password) {
      return { ok: false as const, error: "invalid" };
    }
    if (!found.active) {
      return { ok: false as const, error: "deactivated" };
    }
    const session = await toSessionUser(found);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: session.id }));
    setUser(session);
    return { ok: true as const };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!user) return;
    await dbReady;
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);
    const found = rows[0];
    if (found && found.active) {
      setUser(await toSessionUser(found));
    } else {
      logout();
    }
  }, [user, logout]);

  const patchSession = useCallback((patch: Partial<SessionUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const can = useCallback(
    (permission: StaffPermission) => {
      if (!user || user.role === "client") return false;
      // Super-fallback: portal admin without permissions object
      if (user.role === "admin" && !user.permissions) return true;
      return hasPermission(user.permissions, permission);
    },
    [user],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      patchSession,
      can,
      permissions: user?.permissions ?? null,
    }),
    [user, loading, login, logout, refreshUser, patchSession, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Convenience hook for permission checks. */
export function useCan() {
  const { can, permissions, user } = useAuth();
  return { can, permissions, user };
}
