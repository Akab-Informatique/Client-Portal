import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Clock, Loader2, Pause, Play, Square, StickyNote, Trash2 } from "lucide-react";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import { todayYmd, type TaskFull } from "./shared";
import { clock } from "@/pages/projects/shared";
import { taskError } from "./TaskDialog";

type Filter = "all" | "notes" | "time";

/**
 * The activity of a to-do task, laid out like a project phase's: a box with two tabs (internal note, time entry) and the
 * history under it, newest first. Everything on a to-do is internal: there is no note for the client, and the time is never
 * billable and belongs to no client, so it never counts in anyone's billable share.
 */
export function TaskActivity({ task, editable, onChanged, startOnTime = false }: { task: TaskFull; editable: boolean; onChanged: () => void; startOnTime?: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"note" | "time">(startOnTime ? "time" : "note");
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [date, setDate] = useState(todayYmd());
  const [duration, setDuration] = useState("");
  const [worked, setWorked] = useState<string[]>([]);
  const [finished, setFinished] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const items = task.checklistItems;
  const nameOf = new Map(items.map((i) => [i.id, i.text]));
  const hours = parseHm(duration);
  const canTime = can("timesheets.use");
  const qc = useQueryClient();

  // ── the timer: starts when the person who has the task opens it (once), counts, pauses; stopping asks for the time ──
  type TimerView = { startedAt: string; baseSeconds: number; paused: boolean; seconds: number } | null;
  const timerKey = ["pipeline", "task", task.id, "timer"];
  const { data: timer, isFetched } = useQuery({ queryKey: timerKey, queryFn: () => api.get<TimerView>(`/pipeline/tasks/${task.id}/timer`), enabled: editable && canTime });
  const timerCall = useMutation({
    mutationFn: (what: "start" | "pause" | "resume") => api.post(`/pipeline/tasks/${task.id}/timer/${what}`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: timerKey });
      void qc.invalidateQueries({ queryKey: ["pipeline", "timers"] });
    },
    onError: (e) => toast.error(taskError(t, e)),
  });
  const mine = task.assignees.some((a) => a.id === me.id);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !isFetched || timer || !editable || !canTime || !mine || task.status === "done") return;
    started.current = true;
    timerCall.mutate("start");
  }, [isFetched, timer]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timer || timer.paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer?.paused, timer?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const seconds = timer ? timer.baseSeconds + (timer.paused ? 0 : Math.max(0, (now - new Date(timer.startedAt).getTime()) / 1000)) : 0;
  const fillFromTimer = () => {
    setMode("time");
    if (timer) setDuration(hm(Math.max(1 / 60, Math.round((seconds / 3600) * 100) / 100)));
  };
  // asked to enter the time right now (closing with a timer running)
  useEffect(() => {
    if (startOnTime && timer && !duration) fillFromTimer();
  }, [startOnTime, timer?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    try {
      await fn();
      after();
      onChanged();
    } catch (e) {
      toast.error(taskError(t, e));
    } finally {
      setBusy(false);
    }
  };
  const addNote = () => run(() => api.post(`/pipeline/tasks/${task.id}/notes`, { text: text.trim() }), () => setText(""));
  const addTime = () => {
    if (hours === null || hours < 0.05) return toast.error(t("pipeline.activity.durationFormat"));
    void run(
      () => api.post(`/pipeline/tasks/${task.id}/${timer ? "timer/stop" : "time"}`, { date, hours, note: text.trim() || undefined, itemIds: worked, doneItemIds: finished }),
      () => {
        void qc.invalidateQueries({ queryKey: timerKey });
        void qc.invalidateQueries({ queryKey: ["pipeline", "timers"] });
        setText("");
        setDuration("");
        setWorked([]);
        setFinished([]);
        toast.success(t("pipeline.activity.timeSaved"));
      },
    );
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const removeTime = async (id: string) => {
    if (!(await confirm({ title: t("pipeline.activity.removeTitle"), description: t("pipeline.activity.removeText"), confirmLabel: t("common.delete"), destructive: true }))) return;
    void run(() => api.del(`/time/entries/${id}`), () => undefined);
  };

  type Row = { key: string; at: string; kind: "notes" | "time"; node: React.ReactNode };
  const rows: Row[] = [
    ...task.comments.map(
      (c): Row => ({
        key: `n${c.id}`,
        at: c.createdAt,
        kind: "notes",
        node: (
          <li className="rounded-xl border border-violet-400/30 bg-violet-500/5 px-3 py-2">
            <p className="text-xs">
              <span className="font-semibold">{c.author}</span> <span className="text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
              <span className="ml-2 rounded-full border border-violet-400/40 px-1.5 text-[10px] text-violet-300">{t("pipeline.activity.internal")}</span>
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{c.text}</p>
          </li>
        ),
      }),
    ),
    ...task.timeEntries.map(
      (e): Row => ({
        key: `t${e.id}`,
        at: e.createdAt,
        kind: "time",
        node: (
          <li className="rounded-xl border border-sky-400/30 bg-sky-500/5 px-3 py-2">
            <p className="flex items-center gap-2 text-xs">
              <Clock className="size-3.5 text-sky-300" />
              <span className="font-semibold">{e.by}</span> <span className="text-muted-foreground">{e.date}</span>
              <span className="rounded-full border border-sky-400/40 px-1.5 font-mono text-[11px] text-sky-300">{hm(e.hours)}</span>
              {(e.userId === me.id || can("timesheets.manage")) && (
                <button type="button" onClick={() => void removeTime(e.id)} className="ml-auto text-muted-foreground hover:text-destructive" aria-label={t("common.delete")}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </p>
            {e.note && <p className="mt-1 whitespace-pre-wrap text-sm">{e.note}</p>}
            {e.itemIds.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {e.itemIds.map((id) => (
                  <li key={id} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                    {nameOf.get(id) ?? "…"}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ),
      }),
    ),
  ]
    .filter((r) => filter === "all" || r.kind === filter)
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="space-y-3">
      {editable && (
        <div className="space-y-2 rounded-xl border bg-background/40 p-3">
          {timer && (
            <div className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2", timer.paused ? "border-amber-400/40 bg-amber-500/5" : "border-emerald-400/40 bg-emerald-500/5")}>
              <Clock className={cn("size-4", timer.paused ? "text-amber-300" : "text-emerald-300")} />
              <span className={cn("font-mono text-base font-semibold tabular-nums", timer.paused ? "text-amber-300" : "text-emerald-300")}>{clock(seconds)}</span>
              <span className="text-xs text-muted-foreground">{timer.paused ? t("pipeline.activity.timerPaused") : t("pipeline.activity.timerRunning")}</span>
              <span className="ml-auto flex items-center gap-1.5">
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1" disabled={timerCall.isPending} onClick={() => timerCall.mutate(timer.paused ? "resume" : "pause")}>
                  {timer.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} {timer.paused ? t("pipeline.activity.resume") : t("pipeline.activity.pause")}
                </Button>
                <Button type="button" size="sm" className="h-8 gap-1" onClick={fillFromTimer}>
                  <Square className="size-3.5" /> {t("pipeline.activity.stop")}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => void run(() => api.post(`/pipeline/tasks/${task.id}/timer/stop`, { discard: true }), () => { void qc.invalidateQueries({ queryKey: timerKey }); void qc.invalidateQueries({ queryKey: ["pipeline", "timers"] }); })}>
                  {t("pipeline.activity.discard")}
                </Button>
              </span>
            </div>
          )}
          <div className="flex gap-1.5" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium", mode === "note" ? "border-violet-400/50 bg-violet-500/10 text-violet-200" : "text-muted-foreground")}>
              <StickyNote className="size-3.5" /> {t("pipeline.activity.noteTab")}
            </button>
            {canTime && (
              <button type="button" role="tab" aria-selected={mode === "time"} onClick={() => setMode("time")} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium", mode === "time" ? "border-sky-400/50 bg-sky-500/10 text-sky-200" : "text-muted-foreground")}>
                <Clock className="size-3.5" /> {t("pipeline.activity.timeTab")}
              </button>
            )}
          </div>
          {mode === "time" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("pipeline.activity.day")}
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-40" />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("pipeline.activity.duration")}
                  <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1:30" className="h-9 w-24 font-mono" />
                </label>
              </div>
              {items.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">{t("pipeline.activity.covered")}</p>
                  <ul className="space-y-1">
                    {items.map((i) => {
                      const on = worked.includes(i.id) || finished.includes(i.id);
                      return (
                        <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <Checkbox
                            checked={on}
                            onCheckedChange={() => {
                              if (on) {
                                setWorked(worked.filter((x) => x !== i.id));
                                setFinished(finished.filter((x) => x !== i.id));
                              } else setWorked([...worked, i.id]);
                            }}
                          />
                          <span className={cn("min-w-0 flex-1", i.done && "text-muted-foreground line-through")}>{i.text}</span>
                          {on && !i.done && (
                            <label className="flex items-center gap-1 text-xs text-emerald-300">
                              <Checkbox checked={finished.includes(i.id)} onCheckedChange={() => toggle(finished, setFinished, i.id)} /> {t("pipeline.activity.finished")}
                            </label>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
          <AiTextarea rows={mode === "time" ? 3 : 4} value={text} onChange={(e) => setText(e.target.value)} maxLength={mode === "time" ? 2000 : 4000} placeholder={mode === "time" ? t("pipeline.activity.timeNote") : t("pipeline.teamNotesPlaceholder")} className={cn(mode === "note" && "border-violet-400/30")} />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={busy || (mode === "note" ? !text.trim() : hours === null)} onClick={() => (mode === "note" ? void addNote() : addTime())}>
              {busy && <Loader2 className="size-3.5 animate-spin" />} {mode === "note" ? t("pipeline.addComment") : t("pipeline.activity.addTime")}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(["all", "notes", "time"] as Filter[]).map((k) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={cn("rounded-full border px-2.5 py-0.5 text-xs", filter === k ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary" : "text-muted-foreground")}>
            {t(`pipeline.activity.filter.${k}`)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("pipeline.activity.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <span key={r.key} className="contents">
              {r.node}
            </span>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A step ticked by hand: in which time entry was it done? */
export function PickEntryDialog({ task, itemId, onClose, onChanged, onAddTime }: { task: TaskFull; itemId: string; onClose: () => void; onChanged: () => void; onAddTime: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const item = task.checklistItems.find((i) => i.id === itemId);
  const mine = task.timeEntries.filter((e) => e.userId === me.id).slice().reverse();
  const [busy, setBusy] = useState(false);
  const pick = async (entryId: string) => {
    setBusy(true);
    try {
      await api.post(`/pipeline/tasks/${task.id}/checklist/${itemId}/time`, { entryId });
      onChanged();
      onClose();
    } catch (e) {
      toast.error(taskError(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("pipeline.activity.pickTitle")}</DialogTitle>
          <DialogDescription>{t("pipeline.activity.pickText", { item: item?.text ?? "" })}</DialogDescription>
        </DialogHeader>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pipeline.activity.pickNone")}</p>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {mine.map((e) => (
              <li key={e.id}>
                <button type="button" disabled={busy} onClick={() => void pick(e.id)} className="w-full rounded-lg border px-3 py-2 text-left text-sm hover:border-[color:var(--gold)]/50">
                  <span className="font-mono text-xs text-sky-300">{hm(e.hours)}</span> <span className="text-xs text-muted-foreground">{e.date}</span>
                  {e.note && <span className="mt-0.5 block truncate text-xs">{e.note}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("pipeline.activity.pickSkip")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => (onClose(), onAddTime())}>
            {t("pipeline.activity.pickAdd")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
