import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionUser } from "@/lib/types";
import {
  hasPermission,
  type PermissionMap,
  type StaffPermission,
} from "@/lib/permissions";

export type MfaPendingKind = "challenge" | "enroll";

export type MfaPending = {
  kind: MfaPendingKind;
  email: string;
  name: string;
};

export type LoginResult =
  | { ok: true; needsMfa: false }
  | { ok: true; needsMfa: true; kind: MfaPendingKind }
  | { ok: false; error: "invalid" | "deactivated" };

export type MfaVerifyResult =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_code" | "expired" | "no_pending" | "smtp" | "generic";
      message?: string;
    };

export type MfaEnrollStart = {
  secret: string;
  otpauthUrl: string;
  qrUrl: string;
};

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  patchSession: (patch: Partial<SessionUser>) => void;
  can: (permission: StaffPermission) => boolean;
  permissions: PermissionMap | null;
  mfaPending: MfaPending | null;
  clearMfaPending: () => void;
  verifyMfaTotp: (code: string) => Promise<MfaVerifyResult>;
  verifyMfaRecovery: (code: string) => Promise<MfaVerifyResult>;
  sendMfaEmailCode: () => Promise<MfaVerifyResult>;
  verifyMfaEmailCode: (code: string) => Promise<MfaVerifyResult>;
  startMfaEnroll: () => Promise<MfaEnrollStart | { ok: false; error: string }>;
  confirmMfaEnroll: (
    code: string,
  ) => Promise<
    | { ok: true; recoveryCodes: string[] }
    | { ok: false; error: "invalid_code" | "no_pending" | "generic" }
  >;
  disableMfa: (
    code: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  regenerateRecoveryCodes: (
    totpCode: string,
  ) => Promise<
    | { ok: true; recoveryCodes: string[] }
    | { ok: false; error: string }
  >;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function apiJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; data: T }> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { res, data };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);

  const refreshUser = useCallback(async () => {
    const { data } = await apiJson<{
      ok?: boolean;
      user?: SessionUser | null;
      mfaPending?: MfaPending | null;
    }>("/api/auth/me");
    if (data.user) {
      setUser(data.user);
      setMfaPending(null);
    } else {
      setUser(null);
      setMfaPending(data.mfaPending ?? null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Clear legacy forged client sessions (no longer trusted)
        try {
          localStorage.removeItem("soluti-portal-session");
          sessionStorage.removeItem("soluti-portal-mfa-pending");
        } catch {
          /* ignore */
        }
        const { data } = await apiJson<{
          user?: SessionUser | null;
          mfaPending?: MfaPending | null;
        }>("/api/auth/me");
        if (cancelled) return;
        if (data.user) {
          setUser(data.user);
          setMfaPending(null);
        } else {
          setUser(null);
          setMfaPending(data.mfaPending ?? null);
        }
      } catch {
        if (!cancelled) {
          setUser(null);
          setMfaPending(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearMfaPending = useCallback(() => {
    setMfaPending(null);
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser(null);
    const { res, data } = await apiJson<{
      ok?: boolean;
      needsMfa?: boolean;
      kind?: MfaPendingKind;
      error?: string;
      email?: string;
      name?: string;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok || !data.ok) {
      if (data.error === "deactivated") {
        return { ok: false as const, error: "deactivated" as const };
      }
      return { ok: false as const, error: "invalid" as const };
    }
    const kind: MfaPendingKind = data.kind === "enroll" ? "enroll" : "challenge";
    setMfaPending({
      kind,
      email: data.email || email,
      name: data.name || "",
    });
    return { ok: true as const, needsMfa: true as const, kind };
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setMfaPending(null);
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    try {
      localStorage.removeItem("soluti-portal-session");
      sessionStorage.removeItem("soluti-portal-mfa-pending");
    } catch {
      /* ignore */
    }
  }, []);

  const patchSession = useCallback((patch: Partial<SessionUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const mfaAction = useCallback(async (action: string, code?: string) => {
    return apiJson<{
      ok?: boolean;
      error?: string;
      message?: string;
      user?: SessionUser;
      recoveryCodes?: string[];
      secret?: string;
      otpauthUrl?: string;
      qrUrl?: string;
      mfaPending?: MfaPending;
    }>("/api/auth/mfa", {
      method: "POST",
      body: JSON.stringify({ action, code }),
    });
  }, []);

  const verifyMfaTotp = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const { data } = await mfaAction("verify_totp", code);
      if (data.ok && data.user) {
        setUser(data.user);
        setMfaPending(null);
        return { ok: true };
      }
      const err = data.error;
      if (
        err === "no_pending" ||
        err === "invalid_code" ||
        err === "expired" ||
        err === "smtp" ||
        err === "generic"
      ) {
        return { ok: false, error: err };
      }
      return { ok: false, error: "invalid_code" };
    },
    [mfaAction],
  );

  const verifyMfaRecovery = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const { data } = await mfaAction("verify_recovery", code);
      if (data.ok && data.user) {
        setUser(data.user);
        setMfaPending(null);
        return { ok: true };
      }
      const err = data.error;
      if (
        err === "no_pending" ||
        err === "invalid_code" ||
        err === "expired" ||
        err === "smtp" ||
        err === "generic"
      ) {
        return { ok: false, error: err };
      }
      return { ok: false, error: "invalid_code" };
    },
    [mfaAction],
  );

  const sendMfaEmailCode = useCallback(async (): Promise<MfaVerifyResult> => {
    const { data } = await mfaAction("send_email");
    if (data.ok) return { ok: true };
    return {
      ok: false,
      error: data.error === "smtp" ? "smtp" : "smtp",
      message: data.message,
    };
  }, [mfaAction]);

  const verifyMfaEmailCode = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const { data } = await mfaAction("verify_email", code);
      if (data.ok && data.user) {
        setUser(data.user);
        setMfaPending(null);
        return { ok: true };
      }
      return {
        ok: false,
        error: (data.error as "invalid_code" | "expired") || "invalid_code",
      };
    },
    [mfaAction],
  );

  const startMfaEnroll = useCallback(async () => {
    const { data } = await mfaAction("start_enroll");
    if (data.ok && data.secret && data.otpauthUrl && data.qrUrl) {
      setMfaPending((prev) =>
        prev
          ? { ...prev, kind: "enroll" }
          : {
              kind: "enroll",
              email: user?.email || "",
              name: user?.name || "",
            },
      );
      return {
        secret: data.secret,
        otpauthUrl: data.otpauthUrl,
        qrUrl: data.qrUrl,
      };
    }
    return { ok: false as const, error: data.error || "no_pending" };
  }, [mfaAction, user?.email, user?.name]);

  const confirmMfaEnroll = useCallback(
    async (code: string) => {
      const { data } = await mfaAction("confirm_enroll", code);
      if (data.ok && data.user && data.recoveryCodes) {
        setUser(data.user);
        setMfaPending(null);
        return { ok: true as const, recoveryCodes: data.recoveryCodes };
      }
      return {
        ok: false as const,
        error: (data.error as "invalid_code" | "no_pending" | "generic") ||
          "generic",
      };
    },
    [mfaAction],
  );

  const disableMfa = useCallback(
    async (code: string) => {
      const { data } = await mfaAction("disable", code);
      if (data.ok) {
        setUser(null);
        setMfaPending(
          data.mfaPending ?? {
            kind: "enroll",
            email: user?.email || "",
            name: user?.name || "",
          },
        );
        return { ok: true as const };
      }
      return { ok: false as const, error: data.error || "generic" };
    },
    [mfaAction, user?.email, user?.name],
  );

  const regenerateRecoveryCodes = useCallback(
    async (totpCode: string) => {
      const { data } = await mfaAction("regenerate_recovery", totpCode);
      if (data.ok && data.recoveryCodes) {
        return { ok: true as const, recoveryCodes: data.recoveryCodes };
      }
      return { ok: false as const, error: data.error || "generic" };
    },
    [mfaAction],
  );

  const can = useCallback(
    (permission: StaffPermission) => {
      if (!user || user.role === "client") return false;
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
      mfaPending,
      clearMfaPending,
      verifyMfaTotp,
      verifyMfaRecovery,
      sendMfaEmailCode,
      verifyMfaEmailCode,
      startMfaEnroll,
      confirmMfaEnroll,
      disableMfa,
      regenerateRecoveryCodes,
    }),
    [
      user,
      loading,
      login,
      logout,
      refreshUser,
      patchSession,
      can,
      mfaPending,
      clearMfaPending,
      verifyMfaTotp,
      verifyMfaRecovery,
      sendMfaEmailCode,
      verifyMfaEmailCode,
      startMfaEnroll,
      confirmMfaEnroll,
      disableMfa,
      regenerateRecoveryCodes,
    ],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
