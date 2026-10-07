import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  Building2,
  Clock3,
  Database,
  Mail,
  Megaphone,
  Pin,
  Server,
  Settings2,
  Sparkles,
  Users,
  UsersRound,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { clock, longDate, relativeTime } from "@/lib/format";
import type { Message } from "@/lib/types";
import { LiveDot } from "@/components/brand/TechBackground";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { PermissionKey } from "@shared/permissions";

export type Summary = {
  counts: { clients: number; clientUsers: number; staff: number; messages: number; pinned: number };
  recentMessages: { id: string; title: string; pinned: boolean; audience: "all" | "selected"; createdAt: string }[];
  services: { database: "postgres" | "pglite"; email: boolean };
};

export function useSummary() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Summary>("/dashboard/summary"), refetchInterval: 60_000 });
}

export type WidgetDef = {
  type: string;
  icon: LucideIcon;
  defaultSize: "sm" | "md" | "lg";
  permission?: PermissionKey;
  render: () => ReactNode;
};

export const WIDGETS: WidgetDef[] = [
  { type: "welcome", icon: Sparkles, defaultSize: "lg", render: () => <WelcomeWidget /> },
  { type: "stats", icon: Activity, defaultSize: "lg", render: () => <StatsWidget /> },
  { type: "recentMessages", icon: Megaphone, defaultSize: "md", permission: "messages.view", render: () => <RecentMessagesWidget /> },
  { type: "quickActions", icon: Zap, defaultSize: "sm", render: () => <QuickActionsWidget /> },
  { type: "clock", icon: Clock3, defaultSize: "sm", render: () => <ClockWidget /> },
  { type: "pinned", icon: Pin, defaultSize: "sm", permission: "messages.view", render: () => <PinnedWidget /> },
  { type: "systemStatus", icon: Server, defaultSize: "sm", render: () => <SystemStatusWidget /> },
];

export const DEFAULT_LAYOUT = [
  { id: "w-welcome", type: "welcome", size: "lg" as const },
  { id: "w-stats", type: "stats", size: "lg" as const },
  { id: "w-recent", type: "recentMessages", size: "md" as const },
  { id: "w-actions", type: "quickActions", size: "sm" as const },
  { id: "w-clock", type: "clock", size: "sm" as const },
  { id: "w-status", type: "systemStatus", size: "sm" as const },
  { id: "w-pinned", type: "pinned", size: "sm" as const },
];

// ── building blocks ──────────────────────────────────────────────────────────
export function WidgetFrame({ title, icon: Icon, action, children, className }: { title: string; icon: LucideIcon; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("group/widget relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card/80 backdrop-blur", className)}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--gold)]/50 to-transparent opacity-0 transition-opacity group-hover/widget:opacity-100" />
      <div className="flex items-center gap-2 px-5 pt-4">
        <Icon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      <div className="flex-1 px-5 pb-5 pt-3">{children}</div>
    </div>
  );
}

function CountUp({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    const c = animate(mv, value, { duration: 1.1, ease: [0.22, 1, 0.36, 1] });
    return () => c.stop();
  }, [mv, value]);
  return <motion.span>{rounded}</motion.span>;
}

// ── widgets ──────────────────────────────────────────────────────────────────
function WelcomeWidget() {
  const { t } = useTranslation();
  const me = useMe();
  const { data } = useSummary();
  const h = new Date().getHours();
  const greet = h < 12 ? t("dashboard.greetingMorning") : h < 18 ? t("dashboard.greetingAfternoon") : t("dashboard.greetingEvening");
  return (
    <div className="relative h-full overflow-hidden rounded-2xl border bg-card p-6 sm:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full blur-3xl" style={{ background: "radial-gradient(circle, var(--glow), transparent 70%)" }} />
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-50 [mask-image:linear-gradient(to_left,black,transparent_70%)]" />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <LiveDot tone="gold" /> {longDate(new Date())}
          </p>
          <h2 className="mt-3 text-3xl font-extrabold sm:text-4xl">
            {greet}, <span className="text-grad-gold">{me.name.split(" ")[0]}</span>
          </h2>
          <p className="mt-2 text-muted-foreground">{t("dashboard.subtitle")}</p>
        </div>
        {data && (
          <div className="flex gap-6 font-mono text-sm">
            <div>
              <div className="text-2xl font-bold text-foreground"><CountUp value={data.counts.clients} /></div>
              <div className="text-xs text-muted-foreground">{t("dashboard.stats.clients")}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-foreground"><CountUp value={data.counts.pinned} /></div>
              <div className="text-xs text-muted-foreground">{t("messages.pinned")}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatsWidget() {
  const { t } = useTranslation();
  const { data, isLoading } = useSummary();
  const tiles = [
    { key: "clients", icon: Building2, value: data?.counts.clients },
    { key: "clientUsers", icon: UsersRound, value: data?.counts.clientUsers },
    { key: "staff", icon: Users, value: data?.counts.staff },
    { key: "messages", icon: Megaphone, value: data?.counts.messages },
  ] as const;
  return (
    <div className="grid h-full grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile, i) => (
        <motion.div
          key={tile.key}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06 }}
          className="group relative overflow-hidden rounded-2xl border bg-card/80 p-5 transition-colors hover:border-[color:var(--gold)]/40"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t(`dashboard.stats.${tile.key}`)}</span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-[color:var(--gold)]/10 text-primary">
              <tile.icon className="size-4" />
            </span>
          </div>
          <div className="mt-3 font-display text-3xl font-bold">
            {isLoading || tile.value === undefined ? <Skeleton className="h-9 w-16" /> : <CountUp value={tile.value} />}
          </div>
          <div className="pointer-events-none absolute -bottom-10 -right-10 size-28 rounded-full opacity-0 blur-2xl transition-opacity group-hover:opacity-100" style={{ background: "var(--glow)" }} />
        </motion.div>
      ))}
    </div>
  );
}

function MessageLine({ m }: { m: { id: string; title: string; pinned: boolean; audience: "all" | "selected"; createdAt: string } }) {
  const { t } = useTranslation();
  return (
    <li>
      <Link to="/messages" className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50">
        <span className={cn("mt-1 flex size-6 shrink-0 items-center justify-center rounded-md", m.pinned ? "bg-grad-gold text-[#1a1204]" : "bg-muted text-muted-foreground")}>
          {m.pinned ? <Pin className="size-3" /> : <Megaphone className="size-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{m.title}</span>
          <span className="text-xs text-muted-foreground">
            {m.audience === "all" ? t("messages.toAll") : t("messages.selectedClients")} · {relativeTime(m.createdAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

function RecentMessagesWidget() {
  const { t } = useTranslation();
  const { data, isLoading } = useSummary();
  return (
    <WidgetFrame
      title={t("dashboard.widgets.recentMessages")}
      icon={Megaphone}
      action={
        <Link to="/messages" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          {t("dashboard.viewAll")} <ArrowUpRight className="size-3" />
        </Link>
      }
    >
      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : data?.recentMessages.length ? (
        <ul className="-mx-2 space-y-0.5">{data.recentMessages.map((m) => <MessageLine key={m.id} m={m} />)}</ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("dashboard.noMessages")}</p>
      )}
    </WidgetFrame>
  );
}

function PinnedWidget() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ["messages"], queryFn: () => api.get<Message[]>("/messages") });
  const pinned = (data ?? []).filter((m) => m.pinned);
  return (
    <WidgetFrame title={t("dashboard.widgets.pinned")} icon={Pin}>
      {pinned.length ? (
        <ul className="-mx-2 space-y-0.5">{pinned.slice(0, 6).map((m) => <MessageLine key={m.id} m={m} />)}</ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("dashboard.noMessages")}</p>
      )}
    </WidgetFrame>
  );
}

function QuickActionsWidget() {
  const { t } = useTranslation();
  const can = useCan();
  const me = useMe();
  const [, setParams] = useSearchParams();
  const actions = [
    can("messages.post") && { label: t("palette.newMessage"), icon: Megaphone, to: "/messages?compose=1" },
    me.isAdmin && { label: t("palette.openAdmin"), icon: Settings2, onClick: () => setParams((p) => (p.set("admin", "home"), p)) },
  ].filter(Boolean) as { label: string; icon: LucideIcon; to?: string; onClick?: () => void }[];
  return (
    <WidgetFrame title={t("dashboard.widgets.quickActions")} icon={Zap}>
      <div className="grid gap-2">
        {actions.map((a) => {
          const inner = (
            <>
              <span className="flex size-8 items-center justify-center rounded-lg bg-grad-gold text-[#1a1204]">
                <a.icon className="size-4" />
              </span>
              <span className="text-sm font-medium">{a.label}</span>
              <ArrowUpRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
            </>
          );
          const cls = "group flex items-center gap-3 rounded-xl border bg-background/40 p-2.5 text-left transition-colors hover:border-[color:var(--gold)]/40";
          return a.to ? (
            <Link key={a.label} to={a.to} className={cls}>{inner}</Link>
          ) : (
            <button key={a.label} type="button" onClick={a.onClick} className={cls}>{inner}</button>
          );
        })}
        <div className="flex items-center justify-between rounded-xl border border-dashed p-2.5 text-xs text-muted-foreground">
          {t("topbar.search")} <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px]">Ctrl K</kbd>
        </div>
      </div>
    </WidgetFrame>
  );
}

function ClockWidget() {
  const { t } = useTranslation();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <WidgetFrame title={t("dashboard.widgets.clock")} icon={Clock3}>
      <div className="flex h-full flex-col justify-center">
        <div className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-grad-gold">{clock(now)}</div>
        <div className="mt-1 text-sm text-muted-foreground first-letter:uppercase">{longDate(now)}</div>
        <div className="mt-3 text-xs text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
      </div>
    </WidgetFrame>
  );
}

function SystemStatusWidget() {
  const { t } = useTranslation();
  const { data } = useSummary();
  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const s = performance.now();
      try {
        await api.get("/health");
        if (alive) setLatency(Math.round(performance.now() - s));
      } catch {
        if (alive) setLatency(-1);
      }
    };
    void ping();
    const i = setInterval(ping, 30_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);
  const rows = [
    { icon: Server, label: t("dashboard.portalApi"), ok: latency !== -1, value: latency && latency > 0 ? `${latency} ms` : t("dashboard.online") },
    { icon: Database, label: t("dashboard.database"), ok: Boolean(data), value: data?.services.database === "postgres" ? "PostgreSQL" : "PGlite (dev)" },
    { icon: Mail, label: t("dashboard.email"), ok: Boolean(data?.services.email), value: data?.services.email ? "SMTP" : "Console (dev)" },
  ];
  return (
    <WidgetFrame title={t("dashboard.widgets.systemStatus")} icon={Activity}>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2 text-sm">
            <r.icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{r.label}</span>
            <span className="font-mono text-xs text-muted-foreground">{r.value}</span>
            <span className={cn("size-2 rounded-full", r.ok ? "bg-success" : "bg-amber-500")} />
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
