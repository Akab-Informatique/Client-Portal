import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AlertTriangle, BellRing, Flag, MessagesSquare, Tag, Paperclip, Bot, Building2, CalendarClock, CalendarPlus, Check, BookOpen, ChevronDown, ListOrdered, ChevronUp, Clock3, Eye, FileText, HardDrive, HelpCircle, Inbox, ListChecks, Loader2, Lock, Mail, Minus, MonitorCog, MonitorPlay, NotebookPen, Pencil, Phone, RefreshCw, Send, Sparkles, Timer, Star, UserCheck, UserRound, Users, X, type LucideIcon, MessageSquareReply, MessageSquareText, Trash2, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { AiTextarea } from "@/components/AiPolish";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { AiModelSub, AiTodayLine, useAiModel } from "@/components/AiModelPicker";
import { AiDirection, useAiDirection } from "@/components/AiDirection";
import { useCan, useMe } from "@/lib/session";
import { EditTimeDialog, type TimeNote } from "./EditTime";
import { TicketChat } from "./TicketChat";
import { DueEditor } from "./DueEditor";
import { cn, initials } from "@/lib/utils";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { CompanyPicker, ContactPicker, useCompanies } from "./pickers";
import { TimerControl } from "./timers";
import { AssetContent, AssetPicker } from "./AssetCard";
import { ClientHoursGauge } from "./ClientHoursGauge";
import { AcceptDialog } from "./AcceptDialog";
import { MergeDialog } from "./MergeDialog";
import { NotifyTech } from "./NotifyTech";
import { ChecklistCard } from "./Checklist";
import { fileToBase64 } from "@/pages/outlook/shared";
import { TicketFiles } from "./Files";
import { NotificationBell } from "@/components/NotificationBell";
import { useTicketWorkspace } from "./workspace";
import { contractNote } from "./contract";
import { EmailSend } from "./EmailSend";
import { ContactTicketsList, useContactOpen } from "./ContactTickets";
import { ChargeButtons } from "./Charges";
import { PriorityDialog, TicketPriorities } from "./Planning";
import { TicketSmsPanel, useTicketSms } from "@/pages/sms/SmsPage";
import {
  dueState,
  longDateTime,
  shortDate,
  PRIORITY_STYLE,
  STATUS_STYLE,
  useChoiceText,
  usePresence,
  type AiAnalysis,
  type TicketDetail,
  type TicketList,
  type Viewer,
  ticketErrorText,
  type TicketSummary,
  hm,
  parseHm,
  fullDate,
} from "./shared";

const SOURCE_ICON: Record<string, LucideIcon> = { email: Mail, phone: Phone, portal: Inbox, monitoring: MonitorCog };

/** Friendly text for AI errors (not configured, provider down…). */
export function useAiError() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    if (code === "ai_daily_limit") return t("tickets.ai.errors.daily_limit");
    if (e instanceof ApiError && e.status === 429) return t("tickets.ai.errors.rate_limit");
    return t(`tickets.ai.errors.${code.replace(/^ai_/, "")}`, { defaultValue: t("tickets.ai.errors.api") });
  };
}

/**
 * A ticket over the whole screen. Everything in the header and the details
 * can be changed in place. "Minimize" keeps it in the dock (presence goes on),
 * "Close" leaves it. Presence: popup on arrival + light in the top-right corner.
 */
/**
 * The ticket as already known from a loaded list, so the window opens at once;
 * description, notes and time arrive with the full ticket a moment later.
 */
function fromLists(qc: QueryClient, id: number): TicketDetail | undefined {
  for (const [, d] of qc.getQueriesData<TicketList>({ queryKey: ["tickets"] })) {
    // only real lists (search results have no facets)
    if (!d || !Array.isArray(d.items) || !d.facets) continue;
    const tk = d.items.find((x) => x.id === id);
    if (!tk) continue;
    return {
      ...tk,
      checklist: undefined,
      description: tk.excerpt,
      source: "",
      hours: 0,
      notes: [],
      demo: d.demo,
      ai: d.ai,
      options: { statuses: d.facets.statuses, priorities: d.facets.priorities, queues: d.facets.queues, technicians: d.facets.technicians },
    };
  }
  return undefined;
}

export function TicketOverlay({ id, onClose, onMinimize }: { id: number | null; onClose: () => void; onMinimize: (tk: TicketDetail) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, isPlaceholderData, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["tickets", "detail", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    enabled: Boolean(id),
    staleTime: 15_000,
    placeholderData: () => (id ? fromLists(qc, id) : undefined),
    retry: 1,
  });
  // On error, keep showing what the list knows about the ticket
  const shown = data ?? (isError && id ? fromLists(qc, id) : undefined);
  const viewers = usePresence(id);

  return (
    <DialogPrimitive.Root open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <AnimatePresence>
        {id && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
              <motion.div
                initial={{ opacity: 0, scale: 0.985, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.985, y: 24 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="fixed inset-0 z-50 isolate flex flex-col overflow-hidden bg-background/75 backdrop-blur-2xl"
              >
                <GlassBackdrop />
                <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-grid opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
                {isError && !shown ? (
                  <div className="relative mx-auto w-full max-w-xl space-y-4 p-8 pt-24 text-center">
                    <DialogPrimitive.Title className="text-xl font-semibold">{t("tickets.loadFailed")}</DialogPrimitive.Title>
                    <p className="text-sm text-muted-foreground">{ticketErrorText(t, error)}</p>
                    <div className="flex justify-center gap-2">
                      <Button variant="ghost" onClick={onClose}>
                        {t("common.close")}
                      </Button>
                      <Button onClick={() => void refetch()} disabled={isFetching} className="bg-grad-gold font-semibold text-[#1a1204]">
                        {isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("tickets.retry")}
                      </Button>
                    </div>
                  </div>
                ) : (isLoading && !shown) || !shown ? (
                  <div className="relative mx-auto w-full max-w-7xl space-y-4 p-8">
                    <DialogPrimitive.Title className="sr-only">{t("tickets.title")}</DialogPrimitive.Title>
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-10 w-2/3" />
                    <Skeleton className="h-96" />
                  </div>
                ) : (
                  <TicketBody
                    tk={shown}
                    partial={isPlaceholderData || (isError && !data)}
                    loadError={isError && !data ? { text: ticketErrorText(t, error), retry: () => void refetch(), retrying: isFetching } : null}
                    viewers={viewers}
                    onClose={onClose}
                    onMinimize={() => onMinimize(shown)}
                  />
                )}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

/** Save one or more fields of the ticket, then refresh the window and the list. */
function useTicketUpdate(tk: TicketDetail) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      status?: string;
      priority?: string;
      queue?: string;
      assigneeId?: string | null;
      secondaryIds?: string[];
      dueDate?: string;
      dueAt?: string;
      companyId?: number;
      contactId?: string | null;
      title?: string;
      description?: string;
      assetId?: string | null;
      source?: string;
    }) => api.patch<TicketDetail>(`/tickets/${tk.id}`, patch),
    onSuccess: (next) => {
      qc.setQueryData(["tickets", "detail", tk.id], next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
}

function TicketBody({
  tk,
  partial,
  loadError,
  viewers,
  onClose,
  onMinimize,
}: {
  tk: TicketDetail;
  /** Shown from the list while the full ticket (description, notes, time) loads */
  partial: boolean;
  /** The full ticket could not be loaded: what the list knows is shown, with the reason */
  loadError?: { text: string; retry: () => void; retrying: boolean } | null;
  viewers: Viewer[] | null;
  onClose: () => void;
  onMinimize: () => void;
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const can = useCan();
  const me = useMe();
  const editable = can("tickets.edit");
  const update = useTicketUpdate(tk);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: companies = [tk.company] } = useCompanies();
  // A change made in place shows at once and is saved right away
  const [staged, setStaged] = useState<Staged>({});
  useEffect(() => setStaged({}), [tk.id]);
  const original: Required<Staged> = {
    status: tk.status,
    priority: tk.priority,
    queue: tk.queue,
    dueAt: tk.dueAt,
    assigneeId: tk.assignee?.id ?? null,
    startDate: tk.startDate ?? null,
    startTime: tk.startTime ?? null,
    startLocked: Boolean(tk.startLocked),
    milestoneDate: tk.milestoneDate ?? null,
    milestoneTime: tk.milestoneTime ?? null,
  };
  const stage = (p: Staged) => {
    const next: Staged = { ...p };
    // no day, no time nor restriction
    if (p.startDate === null) Object.assign(next, { startTime: null, startLocked: false });
    if (p.milestoneDate === null) Object.assign(next, { milestoneTime: null });
    for (const k of Object.keys(next) as (keyof Staged)[]) if (next[k] === original[k]) delete next[k];
    if (!Object.keys(next).length) return;
    setStaged((s) => ({ ...s, ...next }));
    saveAll.mutate(next);
  };
  const view = { ...original, ...staged };
  const changed = (k: keyof Staged) => k in staged;
  const saveAll = useMutation({
    mutationFn: async (changes: Staged) => {
      const { startDate, startTime, startLocked, milestoneDate, milestoneTime, ...patch } = changes;
      let next: TicketDetail | null = null;
      if (Object.keys(patch).length) next = await api.patch<TicketDetail>(`/tickets/${tk.id}`, patch);
      const start = { startDate, startTime, startLocked, milestoneDate, milestoneTime };
      if (Object.values(start).some((x) => x !== undefined)) await api.put(`/tickets/${tk.id}/start-date`, start);
      return next;
    },
    onSuccess: (next) => {
      if (next) qc.setQueryData(["tickets", "detail", tk.id], next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      setStaged({});
      toast.success(t("common.saved"));
    },
    onError: (e) => {
      setStaged({});
      toast.error(ticketErrorText(t, e));
    },
  });
  // delete for good (administrators; the portal's own tickets)
  const remove = useMutation({
    mutationFn: () => api.del(`/tickets/${tk.id}`),
    onSuccess: () => {
      toast.success(t("tickets.delete.done", { number: tk.number }));
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      onClose();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const askDelete = () =>
    void confirm({ title: t("tickets.delete.title", { number: tk.number }), description: t("tickets.delete.text"), confirmLabel: t("tickets.delete.confirm"), destructive: true }).then((ok) => ok && remove.mutate());
  const statusOpt = tk.options.statuses.find((s) => s.value === view.status);
  // where the ticket came from, in the portal's own words (Admin › Billets)
  const sourceName = (tk.options.sources ?? []).find((x) => x.value === tk.source)?.label ?? (tk.source ? t(`tickets.source.${tk.source}`, { defaultValue: tk.source }) : "");
  const statusKind = statusOpt?.kind ?? tk.statusKind;
  const statusText = statusOpt ? txt.status(statusOpt) : txt.status({ label: tk.statusLabel, kind: tk.statusKind });
  const priorityOpt = tk.options.priorities.find((p) => p.value === view.priority);
  const priorityKind = priorityOpt?.kind ?? tk.priorityKind;
  const priorityText = priorityOpt ? txt.priority(priorityOpt) : txt.priority({ label: tk.priorityLabel, kind: tk.priorityKind });
  const queueText = tk.options.queues.find((q) => q.value === view.queue)?.label ?? (changed("queue") ? view.queue : tk.queueLabel);
  const assigneeName = changed("assigneeId")
    ? view.assigneeId
      ? (tk.options.technicians.find((p) => p.id === view.assigneeId)?.name ?? "")
      : null
    : (tk.assignee?.name ?? null);
  const due = dueState(view.dueAt, statusKind);
  const [draft, setDraft] = useState<{ text: string; internal: boolean } | null>(null);
  // Quick actions put the note box in a mode and bring it into view
  const [focusNote, setFocusNote] = useState<{ internal: boolean; at: number } | null>(null);
  const [giving, setGiving] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [merging, setMerging] = useState(false);
  // the three squares: full size, or collapsed to small icons (kept per browser)
  const [tilesOpen, setTilesOpen] = useState(() => {
    try {
      return localStorage.getItem("akab.ticket.tiles2") !== "0";
    } catch {
      return true;
    }
  });
  const toggleTiles = () =>
    setTilesOpen((v) => {
      try {
        localStorage.setItem("akab.ticket.tiles2", v ? "0" : "1");
      } catch {
        /* private mode: just not remembered */
      }
      return !v;
    });
  // the exchange shown: the ticket activity, or the texts with the client
  const [thread, setThread] = useState<"activity" | "sms" | "files">("activity");
  const { data: texts } = useTicketSms(tk.id, can("sms.view") && !partial);
  // texts received and not looked at yet; a new one also moved the ticket to "needs attention": the ticket is read again
  const unreadTexts = (texts?.conversations ?? []).reduce((n, c) => n + c.unread, 0);
  const seenTexts = useRef(0);
  useEffect(() => {
    if (unreadTexts > seenTexts.current) void qc.invalidateQueries({ queryKey: ["tickets"] });
    seenTexts.current = unreadTexts;
  }, [unreadTexts, qc]);
  const remote = tk.asset?.links.remote ?? null;
  const contactOpen = useContactOpen(tk.contactId, tk.id);
  const phone = tk.contactInfo?.phone ?? null;
  const email = tk.contactInfo?.email ?? null;

  // R = reply, I = internal note (when not typing)
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || el.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog] [role=listbox]"))
        return;
      const k = e.key.toLowerCase();
      if (k === "r" || k === "i") {
        e.preventDefault();
        e.stopPropagation();
        setFocusNote({ internal: k === "i", at: Date.now() });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editable]);

  return (
    <>
      {/* Header: what the ticket is, where it stands, and the tools */}
      <div className="glass relative z-10 rounded-none border-x-0 border-t-0 border-b">
        <div className="w-full px-4 pb-3 pt-3 lg:px-6">
          <div className="flex items-center gap-3">
            <span className="rounded-md border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-2 py-0.5 font-mono text-xs text-primary">
              {tk.number}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {tk.company.name}
              {tk.contact && ` · ${tk.contact}`}
            </span>
            <span className="ml-auto">
              <PresenceLight viewers={viewers} />
            </span>
            <TimerControl ticketId={tk.id} />
            <MergedTickets tk={tk} />
            {can("tickets.ai") &&
              (tk.ai ? (
                <span className="inline-flex items-center">
                  <AiMenu tk={tk} onReply={(text) => setDraft({ text, internal: false })} />
                  <AiDirection id={`ticket:${tk.id}`} />
                </span>
              ) : <AiSetupHint label={t("tickets.ai.button")} />)}
            {can("tickets.edit") && !partial && <NotifyTech tk={tk} />}
            <NotificationBell />
            {can("tickets.delete") && !partial && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 text-muted-foreground hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={askDelete}
                    aria-label={t("tickets.delete.button")}
                  >
                    {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("tickets.delete.button")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-9" onClick={onMinimize} aria-label={t("tickets.minimize")}>
                  <Minus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("tickets.minimizeHint")}</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="icon" className="size-9" onClick={onClose} aria-label={t("common.close")}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-start lg:gap-5">
            <div className="min-w-0 lg:flex-1">
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <EditableTitle value={tk.title} disabled={!editable || partial} onSave={(title) => update.mutate({ title })} />
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.queue")}
                value={view.queue}
                options={tk.options.queues.map((q) => ({ value: q.value, label: q.label ?? q.value }))}
                onPick={(v) => stage({ queue: v })}
                trigger={
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    <ListOrdered className="size-3.5" /> {queueText || "—"}
                  </span>
                }
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.status")}
                value={view.status}
                options={tk.options.statuses.filter((s) => !s.hidden || s.value === view.status).map((s) => ({ value: s.value, label: txt.status(s) }))}
                onPick={(v) => stage({ status: v })}
                trigger={
                  <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_STYLE[statusKind])}>
                    {statusText}
                  </span>
                }
              />
              <InlinePick
                disabled={!editable}
                label={t("tickets.fields.priority")}
                value={view.priority}
                options={tk.options.priorities.map((p) => ({ value: p.value, label: txt.priority(p), dot: PRIORITY_STYLE[p.kind].dot }))}
                onPick={(v) => stage({ priority: v })}
                trigger={
                  <span
                    className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", PRIORITY_STYLE[priorityKind].text)}
                  >
                    <span className={cn("size-2 rounded-full", PRIORITY_STYLE[priorityKind].dot)} /> {priorityText}
                  </span>
                }
              />
              {(update.isPending || saveAll.isPending) && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {(() => {
                const badge = (
                  <span
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      due === "overdue"
                        ? "border-destructive/50 text-destructive"
                        : due === "today"
                          ? "border-orange-500/50 text-orange-400"
                          : "text-muted-foreground",
                      editable && "cursor-pointer hover:border-[color:var(--gold)]/60",
                    )}
                    title={editable ? t("tickets.due.change") : fullDate(view.dueAt)}
                  >
                    <CalendarClock className="size-3.5" />
                    {t("tickets.fields.due")} · {fullDate(view.dueAt)}
                  </span>
                );
                return editable ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" aria-label={t("tickets.due.change")}>
                        {badge}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 space-y-2">
                      <p className="text-sm font-semibold">{t("tickets.fields.due")}</p>
                      <p className="text-xs text-muted-foreground">{fullDate(view.dueAt)}</p>
                      <DueEditor dueAt={view.dueAt} quick autoFocus onSave={(dueAt) => stage({ dueAt })} />
                    </PopoverContent>
                  </Popover>
                ) : (
                  badge
                );
              })()}
              {/* quick edits: the start and the checkpoint (a day and a time) */}
              <QuickDate
                icon={CalendarPlus}
                label={t("tickets.fields.start")}
                date={view.startDate}
                disabled={!editable}
                onSave={(date) => stage({ startDate: date })}
              />
              <QuickDate
                icon={Flag}
                label={t("tickets.milestone.label")}
                date={view.milestoneDate}
                time={view.milestoneTime}
                withTime
                disabled={!editable}
                min={view.startDate}
                onSave={(date, time) => stage({ milestoneDate: date, milestoneTime: date ? time : null })}
              />
            </div>
            </div>
            <div className="mt-3 lg:mt-1 lg:shrink-0">
        {/* Team, planning and details: tight chips by the title; each opens a small floating panel (nothing is pushed down) */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTiles}
            aria-label={tilesOpen ? t("tickets.tileBar.collapse") : t("tickets.tileBar.expand")}
            title={tilesOpen ? t("tickets.tileBar.collapse") : t("tickets.tileBar.expand")}
            className={cn("flex w-4 items-center justify-center rounded-md text-muted-foreground hover:text-foreground", tilesOpen ? "h-[112px]" : "h-[76px]")}
          >
            <ChevronDown className={cn("size-3.5 transition-transform", tilesOpen ? "rotate-90" : "-rotate-90")} />
          </button>
          <div className={"grid grid-cols-4 gap-2"}>
          {(
            [
              {
                key: "team",
                icon: Users,
                label: t("tickets.sections.team"),
                value: assigneeName ?? t("tickets.unassigned"),
                more: [tk.secondary.length ? `${t("tickets.fields.secondary")} : ${tk.secondary.map((x) => x.name).join(", ")}` : `${t("tickets.fields.secondary")} : —`],
              },
              {
                key: "planning",
                icon: CalendarClock,
                label: t("tickets.sections.planning"),
                value: shortDate(view.dueAt),
                more: [
                  `${t("tickets.fields.start")} : ${tk.startDate ? shortDate(tk.startDate) : "—"}`,
                  `${t("tickets.milestone.label")} : ${tk.milestoneDate ? `${shortDate(tk.milestoneDate)}${tk.milestoneTime ? ` ${tk.milestoneTime}` : ""}` : "—"}`,
                  `${t("tickets.fields.hours")} : ${partial ? "…" : t("tickets.hoursValue", { hours: tk.hours.toLocaleString() })}`,
                  `${t("tickets.estimate.short")} : ${tk.estimate ? hm(tk.estimate.minutes / 60) : "—"}`,
                ],
              },
              {
                key: "details",
                icon: Inbox,
                label: t("tickets.sections.details"),
                value: sourceName || "—",
                more: [`${t("tickets.contractBilling.label")} : ${tk.contract?.name ?? "—"}`, `${t("tickets.fields.created")} : ${shortDate(tk.createdAt)}`, `${t("tickets.sections.lastActivity")} : ${shortDate(tk.updatedAt)}`],
              },
              {
                key: "device",
                icon: HardDrive,
                label: t("tickets.asset.title"),
                value: tk.asset?.name ?? t("tickets.tile.noDevice"),
                more: tk.asset ? [tk.asset.origin === "local" ? t("tickets.asset.originLocal") : t("tickets.asset.originRmm"), tk.asset.os ?? tk.asset.type ?? "—"] : [t("tickets.tile.linkDevice")],
              },
            ] as const
          ).map(({ key, icon: Icon, label, value, more }) => (
            <Popover key={key}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title={label}
                  className={cn(
                    "group flex flex-col justify-center rounded-2xl border border-border/60 bg-card/40 text-center transition hover:border-[color:var(--gold)]/40 hover:bg-card/70 data-[state=open]:border-[color:var(--gold)]/50 data-[state=open]:bg-[color:var(--gold)]/10",
                    tilesOpen ? "h-[112px] w-[178px] items-start justify-start gap-1 px-3.5 py-3 text-left" : "size-[76px] items-center px-1 text-center",
                  )}
                >
                  {tilesOpen ? (
                    <>
                      <span className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Icon className="size-3.5 shrink-0 text-primary" /> {label}
                      </span>
                      <span className="w-full truncate text-sm font-semibold">{value}</span>
                      {more.map((m) => (
                        <span key={m} className="w-full truncate text-[11px] text-muted-foreground">
                          {m}
                        </span>
                      ))}
                    </>
                  ) : (
                    <>
                      <Icon className="size-4 shrink-0 text-primary" />
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
                      <span className="w-full truncate text-[11px] font-medium leading-none">{value}</span>
                    </>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className={cn("p-3 text-sm", key === "device" ? "w-[26rem]" : "w-80")}>
                {key === "team" && (
                  <dl className="space-y-3">
                      <Detail icon={UserRound} label={t("tickets.fields.assignee")}>
                        <InlinePick
                          disabled={!editable}
                          label={t("tickets.fields.assignee")}
                          value={view.assigneeId ?? "none"}
                          options={[{ value: "none", label: t("tickets.unassigned") }, ...tk.options.technicians.map((p) => ({ value: p.id, label: p.name }))]}
                          onPick={(v) => stage({ assigneeId: v === "none" ? null : v })}
                          trigger={
                            <span className={cn("rounded px-1", !assigneeName && "italic text-muted-foreground")}>{assigneeName ?? t("tickets.unassigned")}</span>
                          }
                        />
                      </Detail>
                      <Detail icon={Users} label={t("tickets.fields.secondary")}>
                        <SecondaryPick
                          disabled={!editable}
                          value={tk.secondary.map((p) => p.id)}
                          names={tk.secondary.map((p) => p.name)}
                          options={tk.options.technicians.filter((p) => p.id !== tk.assignee?.id)}
                          onSave={(secondaryIds) => update.mutate({ secondaryIds })}
                        />
                      </Detail>
                    </dl>
                )}
                {key === "planning" && (
                  <dl className="space-y-3">
                      <StartDate value={view} onChange={stage} />
                      <Detail icon={CalendarClock} label={t("tickets.fields.due")}>
                        {editable ? (
                          <div className={cn("mt-0.5 rounded-lg")}>
                            <DueEditor dueAt={view.dueAt} onSave={(dueAt) => stage({ dueAt })} />
                          </div>
                        ) : (
                          fullDate(tk.dueAt)
                        )}
                      </Detail>
                      <Detail icon={Clock3} label={t("tickets.fields.hours")}>
                        {partial ? "…" : t("tickets.hoursValue", { hours: tk.hours.toLocaleString() })}
                      </Detail>
                      <Detail icon={Timer} label={t("tickets.estimate.label")}>
                        <EstimateField tk={tk} editable={editable && !partial} />
                      </Detail>
                    </dl>
                )}
                {key === "details" && (
                  <dl className="space-y-3">
                    <Detail icon={FileText} label={t("tickets.contractBilling.label")}>
                      <ContractField tk={tk} editable={editable && !partial} />
                    </Detail>
                      <Detail icon={SOURCE_ICON[tk.source] ?? Inbox} label={t("tickets.fields.source")}>
                        <InlinePick
                          disabled={!editable || partial || !(tk.options.sources ?? []).length}
                          label={t("tickets.fields.source")}
                          value={tk.source}
                          options={(tk.options.sources ?? []).map((x) => ({ value: x.value, label: x.label ?? x.value }))}
                          onPick={(source) => update.mutate({ source })}
                          trigger={<span className="rounded px-1">{sourceName || "—"}</span>}
                        />
                      </Detail>
                      <Detail icon={Clock3} label={t("tickets.fields.created")}>
                        {longDateTime(tk.createdAt)}
                      </Detail>
                      <Detail icon={RefreshCw} label={t("tickets.sections.lastActivity")}>
                        {longDateTime(tk.updatedAt)}
                      </Detail>
                    </dl>
                )}
                {key === "device" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.asset.title")}</span>
                      {editable && !partial ? <AssetPicker tk={tk} onPick={(assetId) => update.mutate({ assetId })} /> : null}
                    </div>
                    <AssetContent tk={tk} editable={editable} partial={partial} onPick={(assetId) => update.mutate({ assetId })} />
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ))}
          </div>
          <ClientHoursGauge info={tk.client ?? null} big={tilesOpen} />
        </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 lg:mt-12 lg:justify-end lg:justify-self-end">
              {remote && <QuickAction icon={MonitorPlay} label={t("tickets.asset.remote")} href={remote} accent />}
              {editable && !partial && tk.assignee?.id !== me.id && statusKind !== "complete" && <QuickAction icon={UserCheck} label={t("tickets.accept.button")} onClick={() => setAccepting(true)} accent />}
              {editable && !partial && tk.local && statusKind !== "complete" && <QuickAction icon={GitMerge} label={t("tickets.merge.button")} onClick={() => setMerging(true)} />}
              {can("tickets.plan") && <QuickAction icon={Star} label={t("planning.givePriority")} onClick={() => setGiving(true)} />}
              <CallButton contact={tk.contact} phone={phone} />
            </div>
          </div>

          {tk.mergedInto && (
            <p className="flex items-start gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs text-violet-200">
              <GitMerge className="mt-0.5 size-3.5 shrink-0" /> {t("tickets.merge.mergedInto", { number: tk.mergedInto.number })}
            </p>
          )}
          {tk.startLocked && tk.startDate && tk.startDate > todayLocal() && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <Lock className="mt-0.5 size-3.5 shrink-0" />{" "}
              {t("tickets.startLock.notice", { date: shortDate(tk.startDate) })}
            </p>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-4 lg:flex lg:gap-5 lg:overflow-hidden lg:px-6">
        {/* The work: what is asked, what was done, the next note (always at the bottom) */}
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
          <div className="flex flex-col gap-4 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-2">
            {loadError && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t("tickets.loadFailed")}</span> <span className="text-muted-foreground">{loadError.text}</span>
                </span>
                <Button size="sm" variant="outline" onClick={loadError.retry} disabled={loadError.retrying}>
                  {loadError.retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("tickets.retry")}
                </Button>
              </div>
            )}
            <TicketPriorities ticketId={tk.id} />
            <EditableDescription
              text={tk.description}
              disabled={!editable || partial}
              saving={update.isPending}
              partial={partial}
              onSave={(description) => update.mutate({ description })}
            />
            {/* the tasks to complete before the ticket can be: right under the description, folded away or open */}
            <ChecklistCard tk={tk} editable={editable && !partial} />
            <AiPanel tk={tk} onToNote={(text) => setDraft({ text, internal: true })} />
            {(
              <div className="flex items-center gap-1 rounded-xl border p-1 text-xs">
                {(can("sms.view") ? (["activity", "sms", "files"] as const) : (["activity", "files"] as const)).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setThread(k)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
                      thread === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground",
                      // a text came in and was not looked at yet: the tab blinks until it is opened
                      k === "sms" && unreadTexts > 0 && thread !== "sms" && "animate-attention font-semibold text-orange-200",
                    )}
                  >
                    {k === "activity" ? <Clock3 className="size-3.5" /> : k === "files" ? <Paperclip className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
                    {k === "files" ? t("tickets.files.tab") : t(`sms.thread.${k}`)}
                    {k === "files" && (tk.attachments?.length ?? 0) > 0 && <span className="rounded-full bg-black/15 px-1.5 font-mono text-[10px]">{tk.attachments!.length}</span>}
                    {k === "sms" && unreadTexts > 0 && (
                      <span className="rounded-full bg-orange-500 px-1.5 font-mono text-[10px] font-bold text-white" title={t("sms.ticket.unread", { count: unreadTexts })}>
                        {unreadTexts}
                      </span>
                    )}
                    {k === "sms" && unreadTexts === 0 && (texts?.messages.length ?? 0) > 0 && (
                      <span className="rounded-full bg-black/15 px-1.5 font-mono text-[10px]">{texts!.messages.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {thread === "files" ? (
              <TicketFiles tk={tk} editable={editable && !partial} />
            ) : thread === "sms" && can("sms.view") ? (
              <TicketSmsPanel ticketId={tk.id} phone={phone} companyId={tk.company.id} clientName={tk.contact || null} />
            ) : (
              <Activity tk={tk} partial={partial && !loadError} />
            )}
          </div>
          {/* Charges and expenses: small buttons right above the note box */}
          <div className="flex flex-wrap items-center gap-1.5 pb-2 lg:pr-2">
            <ChargeButtons tk={tk} editable={editable} partial={partial} />
          </div>
          {editable && thread !== "sms" && thread !== "files" && (
            <div className="sticky bottom-0 z-10 -mx-2 bg-gradient-to-t from-background via-background/95 to-transparent px-2 pb-4 pt-1 lg:static lg:mx-0 lg:bg-none lg:px-0 lg:pr-2">
              <NoteComposer tk={tk} draft={draft} onDraftUsed={() => setDraft(null)} focusRequest={focusNote} />
            </div>
          )}
        </div>

        {/* Tools and information, in the order they are needed; one column, own scroll */}
        <aside className="space-y-3 pb-4 lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:pr-1">
          <Section id="client" icon={Building2} title={t("tickets.sections.client")}>
            <dl className="space-y-3">
              <Detail icon={Building2} label={t("tickets.fields.company")}>
                <CompanyPicker
                  disabled={!editable}
                  value={tk.company}
                  companies={companies}
                  onChange={(c) => c.id !== tk.company.id && update.mutate({ companyId: c.id })}
                />
              </Detail>
              <Detail icon={UserRound} label={t("tickets.fields.contact")}>
                <ContactPicker
                  disabled={!editable}
                  canCreate={editable}
                  companyId={tk.company.id}
                  value={tk.contactId}
                  valueName={tk.contact || undefined}
                  onChange={(c) => update.mutate({ contactId: c?.id ?? null })}
                />
              </Detail>
              {(phone || email) && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 pl-7 text-xs">
                  {phone && (
                    <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1 text-primary hover:underline">
                      <Phone className="size-3" /> {phone}
                    </a>
                  )}
                  {email && (
                    <a href={`mailto:${email}`} className="flex min-w-0 items-center gap-1 truncate text-primary hover:underline">
                      <Mail className="size-3 shrink-0" /> <span className="truncate">{email}</span>
                    </a>
                  )}
                </div>
              )}
            </dl>
          </Section>

          <Section id="contactTickets" icon={Inbox} title={t("tickets.contactOpen.title", { name: tk.contact || "—" })} badge={contactOpen.data ? t("tickets.contactOpen.count", { count: contactOpen.data.total }) : null}>
            <ContactTicketsList data={contactOpen.data} isLoading={contactOpen.isLoading} />
          </Section>

          <Section id="kb" icon={BookOpen} title={t("tickets.kb.title")} badge={t("tickets.kb.soon")}>
            <p className="text-sm text-muted-foreground">{t("tickets.kb.empty")}</p>
          </Section>

          {/* labels to find the ticket back: searched with the ticket */}
          <Section id="tags" icon={Tag} title={t("tickets.tags.title")} badge={tk.tags?.length ? String(tk.tags.length) : undefined}>
            <TicketTags tk={tk} editable={editable} />
          </Section>

          {/* a small chat with a colleague (their Teams chat with me) */}
          {can("chat.use") && (
            <Section id="chat" icon={MessagesSquare} title={t("chat.title")} defaultOpen={false}>
              <TicketChat tk={tk} />
            </Section>
          )}
        </aside>
      </div>
      <OpenedByOthers viewers={viewers} />
      {merging && <MergeDialog open onOpenChange={(o) => !o && setMerging(false)} tk={tk} onDone={() => onClose()} />}
      {accepting && <AcceptDialog open onOpenChange={(o) => !o && setAccepting(false)} tk={tk} statuses={tk.options.statuses} />}
      {giving && <PriorityDialog priority={null} ticket={{ id: tk.id, number: tk.number, title: tk.title }} onClose={() => setGiving(false)} />}
    </>
  );
}

/** A tool in the quick-action bar: a button, or a link (new tab for web pages). */
/** The tags of a ticket: chips to remove, a field to add one (Enter); they are searched with the ticket. */
function TicketTags({ tk, editable }: { tk: TicketDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const tags = tk.tags ?? [];
  const save = useMutation({
    mutationFn: (next: string[]) => api.put<{ tags: string[] }>(`/tickets/${tk.id}/tags`, { tags: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      setText("");
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((x) => (
          <span key={x} className="flex items-center gap-1 rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-2 py-0.5 text-xs">
            {x}
            {editable && (
              <button type="button" onClick={() => save.mutate(tags.filter((y) => y !== x))} className="text-muted-foreground hover:text-destructive" aria-label={t("common.delete")}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!tags.length && <span className="text-xs text-muted-foreground">{t("tickets.tags.none")}</span>}
      </div>
      {editable && (
        <Input
          value={text}
          maxLength={30}
          className="h-8"
          placeholder={t("tickets.tags.add")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              e.preventDefault();
              save.mutate([...tags, text.trim()]);
            }
          }}
        />
      )}
    </div>
  );
}

/** The contract the ticket's work is billed on: the client's default support contract unless another is picked. */
function ContractField({ tk, editable }: { tk: TicketDetail; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const contracts = tk.contracts ?? [];
  const save = useMutation({
    mutationFn: (contractId: string | null) => api.put(`/tickets/${tk.id}/contract`, { contractId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  if (!contracts.length) return <span className="text-muted-foreground">{t("tickets.contractBilling.none")}</span>;
  return (
    <div className="mt-0.5 space-y-1">
      <select
        value={tk.contract?.id ?? ""}
        disabled={!editable || save.isPending}
        onChange={(e) => save.mutate(e.target.value || null)}
        className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60"
        aria-label={t("tickets.contractBilling.label")}
      >
        {!tk.contract && <option value="">{t("tickets.contractBilling.none")}</option>}
        {contracts.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.isDefault ? ` · ${t("tickets.contractBilling.default")}` : ""}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">{contractNote(t, i18n.language, tk.contract)}</p>
    </div>
  );
}

/**
 * The time the ticket should take to resolve, h:mm: typed by the technician, or
 * estimated by the AI when the action is quick (anything bigger stays empty).
 */
function EstimateField({ tk, editable }: { tk: TicketDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const aiError = useAiError();
  const can = useCan();
  const model = useAiModel("ticket.analyze");
  const direction = useAiDirection(`ticket:${tk.id}`);
  const [text, setText] = useState(tk.estimate ? hm(tk.estimate.minutes / 60) : "");
  useEffect(() => setText(tk.estimate ? hm(tk.estimate.minutes / 60) : ""), [tk.estimate?.minutes]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
    void qc.invalidateQueries({ queryKey: ["ai", "options"] });
  };
  const save = useMutation({
    mutationFn: (minutes: number | null) => api.put(`/tickets/${tk.id}/estimate`, { minutes }),
    onSuccess: refresh,
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const ask = useMutation({
    mutationFn: () => api.post<{ minutes: number | null; reason: string }>(`/tickets/${tk.id}/ai/estimate`, { ...model.body, ...direction.body }),
    onSuccess: (r) => {
      refresh();
      if (r.minutes) toast.success(r.reason ? `${hm(r.minutes / 60)} — ${r.reason}` : hm(r.minutes / 60));
      else toast.info(r.reason ? `${t("tickets.estimate.none")} ${r.reason}` : t("tickets.estimate.none"));
    },
    onError: (e) => toast.error(aiError(e)),
  });
  const commit = () => {
    const v = text.trim();
    if (!v) {
      if (tk.estimate) save.mutate(null);
      return;
    }
    const h = parseHm(v);
    if (h === null || h <= 0) {
      setText(tk.estimate ? hm(tk.estimate.minutes / 60) : "");
      toast.error(t("tickets.estimate.invalid"));
      return;
    }
    const minutes = Math.round(h * 60);
    if (minutes !== tk.estimate?.minutes) save.mutate(minutes);
  };
  return (
    <div className="mt-0.5 space-y-1">
      <div className="flex items-center gap-2">
        <Input
          value={text}
          disabled={!editable}
          placeholder="h:mm"
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-8 w-24 font-mono"
          aria-label={t("tickets.estimate.label")}
        />
        {tk.estimate?.source === "ai" && <span className="rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-px text-[10px] font-medium text-primary">AI</span>}
        {editable && can("tickets.ai") && tk.ai && (
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={ask.isPending} onClick={() => ask.mutate()}>
            {ask.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {t("tickets.estimate.ask")}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("tickets.estimate.hint")}</p>
    </div>
  );
}

/** Calling is not wired yet: the button, the contact's number and the dial pad do nothing for now. */
function CallButton({ contact, phone }: { contact: string; phone?: string | null }) {
  const { t } = useTranslation();
  const [num, setNum] = useState("");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Phone className="size-3.5" /> {t("tickets.quickAction.callBtn")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        {phone && (
          <Button type="button" variant="outline" className="h-auto w-full justify-start gap-2 py-2 text-left" onClick={() => {}}>
            <Phone className="size-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{contact}</span>
              <span className="block text-xs text-muted-foreground">{phone}</span>
            </span>
          </Button>
        )}
        <form className="flex items-center gap-2" onSubmit={(e) => e.preventDefault()}>
          <Input value={num} onChange={(e) => setNum(e.target.value)} inputMode="tel" placeholder={t("tickets.quickAction.callNumber")} aria-label={t("tickets.quickAction.callNumber")} />
          <Button type="submit" size="icon" disabled={!num.trim()} aria-label={t("tickets.quickAction.callBtn")}>
            <Phone className="size-4" />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
  href,
  kbd,
  title,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  kbd?: string;
  title?: string;
  accent?: boolean;
}) {
  const cls = cn("h-8 gap-1.5 text-xs", accent && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary hover:bg-[color:var(--gold)]/20");
  const inner = (
    <>
      <Icon className="size-3.5" /> {label}
      {kbd && <kbd className="ml-0.5 hidden rounded border px-1 font-mono text-[9px] text-muted-foreground sm:inline">{kbd}</kbd>}
    </>
  );
  if (href) {
    const web = href.startsWith("http");
    return (
      <Button asChild variant="outline" size="sm" className={cls} title={title}>
        <a href={href} {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {inner}
        </a>
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" className={cls} onClick={onClick} title={title}>
      {inner}
    </Button>
  );
}

/** Open / closed state of the ticket sections, remembered for the next tickets. */
const SECTIONS_KEY = "akab.ticket.sections";
function useSectionOpen(id: string, defaultOpen: boolean) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = (JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Record<string, boolean>)[id];
      return typeof v === "boolean" ? v : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        const all = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Record<string, boolean>;
        localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...all, [id]: !o }));
      } catch {
        /* not saved: still works for this ticket */
      }
      return !o;
    });
  return [open, toggle] as const;
}

/** A collapsible section; closed, its title (and a short summary) stays visible. */
function Section({
  id,
  icon: Icon,
  title,
  badge,
  action,
  titleExtra,
  flat,
  defaultOpen = true,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Shown next to the title when the section is closed */
  badge?: string | null;
  action?: React.ReactNode;
  /** Shown beside the title, always */
  titleExtra?: React.ReactNode;
  /** No panel: a hairline-separated row, lighter on the eye */
  flat?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, toggle] = useSectionOpen(id, defaultOpen);
  return (
    <section className={cn("text-sm", flat ? "border-b border-border/40 last:border-b-0" : "glass rounded-2xl border")}>
      <div className={cn("flex items-center gap-2", flat ? "px-1 py-2" : "px-4 py-2.5")}>
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon className="size-3.5 shrink-0 text-primary" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
          {titleExtra}
          {!open && badge && <span className="truncate text-xs text-foreground/80">· {badge}</span>}
          <ChevronDown className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className={flat ? "px-1 pb-4" : "px-4 pb-4"}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

type ActivityFilter = "all" | "reply" | "internal" | "time" | "merged";

/**
 * What was said and done, as a conversation, newest on top: the client's
 * messages on the left, the technicians' replies on the right, internal notes
 * and time entries in the middle (each in its own color). Nothing system-made
 * writes by itself (workflow rules, the API user…).
 */
function Activity({ tk, partial }: { tk: TicketDetail; partial: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  // a time entry changed in place: its technician, until their week is submitted and the time approved for invoicing
  const [editing, setEditing] = useState<TimeNote | null>(null);
  type Item = TicketDetail["notes"][number];
  const kindOf = (n: Item): Exclude<ActivityFilter, "all" | "merged"> => (n.kind === "time" ? "time" : n.internal ? "internal" : "reply");
  // the client's own words: told by the source, else by the name of the ticket's contact
  const fromClient = (n: Item) => (n.by ? n.by === "client" : n.author === tk.contact);
  const notes = tk.notes.filter((n) => !n.system).sort((x, y) => y.at.localeCompare(x.at));
  const counts = { all: notes.length, reply: 0, internal: 0, time: 0 };
  for (const n of notes) counts[kindOf(n)]++;
  // what came from a ticket merged into this one is tinted and has its own filter
  const mergedCount = notes.filter((n) => n.mergedFrom).length;
  const shown = notes.filter((n) => filter === "all" || (filter === "merged" ? Boolean(n.mergedFrom) : kindOf(n) === filter));
  const mergedChip = (n: Item) =>
    n.mergedFrom ? (
      <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-300" title={t("tickets.merge.fromHint", { number: n.mergedFrom })}>
        <GitMerge className="size-3" /> {n.mergedFrom}
      </span>
    ) : null;
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <section className="glass rounded-2xl border p-4">
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <p className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.activity")}</p>
        {(["all", "reply", "internal", "time", ...(mergedCount ? (["merged"] as const) : [])] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`tickets.activityFilter.${f}`)} {(f === "merged" ? mergedCount : counts[f]) > 0 && <span className="opacity-60">{f === "merged" ? mergedCount : counts[f]}</span>}
          </button>
        ))}
        {/* the legend: who is where */}
        <span className="ml-auto hidden items-center gap-3 text-[10px] text-muted-foreground sm:flex">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-muted-foreground/50" /> {t("tickets.activityLegend.client")}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-grad-gold" /> {t("tickets.activityLegend.tech")}
          </span>
        </span>
      </div>
      {partial ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("tickets.loadingActivity")}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("tickets.noActivity")}</p>
      ) : (
        <ol className="space-y-3">
          {shown.map((n) => {
            const kind = kindOf(n);
            const client = kind === "reply" && fromClient(n);
            const head = (
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-semibold">{n.author}</span>
                <span className="text-muted-foreground">{longDateTime(n.at)}</span>
              </p>
            );
            // internal notes and time entries: centered, not part of the conversation with the client
            if (kind === "internal" || kind === "time") {
              const time = kind === "time";
              return (
                <li key={n.id} className="flex justify-center">
                  <div
                    className={cn(
                      "w-full max-w-[88%] rounded-2xl border px-4 py-2.5",
                      time ? "border-sky-400/40 bg-sky-500/10" : "border-violet-400/40 bg-violet-500/10",
                      n.mergedFrom && "border-emerald-400/60 shadow-[inset_3px_0_0_0_rgba(52,211,153,0.8)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", time ? "bg-sky-500/20 text-sky-300" : "bg-violet-500/20 text-violet-300")}>
                        {time ? <Clock3 className="size-3" /> : <Lock className="size-3" />}
                        {time ? t("tickets.timeEntry", { hours: hm(n.hours ?? 0) }) : t("tickets.internalOnly")}
                      </span>
                      {time && n.billable === false && <span className="rounded-full bg-slate-500/20 px-1.5 text-[10px] font-medium text-slate-300">{t("tickets.timer.nonBillable")}</span>}
                      {time && n.billable !== false && (n.offsetHours ?? 0) > 0 && (
                        <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-300">
                          {t("tickets.timer.billedAfterOffset", { billed: hm(Math.max(0, (n.hours ?? 0) - (n.offsetHours ?? 0))), offset: hm(n.offsetHours ?? 0) })}
                        </span>
                      )}
                      {time && n.billedHours != null && n.billedHours > (n.hours ?? 0) + 0.001 && (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-300">{t("tickets.timer.billedMore", { billed: hm(n.billedHours) })}</span>
                      )}
                      {mergedChip(n)}
                      {head}
                      {time && can("tickets.edit") && (n.userId === me.id || can("timesheets.manage")) && (
                        <button type="button" title={t("tickets.timer.editEntry")} aria-label={t("tickets.timer.editEntry")} onClick={() => setEditing(n)} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground">
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {n.text && <p className="mt-1.5 whitespace-pre-wrap text-sm">{n.text}</p>}
                    {n.internalText && (
                      <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-violet-500/10 px-3 py-2 text-sm">
                        <span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">
                          <Lock className="size-2.5" /> {t("tickets.internalOnly")}
                        </span>
                        {n.internalText}
                      </p>
                    )}
                  </div>
                </li>
              );
            }
            // the conversation: the client on the left, the technician on the right
            return (
              <li key={n.id} className={cn("flex items-end gap-2", client ? "justify-start" : "flex-row-reverse justify-start")}>
                <span
                  className={cn(
                    "mb-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                    client ? "bg-muted text-muted-foreground" : "bg-grad-gold text-[#1a1204]",
                  )}
                  aria-hidden
                >
                  {initials(n.author)}
                </span>
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl border px-3.5 py-2",
                    client ? "rounded-bl-sm bg-muted/60" : "rounded-br-sm border-[color:var(--gold)]/30 bg-[color:var(--gold)]/12",
                    n.mergedFrom && "border-emerald-400/60 bg-emerald-500/10 shadow-[inset_3px_0_0_0_rgba(52,211,153,0.8)]",
                  )}
                >
                  {n.mergedFrom && <div className={cn("mb-1 flex", !client && "justify-end")}>{mergedChip(n)}</div>}
                  <div className={cn(!client && "text-right")}>{head}</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{n.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {editing && <EditTimeDialog ticketId={tk.id} note={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** A value you click to change (status, priority, queue, assignee). */
export function InlinePick({
  label,
  value,
  options,
  onPick,
  trigger,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; dot?: string }[];
  onPick: (v: string) => void;
  trigger: React.ReactNode;
  disabled?: boolean;
}) {
  if (disabled) return <>{trigger}</>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="group inline-flex items-center gap-1 rounded-full outline-none ring-[color:var(--gold)]/40 transition hover:ring-2 focus-visible:ring-2 data-[state=open]:ring-2"
        >
          {trigger}
          <ChevronDown className="size-3 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 group-data-[state=open]:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => o.value !== value && onPick(o.value)} className="gap-2">
            {o.dot && <span className={cn("size-2 rounded-full", o.dot)} />}
            <span className="flex-1 truncate">{o.label}</span>
            {o.value === value && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ticket title; click to change it (Enter saves, Escape cancels). */
function EditableTitle({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const cls = "font-display text-2xl font-bold leading-snug sm:text-3xl";
  if (draft === null || disabled) {
    return (
      <DialogPrimitive.Title className={cls}>
        {disabled ? (
          value
        ) : (
          <button type="button" onClick={() => setDraft(value)} className="group text-left" title={t("tickets.editTitle")}>
            {value}
            <Pencil className="ml-2 inline size-4 align-middle text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </DialogPrimitive.Title>
    );
  }
  const save = () => {
    const v = draft.trim();
    setDraft(null);
    if (v && v !== value) onSave(v);
  };
  return (
    <>
      <DialogPrimitive.Title className="sr-only">{value}</DialogPrimitive.Title>
      <Input
        autoFocus
        value={draft}
        maxLength={250}
        aria-label={t("tickets.fields.title")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className={cn(cls, "h-auto py-1")}
      />
    </>
  );
}

/** Description with an edit button . */
function EditableDescription({
  text,
  disabled,
  saving,
  partial,
  onSave,
}: {
  text: string;
  disabled: boolean;
  saving: boolean;
  partial: boolean;
  onSave: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Section
      id="description"
      icon={FileText}
      title={t("tickets.description")}
      badge={text
        .split("\n")
        .find((l) => l.trim())
        ?.slice(0, 70)}
      action={
        !disabled && draft === null ? (
          <button type="button" onClick={() => setDraft(text)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Pencil className="size-3" /> {t("common.edit")}
          </button>
        ) : null
      }
    >
      {draft === null ? (
        <>
          <Description text={text || "—"} />
          {partial && <Skeleton className="mt-2 h-4 w-2/3" />}
        </>
      ) : (
        <div className="space-y-2">
          <AiTextarea autoFocus rows={8} value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} aria-label={t("tickets.description")} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={saving}
              className="bg-grad-gold font-semibold text-[#1a1204]"
              onClick={() => {
                if (draft !== text) onSave(draft);
                setDraft(null);
              }}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** Secondary technicians: tick several, saved when the menu closes. */
function SecondaryPick({
  value,
  names,
  options,
  disabled,
  onSave,
}: {
  value: string[];
  names: string[];
  options: { id: string; name: string }[];
  disabled?: boolean;
  onSave: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[] | null>(null);
  const shown = names.length ? names.join(", ") : <span className="text-muted-foreground">—</span>;
  if (disabled) return <>{shown}</>;
  return (
    <DropdownMenu
      onOpenChange={(o) => {
        if (o) return setPicked(value);
        if (picked && (picked.length !== value.length || picked.some((x) => !value.includes(x)))) onSave(picked);
        setPicked(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("tickets.fields.secondary")}
          className="group inline-flex items-center gap-1 rounded-full text-left outline-none ring-[color:var(--gold)]/40 transition hover:ring-2 focus-visible:ring-2 data-[state=open]:ring-2"
        >
          <span>{shown}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tickets.fields.secondary")}</DropdownMenuLabel>
        {options.map((o) => {
          const on = (picked ?? value).includes(o.id);
          return (
            <DropdownMenuItem
              key={o.id}
              className="gap-2"
              onSelect={(e) => {
                e.preventDefault();
                setPicked((p) => {
                  const cur = p ?? value;
                  return on ? cur.filter((x) => x !== o.id) : [...cur, o.id];
                });
              }}
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="flex-1 truncate">{o.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Long descriptions: 5 lines, then "Show more" / "Show less". */
function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [text, open]);
  return (
    <div className="relative">
      <p ref={ref} className={cn("whitespace-pre-wrap text-sm leading-relaxed", !open && "line-clamp-5")}>
        {text}
      </p>
      {/* a long description: one discreet arrow on the section's bottom edge, in the middle, to open or fold it */}
      {(long || open) && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? t("tickets.showLess") : t("tickets.showMore")}
          title={open ? t("tickets.showLess") : t("tickets.showMore")}
          className="absolute -bottom-4 left-1/2 flex h-4 w-20 -translate-x-1/2 items-center justify-center rounded-t-lg border border-b-0 border-[color:var(--glass-border)] bg-foreground/[0.05] text-muted-foreground transition-colors hover:border-[color:var(--gold)]/40 hover:bg-[color:var(--gold)]/10 hover:text-primary"
        >
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      )}
    </div>
  );
}

function Detail({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] text-muted-foreground">{label}</dt>
        <dd className="truncate">{children}</dd>
      </div>
    </div>
  );
}

/** Portal-only planned start date (Planning section, above the due date), saved right away. */
/** The time on the start date (optional): saved when the field is left */
export function StartTimeInput({
  tk,
  disabled,
  onSave,
  className,
}: {
  tk: Pick<TicketSummary, "startDate" | "startTime">;
  disabled: boolean;
  onSave: (time: string | null) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState(tk.startTime ?? "");
  useEffect(() => setV(tk.startTime ?? ""), [tk.startTime]);
  const commit = () => {
    const next = v || null;
    if (next !== (tk.startTime ?? null)) onSave(next);
  };
  return (
    <Input
      type="time"
      className={cn("mt-1 h-8 w-32", className)}
      disabled={disabled}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      aria-label={t("tickets.startTime")}
      title={t("tickets.startTimeHint")}
    />
  );
}

/** Today, YYYY-MM-DD (local) */
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function StartDate({
  value,
  onChange,
}: {
  value: { startDate: string | null; startTime: string | null; startLocked: boolean; milestoneDate: string | null; milestoneTime: string | null };
  onChange: (p: { startDate?: string | null; startTime?: string | null; startLocked?: boolean; milestoneDate?: string | null; milestoneTime?: string | null }) => void;
}) {
  const { t } = useTranslation();
  const can = useCan();
  const off = !can("tickets.edit");
  return (
    <div className="flex gap-3">
      <CalendarPlus className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <label htmlFor="start-date">{t("tickets.fields.start")}</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="rounded border border-[color:var(--gold)]/40 px-1 text-[9px] font-semibold text-primary">{t("tickets.portalTag")}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">{t("tickets.portalHint")}</TooltipContent>
          </Tooltip>
        </dt>
        <dd>
          <Input
            id="start-date"
            type="date"
            className={cn("mt-0.5 h-8")}
            disabled={off}
            value={value.startDate ?? ""}
            onChange={(e) => onChange({ startDate: e.target.value || null })}
          />
          {/* Restriction: nobody works on it before that day (off by default) */}
          <label
            className={cn("mt-1.5 flex w-fit items-center gap-2 rounded-md px-1 text-xs", !value.startDate && "opacity-60")}
            title={t("tickets.startLock.hint")}
          >
            <Switch
              checked={value.startLocked}
              disabled={off || !value.startDate}
              onCheckedChange={(v) => onChange({ startLocked: v })}
              aria-label={t("tickets.startLock.label")}
            />
            <Lock className={cn("size-3.5", value.startLocked ? "text-amber-300" : "text-muted-foreground")} />
            {t("tickets.startLock.label")}
          </label>
          {!value.startDate && <p className="mt-0.5 text-[10px] text-muted-foreground">{t("tickets.startLock.needsDate")}</p>}
          {/* the goal date: between the start and the final due date, so the technician and the AI plan in steps */}
          <label htmlFor="milestone-date" className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={t("tickets.milestone.hint")}>
            <Flag className="size-3 text-primary" /> {t("tickets.milestone.label")}
          </label>
          <Input
            id="milestone-date"
            type="date"
            className="mt-0.5 h-8"
            disabled={off}
            min={value.startDate ?? undefined}
            value={value.milestoneDate ?? ""}
            onChange={(e) => onChange({ milestoneDate: e.target.value || null })}
          />
          <Input
            type="time"
            className="mt-1 h-8 w-32"
            disabled={off}
            value={value.milestoneTime ?? ""}
            aria-label={t("tickets.milestone.time")}
            onChange={(e) => onChange(e.target.value && !value.milestoneDate ? { milestoneDate: value.startDate ?? todayLocal(), milestoneTime: e.target.value } : { milestoneTime: e.target.value || null })}
          />
        </dd>
      </div>
    </div>
  );
}

/** A day (and, for the checkpoint, a time) changed in place from the ticket's header */
function QuickDate({ icon: Icon, label, date, time, withTime, disabled, min, onSave }: { icon: LucideIcon; label: string; date: string | null; time?: string | null; withTime?: boolean; disabled: boolean; min?: string | null; onSave: (date: string | null, time: string | null) => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState(date ?? "");
  const [h, setH] = useState(time ?? "");
  useEffect(() => setD(date ?? ""), [date]);
  useEffect(() => setH(time ?? ""), [time]);
  const shown = date ? shortDate(date) + (withTime && time ? ` ${time}` : "") : "—";
  const badge = (
    <span className={cn("flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground", !disabled && "cursor-pointer hover:border-[color:var(--gold)]/60")}>
      <Icon className="size-3.5" />
      {label} · {shown}
    </span>
  );
  if (disabled) return badge;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label}>
          {badge}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2">
        <p className="text-sm font-semibold">{label}</p>
        <div className="flex gap-2">
          <Input type="date" className="h-8 min-w-0 flex-1" value={d} min={min ?? undefined} onChange={(e) => (setD(e.target.value), !withTime && onSave(e.target.value || null, null))} />
          {withTime && <Input type="time" className="h-8 w-28 shrink-0" value={h} aria-label={t("tickets.milestone.time")} onChange={(e) => setH(e.target.value)} />}
        </div>
        {withTime && (
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onSave(null, null)}>
              {t("tickets.quickClear")}
            </Button>
            <Button type="button" size="sm" disabled={!d} onClick={() => onSave(d, h || null)}>
              {t("common.save")}
            </Button>
          </div>
        )}
        {!withTime && date && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSave(null, null)}>
            {t("tickets.quickClear")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

type Staged = {
  status?: string;
  priority?: string;
  queue?: string;
  dueAt?: string;
  assigneeId?: string | null;
  startDate?: string | null;
  startTime?: string | null;
  startLocked?: boolean;
  milestoneDate?: string | null;
  milestoneTime?: string | null;
};
/** A field changed but not saved yet */
export const MODIFIED = "ring-2 ring-[color:var(--gold)]/80 ring-offset-1 ring-offset-background";
export const MODIFIED_BOX = "border-[color:var(--gold)] ring-1 ring-[color:var(--gold)]/50";

/** "3 changements" with ✓ (save them all) and ✗ (drop them) */
export function PendingBar({
  count,
  saving,
  onSave,
  onCancel,
  floating,
}: {
  count: number;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  floating?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary",
        floating && "bg-popover/95 py-1.5 pl-4 pr-1.5 text-sm shadow-[0_16px_50px_-12px_rgba(0,0,0,0.7),0_0_30px_-10px_rgba(255,206,26,0.6)] backdrop-blur-xl",
      )}
    >
      {t("tickets.pendingCount", { count })}
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        title={t("tickets.pendingSave")}
        aria-label={t("tickets.pendingSave")}
        className={cn(
          "flex items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60",
          floating ? "h-8 w-8" : "h-6 w-6",
        )}
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        title={t("tickets.pendingCancel")}
        aria-label={t("tickets.pendingCancel")}
        className={cn(
          "flex items-center justify-center rounded-full border bg-background/60 text-muted-foreground hover:text-destructive",
          floating ? "h-8 w-8" : "h-6 w-6",
        )}
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** Reply to the client or internal note. An AI draft can be dropped in. */
function NoteComposer({
  tk,
  draft,
  onDraftUsed,
  focusRequest,
}: {
  tk: TicketDetail;
  draft: { text: string; internal: boolean } | null;
  onDraftUsed: () => void;
  /** From the quick actions (Reply / Internal note): mode + focus */
  focusRequest?: { internal: boolean; at: number } | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [internal, setInternal] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setInternal(draft.internal);
    onDraftUsed();
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [draft, onDraftUsed]);
  useEffect(() => {
    if (!focusRequest) return;
    setInternal(focusRequest.internal);
    requestAnimationFrame(() => ref.current?.focus());
  }, [focusRequest]);
  const [focused, setFocused] = useState(false);
  // a reply also goes by email to the ticket's contact (on by default, switched off for this one if wanted), and to other people
  const contactEmail = tk.contactInfo?.email ?? null;
  const [emailIt, setEmailIt] = useState(true);
  const [mailOthers, setMailOthers] = useState<string[]>([]);
  // an internal note can tell colleagues: the bell and an email with the note
  const me = useMe();
  const [tell, setTell] = useState<string[]>([]);
  const colleagues = tk.options.technicians.filter((p) => p.id !== me.id);
  // files: kept on the ticket, and sent with the reply when it goes by email
  const [files, setFiles] = useState<File[]>([]);
  const pick = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => {
    const ok = [...(list ?? [])].filter((f) => {
      if (f.size > 5 * 1024 * 1024) toast.error(t("tickets.files.tooBig", { name: f.name }));
      return f.size <= 5 * 1024 * 1024;
    });
    setFiles((x) => [...x, ...ok].slice(0, 10));
  };
  const send = useMutation({
    mutationFn: async () => {
      // the files first (they are the ticket's, `email_out` when they go with an email), then the note naming them
      const byEmail = !internal && (emailIt || mailOthers.length > 0);
      const ids: string[] = [];
      for (const f of files) {
        const r = await api.post<{ id: string | null }>(`/tickets/${tk.id}/attachments`, { name: f.name, contentType: f.type || "application/octet-stream", data: await fileToBase64(f), source: byEmail ? "email_out" : "upload" });
        if (r.id) ids.push(r.id);
      }
      return api.post<{ emailed?: boolean; to?: string | null; noContactEmail?: boolean }>(`/tickets/${tk.id}/notes`, { text, internal, ...(internal ? { notifyUserIds: tell } : { email: emailIt, others: mailOthers, attachmentIds: ids }) });
    },
    onSuccess: (r) => {
      setText("");
      setFiles([]);
      setEmailIt(true);
      setTell([]);
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
      if (internal) {
        toast.success(t("tickets.noteAdded"));
        const n = (r as { notified?: number }).notified;
        if (n) toast.success(t("tickets.noteNotified", { count: n }));
      }
      else if (r.emailed) toast.success(t("tickets.replySentEmail", { to: r.to ?? "" }));
      else if (emailIt && r.noContactEmail) toast.warning(t("tickets.replyNoEmail"));
      else if (emailIt && r.to) toast.error(t("tickets.replyEmailFailed", { to: r.to }));
      else toast.success(t("tickets.replySent"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return (
    <div className={cn("glass rounded-2xl border p-3 transition-colors", internal && "border-violet-500/30")}>
      <div className="mb-2 flex items-center gap-2">
      <div className="inline-flex rounded-lg border p-0.5 text-xs">
        {[false, true].map((v) => (
          <button
            key={String(v)}
            type="button"
            onClick={() => setInternal(v)}
            className={cn(
              "rounded-md px-2.5 py-1 font-medium",
              internal === v ? (v ? "bg-violet-500/20 text-violet-200" : "bg-grad-gold text-[#1a1204]") : "text-muted-foreground",
            )}
          >
            {v ? t("tickets.noteInternal") : t("tickets.noteReply")}
          </button>
        ))}
      </div>
        {/* the same timer, small, where the work is written */}
        <TimerControl ticketId={tk.id} compact />
      </div>
      <AiTextarea
        ref={ref}
        rows={focused || text ? 5 : 2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // Ctrl+Enter sends
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !send.isPending) send.mutate();
        }}
        placeholder={internal ? t("tickets.notePlaceholderInternal") : t("tickets.notePlaceholder")}
        className="resize-y transition-[height]"
      />
      {internal && colleagues.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <BellRing className="size-3" /> {t("tickets.noteNotify")}
          </span>
          {colleagues.map((p) => {
            const on = tell.includes(p.id);
            return (
              <button key={p.id} type="button" onClick={() => setTell((x) => (on ? x.filter((i) => i !== p.id) : [...x, p.id]))} className={cn("rounded-full border px-2 py-0.5 text-[11px]", on ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
                {p.name}
              </button>
            );
          })}
        </div>
      )}
      {!internal && (
        <div className="mt-2">
          <EmailSend ticket={tk} contact={emailIt && Boolean(contactEmail)} onContact={setEmailIt} others={mailOthers} onOthers={setMailOthers} contactLabel={(name, email) => t("tickets.replyEmailTo", { name, email })} idPrefix="reply" />
        </div>
      )}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]">
              <Paperclip className="size-3 text-muted-foreground" /> {f.name}
              <button type="button" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive" aria-label={t("common.delete")}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input ref={pick} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => pick.current?.click()}>
            <Paperclip className="size-3.5" /> {t("tickets.files.attach")}
          </Button>
          {t("tickets.noteSendHint")}
        </span>
        <Button size="sm" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()} className={cn(!internal && "bg-grad-gold text-[#1a1204]")}>
          {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {internal ? t("tickets.addNote") : t("tickets.send")}
        </Button>
      </div>
    </div>
  );
}

// ── AI assistant ───────────────────────────────────────────────────────────────
function AiMenu({ tk, onReply }: { tk: TicketDetail; onReply: (text: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const aiError = useAiError();
  const analyzeModel = useAiModel("ticket.analyze");
  const replyModel = useAiModel("ticket.reply");
  const direction = useAiDirection(`ticket:${tk.id}`);
  const done = () => void qc.invalidateQueries({ queryKey: ["ai", "options"] });
  const analyze = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`, { ...analyzeModel.body, ...direction.body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets", "ai", tk.id] });
      done();
    },
    onError: (e) => toast.error(aiError(e)),
  });
  const reply = useMutation({
    mutationFn: () => api.post<{ text: string }>(`/tickets/${tk.id}/ai/reply`, { ...replyModel.body, ...direction.body }),
    onSuccess: (r) => {
      onReply(r.text);
      done();
    },
    onError: (e) => toast.error(aiError(e)),
  });
  const busy = analyze.isPending || reply.isPending;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 gap-2 border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} {t("tickets.ai.button")}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={() => analyze.mutate()} disabled={busy} className="items-start gap-3 py-2">
          <ListChecks className="mt-0.5 size-4 text-violet-300" />
          <span>
            <span className="block font-medium">{t("tickets.ai.analyze")}</span>
            <span className="block text-xs text-muted-foreground">{t("tickets.ai.analyzeHint")}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => reply.mutate()} disabled={busy} className="items-start gap-3 py-2">
          <MessageSquareReply className="mt-0.5 size-4 text-violet-300" />
          <span>
            <span className="block font-medium">{t("tickets.ai.reply")}</span>
            <span className="block text-xs text-muted-foreground">{t("tickets.ai.replyHint")}</span>
          </span>
        </DropdownMenuItem>
        {analyzeModel.options?.allowChoice && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("ai.picker.title")}</DropdownMenuLabel>
            <AiModelSub feature="ticket.analyze" label={t("tickets.ai.analyze")} m={analyzeModel} />
            <AiModelSub feature="ticket.reply" label={t("tickets.ai.reply")} m={replyModel} />
          </>
        )}
        <AiTodayLine />
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("tickets.ai.privacy")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Portal-only section: the latest AI analysis (summary, steps, risks, questions). */
function AiPanel({ tk, onToNote }: { tk: TicketDetail; onToNote: (text: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const aiError = useAiError();
  const { data: list = [] } = useQuery({ queryKey: ["tickets", "ai", tk.id], queryFn: () => api.get<AiAnalysis[]>(`/tickets/${tk.id}/ai`) });
  const analyzeModel = useAiModel("ticket.analyze");
  const direction = useAiDirection(`ticket:${tk.id}`);
  const again = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`, { ...analyzeModel.body, ...direction.body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets", "ai", tk.id] }),
    onError: (e) => toast.error(aiError(e)),
  });
  const a = list[0];
  if (!a) return null;
  const c = a.content;
  const asNote = [
    `${t("tickets.ai.summary")} : ${c.summary}`,
    c.nextSteps.length ? `\n${t("tickets.ai.nextSteps")} :\n${c.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
    c.risks.length ? `\n${t("tickets.ai.risks")} :\n${c.risks.map((s) => `- ${s}`).join("\n")}` : "",
    c.questions.length ? `\n${t("tickets.ai.questions")} :\n${c.questions.map((s) => `- ${s}`).join("\n")}` : "",
  ].join("\n");
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-xl border border-violet-500/30 bg-[linear-gradient(135deg,rgba(139,92,246,0.10),transparent_60%)] p-4"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-violet-500/20 text-violet-200">
          <Bot className="size-4" />
        </span>
        <p className="text-sm font-semibold">{t("tickets.ai.panelTitle")}</p>
        <span className="rounded border border-violet-400/40 px-1 text-[9px] font-semibold text-violet-200">{t("tickets.portalTag")}</span>
        <span className="text-[11px] text-muted-foreground">
          {a.author ?? "—"} · {longDateTime(a.createdAt)}
        </span>
        <span className="ml-auto flex gap-1">
          {tk.ai && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => again.mutate()} disabled={again.isPending}>
              {again.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("tickets.ai.refresh")}
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 border-violet-500/40 text-xs" onClick={() => onToNote(asNote)}>
            <NotebookPen className="size-3.5" /> {t("tickets.ai.toNote")}
          </Button>
        </span>
      </div>
      <p className="text-sm leading-relaxed">{c.summary}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {c.nextSteps.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-violet-200">
              <ListChecks className="size-3.5" /> {t("tickets.ai.nextSteps")}
            </p>
            <ol className="space-y-1.5 text-sm">
              {c.nextSteps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-violet-500/20 font-mono text-[10px] text-violet-200">
                    {i + 1}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="space-y-3">
          {c.risks.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-orange-300">
                <AlertTriangle className="size-3.5" /> {t("tickets.ai.risks")}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {c.risks.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {c.questions.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <HelpCircle className="size-3.5" /> {t("tickets.ai.questions")}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {c.questions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {c.suggestedPriority && c.suggestedPriority !== tk.priorityKind && (
            <p className="text-xs text-muted-foreground">
              {t("tickets.ai.suggestedPriority")} :{" "}
              <span className={cn("font-medium", PRIORITY_STYLE[c.suggestedPriority].text)}>{t(`tickets.priority.${c.suggestedPriority}`)}</span>
            </p>
          )}
        </div>
      </div>
    </motion.section>
  );
}

// ── Presence ─────────────────────────────────────────────────────────────────────
/** Corner light: green = only you, orange (pulsing) = also open by someone else. */
function PresenceLight({ viewers }: { viewers: Viewer[] | null }) {
  const { t } = useTranslation();
  if (viewers === null) return null;
  const busy = viewers.length > 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium",
            busy ? "border-orange-500/40 bg-orange-500/10 text-orange-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
          )}
        >
          <span className="relative flex size-2.5">
            {busy && <span className="absolute inline-flex size-full animate-ping rounded-full bg-orange-400 opacity-75" />}
            <span className={cn("relative inline-flex size-2.5 rounded-full", busy ? "bg-orange-400" : "bg-emerald-400")} />
          </span>
          {busy ? (
            <>
              <span className="flex -space-x-1.5">
                {viewers.slice(0, 3).map((v) => (
                  <span
                    key={v.userId}
                    className="flex size-5 items-center justify-center rounded-full border border-background bg-orange-500/30 text-[9px] font-bold text-orange-100"
                  >
                    {initials(v.name)}
                  </span>
                ))}
              </span>
              <Eye className="size-3.5" />
            </>
          ) : (
            t("tickets.presenceAlone")
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{busy ? t("tickets.openBy", { names: viewers.map((v) => v.name).join(", ") }) : t("tickets.presenceAloneHint")}</TooltipContent>
    </Tooltip>
  );
}

/** Popup on arrival when someone else already has the ticket open; a toast if someone joins later. */
function OpenedByOthers({ viewers }: { viewers: Viewer[] | null }) {
  const { t } = useTranslation();
  const me = useMe();
  const [popup, setPopup] = useState<Viewer[] | null>(null);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (viewers === null) return;
    if (known.current === null) {
      known.current = new Set(viewers.map((v) => v.userId));
      if (viewers.length) setPopup(viewers);
      return;
    }
    for (const v of viewers) {
      if (!known.current.has(v.userId) && v.userId !== me.id) toast.warning(t("tickets.joined", { name: v.name }));
    }
    known.current = new Set(viewers.map((v) => v.userId));
  }, [viewers, me.id, t]);

  return (
    <Dialog open={Boolean(popup)} onOpenChange={(o) => !o && setPopup(null)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="relative flex size-9 items-center justify-center rounded-xl bg-orange-500/15 text-orange-400">
              <span className="absolute inset-0 animate-ping rounded-xl bg-orange-400/20" />
              <Eye className="relative size-4" />
            </span>
            {t("tickets.alreadyOpenTitle")}
          </DialogTitle>
          <DialogDescription className="pt-1">{t("tickets.alreadyOpenText", { names: popup?.map((v) => v.name).join(", ") ?? "" })}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end pt-2">
          <Button className="bg-grad-gold font-semibold text-[#1a1204]" onClick={() => setPopup(null)}>
            {t("tickets.alreadyOpenOk")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown instead of the AI button while Claude is not set up or is switched off,
 * so the feature can be found; administrators get a shortcut to the settings.
 */
export function AiSetupHint({ label }: { label: string }) {
  const { t } = useTranslation();
  const me = useMe();
  const [, setParams] = useSearchParams();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 gap-2 border-dashed border-violet-500/40 text-violet-200/80 hover:bg-violet-500/10">
          <Sparkles className="size-4" /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-violet-300" /> {t("tickets.ai.notReadyTitle")}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">{me.isAdmin ? t("tickets.ai.notReadyAdmin") : t("tickets.ai.notReadyUser")}</p>
        {me.isAdmin && (
          <Button
            size="sm"
            className="mt-3 w-full bg-grad-gold font-semibold text-[#1a1204]"
            onClick={() =>
              setParams((p) => {
                p.set("admin", "integrations");
                p.set("integration", "ai");
                return p;
              })
            }
          >
            {t("tickets.ai.configure")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The tickets merged into this one: a small button with a list, each ticket as it was written (description) */
function MergedTickets({ tk }: { tk: TicketDetail }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const list = tk.mergedTickets ?? [];
  if (!list.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/10" aria-label={t("tickets.merge.list")}>
          <GitMerge className="size-4" /> {t("tickets.merge.listCount", { count: list.length })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[92vw] space-y-2 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.merge.list")}</p>
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {list.map((m) => (
            <li key={m.id} className="rounded-xl border border-emerald-400/30 bg-emerald-500/5 p-2.5 text-sm">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-emerald-300">{m.number}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{m.title}</span>
                <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => ws.open(m.id)}>
                  {t("tickets.rowMenu.open")}
                </button>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {m.contact && `${m.contact} · `}
                {t("tickets.merge.mergedOn", { date: longDateTime(m.mergedAt) })}
              </p>
              {m.description.trim() && <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-xs text-muted-foreground">{m.description}</p>}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
