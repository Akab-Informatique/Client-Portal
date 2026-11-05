import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { apiMessage } from "./shared";

/** A new phase (milestone) of the project: its name, what it is, its days, its hours — and the first tasks, one per line. */
export function PhaseDialog({ projectId, project, onClose, onCreated }: { projectId: string; project: { startDate: string | null; dueDate: string | null }; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: "", notes: "", startDate: "", dueDate: "", hours: "", tasks: "" });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const hours = f.hours.trim() ? Number(f.hours.replace(",", ".")) : null;
  const valid = f.name.trim().length > 0 && (hours === null || (Number.isFinite(hours) && hours >= 0)) && !(f.startDate && f.dueDate && f.dueDate < f.startDate);
  const create = useMutation({
    mutationFn: async () => {
      const made = await api.post<{ id: string }>(`/projects/${projectId}/milestones`, { name: f.name.trim(), notes: f.notes.trim(), startDate: f.startDate || null, dueDate: f.dueDate || null, budgetHours: hours });
      for (const title of f.tasks.split("\n").map((l) => l.trim()).filter(Boolean)) await api.post(`/projects/${projectId}/milestones/${made.id}/tasks`, { title });
      return made;
    },
    onSuccess: () => {
      toast.success(t("projects.phaseCreated"));
      onCreated();
    },
    onError: (e) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="size-5 text-primary" /> {t("projects.newPhase")}
          </DialogTitle>
          <DialogDescription>{t("projects.newPhaseText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ph-name">{t("projects.f.name")}</Label>
            <Input id="ph-name" autoFocus maxLength={200} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={t("projects.phaseNamePlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ph-notes">{t("projects.f.description")}</Label>
            <Textarea id="ph-notes" rows={3} value={f.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={8000} placeholder={t("projects.milestoneNotes")} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ph-start">{t("projects.f.start")}</Label>
              <Input id="ph-start" type="date" value={f.startDate} min={project.startDate ?? undefined} max={project.dueDate ?? undefined} onChange={(e) => set("startDate")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ph-due">{t("projects.f.due")}</Label>
              <Input id="ph-due" type="date" value={f.dueDate} min={f.startDate || project.startDate || undefined} max={project.dueDate ?? undefined} onChange={(e) => set("dueDate")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ph-hours">{t("projects.f.budget")}</Label>
              <Input id="ph-hours" inputMode="decimal" value={f.hours} onChange={(e) => set("hours")(e.target.value)} placeholder="16" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ph-tasks">{t("projects.firstTasks")}</Label>
            <Textarea id="ph-tasks" rows={4} value={f.tasks} onChange={(e) => set("tasks")(e.target.value)} placeholder={t("projects.firstTasksPlaceholder")} />
            <p className="text-xs text-muted-foreground">{t("projects.firstTasksHint")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("projects.createPhase")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
