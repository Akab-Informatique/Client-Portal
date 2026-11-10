import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ListChecks, Maximize2, X } from "lucide-react";
import { dockBus, useDockBus } from "@/lib/dockBus";
import { todoDock, useDockedTodos } from "@/lib/todoDock";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { clock } from "@/pages/projects/shared";

type Running = { taskId: string; title: string; startedAt: string; baseSeconds: number; paused: boolean };

/**
 * The to-do tasks in the drawer of minimized items: a dashed emerald card marked "À faire", so a to-do is never mixed up with a
 * ticket (gold hexagon) or a project (violet). A to-do with a running timer stays here even when it was not minimized.
 */
export function TodoDock() {
  const { t } = useTranslation();
  const { slot } = useDockBus();
  const navigate = useNavigate();
  const docked = useDockedTodos();
  const { data: timers = [] } = useQuery({ queryKey: ["pipeline", "timers"], queryFn: () => api.get<Running[]>("/pipeline/timers"), refetchInterval: 30_000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timers.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timers.length]);
  const items = [
    ...docked.map((d) => ({ id: d.id, title: d.title, timer: timers.find((x) => x.taskId === d.id) })),
    ...timers.filter((x) => !docked.some((d) => d.id === x.taskId)).map((x) => ({ id: x.taskId, title: x.title, timer: x })),
  ];
  const running = items.some((x) => x.timer && !x.timer.paused);
  useEffect(() => {
    dockBus.set({ todos: items.length, todoRunning: running });
    return () => dockBus.set({ todos: 0, todoRunning: false });
  }, [items.length, running]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!slot || items.length === 0) return null;
  const open = (id: string) => {
    todoDock.remove(id);
    navigate(`/pipeline?section=todo&task=${id}`);
  };
  return createPortal(
    <AnimatePresence>
      {items.map((d) => {
        const live = Boolean(d.timer) && !d.timer?.paused;
        return (
          <motion.div key={`todo:${d.id}`} layout initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.95 }} className="pointer-events-auto">
            <div className={cn("group relative flex w-72 items-center gap-2 overflow-hidden rounded-lg border-2 border-dashed border-emerald-400/50 bg-popover/95 py-1.5 pl-1.5 pr-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6),0_0_22px_-10px_rgba(52,211,153,0.45)]", live && "project-live border-emerald-300/80")}>
              <button type="button" onClick={() => open(d.id)} title={d.title} className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-left">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-emerald-400/50 bg-emerald-500/10 text-emerald-300">
                  <ListChecks className="size-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[9px] font-semibold uppercase tracking-wider text-emerald-300">{t("pipeline.dockBadge")}</span>
                  <span className="block truncate text-xs font-medium">{d.title}</span>
                </span>
              </button>
              {d.timer && <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums", d.timer.paused ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300")}>{clock(d.timer.baseSeconds + (d.timer.paused ? 0 : (now - new Date(d.timer.startedAt).getTime()) / 1000))}</span>}
              <button type="button" onClick={() => open(d.id)} aria-label={t("pipeline.dockRestore")} title={t("pipeline.dockRestore")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <Maximize2 className="size-3.5" />
              </button>
              {!live && (
                <button type="button" onClick={() => todoDock.remove(d.id)} aria-label={t("common.close")} title={t("common.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </motion.div>
        );
      })}
    </AnimatePresence>,
    slot,
  );
}
