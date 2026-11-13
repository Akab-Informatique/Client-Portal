import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock, Check, StickyNote, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Note = { id: string; kind: "note" | "reminder"; title: string; body: string; remindAt: string | null; notified: boolean; done: boolean; updatedAt: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** A local date-time field value for "in an hour" */
const inAnHour = () => {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
};

/** The notes and quick reminders of the To do panel: private to the person, a reminder rings the bell once at its time. */
export function PersonalNotes() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const key = ["my-notes"];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Note[]>("/my-notes"), refetchInterval: 60_000 });
  const [text, setText] = useState("");
  const [remind, setRemind] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "note_empty" ? t("pipeline.notes.empty") : t("common.error"));
  const add = useMutation({
    mutationFn: () => api.post("/my-notes", { kind: remind ? "reminder" : "note", body: text.trim(), remindAt: remind ? new Date(remind).toISOString() : null }),
    onSuccess: () => {
      setText("");
      setRemind(null);
      refresh();
    },
    onError: fail,
  });
  const save = useMutation({ mutationFn: (v: { id: string; patch: Record<string, unknown> }) => api.patch(`/my-notes/${v.id}`, v.patch), onSuccess: refresh, onError: fail });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/my-notes/${id}`), onSuccess: refresh, onError: fail });
  const editable = can("pipeline.view");
  const now = Date.now();
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("pipeline.notes.hint")}</p>
      {editable && (
        <form
          className="glass space-y-2 rounded-2xl border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Textarea rows={3} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder={t("pipeline.notes.placeholder")} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setRemind(remind ? null : inAnHour())} className={cn("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium", remind ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <AlarmClock className="size-3.5" /> {t("pipeline.notes.remind")}
            </button>
            {remind && <input type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value || null)} className="h-8 rounded-md border bg-transparent px-2 text-xs" aria-label={t("pipeline.notes.remindAt")} />}
            <button type="submit" disabled={!text.trim() || add.isPending} className="ml-auto h-8 rounded-md bg-grad-gold px-4 text-sm font-semibold text-[#1a1204] disabled:opacity-50">
              {t("pipeline.add")}
            </button>
          </div>
        </form>
      )}
      {isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : !data?.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("pipeline.notes.none")}</p>
      ) : (
        <ul className="space-y-2">
          {data.map((n) => {
            const late = n.kind === "reminder" && !n.done && n.remindAt && new Date(n.remindAt).getTime() <= now;
            return (
              <li key={n.id} className={cn("group rounded-xl border p-3", late ? "border-red-400/40 bg-red-500/[0.06]" : "bg-card/40", n.done && "opacity-60")}>
                <div className="flex items-start gap-2">
                  {n.kind === "reminder" ? (
                    <button type="button" onClick={() => save.mutate({ id: n.id, patch: { done: !n.done } })} aria-label={t("pipeline.notes.done")} title={t("pipeline.notes.done")} className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border", n.done ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-300" : "text-muted-foreground hover:text-foreground")}>
                      {n.done && <Check className="size-3.5" />}
                    </button>
                  ) : (
                    <StickyNote className="mt-0.5 size-4 shrink-0 text-violet-300" />
                  )}
                  <div className="min-w-0 flex-1">
                    {editing?.id === n.id ? (
                      <Textarea
                        autoFocus
                        rows={3}
                        value={editing.body}
                        maxLength={4000}
                        onChange={(e) => setEditing({ id: n.id, body: e.target.value })}
                        onBlur={() => {
                          if (editing.body.trim() && editing.body !== n.body) save.mutate({ id: n.id, patch: { body: editing.body } });
                          setEditing(null);
                        }}
                      />
                    ) : (
                      <button type="button" onClick={() => setEditing({ id: n.id, body: n.body })} className={cn("block w-full whitespace-pre-wrap break-words text-left text-sm", n.done && "line-through")}>
                        {n.body || n.title}
                      </button>
                    )}
                    {n.kind === "reminder" && n.remindAt && (
                      <span className={cn("mt-1 flex items-center gap-1 text-[11px]", late ? "text-red-300" : "text-muted-foreground")}>
                        <AlarmClock className="size-3" /> {when(n.remindAt)}
                      </span>
                    )}
                  </div>
                  <button type="button" onClick={() => del.mutate(n.id)} aria-label={t("pipeline.notes.delete")} title={t("pipeline.notes.delete")} className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
