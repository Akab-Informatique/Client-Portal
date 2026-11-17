import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, CheckCircle2, Clock, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Block } from "./shared";

/** Ticks of a block of the day: "Terminé" asks for the final time, "Continuer" greys the item for the day and asks what to update. */
export type FinishAsk = { mode: "done" | "continue"; block: Block };

export function DayFinishDialog({ ask, forUser, onClose, onOpen }: { ask: FinishAsk | null; forUser?: string; onClose: () => void; onOpen: (b: Block) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const b = ask?.block;
  // a to-do task can be finished at once, with no time (it has no ticket-like time entry requirement)
  const quick = useMutation({
    mutationFn: () => api.patch(`/pipeline/tasks/${b!.refId}`, { status: "done" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!ask || !b) return null;
  void forUser;
  const open = () => {
    onClose();
    onOpen(b);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {ask.mode === "done" ? <CheckCircle2 className="size-5 text-emerald-400" /> : <Clock className="size-5 text-primary" />}
            {t(ask.mode === "done" ? "pipeline.day.finish.doneTitle" : "pipeline.day.finish.contTitle", { title: b.title })}
          </DialogTitle>
          <DialogDescription>{t(ask.mode === "done" ? "pipeline.day.finish.doneText" : "pipeline.day.finish.contText")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          {ask.mode === "done" ? (
            <>
              {b.kind === "task" && (
                <Button variant="outline" disabled={quick.isPending} onClick={() => quick.mutate()}>
                  {quick.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("pipeline.day.finish.finishNoTime")}
                </Button>
              )}
              <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" onClick={open}>
                <Clock className="size-4" /> {t("pipeline.day.finish.enterTime")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("pipeline.day.finish.later")}
              </Button>
              <Button variant="outline" onClick={open}>
                <Pencil className="size-4" /> {t("pipeline.day.finish.update")}
              </Button>
              <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" onClick={open}>
                <Clock className="size-4" /> {t("pipeline.day.finish.addTime")}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
