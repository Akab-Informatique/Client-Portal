import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  AlertTriangle,
  ArrowDownUp,
  Bot,
  Building2,
  CalendarClock,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eye,
  FileText,
  HardDrive,
  HelpCircle,
  Inbox,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  MessageSquareReply,
  Minus,
  MonitorCog,
  MonitorPlay,
  NotebookPen,
  Pencil,
  Phone,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  UserRound,
  Users,
  X,
  type LucideIcon,
  MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { useCan, useMe } from "@/lib/session";
import { DueEditor } from "./DueEditor";
import { cn, initials } from "@/lib/utils";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { CompanyPicker, ContactPicker, useCompanies } from "./pickers";
import { TimerControl } from "./timers";
import { AssetContent, AssetPicker } from "./AssetCard";
import { ChargeButtons } from "./Charges";
import { PriorityDialog, TicketPriorities } from "./Planning";
import { TicketSmsPanel, useTicketSms } from "@/pages/sms/SmsPage";
import { useConfirm } from "@/components/ConfirmDialog";
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
  const confirm = useConfirm();
  const editable = can("tickets.edit");
  const update = useTicketUpdate(tk);
  const qc = useQueryClient();
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
  };
  const stage = (p: Staged) => {
    const next: Staged = { ...p };
    // no day, no time nor restriction
    if (p.startDate === null) Object.assign(next, { startTime: null, startLocked: false });
    for (const k of Object.keys(next) as (keyof Staged)[]) if (next[k] === original[k]) delete next[k];
    if (!Object.keys(next).length) return;
    setStaged((s) => ({ ...s, ...next }));
    saveAll.mutate(next);
  };
  const view = { ...original, ...staged };
  const changed = (k: keyof Staged) => k in staged;
  const saveAll = useMutation({
    mutationFn: async (changes: Staged) => {
      const { startDate, startTime, startLocked, ...patch } = changes;
      let next: TicketDetail | null = null;
      if (Object.keys(patch).length) next = await api.patch<TicketDetail>(`/tickets/${tk.id}`, patch);
      const start = { startDate, startTime, startLocked };
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
  const statusOpt = tk.options.statuses.find((s) => s.value === view.status);
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
  // the exchange shown: the ticket activity, or the texts with the client
  const [thread, setThread] = useState<"activity" | "sms">("activity");
  const { data: texts } = useTicketSms(tk.id, can("sms.view") && !partial);
  const done = tk.options.statuses.find((s) => s.kind === "complete");
  const remote = tk.asset?.links.remote ?? null;
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
            {can("tickets.ai") &&
              (tk.ai ? <AiMenu tk={tk} onReply={(text) => setDraft({ text, internal: false })} /> : <AiSetupHint label={t("tickets.ai.button")} />)}
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
          <EditableTitle value={tk.title} disabled={!editable || partial} onSave={(title) => update.mutate({ title })} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <InlinePick
              disabled={!editable}
              label={t("tickets.fields.status")}
              value={view.status}
              options={tk.options.statuses.map((s) => ({ value: s.value, label: txt.status(s) }))}
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
            <InlinePick
              disabled={!editable}
              label={t("tickets.fields.queue")}
              value={view.queue}
              options={tk.options.queues.map((q) => ({ value: q.value, label: q.label ?? q.value }))}
              onPick={(v) => stage({ queue: v })}
              trigger={<span className={cn("rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground")}>{queueText || "—"}</span>}
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
                  title={editable ? t("tickets.due.change") : longDateTime(view.dueAt)}
                >
                  <CalendarClock className="size-3.5" />
                  {changed("dueAt")
                    ? longDateTime(view.dueAt)
                    : due === "overdue"
                      ? t("tickets.overdue")
                      : due === "today"
                        ? t("tickets.today")
                        : longDateTime(view.dueAt)}
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
                    <p className="text-xs text-muted-foreground">{longDateTime(view.dueAt)}</p>
                    <DueEditor dueAt={view.dueAt} quick autoFocus onSave={(dueAt) => stage({ dueAt })} />
                  </PopoverContent>
                </Popover>
              ) : (
                badge
              );
            })()}

            {/* Quick actions: what a technician does next, one click away */}
            <span className="hidden h-5 w-px bg-border lg:mx-1 lg:block" />
            <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
              {editable && (
                <>
                  <QuickAction
                    icon={MessageSquareReply}
                    label={t("tickets.quickAction.reply")}
                    kbd="R"
                    onClick={() => setFocusNote({ internal: false, at: Date.now() })}
                  />
                  <QuickAction icon={Lock} label={t("tickets.quickAction.note")} kbd="I" onClick={() => setFocusNote({ internal: true, at: Date.now() })} />
                </>
              )}
              {remote && <QuickAction icon={MonitorPlay} label={t("tickets.asset.remote")} href={remote} accent />}
              {phone && (
                <QuickAction
                  icon={Phone}
                  label={t("tickets.quickAction.call", { name: tk.contact.split(" ")[0] })}
                  href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                  title={phone}
                />
              )}
              {can("sms.view") && <QuickAction icon={MessageSquareText} label={t("sms.quick")} onClick={() => setThread("sms")} />}
              {email && (
                <QuickAction
                  icon={Mail}
                  label={t("tickets.quickAction.email")}
                  href={`mailto:${email}?subject=${encodeURIComponent(`[${tk.number}] ${tk.title}`)}`}
                  title={email}
                />
              )}
              {can("tickets.plan") && <QuickAction icon={Star} label={t("planning.givePriority")} onClick={() => setGiving(true)} />}
              {editable && done && tk.statusKind !== "complete" && (
                <QuickAction
                  icon={CheckCircle2}
                  label={t("tickets.quickAction.resolve")}
                  onClick={() =>
                    void confirm({ title: t("tickets.quickAction.resolveConfirm", { status: txt.status(done) }) }).then(
                      (ok) => ok && update.mutate({ status: done.value }),
                    )
                  }
                />
              )}
            </div>
          </div>
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
            {(tk.warnings ?? []).map((w) => (
              <p key={w.part} className="flex items-start gap-2 rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-2.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-orange-300" />
                <span>
                  {t(`tickets.partFailed.${w.part}`)} <span className="text-muted-foreground">{w.detail}</span>
                </span>
              </p>
            ))}
            <TicketPriorities ticketId={tk.id} />
            <EditableDescription
              text={tk.description}
              disabled={!editable || partial}
              saving={update.isPending}
              partial={partial}
              onSave={(description) => update.mutate({ description })}
            />
            <AiPanel tk={tk} onToNote={(text) => setDraft({ text, internal: true })} />
            {can("sms.view") && (
              <div className="flex items-center gap-1 rounded-xl border p-1 text-xs">
                {(["activity", "sms"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setThread(k)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
                      thread === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {k === "activity" ? <Clock3 className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
                    {t(`sms.thread.${k}`)}
                    {k === "sms" && (texts?.messages.length ?? 0) > 0 && (
                      <span className="rounded-full bg-black/15 px-1.5 font-mono text-[10px]">{texts!.messages.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {thread === "sms" && can("sms.view") ? <TicketSmsPanel ticketId={tk.id} phone={phone} /> : <Activity tk={tk} partial={partial && !loadError} />}
          </div>
          {/* Charges and expenses: small buttons right above the note box */}
          <div className="flex flex-wrap items-center gap-1.5 pb-2 lg:pr-2">
            <ChargeButtons tk={tk} editable={editable} partial={partial} />
            {can("sms.view") && (
              <Button
                type="button"
                size="sm"
                variant={thread === "sms" ? "default" : "outline"}
                className={cn("h-8 gap-1.5 text-xs", thread === "sms" && "bg-grad-gold text-[#1a1204]")}
                onClick={() => setThread(thread === "sms" ? "activity" : "sms")}
              >
                <MessageSquareText className="size-3.5" /> {t("sms.quick")}
                {(texts?.messages.length ?? 0) > 0 && <span className="font-mono text-[10px] opacity-70">{texts!.messages.length}</span>}
              </Button>
            )}
          </div>
          {editable && thread !== "sms" && (
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

          <Section
            id="device"
            icon={HardDrive}
            title={t("tickets.asset.title")}
            badge={tk.asset?.name}
            action={editable && !partial ? <AssetPicker tk={tk} onPick={(assetId) => update.mutate({ assetId })} /> : null}
          >
            <AssetContent tk={tk} editable={editable} partial={partial} onPick={(assetId) => update.mutate({ assetId })} />
          </Section>

          {tk.startLocked && tk.startDate && tk.startDate > todayLocal() && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <Lock className="mt-0.5 size-3.5 shrink-0" />{" "}
              {t("tickets.startLock.notice", { date: tk.startTime ? `${shortDate(tk.startDate)} ${tk.startTime}` : shortDate(tk.startDate) })}
            </p>
          )}
          <Section id="planning" icon={CalendarClock} title={t("tickets.sections.planning")}>
            <dl className="space-y-3">
              <StartDate tk={tk} value={view} onChange={stage} />
              <Detail icon={CalendarClock} label={t("tickets.fields.due")}>
                {editable ? (
                  <div className={cn("mt-0.5 rounded-lg")}>
                    <DueEditor dueAt={view.dueAt} onSave={(dueAt) => stage({ dueAt })} />
                  </div>
                ) : (
                  longDateTime(tk.dueAt)
                )}
              </Detail>
              <Detail icon={Clock3} label={t("tickets.fields.hours")}>
                {partial ? "…" : t("tickets.hoursValue", { hours: tk.hours.toLocaleString() })}
              </Detail>
            </dl>
          </Section>

          <Section id="team" icon={Users} title={t("tickets.sections.team")} badge={tk.assignee?.name}>
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
          </Section>

          <Section id="details" icon={Inbox} title={t("tickets.sections.details")} defaultOpen={false}>
            <dl className="space-y-3">
              <Detail icon={SOURCE_ICON[tk.source] ?? Inbox} label={t("tickets.fields.source")}>
                {tk.source ? t(`tickets.source.${tk.source}`, { defaultValue: tk.source }) : "—"}
              </Detail>
              <Detail icon={Clock3} label={t("tickets.fields.created")}>
                {longDateTime(tk.createdAt)}
              </Detail>
              <Detail icon={RefreshCw} label={t("tickets.sections.lastActivity")}>
                {longDateTime(tk.updatedAt)}
              </Detail>
            </dl>
          </Section>
        </aside>
      </div>
      <OpenedByOthers viewers={viewers} />
      {giving && <PriorityDialog priority={null} ticket={{ id: tk.id, number: tk.number, title: tk.title }} onClose={() => setGiving(false)} />}
    </>
  );
}

/** A tool in the quick-action bar: a button, or a link (new tab for web pages). */
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
  defaultOpen = true,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Shown next to the title when the section is closed */
  badge?: string | null;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, toggle] = useSectionOpen(id, defaultOpen);
  return (
    <section className="glass rounded-2xl border text-sm">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon className="size-3.5 shrink-0 text-primary" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
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
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

type ActivityFilter = "all" | "reply" | "internal" | "time";

/** What was said and done: replies, internal notes and time entries, filterable. */
function Activity({ tk, partial }: { tk: TicketDetail; partial: boolean }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [newestFirst, setNewestFirst] = useState(() => {
    try {
      // newest first unless the technician chose otherwise
      return localStorage.getItem("akab.ticket.newestFirst") !== "0";
    } catch {
      return true;
    }
  });
  const flip = () =>
    setNewestFirst((v) => {
      try {
        localStorage.setItem("akab.ticket.newestFirst", v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  // what Autotask writes by itself (workflow rules…): hidden unless asked for
  const [showSystem, setShowSystem] = useState(false);
  const systemCount = tk.notes.filter((n) => n.system).length;
  // by date (oldest → newest; flipped below for newest first)
  const notes = (showSystem ? tk.notes : tk.notes.filter((n) => !n.system)).slice().sort((x, y) => x.at.localeCompare(y.at));
  const kindOf = (n: TicketDetail["notes"][number]): Exclude<ActivityFilter, "all"> => (n.kind === "time" ? "time" : n.internal ? "internal" : "reply");
  const counts = { all: notes.length, reply: 0, internal: 0, time: 0 };
  for (const n of notes) counts[kindOf(n)]++;
  const shown = notes.filter((n) => filter === "all" || kindOf(n) === filter);
  if (newestFirst) shown.reverse();

  return (
    <section className="glass rounded-2xl border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <p className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.activity")}</p>
        {(["all", "reply", "internal", "time"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              filter === f
                ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`tickets.activityFilter.${f}`)} {counts[f] > 0 && <span className="opacity-60">{counts[f]}</span>}
          </button>
        ))}
        {systemCount > 0 && (
          <button
            type="button"
            onClick={() => setShowSystem((v) => !v)}
            className={cn("ml-auto rounded-full border px-2 py-0.5 text-[11px]", showSystem ? "border-slate-500/50 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            title={t("tickets.systemNotesHint")}
          >
            {t(showSystem ? "tickets.systemNotesHide" : "tickets.systemNotesShow", { count: systemCount })}
          </button>
        )}
        <button type="button" onClick={flip} className={cn("flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground", !systemCount && "ml-auto")}>
          <ArrowDownUp className="size-3" /> {newestFirst ? t("tickets.activityOrder.newest") : t("tickets.activityOrder.oldest")}
        </button>
      </div>
      {partial ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("tickets.loadingActivity")}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("tickets.noActivity")}</p>
      ) : (
        <ol className="relative space-y-4 border-l pl-5">
          {shown.map((n) => (
            <li key={n.id} className="relative">
              <span
                className={cn(
                  "absolute -left-[27px] top-1 flex size-3.5 items-center justify-center rounded-full border-2 border-background",
                  n.kind === "time" ? "bg-sky-400" : n.internal ? "bg-violet-400" : "bg-grad-gold",
                )}
              />
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{n.author}</span>
                <span className="text-xs text-muted-foreground">{longDateTime(n.at)}</span>
                {n.kind === "time" && (
                  <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 text-[10px] font-medium text-sky-300">
                    <Clock3 className="size-2.5" /> {t("tickets.timeEntry", { hours: (n.hours ?? 0).toLocaleString() })}
                  </span>
                )}
                {n.kind === "time" && n.billable === false && (
                  <span className="rounded-full bg-slate-500/20 px-1.5 text-[10px] font-medium text-slate-300">{t("tickets.timer.nonBillable")}</span>
                )}
                {n.kind === "time" && n.billable !== false && (n.offsetHours ?? 0) > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-300">
                    {t("tickets.timer.billedAfterOffset", {
                      billed: Math.max(0, (n.hours ?? 0) - (n.offsetHours ?? 0)).toLocaleString(),
                      offset: (n.offsetHours ?? 0).toLocaleString(),
                    })}
                  </span>
                )}
                {n.internal && (
                  <span className="flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium text-violet-300">
                    <Lock className="size-2.5" /> {t("tickets.internal")}
                  </span>
                )}
              </div>
              {n.text && (
                <p
                  className={cn(
                    "mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                    n.internal ? "bg-violet-500/5" : n.kind === "time" ? "bg-sky-500/5" : "bg-muted/50",
                  )}
                >
                  {n.text}
                </p>
              )}
              {n.internalText && (
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-violet-500/5 px-3 py-2 text-sm">
                  <span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">
                    <Lock className="size-2.5" /> {t("tickets.internal")}
                  </span>
                  {n.internalText}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
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
  const cls = "mt-3 font-display text-2xl font-bold leading-snug sm:text-3xl";
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

/** Description with an edit button (saved to Autotask). */
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
    <>
      <p ref={ref} className={cn("whitespace-pre-wrap text-sm leading-relaxed", !open && "line-clamp-5")}>
        {text}
      </p>
      {(long || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} /> {open ? t("tickets.showLess") : t("tickets.showMore")}
        </button>
      )}
    </>
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
      disabled={disabled || !tk.startDate}
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
  tk,
  value,
  onChange,
}: {
  tk: TicketDetail;
  value: { startDate: string | null; startTime: string | null; startLocked: boolean };
  onChange: (p: { startDate?: string | null; startTime?: string | null; startLocked?: boolean }) => void;
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
          <StartTimeInput
            tk={{ ...tk, startDate: value.startDate, startTime: value.startTime }}
            disabled={off}
            onSave={(startTime) => onChange({ startTime })}
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
        </dd>
      </div>
    </div>
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
  const send = useMutation({
    mutationFn: () => api.post(`/tickets/${tk.id}/notes`, { text, internal }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
      toast.success(internal ? t("tickets.noteAdded") : t("tickets.replySent"));
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
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{t("tickets.noteSendHint")}</span>
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
  const done = () => void qc.invalidateQueries({ queryKey: ["ai", "options"] });
  const analyze = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`, analyzeModel.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets", "ai", tk.id] });
      done();
    },
    onError: (e) => toast.error(aiError(e)),
  });
  const reply = useMutation({
    mutationFn: () => api.post<{ text: string }>(`/tickets/${tk.id}/ai/reply`, replyModel.body),
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
  const again = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`, analyzeModel.body),
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
