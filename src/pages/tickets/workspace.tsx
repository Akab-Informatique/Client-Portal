import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Hexagon, Maximize2, PanelBottom, RectangleHorizontal, Ticket, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TicketOverlay } from "./TicketPanel";
import { CLOSE_TICKET_EVENT, DockTimer, TimersProvider, useTicketTimerAuto, useTimers, type Timer } from "./timers";
import { ReminderWatcher } from "./Planning";
import { dueGlow, priorityGlow, usePresence, type PriorityKind as Priority, type StatusKind, type TicketDetail } from "./shared";

/**
 * Ticket workspace, shared by every staff page: the ticket open full screen and
 * the minimized ones in a dock at the bottom (restored in one click, even after
 * going to another page). Minimized tickets keep their presence: the others
 * still see that you are on them. Kept for the browser tab (sessionStorage).
 */
type Docked = { id: number; number: string; title: string; priority?: Priority; dueAt?: string; statusKind?: StatusKind };
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

  // The open ticket's timer: starts on open, asks for the time entry on close
  const timer = useTicketTimerAuto();
  const openRef = useRef<number | null>(null);
  openRef.current = openId;
  const open = useCallback(
    (id: number) => {
      setDocked((d) => d.filter((x) => x.id !== id));
      setOpenId(id);
      if (enabled) timer.opened(id);
    },
    [enabled, timer],
  );
  const close = useCallback(() => {
    if (openRef.current !== null && enabled) void timer.closed(openRef.current);
    setOpenId(null);
  }, [enabled, timer]);
  // a timer closed with no time: its ticket closes if it is the one open (nothing left to ask)
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<number>).detail;
      if (openRef.current === id) setOpenId(null);
    };
    window.addEventListener(CLOSE_TICKET_EVENT, on);
    return () => window.removeEventListener(CLOSE_TICKET_EVENT, on);
  }, []);
  const minimize = useCallback((tk: TicketDetail) => {
    setDocked((d) =>
      [
        ...d.filter((x) => x.id !== tk.id),
        { id: tk.id, number: tk.number, title: tk.title, priority: tk.priorityKind, dueAt: tk.dueAt, statusKind: tk.statusKind },
      ].slice(-6),
    );
    setOpenId(null);
  }, []);
  const dismiss = (id: number) => setDocked((d) => d.filter((x) => x.id !== id));
  // X on a minimized ticket: with a timer going, it stops and asks for the time entry (like closing the ticket)
  const closeDocked = useCallback(
    async (id: number, withTimer: boolean) => {
      if (withTimer && enabled) await timer.closed(id);
      setDocked((d) => d.filter((x) => x.id !== id));
    },
    [enabled, timer],
  );

  const value = useMemo(() => ({ openId, docked, open, close }), [openId, docked, open, close]);
  return (
    <WsCtx.Provider value={value}>
      {children}
      {enabled && (
        <TimersProvider>
          <ReminderWatcher />
          <TicketOverlay id={openId} onClose={close} onMinimize={minimize} />
          <Dock docked={docked} hidden={openId !== null} onRestore={open} onDismiss={dismiss} onClose={closeDocked} />
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

/** Where a minimized ticket sits (dragged anywhere) and its size; kept on this computer. */
type Place = { x?: number; y?: number; compact?: boolean };
const PLACES = "akab.tickets.dock.places";
function readPlaces(): Record<string, Place> {
  try {
    return JSON.parse(localStorage.getItem(PLACES) ?? "{}") as Record<string, Place>;
  } catch {
    return {};
  }
}
/** Keep a tab inside the window (after a resize, or on a smaller screen). */
const clamp = (x: number, y: number, w: number, h: number) => ({
  x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
  y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)),
});

function Dock({
  docked,
  hidden,
  onRestore,
  onDismiss,
  onClose,
}: {
  docked: Docked[];
  hidden: boolean;
  onRestore: (id: number) => void;
  onDismiss: (id: number) => void;
  onClose: (id: number, withTimer: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Tickets with a timer stay in the dock, even when they were not minimized
  const { at, list } = useTimers();
  const [places, setPlaces] = useState<Record<string, Place>>(readPlaces);
  const [, redraw] = useState(0);
  useEffect(() => {
    try {
      localStorage.setItem(PLACES, JSON.stringify(places));
    } catch {
      /* private window: for this page only */
    }
  }, [places]);
  // a window resize keeps the tabs on screen
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const place = (id: number, p: Place | null) =>
    setPlaces((all) => {
      const next = { ...all };
      if (p === null) delete next[id];
      else next[id] = { ...next[id], ...p };
      return next;
    });
  const items: Docked[] = [
    ...docked,
    ...list
      .filter((x) => x.state !== "pending" && !docked.some((d) => d.id === x.ticketId))
      .map((x) => ({ id: x.ticketId, number: x.ticketNumber, title: x.ticketTitle })),
  ];
  if (hidden || items.length === 0) return null;
  const item = (d: Docked) => {
    const timer = list.find((x) => x.ticketId === d.id);
    const p = places[d.id] ?? {};
    return (
      <DockItem
        key={d.id}
        d={d}
        timer={timer}
        at={at}
        place={p}
        onPlace={(np) => place(d.id, np)}
        onRestore={() => onRestore(d.id)}
        onClose={() => {
          place(d.id, null);
          if (timer && timer.state !== "pending") void onClose(d.id, true);
          else onDismiss(d.id);
        }}
      />
    );
  };
  const free = items.filter((d) => places[d.id]?.x !== undefined);
  const stacked = items.filter((d) => places[d.id]?.x === undefined);
  return (
    <>
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap-reverse items-end justify-end gap-2"
        aria-label={t("tickets.dock")}
      >
        <AnimatePresence>{stacked.map(item)}</AnimatePresence>
      </div>
      <AnimatePresence>{free.map(item)}</AnimatePresence>
    </>
  );
}

function DockItem({
  d,
  timer,
  at,
  place,
  onPlace,
  onRestore,
  onClose,
}: {
  d: Docked;
  timer?: Timer;
  at: number;
  place: Place;
  onPlace: (p: Place | null) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const viewers = usePresence(d.id);
  const busy = Boolean(viewers?.length);
  const ref = useRef<HTMLDivElement>(null);
  // dragging: the tab follows the pointer; a click without moving opens the ticket
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-nodrag]")) return;
    const r = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 5) return;
    g.moved = true;
    const r = ref.current!.getBoundingClientRect();
    setLive(clamp(e.clientX - g.dx, e.clientY - g.dy, r.width, r.height));
  };
  const onPointerUp = () => {
    const g = drag.current;
    drag.current = null;
    if (g?.moved && live) {
      suppressClick.current = true;
      onPlace({ x: live.x, y: live.y });
      setLive(null);
    }
  };
  const restore = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onRestore();
  };
  // a honeycomb cell by default; a tab when asked
  const compact = place.compact !== false;
  const pos = live ?? (place.x !== undefined && place.y !== undefined ? place : null);
  const size = compact ? { w: 104, h: 116 } : { w: 288, h: 52 };
  const at2 = pos ? clamp(pos.x!, pos.y!, size.w, size.h) : null;
  const glow = d.dueAt && d.statusKind ? dueGlow(d.dueAt, d.statusKind, 0.9) : priorityGlow(d.priority ?? "medium", 0.9);
  const running = timer?.state === "running";

  const controls = (
    <>
      {timer && <DockTimer timer={timer} at={at} />}
      <IconBtn label={t("tickets.restore")} onClick={onRestore}>
        <Maximize2 className="size-3.5" />
      </IconBtn>
      <IconBtn label={compact ? t("tickets.dockTab.normal") : t("tickets.dockTab.compact")} onClick={() => onPlace({ compact: !compact })}>
        {compact ? <RectangleHorizontal className="size-3.5" /> : <Hexagon className="size-3.5" />}
      </IconBtn>
      {pos && (
        <IconBtn label={t("tickets.dockTab.back")} onClick={() => onPlace({ x: undefined, y: undefined })}>
          <PanelBottom className="size-3.5" />
        </IconBtn>
      )}
      <IconBtn label={timer && timer.state !== "pending" ? t("tickets.dockTab.closeTimer") : t("common.close")} onClick={onClose}>
        <X className="size-3.5" />
      </IconBtn>
    </>
  );

  return (
    <motion.div
      ref={ref}
      layout={!live}
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.95 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => ((drag.current = null), setLive(null))}
      style={at2 ? { position: "fixed", left: at2.x, top: at2.y, zIndex: live ? 60 : 41 } : undefined}
      className={cn("pointer-events-auto touch-none select-none", live ? "cursor-grabbing" : "cursor-grab", compact ? "group relative" : "")}
    >
      {compact ? (
        <>
          {/* a running timer: an electric field around the cell */}
          {running && (
            <span aria-hidden className="timer-field">
              <span className="timer-field-hex" />
            </span>
          )}
          {/* a honeycomb cell: number and time; the controls show on hover */}
          <button
            type="button"
            onClick={restore}
            title={`${d.number} — ${d.title}`}
            className={cn(
              "relative flex h-[116px] w-[104px] flex-col items-center justify-center gap-0.5 bg-[color:var(--gold)]/40 p-[1.5px] [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]",
              running && "bg-grad-gold",
            )}
          >
            <span className="absolute inset-[1.5px] flex flex-col items-center justify-center gap-1 bg-popover/95 px-3 [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]">
              <span aria-hidden className="pointer-events-none absolute inset-0 opacity-70" style={glow} />
              <Ticket className="relative size-3 text-primary" />
              <span className="relative font-mono text-[9px] leading-none text-muted-foreground">{d.number.slice(-4)}</span>
              {/* the ticket name, on two short lines */}
              <span className="relative line-clamp-2 max-w-[72px] break-words text-center text-[10px] font-semibold leading-tight">{d.title}</span>
              {timer && (
                <span className="relative">
                  <DockTimer timer={timer} at={at} compact />
                </span>
              )}
            </span>
          </button>
          {busy && (
            <span
              className="absolute right-1 top-2 size-2 rounded-full bg-orange-400"
              title={t("tickets.openBy", { names: viewers!.map((v) => v.name).join(", ") })}
            />
          )}
          {/* the action bar: shows on hover; the padding below it bridges the gap to the cell,
              and it stays a moment after the mouse leaves, so it can be reached without a click */}
          <div
            data-nodrag
            className="invisible absolute bottom-full left-1/2 z-10 -translate-x-1/2 pb-2 opacity-0 transition-[opacity,visibility] delay-300 duration-150 group-focus-within:visible group-focus-within:opacity-100 group-focus-within:delay-0 group-hover:visible group-hover:opacity-100 group-hover:delay-0"
          >
            <div className="flex items-center gap-0.5 rounded-full border bg-popover/95 px-1 py-0.5 shadow-lg backdrop-blur-xl">{controls}</div>
          </div>
        </>
      ) : (
        <div className={cn("relative", running && "timer-field-tab")}>
          <div className="group relative isolate flex w-72 items-center gap-2 overflow-hidden rounded-xl border border-[color:var(--gold)]/25 bg-popover/90 py-1.5 pl-1.5 pr-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6),0_0_24px_-12px_rgba(255,206,26,0.35)] backdrop-blur-xl">
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-40" style={glow} />
            <button type="button" onClick={restore} className="flex min-w-0 flex-1 items-center gap-2 text-left">
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
            <span data-nodrag className="flex shrink-0 items-center">
              {controls}
            </span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-nodrag
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={label}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
