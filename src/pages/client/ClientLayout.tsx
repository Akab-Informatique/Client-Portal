import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { eq } from "drizzle-orm";
import { AppShell, useClientNav } from "@/components/layout/AppShell";
import { InAppToast } from "@/components/InAppToast";
import {
  BoardNotificationsProvider,
  useBoardNotificationsContext,
} from "@/context/BoardNotificationsContext";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";

function ClientShell() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [companyName, setCompanyName] = useState<string>("…");
  const { unreadCount, latestToast, dismissToast, markBoardViewed } =
    useBoardNotificationsContext();
  const nav = useClientNav(unreadCount);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id) return;
      await dbReady;
      const rows = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, user.company_id))
        .limit(1);
      if (!cancelled && rows[0]) setCompanyName(rows[0].name);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.company_id]);

  return (
    <>
      <AppShell
        title={companyName}
        subtitle={t("shell.clientSubtitle")}
        badge={t("shell.badgeClient")}
        nav={nav}
      >
        <Outlet context={{ companyName, markBoardViewed }} />
      </AppShell>
      {latestToast && (
        <InAppToast
          title={latestToast.title}
          body={latestToast.body}
          onDismiss={dismissToast}
          href="/client/board"
        />
      )}
    </>
  );
}

export function ClientLayout() {
  return (
    <BoardNotificationsProvider>
      <ClientShell />
    </BoardNotificationsProvider>
  );
}
