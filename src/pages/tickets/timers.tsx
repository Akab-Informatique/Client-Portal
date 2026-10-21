import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketDetail } from "./shared";
import { isAddress, RecipientInput } from "@/pages/outlook/RecipientInput";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Clock3, CornerDownLeft, Loader2, Lock, Mail, Pause, Play, Receipt, Timer as TimerIcon, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { longDateTime, ticketErrorText, hm, parseHm, useChoiceText } from "./shared";
import { contractNote } from "./contract";

/**
 * Work timers on tickets. Opening a ticket starts (or resumes) its timer;
 * closing it asks for the time entry ("Later" pauses it until the ticket is
 * opened again). The server keeps them (one running at a time per
 * technician); this page beats every 30 s while one runs. If every page is
 * closed, the server stops the timer at its last beat and it waits here,
 * "to validate", with a bell notification. Validating = a time entry in
 * the portal under the technician.
 */
export type Timer = {
  id: string;
  ticketId: number;
  ticketNumber: string;
  ticketTitle: string;
  state: "running" | "paused" | "pending";
  elapsedMs: number;
  startedAt: string;
  endedAt: string | null;
};
type Timers = { at: number; list: Timer[] };

const KEY = ["ticket-timers"];
const BEAT_MS = 30_000;

export function useTimers() {
  const can = useCan();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Timers> => ({ at: Date.now(), list: await api.get<Timer[]>("/tickets/timers") }),
    enabled: can("tickets.edit"),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  return data ?? { at: Date.now(), list: [] };
}

/** Elapsed time now (running timers keep counting from the last answer). */
export function liveMs(t: Timer, at: number, now: number) {
  return t.elapsedMs + (t.state === "running" ? Math.max(0, now - at) : 0);
}

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Start / pause / stop one ticket's timer; the answer is the fresh list. */
export function useTimerAction() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, action }: { ticketId: number; action: "start" | "pause" | "stop" }) => api.post<Timer[]>(`/tickets/${ticketId}/timer/${action}`),
    onSuccess: (list) => qc.setQueryData<Timers>(KEY, { at: Date.now(), list }),
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
}

type Ui = { review: (timerId: string) => void };
const UiCtx = createContext<Ui | null>(null);

/** Heartbeat + the validation dialog for timers that were stopped. */
export function TimersProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { list } = useTimers();
  const running = list.some((x) => x.state === "running");
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!running) return;
    const beat = () =>
      api
        .post<Timer[]>("/tickets/timers/beat")
        .then((l) => qc.setQueryData<Timers>(KEY, { at: Date.now(), list: l }))
        .catch(() => undefined);
    const id = setInterval(beat, BEAT_MS);
    const onShow = () => document.visibilityState === "visible" && void beat();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [running, qc]);

  // From the bell: /tickets?timers=1 shows every timer to validate again
  useEffect(() => {
    if (params.get("timers") !== "1") return;
    void qc.invalidateQueries({ queryKey: KEY });
    const next = new URLSearchParams(params);
    next.delete("timers");
    setParams(next, { replace: true });
  }, [params, setParams, qc]);

  const pending = list.filter((x) => x.state === "pending");
  const current = pending[0] ?? null;
  // Pending timers always show their dialog: nothing to bring back
  const value = useMemo(() => ({ review: () => undefined }), []);
  // "Later": back to paused (shown at once, confirmed by the server)
  const later = (timer: Timer) => {
    qc.setQueryData<Timers>(KEY, (d) => d && { ...d, list: d.list.map((x) => (x.id === timer.id ? { ...x, state: "paused" as const, endedAt: null } : x)) });
    void api
      .post<Timer[]>(`/tickets/timers/${timer.id}/later`)
      .then((l) => qc.setQueryData<Timers>(KEY, { at: Date.now(), list: l }))
      .catch(() => qc.invalidateQueries({ queryKey: KEY }));
  };

  return (
    <UiCtx.Provider value={value}>
      {children}
      {current && <TimeEntryDialog key={current.id} timer={current} position={{ n: 1, total: pending.length }} onLater={() => later(current)} />}
    </UiCtx.Provider>
  );
}

function useTimerUi() {
  return useContext(UiCtx) ?? { review: () => undefined };
}

/**
 * The ticket's timer follows the window: opening starts or resumes it,
 * closing stops it and always asks for the time entry ("Supprimer" if it was
 * only a look). Minimizing keeps it going.
 */
export function useTicketTimerAuto() {
  const qc = useQueryClient();
  const can = useCan();
  const on = can("tickets.edit");
  const starting = useRef(new Map<number, Promise<unknown>>());
  const put = useCallback((list: Timer[]) => qc.setQueryData<Timers>(KEY, { at: Date.now(), list }), [qc]);

  const opened = useCallback(
    (id: number) => {
      if (!on) return;
      const cur = qc.getQueryData<Timers>(KEY)?.list.find((x) => x.ticketId === id);
      if (cur && cur.state !== "paused") return;
      const p = api
        .post<Timer[]>(`/tickets/${id}/timer/start`)
        .then(put)
        .catch(() => undefined);
      starting.current.set(id, p);
    },
    [on, qc, put],
  );

  const closed = useCallback(
    async (id: number) => {
      if (!on) return;
      await starting.current.get(id);
      starting.current.delete(id);
      // Always ask the server (the list here may not be loaded yet); no timer → 404
      try {
        put(await api.post<Timer[]>(`/tickets/${id}/timer/stop`));
      } catch {
        void qc.invalidateQueries({ queryKey: KEY });
      }
    },
    [on, qc, put],
  );

  return useMemo(() => ({ opened, closed }), [opened, closed]);
}

/** In the ticket window header: ▶ / ⏸, h:mm:ss, ■ Terminer. */
/** compact: the small, discreet copy beside the note box (same timer as the header) */
export function TimerControl({ ticketId, compact }: { ticketId: number; compact?: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const { at, list } = useTimers();
  const timer = list.find((x) => x.ticketId === ticketId);
  const now = useNow(timer?.state === "running");
  const act = useTimerAction();
  const ui = useTimerUi();
  if (!can("tickets.edit")) return null;

  if (compact) return <CompactTimer ticketId={ticketId} />;
  if (!timer) {
    return (
      <Button variant="outline" size="sm" className="h-9 gap-1.5" disabled={act.isPending} onClick={() => act.mutate({ ticketId, action: "start" })}>
        {act.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}
        {t("tickets.timer.start")}
      </Button>
    );
  }
  if (timer.state === "pending") {
    return (
      <Button variant="outline" size="sm" className="h-9 gap-1.5 border-orange-500/50 text-orange-300" onClick={() => ui.review(timer.id)}>
        <AlertTriangle className="size-3.5" /> {t("tickets.timer.pending")} · {clock(timer.elapsedMs)}
      </Button>
    );
  }
  const run = timer.state === "running";
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-1 rounded-full border pl-3 pr-1",
        run ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 shadow-[0_0_18px_-6px_rgba(255,206,26,0.6)]" : "border-border bg-muted/40",
      )}
    >
      <span className="relative mr-1 flex size-2">
        {run && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[color:var(--gold)] opacity-70" />}
        <span className={cn("relative inline-flex size-2 rounded-full", run ? "bg-[color:var(--gold)]" : "bg-muted-foreground")} />
      </span>
      <span className={cn("min-w-[4.5rem] font-mono text-sm tabular-nums", run ? "text-primary" : "text-muted-foreground")} aria-live="off">
        {clock(liveMs(timer, at, now))}
      </span>
      <TimerButton
        label={run ? t("tickets.timer.pause") : t("tickets.timer.resume")}
        onClick={() => act.mutate({ ticketId, action: run ? "pause" : "start" })}
        disabled={act.isPending}
      >
        {run ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
      </TimerButton>
      <TimerButton label={t("tickets.timer.enter")} onClick={() => act.mutate({ ticketId, action: "stop" })} disabled={act.isPending}>
        <CornerDownLeft className="size-3.5" />
      </TimerButton>
    </div>
  );
}

/** Beside the note box: h:mm:ss in small, ⏸ / ▶ and ↵ (enter the time) on hover-sized buttons */
function CompactTimer({ ticketId }: { ticketId: number }) {
  const { t } = useTranslation();
  const { at, list } = useTimers();
  const timer = list.find((x) => x.ticketId === ticketId);
  const now = useNow(timer?.state === "running");
  const act = useTimerAction();
  if (!timer || timer.state === "pending") return null;
  const run = timer.state === "running";
  const small = "flex size-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50";
  return (
    <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground" aria-label={t("tickets.timer.label")}>
      <span className={cn("size-1.5 rounded-full", run ? "bg-[color:var(--gold)]" : "bg-muted-foreground/60")} />
      <span className={cn("ml-1 font-mono tabular-nums", run && "text-primary/80")}>{clock(liveMs(timer, at, now))}</span>
      <button
        type="button"
        className={small}
        disabled={act.isPending}
        onClick={() => act.mutate({ ticketId, action: run ? "pause" : "start" })}
        aria-label={run ? t("tickets.timer.pause") : t("tickets.timer.resume")}
        title={run ? t("tickets.timer.pause") : t("tickets.timer.resume")}
      >
        {run ? <Pause className="size-2.5 fill-current" /> : <Play className="size-2.5 fill-current" />}
      </button>
      <button
        type="button"
        className={small}
        disabled={act.isPending}
        onClick={() => act.mutate({ ticketId, action: "stop" })}
        aria-label={t("tickets.timer.enter")}
        title={t("tickets.timer.enter")}
      >
        <CornerDownLeft className="size-3" />
      </button>
    </span>
  );
}

function TimerButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          disabled={disabled}
          aria-label={label}
          className="flex size-7 items-center justify-center rounded-full text-foreground/80 transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Small timer in a dock item: time + play / pause (compact: for the honeycomb cell). */
export function DockTimer({ timer, at, compact }: { timer: Timer; at: number; compact?: boolean }) {
  const { t } = useTranslation();
  const now = useNow(timer.state === "running");
  const act = useTimerAction();
  const ui = useTimerUi();
  if (timer.state === "pending") {
    return (
      <button type="button" onClick={() => ui.review(timer.id)} className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium text-orange-300">
        {t("tickets.timer.pending")}
      </button>
    );
  }
  const run = timer.state === "running";
  if (compact) {
    return (
      <span className={cn("font-mono text-[10px] leading-none tabular-nums", run ? "text-primary" : "text-muted-foreground")}>
        {clock(liveMs(timer, at, now))}
      </span>
    );
  }
  return (
    <span
      className={cn("flex items-center gap-0.5 rounded-full py-0.5 pl-2", run ? "bg-[color:var(--gold)]/15 text-primary" : "bg-muted text-muted-foreground")}
    >
      <span className="font-mono text-[11px] tabular-nums">{clock(liveMs(timer, at, now))}</span>
      <TimerButton
        label={run ? t("tickets.timer.pause") : t("tickets.timer.resume")}
        onClick={() => act.mutate({ ticketId: timer.ticketId, action: run ? "pause" : "start" })}
        disabled={act.isPending}
      >
        {run ? <Pause className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
      </TimerButton>
    </span>
  );
}

/** Asks the ticket workspace to close a ticket (detail: its id), without the time prompt. */
export const CLOSE_TICKET_EVENT = "akab:close-ticket";

/** Validate a stopped timer: hours, summary, internal note, work type → time entry. */
function TimeEntryDialog({ timer, position, onLater }: { timer: Timer; position: { n: number; total: number }; onLater: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const minutes = Math.max(1, Math.round(timer.elapsedMs / 60_000));
  // typed as h:mm (the measured time, at least a minute); sent as decimal hours
  const [hours, setHours] = useState(() => hm(Math.max(1, Math.round(timer.elapsedMs / 60_000)) / 60));
  const [summary, setSummary] = useState("");
  const [internal, setInternal] = useState("");
  // the description by email: to the ticket contact, and to other addresses (the "Envoi" part)
  const [notifyContact, setNotifyContact] = useState(false);
  const [others, setOthers] = useState<string[]>([]);
  const [sendOpen, setSendOpen] = useState(false);
  const { data: ticket } = useQuery({
    queryKey: ["tickets", "detail", timer.ticketId],
    queryFn: () => api.get<TicketDetail>(`/tickets/${timer.ticketId}`),
    staleTime: 60_000,
  });
  const contactEmail = ticket?.contactInfo?.email ?? null;
  const txt = useChoiceText();
  // the ticket's status and due date can change with the time entered
  const [statusNew, setStatusNew] = useState("");
  const [dueNew, setDueNew] = useState("");
  const [dueChanged, setDueChanged] = useState(false);
  const localInput = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const [workType, setWorkType] = useState("");
  // billed to the client, and the hours worked but not billed
  const [billableOn, setBillableOn] = useState(true);
  // the contract the time is logged on: the ticket's, unless another is picked
  const [contractPick, setContractPick] = useState("");
  const contracts = ticket?.contracts ?? [];
  const contract = contracts.find((k) => k.id === (contractPick || ticket?.contract?.id)) ?? null;
  // only an hourly contract bills the hours; monthly, per ticket and included ones never do
  const billable = billableOn && (contract ? contract.billed : true);
  const [offset, setOffset] = useState("");
  const { data: workTypes = [] } = useQuery({
    queryKey: ["tickets", "work-types"],
    queryFn: () => api.get<{ value: string; label: string }[]>("/tickets/work-types"),
    staleTime: 10 * 60_000,
  });
  // Stopped by itself (page closed) rather than by "Terminer" just now
  const auto = timer.endedAt ? Date.now() - new Date(timer.endedAt).getTime() > 2 * 60_000 : false;

  const done = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["tickets", "detail", timer.ticketId] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const submit = useMutation({
    mutationFn: () =>
      api.post<{ notified?: number; notifyFailed?: number; noContactEmail?: boolean }>(`/tickets/timers/${timer.id}/submit`, {
        hours: h,
        summary,
        internal,
        workTypeId: workType || null,
        billable,
        offsetHours: billable ? off : 0,
        contractId: contract?.id ?? null,
        // what changes on the ticket with this time: its status and due date, only when changed
        ...(statusNew && statusNew !== ticket?.status ? { status: statusNew } : {}),
        ...(dueChanged && dueNew ? { dueAt: new Date(dueNew).toISOString() } : {}),
        notify: { contact: notifyContact, others },
      }),
    onSuccess: (r: { notified?: number; notifyFailed?: number; noContactEmail?: boolean }) => {
      toast.success(t("tickets.timer.saved"));
      if (r?.notified) toast.success(t("tickets.timer.notified", { count: r.notified }));
      if (r?.notifyFailed) toast.error(t("tickets.timer.notifyFailed", { count: r.notifyFailed }));
      if (r?.noContactEmail) toast.warning(t("tickets.timer.noContactEmail"));
      done();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const discard = useMutation({
    mutationFn: () => api.del(`/tickets/timers/${timer.id}`),
    onSuccess: () => {
      done();
      // "close with no time": the ticket closes too when it is still open (no new timer starts)
      window.dispatchEvent(new CustomEvent(CLOSE_TICKET_EVENT, { detail: timer.ticketId }));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const h = parseHm(hours) ?? 0;
  const hoursOk = parseHm(hours) !== null && h > 0 && h <= 24;
  const off = offset.trim() ? (parseHm(offset) ?? Number.NaN) : 0;
  const offsetOk = !billable || (Number.isFinite(off) && off >= 0 && off <= h);
  const billed = Math.max(0, Math.round((h - (billable ? off : h)) * 100) / 100);
  const othersOk = others.every(isAddress);
  const valid = hoursOk && summary.trim().length > 0 && offsetOk && othersOk;
  // a short timer is closed without asking; a longer one is confirmed first
  const closeWithoutTime = () =>
    minutes <= 5 ? discard.mutate() : void confirm({ title: t("tickets.timer.discardConfirm"), destructive: true }).then((ok) => ok && discard.mutate());

  return (
    <Dialog open onOpenChange={(o) => !o && onLater()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TimerIcon className="size-5 text-primary" /> {t("tickets.timer.entryTitle")}
            {position.total > 1 && (
              <span className="text-xs font-normal text-muted-foreground">{t("tickets.timer.counter", { n: position.n, total: position.total })}</span>
            )}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{timer.ticketNumber}</span> · {timer.ticketTitle}
          </DialogDescription>
        </DialogHeader>
        {auto && timer.endedAt && (
          <p className="flex items-start gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-orange-300" />
            {t("tickets.timer.closedTab", { time: longDateTime(timer.endedAt) })}
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="te-hours">{t("tickets.timer.hours")}</Label>
              <Input
                id="te-hours"
                inputMode="numeric"
                placeholder="h:mm"
                className={cn("font-mono", hours.trim() && !hoursOk && "border-destructive")}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                onBlur={() => hoursOk && setHours(hm(h))}
              />
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock3 className="size-3" /> {t("tickets.timer.measured", { minutes })}
              </p>
            </div>
            {workTypes.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="te-type">{t("tickets.timer.workType")}</Label>
                <Select value={workType || "default"} onValueChange={(v) => setWorkType(v === "default" ? "" : v)}>
                  <SelectTrigger id="te-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="default">{t("tickets.timer.workTypeDefault")}</SelectItem>
                    {workTypes.map((w) => (
                      <SelectItem key={w.value} value={w.value}>
                        {w.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {contracts.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="te-contract">{t("tickets.contractBilling.label")}</Label>
              <Select value={contract?.id ?? ""} onValueChange={setContractPick}>
                <SelectTrigger id="te-contract" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {contracts.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name}
                      {k.isDefault ? ` · ${t("tickets.contractBilling.default")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{contractNote(t, i18n.language, contract)}</p>
            </div>
          )}
          {/* billing: billed or not, and an offset (hours worked but not billed) */}
          <div className="space-y-2 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox checked={billable} disabled={contract ? !contract.billed : false} onCheckedChange={(v) => setBillableOn(v === true)} />
                <Receipt className="size-4 text-primary" /> {t("tickets.timer.billable")}
              </label>
              {billable && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="te-offset" className="text-sm text-muted-foreground">
                    {t("tickets.timer.offset")}
                  </Label>
                  <Input
                    id="te-offset"
                    inputMode="numeric"
                    className={cn("h-8 w-20 font-mono", !offsetOk && "border-destructive")}
                    placeholder="0:00"
                    value={offset}
                    onChange={(e) => setOffset(e.target.value)}
                    onBlur={() => offset.trim() && Number.isFinite(off) && setOffset(hm(off))}
                  />
                </div>
              )}
            </div>
            <p className={cn("text-xs", !offsetOk ? "text-destructive" : billable ? "text-muted-foreground" : "text-slate-400")}>
              {!offsetOk
                ? t("tickets.timer.offsetTooLarge")
                : billable
                  ? t("tickets.timer.billedHours", { worked: hm(h), billed: hm(billed) })
                  : t("tickets.timer.notBilled")}
            </p>
          </div>
          {/* what the ticket becomes with this work: its status and its due date */}
          {ticket && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="te-status">{t("tickets.fields.status")}</Label>
                <select
                  id="te-status"
                  value={statusNew || ticket.status}
                  onChange={(e) => setStatusNew(e.target.value)}
                  className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
                >
                  {ticket.options.statuses
                    .filter((x) => !x.hidden || x.value === ticket.status)
                    .map((x) => (
                      <option key={x.value} value={x.value}>
                        {txt.status(x)}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="te-due">{t("tickets.fields.due")}</Label>
                <Input id="te-due" type="datetime-local" value={dueNew || localInput(ticket.dueAt)} onChange={(e) => (setDueNew(e.target.value), setDueChanged(true))} />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="te-summary">{t("tickets.timer.summary")}</Label>
            <AiTextarea
              id="te-summary"
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("tickets.timer.summaryHint")}
              autoFocus
            />
          </div>
          {/* the description can go to the client: the ticket contact, and other addresses */}
          <div className="space-y-2">
            <label className={cn("flex cursor-pointer items-center gap-2 text-sm", !contactEmail && "opacity-60")}>
              <Checkbox checked={notifyContact} disabled={!contactEmail} onCheckedChange={(v) => setNotifyContact(v === true)} />
              <Mail className="size-4 text-primary" />
              {contactEmail ? t("tickets.timer.notifyContact", { who: ticket?.contact || contactEmail, email: contactEmail }) : t("tickets.timer.notifyNoContact")}
            </label>
            <button
              type="button"
              onClick={() => setSendOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={sendOpen}
            >
              <ChevronDown className={cn("size-3 transition-transform", sendOpen && "rotate-180")} />
              {others.length ? t("tickets.timer.othersCount", { count: others.length }) : t("tickets.timer.others")}
            </button>
            {sendOpen && (
              <div className="space-y-1.5 rounded-xl border p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.timer.sendTitle")}</p>
                <RecipientInput id="te-others" label={t("tickets.timer.othersLabel")} value={others} onChange={setOthers} />
                <p className="text-[11px] text-muted-foreground">{t("tickets.timer.sendHint")}</p>
              </div>
            )}
          </div>
          <div className="space-y-1.5 rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-3">
            <Label htmlFor="te-internal" className="flex items-center gap-1.5">
              <Lock className="size-3.5 text-violet-300" /> {t("tickets.timer.internal")}
            </Label>
            <AiTextarea id="te-internal" rows={2} value={internal} onChange={(e) => setInternal(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("tickets.timer.internalHint")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={discard.isPending || submit.isPending}
              onClick={closeWithoutTime}
              title={t("tickets.timer.noTimeHint")}
            >
              {discard.isPending ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />} {t("tickets.timer.noTime")}
            </Button>
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onLater} title={t("tickets.timer.laterHint")}>
              {t("tickets.timer.later")}
            </Button>
            <Button type="submit" disabled={!valid || submit.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {submit.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.timer.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
