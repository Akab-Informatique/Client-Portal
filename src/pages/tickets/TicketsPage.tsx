import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { toast } from "sonner";
import {
  AlarmClock,
  ArrowDownUp,
  Bookmark,
  BookmarkPlus,
  CalendarRange,
  Check,
  ChevronDown,
  Eye,
  Flame,
  FlaskConical,
  Hourglass,
  Inbox,
  Layers,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  UserX,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { NewTicketDialog } from "./NewTicketDialog";
import { dueState, FILTER_KEYS, PRIORITY_STYLE, shortDate, STATUS_STYLE, useTickets, VIEWS, type TicketList, type TicketSummary, type View } from "./shared";
import { useTicketWorkspace } from "./workspace";

type Saved = { id: string; name: string; query: string };
type SetFn = (patch: Record<string, string | null>) => void;

/** Same filters = same string: query string with sorted keys, without the open ticket. */
function canonical(p: URLSearchParams | string) {
  const src = new URLSearchParams(p);
  src.delete("ticket");
  return new URLSearchParams([...src].sort(([a], [b]) => a.localeCompare(b))).toString();
}

/**
 * Tickets: key figures on top (click = filter), one toolbar (view menu with
 * saved filters, search, filters, dates, sort) and the list. A ticket opens
 * full screen and can be minimized to the dock.
 */
export function TicketsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const ws = useTicketWorkspace();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.includes(params.get("view") as View) ? params.get("view") : "mine") as View;
  const { data, isLoading, dataUpdatedAt, isFetching } = useTickets(view, params);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const set: SetFn = (patch) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );
  /** Replace the whole query (view + filters), e.g. from a tile or a saved filter. */
  const apply = (query: string) => setParams(new URLSearchParams(query), { replace: true });
  const activeFilters = FILTER_KEYS.filter((k) => k !== "sort" && k !== "q" && params.get(k));

  // Deep link from elsewhere (?ticket=<id>): open it full screen
  useEffect(() => {
    const id = Number(params.get("ticket"));
    if (id) {
      ws.open(id);
      set({ ticket: null });
    }
  }, [params]);

  // Shortcuts: "/" search, "n" new ticket (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && can("tickets.edit") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [can]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{t("tickets.title")}</h1>
          <LiveBadge updatedAt={dataUpdatedAt} fetching={isFetching} />
          {data?.demo && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 border-dashed text-muted-foreground">
                  <FlaskConical className="size-3" /> {t("tickets.demo")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t("tickets.demoHint")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {can("tickets.edit") && (
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <Plus className="size-4" /> {t("tickets.new")}
            <kbd className="ml-1 rounded border border-black/20 px-1 font-mono text-[10px] opacity-70">N</kbd>
          </Button>
        )}
      </div>

      <MetricTiles data={data} params={params} apply={apply} />

      {/* Toolbar */}
      <div className="rounded-2xl border bg-card/60 p-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <ViewMenu view={view} counts={data?.counts} params={params} apply={apply} />
          <div className="relative min-w-52 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={params.get("q") ?? ""}
              onChange={(e) => set({ q: e.target.value || null })}
              placeholder={t("tickets.search")}
              className="h-9 border-transparent bg-background/60 pl-9 pr-8"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
          </div>
          {data && (
            <>
              <MultiFilter label={t("tickets.fields.status")} param="status" options={data.facets.statuses.map((s) => ({ value: s, label: t(`tickets.status.${s}`) }))} params={params} set={set} />
              <MultiFilter
                label={t("tickets.fields.priority")}
                param="priority"
                options={data.facets.priorities.map((p) => ({ value: p, label: t(`tickets.priority.${p}`), dot: PRIORITY_STYLE[p].dot }))}
                params={params}
                set={set}
              />
              <MultiFilter label={t("tickets.fields.company")} param="company" options={data.facets.companies.map((c) => ({ value: String(c.id), label: c.name }))} params={params} set={set} searchable />
              <MultiFilter label={t("tickets.fields.queue")} param="queue" options={data.facets.queues.map((q) => ({ value: q, label: q }))} params={params} set={set} />
              <DatesFilter params={params} set={set} />
            </>
          )}
          <div className="ml-auto">
            <SortMenu value={params.get("sort") ?? "due"} onChange={(v) => set({ sort: v === "due" ? null : v })} />
          </div>
        </div>
        {activeFilters.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t px-1 pt-2">
            {activeFilters.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => set({ [k]: null })}
                className="flex items-center gap-1 rounded-full border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.06] px-2.5 py-1 text-xs hover:border-destructive/50"
              >
                {t(`tickets.filter.${k}`)}: <span className="font-medium">{filterLabel(k, params.get(k)!, data, t)}</span>
                <X className="size-3 text-muted-foreground" />
              </button>
            ))}
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => set(Object.fromEntries(activeFilters.map((k) => [k, null])))}>
              {t("tickets.clearFilters")}
            </Button>
          </div>
        )}
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-2xl border bg-card/70 backdrop-blur">
        <div className="hidden grid-cols-[minmax(0,1fr)_150px_110px_150px_90px_140px_28px] gap-4 border-b bg-background/40 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground lg:grid">
          <span>{t("tickets.fields.ticket")}</span>
          <span>{t("tickets.fields.status")}</span>
          <span>{t("tickets.fields.priority")}</span>
          <span>{t("tickets.fields.assignee")}</span>
          <span className="flex items-center gap-1">
            {t("tickets.fields.start")} <PortalTag />
          </span>
          <span>{t("tickets.fields.due")}</span>
          <span />
        </div>
        {isLoading || !data ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <Inbox className="size-8 opacity-50" />
            {activeFilters.length || params.get("q") ? t("tickets.emptyFiltered") : t(`tickets.empty.${view}`)}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.items.map((tk, i) => (
              <TicketRow key={tk.id} tk={tk} index={i} active={tk.id === ws.openId || ws.docked.some((d) => d.id === tk.id)} onOpen={() => ws.open(tk.id)} />
            ))}
          </ul>
        )}
        {data && data.items.length > 0 && (
          <div className="border-t bg-background/40 px-5 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("tickets.shown", { count: data.items.length })}
          </div>
        )}
      </div>

      {data && <NewTicketDialog open={creating} onOpenChange={setCreating} facets={data.facets} onCreated={(id) => ws.open(id)} />}
    </div>
  );
}

// ── Header bits ─────────────────────────────────────────────────────────────────
function LiveBadge({ updatedAt, fetching }: { updatedAt: number; fetching: boolean }) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  return (
    <span className="flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/[0.07] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-300">
      <span className="relative flex size-2">
        <span className={cn("absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75", fetching && "animate-ping")} />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
      </span>
      {t("tickets.live")} · {relativeTime(new Date(updatedAt))}
    </span>
  );
}

function PortalTag() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="rounded border border-[color:var(--gold)]/40 px-1 font-sans text-[9px] font-semibold normal-case tracking-normal text-primary">{t("tickets.portalTag")}</span>
      </TooltipTrigger>
      <TooltipContent>{t("tickets.portalHint")}</TooltipContent>
    </Tooltip>
  );
}

// ── Metric tiles ───────────────────────────────────────────────────────────────
const OPEN = "new,inProgress,waitingCustomer,waitingVendor,scheduled";
const TILES: { key: keyof TicketList["metrics"]; icon: LucideIcon; tone: string; glow: string; query: string }[] = [
  { key: "mine", icon: UserRound, tone: "text-primary", glow: "rgba(255,206,26,0.35)", query: "view=mine" },
  { key: "overdue", icon: AlarmClock, tone: "text-red-400", glow: "rgba(239,68,68,0.35)", query: "view=mine&due=overdue" },
  { key: "dueToday", icon: Hourglass, tone: "text-orange-400", glow: "rgba(249,115,22,0.35)", query: "view=mine&due=today" },
  { key: "critical", icon: Flame, tone: "text-rose-400", glow: "rgba(244,63,94,0.35)", query: `view=all&priority=critical,high&status=${OPEN}` },
  { key: "unassigned", icon: UserX, tone: "text-sky-400", glow: "rgba(56,189,248,0.35)", query: "view=unassigned" },
  { key: "newToday", icon: Sparkles, tone: "text-violet-400", glow: "rgba(167,139,250,0.35)", query: "view=all&created=today" },
];

function MetricTiles({ data, params, apply }: { data: TicketList | undefined; params: URLSearchParams; apply: (q: string) => void }) {
  const { t } = useTranslation();
  const current = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete("sort");
    return canonical(p);
  }, [params]);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {TILES.map((tile, i) => {
        const active = canonical(tile.query) === current || (tile.key === "mine" && current === "");
        const value = data?.metrics[tile.key];
        return (
          <motion.button
            key={tile.key}
            type="button"
            onClick={() => apply(tile.query)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{ ["--tile-glow" as string]: tile.glow }}
            className={cn(
              "group relative flex aspect-[5/4] flex-col justify-between overflow-hidden rounded-2xl border bg-card/70 p-4 text-left backdrop-blur transition-all hover:-translate-y-0.5 hover:border-[color:var(--gold)]/40 hover:shadow-[0_0_32px_-12px_var(--tile-glow)] sm:aspect-square xl:aspect-[1/0.95]",
              active && "border-[color:var(--gold)]/60 shadow-[0_0_32px_-10px_var(--tile-glow)]",
            )}
          >
            <span className="pointer-events-none absolute inset-0 bg-grid opacity-[0.35] [mask-image:radial-gradient(circle_at_100%_0%,black,transparent_70%)]" />
            <span className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full opacity-0 blur-2xl transition-opacity group-hover:opacity-100" style={{ background: tile.glow }} />
            <span className="relative flex items-center justify-between">
              <span className={cn("flex size-9 items-center justify-center rounded-xl border bg-background/60", tile.tone)}>
                <tile.icon className="size-4" />
              </span>
              {active && <span className="size-1.5 rounded-full bg-[color:var(--gold)] shadow-[0_0_8px_var(--gold)]" />}
            </span>
            <span className="relative">
              <span className={cn("block font-mono text-4xl font-semibold tabular-nums tracking-tight", value ? "text-foreground" : "text-muted-foreground/60")}>
                {value === undefined ? "–" : <CountUp value={value} />}
              </span>
              <span className="mt-1 block text-xs font-medium leading-tight">{t(`tickets.metrics.${tile.key}`)}</span>
              <span className="block text-[10px] text-muted-foreground">{t(`tickets.metricsHint.${tile.key}`)}</span>
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

function CountUp({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v).toString());
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.8, ease: [0.22, 1, 0.36, 1] });
    return () => c.stop();
  }, [mv, value]);
  return <motion.span>{rounded}</motion.span>;
}

// ── View menu: built-in views + my saved filters ──────────────────────────────────
const VIEW_ICON: Record<View, LucideIcon> = { mine: UserRound, unassigned: UserX, due: AlarmClock, all: Layers };

function ViewMenu({ view, counts, params, apply }: { view: View; counts?: TicketList["counts"]; params: URLSearchParams; apply: (q: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const { data: saved = [] } = useQuery({ queryKey: ["tickets", "filters"], queryFn: () => api.get<Saved[]>("/tickets/filters") });
  const currentQuery = useMemo(() => canonical(params), [params]);
  const activeSaved = saved.find((s) => canonical(s.query) === currentQuery);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/tickets/filters/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets", "filters"] }),
  });
  const Icon = activeSaved ? Bookmark : VIEW_ICON[view];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-9 gap-2 border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.06] font-semibold">
            <Icon className="size-4 text-primary" />
            <span className="max-w-40 truncate">{activeSaved ? activeSaved.name : t(`tickets.views.${view}`)}</span>
            {!activeSaved && counts && <span className="rounded-full bg-muted px-1.5 font-mono text-[10px]">{counts[view]}</span>}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("tickets.viewsTitle")}</DropdownMenuLabel>
          {VIEWS.map((v) => {
            const VIcon = VIEW_ICON[v];
            return (
              <DropdownMenuItem key={v} onSelect={() => apply(v === "mine" ? "" : `view=${v}`)} className="gap-3">
                <VIcon className="size-4" />
                <span className="flex-1">{t(`tickets.views.${v}`)}</span>
                {counts && <span className="font-mono text-[11px] text-muted-foreground">{counts[v]}</span>}
                {!activeSaved && view === v && currentQuery.replace(/(^|&)view=[^&]*/, "") === "" && <Check className="size-4 text-primary" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("tickets.myFilters")}</DropdownMenuLabel>
          {saved.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("tickets.noSavedFilters")}</p>}
          {saved.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => apply(s.query)} className="group gap-3">
              <Bookmark className="size-4" />
              <span className="flex-1 truncate">{s.name}</span>
              {activeSaved?.id === s.id && <Check className="size-4 text-primary" />}
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove.mutate(s.id);
                }}
                className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 group-focus:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaving(true)} className="gap-3 text-primary focus:text-primary" disabled={Boolean(activeSaved)}>
            <BookmarkPlus className="size-4" /> {t("tickets.saveFilter")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveFilterDialog open={saving} onClose={() => setSaving(false)} query={currentQuery} onSaved={(s) => apply(s.query)} />
    </>
  );
}

function SaveFilterDialog({ open, onClose, query, onSaved }: { open: boolean; onClose: () => void; query: string; onSaved: (s: Saved) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const save = useMutation({
    mutationFn: () => api.post<Saved>("/tickets/filters", { name, query }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["tickets", "filters"] });
      toast.success(t("tickets.filterSaved", { name: s.name }));
      onSaved(s);
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkPlus className="size-5 text-primary" /> {t("tickets.saveFilter")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tickets.filterNamePlaceholder")} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── List row ─────────────────────────────────────────────────────────────────────
/** Share of the time between creation and due date already used (0–1). */
function slaUsed(tk: TicketSummary) {
  const start = new Date(tk.createdAt).getTime();
  const end = new Date(tk.dueAt).getTime();
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

function TicketRow({ tk, index, active, onOpen }: { tk: TicketSummary; index: number; active: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const due = dueState(tk.dueAt, tk.status);
  const used = tk.status === "complete" ? 0 : slaUsed(tk);
  return (
    <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(index, 12) * 0.015 }}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group relative grid w-full grid-cols-1 gap-x-4 gap-y-2 px-5 py-3 text-left transition-colors lg:grid-cols-[minmax(0,1fr)_150px_110px_150px_90px_140px_28px] lg:items-center",
          "hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.07),transparent_60%)]",
          active && "bg-[linear-gradient(90deg,rgba(255,206,26,0.1),transparent_70%)]",
        )}
      >
        <span className={cn("absolute inset-y-2 left-0 w-1 rounded-r-full transition-all group-hover:inset-y-1", PRIORITY_STYLE[tk.priority].bar)} />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground group-hover:text-primary">{tk.number}</span>
            <span className="truncate font-medium">{tk.title}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {tk.company.name}
            {tk.contact && ` · ${tk.contact}`}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 lg:contents">
          <span>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[tk.status])}>
              <span className="size-1.5 rounded-full bg-current" />
              {t(`tickets.status.${tk.status}`)}
            </span>
          </span>
          <span className={cn("flex items-center gap-1.5 text-xs font-medium", PRIORITY_STYLE[tk.priority].text)}>
            <span className={cn("size-2 rounded-full", PRIORITY_STYLE[tk.priority].dot, tk.priority === "critical" && "shadow-[0_0_8px] shadow-red-500")} />
            {t(`tickets.priority.${tk.priority}`)}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs">
            {tk.assignee ? (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background/60 text-[10px] font-semibold">{initials(tk.assignee.name)}</span>
                <span className="truncate">{tk.assignee.name}</span>
              </>
            ) : (
              <span className="italic text-muted-foreground">{t("tickets.unassigned")}</span>
            )}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{tk.startDate ? shortDate(tk.startDate) : "—"}</span>
          <span className="min-w-0">
            <span
              className={cn(
                "block font-mono text-xs font-medium tabular-nums",
                due === "overdue" ? "text-destructive" : due === "today" ? "text-orange-400" : due === "soon" ? "text-primary" : "text-muted-foreground",
              )}
            >
              {due === "overdue" ? t("tickets.overdue") : due === "today" ? t("tickets.today") : shortDate(tk.dueAt)}
            </span>
            {tk.status !== "complete" && (
              <span className="mt-1 block h-1 w-full max-w-28 overflow-hidden rounded-full bg-muted" title={t("tickets.slaUsed", { pct: Math.round(used * 100) })}>
                <span
                  className={cn("block h-full rounded-full", used >= 1 ? "bg-red-500" : used > 0.75 ? "bg-orange-400" : used > 0.5 ? "bg-[#ffce1a]" : "bg-emerald-400")}
                  style={{ width: `${Math.max(4, used * 100)}%` }}
                />
              </span>
            )}
          </span>
          <span className="flex justify-end">
            {tk.viewers.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative flex size-6 items-center justify-center text-orange-400">
                    <span className="absolute inset-0 animate-ping rounded-full bg-orange-400/20" />
                    <Eye className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("tickets.openBy", { names: tk.viewers.map((v) => v.name).join(", ") })}</TooltipContent>
              </Tooltip>
            )}
          </span>
        </span>
      </button>
    </motion.li>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────────
function FilterButton({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("h-9 gap-1.5", count > 0 && "bg-[color:var(--gold)]/10 text-primary")}>
          {label}
          {count > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{count}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MultiFilter({
  label,
  param,
  options,
  params,
  set,
  searchable,
}: {
  label: string;
  param: string;
  options: { value: string; label: string; dot?: string }[];
  params: URLSearchParams;
  set: SetFn;
  searchable?: boolean;
}) {
  const { t } = useTranslation();
  const selected = useMemo(() => (params.get(param) ?? "").split(",").filter(Boolean), [params, param]);
  const [q, setQ] = useState("");
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    set({ [param]: next.join(",") || null });
  };
  return (
    <FilterButton label={label} count={selected.length}>
      {searchable && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="mb-1 h-8" />}
      <div className="max-h-72 overflow-y-auto">
        {shown.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
            {o.dot && <span className={cn("size-2 rounded-full", o.dot)} />}
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <Button variant="ghost" size="sm" className="mt-1 h-7 w-full text-xs text-muted-foreground" onClick={() => set({ [param]: null })}>
          {t("tickets.clear")}
        </Button>
      )}
    </FilterButton>
  );
}

/** Due date (Autotask) and start date (portal only) ranges. */
function DatesFilter({ params, set }: { params: URLSearchParams; set: SetFn }) {
  const { t } = useTranslation();
  const keys = ["dueFrom", "dueTo", "startFrom", "startTo"] as const;
  const count = keys.filter((k) => params.get(k)).length;
  const today = new Date().toISOString().slice(0, 10);
  const Range = ({ from, to, title, tag }: { from: (typeof keys)[number]; to: (typeof keys)[number]; title: string; tag?: boolean }) => (
    <div className="space-y-1.5 p-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        {title} {tag && <PortalTag />}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" aria-label={`${title} — ${t("tickets.from")}`} value={params.get(from) ?? ""} onChange={(e) => set({ [from]: e.target.value || null })} className="h-8 text-xs" />
        <Input type="date" aria-label={`${title} — ${t("tickets.to")}`} value={params.get(to) ?? ""} onChange={(e) => set({ [to]: e.target.value || null })} className="h-8 text-xs" />
      </div>
      <div className="flex gap-1">
        <QuickRange label={t("tickets.quick.today")} onClick={() => set({ [from]: today, [to]: today })} />
        <QuickRange label={t("tickets.quick.week")} onClick={() => set({ [from]: today, [to]: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) })} />
        <QuickRange label={t("tickets.quick.clear")} onClick={() => set({ [from]: null, [to]: null })} />
      </div>
    </div>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("h-9 gap-1.5", count > 0 && "bg-[color:var(--gold)]/10 text-primary")}>
          <CalendarRange className="size-4" /> {t("tickets.dates")}
          {count > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{count}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 divide-y p-1.5">
        <Range from="startFrom" to="startTo" title={t("tickets.fields.start")} tag />
        <Range from="dueFrom" to="dueTo" title={t("tickets.fields.due")} />
      </PopoverContent>
    </Popover>
  );
}

function QuickRange({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
      {label}
    </button>
  );
}

function SortMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-muted-foreground">
          <ArrowDownUp className="size-4" /> {t(`tickets.sort.${value}`)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        {["due", "priority", "start", "updated"].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={cn("block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent", value === s && "font-semibold text-primary")}
          >
            {t(`tickets.sort.${s}`)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function filterLabel(key: string, value: string, data: TicketList | undefined, t: (k: string) => string) {
  const parts = value.split(",");
  switch (key) {
    case "status":
      return parts.map((p) => t(`tickets.status.${p}`)).join(", ");
    case "priority":
      return parts.map((p) => t(`tickets.priority.${p}`)).join(", ");
    case "company":
      return parts.map((p) => data?.facets.companies.find((c) => String(c.id) === p)?.name ?? p).join(", ");
    case "due":
      return t(`tickets.dueFilter.${value}`);
    case "created":
      return t("tickets.quick.today");
    case "dueFrom":
    case "dueTo":
    case "startFrom":
    case "startTo":
      return shortDate(value);
    default:
      return parts.join(", ");
  }
}
