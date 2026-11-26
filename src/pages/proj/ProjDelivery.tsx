import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, PackageCheck, Settings2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { NotifyDialog } from "@/pages/tickets/NotifyTech";
import { api, ApiError } from "@/lib/api";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import type { ProjDetail } from "./shared";

const KNOWN = ["project_delivered", "already_delivered", "not_delivered", "no_recipient", "project_closed"];
function err(t: (k: string, o?: Record<string, unknown>) => string, e: unknown) {
  if (e instanceof ApiError && KNOWN.includes(e.code)) return t(e.code === "project_closed" ? "projWork.errors.project_closed" : `projDeliver.errors.${e.code}`);
  return t("projWork.error");
}

/** Bell button of the project header: tell colleagues about this project (like a ticket's) */
export function ProjNotifyButton({ project }: { project: ProjDetail }) {
  const { t } = useTranslation();
  const people = usePeople();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="icon" aria-label={t("tickets.notifyTech.button")} title={t("tickets.notifyTech.button")} onClick={() => setOpen(true)}>
        <BellRing className="size-4" aria-hidden />
      </Button>
      {open && <NotifyDialog endpoint={`/proj/${project.id}/notify-tech`} subject={`${project.number} · ${project.name}`} people={people.data ?? []} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Marquer comme livré" (proj.edit) on an open project; "Remettre en cours" (proj.manage) on a delivered one */
export function DeliverButton({ project, canEdit }: { project: ProjDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const delivered = project.status === "delivered";
  const done = () => void qc.invalidateQueries({ queryKey: ["proj"] });
  const deliver = useMutation({
    mutationFn: () => api.post<{ notified: number; billing?: { status: string } }>(`/proj/${project.id}/deliver`, {}),
    onSuccess: (r) => {
      toast.success(r.notified ? t("projDeliver.deliver.done", { count: r.notified }) : t("projDeliver.deliver.doneNobody"));
      if (r.billing) toast.info(t(`projDeliver.deliver.billing.${r.billing.status}`));
      void qc.invalidateQueries({ queryKey: ["billables"] });
      done();
    },
    onError: (e) => toast.error(err(t, e)),
  });
  const undo = useMutation({
    mutationFn: () => api.post(`/proj/${project.id}/undeliver`, {}),
    onSuccess: () => {
      toast.success(t("projDeliver.deliver.undone"));
      done();
    },
    onError: (e) => toast.error(err(t, e)),
  });
  if (project.status === "done" || project.status === "cancelled") return null;
  if (delivered) {
    if (!project.canManage) return null;
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={undo.isPending}
        onClick={async () => {
          if (await confirm({ title: t("projDeliver.deliver.undoTitle"), description: t("projDeliver.deliver.undoText"), confirmLabel: t("projDeliver.deliver.undo") })) undo.mutate();
        }}
      >
        <Undo2 className="size-4" aria-hidden /> {t("projDeliver.deliver.undo")}
      </Button>
    );
  }
  if (!canEdit) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="border-teal-400/50 text-teal-200 hover:bg-teal-500/10"
      disabled={deliver.isPending}
      onClick={async () => {
        if (await confirm({ title: t("projDeliver.deliver.title"), description: t("projDeliver.deliver.text"), confirmLabel: t("projDeliver.deliver.confirm") })) deliver.mutate();
      }}
    >
      <PackageCheck className="size-4" aria-hidden /> {t("projDeliver.deliver.button")}
    </Button>
  );
}

type Reviewers = { userIds: string[]; effective: { id: string; name: string }[] };

/** Who is told when a project is delivered (proj.manage): a small picker, none picked = the master administrators */
export function DeliveryReviewersButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="icon" aria-label={t("projDeliver.reviewers.button")} title={t("projDeliver.reviewers.button")} onClick={() => setOpen(true)}>
        <Settings2 className="size-4" aria-hidden />
      </Button>
      {open && <ReviewersDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ReviewersDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const people = usePeople();
  const cur = useQuery({ queryKey: ["proj", "delivery-reviewers"], queryFn: () => api.get<Reviewers>("/proj/delivery-reviewers") });
  const [picked, setPicked] = useState<string[] | null>(null);
  const value = picked ?? cur.data?.userIds ?? [];
  const save = useMutation({
    mutationFn: () => api.put<Reviewers>("/proj/delivery-reviewers", { userIds: value }),
    onSuccess: () => {
      toast.success(t("projDeliver.reviewers.saved"));
      void qc.invalidateQueries({ queryKey: ["proj", "delivery-reviewers"] });
      onClose();
    },
    onError: (e) => toast.error(err(t, e)),
  });
  const names = (cur.data?.effective ?? []).map((x) => x.name).join(", ") || t("projDeliver.reviewers.none");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("projDeliver.reviewers.title")}</DialogTitle>
          <DialogDescription>{t("projDeliver.reviewers.hint")}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-xl border">
          {(people.data ?? []).map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                <Checkbox checked={value.includes(p.id)} onCheckedChange={() => setPicked(value.includes(p.id) ? value.filter((x) => x !== p.id) : [...value, p.id])} />
                {p.name}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("projDeliver.reviewers.defaultNow", { names })}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t("projDeliver.reviewers.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
