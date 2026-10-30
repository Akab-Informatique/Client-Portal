import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { hm, parseHm } from "./shared";

export type TimeNote = { id: string; text: string; internalText?: string; hours?: number; billable?: boolean; offsetHours?: number; billedHours?: number };

/**
 * Change a time entry of a ticket: its hours, what is billed (it can be more than the hours worked), its note. Its technician can
 * until their week is submitted and the time is approved for invoicing; the same entry on their timesheet follows.
 */
export function EditTimeDialog({ ticketId, note, onClose }: { ticketId: number; note: TimeNote; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const worked = note.hours ?? 0;
  const billedNow = note.billable === false ? 0 : (note.billedHours ?? Math.max(0, worked - (note.offsetHours ?? 0)));
  const [hours, setHours] = useState(hm(worked));
  const [billable, setBillable] = useState(note.billable !== false);
  const [billed, setBilled] = useState(hm(billedNow));
  const [summary, setSummary] = useState(note.text);
  const [internal, setInternal] = useState(note.internalText ?? "");
  const h = parseHm(hours);
  const b = parseHm(billed);
  const valid = h !== null && h > 0 && h <= 24 && (!billable || (b !== null && b >= 0 && b <= 100)) && summary.trim().length > 0;
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/tickets/${ticketId}/time/${note.id.replace(/^t-/, "")}`, {
        hours: h,
        billable,
        ...(billable ? { billedHours: b } : {}),
        summary,
        internal,
      }),
    onSuccess: () => {
      toast.success(t("common.saved"));
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["time"] });
      onClose();
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      toast.error(code === "timesheet_locked" ? t("timesheet.locked") : code === "entry_billed" ? t("timesheet.entryBilled") : t("common.error"));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-5 text-primary" /> {t("tickets.timer.editEntry")}
          </DialogTitle>
          <DialogDescription>{t("tickets.timer.editEntryHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="et-hours">{t("timesheet.hours")}</Label>
              <Input id="et-hours" inputMode="numeric" className="font-mono" value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="et-billed">{t("tickets.timer.billedField")}</Label>
              <Input id="et-billed" inputMode="numeric" className="font-mono" disabled={!billable} value={billable ? billed : "0:00"} onChange={(e) => setBilled(e.target.value)} />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={billable} onCheckedChange={(v) => setBillable(v === true)} /> {t("tickets.timer.billable")}
          </label>
          <Textarea value={summary} rows={3} onChange={(e) => setSummary(e.target.value)} placeholder={t("tickets.timer.summary")} />
          <Textarea value={internal} rows={2} onChange={(e) => setInternal(e.target.value)} placeholder={t("tickets.timer.internal")} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
