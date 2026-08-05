import { Outlet } from "react-router-dom";
import {
  AppShell,
  useAdminNav,
  useAdminNavEntries,
} from "@/components/layout/AppShell";
import { SelectedClientProvider } from "@/context/SelectedClientContext";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";

function AdminShellInner() {
  const { user } = useAuth();
  const { t } = useLocale();
  const nav = useAdminNav();
  const navEntries = useAdminNavEntries();
  const roleName = user?.staff_role_name;
  const isAdminClass =
    user?.role === "admin" || user?.staff_role_slug === "admin";

  return (
    <AppShell
      title={isAdminClass ? t("shell.adminTitle") : t("shell.techTitle")}
      subtitle={t("shell.adminSubtitle")}
      badge={
        roleName ||
        (isAdminClass ? t("shell.badgeAdmin") : t("shell.badgeTech"))
      }
      nav={nav}
      navEntries={navEntries}
    >
      <Outlet />
    </AppShell>
  );
}

export function AdminLayout() {
  return (
    <SelectedClientProvider>
      <AdminShellInner />
    </SelectedClientProvider>
  );
}
