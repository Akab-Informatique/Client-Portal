import { useDraft } from "@/lib/useDraft";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AiTextarea } from "@/components/AiPolish";
import { PhasePanel } from "./PhasePanel";
import { ArrowDown, ArrowUp, GripVertical, BellRing, Check, Globe, Lock, ChevronDown, Clock, FileText, Flag, FolderOpen, Info, ListChecks, Loader2, Mail, MessageSquare, MessagesSquare, Minus, Pencil, Plus, Receipt, Star, Trash2, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import { shortDate, shortDateTime } from "@/pages/tickets/shared";
import { useProjectWorkspace } from "./ProjectWorkspace";
import { Overview } from "./Overview";
import { FilesBox } from "@/pages/pipeline/TaskParts";
import { fileToBase64 } from "@/pages/pipeline/shared";
import { PhaseDialog } from "./PhaseDialog";
import { ChargesTab } from "./ChargesTab";
import { MilestoneTasks } from "./MilestoneTasks";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { TaskDndCtx } from "./taskDnd";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, Text } from "./ui";
import { apiMessage, dueTone, hoursText, KEY, MS_TONE, useProjectPeople, STATUS_STYLE, TONE_TEXT, today, type Milestone, type ProjectDetail } from "./shared";

const TABS = [
  { key: "overview", icon: Info },
  { key: "milestones", icon: ListChecks },
  { key: "time", icon: Clock },
  { key: "charges", icon: Receipt },
  { key: "notes", icon: MessageSquare },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** The project as a folder: a header, then tabs — overview, milestones, time, notes. Everything is saved as it is changed. */
export function ProjectDialog({ id, onClose, tab, milestone, onTab }: { id: string; onClose: () => void; tab: string | null; milestone: string | null; onTab: (tab: string) => void }) {
  const ws = useProjectWorkspace();
  const onTask = (taskId: string | null) => taskId && ws.openTask(id, taskId);
  const [, setSearch] = useSearchParams();
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const current = (TABS.find((x) => x.key === tab)?.key ?? "overview") as TabKey;
  const { data: p, isLoading, isError } = useQuery({ queryKey: [...KEY, "detail", id], queryFn: () => api.get<ProjectDetail>(`/projects/${id}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: unknown) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t));
  const save = useMutation({ mutationFn: (patch: Record<string, unknown>) => api.patch(`/projects/${id}`, patch), onSuccess: refresh, onError: fail });
  const follow = useMutation({ mutationFn: () => api.put(`/projects/${id}/follow`, { follow: !p?.following }), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: () => api.del(`/projects/${id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: fail,
  });
  const edit = can("projects.edit");
  // a phase timer running in this project: closing the folder asks what to do with the time; minimizing keeps everything running
  const { data: runs = [] } = useQuery({ queryKey: [...KEY, "timers"], queryFn: () => api.get<{ taskId: string; startedAt: string; title: string; projectId: string; kind?: "phase" }[]>("/projects/timers"), refetchInterval: 30_000 });
  const running = runs.filter((x) => x.kind === "phase" && x.projectId === id);
  const [closing, setClosing] = useState(false);
  const requestClose = () => (running.length ? setClosing(true) : onClose());
  const minimize = () => {
    if (p) ws.minimizeProject({ projectId: id, number: p.number, name: p.name });
    onClose();
  };
  // "enter the time" opens that phase with its time window
  const enterTime = (milestoneId: string) => {
    setClosing(false);
    setSearch((q) => {
      q.set("tab", "milestones");
      q.set("milestone", milestoneId);
      q.set("time", milestoneId);
      return q;
    }, { replace: true });
  };
  const discardAll = useMutation({
    mutationFn: () => Promise.all(running.map((x) => api.post(`/projects/${id}/milestones/${x.taskId}/timer/stop`, { discard: true }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, "timers"] });
      onClose();
    },
    onError: fail,
  });
  const counts: Record<TabKey, number | null> = { overview: null, milestones: p?.milestones.length ?? null, time: p?.time.entries.length ?? null, charges: null, notes: p?.notes.length ?? null };

  return (
    <Dialog open onOpenChange={(o) => !o && requestClose()}>
      <DialogContent showCloseButton={false} className="flex h-[min(96dvh,64rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(97vw,92rem)]">
        {/* the folder's header */}
        <header className="flex items-start gap-3 border-b bg-gradient-to-b from-[color:var(--gold)]/[0.07] to-transparent px-5 pb-0 pt-4">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
            <FolderOpen className="size-6 fill-[color:var(--gold)]/25" />
          </span>
          <div className="min-w-0 flex-1 pb-3">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <span className="font-mono text-xs font-normal text-muted-foreground">{p?.number}</span>
              <span className="truncate">{p?.name ?? t("projects.loading")}</span>
            </DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {p && (
                <>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[p.status])}>{t(`projects.status.${p.status}`)}</span>
                  {p.client && <span>{p.client.name}</span>}
                  {p.lead && <span>· {t("projects.ledBy", { name: p.lead.name })}</span>}
                  {p.attention.map((a) => (
                    <span key={a} className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">
                      {t(`projects.attention.${a}`)}
                    </span>
                  ))}
                </>
              )}
            </DialogDescription>
          </div>
          {p && (
            <button type="button" onClick={() => follow.mutate()} aria-label={p.following ? t("projects.unfollow") : t("projects.follow")} title={p.following ? t("projects.unfollow") : t("projects.follow")} className={cn("rounded-md p-2 hover:bg-foreground/[0.06]", p.following ? "text-amber-300" : "text-muted-foreground")}>
              <Star className={cn("size-5", p.following && "fill-current")} />
            </button>
          )}
          <button type="button" onClick={minimize} aria-label={t("projects.minimize")} title={t("projects.minimize")} className="rounded-md p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <Minus className="size-5" />
          </button>
          <button type="button" onClick={requestClose} aria-label={t("common.close")} className="rounded-md p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <X className="size-5" />
          </button>
        </header>
        {closing && (
          <Dialog open onOpenChange={(o) => !o && setClosing(false)}>
            <DialogContent className="sm:max-w-md">
              <DialogTitle className="flex items-center gap-2">
                <Clock className="size-5 text-emerald-300" /> {t("projects.phase.projectCloseTitle")}
              </DialogTitle>
              <DialogDescription>{t("projects.phase.closeText")}</DialogDescription>
              <ul className="space-y-1.5">
                {running.map((x) => (
                  <li key={x.taskId} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                    <Flag className="size-4 shrink-0 text-violet-300" />
                    <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    <Button size="sm" className="h-8 bg-sky-500 text-white hover:bg-sky-400" onClick={() => enterTime(x.taskId)}>
                      {t("projects.phase.enterNow")}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="grid gap-2">
                <Button variant="outline" className="justify-start gap-2" onClick={() => (setClosing(false), onClose())}>
                  <Minus className="size-4" /> {t("projects.phase.later")}
                </Button>
                <Button variant="ghost" className="justify-start gap-2 text-muted-foreground hover:text-destructive" disabled={discardAll.isPending} onClick={() => discardAll.mutate()}>
                  <Trash2 className="size-4" /> {t("projects.phase.closeNoTime")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
        {/* the folder's tabs */}
        <div className="flex flex-wrap items-end gap-1 border-b px-4 pt-2" role="tablist">
          {TABS.map((x) => {
            const active = x.key === current;
            return (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(x.key)}
                className={cn(
                  "relative -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 px-4 py-2 text-sm font-medium transition-colors",
                  active ? "z-10 border-border bg-background text-foreground" : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-grad-gold" />}
                <x.icon className={cn("size-4", active && "text-primary")} /> {t(`projects.tabs.${x.key}`)}
                {counts[x.key] ? <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px]">{counts[x.key]}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {isLoading && <Loader2 className="mx-auto my-16 size-6 animate-spin text-muted-foreground" />}
          {isError && <p className="py-16 text-center text-sm text-muted-foreground">{t("projects.notFound")}</p>}
          {p && current === "overview" && (
            <Overview
              p={p}
              edit={edit}
              save={(patch) => save.mutate(patch)}
              onTask={onTask}
              onTab={onTab}
              onChanged={refresh}
              fail={fail}
              onDelete={
                can("projects.manage")
                  ? () => void confirm({ title: t("projects.deleteTitle", { number: p.number }), description: t("projects.deleteText") }).then((ok) => ok && remove.mutate())
                  : undefined
              }
            />
          )}
          {p && current === "milestones" && <Milestones p={p} edit={edit} focus={milestone} onChanged={refresh} fail={fail} onTask={onTask} />}
          {p && current === "charges" && <ChargesTab p={p} edit={edit} />}
          {p && current === "time" && <TimeTab p={p} edit={edit} onChanged={refresh} fail={fail} />}
          {p && current === "notes" && <Notes p={p} edit={edit} onChanged={refresh} fail={fail} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Milestones and their tasks ──
function Milestones({ p, edit, focus, onChanged, fail, onTask }: { p: ProjectDetail; edit: boolean; focus: string | null; onChanged: () => void; fail: (e: unknown) => void; onTask: (id: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set(focus ? [focus] : []));
  const [adding, setAdding] = useState(false);
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.post(`/projects/${p.id}/milestones/reorder`, { ids }), onSuccess: onChanged, onError: fail });
  const move = (i: number, d: -1 | 1) => {
    const ids = p.milestones.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder.mutate(ids);
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  // one drag area for the phases AND their tasks: a phase is reordered, a task is moved inside its phase or to another one
  const handlers = useRef(new Map<string, (e: DragEndEvent) => void>());
  const register = useCallback((id: string, fn: (e: DragEndEvent) => void) => {
    handlers.current.set(id, fn);
    return () => void handlers.current.delete(id);
  }, []);
  const [draggingTask, setDraggingTask] = useState(false);
  const crossMove = useMutation({ mutationFn: (v: { id: string; milestoneId: string; groupId: string | null }) => api.patch(`/projects/${p.id}/tasks/${v.id}`, { milestoneId: v.milestoneId, groupId: v.groupId }), onSuccess: onChanged, onError: fail });
  const collide: CollisionDetection = (args) => {
    // a phase goes among the phases; a task: what is under the pointer first (a task row, a group, the phase), else the nearest
    if (args.active.data.current?.type === "phase") return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === "phase") });
    const hit = pointerWithin(args);
    return hit.length ? hit : closestCenter(args);
  };
  const onEnd = (e: DragEndEvent) => {
    setDraggingTask(false);
    if (!e.over || e.active.id === e.over.id) return;
    if (e.active.data.current?.type === "phase") {
      const ids = p.milestones.map((m) => m.id);
      reorder.mutate(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
      return;
    }
    const from = e.active.data.current as { milestoneId?: string } | undefined;
    const to = e.over.data.current as { milestoneId?: string; groupId?: string | null } | undefined;
    if (!from?.milestoneId || !to?.milestoneId) return;
    if (from.milestoneId === to.milestoneId) handlers.current.get(from.milestoneId)?.(e);
    else if (edit) crossMove.mutate({ id: String(e.active.id), milestoneId: to.milestoneId, groupId: to.groupId ?? null });
  };
  const dndValue = useMemo(() => ({ register, dragging: draggingTask }), [register, draggingTask]);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setOpen(open.size ? new Set() : new Set(p.milestones.map((m) => m.id)))}>
          {open.size ? t("projects.collapseAll") : t("projects.expandAll")}
        </Button>
      </div>
      {p.milestones.length === 0 && <p className="rounded-2xl border border-dashed py-10 text-center text-sm text-muted-foreground">{t("projects.noMilestones")}</p>}
      <TaskDndCtx.Provider value={dndValue}>
      <DndContext sensors={sensors} collisionDetection={collide} onDragStart={(e) => setDraggingTask(e.active.data.current?.type === "task")} onDragCancel={() => setDraggingTask(false)} onDragEnd={onEnd}>
      <SortableContext items={p.milestones.map((m) => m.id)} strategy={verticalListSortingStrategy}>
      <ul className="space-y-2">
        {p.milestones.map((m, i) => (
          <MilestoneRow key={m.id} p={p} m={m} edit={edit} isOpen={open.has(m.id)} onToggle={() => toggle(m.id)} onChanged={onChanged} fail={fail} onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < p.milestones.length - 1 ? () => move(i, 1) : undefined} focus={focus === m.id} onTask={onTask} last={i === p.milestones.length - 1} />
        ))}
      </ul>
      </SortableContext>
      </DndContext>
      </TaskDndCtx.Provider>
      {edit && (
        <Button variant="outline" className="w-full border-dashed" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> {t("projects.newPhase")}
        </Button>
      )}
      {adding && <PhaseDialog projectId={p.id} project={{ startDate: p.startDate, dueDate: p.dueDate }} onClose={() => setAdding(false)} onCreated={() => (setAdding(false), onChanged())} />}
    </div>
  );
}

function MilestoneRow({ p, m, edit, isOpen, onToggle, onChanged, fail, onUp, onDown, focus, onTask, last }: { p: ProjectDetail; m: Milestone; edit: boolean; isOpen: boolean; onToggle: () => void; onChanged: () => void; fail: (e: unknown) => void; onUp?: () => void; onDown?: () => void; focus: boolean; onTask: (id: string | null) => void; last: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const ref = useRef<HTMLLIElement | null>(null);
  const sortable = useSortable({ id: m.id, disabled: !edit, data: { type: "phase", milestoneId: m.id, groupId: null } });
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center" });
  }, [focus]);
  const can = useCan();
  const patch = useMutation({ mutationFn: (v: Record<string, unknown>) => api.patch(`/projects/${p.id}/milestones/${m.id}`, v), onSuccess: onChanged, onError: fail });
  // a done milestone goes to Accounting › Approbation (Jalons) when it is sent; it can be taken back until approved
  const sendApproval = useMutation({
    mutationFn: (send: boolean) => (send ? api.post(`/projects/${p.id}/milestones/${m.id}/send-approval`, {}) : api.del(`/projects/${p.id}/milestones/${m.id}/send-approval`)),
    onSuccess: (_r, send) => {
      toast.success(t(send ? "projects.sentToApproval" : "projects.approvalWithdrawn"));
      onChanged();
    },
    onError: fail,
  });
  const del = useMutation({ mutationFn: () => api.del(`/projects/${p.id}/milestones/${m.id}`), onSuccess: onChanged, onError: fail });
  const [task, setTask] = useState("");
  const addTask = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/milestones/${m.id}/tasks`, { title: task.trim() }), onSuccess: () => (setTask(""), onChanged()), onError: fail });
  const tone = dueTone(m.dueDate, m.status === "done");
  const pct = m.tasksTotal ? Math.round((m.tasksDone / m.tasksTotal) * 100) : m.status === "done" ? 100 : 0;
  return (
    <li
      ref={(el) => {
        ref.current = el;
        sortable.setNodeRef(el);
      }}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={cn("relative pl-12", sortable.isDragging && "z-10 opacity-80")}
    >
      {/* the line of the project, and this milestone's flag on it */}
      {!last && <span className="absolute bottom-[-0.5rem] left-[1.15rem] top-9 w-px bg-border" aria-hidden />}
      <span
        className={cn("absolute left-0 top-2 flex size-10 items-center justify-center rounded-xl border-2 bg-background", m.status === "done" ? "border-emerald-500/60" : m.status === "doing" ? "border-[color:var(--gold)]/60" : "border-border", m.late && "border-red-500/70")}
        title={t(`projects.ms.${m.status}`)}
      >
        <Flag className={cn("size-[18px]", m.late ? "text-red-400" : MS_TONE[m.status], m.status === "done" && "fill-emerald-400/30")} />
      </span>
      <div className={cn("rounded-2xl border bg-card/40 transition-colors", focus && "border-[color:var(--gold)]/50", m.status === "done" && "border-emerald-500/20")}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          {edit && (
            <button type="button" aria-label={t("projects.sort.drag")} title={t("projects.sort.dragPhase")} className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing" {...sortable.attributes} {...sortable.listeners}>
              <GripVertical className="size-4" />
            </button>
          )}
          <button type="button" onClick={onToggle} aria-expanded={isOpen} aria-label={isOpen ? t("projects.collapse") : t("projects.expand")} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("size-4 transition-transform", !isOpen && "-rotate-90")} />
          </button>
          <div className="min-w-40 flex-1">
            <Text value={m.name} onSave={(v) => v && patch.mutate({ name: v })} maxLength={200} aria-label={t("projects.f.name")} className={cn("h-8 border-transparent bg-transparent px-2 font-semibold hover:border-border focus:border-border", !edit && "pointer-events-none")} />
          </div>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full border px-2 py-0.5 font-medium", m.status === "done" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : m.status === "doing" ? "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary" : "border-border")}>{t(`projects.ms.${m.status}`)}</span>
            <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-foreground/10 sm:block">
              <span className={cn("block h-full rounded-full", m.status === "done" ? "bg-emerald-400" : "bg-grad-gold")} style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono">{m.tasksTotal > 0 ? `${m.tasksDone}/${m.tasksTotal}` : "—"}</span>
            <span className="hidden font-mono sm:inline">
              {hoursText(m.hours)}
              {m.budgetHours != null && ` / ${hoursText(m.budgetHours)}`}
            </span>
          </span>
          <Input type="date" disabled={!edit} value={m.dueDate ?? ""} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} className={cn("h-8 w-36", TONE_TEXT[tone])} aria-label={t("projects.f.due")} />
          {edit && (
            <span className="flex items-center">
              <button type="button" disabled={!onUp} onClick={onUp} aria-label={t("projects.up")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                <ArrowUp className="size-3.5" />
              </button>
              <button type="button" disabled={!onDown} onClick={onDown} aria-label={t("projects.down")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={() => void confirm({ title: t("projects.removeMilestoneTitle", { name: m.name }), description: t("projects.removeMilestoneText") }).then((ok) => ok && del.mutate())}
                className="rounded p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          )}
        </div>
        {isOpen && (
          <div className="space-y-3 border-t px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem]">
              <Text multiline value={m.notes} onSave={(v) => patch.mutate({ notes: v })} placeholder={t("projects.milestoneNotes")} maxLength={8000} className={cn("min-h-16", !edit && "pointer-events-none")} />
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.f.start")}</Label>
                <Input type="date" disabled={!edit} value={m.startDate ?? ""} max={m.dueDate ?? undefined} onChange={(e) => patch.mutate({ startDate: e.target.value || null })} className="h-8" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.f.budget")}</Label>
                <Text
                  value={m.budgetHours == null ? "" : String(m.budgetHours)}
                  onSave={(v) => {
                    const n = Number(v.replace(",", "."));
                    if (!v) patch.mutate({ budgetHours: null });
                    else if (Number.isFinite(n) && n >= 0) patch.mutate({ budgetHours: n });
                  }}
                  aria-label={t("projects.f.budget")}
                  className={cn("h-8", !edit && "pointer-events-none")}
                />
              </div>
            </div>
            {/* the tasks: each opens in its own window, like a ticket; sorted as the technician chose (checkpoint by default) */}
            <div>
              <MilestoneTasks projectId={p.id} m={m} onTask={onTask} edit={edit} onChanged={onChanged} fail={fail} />
              {edit && (
                <form
                  className="mt-2 flex items-center gap-2"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (task.trim()) addTask.mutate();
                  }}
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <input value={task} onChange={(e) => setTask(e.target.value)} placeholder={t("projects.addTask")} maxLength={200} className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
                </form>
              )}
            </div>
            {/* the phase works like a ticket: its timer, its activity and the box to answer or enter time */}
            <PhasePanel p={p} m={m} edit={edit} onChanged={onChanged} fail={fail} onCollapse={onToggle} />
            {/* a milestone with no task is reached by hand; with tasks it is reached when they are done */}
            {edit && m.tasksTotal === 0 && (
              <Button variant="outline" size="sm" onClick={() => patch.mutate({ status: m.status === "done" ? "todo" : "done" })}>
                <Flag className="size-3.5" /> {m.status === "done" ? t("projects.reopenMilestone") : t("projects.markReached")}
              </Button>
            )}
            {m.tasksTotal > 0 && <p className="text-xs text-muted-foreground">{t("projects.followsTasks")}</p>}
            {edit && can("accounting.manage") && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                {m.sentToApprovalAt ? (
                  <>
                    <span className="flex items-center gap-1 text-xs text-emerald-300"><Flag className="size-3.5" /> {t("projects.sentToApprovalOn", { date: shortDate(m.sentToApprovalAt) })}</span>
                    <Button variant="ghost" size="sm" disabled={sendApproval.isPending} onClick={() => sendApproval.mutate(false)}>
                      {t("projects.withdrawApproval")}
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" disabled={m.status !== "done" || sendApproval.isPending} onClick={() => sendApproval.mutate(true)} title={m.status !== "done" ? t("projects.sendApprovalNeedsDone") : undefined}>
                    <Flag className="size-3.5" /> {t("projects.sendToApproval")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ── Time ──
/** Change an entry of time: day, hours, phase / task and note (billable / included is the chip on the row) */
function EditTimeDialog({ p, entry, tasks, onClose, onChanged, fail }: { p: ProjectDetail; entry: ProjectDetail["time"]["entries"][number]; tasks: { id: string; title: string; milestone: string }[]; onClose: () => void; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ date: entry.date, duration: hm(entry.hours), milestoneId: entry.milestoneId ?? "", taskId: entry.taskId ?? "", note: entry.note ?? "" });
  const hours = parseHm(f.duration);
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${p.id}/time/${entry.id}`, { date: f.date, hours, ...(f.taskId ? { taskId: f.taskId } : { taskId: null, milestoneId: f.milestoneId || null }), note: f.note.trim() || null }),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: fail,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("projects.editTime")}</DialogTitle>
        <DialogDescription className="sr-only">{t("projects.editTime")}</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (hours && hours > 0) save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.date")}</Label>
              <Input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.duration")}</Label>
              <Input value={f.duration} onChange={(e) => setF((s) => ({ ...s, duration: e.target.value }))} placeholder="1:30" aria-invalid={hours == null} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.f.milestone")}</Label>
            <Select value={f.milestoneId || "none"} onValueChange={(v) => setF((s) => ({ ...s, milestoneId: v === "none" ? "" : v, taskId: "" }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("projects.noMilestone")}</SelectItem>
                {p.milestones.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.task")}</Label>
            <Select value={f.taskId || "none"} onValueChange={(v) => setF((s) => ({ ...s, taskId: v === "none" ? "" : v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("projects.noTask")}</SelectItem>
                {tasks.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.milestone} · {k.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.note")}</Label>
            <AiTextarea rows={4} value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} maxLength={2000} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!hours || hours <= 0 || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TimeTab({ p, edit, onChanged, fail }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const closed = p.status === "done" || p.status === "cancelled";
  const hourly = p.billingMode !== "fixed" && p.billingMode !== "bank";
  const [f, setF] = useState({ date: today(), duration: "", milestoneId: "", taskId: "", note: "", billable: hourly, userId: "" });
  useEffect(() => setF((s) => ({ ...s, billable: hourly })), [hourly]);
  const hours = parseHm(f.duration);
  // a manager gives the time to anyone, and changes whose an entry is
  const manager = can("projects.manage");
  const { data: people = [] } = useProjectPeople();
  const [editing, setEditing] = useState<ProjectDetail["time"]["entries"][number] | null>(null);
  const reassign = useMutation({
    mutationFn: (v: { id: string; userId: string }) => api.patch(`/projects/${p.id}/time/${v.id}`, { userId: v.userId }),
    onSuccess: (_r, v) => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t("timeFor.changed", { name: people.find((x) => x.id === v.userId)?.name ?? "" }));
    },
    onError: fail,
  });
  const tasks = p.milestones.flatMap((m) => (m.tasks ?? []).map((k) => ({ ...k, milestone: m.name })));
  const toggle = useMutation({ mutationFn: (v: { id: string; billable: boolean }) => api.patch(`/projects/${p.id}/time/${v.id}`, { billable: v.billable }), onSuccess: onChanged, onError: fail });
  const add = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/time`, { date: f.date, hours, ...(f.taskId ? { taskId: f.taskId } : { milestoneId: f.milestoneId || null }), note: f.note.trim() || undefined, billable: f.billable, ...(f.userId && f.userId !== me.id ? { userId: f.userId } : {}) }),
    onSuccess: () => {
      setF((s) => ({ ...s, duration: "", note: "" }));
      onChanged();
      toast.success(t("projects.timeAdded"));
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/time/entries/${id}`),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
    },
    onError: fail,
  });
  const total = p.hours;
  const perMilestone = p.milestones.filter((m) => m.hours > 0 || m.budgetHours != null);
  const unfiled = Math.max(0, total - p.milestones.reduce((n, m) => n + m.hours, 0));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card title={t("projects.hoursLogged")}>
          <p className="font-mono text-2xl font-semibold">{hoursText(total)}</p>
          {p.budgetHours != null && <p className={cn("text-xs", total > p.budgetHours ? "text-red-400" : "text-muted-foreground")}>{total > p.budgetHours ? t("projects.over", { time: hoursText(total - p.budgetHours) }) : t("projects.left", { time: hoursText(p.budgetHours - total) })}</p>}
        </Card>
        <Card title={t("projects.byPerson")}>
          <ul className="space-y-1 text-sm">
            {p.time.byPerson.length === 0 && <li className="text-muted-foreground">—</li>}
            {p.time.byPerson.map((x) => (
              <li key={x.userId} className="flex justify-between">
                <span className="truncate">{x.name}</span>
                <span className="font-mono">{hoursText(x.hours)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("projects.byMilestone")}>
          <ul className="space-y-1 text-sm">
            {perMilestone.length === 0 && unfiled === 0 && <li className="text-muted-foreground">—</li>}
            {perMilestone.map((m) => (
              <li key={m.id} className="flex justify-between gap-2">
                <span className="truncate">{m.name}</span>
                <span className={cn("font-mono", m.budgetHours != null && m.hours > m.budgetHours && "text-red-400")}>
                  {hoursText(m.hours)}
                  {m.budgetHours != null && <span className="text-muted-foreground"> / {hoursText(m.budgetHours)}</span>}
                </span>
              </li>
            ))}
            {unfiled > 0 && (
              <li className="flex justify-between text-muted-foreground">
                <span>{t("projects.noMilestone")}</span>
                <span className="font-mono">{hoursText(unfiled)}</span>
              </li>
            )}
          </ul>
        </Card>
      </div>

      {edit && (can("timesheets.use") || manager) && !closed && (
        <Card title={t("projects.addTime")}>
          <form
            className="grid gap-3 sm:grid-cols-[9rem_6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (hours && hours > 0) add.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.date")}</Label>
              <Input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.duration")}</Label>
              <Input value={f.duration} onChange={(e) => setF((s) => ({ ...s, duration: e.target.value }))} placeholder="1:30" inputMode="text" aria-invalid={f.duration !== "" && hours == null} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.f.milestone")}</Label>
              <Select value={f.milestoneId || "none"} onValueChange={(v) => setF((s) => ({ ...s, milestoneId: v === "none" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("projects.noMilestone")}</SelectItem>
                  {p.milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.task")}</Label>
              <Select value={f.taskId || "none"} onValueChange={(v) => setF((s) => ({ ...s, taskId: v === "none" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("projects.noTask")}</SelectItem>
                  {tasks.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.milestone} · {k.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.note")}</Label>
              <AiTextarea rows={4} value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} maxLength={2000} className="min-h-24" />
            </div>
            <div className="flex items-end gap-3">
              {manager && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("timeFor.person")}</Label>
                  <Select value={f.userId || me.id} onValueChange={(v) => setF((s) => ({ ...s, userId: v }))}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {people.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.id === me.id ? t("timeFor.myself") : x.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={f.billable} onCheckedChange={(v) => setF((s) => ({ ...s, billable: v }))} /> {f.billable ? t("projects.billable") : t("projects.included")}
              </label>
              <Button type="submit" disabled={!hours || hours <= 0 || add.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("projects.add")}
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{t("projects.timeHint")}</p>
        </Card>
      )}
      {closed && <p className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("projects.errors.project_closed")}</p>}

      <Card title={t("projects.entries")}>
        {p.time.entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t("projects.noTime")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {p.time.entries.map((e) => (
              <li key={e.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem_auto_auto] items-center gap-3 py-2 text-sm md:grid-cols-[4.5rem_9rem_minmax(0,1fr)_minmax(0,1fr)_4rem_5.5rem_auto]">
                <span className="text-xs text-muted-foreground">{shortDate(e.date)}</span>
                {manager && !e.ticket ? (
                  <Select value={e.userId} onValueChange={(v) => v !== e.userId && reassign.mutate({ id: e.id, userId: v })} disabled={reassign.isPending}>
                    <SelectTrigger className="hidden h-7 border-transparent bg-transparent px-1 text-sm md:flex" aria-label={t("timeFor.change")} title={t("timeFor.change")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {people.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="hidden truncate md:block">{e.user}</span>
                )}
                <span className="truncate text-muted-foreground" title={e.ticket ? `${e.ticket.number} · ${e.ticket.title ?? ""}` : undefined}>
                  {e.ticket ? <span className="font-mono text-xs text-primary">{e.ticket.number}</span> : (e.milestone ?? t("projects.noMilestone"))}
                  {e.task && <span className="text-xs"> · {e.task}</span>}
                </span>
                <span className="hidden truncate text-muted-foreground md:block">{e.note}</span>
                <span className="text-right font-mono">{hm(e.hours)}</span>
                <button
                  type="button"
                  disabled={Boolean(e.ticket) || !(e.userId === me.id || can("projects.manage"))}
                  onClick={() => toggle.mutate({ id: e.id, billable: e.billableHours <= 0 })}
                  title={t("projects.toggleBillable")}
                  className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", e.billableHours > 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-slate-500/40 bg-slate-500/10 text-slate-300")}
                >
                  {e.billableHours > 0 ? t("projects.billable") : t("projects.included")}
                </button>
                <span className="flex w-14 items-center">
                  {!e.ticket && (e.userId === me.id || can("projects.manage")) && (
                    <button type="button" aria-label={t("projects.editTime")} title={t("projects.editTime")} onClick={() => setEditing(e)} className="rounded p-1 text-muted-foreground hover:text-primary">
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {!e.ticket && (e.userId === me.id || can("projects.manage")) && (
                    <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(e.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <EditTimeDialog p={p} entry={editing} tasks={tasks} onClose={() => setEditing(null)} onChanged={() => { onChanged(); void qc.invalidateQueries({ queryKey: ["time"] }); }} fail={fail} />}

    </div>
  );
}

// ── Files of the project (what a ticket brought, and what the team adds) ──
function ProjectFiles({ p, edit, fail }: { p: ProjectDetail; edit: boolean; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const { data: files = [], refetch } = useQuery({ queryKey: [...KEY, "files", p.id], queryFn: () => api.get<{ id: string; name: string; size: number; author: string }[]>(`/projects/${p.id}/files`) });
  const add = useMutation({
    mutationFn: async (x: File) => api.post(`/projects/${p.id}/files`, { name: x.name, contentType: x.type || "application/octet-stream", data: await fileToBase64(x) }),
    onSuccess: () => void refetch(),
    onError: fail,
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/projects/${p.id}/files/${id}`), onSuccess: () => void refetch(), onError: fail });
  if (!edit && files.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.files.title")}</h3>
      <FilesBox stored={files.map((f) => ({ id: f.id, name: f.name, size: f.size, by: f.author }))} disabled={!edit} downloadUrl={(id) => `/api/projects/${p.id}/files/${id}`} onRemove={(id) => del.mutate(id)} onAdd={(x) => add.mutate(x)} />
    </section>
  );
}

// ── Notes ──
function Notes({ p, edit, onChanged, fail }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const [text, setText, clearText] = useDraft(`project:${p.id}:note`);
  // colleagues told about the note: the bell, an email with the note, a Teams chat message
  const { data: people = [] } = useProjectPeople();
  const colleagues = people.filter((x) => x.id !== me.id);
  const team = [...new Set([p.lead?.id, ...p.members.map((m) => m.id)].filter((x): x is string => Boolean(x) && x !== me.id))];
  const [tell, setTell] = useState<string[]>([]);
  const [how, setHow] = useState({ bell: true, email: true, chat: false });
  // internal = staff only; public = also the client (client portal › Projets)
  const [isPublic, setIsPublic] = useState(false);
  const add = useMutation({
    mutationFn: () => api.post<{ notified?: number; chatNotReady?: boolean; notifyFailed?: number }>(`/projects/${p.id}/notes`, { text: text.trim(), internal: !isPublic, ...(tell.length ? { notifyUserIds: tell, notifyChannels: how } : {}) }),
    onSuccess: (r) => {
      clearText();
      setTell([]);
      if (r.notified) toast.success(t("projects.noteTell.done", { count: r.notified }));
      if (r.chatNotReady) toast.warning(t("tickets.noteTell.chatNotReady"));
      else if (r.notifyFailed) toast.warning(t("projects.noteTell.failed", { count: r.notifyFailed }));
      onChanged();
    },
    onError: fail,
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/projects/${p.id}/notes/${id}`), onSuccess: onChanged, onError: fail });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {edit && (
        <form
          className="space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projects.notePlaceholder")} maxLength={8000} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-full border text-[11px]" role="group" aria-label={t("projects.noteKind.label")}>
              {([false, true] as const).map((pub) => (
                <button key={String(pub)} type="button" aria-pressed={isPublic === pub} onClick={() => setIsPublic(pub)} className={cn("flex items-center gap-1 px-3 py-1", isPublic === pub ? (pub ? "bg-sky-500/20 text-sky-200" : "bg-violet-500/20 text-violet-200") : "text-muted-foreground hover:text-foreground")}>
                  {pub ? <Globe className="size-3" /> : <Lock className="size-3" />} {t(pub ? "projects.noteKind.public" : "projects.noteKind.internal")}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">{t(isPublic ? "projects.noteKind.publicHint" : "projects.noteKind.internalHint")}</span>
          </div>
          {colleagues.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", tell.length ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
                    <BellRing className="size-3" />
                    {tell.length ? t("tickets.noteTell.count", { count: tell.length }) : t("tickets.noteTell.pick")}
                    <ChevronDown className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  {team.length > 0 && (
                    <button type="button" onClick={() => setTell((x) => [...new Set([...x, ...team])])} className="mb-1 w-full rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-accent">
                      {t("projects.noteTell.team")}
                    </button>
                  )}
                  <ul className="max-h-64 overflow-y-auto">
                    {colleagues.map((x) => {
                      const on = tell.includes(x.id);
                      return (
                        <li key={x.id}>
                          <button type="button" onClick={() => setTell((v) => (on ? v.filter((i) => i !== x.id) : [...v, x.id]))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                            <span className={cn("flex size-4 items-center justify-center rounded border", on ? "border-violet-400 bg-violet-500/30" : "border-muted-foreground/40")}>{on && <Check className="size-3" />}</span>
                            {x.name}
                            {team.includes(x.id) && <span className="ml-auto text-[10px] text-muted-foreground">{t("projects.noteTell.inTeam")}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {tell.length > 0 && (
                    <button type="button" onClick={() => setTell([])} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
                      {t("tickets.noteTell.clear")}
                    </button>
                  )}
                </PopoverContent>
              </Popover>
              {tell.length > 0 && (
                <div className="flex items-center gap-1" role="group" aria-label={t("tickets.noteTell.how")}>
                  {([["bell", BellRing, "tickets.noteTell.bell"], ["email", Mail, "tickets.noteTell.email"], ["chat", MessagesSquare, "tickets.noteTell.chat"]] as const).map(([k, Icon, label]) => (
                    <button key={k} type="button" aria-pressed={how[k]} onClick={() => setHow((h) => ({ ...h, [k]: !h[k] }))} className={cn("flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]", how[k] ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
                      <Icon className="size-3" /> {t(label)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!text.trim() || add.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              <FileText className="size-4" /> {t("projects.addNote")}
            </Button>
          </div>
        </form>
      )}
      <ProjectFiles p={p} edit={edit} fail={fail} />
      {p.notes.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t("projects.noNotes")}</p>}
      <ul className="space-y-3">
        {p.notes.map((n) => (
          <li key={n.id} className="rounded-2xl border bg-card/40 p-4">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{n.author ?? "—"}</span>
              <span>{shortDateTime(n.createdAt)}</span>
              {n.fromClient ? (
                <span className="rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-px text-[10px] font-medium text-primary">{t("projects.noteKind.fromClient")}</span>
              ) : n.internal ? (
                <span className="flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 py-px text-[10px] font-medium text-violet-200">
                  <Lock className="size-2.5" /> {t("projects.noteKind.internal")}
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-px text-[10px] font-medium text-sky-200">
                  <Globe className="size-2.5" /> {t("projects.noteKind.public")}
                </span>
              )}
              {(n.authorId === me.id || can("projects.manage")) && (
                <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(n.id)} className="ml-auto rounded p-1 hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm">{n.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
