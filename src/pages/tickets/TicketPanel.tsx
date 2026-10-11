import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  AlertTriangle,
  Bot,
  Building2,
  CalendarClock,
  CalendarPlus,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  HelpCircle,
  Inbox,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  MessageSquareReply,
  Minus,
  MonitorCog,
  NotebookPen,
  Phone,
  RefreshCw,
  Send,
  Sparkles,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { dueState, longDateTime, PRIORITY_STYLE, STATUS_STYLE, usePresence, type AiAnalysis, type Priority, type Status, type TicketDetail, type Viewer } from "./shared";

const SOURCE_ICON: Record<TicketDetail["source"], LucideIcon> = { email: Mail, phone: Phone, portal: Inbox, monitoring: MonitorCog };

/** Friendly text for AI errors (not configured, provider down…). */
export function useAiError() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    if (e instanceof ApiError && e.status === 429) return t("tickets.ai.errors.rate_limit");
    return t(`tickets.ai.errors.${code.replace(/^ai_/, "")}`, { defaultValue: t("tickets.ai.errors.api") });
  };
}

/**
 * A ticket over the whole screen. Everything in the header and the details
 * can be changed in place. "Minimize" keeps it in the dock (presence goes on),
 * "Close" leaves it. Presence: popup on arrival + light in the top-right corner.
 */
export function TicketOverlay({ id, onClose, onMinimize }: { id: number | null; onClose: () => void; onMinimize: (tk: TicketDetail) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["tickets", "detail", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    enabled: Boolean(id),
  });
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
                className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-grid opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
                {isLoading || !data ? (
                  <div className="relative mx-auto w-full max-w-7xl space-y-4 p-8">
                    <DialogPrimitive.Title className="sr-only">{t("tickets.title")}</DialogPrimitive.Title>
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-10 w-2/3" />
                    <Skeleton className="h-96" />
                  </div>
                ) : (
                  <TicketBody tk={data} viewers={viewers} onClose={onClose} onMinimize={() => onMinimize(data)} />
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
    mutationFn: (patch: { status?: Status; priority?: Priority; queue?: string; assigneeId?: string | null; dueDate?: string }) =>
      api.patch<TicketDetail>(`/tickets/${tk.id}`, patch),
    onSuccess: (next) => {
      qc.setQueryData(["tickets", "detail", tk.id], next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
}

function TicketBody({ tk, viewers, onClose, onMinimize }: { tk: TicketDetail; viewers: Viewer[] | null; onClose: () => void; onMinimize: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const editable = can("tickets.edit");
  const update = useTicketUpdate(tk);
  const due = dueState(tk.dueAt, tk.status);
  const [draft, setDraft] = useState<{ text: string; internal: boolean } | null>(null);

  return (
    <>
      {/* Header */}
      <div className="relative z-10 border-b bg-background/70 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-7xl px-6 pb-4 pt-4 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="rounded-md border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-2 py-0.5 font-mono text-xs text-primary">{tk.number}</span>
            <span className="truncate text-xs text-muted-foreground">{tk.company.name}</span>
            <span className="ml-auto">
              <PresenceLight viewers={viewers} />
            </span>
            {tk.ai && <AiMenu tk={tk} onReply={(text) => setDraft({ text, internal: false })} />}
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
          <DialogPrimitive.Title className="mt-3 font-display text-2xl font-bold leading-snug sm:text-3xl">{tk.title}</DialogPrimitive.Title>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <InlinePick
              disabled={!editable}
              label={t("tickets.fields.status")}
              value={tk.status}
              options={tk.options.statuses.map((s) => ({ value: s, label: t(`tickets.status.${s}`) }))}
              onPick={(v) => update.mutate({ status: v as Status })}
              trigger={<span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_STYLE[tk.status])}>{t(`tickets.status.${tk.status}`)}</span>}
            />
            <InlinePick
              disabled={!editable}
              label={t("tickets.fields.priority")}
              value={tk.priority}
              options={tk.options.priorities.map((p) => ({ value: p, label: t(`tickets.priority.${p}`), dot: PRIORITY_STYLE[p].dot }))}
              onPick={(v) => update.mutate({ priority: v as Priority })}
              trigger={
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", PRIORITY_STYLE[tk.priority].text)}>
                  <span className={cn("size-2 rounded-full", PRIORITY_STYLE[tk.priority].dot)} /> {t(`tickets.priority.${tk.priority}`)}
                </span>
              }
            />
            <InlinePick
              disabled={!editable}
              label={t("tickets.fields.queue")}
              value={tk.queue}
              options={tk.options.queues.map((q) => ({ value: q, label: q }))}
              onPick={(v) => update.mutate({ queue: v })}
              trigger={<span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">{tk.queue}</span>}
            />
            {update.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <span
              className={cn(
                "ml-auto flex items-center gap-1 text-xs font-medium",
                due === "overdue" ? "text-destructive" : due === "today" ? "text-orange-400" : "text-muted-foreground",
              )}
            >
              <CalendarClock className="size-3.5" />
              {due === "overdue" ? t("tickets.overdue") : due === "today" ? t("tickets.today") : longDateTime(tk.dueAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:px-8">
          {/* Conversation */}
          <div className="min-w-0 space-y-5">
            <AiPanel tk={tk} onToNote={(text) => setDraft({ text, internal: true })} />
            <section className="rounded-xl border bg-card/60 p-4">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("tickets.description")}</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{tk.description || "—"}</p>
            </section>
            <section>
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("tickets.activity")}</p>
              {tk.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tickets.noActivity")}</p>
              ) : (
                <ol className="relative space-y-4 border-l pl-5">
                  {tk.notes.map((n) => (
                    <li key={n.id} className="relative">
                      <span className={cn("absolute -left-[27px] top-1 flex size-3.5 items-center justify-center rounded-full border-2 border-background", n.internal ? "bg-violet-400" : "bg-grad-gold")} />
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-medium">{n.author}</span>
                        <span className="text-xs text-muted-foreground">{longDateTime(n.at)}</span>
                        {n.internal && (
                          <span className="flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium text-violet-300">
                            <Lock className="size-2.5" /> {t("tickets.internal")}
                          </span>
                        )}
                      </div>
                      <p className={cn("mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm", n.internal ? "bg-violet-500/5" : "bg-muted/50")}>{n.text}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            {editable && <NoteComposer tk={tk} draft={draft} onDraftUsed={() => setDraft(null)} />}
          </div>

          {/* Details (editable) */}
          <aside className="space-y-4">
            <dl className="space-y-3 rounded-xl border bg-card/60 p-4 text-sm">
              <Detail icon={Building2} label={t("tickets.fields.company")}>
                {tk.company.name}
              </Detail>
              <Detail icon={UserRound} label={t("tickets.fields.contact")}>
                {tk.contact || "—"}
              </Detail>
              <Detail icon={Users} label={t("tickets.fields.assignee")}>
                <InlinePick
                  disabled={!editable}
                  label={t("tickets.fields.assignee")}
                  value={tk.assignee?.id ?? "none"}
                  options={[{ value: "none", label: t("tickets.unassigned") }, ...tk.options.technicians.map((p) => ({ value: p.id, label: p.name }))]}
                  onPick={(v) => update.mutate({ assigneeId: v === "none" ? null : v })}
                  trigger={<span className={cn(!tk.assignee && "italic text-muted-foreground")}>{tk.assignee?.name ?? t("tickets.unassigned")}</span>}
                />
              </Detail>
              <Detail icon={CalendarClock} label={t("tickets.fields.due")}>
                {editable ? (
                  <Input
                    type="date"
                    className="mt-0.5 h-8"
                    key={tk.dueAt}
                    defaultValue={tk.dueAt.slice(0, 10)}
                    onChange={(e) => e.target.value && update.mutate({ dueDate: e.target.value })}
                    aria-label={t("tickets.fields.due")}
                  />
                ) : (
                  longDateTime(tk.dueAt)
                )}
              </Detail>
              <Detail icon={SOURCE_ICON[tk.source]} label={t("tickets.fields.source")}>
                {t(`tickets.source.${tk.source}`)}
              </Detail>
              <Detail icon={Clock3} label={t("tickets.fields.created")}>
                {longDateTime(tk.createdAt)}
              </Detail>
              <Detail icon={Clock3} label={t("tickets.fields.hours")}>
                {t("tickets.hoursValue", { hours: tk.hours.toLocaleString() })}
              </Detail>
            </dl>
            <StartDate tk={tk} />
          </aside>
        </div>
      </div>
      <OpenedByOthers viewers={viewers} />
    </>
  );
}

/** A value you click to change (status, priority, queue, assignee). */
function InlinePick({
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
          <ChevronDown className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-data-[state=open]:opacity-100" />
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

/** Portal-only planned start date, saved right away. */
function StartDate({ tk }: { tk: TicketDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (startDate: string | null) => api.put(`/tickets/${tk.id}/start-date`, { startDate }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <div className="rounded-xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.04] p-4">
      <label htmlFor="start-date" className="flex items-center gap-2 text-sm font-medium">
        <CalendarPlus className="size-4 text-primary" /> {t("tickets.fields.start")}
        <span className="rounded border border-[color:var(--gold)]/40 px-1 text-[9px] font-semibold text-primary">{t("tickets.portalTag")}</span>
      </label>
      <Input
        id="start-date"
        type="date"
        className="mt-2 h-9"
        disabled={!can("tickets.edit") || save.isPending}
        defaultValue={tk.startDate ?? ""}
        key={tk.startDate ?? ""}
        onChange={(e) => save.mutate(e.target.value || null)}
      />
      <p className="mt-2 text-[11px] text-muted-foreground">{t("tickets.portalHint")}</p>
    </div>
  );
}

/** Reply to the client or internal note. An AI draft can be dropped in. */
function NoteComposer({ tk, draft, onDraftUsed }: { tk: TicketDetail; draft: { text: string; internal: boolean } | null; onDraftUsed: () => void }) {
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
  const send = useMutation({
    mutationFn: () => api.post(`/tickets/${tk.id}/notes`, { text, internal }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
      toast.success(internal ? t("tickets.noteAdded") : t("tickets.replySent"));
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <div className={cn("rounded-xl border bg-card/60 p-3 transition-colors", internal && "border-violet-500/30")}>
      <div className="mb-2 inline-flex rounded-lg border p-0.5 text-xs">
        {[false, true].map((v) => (
          <button
            key={String(v)}
            type="button"
            onClick={() => setInternal(v)}
            className={cn("rounded-md px-2.5 py-1 font-medium", internal === v ? (v ? "bg-violet-500/20 text-violet-200" : "bg-grad-gold text-[#1a1204]") : "text-muted-foreground")}
          >
            {v ? t("tickets.noteInternal") : t("tickets.noteReply")}
          </button>
        ))}
      </div>
      <Textarea ref={ref} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("tickets.notePlaceholder")} className="resize-y" />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{t("tickets.noteSoon")}</span>
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
  const analyze = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets", "ai", tk.id] }),
    onError: (e) => toast.error(aiError(e)),
  });
  const reply = useMutation({
    mutationFn: () => api.post<{ text: string }>(`/tickets/${tk.id}/ai/reply`),
    onSuccess: (r) => onReply(r.text),
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
  const again = useMutation({
    mutationFn: () => api.post<AiAnalysis>(`/tickets/${tk.id}/ai/analyze`),
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
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-violet-500/20 font-mono text-[10px] text-violet-200">{i + 1}</span>
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
              <ul className="list-disc space-y-1 pl-5 text-sm">{c.risks.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {c.questions.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <HelpCircle className="size-3.5" /> {t("tickets.ai.questions")}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">{c.questions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {c.suggestedPriority && c.suggestedPriority !== tk.priority && (
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
                  <span key={v.userId} className="flex size-5 items-center justify-center rounded-full border border-background bg-orange-500/30 text-[9px] font-bold text-orange-100">
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
