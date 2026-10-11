import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  Building2,
  CalendarClock,
  CalendarPlus,
  Clock3,
  Eye,
  Inbox,
  Lock,
  Mail,
  MonitorCog,
  Phone,
  Send,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { dueState, longDateTime, PRIORITY_STYLE, STATUS_STYLE, usePresence, type TicketDetail, type Viewer } from "./shared";

const SOURCE_ICON: Record<TicketDetail["source"], LucideIcon> = { email: Mail, phone: Phone, portal: Inbox, monitoring: MonitorCog };

/**
 * A ticket in a large side panel over the list. While it is open the portal
 * shows who else has it open: a popup when you arrive, then a light in the
 * corner (green = only you, orange = someone else too).
 */
export function TicketPanel({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["tickets", "detail", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    enabled: Boolean(id),
  });
  const viewers = usePresence(id);

  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        {isLoading || !data ? (
          <div className="space-y-4 p-6">
            <SheetTitle className="sr-only">{t("tickets.title")}</SheetTitle>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <TicketBody tk={data} viewers={viewers} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function TicketBody({ tk, viewers, onClose }: { tk: TicketDetail; viewers: Viewer[] | null; onClose: () => void }) {
  const { t } = useTranslation();
  const due = dueState(tk.dueAt, tk.status);
  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background/85 px-6 pb-4 pt-5 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{tk.number}</span>
          <span className="ml-auto">
            <PresenceLight viewers={viewers} />
          </span>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label={t("common.close")}>
            <X className="size-4" />
          </Button>
        </div>
        <SheetTitle className="mt-1.5 text-xl font-bold leading-snug">{tk.title}</SheetTitle>
        <SheetDescription className="sr-only">{tk.company.name}</SheetDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_STYLE[tk.status])}>{t(`tickets.status.${tk.status}`)}</span>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", PRIORITY_STYLE[tk.priority].text)}>
            <span className={cn("size-2 rounded-full", PRIORITY_STYLE[tk.priority].dot)} /> {t(`tickets.priority.${tk.priority}`)}
          </span>
          <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">{tk.queue}</span>
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

      <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_240px]">
        {/* Conversation */}
        <div className="space-y-5">
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
                    <p className={cn("mt-1 rounded-lg px-3 py-2 text-sm", n.internal ? "bg-violet-500/5" : "bg-muted/50")}>{n.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <NoteComposer />
        </div>

        {/* Details */}
        <aside className="space-y-4">
          <dl className="space-y-3 rounded-xl border bg-card/60 p-4 text-sm">
            <Detail icon={Building2} label={t("tickets.fields.company")}>
              {tk.company.name}
            </Detail>
            <Detail icon={UserRound} label={t("tickets.fields.contact")}>
              {tk.contact || "—"}
            </Detail>
            <Detail icon={Users} label={t("tickets.fields.assignee")}>
              {tk.assignee?.name ?? <span className="italic text-muted-foreground">{t("tickets.unassigned")}</span>}
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
      <OpenedByOthers viewers={viewers} />
    </>
  );
}

function Detail({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
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

/** Reply / internal note — wired to Autotask later. */
function NoteComposer() {
  const { t } = useTranslation();
  const [internal, setInternal] = useState(false);
  return (
    <div className="rounded-xl border bg-card/60 p-3">
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
      <Textarea rows={3} placeholder={t("tickets.notePlaceholder")} className="resize-none" />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{t("tickets.noteSoon")}</span>
        <Button size="sm" disabled>
          <Send className="size-3.5" /> {t("tickets.send")}
        </Button>
      </div>
    </div>
  );
}

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
      // first answer from the server: the popup if anyone is already here
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
          <DialogDescription className="pt-1">
            {t("tickets.alreadyOpenText", { names: popup?.map((v) => v.name).join(", ") ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <AnimatePresence>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-end pt-2">
            <Button className="bg-grad-gold font-semibold text-[#1a1204]" onClick={() => setPopup(null)}>
              {t("tickets.alreadyOpenOk")}
            </Button>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
