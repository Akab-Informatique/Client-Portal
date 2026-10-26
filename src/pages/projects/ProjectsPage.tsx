import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, BellRing, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, Flag, Folder, FolderOpen, Loader2, Plus, Search, SlidersHorizontal, Star, UserRound, X, type LucideIcon } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useCrmClients } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectDialog } from "./ProjectDialog";
import { dueTone, hoursText, KEY, MS_TONE, STATUS_STYLE, TONE_TEXT, today, useProjectPeople, type Project, type Summary, type Week } from "./shared";

type View = "mine" | "attention" | "watch" | "all";
const TILES: { key: Exclude<View, "all">; icon: LucideIcon; tone: string; glow: string }[] = [
  { key: "mine", icon: UserRound, tone: "text-primary", glow: "rgba(255,206,26,0.35)" },
  { key: "attention", icon: BellRing, tone: "text-red-400", glow: "rgba(239,68,68,0.38)" },
  { key: "watch", icon: Eye, tone: "text-amber-300", glow: "rgba(251,191,36,0.38)" },
];
const OPENED = "akab.projects.opened";
const readOpened = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(OPENED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/** Centre de commande › Projets: the same tiles, filters and weekly panel as Tickets, with a folder per project. */
export function ProjectsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
        return p;
      },
      { replace: true },
    );
  const view = (["mine", "attention", "watch", "all"].includes(params.get("view") ?? "") ? params.get("view") : "mine") as View;
  const status = params.get("status") === "done" ? "done" : params.get("status") === "all" ? "all" : "open";
  const lead = params.get("lead") ?? "";
  const client = params.get("client") ?? "";
  const q = params.get("q") ?? "";
  const openId = params.get("project");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => set({ q: search.trim() || null }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = new URLSearchParams({ view, status, ...(lead ? { lead } : {}), ...(client ? { client } : {}), ...(q ? { q } : {}) }).toString();
  const { data: list, isLoading } = useQuery({ queryKey: [...KEY, "list", query], queryFn: () => api.get<Project[]>(`/projects?${query}`), refetchInterval: 30_000 });
  const { data: summary } = useQuery({ queryKey: [...KEY, "summary"], queryFn: () => api.get<Summary>("/projects/summary"), refetchInterval: 30_000 });
  const { data: people = [] } = useProjectPeople();
  const { data: clients = [] } = useCrmClients();

  // every project starts folded; the ones opened are kept for the session
  const [opened, setOpened] = useState<Set<string>>(readOpened);
  const toggle = (ids: string[], close: boolean) =>
    setOpened((s) => {
      const next = new Set(s);
      for (const id of ids) (close ? next.delete(id) : next.add(id));
      try {
        sessionStorage.setItem(OPENED, JSON.stringify([...next]));
      } catch {
        /* the screen works without it */
      }
      return next;
    });
  const ids = (list ?? []).map((p) => p.id);
  const allOpen = ids.length > 0 && ids.every((id) => opened.has(id));

  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const follow = useMutation({
    mutationFn: (p: Project) => api.put(`/projects/${p.id}/follow`, { follow: !p.following }),
    onSuccess: refresh,
    onError: () => toast.error(t("common.error")),
  });
  const filtered = Boolean(lead || client || q || status !== "open");
  const canEdit = can("projects.edit");

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{t("projects.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("projects.subtitle")}</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            <Plus className="size-4" /> {t("projects.new")}
          </Button>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {/* the tiles */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
            {TILES.map((tile, i) => {
              const active = view === tile.key;
              const value = summary?.[tile.key];
              return (
                <Tooltip key={tile.key}>
                  <TooltipTrigger asChild>
                    <motion.button
                      type="button"
                      onClick={() => set({ view: tile.key === "mine" ? null : tile.key })}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      style={{ ["--tile-glow" as string]: tile.glow }}
                      className={cn(
                        "glass group flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-left transition-all hover:border-[color:var(--gold)]/40 hover:shadow-[0_0_20px_-12px_var(--tile-glow)]",
                        active && "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.06] shadow-[0_0_20px_-10px_var(--tile-glow)]",
                      )}
                    >
                      <tile.icon className={cn("size-4 shrink-0", tile.tone)} />
                      <span className="whitespace-nowrap text-xs font-medium">{t(`projects.metrics.${tile.key}`)}</span>
                      <span className={cn("font-mono text-base font-semibold tabular-nums", value ? "text-foreground" : "text-muted-foreground/50")}>{value ?? "–"}</span>
                    </motion.button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-64">
                    <p className="font-semibold">{t(`projects.metrics.${tile.key}`)}</p>
                    <p className="text-xs opacity-80">{t(`projects.tiles.${tile.key}`)}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
            <button
              type="button"
              onClick={() => set({ view: "all" })}
              className={cn("h-10 shrink-0 rounded-xl border border-transparent px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground", view === "all" && "border-[color:var(--gold)]/60 text-foreground")}
            >
              {t("projects.metrics.all")} {summary ? <span className="font-mono">{summary.open}</span> : null}
            </button>
          </div>

          {/* the filters */}
          <div className="glass space-y-3 rounded-2xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <SlidersHorizontal className="size-4 text-primary" /> {t("projects.filters.title")}
              </span>
              <span className="rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-2 py-0.5 text-[11px] font-medium text-primary">{t(`projects.metrics.${view}`)}</span>
              {filtered && (
                <button type="button" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => (setSearch(""), set({ lead: null, client: null, q: null, status: null }))}>
                  <X className="size-3" /> {t("projects.filters.reset")}
                </button>
              )}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("projects.search")} className="pl-9" />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Select value={lead || "any"} onValueChange={(v) => set({ lead: v === "any" ? null : v })}>
                <SelectTrigger aria-label={t("projects.filters.lead")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">{t("projects.filters.anyLead")}</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.id === me.id ? t("projects.filters.me", { name: p.name }) : p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={(v) => set({ status: v === "open" ? null : v })}>
                <SelectTrigger aria-label={t("projects.filters.status")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["open", "done", "all"] as const).map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`projects.filters.state.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={client || "any"} onValueChange={(v) => set({ client: v === "any" ? null : v })}>
                <SelectTrigger aria-label={t("projects.filters.client")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="any">{t("projects.filters.anyClient")}</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <WeekPanel onOpen={(id) => set({ project: id, tab: null })} />
      </div>

      {/* the projects: a folder each, milestones inside */}
      <div className="glass overflow-hidden rounded-2xl border">
        <div className="flex items-center gap-2 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <button
            type="button"
            disabled={!ids.length}
            onClick={() => toggle(ids, allOpen)}
            aria-label={allOpen ? t("projects.collapseAll") : t("projects.expandAll")}
            title={allOpen ? t("projects.collapseAll") : t("projects.expandAll")}
            className="rounded-md p-1 normal-case text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
          >
            {allOpen ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
          </button>
          <span className="flex-1 pl-12">{t("projects.col.project")}</span>
          <span className="hidden w-28 md:block">{t("projects.col.status")}</span>
          <span className="hidden w-40 lg:block">{t("projects.col.client")}</span>
          <span className="hidden w-32 md:block">{t("projects.col.progress")}</span>
          <span className="hidden w-24 text-right lg:block">{t("projects.col.hours")}</span>
          <span className="hidden w-20 text-right md:block">{t("projects.col.due")}</span>
          <span className="hidden w-32 xl:block">{t("projects.col.lead")}</span>
          <span className="w-8" />
        </div>
        {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
        {!isLoading && !list?.length && <p className="py-14 text-center text-sm text-muted-foreground">{filtered || view !== "all" ? t("projects.noneFiltered") : t("projects.none")}</p>}
        <ul className="divide-y divide-border/60">
          {(list ?? []).map((p) => {
            const isOpen = opened.has(p.id);
            const finished = p.status === "done" || p.status === "cancelled";
            const tone = dueTone(p.dueDate, finished);
            const pct = p.progress.total ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
            return (
              <li key={p.id} className="group/row relative">
                <span className={cn("absolute inset-y-0 left-0 w-0.5 transition-all group-hover/row:w-1", p.attention.length ? "bg-red-500/80" : finished ? "bg-muted-foreground/30" : "bg-[color:var(--gold)]/70")} />
                <div className="flex items-center gap-2 px-4 py-3 hover:bg-foreground/[0.03]">
                  <button type="button" aria-label={isOpen ? t("projects.collapse") : t("projects.expand")} aria-expanded={isOpen} onClick={() => toggle([p.id], isOpen)} className="rounded-md p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
                    <ChevronDown className={cn("size-4 transition-transform", !isOpen && "-rotate-90")} />
                  </button>
                  <button type="button" onClick={() => set({ project: p.id, tab: null })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
                      {isOpen ? <FolderOpen className="size-[18px] fill-[color:var(--gold)]/25" /> : <Folder className="size-[18px] fill-[color:var(--gold)]/20" />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">{p.number}</span>
                        <span className="truncate font-semibold">{p.name}</span>
                        {p.attention.length > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
                            </TooltipTrigger>
                            <TooltipContent side="top">{p.attention.map((a) => t(`projects.attention.${a}`)).join(" · ")}</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground md:hidden">{[p.client?.name, t(`projects.status.${p.status}`)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                  <span className="hidden w-28 md:block">
                    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[p.status])}>{t(`projects.status.${p.status}`)}</span>
                  </span>
                  <span className="hidden w-40 truncate text-sm text-muted-foreground lg:block">{p.client?.name ?? "—"}</span>
                  <span className="hidden w-32 md:block">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
                        <span className="block h-full rounded-full bg-grad-gold" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {p.progress.done}/{p.progress.total}
                      </span>
                    </span>
                  </span>
                  <span className={cn("hidden w-24 text-right font-mono text-xs tabular-nums lg:block", p.attention.includes("over_budget") && "text-red-400")}>
                    {hoursText(p.hours)}
                    {p.budgetHours != null && <span className="text-muted-foreground"> / {hoursText(p.budgetHours)}</span>}
                  </span>
                  <span className={cn("hidden w-20 text-right text-xs md:block", TONE_TEXT[tone])}>{p.dueDate ? shortDate(p.dueDate) : "—"}</span>
                  <span className="hidden w-32 truncate text-sm xl:block">{p.lead?.name ?? "—"}</span>
                  <button
                    type="button"
                    aria-label={p.following ? t("projects.unfollow") : t("projects.follow")}
                    title={p.following ? t("projects.unfollow") : t("projects.follow")}
                    onClick={() => follow.mutate(p)}
                    className={cn("rounded-md p-1.5 transition-colors hover:bg-foreground/[0.06]", p.following ? "text-amber-300" : "text-muted-foreground/60 hover:text-foreground")}
                  >
                    <Star className={cn("size-4", p.following && "fill-current")} />
                  </button>
                </div>

                {/* the milestones, folded in */}
                {isOpen && (
                  <div className="border-t border-border/40 bg-foreground/[0.02] py-1.5 pl-16 pr-4">
                    {p.milestones.length === 0 && <p className="py-2 text-xs text-muted-foreground">{t("projects.noMilestones")}</p>}
                    <ul>
                      {p.milestones.map((m) => {
                        const mt = dueTone(m.dueDate, m.status === "done");
                        return (
                          <li key={m.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/[0.04]">
                            <Flag className={cn("size-4 shrink-0", m.late ? "text-red-400" : MS_TONE[m.status], m.status === "done" && "fill-emerald-400/30")} aria-label={t(`projects.ms.${m.status}`)} />
                            <button type="button" onClick={() => set({ project: p.id, tab: "milestones", milestone: m.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                              <span className={cn("truncate", m.status === "done" && "text-muted-foreground line-through")}>{m.name}</span>
                              {m.tasksTotal > 0 && (
                                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                                  <span className="h-1 w-12 overflow-hidden rounded-full bg-foreground/10">
                                    <span className={cn("block h-full rounded-full", m.status === "done" ? "bg-emerald-400" : "bg-grad-gold")} style={{ width: `${Math.round((m.tasksDone / m.tasksTotal) * 100)}%` }} />
                                  </span>
                                  {m.tasksDone}/{m.tasksTotal}
                                </span>
                              )}
                            </button>
                            <span className="hidden w-24 text-right font-mono text-[11px] text-muted-foreground sm:block">
                              {hoursText(m.hours)}
                              {m.budgetHours != null && ` / ${hoursText(m.budgetHours)}`}
                            </span>
                            <span className={cn("w-16 text-right text-xs", TONE_TEXT[mt])}>{m.dueDate ? shortDate(m.dueDate) : "—"}</span>
                          </li>
                        );
                      })}
                    </ul>
                    {canEdit && <QuickMilestone project={p} onDone={refresh} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            refresh();
            setCreating(false);
            set({ project: id, tab: null });
          }}
        />
      )}
      {openId && <ProjectDialog id={openId} onClose={() => set({ project: null, tab: null, milestone: null })} tab={params.get("tab")} milestone={params.get("milestone")} onTab={(tab) => set({ tab })} />}
    </div>
  );
}

/** One field to add a milestone to a project, right in the list */
function QuickMilestone({ project, onDone }: { project: Project; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/milestones`, { name: name.trim() }),
    onSuccess: () => {
      setName("");
      onDone();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <form
      className="flex items-center gap-2 px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate();
      }}
    >
      <Plus className="size-4 text-muted-foreground" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects.addMilestone")} maxLength={200} className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
    </form>
  );
}

/** My week: the milestones and projects due each day, and my hours on projects. The overlay with the tickets' week comes later. */
function WeekPanel({ onOpen }: { onOpen: (projectId: string) => void }) {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: [...KEY, "week", from], queryFn: () => api.get<Week>(`/projects/week${from ? `?from=${from}` : ""}`), refetchInterval: 60_000 });
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const shift = (n: number) => {
    if (!data) return;
    const d = new Date(`${data.from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    setFrom(d.toISOString().slice(0, 10));
    setDay(null);
  };
  const days = useMemo(() => (data?.days ?? []).slice(0, 5), [data]);
  const now = today();
  const selected = data?.days.find((d) => d.date === (day ?? (data.days.some((x) => x.date === now) ? now : data.days[0]?.date))) ?? null;
  const weekName = (d: string) => new Intl.DateTimeFormat(loc, { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  return (
    <div className="glass rounded-2xl border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays className="size-4 text-primary" /> {t("projects.week.title")}
        </span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => shift(-7)} aria-label={t("projects.week.prev")}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground">{data ? new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${data.from}T12:00:00Z`)) : ""}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => shift(7)} aria-label={t("projects.week.next")}>
          <ChevronRight className="size-4" />
        </Button>
        {from && (
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => (setFrom(null), setDay(null))}>
            {t("projects.week.today")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {days.map((d) => {
          const n = d.milestones.length + d.projects.length;
          const on = selected?.date === d.date;
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => setDay(d.date)}
              className={cn("rounded-xl border px-1 py-2 text-center transition-colors hover:border-[color:var(--gold)]/40", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.06]" : "border-border/60 bg-card/40", d.date === now && "ring-1 ring-[color:var(--gold)]/40")}
            >
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{weekName(d.date)}</span>
              <span className="block font-mono text-lg font-semibold leading-tight">{Number(d.date.slice(8))}</span>
              <span className="block h-3.5 text-[10px] text-muted-foreground">{n ? t("projects.week.items", { count: n }) : d.hours ? hoursText(d.hours) : ""}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 min-h-12 space-y-1 text-sm">
        {selected && selected.milestones.length + selected.projects.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">{t("projects.week.none")}</p>}
        {selected?.projects.map((p) => (
          <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-foreground/[0.05]">
            <Folder className="size-3.5 text-primary" />
            <span className="font-mono text-[11px] text-muted-foreground">{p.number}</span>
            <span className="truncate">{p.name}</span>
            <span className="ml-auto text-[10px] uppercase text-red-300">{t("projects.week.dueProject")}</span>
          </button>
        ))}
        {selected?.milestones.map((m) => (
          <Fragment key={m.id}>
            <button type="button" onClick={() => onOpen(m.projectId)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-foreground/[0.05]">
              <Flag className="size-3.5 text-muted-foreground" />
              <span className="font-mono text-[11px] text-muted-foreground">{m.number}</span>
              <span className="truncate">{m.name}</span>
              <span className="ml-auto max-w-32 truncate text-[11px] text-muted-foreground">{m.project}</span>
            </button>
          </Fragment>
        ))}
        {selected && selected.hours > 0 && <p className="px-2 pt-1 text-[11px] text-muted-foreground">{t("projects.week.hours", { time: hoursText(selected.hours) })}</p>}
      </div>
    </div>
  );
}

