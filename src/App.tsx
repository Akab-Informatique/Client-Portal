import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoginPage } from "@/pages/LoginPage";
import { LogoMark } from "@/components/brand/Logo";
import { SessionProvider, useAuthState, useCan, useUnauthorizedListener } from "@/lib/session";
import type { Me } from "@/lib/types";
import type { PermissionKey } from "@shared/permissions";

// Code-split: the sign-in page loads first; the rest loads after sign-in.
const StaffLayout = lazy(() => import("@/layouts/StaffLayout").then((m) => ({ default: m.StaffLayout })));
const DashboardPage = lazy(() => import("@/pages/dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const MessagesPage = lazy(() => import("@/pages/messages/MessagesPage").then((m) => ({ default: m.MessagesPage })));
const TicketsPage = lazy(() => import("@/pages/tickets/TicketsPage").then((m) => ({ default: m.TicketsPage })));
const ClientHome = lazy(() => import("@/pages/client/ClientHome").then((m) => ({ default: m.ClientHome })));

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <LogoMark className="h-12 animate-pulse" />
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Shown instead of an endless spinner when the API cannot be reached. */
function ServerDown({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <LogoMark className="h-12" />
      <div>
        <h1 className="text-2xl font-bold">{t("errors.serverDown")}</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{t("errors.serverDownText")}</p>
      </div>
      <Button onClick={onRetry} disabled={retrying} variant="outline">
        {retrying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("errors.retry")}
      </Button>
    </div>
  );
}

function Guard({ permission, children }: { permission: PermissionKey; children: React.ReactNode }) {
  const { t } = useTranslation();
  const can = useCan();
  if (!can(permission)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed p-16 text-center text-muted-foreground">
        <ShieldAlert className="size-8 text-primary" />
        {t("errors.forbidden")}
      </div>
    );
  }
  return <>{children}</>;
}

function StaffApp() {
  const can = useCan();
  return (
    <Routes>
      <Route element={<StaffLayout />}>
        <Route
          index
          element={
            can("dashboard.view") ? (
              <DashboardPage />
            ) : can("messages.view") ? (
              <Navigate to="/messages" replace />
            ) : (
              <Guard permission="dashboard.view">{null}</Guard>
            )
          }
        />
        <Route path="messages" element={<Guard permission="messages.view"><MessagesPage /></Guard>} />
        <Route path="tickets" element={<Guard permission="tickets.view"><TicketsPage /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Root() {
  useUnauthorizedListener();
  const { data, isLoading, isError, refetch, isFetching } = useAuthState();
  if (isError && !data) return <ServerDown onRetry={() => void refetch()} retrying={isFetching} />;
  if (isLoading || !data) return <Splash />;
  if (data.stage !== "ready") return <LoginPage stage={data.stage} email={data.me?.email} />;
  const me = data.me as Me;
  return (
    <SessionProvider me={me}>
      <Suspense fallback={<Splash />}>
        {me.kind === "staff" ? (
          <StaffApp />
        ) : (
          <Routes>
            <Route path="*" element={<ClientHome />} />
          </Routes>
        )}
      </Suspense>
    </SessionProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}
