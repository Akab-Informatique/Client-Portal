import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, Plus, Receipt, Trash2, Users, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { PickEntryDialog } from "./PickEntryDialog";
import { ProjTaskDialog } from "./ProjTaskDialog";
import { ProjInfoDialog } from "./ProjInfoDialog";
import { ProjComposer } from "./ProjComposer";
import { ProjNotes } from "./ProjNotes";
import { ProjCalendar } from "./ProjCalendar";
import { ProjSide } from "./ProjSide";
import { ProjGauge } from "./ProjGauge";
import { ProjTasks, projError, initials } from "./ProjTasks";
import { useProject, type ProjDetail, type ProjStatus, type ProjTask } from "./shared";

const STATUSES: ProjStatus[] = ["planning", "active", "done", "cancelled"];
const inputCls = "h-9 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60";
const tileCls = "glass flex min-w-[9rem] items-center gap-3 rounded-2xl border border-violet-500/25 px-3 py-2 text-left transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/** Project name, edited in place: saved on blur or Enter, put back on Escape */
function InlineName({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setText(value), [value]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setText(value);
      return;
    }
    const v = text.trim();
    if (!v) {
      setText(value);
      return;
    }
    if (v !== value) onSave(v);
  };

  return (
    <input
      aria-label={t("proj.name")}
      title={disabled ? undefined : t("proj.nameHint")}
      value={text}
      disabled={disabled}
      maxLength={200}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="-mx-2 w-full rounded-md bg-transparent px-2 py-1 text-2xl font-semibold outline-none hover:bg-white/5 focus:bg-white/5 focus:ring-2 focus:ring-violet-500/40 disabled:opacity-100"
    />
  );
}

/** The team: lead, members, add or remove people (memberIds), change the lead */
function TeamTile({ project, canEdit, onSave }: { project: ProjDetail; canEdit: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const people = usePeople();
  const [pick, setPick] = useState("");
  const members = project.members.filter((m) => m.id !== project.lead?.id);
  const count = new Set([...(project.lead ? [project.lead.id] : []), ...members.map((m) => m.id)]).size;
  const candidates = (people.data ?? []).filter((p) => p.id !== project.lead?.id && !members.some((m) => m.id === p.id));

  const addMember = (id: string) => {
    if (!id) return;
    onSave({ memberIds: [...members.map((m) => m.id), id] });
    setPick("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={tileCls} aria-label={t("proj.team.title")}>
          <Users className="size-5 shrink-0 text-violet-300" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.tile.team")}</span>
            <span className="block text-sm">{t("proj.tile.teamCount", { count })}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <div className="text-sm font-semibold">{t("proj.team.title")}</div>
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.team.lead")}</div>
          {canEdit ? (
            <select className={cn(inputCls, "w-full")} value={project.lead?.id ?? ""} onChange={(e) => onSave({ leadId: e.target.value || null })} aria-label={t("proj.team.lead")}>
              <option value="">—</option>
              {project.lead && !(people.data ?? []).some((p) => p.id === project.lead?.id) && <option value={project.lead.id}>{project.lead.name}</option>}
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm">{project.lead?.name ?? "—"}</div>
          )}
          <p className="text-[11px] text-muted-foreground">{t("proj.team.leadHint")}</p>
        </div>
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {members.length === 0 && <li className="text-xs text-muted-foreground">{t("proj.team.none")}</li>}
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-white/5">
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200">
                {initials(m.name)}
              </span>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={t("proj.team.remove", { name: m.name })}
                  title={t("proj.team.remove", { name: m.name })}
                  onClick={() => onSave({ memberIds: members.filter((x) => x.id !== m.id).map((x) => x.id) })}
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex items-center gap-2">
            <select className={cn(inputCls, "min-w-0 flex-1")} value={pick} onChange={(e) => addMember(e.target.value)} aria-label={t("proj.team.add")}>
              <option value="">{t("proj.team.pick")}</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The opened project: a near full-screen window (violet, "Projet" tag) with the header tiles,
 * the task list and notes on the left, the calendar and the client card on the right.
 */
export function ProjView({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: d, isLoading, isError } = useProject(id);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [askTask, setAskTask] = useState<ProjTask | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const canEdit = can("proj.edit");

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<ProjDetail>(`/proj/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proj"] }),
    onError: (e) => toast.error(projError(t, e)),
  });

  const remove = useMutation({
    mutationFn: () => api.del<{ deleted: boolean }>(`/proj/${id}`),
    onSuccess: () => {
      toast.success(t("proj.delete.done"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
      onClose();
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const askRemove = async () => {
    if (!d) return;
    const ok = await confirm({ title: t("proj.delete.title"), description: t("proj.delete.text"), confirmLabel: t("common.delete"), destructive: true });
    if (ok) remove.mutate();
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="glass flex h-[min(94vh,1100px)] w-[min(1500px,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-t-4 border-violet-500/40 border-t-violet-500 p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">{d ? `${d.number} · ${d.name}` : t("proj.tag")}</DialogTitle>
          <DialogDescription className="sr-only">{t("proj.tag")}</DialogDescription>

          {isLoading && <div className="p-8 text-sm text-muted-foreground">{t("proj.loading")}</div>}
          {isError && <div className="p-8 text-sm text-red-300">{t("proj.loadError")}</div>}

          {d && (
            <>
              <header className="flex flex-wrap items-start gap-4 border-b border-white/10 p-5">
                <div className="min-w-[16rem] flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-violet-200 tabular-nums">{d.number}</span>
                    <span className="rounded-full border border-violet-500/40 px-2 py-0.5 text-[11px] uppercase tracking-wide text-violet-300">{t("proj.tag")}</span>
                  </div>
                  <InlineName value={d.name} disabled={!canEdit} onSave={(name) => save.mutate({ name })} />
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.status")}</span>
                      <select className={inputCls} value={d.status} disabled={!canEdit} onChange={(e) => save.mutate({ status: e.target.value })}>
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`proj.statusValue.${s}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.due")}</span>
                      <input
                        type="date"
                        className={inputCls}
                        value={d.dueDate ?? ""}
                        disabled={!canEdit}
                        onChange={(e) => save.mutate({ dueDate: e.target.value || null })}
                      />
                    </label>
                  </div>
                </div>

                <div className="flex flex-wrap items-stretch gap-3">
                  <TeamTile project={d} canEdit={canEdit} onSave={(body) => save.mutate(body)} />
                  <ProjGauge worked={d.worked.hours} sold={d.soldHours} canEdit={canEdit} onSaveSold={(hours) => save.mutate({ soldHours: hours })} />
                  <button type="button" className={cn(tileCls, "border-white/10")} disabled aria-disabled="true" aria-label={`${t("proj.tile.charges")}: ${t("proj.tile.soon")}`} title={t("proj.tile.soon")}>
                    <Receipt className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.tile.charges")}</span>
                      <span className="block text-sm text-muted-foreground">{t("proj.tile.soon")}</span>
                    </span>
                  </button>
                  <button type="button" className={tileCls} onClick={() => setInfoOpen(true)}>
                    <Info className="size-5 shrink-0 text-violet-300" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{t("proj.tile.info")}</span>
                      <span className="block text-[11px] text-muted-foreground">{t("proj.tile.infoHint")}</span>
                    </span>
                  </button>
                </div>

                <div className="ml-auto flex items-center gap-1">
                  {d.canManage && (
                    <Button type="button" variant="ghost" size="icon" aria-label={t("proj.delete.button")} title={t("proj.delete.button")} onClick={() => void askRemove()} disabled={remove.isPending}>
                      <Trash2 className="size-4 text-red-300" aria-hidden />
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("proj.close")} title={t("proj.close")} onClick={onClose}>
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <div className="grid gap-5 lg:grid-cols-3">
                  <div className="min-w-0 space-y-5 lg:col-span-2">
                    <ProjTasks project={d} onOpenTask={(tid) => setTaskId(tid)} onAskDone={(task) => setAskTask(task)} />
                    <ProjComposer project={d} />
                    <ProjNotes project={d} onOpenTask={(tid) => setTaskId(tid)} />
                  </div>
                  <div className="min-w-0 space-y-5">
                    <ProjCalendar project={d} onOpenTask={(tid) => setTaskId(tid)} />
                    <ProjSide project={d} />
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {d && taskId && <ProjTaskDialog project={d} taskId={taskId} onClose={() => setTaskId(null)} />}
      {d && askTask && <PickEntryDialog project={d} task={askTask} onClose={() => setAskTask(null)} />}
      {d && infoOpen && <ProjInfoDialog project={d} onClose={() => setInfoOpen(false)} />}
    </>
  );
}
