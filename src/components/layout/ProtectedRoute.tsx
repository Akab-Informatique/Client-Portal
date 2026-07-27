import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { UserRole } from "@/lib/types";
import {
  firstAllowedAdminPath,
  permissionForAdminPath,
  type StaffPermission,
} from "@/lib/permissions";
import { useLocale } from "@/hooks/use-locale";
import { AkabLoader } from "@/components/AkabLoader";

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

  if (roles && !roles.includes(user.role)) {
    if (user.role === "client") return <Navigate to="/client" replace />;
    return <Navigate to={firstAllowedAdminPath(user.permissions)} replace />;
  }

  // Section-level gate for staff
  if (user.role !== "client") {
    const needed = permission ?? permissionForAdminPath(location.pathname);
    if (needed && !can(needed)) {
      const fallback = firstAllowedAdminPath(user.permissions);
      if (fallback !== location.pathname) {
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
