import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Building2,
  LayoutDashboard,
  Megaphone,
  UserCircle2,
  Users,
  Wrench,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import { StatCard } from "@/components/StatCard";
import {
  DashboardCustomizeButton,
  DashboardCustomizer,
  DashboardWidgetFrame,
} from "@/components/DashboardCustomizer";
import { BlurFade } from "@/components/ui/blur-fade";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { useLocale } from "@/hooks/use-locale";
import {
  defaultAdminLayout,
  isVisible,
  loadAdminLayout,
  moveInOrder,
  saveAdminLayout,
  toggleHidden,
  type AdminDashboardLayout,
  type AdminWidgetId,
} from "@/lib/dashboard-layout";
import type { BoardMessage, Company } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AdminDashboard() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [stats, setStats] = useState({
    clients: 0,
    technicians: 0,
    clientUsers: 0,
    messages: 0,
  });
  const [recentMessages, setRecentMessages] = useState<
    (BoardMessage & { companyName?: string })[]
  >([]);
  const [clients, setClients] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<AdminDashboardLayout>(() =>
    defaultAdminLayout(),
  );

  useEffect(() => {
    if (!user?.id) return;
    setLayout(loadAdminLayout(user.id));
  }, [user?.id]);

  const persist = useCallback(
    (next: AdminDashboardLayout) => {
      setLayout(next);
      if (user?.id) saveAdminLayout(user.id, next);
    },
    [user?.id],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await dbReady;
      const [companies, users, messages] = await Promise.all([
        db.select().from(schema.companies),
        db.select().from(schema.users),
        db.select().from(schema.board_messages),
      ]);
      if (cancelled) return;

      const clientCompanies = companies.filter((c) => c.type === "client");
      const companyMap = new Map(companies.map((c) => [c.id, c.name]));

      setClients(clientCompanies as Company[]);
      setStats({
        clients: clientCompanies.filter((c) => c.active).length,
        technicians: users.filter(
          (u) => u.role === "technician" && u.active,
        ).length,
        clientUsers: users.filter((u) => u.role === "client" && u.active)
          .length,
        messages: messages.length,
      });

      const sorted = [...messages].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      setRecentMessages(
        sorted.slice(0, 5).map((m) => ({
          ...(m as BoardMessage),
          companyName: companyMap.get(m.company_id) ?? "Unknown",
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const compact = layout.density === "compact";
  const gap = compact ? "gap-3" : "gap-6";
  const spaceY = compact ? "space-y-4" : "space-y-8";

  const widgetMeta = useMemo(
    () => [
      {
        id: "stats",
        label: t("dash.wStats"),
        description: t("dash.wStatsDesc"),
      },
      {
        id: "messages",
        label: t("dash.wMessages"),
        description: t("dash.wMessagesDesc"),
      },
      {
        id: "clients",
        label: t("dash.wClients"),
        description: t("dash.wClientsDesc"),
      },
      {
        id: "addons",
        label: t("dash.wAddons"),
        description: t("dash.wAddonsDesc"),
      },
      {
        id: "quickLinks",
        label: t("dash.wQuickLinks"),
        description: t("dash.wQuickLinksDesc"),
      },
    ],
    [t],
  );

  const labelFor = (id: AdminWidgetId) =>
    widgetMeta.find((w) => w.id === id)?.label ?? id;

  const move = (id: AdminWidgetId, dir: -1 | 1) => {
    persist({ ...layout, order: moveInOrder(layout.order, id, dir) });
  };

  const toggle = (id: AdminWidgetId) => {
    persist({ ...layout, hidden: toggleHidden(layout.hidden, id) });
  };

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  const renderWidget = (id: AdminWidgetId, index: number) => {
    const visible = isVisible(layout, id);
    const frameProps = {
      editing,
      visible,
      label: labelFor(id),
      canUp: index > 0,
      canDown: index < layout.order.length - 1,
      onMoveUp: () => move(id, -1),
      onMoveDown: () => move(id, 1),
      onToggle: () => toggle(id),
    };

    switch (id) {
      case "stats":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.05}>
              <div className="mb-3 flex justify-end">
                <DashboardCustomizeButton
                  active={editing}
                  onClick={() => setEditing((v) => !v)}
                />
              </div>
              <div
                className={cn(
                  "grid gap-4",
                  layout.statsColumns === 2
                    ? "sm:grid-cols-2"
                    : "sm:grid-cols-2 xl:grid-cols-4",
                )}
              >
                <StatCard
                  label={t("admin.activeClients")}
                  value={stats.clients}
                  icon={<Building2 className="size-5" />}
                  hint={t("admin.clientCompanies")}
                />
                <StatCard
                  label={t("admin.technicians")}
                  value={stats.technicians}
                  icon={<Wrench className="size-5" />}
                  hint={t("admin.techniciansHint")}
                />
                <StatCard
                  label={t("admin.clientUsers")}
                  value={stats.clientUsers}
                  icon={<Users className="size-5" />}
                  hint={t("admin.acrossZones")}
                />
                <StatCard
                  label={t("admin.boardMessages")}
                  value={stats.messages}
                  icon={<Megaphone className="size-5" />}
                  hint={t("admin.allBoards")}
                />
              </div>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "messages":
        return (
          <DashboardWidgetFrame
            key={id}
            {...frameProps}
            className="lg:col-span-3"
          >
            <BlurFade delay={0.1}>
              <Card className="h-full">
                <CardHeader
                  className={cn(
                    "flex flex-row items-start justify-between gap-4 space-y-0",
                    compact && "p-4 pb-2",
                  )}
                >
                  <div>
                    <CardTitle>{t("admin.recentMessages")}</CardTitle>
                    <CardDescription>{t("admin.recentDesc")}</CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/admin/messages">
                      {t("admin.openBoard")}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent
                  className={cn("space-y-3", compact && "p-4 pt-0")}
                >
                  {recentMessages.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("admin.noMessages")}
                    </p>
                  ) : (
                    recentMessages.map((m) => (
                      <div
                        key={m.id}
                        className={cn(
                          "rounded-lg border border-border bg-card/60 transition-colors hover:bg-muted/30",
                          compact ? "p-3" : "p-4",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{m.title}</p>
                          {m.pinned && (
                            <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                              {t("board.pinned")}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {m.body}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {m.companyName}
                          </span>
                          <span>{m.author_name}</span>
                          <span>{formatDate(m.created_at)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "clients":
        return (
          <DashboardWidgetFrame
            key={id}
            {...frameProps}
            className="lg:col-span-2"
          >
            <BlurFade delay={0.15}>
              <Card className="h-full">
                <CardHeader
                  className={cn(
                    "flex flex-row items-start justify-between gap-4 space-y-0",
                    compact && "p-4 pb-2",
                  )}
                >
                  <div>
                    <CardTitle>{t("admin.clientZones")}</CardTitle>
                    <CardDescription>
                      {t("admin.clientZonesDesc")}
                    </CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/admin/clients">{t("admin.manage")}</Link>
                  </Button>
                </CardHeader>
                <CardContent
                  className={cn("space-y-2", compact && "p-4 pt-0")}
                >
                  {clients.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("admin.noClients")}
                    </p>
                  ) : (
                    clients.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{c.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {c.email || t("admin.noEmail")}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={
                            c.active
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "text-muted-foreground"
                          }
                        >
                          {c.active
                            ? t("common.active")
                            : t("common.inactive")}
                        </Badge>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "addons":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.2}>
              <Card className="border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card">
                <CardContent
                  className={cn(
                    "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
                    compact ? "p-4" : "p-6",
                  )}
                >
                  <div>
                    <h3 className="text-lg font-bold tracking-tight">
                      {t("admin.addonsTitle")}
                    </h3>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      {t("admin.addonsDesc")}
                    </p>
                  </div>
                  <Button asChild>
                    <Link to="/admin/messages">
                      {t("admin.sendMessage")}
                      <Megaphone className="size-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "quickLinks":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.18}>
              <Card>
                <CardHeader className={cn(compact && "p-4 pb-2")}>
                  <CardTitle className="flex items-center gap-2">
                    <LayoutDashboard className="size-5 text-primary" />
                    {t("dash.quickLinksTitle")}
                  </CardTitle>
                  <CardDescription>{t("dash.quickLinksDesc")}</CardDescription>
                </CardHeader>
                <CardContent
                  className={cn(
                    "grid gap-2 sm:grid-cols-2 lg:grid-cols-4",
                    compact && "p-4 pt-0",
                  )}
                >
                  {[
                    {
                      to: "/admin/clients",
                      label: t("dash.linkClients"),
                      icon: Building2,
                    },
                    {
                      to: "/admin/technicians",
                      label: t("dash.linkTechnicians"),
                      icon: Wrench,
                    },
                    {
                      to: "/admin/users",
                      label: t("dash.linkUsers"),
                      icon: Users,
                    },
                    {
                      to: "/admin/messages",
                      label: t("dash.linkMessages"),
                      icon: Megaphone,
                    },
                    {
                      to: "/admin/directory",
                      label: t("dash.linkDirectory"),
                      icon: Users,
                    },
                    {
                      to: "/admin/profile/me",
                      label: t("dash.linkProfile"),
                      icon: UserCircle2,
                    },
                  ].map((link) => (
                    <Button
                      key={link.to}
                      asChild
                      variant="outline"
                      className="h-auto justify-start gap-3 px-4 py-3"
                    >
                      <Link to={link.to}>
                        <link.icon className="size-4 text-primary" />
                        <span>{link.label}</span>
                      </Link>
                    </Button>
                  ))}
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      default:
        return null;
    }
  };

  const orderedVisible = layout.order.filter(
    (id) => editing || isVisible(layout, id),
  );

  const useClassicGrid =
    !editing &&
    orderedVisible.includes("messages") &&
    orderedVisible.includes("clients");

  return (
    <div className={spaceY}>
      {!isVisible(layout, "stats") && !editing && (
        <div className="flex justify-end">
          <DashboardCustomizeButton
            active={editing}
            onClick={() => setEditing(true)}
          />
        </div>
      )}

      {editing && (
        <DashboardCustomizer
          open={editing}
          onOpenChange={setEditing}
          widgets={widgetMeta}
          order={layout.order}
          hidden={layout.hidden}
          density={layout.density}
          statsColumns={layout.statsColumns}
          onMove={(id, dir) => move(id as AdminWidgetId, dir)}
          onToggle={(id) => toggle(id as AdminWidgetId)}
          onDensity={(d) => persist({ ...layout, density: d })}
          onStatsColumns={(n) => persist({ ...layout, statsColumns: n })}
          onReset={() => persist(defaultAdminLayout())}
        />
      )}

      {useClassicGrid ? (
        <>
          {orderedVisible
            .filter((id) => id !== "messages" && id !== "clients")
            .map((id) => renderWidget(id, layout.order.indexOf(id)))}

          <div className={cn("grid lg:grid-cols-5", gap)}>
            {orderedVisible.includes("messages") &&
              renderWidget("messages", layout.order.indexOf("messages"))}
            {orderedVisible.includes("clients") &&
              renderWidget("clients", layout.order.indexOf("clients"))}
          </div>
        </>
      ) : (
        <div className={cn("grid", gap)}>
          {orderedVisible.map((id) =>
            renderWidget(id, layout.order.indexOf(id)),
          )}
        </div>
      )}
    </div>
  );
}
