import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import type { Person } from "@/pages/pipeline/shared";
import { ticketErrorText } from "./shared";

export type DayTicketState = { added: boolean; dueTime: string | null };
export type DayKind = "ticket" | "task" | "ptask";

const qs = (userId?: string) => (userId ? `?userId=${userId}` : "");

/** Whether the ticket (or task) is on someone's day today, and with which time (nothing on the ticket itself). */
export function useDayTicket(id: number | string, enabled = true, kind: DayKind = "ticket", userId?: string) {
  return useQuery({ queryKey: ["pipeline", "dayTicket", kind, id, userId ?? "me"], queryFn: () => api.get<DayTicketState>(`/pipeline/day/${kind}s/${id}${qs(userId)}`), enabled, staleTime: 15_000 });
}

/**
 * "Ajouter à ma journée": the ticket (or Pipeline task) goes to today's work blocks, with a time to do it before.
 * The due date and the checkpoint are not touched; it leaves the day when the day ends.
 * An administrator (pipeline.manage) can pick another person's day.
 */
export function AddToDayDialog({
  open,
  onOpenChange,
  tk,
  kind = "ticket",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tk: { id: number | string; number?: string; title: string };
  kind?: DayKind;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const manager = can("pipeline.manage");
  const people = useQuery({ queryKey: ["pipeline", "people"], queryFn: () => api.get<Person[]>("/pipeline/people"), staleTime: 60_000, enabled: open && manager });
  const [who, setWho] = useState(me.id);
  const target = who === me.id ? undefined : who;
  const state = useDayTicket(tk.id, open, kind, target);
  const [time, setTime] = useState("");
  useEffect(() => {
    if (open && state.data) setTime(state.data.dueTime ?? "");
  }, [open, state.data]);
  const label = tk.number ?? tk.title;
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
    toast.success(msg);
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: () => api.put(`/pipeline/day/${kind}s/${tk.id}`, { time: time || null, ...(target ? { userId: target } : {}) }),
    onSuccess: () => done(t(target ? "tickets.addDay.addedFor" : "tickets.addDay.added", { number: label, name: people.data?.find((p) => p.id === who)?.name ?? "" })),
    onError: (e) => toast.error(e instanceof ApiError && (e.code === "ticket_complete" || e.code === "task_done" || e.code === "project_closed") ? t("tickets.addDay.complete") : ticketErrorText(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/pipeline/day/${kind}s/${tk.id}${qs(target)}`),
    onSuccess: () => done(t("tickets.addDay.removed", { number: label })),
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
            {tk.number && <span className="font-mono text-primary">{tk.number} · </span>}
            {tk.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("tickets.addDay.text")}</p>
        {manager && (
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("tickets.addDay.forWho")}
            <select value={who} onChange={(e) => setWho(e.target.value)} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
              <option value={me.id}>{t("tickets.addDay.me", { name: me.name })}</option>
              {(people.data ?? [])
                .filter((p) => p.id !== me.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
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
