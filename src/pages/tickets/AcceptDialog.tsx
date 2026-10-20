import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Loader2, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { longDateTime, ticketErrorText, useChoiceText, type Choice, type PriorityKind, type StatusKind } from "./shared";

/** The status "in charge": the one named so (prise en charge / in charge / taken), else the first "in progress" one. */
export function chargeStatus<S extends Choice<StatusKind>>(statuses: S[]): S | undefined {
  const open = statuses.filter((s) => !s.hidden);
  return open.find((s) => /prise? en charge|en charge|in charge|taken|assum/i.test(s.label ?? "")) ?? open.find((s) => s.kind === "inProgress") ?? open.find((s) => s.kind !== "new" && s.kind !== "complete");
}

const at17 = (d: Date) => {
  const x = new Date(d);
  x.setHours(17, 0, 0, 0);
  return x;
};
/** The delays offered, from now (local time, the working day ends at 17:00). */
function delays(now = new Date()): { key: string; at: Date }[] {
  const plusHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const plusDays = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return at17(d);
  };
  // the coming Friday at 17:00 (today when it is Friday and not past 17:00)
  const friday = new Date(now);
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7));
  let fri = at17(friday);
  if (fri.getTime() <= now.getTime()) fri = at17(new Date(friday.getTime() + 7 * 86_400_000));
  const today = at17(now);
  return [
    { key: "h2", at: plusHours(2) },
    { key: "h4", at: plusHours(4) },
    { key: "today", at: today.getTime() > now.getTime() ? today : plusDays(1) },
    { key: "d1", at: plusDays(1) },
    { key: "d2", at: plusDays(2) },
    { key: "d3", at: plusDays(3) },
    { key: "friday", at: fri },
  ];
}
/** What to propose by default: the more urgent, the sooner. */
const DEFAULT_DELAY: Record<PriorityKind, string> = { critical: "h4", high: "today", medium: "d1", low: "d3" };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * "Accepter le billet": the technician takes it. It goes to the "in charge" status, is
 * assigned to them, and gets the delay they give to finish it (its due date).
 */
export function AcceptDialog({
  open,
  onOpenChange,
  tk,
  statuses,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tk: { id: number; number: string; title: string; priorityKind: PriorityKind; dueAt: string };
  statuses: Choice<StatusKind>[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const txt = useChoiceText();
  const choices = delays();
  const [pick, setPick] = useState(DEFAULT_DELAY[tk.priorityKind] ?? "d1");
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState(chargeStatus(statuses)?.value ?? "");
  useEffect(() => {
    if (open) {
      setPick(DEFAULT_DELAY[tk.priorityKind] ?? "d1");
      setCustom("");
      setStatus(chargeStatus(statuses)?.value ?? "");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = pick === "custom" ? (custom ? new Date(custom) : null) : (choices.find((c) => c.key === pick)?.at ?? null);
  const valid = due && !Number.isNaN(due.getTime()) && due.getTime() > Date.now() && status;
  const accept = useMutation({
    mutationFn: () => api.patch(`/tickets/${tk.id}`, { assigneeId: me.id, status, dueAt: due!.toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
      toast.success(t("tickets.accept.done", { number: tk.number }));
      onOpenChange(false);
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="size-5 text-primary" /> {t("tickets.accept.title")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("tickets.accept.text", { name: me.name })}</p>
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CalendarClock className="size-3.5" /> {t("tickets.accept.delay")}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("tickets.accept.delay")}>
            {[...choices.map((c) => c.key), "custom"].map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={pick === k}
                onClick={() => setPick(k)}
                className={cn("rounded-lg border px-2 py-2 text-sm transition-colors", pick === k ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 font-medium" : "text-muted-foreground hover:bg-accent/50")}
              >
                {t(`tickets.accept.delays.${k}`)}
              </button>
            ))}
          </div>
          {pick === "custom" && <Input type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} />}
          <p className="text-xs text-muted-foreground">{due && !Number.isNaN(due.getTime()) ? t("tickets.accept.due", { date: longDateTime(due.toISOString()) }) : t("tickets.accept.pickDue")}</p>
        </div>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("tickets.fields.status")}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
            {statuses
              .filter((s) => !s.hidden || s.value === status)
              .map((s) => (
                <option key={s.value} value={s.value}>
                  {txt.status(s)}
                </option>
              ))}
          </select>
        </label>
        <Button className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || accept.isPending} onClick={() => accept.mutate()}>
          {accept.isPending ? <Loader2 className="size-4 animate-spin" /> : <UserCheck className="size-4" />} {t("tickets.accept.button")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
