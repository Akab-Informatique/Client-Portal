import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { eq } from "drizzle-orm";
import {
  ArrowRight,
  Bell,
  Building2,
  LayoutDashboard,
  Pin,
  Ticket,
  UserCircle2,
  Users,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import { fetchOpenTickets } from "@/lib/autotask";
import { loadMessagesWithState } from "@/lib/message-state";
import type { BoardMessageWithState, Company, User } from "@/lib/types";
import {
  clearClientLayout,
  clientLayoutBaseline,
  defaultClientLayout,
  hasPersonalClientLayout,
  isVisible,
  moveInOrder,
  parseCompanyClientLayout,
  resolveClientLayout,
  saveClientLayout,
  toggleHidden,
  type ClientDashboardLayout,
  type ClientWidgetId,
} from "@/lib/dashboard-layout";
import { StatCard } from "@/components/StatCard";
import { NotificationBanner } from "@/components/NotificationBanner";
import {
  DashboardCustomizeButton,
  DashboardCustomizer,
  DashboardWidgetFrame,
} from "@/components/DashboardCustomizer";
import { useBoardNotificationsContext } from "@/context/BoardNotificationsContext";
import { useLocale } from "@/hooks/use-locale";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ClientDashboard() {
  const { user } = useAuth();
  const { t } = useLocale();
  const { permission, refreshPermission, unreadCount } =
    useBoardNotificationsContext();
  const [messages, setMessages] = useState<BoardMessageWithState[]>([]);
  const [teammates, setTeammates] = useState<User[]>([]);
  const [openTickets, setOpenTickets] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<ClientDashboardLayout>(() =>
    defaultClientLayout(),
  );
  const [companyDefault, setCompanyDefault] =
    useState<ClientDashboardLayout | null>(null);
  const [usingPersonal, setUsingPersonal] = useState(false);

  const persist = useCallback(
    (next: ClientDashboardLayout) => {
      setLayout(next);
      if (user?.id) {
        saveClientLayout(user.id, next);
        setUsingPersonal(true);
      }
    },
    [user?.id],
  );

  const resetToDefault = useCallback(() => {
    if (!user?.id) return;
    clearClientLayout(user.id);
    const baseline = clientLayoutBaseline(companyDefault);
    setLayout(baseline);
    setUsingPersonal(false);
  }, [user?.id, companyDefault]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id || !user?.id) {
        setLoading(false);
        return;
      }
      await dbReady;
      const [msgs, users, companies] = await Promise.all([
        loadMessagesWithState(user.company_id, user.id),
        db
          .select()
          .from(schema.users)
          .where(eq(schema.users.company_id, user.company_id)),
        db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, user.company_id))
          .limit(1),
      ]);
      if (cancelled) return;
      setMessages(msgs);
      setTeammates(
        (users as User[]).filter((u) => u.role === "client" && u.active),
      );

      const company = companies[0] as Company | undefined;
      const companyLayout = parseCompanyClientLayout(
        company?.dashboard_layout ?? null,
      );
      setCompanyDefault(companyLayout);
      setLayout(resolveClientLayout(user.id, companyLayout));
      setUsingPersonal(hasPersonalClientLayout(user.id));

      if (company?.autotask_company_id && user.email) {
        const ticketRes = await fetchOpenTickets({
          companyId: company.id,
          autotaskCompanyId: company.autotask_company_id,
          email: user.email,
          scope: "user",
        });
        if (!cancelled) setOpenTickets(ticketRes.tickets?.length ?? 0);
      } else if (!cancelled) {
        setOpenTickets(0);
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const latest = messages.slice(0, 3);
  const compact = layout.density === "compact";
  const gap = compact ? "gap-3" : "gap-6";
  const spaceY = compact ? "space-y-4" : "space-y-8";

  const widgetMeta = useMemo(
    () => [
      {
        id: "welcome",
        label: t("dash.wWelcome"),
        description: t("dash.wWelcomeDesc"),
      },
      {
        id: "notifications",
        label: t("dash.wNotifications"),
        description: t("dash.wNotificationsDesc"),
      },
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
        id: "tickets",
        label: t("dash.wTickets"),
        description: t("dash.wTicketsDesc"),
      },
      {
        id: "teammates",
        label: t("dash.wTeammates"),
        description: t("dash.wTeammatesDesc"),
      },
      {
        id: "quickLinks",
        label: t("dash.wQuickLinks"),
        description: t("dash.wQuickLinksDesc"),
      },
    ],
    [t],
  );

  const labelFor = (id: ClientWidgetId) =>
    widgetMeta.find((w) => w.id === id)?.label ?? id;

  const move = (id: ClientWidgetId, dir: -1 | 1) => {
    persist({ ...layout, order: moveInOrder(layout.order, id, dir) });
  };

  const toggle = (id: ClientWidgetId) => {
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

  const renderWidget = (id: ClientWidgetId, index: number) => {
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
      case "welcome":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.05}>
              <div
                className={cn(
                  "rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 via-card to-card",
                  compact ? "p-4 sm:p-5" : "p-6 sm:p-8",
                )}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                      {t("clientDash.zone")}
                    </p>
                    <h2
                      className={cn(
                        "mt-2 font-extrabold tracking-tight",
                        compact
                          ? "text-xl sm:text-2xl"
                          : "text-2xl sm:text-3xl",
                      )}
                    >
                      {t("clientDash.welcome", {
                        name: user?.name.split(" ")[0] ?? "",
                      })}
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
                      {t("clientDash.intro")}
                    </p>
                  </div>
                  <DashboardCustomizeButton
                    active={editing}
                    onClick={() => setEditing((v) => !v)}
                    className="shrink-0 self-start"
                  />
                </div>
              </div>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "notifications":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.07}>
              <NotificationBanner
                permission={permission}
                onPermissionChange={refreshPermission}
              />
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "stats":
        return (
          <DashboardWidgetFrame key={id} {...frameProps}>
            <BlurFade delay={0.1}>
              <div
                className={cn(
                  "grid gap-4",
                  layout.statsColumns === 2
                    ? "sm:grid-cols-2"
                    : "sm:grid-cols-2 xl:grid-cols-4",
                )}
              >
                <StatCard
                  label={t("clientDash.boardMessages")}
                  value={messages.length}
                  icon={<Bell className="size-5" />}
                  hint={t("clientDash.fromSolu")}
                />
                <StatCard
                  label={t("clientDash.unread")}
                  value={unreadCount}
                  icon={<Bell className="size-5" />}
                  hint={
                    unreadCount > 0
                      ? t("clientDash.needsAttention")
                      : t("clientDash.caughtUp")
                  }
                />
                <StatCard
                  label={t("clientDash.openTickets")}
                  value={openTickets}
                  icon={<Ticket className="size-5" />}
                  hint={t("clientDash.yoursOnly")}
                />
                <StatCard
                  label={t("clientDash.zoneUsers")}
                  value={teammates.length}
                  icon={<Users className="size-5" />}
                  hint={t("clientDash.sameCompany")}
                />
              </div>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "messages":
        return (
          <DashboardWidgetFrame key={id} {...frameProps} className="lg:col-span-3">
            <BlurFade delay={0.12}>
              <Card className="h-full">
                <CardHeader
                  className={cn(
                    "flex flex-row items-start justify-between gap-4 space-y-0",
                    compact && "p-4 pb-2",
                  )}
                >
                  <div>
                    <CardTitle>{t("clientDash.latestFrom")}</CardTitle>
                    <CardDescription>
                      {t("clientDash.latestDesc")}
                    </CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/client/board">
                      {t("clientDash.fullBoard")}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent
                  className={cn("space-y-3", compact && "p-4 pt-0")}
                >
                  {latest.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      {t("clientDash.noMessages")}
                    </p>
                  ) : (
                    latest.map((m) => (
                      <div
                        key={m.id}
                        className={cn(
                          "rounded-lg border border-border bg-card/60",
                          compact ? "p-3" : "p-4",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {m.readStatus === "unread" && (
                            <span className="size-2 rounded-full bg-primary" />
                          )}
                          <p className="font-semibold">{m.title}</p>
                          {m.pinned && (
                            <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                              <Pin className="mr-1 size-3" />
                              {t("board.pinned")}
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={
                              m.readStatus === "unread"
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : ""
                            }
                          >
                            {m.readStatus === "unread"
                              ? t("board.unread")
                              : t("board.read")}
                          </Badge>
                          {m.customLabel && (
                            <Badge variant="outline">{m.customLabel}</Badge>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                          {m.body}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {m.author_name} · {formatDate(m.created_at)}
                        </p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "tickets":
        return (
          <DashboardWidgetFrame key={id} {...frameProps} className="lg:col-span-2">
            <BlurFade delay={0.14}>
              <Card className="h-full">
                <CardHeader
                  className={cn(
                    "flex flex-row items-start justify-between gap-4 space-y-0",
                    compact && "p-4 pb-2",
                  )}
                >
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Ticket className="size-5 text-primary" />
                      {t("clientDash.ticketsCard")}
                    </CardTitle>
                    <CardDescription>
                      {t("clientDash.ticketsDesc")}
                    </CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/client/tickets">
                      {t("clientDash.view")}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent className={cn(compact && "p-4 pt-0")}>
                  <p className="text-3xl font-bold tabular-nums tracking-tight">
                    {openTickets}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {openTickets === 0
                      ? t("clientDash.noTickets")
                      : t("clientDash.ticketsLinked")}
                  </p>
                </CardContent>
              </Card>
            </BlurFade>
          </DashboardWidgetFrame>
        );

      case "teammates":
        return (
          <DashboardWidgetFrame key={id} {...frameProps} className="lg:col-span-2">
            <BlurFade delay={0.16}>
              <Card className="h-full">
                <CardHeader
                  className={cn(
                    "flex flex-row items-start justify-between gap-4 space-y-0",
                    compact && "p-4 pb-2",
                  )}
                >
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Building2 className="size-5 text-primary" />
                      {t("clientDash.teammates")}
                    </CardTitle>
                    <CardDescription>
                      {t("clientDash.teammatesDesc")}
                    </CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/client/directory">{t("nav.directory")}</Link>
                  </Button>
                </CardHeader>
                <CardContent
                  className={cn("space-y-2", compact && "p-4 pt-0")}
                >
                  {teammates.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      {t("clientDash.noTeammates")}
                    </p>
                  ) : (
                    teammates.map((mate) => (
                      <Link
                        key={mate.id}
                        to={
                          mate.id === user?.id
                            ? "/client/profile/me"
                            : `/client/profile/${mate.id}`
                        }
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {mate.name}
                            {mate.id === user?.id && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({t("common.you")})
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {mate.email}
                          </p>
                        </div>
                      </Link>
                    ))
                  )}
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
                      to: "/client/board",
                      label: t("dash.linkBoard"),
                      icon: Bell,
                    },
                    {
                      to: "/client/tickets",
                      label: t("dash.linkTickets"),
                      icon: Ticket,
                    },
                    {
                      to: "/client/directory",
                      label: t("dash.linkDirectory"),
                      icon: Users,
                    },
                    {
                      to: "/client/profile/me",
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

  // Pair side-by-side widgets (messages spans 3, tickets/teammates span 2)
  // Render in order; use a simple flow grid for personalization.
  const orderedVisible = layout.order.filter(
    (id) => editing || isVisible(layout, id),
  );

  // When not editing, keep a nicer 5-col grid for messages + side column if adjacent
  const useClassicGrid =
    !editing &&
    orderedVisible.includes("messages") &&
    (orderedVisible.includes("tickets") ||
      orderedVisible.includes("teammates"));

  return (
    <div className={spaceY}>
      {/* Always show customize control if welcome is hidden */}
      {!isVisible(layout, "welcome") && !editing && (
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
          onMove={(id, dir) => move(id as ClientWidgetId, dir)}
          onToggle={(id) => toggle(id as ClientWidgetId)}
          onDensity={(d) => persist({ ...layout, density: d })}
          onStatsColumns={(n) => persist({ ...layout, statsColumns: n })}
          onReset={resetToDefault}
          description={
            companyDefault
              ? usingPersonal
                ? t("dash.customizeDescWithCompanyPersonal")
                : t("dash.customizeDescWithCompany")
              : t("dash.customizeDesc")
          }
          resetLabel={
            companyDefault ? t("dash.resetCompany") : t("dash.reset")
          }
          autoSaveHint={
            usingPersonal
              ? t("dash.autoSavePersonal")
              : companyDefault
                ? t("dash.usingCompanyDefault")
                : t("dash.autoSave")
          }
        />
      )}

      {useClassicGrid ? (
        <>
          {orderedVisible
            .filter(
              (id) =>
                id !== "messages" &&
                id !== "tickets" &&
                id !== "teammates",
            )
            .map((id) => renderWidget(id, layout.order.indexOf(id)))}

          <div className={cn("grid lg:grid-cols-5", gap)}>
            {orderedVisible.includes("messages") &&
              renderWidget("messages", layout.order.indexOf("messages"))}
            <div className={cn("flex flex-col lg:col-span-2", gap)}>
              {orderedVisible.includes("tickets") &&
                renderWidget("tickets", layout.order.indexOf("tickets"))}
              {orderedVisible.includes("teammates") &&
                renderWidget("teammates", layout.order.indexOf("teammates"))}
            </div>
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
