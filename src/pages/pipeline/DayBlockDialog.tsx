import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, ListTodo, Loader2, Ticket, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NewTicketDialog } from "@/pages/tickets/NewTicketDialog";
import type { TicketList } from "@/pages/tickets/shared";
import { todayYmd } from "./shared";
import { useMe } from "@/lib/session";
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
  const me = useMe();
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
  // turned into a task or a ticket of today's plan: same start, same length; the block itself goes
  const [ticketOpen, setTicketOpen] = useState(false);
  const canConvert = Boolean(v.id) && date === todayYmd();
  const facets = useQuery({ queryKey: ["tickets", "view=mine"], queryFn: () => api.get<TicketList>("/tickets?view=mine"), enabled: ticketOpen, staleTime: 60_000 });
  const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const place = async (key: string, addPath: string) => {
    const who = forUser ? { userId: forUser } : {};
    await api.put(addPath, { ...who });
    await api.put("/pipeline/day/start", { key, minute: mins(v.start), ...who });
    await api.put("/pipeline/day/alloc", { key, minutes: Math.max(15, Math.min(480, mins(v.end) - mins(v.start))), ...who });
    await api.del(`/pipeline/day/blocks/${v.id}`);
  };
  const toTask = useMutation({
    mutationFn: async () => {
      const t = await api.post<{ id: string }>("/pipeline/tasks", { title: v.title.trim(), notes: v.note.trim(), estimateMinutes: Math.max(15, mins(v.end) - mins(v.start)), checkpointDate: date, checkpointTime: v.start, assigneeId: forUser ?? me.id });
      await place(`task:${t.id}`, `/pipeline/day/tasks/${t.id}`);
    },
    onSuccess: () => {
      toast.success(t("pipeline.day.block.taskMade"));
      done();
    },
    onError: fail,
  });
  const ticketMade = async (id: number) => {
    try {
      await place(`ticket:${id}`, `/pipeline/day/tickets/${id}`);
      toast.success(t("pipeline.day.block.ticketMade"));
      done();
    } catch {
      fail();
    }
  };
  const remove = useMutation({ mutationFn: () => api.del(`/pipeline/day/blocks/${v.id}`), onSuccess: done, onError: fail });
  const valid = v.title.trim().length > 0 && v.start && v.end && v.end > v.start;
  if (ticketOpen && facets.data) return <NewTicketDialog open onOpenChange={(o) => !o && setTicketOpen(false)} facets={facets.data.facets} initial={{ title: v.title.trim(), description: v.note.trim() }} onCreated={(id) => void ticketMade(id)} />;
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
        {canConvert && (
          <div className="space-y-1.5 rounded-lg border border-dashed p-2.5">
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" className="flex-1 gap-1.5" disabled={!valid || toTask.isPending || save.isPending} onClick={() => toTask.mutate()}>
                {toTask.isPending ? <Loader2 className="size-4 animate-spin" /> : <ListTodo className="size-4 text-violet-300" />} {t("pipeline.day.block.toTask")}
              </Button>
              <Button type="button" variant="outline" size="sm" className="flex-1 gap-1.5" disabled={!valid || save.isPending} onClick={() => setTicketOpen(true)}>
                <Ticket className="size-4 text-primary" /> {t("pipeline.day.block.toTicket")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("pipeline.day.block.convertHint")}</p>
          </div>
        )}
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
