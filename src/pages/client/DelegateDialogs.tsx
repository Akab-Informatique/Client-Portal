import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DELEGATE_API, useDelegateError } from "./delegateShared";

type MergeTarget = { id: number; number: string; title: string };

/** Merge this ticket into another open one of the company; then the target opens */
export function MergeDialog({
  ticketId,
  open,
  onOpenChange,
  onMerged,
}: {
  ticketId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onMerged: (targetId: number) => void;
}) {
  const { t } = useTranslation();
  const errorText = useDelegateError();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<MergeTarget | null>(null);
  const term = q.trim();

  const targets = useQuery({
    queryKey: ["portal", "delegate", "merge-targets", ticketId, term],
    queryFn: () => api.get<MergeTarget[]>(`${DELEGATE_API}/tickets/${ticketId}/merge-targets?q=${encodeURIComponent(term)}`),
    enabled: open,
  });

  const merge = useMutation({
    mutationFn: (intoId: number) => api.post<{ ok: boolean }>(`${DELEGATE_API}/tickets/${ticketId}/merge`, { intoId }),
    onSuccess: (_r, intoId) => {
      toast.success(t("selfManaged.delegate.ticket.merge.done"));
      setPicked(null);
      onOpenChange(false);
      onMerged(intoId);
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const list = targets.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPicked(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("selfManaged.delegate.ticket.merge.title")}</DialogTitle>
        <DialogDescription>{t("selfManaged.delegate.ticket.merge.body")}</DialogDescription>
        <div className="mt-2 space-y-3">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("selfManaged.delegate.ticket.merge.search")}
            aria-label={t("selfManaged.delegate.ticket.merge.search")}
            autoFocus
          />
          {targets.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          {!targets.isFetching && list.length === 0 && <p className="text-sm text-muted-foreground">{t("selfManaged.delegate.ticket.merge.none")}</p>}
          {list.length > 0 && (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-thin" role="listbox" aria-label={t("selfManaged.delegate.ticket.merge.title")}>
              {list.map((tg) => {
                const on = picked?.id === tg.id;
                return (
                  <li key={tg.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => setPicked(tg)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                        on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "border-[color:var(--glass-border)] hover:bg-foreground/[0.04]",
                      )}
                    >
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{tg.number}</span>
                      <span className="min-w-0 truncate text-sm">{tg.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("selfManaged.delegate.ticket.cancel")}
          </Button>
          <Button type="button" disabled={!picked || merge.isPending} onClick={() => picked && merge.mutate(picked.id)}>
            {merge.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t("selfManaged.delegate.ticket.merge.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Ask AKAB for help: explains that AKAB takes the ticket, with an optional message */
export function HelpDialog({
  open,
  onOpenChange,
  ticketId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ticketId: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t("selfManaged.delegate.ticket.help.title")}</DialogTitle>
        <DialogDescription>{t("selfManaged.delegate.ticket.help.body")}</DialogDescription>
        {open && (
          <HelpForm
            ticketId={ticketId}
            onDone={() => {
              onOpenChange(false);
              onDone();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function HelpForm({ ticketId, onDone }: { ticketId: number; onDone: () => void }) {
  const { t } = useTranslation();
  const errorText = useDelegateError();
  const [message, setMessage] = useState("");
  const ask = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`${DELEGATE_API}/tickets/${ticketId}/help`, message.trim() ? { message: message.trim() } : {}),
    onSuccess: () => {
      toast.success(t("selfManaged.delegate.ticket.help.done"));
      onDone();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ask.isPending) ask.mutate();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="delegate-help-message" className="text-sm font-medium">
          {t("selfManaged.delegate.ticket.help.message")}
        </label>
        <Textarea id="delegate-help-message" value={message} rows={4} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={ask.isPending} className="gap-2">
          {ask.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {t("selfManaged.delegate.ticket.help.confirm")}
        </Button>
      </div>
    </form>
  );
}
