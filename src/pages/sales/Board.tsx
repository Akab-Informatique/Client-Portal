import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CalendarClock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { LOST_REASONS, SALES_STAGES, isOpenStage, type LostReason, type SalesStage } from "@shared/sales";
import { STAGE_TONE, salesError, shortMoney, type Opportunity } from "./shared";

/**
 * The pipeline as a board: one column per stage, a card per opportunity, dragged to
 * change its stage. Open stages show everything; Gagné / Perdu only what closed in the period.
 */
export function Board({ list, from, to, onOpen, onNew }: { list: Opportunity[]; from: string; to: string; onOpen: (o: Opportunity) => void; onNew: (stage: SalesStage) => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const editable = can("opportunities.edit");
  const qc = useQueryClient();
  const [dragging, setDragging] = useState<Opportunity | null>(null);
  const [losing, setLosing] = useState<Opportunity | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const move = useMutation({
    mutationFn: ({ id, stage, lostReason }: { id: string; stage: SalesStage; lostReason?: LostReason }) => api.patch<Opportunity>(`/sales/opportunities/${id}`, { stage, ...(lostReason ? { lostReason } : {}) }),
    // the card moves at once; the server's answer (dates, probability) replaces it
    onMutate: ({ id, stage }) => {
      qc.setQueryData<Opportunity[]>(["sales", "opportunities"], (cur) => cur?.map((o) => (o.id === id ? { ...o, stage } : o)));
    },
    onSuccess: (row) => {
      qc.setQueryData<Opportunity[]>(["sales", "opportunities"], (cur) => cur?.map((o) => (o.id === row.id ? row : o)));
      void qc.invalidateQueries({ queryKey: ["sales", "dashboard"] });
      if (row.stage === "won") toast.success(t("sales.wonToast", { name: row.companyName }));
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: ["sales", "opportunities"] });
      toast.error(salesError(e, t));
    },
  });

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const o = list.find((x) => x.id === e.active.id);
    const stage = e.over?.id as SalesStage | undefined;
    if (!o || !stage || stage === o.stage) return;
    // a lost deal needs its reason first
    if (stage === "lost") setLosing(o);
    else move.mutate({ id: o.id, stage });
  };

  const inColumn = (s: SalesStage) => list.filter((o) => o.stage === s && (isOpenStage(s) || (o.closedOn && o.closedOn >= from && o.closedOn <= to)));

  return (
    <>
      <DndContext sensors={sensors} onDragStart={(e) => setDragging(list.find((o) => o.id === e.active.id) ?? null)} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          <div className="grid min-w-[72rem] grid-cols-6 gap-3">
            {SALES_STAGES.map((s) => {
              const cards = inColumn(s);
              const mrr = cards.reduce((n, o) => n + o.monthlyCents, 0);
              const once = cards.reduce((n, o) => n + (o.kind === "one_time" ? (o.oneTimeCents ?? 0) : 0), 0);
              return (
                <Column key={s} stage={s}>
                  <header className="flex items-start justify-between gap-2 px-1">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold">
                        <span className={cn("size-2 shrink-0 rounded-full", STAGE_TONE[s])} />
                        {t(`sales.stage.${s}`)}
                        <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">{cards.length}</span>
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                        {shortMoney(mrr, i18n.language)}
                        {t("sales.perMonth")}
                        {once > 0 && ` · ${shortMoney(once, i18n.language)}`}
                      </p>
                    </div>
                    {editable && isOpenStage(s) && (
                      <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => onNew(s)} aria-label={t("sales.addIn", { stage: t(`sales.stage.${s}`) })}>
                        <Plus className="size-4" />
                      </Button>
                    )}
                  </header>
                  <div className="space-y-2">
                    {cards.map((o) => (
                      <Card key={o.id} opp={o} draggable={editable} onOpen={() => onOpen(o)} />
                    ))}
                    {!cards.length && <p className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{isOpenStage(s) ? t("sales.emptyColumn") : t("sales.emptyClosed")}</p>}
                  </div>
                </Column>
              );
            })}
          </div>
        </div>
        <DragOverlay>{dragging && <CardBody opp={dragging} lifted />}</DragOverlay>
      </DndContext>

      {losing && (
        <Dialog open onOpenChange={(o) => !o && setLosing(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("sales.lostTitle", { name: losing.companyName })}</DialogTitle>
              <DialogDescription>{t("sales.lostText")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {LOST_REASONS.map((r) => (
                <Button
                  key={r}
                  variant="outline"
                  className="justify-start"
                  onClick={() => {
                    move.mutate({ id: losing.id, stage: "lost", lostReason: r });
                    setLosing(null);
                  }}
                >
                  {t(`sales.lost.${r}`)}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Column({ stage, children }: { stage: SalesStage; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section ref={setNodeRef} className={cn("glass flex min-h-[24rem] flex-col gap-3 rounded-2xl border p-3 transition-colors", isOver && "border-primary/60 bg-primary/5")}>
      {children}
    </section>
  );
}

function Card({ opp, draggable, onOpen }: { opp: Opportunity; draggable: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: opp.id, disabled: !draggable });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={cn("touch-none", isDragging && "opacity-30")}>
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <CardBody opp={opp} />
      </button>
    </div>
  );
}

function CardBody({ opp, lifted }: { opp: Opportunity; lifted?: boolean }) {
  const { t, i18n } = useTranslation();
  const open = isOpenStage(opp.stage);
  return (
    <div className={cn("rounded-xl border bg-card p-3 transition-colors hover:border-primary/40", lifted && "rotate-1 shadow-2xl ring-1 ring-primary/40")}>
      <p className="truncate font-medium">{opp.companyName}</p>
      {opp.contactName && <p className="truncate text-xs text-muted-foreground">{opp.contactName}</p>}
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums">
          {opp.kind === "recurring" ? (
            <>
              {shortMoney(opp.monthlyCents, i18n.language)}
              <span className="font-normal text-muted-foreground">{t("sales.perMonth")}</span>
            </>
          ) : (
            <>
              {shortMoney(opp.oneTimeCents ?? 0, i18n.language)} <span className="font-normal text-muted-foreground">{t("sales.oneTimeShort")}</span>
            </>
          )}
        </p>
        {open && <span className="text-xs tabular-nums text-muted-foreground">{opp.probability} %</span>}
      </div>
      {opp.kind === "recurring" && opp.users != null && <p className="text-xs text-muted-foreground">{t("sales.usersCount", { count: opp.users })}</p>}
      {open && opp.nextFollowUp && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs", opp.overdue ? "font-semibold text-red-400" : "text-muted-foreground")}>
          <CalendarClock className="size-3.5" />
          {opp.overdue ? t("sales.followLate", { date: shortDate(opp.nextFollowUp) }) : t("sales.followOn", { date: shortDate(opp.nextFollowUp) })}
        </p>
      )}
      {opp.stage === "lost" && opp.lostReason && <p className="mt-2 text-xs text-red-400/90">{t(`sales.lost.${opp.lostReason}`)}</p>}
      {opp.ownerName && <p className="mt-2 truncate text-[11px] text-muted-foreground">{opp.ownerName}</p>}
    </div>
  );
}
