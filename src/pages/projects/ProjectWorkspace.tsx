import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Flag, FolderKanban, ListTodo, Maximize2, X } from "lucide-react";
import { dockBus, useDockBus } from "@/lib/dockBus";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TaskDialog, type DockedTask } from "./TaskDialog";
import { clock, KEY, TASK_STYLE } from "./shared";

/**
 * The task workspace, for every staff page: a task window opened over the page, and the minimized ones in the SAME drawer as
 * the minimized tickets (opened by the floating logo), as violet cards marked "projet" so the two are never mixed up. A task with a running timer stays in the dock even when it was not minimized. Kept for the browser tab.
 */
export type DockedFolder = { projectId: string; number: string; name: string };
type Ws = { openTask: (projectId: string, taskId: string) => void; closeTask: () => void; current: { projectId: string; taskId: string } | null; minimizeProject: (f: DockedFolder) => void };
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
  // minimized project folders (the drawer shows them; a running phase timer keeps going)
  const [folders, setFolders] = useState<DockedFolder[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("akab.projects.folders") ?? "[]") as DockedFolder[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("akab.projects.folders", JSON.stringify(folders));
    } catch {
      /* the dock works without it */
    }
  }, [folders]);
  const minimizeProject = useCallback((f: DockedFolder) => setFolders((x) => [...x.filter((y) => y.projectId !== f.projectId), f].slice(-6)), []);
  const navigate = useNavigate();
  const location = useLocation();
  const openTask = useCallback((projectId: string, taskId: string) => {
    setDocked((d) => d.filter((x) => x.taskId !== taskId));
    setCurrent({ projectId, taskId });
  }, []);
  // restoring a task that was minimized with its project folder open brings the folder back behind it
  const restore = useCallback(
    (projectId: string, taskId: string) => {
      const d = docked.find((x) => x.taskId === taskId);
      if (d?.folder) {
        // the folder first, then the task on top of it (a window opened later is drawn above the earlier one)
        navigate(`/pipeline?section=projects&project=${projectId}&tab=milestones`);
        setTimeout(() => openTask(projectId, taskId), 250);
      } else openTask(projectId, taskId);
    },
    [docked, navigate, openTask],
  );
  const closeTask = useCallback(() => setCurrent(null), []);
  // minimizing a task also minimizes the project folder it was opened from (the whole project goes into the drawer)
  const minimize = useCallback(
    (t: DockedTask) => {
      const q = new URLSearchParams(location.search);
      const folder = q.get("project") === t.projectId;
      setDocked((d) => [...d.filter((x) => x.taskId !== t.taskId), { ...t, folder }].slice(-6));
      setCurrent(null);
      if (folder) {
        q.delete("project");
        q.delete("tab");
        q.delete("milestone");
        q.delete("task");
        navigate({ pathname: location.pathname, search: q.toString() }, { replace: true });
      }
    },
    [location.pathname, location.search, navigate],
  );
  const value = useMemo(() => ({ openTask, closeTask, current, minimizeProject }), [openTask, closeTask, current, minimizeProject]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {enabled && current && <TaskDialog key={current.taskId} projectId={current.projectId} taskId={current.taskId} onClose={closeTask} onMinimize={minimize} />}
      {enabled && <TaskDock docked={docked} folders={folders} onRestoreFolder={(id) => setFolders((x) => x.filter((y) => y.projectId !== id))} onRestore={restore} onDismiss={(id) => setDocked((d) => d.filter((x) => x.taskId !== id))} />}
    </Ctx.Provider>
  );
}

export function useProjectWorkspace() {
  const ws = useContext(Ctx);
  if (!ws) throw new Error("useProjectWorkspace outside ProjectWorkspaceProvider");
  return ws;
}

type RunningTimer = { taskId: string; startedAt: string; title: string; projectId: string; number: string; project?: string; milestone: string; kind?: "phase"; milestoneId?: string };

/** The minimized project tasks, drawn into the drawer of the ticket dock (a project card: project, task, timer) */
function TaskDock({ docked, folders, onRestoreFolder, onRestore, onDismiss }: { docked: DockedTask[]; folders: DockedFolder[]; onRestoreFolder: (projectId: string) => void; onRestore: (projectId: string, taskId: string) => void; onDismiss: (taskId: string) => void }) {
  const { t } = useTranslation();
  const { slot } = useDockBus();
  const navigate = useNavigate();
  // a minimized phase (its timer runs) reopens the project folder on that phase
  const restoreItem = (d: { projectId: string; taskId: string; phase: boolean; folder?: boolean }) =>
    d.folder ? (onRestoreFolder(d.projectId), navigate(`/pipeline?section=projects&project=${d.projectId}&tab=milestones`)) : d.phase ? navigate(`/pipeline?section=projects&project=${d.projectId}&tab=milestones&milestone=${d.taskId}`) : onRestore(d.projectId, d.taskId);
  const { data: timers = [] } = useQuery({ queryKey: [...KEY, "timers"], queryFn: () => api.get<RunningTimer[]>("/projects/timers"), refetchInterval: 30_000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timers.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timers.length]);
  const folderIds = new Set(folders.map((f) => f.projectId));
  const items = [
    // a minimized project folder: its running phase timer (the earliest) is shown on its card
    ...folders.map((f) => ({ projectId: f.projectId, taskId: `folder:${f.projectId}`, number: f.number, project: f.name, title: "", milestone: "", status: "doing" as const, folder: true as boolean | undefined, phase: false, timer: timers.filter((x) => x.projectId === f.projectId).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] })),
    ...docked.map((d) => ({ ...d, phase: false, folder: undefined as boolean | undefined, timer: timers.find((x) => x.taskId === d.taskId) })),
    ...timers.filter((x) => !docked.some((d) => d.taskId === x.taskId) && !folderIds.has(x.projectId)).map((x) => ({ projectId: x.projectId, taskId: x.taskId, number: x.number, project: x.project, title: x.title, milestone: x.milestone, status: "doing" as const, timer: x, phase: x.kind === "phase", folder: undefined as boolean | undefined })),
  ];
  // the drawer counts them, and glows electric while a timer runs
  useEffect(() => {
    dockBus.set({ projects: items.length, projectRunning: items.some((x) => x.timer) });
    return () => dockBus.set({ projects: 0, projectRunning: false });
  }, [items.length, items.some((x) => x.timer)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!slot || items.length === 0) return null;
  return createPortal(
    <AnimatePresence>
      {items.map((d) => {
        const running = Boolean(d.timer);
        return (
          <motion.div key={d.taskId} layout initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.95 }} className="pointer-events-auto">
            <div className={cn("group relative flex w-72 items-center gap-2 overflow-hidden rounded-xl border border-violet-400/40 bg-popover/95 py-1.5 pl-1.5 pr-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6),0_0_24px_-10px_rgba(167,139,250,0.45)]", running && "project-live border-violet-300/80")}>
              <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-violet-400" />
              <button type="button" onClick={() => restoreItem(d)} title={`${d.number} ${d.project ?? ""} — ${d.title}`} className="flex min-w-0 flex-1 items-center gap-2 pl-1.5 text-left">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
                  <FolderKanban className="size-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 font-mono text-[10px] text-violet-300">
                    <span className="rounded bg-violet-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide">{t("projects.dockBadge")}</span>
                    {d.number}
                    {!d.folder && <span className="truncate font-sans text-muted-foreground">{d.project}</span>}
                  </span>
                  <span className="flex items-center gap-1 truncate text-xs font-medium">
                    {d.folder ? <FolderKanban className="size-3 shrink-0 text-violet-300" /> : d.phase ? <Flag className="size-3 shrink-0 text-violet-300" /> : <ListTodo className="size-3 shrink-0 text-violet-300" />}
                    <span className="truncate">{d.folder ? d.project : d.title}</span>
                  </span>
                </span>
              </button>
              {d.timer ? (
                <span className="shrink-0 rounded-md bg-[color:var(--gold)]/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-primary">{clock((now - new Date(d.timer.startedAt).getTime()) / 1000)}</span>
              ) : (
                !d.folder && <span className={cn("hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium sm:block", TASK_STYLE[d.status])}>{t(`projects.taskStatus.${d.status}`)}</span>
              )}
              <button type="button" onClick={() => restoreItem(d)} aria-label={t("projects.restore")} title={t("projects.restore")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <Maximize2 className="size-3.5" />
              </button>
              {!running && (
                <button type="button" onClick={() => (d.folder ? onRestoreFolder(d.projectId) : onDismiss(d.taskId))} aria-label={t("common.close")} title={t("common.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
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
