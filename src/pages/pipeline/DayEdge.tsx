import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarMinus, CalendarPlus, ExternalLink, X, GitMerge, Star, Trash2, UserCheck, UserRoundPlus, UserX } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AcceptDialog } from "@/pages/tickets/AcceptDialog";
import { AddToDayDialog } from "@/pages/tickets/AddToDayDialog";
import { MergeDialog } from "@/pages/tickets/MergeDialog";
import { ticketErrorText } from "@/pages/tickets/shared";
import { usePeople } from "./TaskDialog";
import { DAY_ROUTE, type DayKind } from "./shared";
import { ProjectToDayDialog } from "./ProjectToDayDialog";

type Kind = DayKind;

/**
 * The small edge button before a ticket / task / project task of Ma journée (the same line as on the left of a row of
 * the Tickets list, with the same menu: accept, assign, open, merge, delete) and, for the day, "add to my day".
 * Everything goes through the usual routes, which check the rights again.
 */
/** Takes an item off today's plan (nothing changes on the ticket, task or project). */
export function useRemoveFromDay(kind: DayKind, id: string, forUser?: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return () =>
    api.del(`/pipeline/day/${DAY_ROUTE[kind]}/${id}${forUser ? `?userId=${forUser}` : ""}`).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["pipeline"] });
        toast.success(t("pipeline.day.removed"));
      },
      (e) => toast.error(ticketErrorText(t, e)),
    );
}

/** A small cross on a block of the day: takes the item off the day */
export function RemoveFromDay({ kind, id, forUser, className }: { kind: DayKind; id: string; forUser?: string; className?: string }) {
  const { t } = useTranslation();
  const remove = useRemoveFromDay(kind, id, forUser);
  return (
    <button type="button" title={t("pipeline.day.remove")} aria-label={t("pipeline.day.remove")} onClick={(e) => (e.stopPropagation(), void remove())} onPointerDown={(e) => e.stopPropagation()} className={cn("flex size-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground hover:bg-red-500/20 hover:text-red-300", className)}>
      <X className="size-3" />
    </button>
  );
}

export function DayEdge({ kind, id, number, title, urgent, onOpen, onDay, className }: { kind: Kind; id: string; number?: string | null; title: string; urgent?: boolean; onOpen: () => void; onDay?: { forUser?: string }; className?: string }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const people = usePeople();
  const [dialog, setDialog] = useState<null | "accept" | "merge" | "day">(null);
  const [detail, setDetail] = useState<any>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const fail = (e: unknown) => toast.error(ticketErrorText(t, e));
  // the ticket in full is read only when an action needs it (accept: its statuses; merge: its company)
  const withDetail = async (next: "accept" | "merge") => {
    try {
      setDetail(await api.get<any>(`/tickets/${id}`));
      setDialog(next);
    } catch (e) {
      fail(e);
    }
  };
  const assign = (assigneeId: string | null) =>
    api.patch(`/tickets/${id}`, { assigneeId }).then(refresh, fail);
  const remove = async () => {
    if (!window.confirm(t("tickets.delete.title", { number: number ?? "" }))) return;
    try {
      await api.del(`/tickets/${id}`);
      refresh();
      toast.success(t("tickets.delete.done", { number: number ?? "" }));
    } catch (e) {
      fail(e);
    }
  };
  const ticket = kind === "ticket";
  const canEdit = ticket && can("tickets.edit");
  const canDay = can("pipeline.edit") && !onDay && (kind === "ticket" || kind === "task" || kind === "ptask");
  const removeFromDay = useRemoveFromDay(kind, id, onDay?.forUser);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t("tickets.rowMenu.title")}
            aria-label={t("tickets.rowMenu.title")}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn("group/line flex w-3.5 shrink-0 items-center justify-start self-stretch outline-none", className)}
          >
            <span
              aria-hidden
              className={cn(
                "block h-[70%] w-[3px] rounded-r-full transition-all duration-200 group-hover/line:h-[88%] group-hover/line:w-[6px] group-data-[state=open]/line:h-[88%] group-data-[state=open]/line:w-[6px]",
                urgent ? "bg-red-400 shadow-[0_0_10px_2px_rgba(248,113,113,0.6)]" : "bg-[color:var(--gold)] shadow-[0_0_10px_2px_rgba(255,206,26,0.45)]",
              )}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="min-w-52" onClick={(e) => e.stopPropagation()}>
          {canEdit && (
            <DropdownMenuItem onSelect={() => void withDetail("accept")}>
              <UserCheck className="size-4 text-primary" /> {t("tickets.rowMenu.accept")}
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserRoundPlus className="size-4" /> {t("tickets.rowMenu.assign")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 min-w-48 overflow-y-auto">
                {(people.data ?? []).map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => void assign(p.id)}>
                    <span className="flex-1 truncate">{p.id === me.id ? t("tickets.rowMenu.assignMe", { name: p.name }) : p.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void assign(null)}>
                  <UserX className="size-4" /> {t("tickets.unassigned")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {canDay && (
            <DropdownMenuItem onSelect={() => setDialog("day")}>
              <CalendarPlus className="size-4 text-primary" /> {t("tickets.rowMenu.addToDay")}
            </DropdownMenuItem>
          )}
          {onDay && can("pipeline.edit") && (
            <DropdownMenuItem onSelect={() => void removeFromDay()}>
              <CalendarMinus className="size-4 text-red-300" /> {t("pipeline.day.remove")}
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem onSelect={() => void withDetail("merge")}>
              <GitMerge className="size-4" /> {t("tickets.merge.button")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onOpen}>
            <ExternalLink className="size-4" /> {t(ticket ? "tickets.rowMenu.open" : "pipeline.day.openItem")}
          </DropdownMenuItem>
          {ticket && can("tickets.delete") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash2 className="size-4" /> {t("tickets.delete.button")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "day" && <AddToDayDialog open onOpenChange={(o) => !o && setDialog(null)} tk={ticket ? { id: Number(id), number: number ?? undefined, title } : { id, title }} kind={kind as "ticket" | "task" | "ptask"} />}
      {dialog === "accept" && detail && <AcceptDialog open onOpenChange={(o) => !o && (setDialog(null), refresh())} tk={detail} statuses={detail.options.statuses} />}
      {dialog === "merge" && detail && <MergeDialog open onOpenChange={(o) => !o && (setDialog(null), refresh())} tk={detail} onDone={refresh} />}
    </>
  );
}

/** The same edge line before a project of the day's list: open it, follow it (the star of the Projects page) or stop following it. */
export function ProjectEdge({ id, following, onOpen, className }: { id: string; following: boolean; onOpen: () => void; className?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const follow = () =>
    api.put(`/projects/${id}/follow`, { follow: !following }).then(
      () => void qc.invalidateQueries({ queryKey: ["projects"] }),
      (e) => toast.error(ticketErrorText(t, e)),
    );
  return (
    <>
    {adding && <ProjectToDayDialog projectId={id} onClose={() => setAdding(false)} />}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={t("pipeline.day.projectMenu")} aria-label={t("pipeline.day.projectMenu")} onClick={(e) => e.stopPropagation()} className={cn("group/line flex w-3.5 shrink-0 items-center justify-start self-stretch outline-none", className)}>
          <span aria-hidden className="block h-[70%] w-[3px] rounded-r-full bg-teal-400 shadow-[0_0_10px_2px_rgba(45,212,191,0.45)] transition-all duration-200 group-hover/line:h-[88%] group-hover/line:w-[6px] group-data-[state=open]/line:h-[88%] group-data-[state=open]/line:w-[6px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="min-w-48" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => void follow()}>
          <Star className={cn("size-4", following ? "fill-current text-primary" : "")} /> {t(following ? "projects.unfollow" : "projects.follow")}
        </DropdownMenuItem>
        {can("pipeline.edit") && (
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <CalendarPlus className="size-4 text-primary" /> {t("tickets.rowMenu.addToDay")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onOpen}>
          <ExternalLink className="size-4" /> {t("pipeline.day.openItem")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
