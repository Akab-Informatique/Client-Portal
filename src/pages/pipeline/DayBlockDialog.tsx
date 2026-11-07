import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export type DayBlockDraft = { id?: string; start: string; end: string; title: string; note: string };

/**
 * A slot of time blocked by hand in the day (local work, an errand, a meeting that is not on the calendar): a title, from
 * and to (quarter hours). It takes its hours off what can be planned and shows in its own color in the blocks of the day.
 */
export function DayBlockDialog({ draft, date, forUser, onClose, onSaved }: { draft: DayBlockDraft; date: string; forUser?: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(draft);
  const done = () => {
    onSaved();
    onClose();
  };
  const fail = () => toast.error(t("pipeline.day.block.failed"));
  const save = useMutation({
    mutationFn: () => {
      const body = { start: v.start, end: v.end, title: v.title.trim(), note: v.note.trim() };
      return v.id ? api.patch(`/pipeline/day/blocks/${v.id}`, body) : api.post("/pipeline/day/blocks", { ...body, date, ...(forUser ? { userId: forUser } : {}) });
    },
    onSuccess: done,
    onError: fail,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/pipeline/day/blocks/${v.id}`), onSuccess: done, onError: fail });
  const valid = v.title.trim().length > 0 && v.start && v.end && v.end > v.start;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5 text-pink-300" /> {t(v.id ? "pipeline.day.block.edit" : "pipeline.day.block.title")}
          </DialogTitle>
          <DialogDescription>{t("pipeline.day.block.hint")}</DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("pipeline.day.block.name")}
          <Input autoFocus value={v.title} maxLength={120} placeholder={t("pipeline.day.block.placeholder")} onChange={(e) => setV({ ...v, title: e.target.value })} className="text-foreground" />
        </label>
        <div className="flex gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("pipeline.day.block.start")}
            <Input type="time" step={900} value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} className="w-32 text-foreground" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("pipeline.day.block.end")}
            <Input type="time" step={900} value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} className="w-32 text-foreground" />
          </label>
        </div>
        {v.end <= v.start && <p className="text-xs text-orange-300">{t("pipeline.day.block.order")}</p>}
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("pipeline.day.block.note")}
          <Textarea value={v.note} maxLength={500} rows={2} onChange={(e) => setV({ ...v, note: e.target.value })} className="text-foreground" />
        </label>
        <div className="flex gap-2">
          <Button className="flex-1 bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || save.isPending || remove.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("pipeline.day.block.save")}
          </Button>
          {v.id && (
            <Button variant="outline" disabled={save.isPending || remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {t("pipeline.day.block.delete")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
