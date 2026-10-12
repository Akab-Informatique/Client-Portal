import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Ticket, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TicketOverlay } from "./TicketPanel";
import { DockTimer, TimersProvider, useTimers, type Timer } from "./timers";
import { PRIORITY_STYLE, usePresence, type PriorityKind as Priority, type TicketDetail } from "./shared";

/**
 * Ticket workspace, shared by every staff page: the ticket open full screen and
 * the minimized ones in a dock at the bottom (restored in one click, even after
 * going to another page). Minimized tickets keep their presence: the others
 * still see that you are on them. Kept for the browser tab (sessionStorage).
 */
type Docked = { id: number; number: string; title: string; priority?: Priority };
type Ws = {
  openId: number | null;
  docked: Docked[];
  open: (id: number) => void;
  close: () => void;
};

const WsCtx = createContext<Ws | null>(null);
const KEY = "akab.tickets.dock";

export function TicketWorkspaceProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [docked, setDocked] = useState<Docked[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Docked[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(docked));
    } catch {
      /* ignore */
    }
  }, [docked]);

  const open = useCallback((id: number) => {
    setDocked((d) => d.filter((x) => x.id !== id));
    setOpenId(id);
  }, []);
  const close = useCallback(() => setOpenId(null), []);
  const minimize = useCallback((tk: TicketDetail) => {
    setDocked((d) => [...d.filter((x) => x.id !== tk.id), { id: tk.id, number: tk.number, title: tk.title, priority: tk.priorityKind }].slice(-6));
    setOpenId(null);
  }, []);
  const dismiss = (id: number) => setDocked((d) => d.filter((x) => x.id !== id));

  const value = useMemo(() => ({ openId, docked, open, close }), [openId, docked, open, close]);
  return (
    <WsCtx.Provider value={value}>
      {children}
      {enabled && (
        <TimersProvider>
          <TicketOverlay id={openId} onClose={close} onMinimize={minimize} />
          <Dock docked={docked} hidden={openId !== null} onRestore={open} onDismiss={dismiss} />
        </TimersProvider>
      )}
    </WsCtx.Provider>
  );
}

export function useTicketWorkspace() {
  const ws = useContext(WsCtx);
  if (!ws) throw new Error("useTicketWorkspace outside TicketWorkspaceProvider");
  return ws;
}

function Dock({ docked, hidden, onRestore, onDismiss }: { docked: Docked[]; hidden: boolean; onRestore: (id: number) => void; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  // Tickets with a timer stay in the dock, even when they were not minimized
  const { at, list } = useTimers();
  const items: Docked[] = [
    ...docked,
    ...list.filter((x) => x.state !== "pending" && !docked.some((d) => d.id === x.ticketId)).map((x) => ({ id: x.ticketId, number: x.ticketNumber, title: x.ticketTitle })),
  ];
  if (hidden || items.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap-reverse justify-end gap-2" aria-label={t("tickets.dock")}>
      <AnimatePresence>
        {items.map((d) => (
          <DockItem key={d.id} d={d} timer={list.find((x) => x.ticketId === d.id)} at={at} onRestore={() => onRestore(d.id)} onDismiss={() => onDismiss(d.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function DockItem({ d, timer, at, onRestore, onDismiss }: { d: Docked; timer?: Timer; at: number; onRestore: () => void; onDismiss: () => void }) {
  const active = timer && timer.state !== "pending";
  const { t } = useTranslation();
  const viewers = usePresence(d.id);
  const busy = Boolean(viewers?.length);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.95 }}
      className="group flex w-72 items-center gap-2 overflow-hidden rounded-xl border border-[color:var(--gold)]/25 bg-popover/90 py-1.5 pl-1.5 pr-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6),0_0_24px_-12px_rgba(255,206,26,0.35)] backdrop-blur-xl"
    >
      <span className={cn("h-8 w-1 shrink-0 rounded-full", d.priority ? PRIORITY_STYLE[d.priority].bar : "bg-[color:var(--gold)]/60")} />
      <button type="button" onClick={onRestore} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Ticket className="size-4 shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="block font-mono text-[10px] text-muted-foreground">{d.number}</span>
          <span className="block truncate text-xs font-medium">{d.title}</span>
        </span>
      </button>
      {busy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="relative flex size-2.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-orange-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("tickets.openBy", { names: viewers!.map((v) => v.name).join(", ") })}</TooltipContent>
        </Tooltip>
      )}
      {timer && <DockTimer timer={timer} at={at} />}
      <button type="button" onClick={onRestore} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("tickets.restore")}>
        <Maximize2 className="size-3.5" />
      </button>
      {!active && (
        <button type="button" onClick={onDismiss} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("common.close")}>
          <X className="size-3.5" />
        </button>
      )}
    </motion.div>
  );
}
