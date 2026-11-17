import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { clockText, projError, useTimerSeconds } from "./ProjComposer";
import type { ProjDetail } from "./shared";

/**
 * The project timer at the top of the window, like a ticket's: it starts by itself when the project is opened
 * (once), pause / play, and a button that goes straight to the time entry with the clock's time.
 */
export function ProjTimerChip({ project }: { project: ProjDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const closed = project.status === "done" || project.status === "cancelled";
  const usable = can("proj.edit") && can("timesheets.use") && !closed;
  const timer = project.timer;
  const seconds = useTimerSeconds(timer);
  const call = useMutation({
    mutationFn: (what: "start" | "pause" | "resume") => api.post(`/proj/${project.id}/timer/${what}`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["proj"] }),
    onError: (e) => toast.error(projError(t, e)),
  });
  // opening the project starts the timer, once per opening
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!usable || timer || tried.current === project.id) return;
    tried.current = project.id;
    call.mutate("start");
  }, [usable, Boolean(timer), project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!usable || !timer) return null;
  const enter = () => {
    const next = new URLSearchParams(params);
    next.set("time", "1");
    setParams(next, { replace: true });
  };
  return (
    <div className={cn("flex items-center gap-2 rounded-2xl border px-3 py-2", timer.paused ? "border-amber-400/40 bg-amber-500/5" : "border-violet-500/50 bg-violet-500/10")} role="group" aria-label={t("projWork.timer.title")}>
      <Clock className={cn("size-4", timer.paused ? "text-amber-300" : "text-violet-300")} aria-hidden />
      <span className={cn("font-mono text-lg font-semibold tabular-nums", timer.paused ? "text-amber-300" : "text-violet-200")} aria-live="off">
        {clockText(seconds)}
      </span>
      <Button type="button" size="icon" variant="ghost" onClick={() => call.mutate(timer.paused ? "resume" : "pause")} disabled={call.isPending} aria-label={timer.paused ? t("projWork.timer.resume") : t("projWork.timer.pause")} title={timer.paused ? t("projWork.timer.resume") : t("projWork.timer.pause")}>
        {timer.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={enter} className="border-violet-500/40">
        <Square className="size-3.5" /> {t("projWork.timer.enter")}
      </Button>
    </div>
  );
}
