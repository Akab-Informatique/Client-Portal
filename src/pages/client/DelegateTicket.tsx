import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitMerge, LifeBuoy, Loader2, Pause, Play, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { Pane } from "./ui";
import { ActivityPanel } from "./DelegateActivity";
import { ChecklistCard } from "./DelegateChecklist";
import { Composer } from "./DelegateComposer";
import { HelpDialog, MergeDialog } from "./DelegateDialogs";
import {
  ChipSelect,
  ClientCard,
  Description,
  DetailsTile,
  DueChip,
  OtherTickets,
  TagsCard,
  TeamTile,
  TitleField,
  chipOptions,
} from "./DelegateTicketParts";
import { DELEGATE_API, dayOf, priorityTone, statusTone, useDelegateError, type DelegateOptions, type DelegateTicket } from "./delegateShared";
import { useNoteTimer, type NoteTimer } from "./useNoteTimer";

/** The ticket window of the delegate: a big dialog opened from the list or from `?ticket=<id>`. */
export function DelegateTicketDialog({
  id,
  options,
  onClose,
  onOpen,
}: {
  id: number | null;
  options: DelegateOptions | undefined;
  onClose: () => void;
  onOpen: (id: number) => void;
}) {
  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none flex-col gap-0 overflow-hidden rounded-3xl border-[color:var(--glass-border)] bg-background/90 p-0 dark:bg-background/70 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-2xl sm:max-w-none lg:h-[calc(100dvh-3rem)] lg:w-[calc(100vw-3rem)]"
      >
        <div className="client-ambient pointer-events-none absolute inset-0 -z-10 opacity-80" />
        {/* keyed by ticket: each ticket starts its own state, timer included */}
        {id != null && <TicketContent key={id} id={id} options={options} onClose={onClose} onOpen={onOpen} />}
      </DialogContent>
    </Dialog>
  );
}

function TicketContent({ id, options, onClose, onOpen }: { id: number; options: DelegateOptions | undefined; onClose: () => void; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["portal", "delegate", "ticket", id],
    queryFn: () => api.get<DelegateTicket>(`${DELEGATE_API}/tickets/${id}`),
    refetchInterval: 30_000,
  });
  return (
    <>
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <DialogTitle className="sr-only">{t("common.loading")}</DialogTitle>
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {isError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <DialogTitle className="sr-only">{t("selfManaged.delegate.ticket.loadError")}</DialogTitle>
          <p className="text-sm text-destructive">{t("selfManaged.delegate.ticket.loadError")}</p>
          <Button variant="outline" onClick={onClose}>
            {t("selfManaged.delegate.ticket.close")}
          </Button>
        </div>
      )}
      {data && <Loaded ticket={data} options={options} onClose={onClose} onOpen={onOpen} />}
    </>
  );
}

/** Seconds as h:mm:ss */
function clockOf(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Loaded({ ticket: x, options, onClose, onOpen }: { ticket: DelegateTicket; options: DelegateOptions | undefined; onClose: () => void; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const errorText = useDelegateError();
  const timer = useNoteTimer(`akab.delegate.timer.${me.id}.${x.id}`);
  // bumped when a change is refused, so the chips and fields show the saved value again
  const [rev, setRev] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  /** Everything that changes the ticket or its activity: this ticket and the lists */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["portal", "delegate", "ticket", x.id] });
    void qc.invalidateQueries({ queryKey: ["portal", "delegate", "tickets"] });
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<{ ok: boolean }>(`${DELEGATE_API}/tickets/${x.id}`, body),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(errorText(e));
      setRev((r) => r + 1);
      refresh();
    },
  });

  const contacts = options?.contacts ?? [];

  return (
    <>
      <DialogTitle className="sr-only">{`${x.number} ${x.title}`}</DialogTitle>
      <DialogDescription className="sr-only">{x.status.label}</DialogDescription>

      {/* Header: number, title, client and contact, AKAB's mark, the stopwatch, merge, close */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[color:var(--glass-border)] px-5 py-3">
        <span className="shrink-0 rounded-md border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-2 py-0.5 font-mono text-xs text-primary">{x.number}</span>
        <div className="min-w-0 flex-1 basis-64">
          <TitleField key={`title-${rev}`} ticket={x} onSave={(title) => save.mutate({ title })} />
          <p className="truncate text-xs text-muted-foreground">{[x.client, x.contact].filter(Boolean).join(" · ")}</p>
        </div>
        {x.akabWorking && (
          <span className="inline-flex shrink-0 items-center rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/12 px-2.5 py-0.5 text-xs font-semibold text-primary">
            {t("selfManaged.delegate.ticket.akabWorking")}
          </span>
        )}
        <TimerChip timer={timer} />
        <Button type="button" variant="outline" size="sm" className="h-9 gap-2" onClick={() => setMergeOpen(true)}>
          <GitMerge className="size-4" aria-hidden />
          {t("selfManaged.delegate.ticket.merge.button")}
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" onClick={onClose} aria-label={t("selfManaged.delegate.ticket.close")} title={t("selfManaged.delegate.ticket.close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      {/* Chips: status, priority, due day (each saved at once) */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--glass-border)] px-5 py-2.5">
        <ChipSelect
          key={`status-${rev}`}
          id="delegate-status"
          label={t("selfManaged.delegate.ticket.fieldStatus")}
          value={x.status.key}
          options={chipOptions(options?.statuses, x.status)}
          tone={statusTone(x.status.kind)}
          onPick={(v) => save.mutate({ status: v })}
        />
        <ChipSelect
          key={`priority-${rev}`}
          id="delegate-priority"
          label={t("selfManaged.delegate.ticket.fieldPriority")}
          value={x.priority.key}
          options={chipOptions(options?.priorities, x.priority)}
          tone={priorityTone(x.priority.kind)}
          onPick={(v) => save.mutate({ priority: v })}
        />
        <DueChip key={`due-${rev}`} label={t("selfManaged.delegate.ticket.fieldDue")} value={dayOf(x.dueAt)} onPick={(day) => save.mutate({ dueDate: day })} />
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: tiles, description, steps, activity and attachments, the note box at the bottom */}
        <section className="min-h-0 space-y-5 overflow-y-auto p-5 scrollbar-thin">
          <div className="grid gap-3 sm:grid-cols-2">
            <TeamTile ticket={x} onPick={(delegateId) => save.mutate({ delegateId })} />
            <DetailsTile ticket={x} />
          </div>

          {x.akabWorking && (
            <Pane className="border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.07] p-4 text-sm">{t("selfManaged.delegate.ticket.akabWorkingBanner")}</Pane>
          )}

          <Description key={`desc-${rev}`} ticket={x} onSave={(description) => save.mutate({ description })} />

          <ChecklistCard ticketId={x.id} items={x.checklist} onChanged={refresh} />

          <ActivityPanel ticket={x} onChanged={refresh} />

          <Composer ticketId={x.id} timer={timer} onChanged={refresh} />
        </section>

        {/* Side: client and contact, the contact's other tickets, tags, help */}
        <aside className="min-h-0 space-y-4 overflow-y-auto border-t border-[color:var(--glass-border)] p-5 lg:border-l lg:border-t-0 scrollbar-thin">
          <ClientCard ticket={x} contacts={contacts} onPickContact={(contactId) => save.mutate({ contactId })} />
          <OtherTickets ticket={x} onOpen={onOpen} />
          <TagsCard ticket={x} onChanged={refresh} errorText={errorText} />
          {!x.akabWorking && (
            <Button type="button" className="w-full gap-2" variant="outline" onClick={() => setHelpOpen(true)}>
              <LifeBuoy className="size-4 text-primary" aria-hidden />
              {t("selfManaged.delegate.ticket.help.button")}
            </Button>
          )}
        </aside>
      </div>

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} ticketId={x.id} onDone={refresh} />
      <MergeDialog ticketId={x.id} open={mergeOpen} onOpenChange={setMergeOpen} onMerged={onOpen} />
    </>
  );
}

/** The stopwatch of this window, in the header (pause / resume). Only noted on a sent note; never billed. */
function TimerChip({ timer }: { timer: NoteTimer }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-[color:var(--glass-border)] bg-background/30 pl-2.5 pr-1" title={t("selfManaged.delegate.ticket.timer.hint")}>
      <Timer className="size-3.5 text-primary" aria-hidden />
      <span className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.timer.label")}</span>
      <span className="font-mono text-sm tabular-nums">{clockOf(timer.seconds)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => (timer.paused ? timer.resume() : timer.pause())}
        aria-label={timer.paused ? t("selfManaged.delegate.ticket.timer.resume") : t("selfManaged.delegate.ticket.timer.pause")}
        title={timer.paused ? t("selfManaged.delegate.ticket.timer.resume") : t("selfManaged.delegate.ticket.timer.pause")}
      >
        {timer.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
      </Button>
    </div>
  );
}
