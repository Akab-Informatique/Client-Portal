import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const KINDS = ["vacation", "sick", "training", "personal", "other"] as const;
type Kind = (typeof KINDS)[number];
export type AbsenceDraft = { id?: string; userId: string; startDate: string; endDate: string; kind: Kind; note: string };

const KIND_DOT: Record<Kind, string> = { vacation: "bg-sky-400", sick: "bg-red-400", training: "bg-violet-400", personal: "bg-amber-400", other: "bg-slate-400" };

/** The absence form (used from the weekly meeting calendar). */
export function AbsenceDialog({ draft, onClose }: { draft: AbsenceDraft; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [d, setD] = useState(draft);
  const team = useQuery({ queryKey: ["meetings", "team"], queryFn: () => api.get<{ id: string; name: string }[]>("/meetings/team"), staleTime: 5 * 60_000 });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["meetings", "absences"] });
    void qc.invalidateQueries({ queryKey: ["meetings", "week"] });
    onClose();
  };
  const onError = (e: unknown) => toast.error(e instanceof ApiError && e.fields?.some((f) => f.message === "end_before_start") ? t("meetings.absences.endBeforeStart") : t("common.error"));
  const save = useMutation({
    mutationFn: () => {
      const payload = { userId: d.userId, startDate: d.startDate, endDate: d.endDate, kind: d.kind, note: d.note };
      return d.id ? api.put(`/meetings/absences/${d.id}`, payload) : api.post("/meetings/absences", payload);
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/meetings/absences/${d.id}`), onSuccess: done, onError });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.userId && d.startDate && d.endDate) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(d.id ? "meetings.absences.editTitle" : "meetings.absences.addTitle")}</DialogTitle>
          <DialogDescription>{t("meetings.absences.dialogText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("meetings.absences.person")}</Label>
            <Select value={d.userId} onValueChange={(userId) => setD({ ...d, userId })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("meetings.absences.choosePerson")} />
              </SelectTrigger>
              <SelectContent>
                {(team.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="abs-from">{t("meetings.absences.from")}</Label>
              <Input id="abs-from" type="date" required value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value, endDate: d.endDate < e.target.value ? e.target.value : d.endDate })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="abs-to">{t("meetings.absences.to")}</Label>
              <Input id="abs-to" type="date" required min={d.startDate} value={d.endDate} onChange={(e) => setD({ ...d, endDate: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("meetings.absences.type")}</Label>
            <Select value={d.kind} onValueChange={(kind) => setD({ ...d, kind: kind as Kind })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className={cn("size-2 rounded-full", KIND_DOT[k])} /> {t(`meetings.absences.kind.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="abs-note">{t("meetings.absences.note")}</Label>
            <Input id="abs-note" maxLength={300} placeholder={t("meetings.absences.notePlaceholder")} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </div>
          <div className="flex items-center gap-2 pt-2">
            {d.id && (
              <Button
                type="button"
                variant="ghost"
                className="text-red-400"
                onClick={() => void confirm({ title: t("meetings.absences.deleteConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!d.userId || save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
