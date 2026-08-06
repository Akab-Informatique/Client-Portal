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
import {
  ContractsPage,
  InvoicesPage,
} from "@/pages/admin/BillingPlaceholderPage";
import { TodoPage } from "@/pages/admin/TodoPage";
import { SosQueuePage } from "@/pages/admin/SosQueuePage";
import { ClientRolesPage } from "@/pages/admin/ClientRolesPage";
import { ClientLayout } from "@/pages/client/ClientLayout";
import { ClientDashboard } from "@/pages/client/ClientDashboard";
import { ClientBoardPage } from "@/pages/client/ClientBoardPage";
import { ClientTicketsPage } from "@/pages/client/ClientTicketsPage";
import { ClientDocumentationPage } from "@/pages/client/ClientDocumentationPage";
import { ClientBillingPage } from "@/pages/client/ClientBillingPage";
import { SosDownloadPage } from "@/pages/client/SosDownloadPage";
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
  if (!user.mfa_enabled) return <Navigate to="/login" replace />;
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
          <Route
            path="client-roles"
            element={
              <RequirePermission permission="clients">
                <ClientRolesPage />
              </RequirePermission>
            }
          />
          {/* Legacy top-level Users route → Clients (users live under client companies) */}
          <Route path="users" element={<Navigate to="/admin/clients" replace />} />
          {/* General settings: any signed-in staff (admin/technician layout already gated) */}
          <Route path="settings" element={<SettingsPage />} />
          {/* To-do workspace — swaps the whole admin sidebar when open */}
          <Route path="todo" element={<TodoPage />} />
          {/* Splashtop SOS incoming queue */}
          <Route path="sos" element={<SosQueuePage />} />
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
          <Route path="billing/invoices" element={<InvoicesPage />} />
          <Route path="billing/contracts" element={<ContractsPage />} />
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
          <Route path="billing" element={<ClientBillingPage />} />
          {/* Branded SOS download page (auto-starts custom package / session link) */}
          <Route path="sos" element={<SosDownloadPage />} />
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
          "Portal startup timed out. On the server: cd /opt/akab-portal && docker compose ps && docker compose logs --tail=80 app db && curl -sS -m 5 \"http://127.0.0.1:3000/api/health\" && curl -sS -m 5 \"http://127.0.0.1:3000/api/db/ping\"",
        );
        setReady(true);
      }
    }, 22000);

    (async () => {
      try {
        // Production: server already migrated + seeded via /api/db/status.
        // seedIfNeeded is a fast no-op when users already exist.
        await seedIfNeeded();
        try {
          await ensureDemoAutotaskIds();
        } catch (e) {
          // Non-fatal branding backfill
          console.warn("[akab] ensureDemoAutotaskIds:", e);
        }
      } catch (err) {
        console.error("[akab] Boot failed:", err);
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

  // Fatal DB error: show instructions (never open a broken empty login)
  if (bootError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-xl space-y-4 rounded-xl border border-destructive/40 bg-card p-6 shadow-lg">
          <h1 className="text-lg font-bold text-destructive">
            Database connection failed
          </h1>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {bootError}
          </p>
          <div className="rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            <p className="mb-2 font-sans text-sm font-semibold text-foreground">
              On your Ubuntu server, run:
            </p>
            {`cd /opt/akab-portal
git pull origin master
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 app db
curl -sS -m 5  "http://127.0.0.1:3000/api/health"
curl -sS -m 8  "http://127.0.0.1:3000/api/health?db=1"
curl -sS -m 10 "http://127.0.0.1:3000/api/db/status"
curl -sS -m 30 "http://127.0.0.1:3000/api/db/status?migrate=1"
`}
          </div>
          <p className="text-xs text-muted-foreground">
            Expect{" "}
            <code className="text-foreground">
              &quot;mode&quot;:&quot;postgres&quot;,&quot;ok&quot;:true
            </code>
            . Always quote URLs that contain{" "}
            <code className="text-foreground">?</code>. Then hard-refresh this
            page. Login: admin@akab.local / admin123
          </p>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider>
      <LocaleProvider>
        <AuthProvider>
          <BrowserRouter>
            <LocaleSync />
            <RouteLoadingOverlay />
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
