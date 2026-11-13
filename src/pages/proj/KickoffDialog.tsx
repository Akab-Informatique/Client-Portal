import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AiTextarea } from "@/components/AiPolish";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { projError } from "./ProjComposer";
import { useProject, type ProjDetail } from "./shared";

const fieldCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40";
const labelText = "block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/**
 * The pop-up that follows a new project (by hand, from a quote or from a ticket): the lead and the team (kept when already
 * set), a short description and notes. They become the project's first internal note and the lead is told by email and bell.
 */
export function KickoffDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useProject(id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="glass max-h-[92vh] w-[min(40rem,calc(100vw-1.5rem))] max-w-none gap-0 overflow-hidden rounded-2xl border border-t-4 border-violet-500/40 border-t-violet-500 p-0">
        {project.data ? <Form project={project.data} onClose={onClose} /> : <Skeleton className="m-5 h-64" />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ project, onClose }: { project: ProjDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const people = usePeople();
  const [leadId, setLeadId] = useState(project.lead?.id ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(project.members.map((m) => m.id).filter((m) => m !== project.lead?.id));
  const [description, setDescription] = useState(project.description ?? "");
  const [notes, setNotes] = useState("");
  const personName = (pid: string) => (people.data ?? []).find((p) => p.id === pid)?.name ?? pid;
  const candidates = (people.data ?? []).filter((p) => p.id !== leadId && !memberIds.includes(p.id));

  const save = useMutation({
    mutationFn: () => api.post<{ emailed: boolean }>(`/proj/${project.id}/kickoff`, { leadId: leadId || null, memberIds, description: description.trim(), notes: notes.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["proj"] });
      toast.success(t("proj.kickoff.done"));
      onClose();
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-5 py-4">
        <DialogTitle className="text-base font-semibold text-violet-200">
          {t("proj.kickoff.title")} · {project.number}
        </DialogTitle>
        <DialogDescription className="sr-only">{t("proj.kickoff.intro")}</DialogDescription>
        <Button type="button" variant="ghost" size="icon" aria-label={t("proj.close")} onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <form
        className="max-h-[calc(92vh-4.5rem)] space-y-4 overflow-y-auto px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) save.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground">{t("proj.kickoff.intro")}</p>
        <p className="text-sm font-medium">{project.name}</p>
        <label className="block space-y-1">
          <span className={labelText}>{t("proj.kickoff.lead")}</span>
          <select className={fieldCls} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="" />
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1">
          <span className={labelText}>{t("proj.kickoff.team")}</span>
          <div className="flex flex-wrap gap-1.5">
            {memberIds.map((m) => (
              <span key={m} className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 py-0.5 pl-2.5 pr-1 text-xs text-violet-200">
                {personName(m)}
                <button type="button" aria-label={t("proj.team.remove", { name: personName(m) })} onClick={() => setMemberIds((ids) => ids.filter((x) => x !== m))} className="grid size-4 place-items-center rounded-full hover:bg-white/10">
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            <select
              className={cn("h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-violet-500/40")}
              value=""
              aria-label={t("proj.newProj.teamAdd")}
              onChange={(e) => e.target.value && setMemberIds((ids) => [...ids, e.target.value])}
            >
              <option value="">{t("proj.newProj.teamAdd")}</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="block space-y-1">
          <span className={labelText}>{t("proj.kickoff.description")}</span>
          <AiTextarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </label>
        <label className="block space-y-1">
          <span className={labelText}>{t("proj.kickoff.notes")}</span>
          <AiTextarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={8000} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("proj.kickoff.skip")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("proj.kickoff.save")}
          </Button>
        </div>
      </form>
    </>
  );
}
