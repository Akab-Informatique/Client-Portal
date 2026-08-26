import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { UserRole } from "@/lib/types";
import {
  firstAllowedAdminPath,
  permissionForAdminPath,
  type StaffPermission,
} from "@/lib/permissions";
import {
  hasClientPermission,
  type ClientPermission,
} from "@/lib/client-permissions";
import { useLocale } from "@/hooks/use-locale";
import { AkabLoader } from "@/components/AkabLoader";

/**
 * UX-only route gate. Real authorization is enforced server-side in
 * /api/db/query (and purpose-built /api/* handlers) from the session cookie.
 * Never treat these React checks as a security boundary.
 */
export function ProtectedRoute({
  roles,
  permission,
}: {
  roles?: UserRole[];
  /** Required staff permission for this route (admin shell only). */
  permission?: StaffPermission;
}) {
  const { user, loading, can } = useAuth();
  const { t } = useLocale();
  const location = useLocation();

  if (loading) {
    return <AkabLoader fullScreen size="xl" label={t("app.loading")} />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // MFA is required for every account — block the app until enrolled
  if (!user.mfa_enabled) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    if (user.role === "client") return <Navigate to="/client" replace />;
    return <Navigate to={firstAllowedAdminPath(user.permissions)} replace />;
  }

  // Section-level gate for staff
  if (user.role !== "client") {
    const needed = permission ?? permissionForAdminPath(location.pathname);
    if (needed && !can(needed)) {
      const fallback = firstAllowedAdminPath(user.permissions);
      // Compare path only — query strings must not create redirect loops
      const fallbackPath = fallback.split("?")[0] || fallback;
      if (fallbackPath !== location.pathname) {
        return <Navigate to={fallback} replace />;
      }
    }
  }

  return <Outlet />;
}

/** Nested guard for individual admin pages. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: StaffPermission;
  children: React.ReactNode;
}) {
  const { user, can, loading } = useAuth();
  const { t } = useLocale();

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <AkabLoader size="md" label={t("common.loading")} />
      </div>
    );
  }

  if (!user || user.role === "client" || !can(permission)) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center">
        <h2 className="text-lg font-bold">{t("staffRoles.accessDenied")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("staffRoles.accessDeniedDesc")}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

/** Nested guard for client-portal sections gated by user-role modules. */
export function RequireClientPermission({
  permission,
  children,
}: {
  permission: ClientPermission;
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const { t } = useLocale();

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <AkabLoader size="md" label={t("common.loading")} />
      </div>
    );
  }

  const allowed =
    user?.role === "client" &&
    (permission === "billing"
      ? !!user.billing_enabled
      : hasClientPermission(user.client_permissions, permission));

  if (!user || user.role !== "client" || !allowed) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center">
        <h2 className="text-lg font-bold">{t("staffRoles.accessDenied")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("staffRoles.accessDeniedDesc")}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
