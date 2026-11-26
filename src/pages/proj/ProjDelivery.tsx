import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { BellRing, PackageCheck, Settings2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { NotifyDialog } from "@/pages/tickets/NotifyTech";
import { api, ApiError } from "@/lib/api";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { useCan } from "@/lib/session";
import { projError } from "./ProjComposer";
import type { ProjDetail } from "./shared";

const KNOWN = ["project_not_sold", "project_no_client", "project_delivered", "already_delivered", "not_delivered", "no_recipient", "project_closed"];
function err(t: (k: string, o?: Record<string, unknown>) => string, e: unknown) {
  if (e instanceof ApiError && KNOWN.includes(e.code)) return t(e.code === "project_closed" || e.code === "project_not_sold" || e.code === "project_no_client" ?`projWork.errors.${e.code}` : `projDeliver.errors.${e.code}`);
  return t("projWork.error");
}

const APPROVALS_LINK = "/accounting/approvals?tab=project";

/** What billing the hours sold comes to, written out ("= 12 h × 115 $ = 1 380 $") */
function soldPreview(t: (k: string, o?: Record<string, unknown>) => string, project: ProjDetail, hours: number): string | null {
  if (!(hours > 0)) return null;
  const money = (n: number) => new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD" }).format(n);
  const mode = project.billing.mode;
  if ((mode === "fixed" || mode === "bank") && project.billing.fixedPrice) return t("projDeliver.sold.fixed", { price: money(project.billing.fixedPrice) });
  const rate = project.billing.previewRate;
  if (!rate || rate <= 0) return t("projDeliver.sold.noRate");
  return t("projDeliver.sold.preview", { hours: hours.toLocaleString("fr-CA"), rate: money(rate), total: money(Math.round(hours * rate * 100) / 100) });
}

const parseHours = (v: string) => Number(v.replace(",", "."));

function SoldHoursField({ project, value, onChange }: { project: ProjDetail; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const preview = soldPreview(t, project, parseHours(value));
  return (
    <label className="block space-y-1 text-left">
      <span className="text-sm font-medium">{t("projDeliver.sold.label")}</span>
      <Input type="number" inputMode="decimal" min={0} max={100000} step={0.25} required value={value} onChange={(e) => onChange(e.target.value)} />
      {preview && <span className="block text-xs text-muted-foreground">{preview}</span>}
    </label>
  );
}

/** In a toast (drawn outside the router) a <Link> crashes the page: there it is a button calling `go`. */
function ApprovalsLink({ go }: { go?: () => void }) {
  const { t } = useTranslation();
  if (go)
    return (
      <button type="button" onClick={go} className="underline underline-offset-2">
        {t("projDeliver.deliver.seeApproval")}
      </button>
    );
  return (
    <Link to={APPROVALS_LINK} className="underline underline-offset-2">
      {t("projDeliver.deliver.seeApproval")}
    </Link>
  );
}

/** Setting a project to "Terminé": it goes to Approbation like a delivery, so it needs hours sold (asked here when it has none) */
export function useFinishProject(project: ProjDetail) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [ask, setAsk] = useState(false);
  const [hours, setHours] = useState("");
  const needHours = !((project.soldHours ?? 0) > 0) && !project.billing.prepaid;
  const mutation = useMutation({
    mutationFn: (soldHours?: number) => api.patch<{ billing?: { status: string } }>(`/proj/${project.id}`, soldHours != null ? { status: "done", soldHours } : { status: "done" }),
    onSuccess: (r) => {
      setAsk(false);
      toast.success(t("projDeliver.done.done"));
      if (r.billing) {
        toast.info(
          <span>
            {t(`projDeliver.deliver.billing.${r.billing.status}`)} {(r.billing.status === "created" || r.billing.status === "already") && <ApprovalsLink go={() => navigate(APPROVALS_LINK)} />}
          </span>,
        );
      }
      void qc.invalidateQueries({ queryKey: ["billables"] });
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(err(t, e)),
  });
  const finish = () => (needHours ? setAsk(true) : mutation.mutate(undefined));
  const dialog = ask ? (
    <Dialog open onOpenChange={(o) => !o && setAsk(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("projDeliver.done.title")}</DialogTitle>
          <DialogDescription>{t("projDeliver.done.text")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-amber-200">{t("projDeliver.sold.needed")}</p>
        <SoldHoursField project={project} value={hours} onChange={setHours} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAsk(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={mutation.isPending || !(parseHours(hours) > 0)} onClick={() => mutation.mutate(parseHours(hours))}>
            {t("projDeliver.done.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  ) : null;
  return { finish, dialog, pending: mutation.isPending };
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
  const navigate = useNavigate();
  const confirm = useConfirm();
  const delivered = project.status === "delivered";
  const [ask, setAsk] = useState(false);
  const [hours, setHours] = useState("");
  const needHours = !((project.soldHours ?? 0) > 0) && !project.billing.prepaid;
  const done =() => void qc.invalidateQueries({ queryKey: ["proj"] });
  const deliver = useMutation({
    mutationFn: (soldHours?: number) => api.post<{ notified: number; billing?: { status: string } }>(`/proj/${project.id}/deliver`, soldHours != null ? { soldHours } : {}),
    onSuccess: (r) => {
      setAsk(false);
      toast.success(r.notified ? t("projDeliver.deliver.done", { count: r.notified }) : t("projDeliver.deliver.doneNobody"));
      if (r.billing) {
        toast.info(
          <span>
            {t(`projDeliver.deliver.billing.${r.billing.status}`)} {(r.billing.status === "created" || r.billing.status === "already") && <ApprovalsLink go={() => navigate(APPROVALS_LINK)} />}
          </span>,
        );
      }
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
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="border-teal-400/50 text-teal-200 hover:bg-teal-500/10"
        disabled={deliver.isPending}
        onClick={async () => {
          if (needHours) return setAsk(true);
          if (await confirm({ title: t("projDeliver.deliver.title"), description: t("projDeliver.deliver.text"), confirmLabel: t("projDeliver.deliver.confirm") })) deliver.mutate(undefined);
        }}
      >
        <PackageCheck className="size-4" aria-hidden /> {t("projDeliver.deliver.button")}
      </Button>
      {ask && (
        <Dialog open onOpenChange={(o) => !o && setAsk(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("projDeliver.deliver.title")}</DialogTitle>
              <DialogDescription>{t("projDeliver.deliver.text")}</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-amber-200">{t("projDeliver.sold.needed")}</p>
            <SoldHoursField project={project} value={hours} onChange={setHours} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsk(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={deliver.isPending || !(parseHours(hours) > 0)} onClick={() => deliver.mutate(parseHours(hours))}>
                {t("projDeliver.deliver.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** Actions of the teal banner of a delivered project: send it to approval (accounting.manage), close it as billed (proj.manage) */
export function DeliveredActions({ project }: { project: ProjDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const can = useCan();
  const [hours, setHours] = useState(project.soldHours ? String(project.soldHours) : "");
  const bill = useMutation({
    mutationFn: () => api.post(`/proj/${project.id}/bill`, parseHours(hours) > 0 ? { soldHours: parseHours(hours) } : {}),
    onSuccess: () => {
      toast.success(
        <span>
          {t("projDeliver.deliver.sentApproval")} <ApprovalsLink go={() => navigate(APPROVALS_LINK)} />
        </span>,
      );
      void qc.invalidateQueries({ queryKey: ["proj"] });
      void qc.invalidateQueries({ queryKey: ["billables"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });
  const close = useFinishProject(project);
  const noLine = project.billing.status === "none" && !project.billing.billedAt;
  const showBill = can("accounting.manage") && noLine;
  const where = project.billing.status !== "none" ? t(`projDeliver.deliver.where.${project.billing.status}`, { number: project.billing.invoiceNumber ?? "" }) : null;
  if (!showBill && !project.canManage && !where) return null;
  return (
    <span className="ml-auto flex flex-wrap items-center gap-2">
      {where && (
        <span className="text-xs">
          {where} · <ApprovalsLink />
        </span>
      )}
      {showBill && !project.billing.prepaid && (
        <span className="w-56">
          <SoldHoursField project={project} value={hours} onChange={setHours} />
        </span>
      )}
      {showBill && (
        <Button type="button" size="sm" variant="outline" disabled={bill.isPending || (!(parseHours(hours) > 0) && !((project.soldHours ?? 0) > 0))} onClick={() => bill.mutate()}>
          {t("projDeliver.deliver.sendApproval")}
        </Button>
      )}
      {project.canManage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={close.pending}
          onClick={async () => {
            if (await confirm({ title: t("projDeliver.deliver.closeTitle"), description: t("projDeliver.deliver.closeText"), confirmLabel: t("projDeliver.deliver.closeBilled") })) close.finish();
          }}
        >
          {t("projDeliver.deliver.closeBilled")}
        </Button>
      )}
      {close.dialog}
    </span>
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
