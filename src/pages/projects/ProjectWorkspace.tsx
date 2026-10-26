import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Flag, ListTodo, Maximize2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TaskDialog, type DockedTask } from "./TaskDialog";
import { clock, KEY, TASK_STYLE } from "./shared";

/**
 * The task workspace, for every staff page: a task window opened over the page, and the minimized ones in a dock at the
 * bottom CENTER (tickets' honeycombs are at the bottom right: a task is a violet card marked "tâche", so the two are never
 * mixed up). A task with a running timer stays in the dock even when it was not minimized. Kept for the browser tab.
 */
type Ws = { openTask: (projectId: string, taskId: string) => void; closeTask: () => void; current: { projectId: string; taskId: string } | null };
const Ctx = createContext<Ws | null>(null);
const STORE = "akab.projects.dock";

export function ProjectWorkspaceProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [current, setCurrent] = useState<{ projectId: string; taskId: string } | null>(null);
  const [docked, setDocked] = useState<DockedTask[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as DockedTask[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(docked));
    } catch {
      /* the dock works without it */
    }
  }, [docked]);
  const openTask = useCallback((projectId: string, taskId: string) => {
    setDocked((d) => d.filter((x) => x.taskId !== taskId));
    setCurrent({ projectId, taskId });
  }, []);
  const closeTask = useCallback(() => setCurrent(null), []);
  const minimize = useCallback((t: DockedTask) => {
    setDocked((d) => [...d.filter((x) => x.taskId !== t.taskId), t].slice(-6));
    setCurrent(null);
  }, []);
  const value = useMemo(() => ({ openTask, closeTask, current }), [openTask, closeTask, current]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {enabled && current && <TaskDialog key={current.taskId} projectId={current.projectId} taskId={current.taskId} onClose={closeTask} onMinimize={minimize} />}
      {enabled && <TaskDock docked={docked} hidden={current !== null} onRestore={openTask} onDismiss={(id) => setDocked((d) => d.filter((x) => x.taskId !== id))} />}
    </Ctx.Provider>
  );
}

export function useProjectWorkspace() {
  const ws = useContext(Ctx);
  if (!ws) throw new Error("useProjectWorkspace outside ProjectWorkspaceProvider");
  return ws;
}

type RunningTimer = { taskId: string; startedAt: string; title: string; projectId: string; number: string; milestone: string };

function TaskDock({ docked, hidden, onRestore, onDismiss }: { docked: DockedTask[]; hidden: boolean; onRestore: (projectId: string, taskId: string) => void; onDismiss: (taskId: string) => void }) {
  const { t } = useTranslation();
  const { data: timers = [] } = useQuery({ queryKey: [...KEY, "timers"], queryFn: () => api.get<RunningTimer[]>("/projects/timers"), refetchInterval: 30_000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timers.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timers.length]);
  const items = [
    ...docked.map((d) => ({ ...d, timer: timers.find((x) => x.taskId === d.taskId) })),
    ...timers.filter((x) => !docked.some((d) => d.taskId === x.taskId)).map((x) => ({ projectId: x.projectId, taskId: x.taskId, number: x.number, title: x.title, milestone: x.milestone, status: "doing" as const, timer: x })),
  ];
  if (hidden || items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap-reverse items-end justify-center gap-2" aria-label={t("projects.dock")}>
      <AnimatePresence>
        {items.map((d) => {
          const running = Boolean(d.timer);
          return (
            <motion.div
              key={d.taskId}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.95 }}
              className="pointer-events-auto"
            >
              <div className={cn("group relative flex w-64 items-center gap-2 overflow-hidden rounded-xl border border-violet-400/40 bg-popover/95 py-1.5 pl-1.5 pr-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6),0_0_24px_-10px_rgba(167,139,250,0.45)] backdrop-blur-xl", running && "border-violet-300/80")}>
                <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-violet-400" />
                <button type="button" onClick={() => onRestore(d.projectId, d.taskId)} title={`${d.number} — ${d.title}`} className="flex min-w-0 flex-1 items-center gap-2 pl-1.5 text-left">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
                    <ListTodo className="size-[18px]" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 font-mono text-[10px] text-violet-300">
                      <span className="rounded bg-violet-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide">{t("projects.taskBadge")}</span>
                      {d.number}
                      <Flag className="size-2.5 text-muted-foreground" />
                      <span className="truncate text-muted-foreground">{d.milestone}</span>
                    </span>
                    <span className="block truncate text-xs font-medium">{d.title}</span>
                  </span>
                </button>
                {d.timer ? (
                  <span className="shrink-0 rounded-md bg-[color:var(--gold)]/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-primary">{clock((now - new Date(d.timer.startedAt).getTime()) / 1000)}</span>
                ) : (
                  <span className={cn("hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium sm:block", TASK_STYLE[d.status])}>{t(`projects.taskStatus.${d.status}`)}</span>
                )}
                <button type="button" onClick={() => onRestore(d.projectId, d.taskId)} aria-label={t("projects.restore")} title={t("projects.restore")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Maximize2 className="size-3.5" />
                </button>
                {!running && (
                  <button type="button" onClick={() => onDismiss(d.taskId)} aria-label={t("common.close")} title={t("common.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
