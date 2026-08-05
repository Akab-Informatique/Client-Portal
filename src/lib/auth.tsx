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
import type { SessionUser, User, UserRole } from "@/lib/types";
import {
  hasPermission,
  type PermissionMap,
  type StaffPermission,
} from "@/lib/permissions";
import { resolvePermissionsForUser } from "@/lib/roles";
import { resolveClientAccessForUser } from "@/lib/client-roles";
import {
  buildOtpAuthUri,
  consumeRecoveryCode,
  createPendingToken,
  emailOtpExpiryIso,
  generateEmailOtp,
  generateRecoveryCodes,
  generateTotpSecret,
  hashEmailOtp,
  hashRecoveryCodes,
  isEmailOtpExpired,
  isMfaEnabled,
  totpQrImageUrl,
  verifyTotp,
} from "@/lib/mfa";

const SESSION_KEY = "soluti-portal-session";
const MFA_PENDING_KEY = "soluti-portal-mfa-pending";

export type MfaPendingKind = "challenge" | "enroll";

export type MfaPending = {
  token: string;
  userId: number;
  email: string;
  name: string;
  kind: MfaPendingKind;
  /** Present only during enroll before confirm */
  setupSecret?: string;
  createdAt: number;
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
  /** Password step — may require MFA challenge or enrollment next. */
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  patchSession: (patch: Partial<SessionUser>) => void;
  can: (permission: StaffPermission) => boolean;
  permissions: PermissionMap | null;
  /** In-progress MFA after password (challenge or forced enroll). */
  mfaPending: MfaPending | null;
  clearMfaPending: () => void;
  verifyMfaTotp: (code: string) => Promise<MfaVerifyResult>;
  verifyMfaRecovery: (code: string) => Promise<MfaVerifyResult>;
  sendMfaEmailCode: () => Promise<MfaVerifyResult>;
  verifyMfaEmailCode: (code: string) => Promise<MfaVerifyResult>;
  /** Begin / refresh authenticator enrollment (pending or logged-in without MFA). */
  startMfaEnroll: () => Promise<MfaEnrollStart | { ok: false; error: string }>;
  confirmMfaEnroll: (
    code: string,
  ) => Promise<
    | { ok: true; recoveryCodes: string[] }
    | { ok: false; error: "invalid_code" | "no_pending" | "generic" }
  >;
  /** Disable MFA (requires current TOTP or recovery). Logged-in only. */
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

type UserRow = User & {
  mfa_enabled?: boolean | null;
  mfa_totp_secret?: string | null;
  mfa_recovery_codes?: string | null;
  mfa_email_code_hash?: string | null;
  mfa_email_code_expires?: string | null;
};

async function loadUserById(id: number): Promise<UserRow | null> {
  await dbReady;
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

async function toSessionUser(row: UserRow): Promise<SessionUser> {
  const resolved = await resolvePermissionsForUser({
    role: row.role,
    staff_role_id: row.staff_role_id ?? null,
  });
  const clientAccess = await resolveClientAccessForUser({
    id: row.id,
    role: row.role,
    company_id: row.company_id ?? null,
    client_role_id: row.client_role_id ?? null,
    billing_access: row.billing_access ?? null,
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    company_id: row.company_id,
    active: row.active,
    staff_role_id: row.staff_role_id ?? null,
    client_role_id: row.client_role_id ?? null,
    billing_access: row.billing_access ?? null,
    job_title: row.job_title ?? null,
    phone: row.phone ?? null,
    mobile: row.mobile ?? null,
    bio: row.bio ?? null,
    locale: row.locale ?? null,
    itglue_user_id: row.itglue_user_id ?? null,
    board_email_opt_in: row.board_email_opt_in === false ? false : true,
    mfa_enabled: isMfaEnabled(row),
    created_at: row.created_at,
    permissions: resolved.permissions,
    staff_role_name: resolved.staff_role_name,
    staff_role_slug: resolved.staff_role_slug,
    client_role_name: clientAccess.client_role_name,
    client_role_slug: clientAccess.client_role_slug,
    client_role_names: clientAccess.client_role_names,
    client_role_slugs: clientAccess.client_role_slugs,
    billing_enabled: clientAccess.billing_enabled,
    client_permissions:
      row.role === "client" ? clientAccess.client_permissions : null,
  };
}

function readPending(): MfaPending | null {
  try {
    const raw = sessionStorage.getItem(MFA_PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as MfaPending;
    if (!p?.token || !p?.userId) return null;
    // Expire pending after 15 minutes
    if (Date.now() - (p.createdAt || 0) > 15 * 60_000) {
      sessionStorage.removeItem(MFA_PENDING_KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function writePending(p: MfaPending | null) {
  if (!p) {
    sessionStorage.removeItem(MFA_PENDING_KEY);
    return;
  }
  sessionStorage.setItem(MFA_PENDING_KEY, JSON.stringify(p));
}

async function establishSession(userId: number): Promise<SessionUser | null> {
  const found = await loadUserById(userId);
  if (!found || !found.active) return null;
  const session = await toSessionUser(found);
  localStorage.setItem(SESSION_KEY, JSON.stringify({ id: session.id }));
  writePending(null);
  return session;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await dbReady;
        const pending = readPending();
        if (!cancelled) setMfaPending(pending);

        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { id?: number };
        if (!parsed?.id) return;
        const found = await loadUserById(parsed.id);
        if (!cancelled && found && found.active && isMfaEnabled(found)) {
          setUser(await toSessionUser(found));
        } else if (!cancelled && found && found.active && !isMfaEnabled(found)) {
          // Stale session without MFA — force re-enroll
          localStorage.removeItem(SESSION_KEY);
          const pending: MfaPending = {
            token: createPendingToken(),
            userId: found.id,
            email: found.email,
            name: found.name,
            kind: "enroll",
            createdAt: Date.now(),
          };
          writePending(pending);
          setMfaPending(pending);
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

  const clearMfaPending = useCallback(() => {
    writePending(null);
    setMfaPending(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await dbReady;
    const normalized = email.trim().toLowerCase();
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalized))
      .limit(1);
    const found = rows[0] as UserRow | undefined;
    if (!found || found.password !== password) {
      return { ok: false as const, error: "invalid" as const };
    }
    if (!found.active) {
      return { ok: false as const, error: "deactivated" as const };
    }

    // Always clear any previous full session before MFA
    localStorage.removeItem(SESSION_KEY);
    setUser(null);

    const kind: MfaPendingKind = isMfaEnabled(found) ? "challenge" : "enroll";
    const pending: MfaPending = {
      token: createPendingToken(),
      userId: found.id,
      email: found.email,
      name: found.name,
      kind,
      createdAt: Date.now(),
    };
    writePending(pending);
    setMfaPending(pending);
    return { ok: true as const, needsMfa: true as const, kind };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    writePending(null);
    setMfaPending(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!user) return;
    const found = await loadUserById(user.id);
    if (found && found.active) {
      setUser(await toSessionUser(found));
    } else {
      logout();
    }
  }, [user, logout]);

  const patchSession = useCallback((patch: Partial<SessionUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const finishLogin = useCallback(async (userId: number) => {
    const session = await establishSession(userId);
    if (!session) return false;
    setUser(session);
    setMfaPending(null);
    return true;
  }, []);

  const verifyMfaTotp = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const pending = readPending();
      if (!pending || pending.kind !== "challenge") {
        return { ok: false, error: "no_pending" };
      }
      const found = await loadUserById(pending.userId);
      if (!found || !found.active || !isMfaEnabled(found)) {
        return { ok: false, error: "no_pending" };
      }
      const ok = await verifyTotp(found.mfa_totp_secret || "", code);
      if (!ok) return { ok: false, error: "invalid_code" };
      const done = await finishLogin(found.id);
      return done ? { ok: true } : { ok: false, error: "generic" };
    },
    [finishLogin],
  );

  const verifyMfaRecovery = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const pending = readPending();
      if (!pending || pending.kind !== "challenge") {
        return { ok: false, error: "no_pending" };
      }
      const found = await loadUserById(pending.userId);
      if (!found || !found.active || !isMfaEnabled(found)) {
        return { ok: false, error: "no_pending" };
      }
      const consumed = await consumeRecoveryCode(
        found.mfa_recovery_codes,
        code,
      );
      if (!consumed.ok) return { ok: false, error: "invalid_code" };
      await dbReady;
      await db
        .update(schema.users)
        .set({ mfa_recovery_codes: consumed.remainingJson })
        .where(eq(schema.users.id, found.id));
      const done = await finishLogin(found.id);
      return done ? { ok: true } : { ok: false, error: "generic" };
    },
    [finishLogin],
  );

  const sendMfaEmailCode = useCallback(async (): Promise<MfaVerifyResult> => {
    const pending = readPending();
    if (!pending || pending.kind !== "challenge") {
      return { ok: false, error: "no_pending" };
    }
    const found = await loadUserById(pending.userId);
    if (!found || !found.active) return { ok: false, error: "no_pending" };

    const code = generateEmailOtp();
    const hash = await hashEmailOtp(code);
    const expires = emailOtpExpiryIso(10);
    await dbReady;
    await db
      .update(schema.users)
      .set({
        mfa_email_code_hash: hash,
        mfa_email_code_expires: expires,
      })
      .where(eq(schema.users.id, found.id));

    try {
      const res = await fetch("/api/smtp/send-mfa-code", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email: found.email,
          name: found.name,
          code,
          locale: found.locale || "en",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          error: "smtp",
          message: data.error || "Could not send email code",
        };
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: "smtp",
        message: e instanceof Error ? e.message : "Could not send email code",
      };
    }
  }, []);

  const verifyMfaEmailCode = useCallback(
    async (code: string): Promise<MfaVerifyResult> => {
      const pending = readPending();
      if (!pending || pending.kind !== "challenge") {
        return { ok: false, error: "no_pending" };
      }
      const found = await loadUserById(pending.userId);
      if (!found || !found.active) return { ok: false, error: "no_pending" };
      if (isEmailOtpExpired(found.mfa_email_code_expires)) {
        return { ok: false, error: "expired" };
      }
      const hash = await hashEmailOtp(code);
      if (!found.mfa_email_code_hash || hash !== found.mfa_email_code_hash) {
        return { ok: false, error: "invalid_code" };
      }
      await dbReady;
      await db
        .update(schema.users)
        .set({
          mfa_email_code_hash: null,
          mfa_email_code_expires: null,
        })
        .where(eq(schema.users.id, found.id));
      const done = await finishLogin(found.id);
      return done ? { ok: true } : { ok: false, error: "generic" };
    },
    [finishLogin],
  );

  const startMfaEnroll = useCallback(async () => {
    // Prefer pending enroll after password; allow logged-in user without MFA too
    let pending = readPending();
    let userId: number | null = pending?.userId ?? user?.id ?? null;
    let email = pending?.email || user?.email || "";
    let name = pending?.name || user?.name || "";

    if (userId == null) {
      return { ok: false as const, error: "no_pending" };
    }

    const found = await loadUserById(userId);
    if (!found || !found.active) {
      return { ok: false as const, error: "no_pending" };
    }
    email = found.email;
    name = found.name;

    const secret = generateTotpSecret();
    const otpauthUrl = buildOtpAuthUri({
      secret,
      accountName: email,
      issuer: "AKAB Portal",
    });
    const qrUrl = totpQrImageUrl(otpauthUrl, 200);

    // Store pending setup secret (never write secret to DB until confirmed)
    if (!pending || pending.userId !== userId) {
      pending = {
        token: createPendingToken(),
        userId,
        email,
        name,
        kind: "enroll",
        setupSecret: secret,
        createdAt: Date.now(),
      };
    } else {
      pending = {
        ...pending,
        kind: "enroll",
        setupSecret: secret,
        createdAt: Date.now(),
      };
    }
    writePending(pending);
    setMfaPending(pending);

    // If already fully logged in without MFA, keep session but track enroll pending
    return { secret, otpauthUrl, qrUrl };
  }, [user]);

  const confirmMfaEnroll = useCallback(
    async (code: string) => {
      const pending = readPending();
      if (!pending?.setupSecret) {
        return { ok: false as const, error: "no_pending" as const };
      }
      const ok = await verifyTotp(pending.setupSecret, code);
      if (!ok) return { ok: false as const, error: "invalid_code" as const };

      const recoveryCodes = generateRecoveryCodes(8);
      const hashed = await hashRecoveryCodes(recoveryCodes);

      await dbReady;
      await db
        .update(schema.users)
        .set({
          mfa_enabled: true,
          mfa_totp_secret: pending.setupSecret,
          mfa_recovery_codes: JSON.stringify(hashed),
          mfa_email_code_hash: null,
          mfa_email_code_expires: null,
        })
        .where(eq(schema.users.id, pending.userId));

      const done = await finishLogin(pending.userId);
      if (!done) return { ok: false as const, error: "generic" as const };
      return { ok: true as const, recoveryCodes };
    },
    [finishLogin],
  );

  const disableMfa = useCallback(
    async (code: string) => {
      if (!user) return { ok: false as const, error: "not_signed_in" };
      const found = await loadUserById(user.id);
      if (!found || !isMfaEnabled(found)) {
        return { ok: false as const, error: "not_enabled" };
      }
      const totpOk = await verifyTotp(found.mfa_totp_secret || "", code);
      let recoveryOk = false;
      let remainingJson: string | null = found.mfa_recovery_codes ?? null;
      if (!totpOk) {
        const consumed = await consumeRecoveryCode(
          found.mfa_recovery_codes,
          code,
        );
        if (consumed.ok) {
          recoveryOk = true;
          remainingJson = consumed.remainingJson;
        }
      }
      if (!totpOk && !recoveryOk) {
        return { ok: false as const, error: "invalid_code" };
      }
      await dbReady;
      await db
        .update(schema.users)
        .set({
          mfa_enabled: false,
          mfa_totp_secret: null,
          mfa_recovery_codes: recoveryOk ? remainingJson : null,
          mfa_email_code_hash: null,
          mfa_email_code_expires: null,
        })
        .where(eq(schema.users.id, user.id));
      // MFA is required — immediately put user into enroll pending and clear session
      localStorage.removeItem(SESSION_KEY);
      const pending: MfaPending = {
        token: createPendingToken(),
        userId: user.id,
        email: user.email,
        name: user.name,
        kind: "enroll",
        createdAt: Date.now(),
      };
      writePending(pending);
      setMfaPending(pending);
      setUser(null);
      return { ok: true as const };
    },
    [user],
  );

  const regenerateRecoveryCodes = useCallback(
    async (totpCode: string) => {
      if (!user) return { ok: false as const, error: "not_signed_in" };
      const found = await loadUserById(user.id);
      if (!found || !isMfaEnabled(found)) {
        return { ok: false as const, error: "not_enabled" };
      }
      const ok = await verifyTotp(found.mfa_totp_secret || "", totpCode);
      if (!ok) return { ok: false as const, error: "invalid_code" };
      const recoveryCodes = generateRecoveryCodes(8);
      const hashed = await hashRecoveryCodes(recoveryCodes);
      await dbReady;
      await db
        .update(schema.users)
        .set({ mfa_recovery_codes: JSON.stringify(hashed) })
        .where(eq(schema.users.id, user.id));
      return { ok: true as const, recoveryCodes };
    },
    [user],
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
