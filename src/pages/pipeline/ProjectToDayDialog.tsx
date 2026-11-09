import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { KEY, type ProjectDetail } from "@/pages/projects/shared";

type Scope = "project" | "milestone" | "task";

/**
 * "Ajouter à ma journée" for a project: the whole project (every open task of it), one phase (milestone) or one task.
 * Each open task goes on today's plan by the usual route; nothing changes on the project itself.
 */
export function ProjectToDayDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: p, isLoading } = useQuery({ queryKey: [...KEY, "detail", projectId], queryFn: () => api.get<ProjectDetail>(`/projects/${projectId}`) });
  const phases = useMemo(() => (p?.milestones ?? []).map((m) => ({ id: m.id, name: m.name, tasks: (m.tasks ?? []).filter((x) => !x.done && x.status !== "done") })), [p]);
  const [scope, setScope] = useState<Scope>("project");
  const [phase, setPhase] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const all = phases.flatMap((m) => m.tasks.map((x) => ({ ...x, phase: m.name })));
  const phaseId = phase || phases.find((m) => m.tasks.length)?.id || "";
  const chosen = scope === "project" ? all : scope === "milestone" ? (phases.find((m) => m.id === phaseId)?.tasks ?? []) : all.filter((x) => x.id === (task || all[0]?.id));
  const add = async () => {
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const x of chosen) {
      try {
        await api.put(`/pipeline/day/ptasks/${x.id}`, { time: null });
        ok++;
      } catch (e) {
        failed++;
        if (e instanceof ApiError && e.code === "project_closed") break;
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
    if (ok) toast.success(t("pipeline.day.projectToDay.added", { count: ok }));
    if (failed) toast.error(t("pipeline.day.projectToDay.failed", { count: failed }));
    if (ok) onClose();
  };
  const opt = (v: Scope, label: string, n: number) => (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-[color:var(--gold)]/60 has-[:checked]:bg-[color:var(--gold)]/[0.06]">
      <input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} className="accent-[color:var(--gold)]" />
      <span className="flex-1">{label}</span>
      <span className="text-xs text-muted-foreground">{t("pipeline.day.projectToDay.tasks", { count: n })}</span>
    </label>
  );
  const select = "h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="size-5 text-primary" /> {t("tickets.addDay.title")}
          </DialogTitle>
          <DialogDescription>{p ? `${p.number} · ${p.name}` : ""}</DialogDescription>
        </DialogHeader>
        {isLoading || !p ? (
          <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
        ) : all.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pipeline.day.projectToDay.none")}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("pipeline.day.projectToDay.text")}</p>
            <div className="space-y-2">
              {opt("project", t("pipeline.day.projectToDay.whole"), all.length)}
              {opt("milestone", t("pipeline.day.projectToDay.phase"), phases.find((m) => m.id === phaseId)?.tasks.length ?? 0)}
              {scope === "milestone" && (
                <select value={phaseId} onChange={(e) => setPhase(e.target.value)} className={select}>
                  {phases
                    .filter((m) => m.tasks.length)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.tasks.length})
                      </option>
                    ))}
                </select>
              )}
              {opt("task", t("pipeline.day.projectToDay.one"), 1)}
              {scope === "task" && (
                <select value={task || all[0]?.id} onChange={(e) => setTask(e.target.value)} className={select}>
                  {all.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.phase} — {x.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={busy || chosen.length === 0} onClick={() => void add()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />} {t("pipeline.day.projectToDay.add", { count: chosen.length })}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
