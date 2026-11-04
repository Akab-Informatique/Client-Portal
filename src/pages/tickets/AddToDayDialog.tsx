import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { ticketErrorText } from "./shared";

export type DayTicketState = { added: boolean; dueTime: string | null };

/** Whether the ticket is on my day today, and with which time (nothing on the ticket itself). */
export function useDayTicket(id: number, enabled = true) {
  return useQuery({ queryKey: ["pipeline", "dayTicket", id], queryFn: () => api.get<DayTicketState>(`/pipeline/day/tickets/${id}`), enabled, staleTime: 15_000 });
}

/**
 * "Ajouter à ma journée": the ticket goes to today's work blocks, with a time to do it before.
 * The due date and the checkpoint are not touched; the ticket leaves the day when the day ends.
 */
export function AddToDayDialog({ open, onOpenChange, tk }: { open: boolean; onOpenChange: (o: boolean) => void; tk: { id: number; number: string; title: string } }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const state = useDayTicket(tk.id, open);
  const [time, setTime] = useState("");
  useEffect(() => {
    if (open && state.data) setTime(state.data.dueTime ?? "");
  }, [open, state.data]);
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
    toast.success(msg);
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: () => api.put(`/pipeline/day/tickets/${tk.id}`, { time: time || null }),
    onSuccess: () => done(t("tickets.addDay.added", { number: tk.number })),
    onError: (e) => toast.error(e instanceof ApiError && e.code === "ticket_complete" ? t("tickets.addDay.complete") : ticketErrorText(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/pipeline/day/tickets/${tk.id}`),
    onSuccess: () => done(t("tickets.addDay.removed", { number: tk.number })),
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const already = state.data?.added ?? false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="size-5 text-primary" /> {t("tickets.addDay.title")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("tickets.addDay.text")}</p>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("tickets.addDay.time")}
          <div className="flex items-center gap-2">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
            {time && (
              <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => setTime("")}>
                {t("tickets.addDay.noTime")}
              </button>
            )}
          </div>
        </label>
        <div className="flex gap-2">
          <Button className="flex-1 bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={save.isPending || remove.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />} {already ? t("tickets.addDay.update") : t("tickets.addDay.add")}
          </Button>
          {already && (
            <Button variant="outline" disabled={save.isPending || remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {t("tickets.addDay.remove")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
