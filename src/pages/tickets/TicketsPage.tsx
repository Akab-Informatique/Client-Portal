import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { toast } from "sonner";
import {
  AlarmClock,
  ArrowDownUp,
  BellRing,
  Bookmark,
  BookmarkPlus,
  SlidersHorizontal,
  CalendarCheck,
  Check,
  ChevronDown,
  Eye,
  FlaskConical,
  Inbox,
  Link2Off,
  Loader2,
  Layers,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Siren,
  Sparkles,
  Trash2,
  UserRound,
  UserX,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
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
import { useCan, useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { NewTicketDialog } from "./NewTicketDialog";
import { dueState, FILTER_KEYS, PRIORITY_STYLE, dueGlow, useChoiceText, shortDate, STATUS_STYLE, useTickets, VIEWS, type TicketList, type TicketSummary, type View, ticketErrorText } from "./shared";
import { useTicketWorkspace } from "./workspace";
import { GlobalSearch } from "./GlobalSearch";
import { AiSetupHint, InlinePick, useAiError } from "./TicketPanel";

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
  const txt = useChoiceText();
  const can = useCan();
  const ws = useTicketWorkspace();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.includes(params.get("view") as View) ? params.get("view") : "mine") as View;
  const { data, isLoading, dataUpdatedAt, isFetching, refetch } = useTickets(view, params);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  // Inline change from the list (status, priority, assignee)
  const patchTicket = useMutation({
    mutationFn: (p: { id: number; patch: RowPatch }) => api.patch(`/tickets/${p.id}`, p.patch),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", p.id] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
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
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold">{t("tickets.title")}</h1>
          <LiveBadge updatedAt={dataUpdatedAt} fetching={isFetching} onRefresh={() => void refetch()} />
          {data && !data.demo && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <PlugZap className="size-3 text-primary" /> Autotask
            </span>
          )}
          {data?.demo && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <FlaskConical className="size-3" /> {t("tickets.demo")}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("tickets.demoHint")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <GlobalSearch demo={Boolean(data?.demo)} />
          {can("tickets.ai") && data && (data.ai ? <AiPlanButton /> : <AiSetupHint label={t("tickets.ai.plan")} />)}
          {can("tickets.edit") && (
            <Button size="sm" onClick={() => setCreating(true)} className="h-9 bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
              <Plus className="size-4" /> {t("tickets.new")}
              <kbd className="ml-1 hidden rounded border border-black/20 px-1 font-mono text-[10px] opacity-70 sm:inline">N</kbd>
            </Button>
          )}
        </div>
      </div>

      {data?.notLinked && (
        <div className="flex items-start gap-3 rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-sm">
          <Link2Off className="mt-0.5 size-4 shrink-0 text-orange-300" />
          <span>
            <span className="font-medium text-orange-200">{t("tickets.notLinkedTitle")}</span> <span className="text-muted-foreground">{t("tickets.notLinkedText")}</span>
          </span>
        </div>
      )}
      <MetricTiles data={data} params={params} apply={apply} />

      {/* Toolbar: view, search, team, the two frequent filters, the rest under "More" */}
      <div className="glass flex flex-wrap items-center gap-1.5 rounded-2xl border p-1.5">
        <ViewMenu view={view} counts={data?.counts} params={params} apply={apply} />
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={params.get("q") ?? ""}
            onChange={(e) => set({ q: e.target.value || null })}
            placeholder={t("tickets.search")}
            className="h-9 border-transparent bg-white/5 pl-9 pr-8 dark:bg-white/[0.04]"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        </div>
        {data && (
          <>
            <TeamFilter technicians={data.facets.technicians} params={params} set={set} />
            <MultiFilter label={t("tickets.fields.status")} param="status" options={data.facets.statuses.map((s) => ({ value: s.value, label: txt.status(s) }))} params={params} set={set} />
            <MultiFilter label={t("tickets.fields.company")} param="company" options={data.facets.companies.map((c) => ({ value: String(c.id), label: c.name }))} params={params} set={set} searchable />
            <MoreFilters data={data} params={params} set={set} />
          </>
        )}
        <div className="ml-auto">
          <SortMenu value={params.get("sort") ?? "due"} onChange={(v) => set({ sort: v === "due" ? null : v })} />
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          {activeFilters.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => set({ [k]: null })}
              className="flex items-center gap-1 rounded-full border border-[color:var(--gold)]/25 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-foreground"
            >
              {t(`tickets.filter.${k}`)}: <span className="font-medium text-foreground">{filterLabel(k, params.get(k)!, data, t)}</span>
              <X className="size-3" />
            </button>
          ))}
          <button type="button" className="px-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => set(Object.fromEntries(activeFilters.map((k) => [k, null])))}>
            {t("tickets.clearFilters")}
          </button>
        </div>
      )}

      {/* List */}
      <div className="glass overflow-hidden rounded-2xl border">
        <div className="hidden grid-cols-[minmax(0,1fr)_144px_140px_64px_104px_86px_132px_64px_20px] gap-3 border-b border-[color:var(--glass-border)] bg-white/[0.02] px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground xl:grid">
          <span>{t("tickets.fields.ticket")}</span>
          <span>{t("tickets.fields.status")}</span>
          <span>{t("tickets.fields.company")}</span>
          <span className="flex items-center gap-1">
            {t("tickets.fields.start")} <PortalTag />
          </span>
          <span>{t("tickets.fields.due")}</span>
          <span>{t("tickets.fields.priority")}</span>
          <span>{t("tickets.fields.assignee")}</span>
          <span>{t("tickets.fields.secondary")}</span>
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
          <ul className="divide-y divide-[color:var(--glass-border)]">
            {data.items.map((tk, i) => (
              <TicketRow
                key={tk.id}
                tk={tk}
                index={i}
                active={tk.id === ws.openId || ws.docked.some((d) => d.id === tk.id)}
                onOpen={() => ws.open(tk.id)}
                facets={data.facets}
                editable={can("tickets.edit")}
                onPatch={(patch) => patchTicket.mutate({ id: tk.id, patch })}
                onHover={() => void qc.prefetchQuery({ queryKey: ["tickets", "detail", tk.id], queryFn: () => api.get(`/tickets/${tk.id}`), staleTime: 15_000 })}
              />
            ))}
          </ul>
        )}
        {data && data.items.length > 0 && (
          <div className="border-t border-[color:var(--glass-border)] bg-white/[0.02] px-5 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("tickets.shown", { count: data.items.length })}
          </div>
        )}
      </div>

      {data && <NewTicketDialog open={creating} onOpenChange={setCreating} facets={data.facets} onCreated={(id) => ws.open(id)} />}
    </div>
  );
}

// ── Header bits ─────────────────────────────────────────────────────────────────
/** "Updated 20 s ago" (the list refreshes by itself every 30 s) + a refresh button. */
function LiveBadge({ updatedAt, fetching, onRefresh }: { updatedAt: number; fetching: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="relative flex size-1.5">
        <span className={cn("absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75", fetching && "animate-ping")} />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      <span className="ml-0.5">{t("tickets.updated", { when: relativeTime(new Date(updatedAt)) })}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onRefresh}
            disabled={fetching}
            aria-label={t("tickets.refresh")}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={cn("size-3.5", fetching && "animate-spin")} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("tickets.refreshHint")}</TooltipContent>
      </Tooltip>
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
type TileKey = "mine" | "unassigned" | "attention" | "statusAttention";
const TILES: { key: TileKey; icon: LucideIcon; tone: string; glow: string; query: string }[] = [
  { key: "mine", icon: UserRound, tone: "text-primary", glow: "rgba(255,206,26,0.35)", query: "view=mine" },
  { key: "unassigned", icon: UserX, tone: "text-sky-400", glow: "rgba(56,189,248,0.35)", query: "view=unassigned" },
  { key: "statusAttention", icon: BellRing, tone: "text-amber-300", glow: "rgba(251,191,36,0.38)", query: "view=all&statusKind=needsAttention" },
  { key: "attention", icon: Siren, tone: "text-red-400", glow: "rgba(239,68,68,0.38)", query: "view=all&attention=1" },
];

function MetricTiles({ data, params, apply }: { data: TicketList | undefined; params: URLSearchParams; apply: (q: string) => void }) {
  const { t } = useTranslation();
  const current = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete("sort");
    return canonical(p);
  }, [params]);
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {TILES.map((tile, i) => {
        const active = canonical(tile.query) === current || (tile.key === "mine" && current === "");
        const value = data?.metrics[tile.key];
        const b = data?.metrics.attentionBreakdown;
        return (
          <Tooltip key={tile.key}>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                onClick={() => apply(tile.query)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                style={{ ["--tile-glow" as string]: tile.glow }}
                className={cn(
                  "glass group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border px-4 py-3.5 text-left transition-all hover:border-[color:var(--gold)]/40 hover:shadow-[0_0_28px_-14px_var(--tile-glow)]",
                  active && "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.05] shadow-[0_0_28px_-12px_var(--tile-glow)]",
                )}
              >
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background/60", tile.tone)}>
                  <tile.icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{t(`tickets.metrics.${tile.key}`)}</span>
                  {tile.key === "attention" && b ? (
                    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] leading-tight">
                      <span className="text-red-400">{t("tickets.breakdown.overdue", { count: b.overdue })}</span>
                      <span className="text-orange-400">{t("tickets.breakdown.dueToday", { count: b.dueToday })}</span>
                      <span className="text-rose-300">{t("tickets.breakdown.critical", { count: b.critical })}</span>
                    </span>
                  ) : (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t(`tickets.metricsHint.${tile.key}`)}</span>
                  )}
                </span>
                <span className={cn("font-mono text-3xl font-semibold tabular-nums", value ? "text-foreground" : "text-muted-foreground/50")}>
                  {value === undefined ? "–" : <CountUp value={value} />}
                </span>
              </motion.button>
            </TooltipTrigger>
            <TooltipContent>
              {t(`tickets.metricsHint.${tile.key}`)}
              {tile.key === "attention" && b && (
                <span className="block opacity-80">
                  {t("tickets.breakdown.overdue", { count: b.overdue })} · {t("tickets.breakdown.dueToday", { count: b.dueToday })} · {t("tickets.breakdown.critical", { count: b.critical })}
                </span>
              )}
            </TooltipContent>
          </Tooltip>
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
    onError: (e) => toast.error(ticketErrorText(t, e)),
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

type RowPatch = { status?: string; priority?: string; assigneeId?: string | null };

/** Keeps clicks inside an inline picker from opening the ticket (React events cross portals). */
const Stop = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex max-w-full" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    {children}
  </span>
);

function TicketRow({
  tk,
  index,
  active,
  onOpen,
  facets,
  editable,
  onPatch,
  onHover,
}: {
  tk: TicketSummary;
  index: number;
  active: boolean;
  onOpen: () => void;
  facets: TicketList["facets"];
  editable: boolean;
  onPatch: (patch: RowPatch) => void;
  onHover: () => void;
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const me = useMe();
  const due = dueState(tk.dueAt, tk.statusKind);
  const used = tk.statusKind === "complete" ? 0 : slaUsed(tk);
  // Load the ticket ahead only when the pointer rests on it (not when it just passes over)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(hoverTimer.current ?? undefined), []);
  return (
    <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(index, 12) * 0.015 }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onMouseEnter={() => {
          clearTimeout(hoverTimer.current ?? undefined);
          hoverTimer.current = setTimeout(onHover, 400);
        }}
        onMouseLeave={() => clearTimeout(hoverTimer.current ?? undefined)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--gold)]/50",
          "group relative isolate grid w-full grid-cols-1 gap-x-3 gap-y-1.5 px-5 py-2.5 text-left transition-colors xl:grid-cols-[minmax(0,1fr)_144px_140px_64px_104px_86px_132px_64px_20px] xl:items-center",
          "hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.07),transparent_60%)]",
          active && "bg-[linear-gradient(90deg,rgba(255,206,26,0.1),transparent_70%)]",
        )}
      >
        {/* Due date: a glowing hue fading out behind the number and title */}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-72 opacity-80 transition-opacity group-hover:opacity-100" style={dueGlow(tk.dueAt, tk.statusKind)} />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground group-hover:text-primary">{tk.number}</span>
            <span className="truncate font-medium">{tk.title}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{tk.excerpt || tk.company.name}</span>
        </span>
        <span className="flex flex-wrap items-center gap-2 xl:contents">
          <span>
            <Stop>
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.status")}
                value={tk.status}
                options={facets.statuses.map((s) => ({ value: s.value, label: txt.status(s) }))}
                onPick={(v) => onPatch({ status: v })}
                trigger={
                  <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[tk.statusKind])}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {txt.status({ label: tk.statusLabel, kind: tk.statusKind })}
                  </span>
                }
              />
            </Stop>
          </span>
          <span className="min-w-0 text-xs" title={tk.contact ? `${tk.company.name} · ${tk.contact}` : tk.company.name}>
            <span className="block truncate">{tk.company.name}</span>
            {tk.contact && <span className="block truncate text-[11px] text-muted-foreground">{tk.contact}</span>}
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
            {tk.statusKind !== "complete" && (
              <span className="mt-1 block h-1 w-full max-w-28 overflow-hidden rounded-full bg-muted" title={t("tickets.slaUsed", { pct: Math.round(used * 100) })}>
                <span
                  className={cn("block h-full rounded-full", used >= 1 ? "bg-red-500" : used > 0.75 ? "bg-orange-400" : used > 0.5 ? "bg-[#ffce1a]" : "bg-emerald-400")}
                  style={{ width: `${Math.max(4, used * 100)}%` }}
                />
              </span>
            )}
          </span>
          <span>
            <Stop>
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.priority")}
                value={tk.priority}
                options={facets.priorities.map((p) => ({ value: p.value, label: txt.priority(p), dot: PRIORITY_STYLE[p.kind].dot }))}
                onPick={(v) => onPatch({ priority: v })}
                trigger={
                  <span className={cn("flex items-center gap-1.5 px-1 text-xs font-medium", PRIORITY_STYLE[tk.priorityKind].text)}>
                    <span className={cn("size-2 rounded-full", PRIORITY_STYLE[tk.priorityKind].dot, tk.priority === "critical" && "shadow-[0_0_8px] shadow-red-500")} />
                    {txt.priority({ label: tk.priorityLabel, kind: tk.priorityKind })}
                  </span>
                }
              />
            </Stop>
          </span>
          <span className="min-w-0">
            <Stop>
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.assignee")}
                value={tk.assignee?.id ?? "none"}
                options={[{ value: "none", label: t("tickets.unassigned") }, ...facets.technicians.map((p) => ({ value: p.id, label: p.name }))]}
                onPick={(v) => onPatch({ assigneeId: v === "none" ? null : v })}
                trigger={
                  <span className="flex min-w-0 max-w-36 items-center gap-2 pr-1 text-xs">
                    {tk.assignee ? (
                      <>
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background/60 text-[10px] font-semibold">{initials(tk.assignee.name)}</span>
                        <span className="truncate">{tk.assignee.name}</span>
                      </>
                    ) : (
                      <span className="pl-1 italic text-muted-foreground">{t("tickets.unassigned")}</span>
                    )}
                  </span>
                }
              />
            </Stop>
          </span>
          <span className="flex min-w-0 items-center">
            {tk.secondary.length ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex -space-x-1.5">
                    {tk.secondary.slice(0, 3).map((p) => (
                      <span
                        key={p.id}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full border-2 border-card text-[9px] font-semibold",
                          p.id === me.id ? "bg-grad-gold text-[#1a1204]" : "bg-muted",
                        )}
                      >
                        {initials(p.name)}
                      </span>
                    ))}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {tk.secondary.map((p) => p.name).join(", ")}
                  {tk.secondary.some((p) => p.id === me.id) && <span className="block opacity-80">{t("tickets.youAreSecondary")}</span>}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-xs text-muted-foreground/60">—</span>
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
      </div>
    </motion.li>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────────
/** Top of every filter panel: its name and "Clear" (active when something is selected). */
function PanelHeader({ title, count, onClear }: { title: string; count: number; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mb-1 flex items-center justify-between gap-2 border-b px-2 pb-1.5 pt-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
      <button
        type="button"
        onClick={onClear}
        disabled={count === 0}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <X className="size-3" /> {t("tickets.clear")}
      </button>
    </div>
  );
}

function FilterButton({
  label,
  count,
  icon: Icon,
  children,
  wide,
  onClear,
}: {
  label: string;
  count: number;
  icon?: LucideIcon;
  children: ReactNode;
  wide?: boolean;
  onClear: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-9 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground", count > 0 && "bg-[color:var(--gold)]/10 text-primary hover:text-primary")}
        >
          {Icon && <Icon className="size-4" />}
          {label}
          {count > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{count}</span>}
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("p-1.5", wide ? "w-[22rem]" : "w-64")}>
        <PanelHeader title={label} count={count} onClear={onClear} />
        {children}
      </PopoverContent>
    </Popover>
  );
}

type Option = { value: string; label: string; dot?: string };

/** Checkbox list for one URL parameter (comma-separated values). */
function Checklist({ param, options, params, set, searchable, max = "max-h-72" }: { param: string; options: Option[]; params: URLSearchParams; set: SetFn; searchable?: boolean; max?: string }) {
  const { t } = useTranslation();
  const selected = useMemo(() => (params.get(param) ?? "").split(",").filter(Boolean), [params, param]);
  const [q, setQ] = useState("");
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    set({ [param]: next.join(",") || null });
  };
  return (
    <>
      {searchable && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="mb-1 h-8" />}
      <div className={cn("overflow-y-auto", max)}>
        {shown.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
            {o.dot && <span className={cn("size-2 rounded-full", o.dot)} />}
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function MultiFilter({ label, param, options, params, set, searchable }: { label: string; param: string; options: Option[]; params: URLSearchParams; set: SetFn; searchable?: boolean }) {
  const count = (params.get(param) ?? "").split(",").filter(Boolean).length;
  return (
    <FilterButton label={label} count={count} onClear={() => set({ [param]: null })}>
      <Checklist param={param} options={options} params={params} set={set} searchable={searchable} />
    </FilterButton>
  );
}

const MORE_KEYS = ["priority", "dueFrom", "dueTo", "startFrom", "startTo"] as const;

/** Less frequent filters in one panel: client, queue, start date, due date. */
function MoreFilters({ data, params, set }: { data: TicketList; params: URLSearchParams; set: SetFn }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const count = MORE_KEYS.filter((k) => params.get(k)).length;
  const [tab, setTab] = useState<"priority" | "dates">("priority");
  return (
    <FilterButton label={t("tickets.more")} count={count} icon={SlidersHorizontal} wide onClear={() => set(Object.fromEntries(MORE_KEYS.map((k) => [k, null])))}>
      <div className="mb-1 grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-0.5 text-xs">
        {(["priority", "dates"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn("rounded-md px-2 py-1 font-medium", tab === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {k === "dates" ? t("tickets.dates") : t("tickets.fields.priority")}
            {(k === "dates" ? ["dueFrom", "dueTo", "startFrom", "startTo"].some((x) => params.get(x)) : params.get(k)) && (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-[color:var(--gold)] align-middle" />
            )}
          </button>
        ))}
      </div>
      {tab === "dates" && (
        <div className="divide-y">
          <DateRange from="startFrom" to="startTo" title={t("tickets.fields.start")} tag params={params} set={set} />
          <DateRange from="dueFrom" to="dueTo" title={t("tickets.fields.due")} params={params} set={set} />
        </div>
      )}
      {tab === "priority" && (
        <Checklist param="priority" options={data.facets.priorities.map((p) => ({ value: p.value, label: txt.priority(p), dot: PRIORITY_STYLE[p.kind].dot }))} params={params} set={set} />
      )}
    </FilterButton>
  );
}

function DateRange({ from, to, title, tag, params, set }: { from: string; to: string; title: string; tag?: boolean; params: URLSearchParams; set: SetFn }) {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  return (
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
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 px-2.5 text-muted-foreground">
          <ArrowDownUp className="size-4" /> <span className="hidden sm:inline">{t(`tickets.sort.${value}`)}</span>
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

// ── Team: compact avatar stack; the list (with load bars) opens on click ──────────
function TeamFilter({ technicians, params, set }: { technicians: TicketList["facets"]["technicians"]; params: URLSearchParams; set: SetFn }) {
  const { t } = useTranslation();
  const me = useMe();
  const selected = (params.get("assignee") ?? "").split(",").filter(Boolean);
  const max = Math.max(1, ...technicians.map((p) => p.open));
  const people = [...technicians].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : b.open - a.open));
  const pick = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    // Someone else's tickets are not in "My tickets": switch to all
    set({ assignee: next.join(",") || null, ...(next.length ? { view: "all" } : {}) });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("h-9 gap-2 px-2", selected.length > 0 && "bg-[color:var(--gold)]/10 text-primary")}>
          <span className="flex -space-x-2">
            {people.slice(0, 4).map((p) => (
              <span
                key={p.id}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border-2 border-background text-[9px] font-semibold",
                  selected.includes(p.id) ? "bg-grad-gold text-[#1a1204]" : "bg-muted text-foreground",
                )}
              >
                {initials(p.name)}
              </span>
            ))}
          </span>
          <span className="hidden text-sm md:inline">{t("tickets.team")}</span>
          {selected.length > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{selected.length}</span>}
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <PanelHeader title={t("tickets.teamTitle")} count={selected.length} onClear={() => set({ assignee: null })} />
        <div className="max-h-80 overflow-y-auto">
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.id)}
              className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", selected.includes(p.id) && "bg-[color:var(--gold)]/10")}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                  p.id === me.id ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary" : "bg-background/60",
                )}
              >
                {initials(p.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {p.name}
                  {p.id === me.id && <span className="text-muted-foreground"> ({t("tickets.me")})</span>}
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-grad-gold" style={{ width: `${(p.open / max) * 100}%` }} />
                </span>
              </span>
              <span className="w-6 text-right font-mono text-xs text-muted-foreground">{p.open}</span>
              {selected.includes(p.id) && <Check className="size-4 text-primary" />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => pick("none")}
            className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm italic text-muted-foreground hover:bg-accent", selected.includes("none") && "bg-[color:var(--gold)]/10")}
          >
            <span className="flex size-7 items-center justify-center rounded-full border border-dashed">
              <UserX className="size-3.5" />
            </span>
            <span className="flex-1">{t("tickets.unassigned")}</span>
            {selected.includes("none") && <Check className="size-4 text-primary" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── AI: plan my open tickets ─────────────────────────────────────────────────────
type Plan = { overview: string; items: { id: number; number: string; title: string; order: number; startDate: string; reason: string }[] };

function AiPlanButton() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const aiError = useAiError();
  const [plan, setPlan] = useState<Plan | null>(null);
  const run = useMutation({
    mutationFn: () => api.post<Plan>("/tickets/ai/plan"),
    onSuccess: (p) => (p.items.length ? setPlan(p) : toast.info(t("tickets.ai.planEmpty"))),
    onError: (e) => toast.error(aiError(e)),
  });
  const apply = useMutation({
    mutationFn: () => api.post("/tickets/start-dates", { items: plan!.items.map((i) => ({ id: i.id, startDate: i.startDate })) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("tickets.ai.planApplied", { count: plan!.items.length }));
      setPlan(null);
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return (
    <>
      <Button variant="outline" onClick={() => run.mutate()} disabled={run.isPending} className="gap-2 border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20">
        {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} {t("tickets.ai.plan")}
      </Button>
      <Dialog open={Boolean(plan)} onOpenChange={(o) => !o && setPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-violet-300" /> {t("tickets.ai.planTitle")}
            </DialogTitle>
          </DialogHeader>
          {plan && (
            <div className="space-y-4">
              {plan.overview && <p className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 text-sm">{plan.overview}</p>}
              <ol className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
                {plan.items.map((i, n) => (
                  <li key={i.id} className="flex gap-3 rounded-xl border bg-card/60 p-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-violet-500/20 font-mono text-xs text-violet-200">{n + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">{i.number}</span>
                        <span className="truncate text-sm font-medium">{i.title}</span>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{i.reason}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{t("tickets.fields.start")}</span>
                      <span className="font-mono text-sm text-primary">{shortDate(i.startDate)}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-muted-foreground">{t("tickets.ai.planNote")}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setPlan(null)}>
                  {t("common.close")}
                </Button>
                <Button onClick={() => apply.mutate()} disabled={apply.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                  {apply.isPending ? <Loader2 className="size-4 animate-spin" /> : <CalendarCheck className="size-4" />} {t("tickets.ai.planApply")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function filterLabel(key: string, value: string, data: TicketList | undefined, t: (k: string) => string) {
  const parts = value.split(",");
  switch (key) {
    case "assignee":
      return parts.map((p) => (p === "none" ? t("tickets.unassigned") : (data?.facets.technicians.find((x) => x.id === p)?.name ?? p))).join(", ");
    case "status":
      return parts.map((p) => data?.facets.statuses.find((s) => s.value === p)).map((c, i) => (c ? (c.label ?? t(`tickets.status.${c.kind}`)) : parts[i])).join(", ");
    case "statusKind":
      return parts.map((p) => t(`tickets.status.${p}`)).join(", ");
    case "priority":
      return parts.map((p) => data?.facets.priorities.find((s) => s.value === p)).map((c, i) => (c ? (c.label ?? t(`tickets.priority.${c.kind}`)) : parts[i])).join(", ");
    case "queue":
      return parts.map((p) => data?.facets.queues.find((s) => s.value === p)?.label ?? p).join(", ");
    case "company":
      return parts.map((p) => data?.facets.companies.find((c) => String(c.id) === p)?.name ?? p).join(", ");
    case "due":
      return t(`tickets.dueFilter.${value}`);
    case "created":
      return t("tickets.quick.today");
    case "attention":
      return t("tickets.metricsHint.attention");
    case "dueFrom":
    case "dueTo":
    case "startFrom":
    case "startTo":
      return shortDate(value);
    default:
      return parts.join(", ");
  }
}
