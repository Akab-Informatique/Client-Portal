import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/hooks/use-theme";
import { LocaleProvider, useLocale } from "@/hooks/use-locale";
import { ensureDemoAutotaskIds, seedIfNeeded } from "@/lib/seed";
import { isLocale } from "@/i18n";
import {
  ProtectedRoute,
  RequirePermission,
} from "@/components/layout/ProtectedRoute";
import { LoginPage } from "@/pages/LoginPage";
import { AdminLayout } from "@/pages/admin/AdminLayout";
import { AdminDashboard } from "@/pages/admin/AdminDashboard";
import { ClientsPage } from "@/pages/admin/ClientsPage";
import { TechniciansPage } from "@/pages/admin/TechniciansPage";
import { MessagesPage } from "@/pages/admin/MessagesPage";
import { AdminDocumentationPage } from "@/pages/admin/AdminDocumentationPage";
import { SettingsPage } from "@/pages/admin/SettingsPage";
import { ClientLayout } from "@/pages/client/ClientLayout";
import { ClientDashboard } from "@/pages/client/ClientDashboard";
import { ClientBoardPage } from "@/pages/client/ClientBoardPage";
import { ClientTicketsPage } from "@/pages/client/ClientTicketsPage";
import { ClientDocumentationPage } from "@/pages/client/ClientDocumentationPage";
import { PasswordsPage } from "@/pages/PasswordsPage";
import { DirectoryPage, ProfilePage } from "@/pages/ProfilePage";
import { firstAllowedAdminPath } from "@/lib/permissions";
import { AkabLoader } from "@/components/AkabLoader";
import { RouteLoadingOverlay } from "@/components/RouteLoadingOverlay";

function RootRedirect() {
  const { user, loading } = useAuth();
  const { t } = useLocale();
  if (loading) {
    return <AkabLoader fullScreen size="xl" label={t("app.loading")} />;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === "client") return <Navigate to="/client" replace />;
  return <Navigate to={firstAllowedAdminPath(user.permissions)} replace />;
}

/** Sync portal language from the signed-in user's preferred locale. */
function LocaleSync() {
  const { user } = useAuth();
  const { locale, setLocale } = useLocale();
  useEffect(() => {
    if (user?.locale && isLocale(user.locale) && user.locale !== locale) {
      setLocale(user.locale);
    }
    // Only react to user identity / stored preference changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.locale]);
  return null;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RootRedirect />} />

      <Route element={<ProtectedRoute roles={["admin", "technician"]} />}>
        <Route path="/admin" element={<AdminLayout />}>
          <Route
            index
            element={
              <RequirePermission permission="dashboard">
                <AdminDashboard />
              </RequirePermission>
            }
          />
          <Route
            path="clients"
            element={
              <RequirePermission permission="clients">
                <ClientsPage />
              </RequirePermission>
            }
          />
          <Route path="technicians" element={<TechniciansPage />} />
          {/* Legacy top-level Users route → Clients (users live under client companies) */}
          <Route path="users" element={<Navigate to="/admin/clients" replace />} />
          {/* General settings: any signed-in staff (admin/technician layout already gated) */}
          <Route path="settings" element={<SettingsPage />} />
          <Route
            path="messages"
            element={
              <RequirePermission permission="messages">
                <MessagesPage />
              </RequirePermission>
            }
          />
          <Route
            path="documentation"
            element={
              <RequirePermission permission="documentation">
                <AdminDocumentationPage />
              </RequirePermission>
            }
          />
          <Route
            path="passwords"
            element={
              <RequirePermission permission="passwords">
                <PasswordsPage />
              </RequirePermission>
            }
          />
          <Route
            path="directory"
            element={
              <RequirePermission permission="directory">
                <DirectoryPage />
              </RequirePermission>
            }
          />
          <Route path="profile" element={<Navigate to="me" replace />} />
          <Route
            path="profile/:userId"
            element={
              <RequirePermission permission="profiles">
                <ProfilePage />
              </RequirePermission>
            }
          />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={["client"]} />}>
        <Route path="/client" element={<ClientLayout />}>
          <Route index element={<ClientDashboard />} />
          <Route path="board" element={<ClientBoardPage />} />
          <Route path="tickets" element={<ClientTicketsPage />} />
          <Route path="documentation" element={<ClientDocumentationPage />} />
          <Route path="passwords" element={<PasswordsPage />} />
          <Route path="directory" element={<DirectoryPage />} />
          <Route path="profile" element={<Navigate to="me" replace />} />
          <Route path="profile/:userId" element={<ProfilePage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const hardTimer = window.setTimeout(() => {
      if (!cancelled) {
        console.error("[akab] Boot timed out — forcing UI open");
        setBootError(
          "Portal startup is taking too long. On the server run: docker compose logs app db && curl -s localhost:3000/api/db/status?migrate=1",
        );
        setReady(true);
      }
    }, 30000);

    (async () => {
      try {
        // On production Postgres the server already migrated + seeded via /api/db/status.
        // seedIfNeeded is a fast no-op when users already exist.
        await seedIfNeeded();
        await ensureDemoAutotaskIds();
      } catch (err) {
        console.error("[akab] Boot seed failed:", err);
        if (!cancelled) {
          setBootError(
            err instanceof Error
              ? err.message
              : "Could not prepare the portal database.",
          );
        }
      } finally {
        window.clearTimeout(hardTimer);
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(hardTimer);
    };
  }, []);

  if (!ready) {
    return <AkabLoader fullScreen size="xl" label="Preparing portal…" />;
  }

  return (
    <ThemeProvider>
      <LocaleProvider>
        <AuthProvider>
          <BrowserRouter>
            <LocaleSync />
            <RouteLoadingOverlay />
            {bootError && (
              <div
                role="alert"
                className="fixed inset-x-0 top-0 z-[100] border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-center text-sm text-destructive"
              >
                {bootError}{" "}
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
              </div>
            )}
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
