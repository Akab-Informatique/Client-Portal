import { useDraft } from "@/lib/useDraft";
import { type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, Check, Flag, FolderKanban, Loader2, MessageSquare, Send, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { shortDate, shortDateTime } from "@/pages/tickets/shared";
import { PageHeader, Pane } from "./ui";

type Card = { id: string; number: string; name: string; status: string; startDate: string | null; dueDate: string | null; lead: string | null; milestones: { done: number; total: number } };
type Detail = {
  id: string;
  number: string;
  name: string;
  description: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  lead: string | null;
  milestones: { id: string; name: string; status: string; dueDate: string | null }[];
  notes: { id: string; text: string; createdAt: string; author: string | null; fromClient: boolean }[];
};

const STATUS_STYLE: Record<string, string> = {
  planning: "border-sky-400/40 bg-sky-500/10 text-sky-200",
  active: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  on_hold: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  done: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
};

/** Client portal › Projets: the projects run for the company, their progress and the public notes (a note can be written back). */
export function ClientProjectsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const open = params.get("project");
  const { data = [], isLoading } = useQuery({ queryKey: ["client-projects"], queryFn: () => api.get<Card[]>("/portal/projects") });
  return (
    <div className="space-y-5">
      <PageHeader icon={FolderKanban} title={t("clientProjects.title")} subtitle={t("clientProjects.subtitle")} />
      {isLoading && <Skeleton className="h-24 w-full rounded-2xl" />}
      {!isLoading && data.length === 0 && <Pane className="p-10 text-center text-sm text-muted-foreground">{t("clientProjects.none")}</Pane>}
      <ul className="space-y-3">
        {data.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => setParams({ project: p.id })} className="pane block w-full rounded-2xl p-4 text-left transition-colors hover:bg-accent/40">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{p.number}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[p.status])}>{t(`clientProjects.status.${p.status}`)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {p.milestones.total > 0 && (
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((p.milestones.done / p.milestones.total) * 100)}%` }} />
                    </span>
                    {t("clientProjects.progress", { done: p.milestones.done, total: p.milestones.total })}
                  </span>
                )}
                {p.dueDate && (
                  <span className="flex items-center gap-1">
                    <CalendarDays className="size-3" /> {t("clientProjects.due", { date: shortDate(p.dueDate) })}
                  </span>
                )}
                {p.lead && (
                  <span className="flex items-center gap-1">
                    <UserRound className="size-3" /> {p.lead}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open && <ProjectWindow id={open} onClose={() => setParams({})} />}
    </div>
  );
}

function ProjectWindow({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const key = ["client-projects", id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/portal/projects/${id}`) });
  const [text, setText, clearText] = useDraft(`portal-project:${id}:note`);
  const add = useMutation({
    mutationFn: () => api.post(`/portal/projects/${id}/notes`, { text: text.trim() }),
    onSuccess: () => {
      clearText();
      toast.success(t("clientProjects.noteSent"));
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {data && <span className="font-mono text-sm text-muted-foreground">{data.number}</span>} {data?.name ?? "…"}
          </DialogTitle>
          <DialogDescription>{data ? [t(`clientProjects.status.${data.status}`), data.dueDate && t("clientProjects.due", { date: shortDate(data.dueDate) }), data.lead].filter(Boolean).join(" · ") : ""}</DialogDescription>
        </DialogHeader>
        {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
        {data && (
          <div className="space-y-5">
            {data.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.description}</p>}
            {data.milestones.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("clientProjects.milestones")}</h3>
                <ul className="divide-y divide-border/50 rounded-xl border">
                  {data.milestones.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      {m.status === "done" ? <Check className="size-4 text-emerald-300" /> : <Flag className={cn("size-4", m.status === "doing" ? "text-primary" : "text-muted-foreground")} />}
                      <span className={cn("min-w-0 flex-1 truncate", m.status === "done" && "text-muted-foreground line-through")}>{m.name}</span>
                      {m.dueDate && <span className="text-xs text-muted-foreground">{shortDate(m.dueDate)}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <MessageSquare className="size-3.5" /> {t("clientProjects.notes")}
              </h3>
              {can("clientProjects.comment") && (
                <form
                  className="space-y-2"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (text.trim()) add.mutate();
                  }}
                >
                  <Textarea rows={3} value={text} maxLength={6000} onChange={(e) => setText(e.target.value)} placeholder={t("clientProjects.notePlaceholder")} />
                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={!text.trim() || add.isPending}>
                      {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("clientProjects.send")}
                    </Button>
                  </div>
                </form>
              )}
              {data.notes.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{t("clientProjects.noNotes")}</p>}
              <ul className="space-y-2">
                {data.notes.map((n) => (
                  <li key={n.id} className={cn("rounded-xl border p-3", n.fromClient ? "border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.05]" : "bg-card/40")}>
                    <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{n.author ?? "—"}</span>
                      <span>{shortDateTime(n.createdAt)}</span>
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{n.text}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
