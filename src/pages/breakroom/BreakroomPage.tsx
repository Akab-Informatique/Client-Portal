import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Chess, type Square } from "chess.js";
import { Check, ChevronLeft, ChevronRight, Coffee, Crown, ExternalLink, Flag, Hourglass, Loader2, Play, Sparkles, UserPlus, Users, X } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn, initials } from "@/lib/utils";

type Person = { id: string; name: string };
type Color = "w" | "b";
type Game = {
  id: string;
  status: "invited" | "playing" | "done" | "declined";
  fen: string;
  lastMove: string | null;
  turn: Color;
  inCheck: boolean;
  result: Color | "draw" | null;
  endedBy: "checkmate" | "stalemate" | "draw" | "resign" | null;
  myColor: Color;
  myTurn: boolean;
  invitedByMe: boolean;
  opponent: Person;
  updatedAt: string;
};
type Video = { id: string; title: string; published: string };
type BreakStatus = { limitSeconds: number; usedSeconds: number; remainingSeconds: number };

const KEY = ["breakroom"] as const;
const BEAT_MS = 30_000;
const over = (e: unknown) => e instanceof ApiError && e.code === "break_over";

/**
 * Team › Coffee break: chess with a colleague, Orbi's videos — 30 minutes a
 * day, counted on the server while the page is on screen.
 */
export function BreakroomPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [gameId, setGameId] = useState<string | null>(null);
  const [orbi, setOrbi] = useState(false);
  const status = useQuery({ queryKey: [...KEY, "status"], queryFn: () => api.get<BreakStatus>("/breakroom/status") });

  // the time on screen counts: a beat every 30 s while the page is visible
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      void api
        .post<BreakStatus>("/breakroom/beat")
        .then((s) => qc.setQueryData([...KEY, "status"], s))
        .catch(() => undefined);
    };
    beat();
    const id = setInterval(beat, BEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [qc]);

  // from the bell: /breakroom?game=<id>
  useEffect(() => {
    const id = params.get("game");
    if (!id) return;
    setGameId(id);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("game");
        return n;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const left = status.data?.remainingSeconds ?? null;
  const closed = left !== null && left <= 0;

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <Hero status={status.data} />
      {closed ? (
        <section className="glass flex flex-col items-center gap-3 rounded-3xl border px-6 py-16 text-center">
          <span className="flex size-16 items-center justify-center rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary">
            <Coffee className="size-7" />
          </span>
          <h2 className="font-display text-2xl font-semibold">{t("breakroom.over.title")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">{t("breakroom.over.text")}</p>
        </section>
      ) : (
        <div className="grid items-stretch gap-5 lg:grid-cols-3">
          <ChessTile onOpen={setGameId} />
          <OrbiTile onOpen={() => setOrbi(true)} />
        </div>
      )}
      {!closed && gameId && <ChessDialog id={gameId} onClose={() => setGameId(null)} />}
      {!closed && orbi && <OrbiDialog onClose={() => setOrbi(false)} />}
    </div>
  );
}

/** The title, and today's break time (a ring that empties) */
function Hero({ status }: { status?: BreakStatus }) {
  const { t } = useTranslation();
  const share = status ? status.remainingSeconds / status.limitSeconds : 1;
  const min = status ? Math.ceil(status.remainingSeconds / 60) : null;
  const r = 26;
  const len = 2 * Math.PI * r;
  return (
    <section className="glass relative overflow-hidden rounded-3xl border p-6 sm:p-8">
      <span
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 bg-[radial-gradient(circle,rgba(255,206,26,0.22),transparent_65%)]"
      />
      <div className="relative flex flex-wrap items-center gap-6">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            <Coffee className="size-3.5" /> {t("breakroom.kicker")}
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight sm:text-4xl">{t("breakroom.title")}</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t("breakroom.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border bg-background/40 px-4 py-3">
          <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden>
            <defs>
              <linearGradient id="break-ring" x1="0" x2="1">
                <stop offset="0" stopColor="#ffe24a" />
                <stop offset="1" stopColor="#f59410" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={6} />
            <circle
              cx="32"
              cy="32"
              r={r}
              fill="none"
              stroke="url(#break-ring)"
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={`${share * len} ${len}`}
              className="transition-[stroke-dasharray] duration-700"
            />
          </svg>
          <div>
            <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Hourglass className="size-3" /> {t("breakroom.timeLeft")}
            </p>
            <p className="font-display text-2xl font-semibold tabular-nums">{min === null ? "…" : t("breakroom.minutes", { count: min })}</p>
            <p className="text-[11px] text-muted-foreground">{t("breakroom.perDay")}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Chess ──
const PIECE: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

function ChessTile({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const online = useQuery({ queryKey: [...KEY, "online"], queryFn: () => api.get<Person[]>("/breakroom/online"), refetchInterval: 20_000 });
  const games = useQuery({ queryKey: [...KEY, "chess"], queryFn: () => api.get<Game[]>("/breakroom/chess"), refetchInterval: 5_000 });
  const onError = (e: unknown) => {
    if (over(e)) void qc.invalidateQueries({ queryKey: [...KEY, "status"] });
    else toast.error(t("common.error"));
  };
  const invite = useMutation({
    mutationFn: (opponentId: string) => api.post<Game>("/breakroom/chess", { opponentId }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("breakroom.chess.invited", { name: g.opponent.name }));
      onOpen(g.id);
    },
    onError,
  });
  const respond = useMutation({
    mutationFn: (p: { id: string; accept: boolean }) => api.post<Game>(`/breakroom/chess/${p.id}/respond`, { accept: p.accept }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: KEY });
      if (g.status === "playing") onOpen(g.id);
    },
    onError,
  });
  const list = games.data ?? [];
  const invitations = list.filter((g) => g.status === "invited" && !g.invitedByMe);
  const current = list.filter((g) => g.status === "playing" || (g.status === "invited" && g.invitedByMe));
  // already in a game or an invitation with them: no second invitation
  const busy = new Map([...invitations, ...current].map((g) => [g.opponent.id, g.id]));
  // the preview: my turn first, else the latest game
  const featured = current.find((g) => g.myTurn) ?? current[0];

  return (
    <section className="glass relative flex flex-col overflow-hidden rounded-3xl border lg:col-span-2">
      <span
        aria-hidden
        className="pointer-events-none absolute -left-20 top-1/3 h-72 w-72 bg-[radial-gradient(circle,rgba(255,206,26,0.12),transparent_70%)]"
      />
      <div className="relative grid flex-1 gap-6 p-6 md:grid-cols-[minmax(0,240px)_1fr]">
        <button
          type="button"
          onClick={() => featured && onOpen(featured.id)}
          disabled={!featured}
          className="group self-start overflow-hidden border border-[color:var(--gold)]/30 shadow-[0_20px_60px_-24px_rgba(255,206,26,0.45)] transition-transform enabled:hover:-translate-y-0.5"
          aria-label={featured ? t("breakroom.chess.resumeWith", { name: featured.opponent.name }) : t("breakroom.chess.title")}
        >
          <MiniBoard fen={featured?.fen ?? new Chess().fen()} flip={featured?.myColor === "b"} />
        </button>
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">{t("breakroom.chess.kicker")}</p>
            <h2 className="font-display text-2xl font-semibold">{t("breakroom.chess.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("breakroom.chess.text")}</p>
          </div>

          {invitations.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-2xl border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 px-3 py-2.5 text-sm">
              <Sparkles className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{t("breakroom.chess.invitedBy", { name: g.opponent.name })}</span>
              <Button
                size="sm"
                className="h-8 bg-grad-gold font-semibold text-[#1a1204]"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: g.id, accept: true })}
              >
                <Check className="size-3.5" /> {t("breakroom.chess.accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: g.id, accept: false })}
                aria-label={t("breakroom.chess.decline")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}

          {current.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.chess.current")}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {current.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => onOpen(g.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-2xl border px-3 py-2 text-left text-sm transition-colors hover:border-[color:var(--gold)]/50 hover:bg-accent/40",
                      g.myTurn && "border-[color:var(--gold)]/50",
                    )}
                  >
                    <Avatar name={g.opponent.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{g.opponent.name}</span>
                      <span className={cn("block text-[11px]", g.myTurn ? "font-semibold text-primary" : "text-muted-foreground")}>
                        {g.status === "invited" ? t("breakroom.chess.waiting") : g.myTurn ? t("breakroom.chess.yourTurn") : t("breakroom.chess.theirTurn")}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="size-3.5" /> {t("breakroom.chess.online")}
              {online.data && <span className="font-normal normal-case">· {online.data.length}</span>}
            </p>
            {online.isLoading ? (
              <Skeleton className="h-12 rounded-2xl" />
            ) : !(online.data ?? []).length ? (
              <p className="rounded-2xl border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">{t("breakroom.chess.nobody")}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {(online.data ?? []).map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 rounded-2xl border bg-background/30 px-3 py-2 text-sm">
                    <span className="relative">
                      <Avatar name={p.name} />
                      <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-400" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {busy.has(p.id) ? (
                      <Button size="sm" variant="ghost" className="h-8" onClick={() => onOpen(busy.get(p.id)!)}>
                        {t("breakroom.chess.resume")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-8" disabled={invite.isPending} onClick={() => invite.mutate(p.id)}>
                        <UserPlus className="size-3.5" /> {t("breakroom.chess.invite")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

const Avatar = ({ name }: { name: string }) => (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(name)}</span>
);

const LIGHT = "bg-[#e8dcc0]";
const DARK = "bg-[#8a6a43]";
const pieceClass = (color: Color) =>
  color === "w"
    ? "text-[#ffd84a] [text-shadow:0_1px_0_#7a4a00,0_0_1px_#3a2400,0_2px_6px_rgba(0,0,0,0.45)]"
    : "text-[#141416] [text-shadow:0_1px_0_rgba(255,255,255,0.25),0_2px_6px_rgba(0,0,0,0.35)]";

/** A small board (the tile's preview), read only */
function MiniBoard({ fen, flip }: { fen: string; flip?: boolean }) {
  const board = useMemo(() => new Chess(fen).board(), [fen]);
  const rows = flip ? [...board].reverse().map((r) => [...r].reverse()) : board;
  return (
    <div className="grid w-full grid-cols-8" style={{ aspectRatio: "1 / 1" }}>
      {rows.flatMap((row, r) =>
        row.map((cell, c) => (
          <span
            key={`${r}-${c}`}
            className={cn("flex items-center justify-center text-[clamp(0.9rem,2.4vw,1.5rem)] leading-none", (r + c) % 2 === 0 ? LIGHT : DARK)}
          >
            {cell && <span className={cn("[font-variant-emoji:text]", pieceClass(cell.color))}>{PIECE[cell.type]}</span>}
          </span>
        )),
      )}
    </div>
  );
}

const FILES = "abcdefgh";

function ChessDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: g, isLoading } = useQuery({
    queryKey: [...KEY, "game", id],
    queryFn: () => api.get<Game>(`/breakroom/chess/${id}`),
    // the other player's move shows within a second or two
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "done" || q.state.data.status === "declined") ? false : 1500),
  });
  const [picked, setPicked] = useState<Square | null>(null);
  const [promo, setPromo] = useState<{ from: Square; to: Square } | null>(null);
  const put = (next: Game) => {
    qc.setQueryData([...KEY, "game", id], next);
    void qc.invalidateQueries({ queryKey: [...KEY, "chess"] });
  };
  const onError = (e: unknown) => {
    void qc.invalidateQueries({ queryKey: [...KEY, "game", id] });
    if (over(e)) void qc.invalidateQueries({ queryKey: [...KEY, "status"] });
    else toast.error(e instanceof ApiError && e.code === "illegal_move" ? t("breakroom.chess.illegal") : t("common.error"));
  };
  const move = useMutation({
    mutationFn: (p: { from: Square; to: Square; promotion?: string }) => api.post<Game>(`/breakroom/chess/${id}/move`, p),
    onSuccess: (next) => {
      put(next);
      setPicked(null);
      setPromo(null);
    },
    onError,
  });
  const resign = useMutation({ mutationFn: () => api.post<Game>(`/breakroom/chess/${id}/resign`), onSuccess: put, onError });

  const chess = useMemo(() => (g ? new Chess(g.fen) : null), [g]);
  const targets = useMemo(() => (chess && picked && g?.myTurn ? chess.moves({ square: picked, verbose: true }) : []), [chess, picked, g?.myTurn]);
  const flip = g?.myColor === "b";
  const ranks = flip ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = flip ? [...FILES].reverse() : [...FILES];
  const last = g?.lastMove ? [g.lastMove.slice(0, 2), g.lastMove.slice(2, 4)] : [];
  const kingInCheck =
    g?.inCheck && chess
      ? chess
          .board()
          .flat()
          .find((x) => x && x.type === "k" && x.color === g.turn)?.square
      : undefined;

  const click = (sq: Square) => {
    if (!g || !chess || !g.myTurn || move.isPending) return;
    const target = targets.find((m) => m.to === sq);
    if (picked && target) {
      if (target.promotion) setPromo({ from: picked, to: sq });
      else move.mutate({ from: picked, to: sq });
      return;
    }
    const piece = chess.get(sq);
    setPicked(piece && piece.color === g.myColor ? (picked === sq ? null : sq) : null);
  };

  const status = !g
    ? ""
    : g.status === "invited"
      ? g.invitedByMe
        ? t("breakroom.chess.waitingFor", { name: g.opponent.name })
        : t("breakroom.chess.invitedBy", { name: g.opponent.name })
      : g.status === "declined"
        ? t("breakroom.chess.declined")
        : g.status === "done"
          ? g.result === "draw"
            ? t(g.endedBy === "stalemate" ? "breakroom.chess.stalemate" : "breakroom.chess.draw")
            : g.result === g.myColor
              ? t(g.endedBy === "resign" ? "breakroom.chess.wonResign" : "breakroom.chess.wonMate")
              : t(g.endedBy === "resign" ? "breakroom.chess.lostResign" : "breakroom.chess.lostMate", { name: g.opponent.name })
          : g.myTurn
            ? g.inCheck
              ? t("breakroom.chess.youCheck")
              : t("breakroom.chess.yourTurn")
            : t("breakroom.chess.theirTurnName", { name: g.opponent.name });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="size-5 text-primary" /> {t("breakroom.chess.title")}
            {g && <span className="font-normal text-muted-foreground">· {g.opponent.name}</span>}
          </DialogTitle>
          <DialogDescription className={cn(g?.myTurn && "font-semibold text-primary", g?.inCheck && g.myTurn && "text-red-300")}>{status}</DialogDescription>
        </DialogHeader>
        {isLoading || !g || !chess ? (
          <Skeleton className="aspect-square w-full rounded-xl" />
        ) : (
          <>
            <PlayerBar name={g.opponent.name} color={g.myColor === "w" ? "b" : "w"} active={g.status === "playing" && !g.myTurn} />
            <div className="relative mx-auto w-full max-w-[min(34rem,70vh)]">
              <div
                className="grid grid-cols-8 overflow-hidden border-2 border-[color:var(--gold)]/40 shadow-[0_24px_70px_-28px_rgba(255,206,26,0.5)]"
                style={{ aspectRatio: "1 / 1" }}
              >
                {ranks.flatMap((rank, r) =>
                  files.map((file, c) => {
                    const sq = `${file}${rank}` as Square;
                    const piece = chess.get(sq);
                    const target = targets.find((m) => m.to === sq);
                    const light = (r + c) % 2 === 0;
                    return (
                      <button
                        key={sq}
                        type="button"
                        onClick={() => click(sq)}
                        className={cn(
                          "relative flex items-center justify-center text-[clamp(1.4rem,5.2vw,2.6rem)] leading-none outline-none",
                          light ? LIGHT : DARK,
                          last.includes(sq) && "after:absolute after:inset-0 after:bg-[#ffce1a]/35",
                          picked === sq && "after:absolute after:inset-0 after:bg-emerald-400/40",
                          kingInCheck === sq && "after:absolute after:inset-0 after:bg-[radial-gradient(circle,rgba(239,68,68,0.85),transparent_70%)]",
                          g.myTurn && (piece?.color === g.myColor || target) && "cursor-pointer",
                        )}
                        aria-label={sq}
                      >
                        {c === 0 && (
                          <span className={cn("absolute left-0.5 top-0.5 z-10 text-[9px] font-semibold", light ? "text-[#8a6a43]" : "text-[#e8dcc0]")}>
                            {rank}
                          </span>
                        )}
                        {r === 7 && (
                          <span className={cn("absolute bottom-0.5 right-1 z-10 text-[9px] font-semibold", light ? "text-[#8a6a43]" : "text-[#e8dcc0]")}>
                            {file}
                          </span>
                        )}
                        {piece && <span className={cn("relative z-10 [font-variant-emoji:text]", pieceClass(piece.color))}>{PIECE[piece.type]}</span>}
                        {target &&
                          (piece ? (
                            <span className="absolute inset-[6%] z-10 rounded-full border-4 border-emerald-500/70" />
                          ) : (
                            <span className="absolute z-10 h-[28%] w-[28%] rounded-full bg-emerald-600/60" />
                          ))}
                      </button>
                    );
                  }),
                )}
              </div>
              {promo && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
                  <div className="glass flex gap-2 rounded-2xl border p-3">
                    {(["q", "r", "b", "n"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => move.mutate({ ...promo, promotion: p })}
                        className="flex h-14 w-14 items-center justify-center rounded-xl border bg-background/60 text-4xl hover:border-[color:var(--gold)]/60"
                        aria-label={t(`breakroom.chess.piece.${p}`)}
                      >
                        <span className={cn("[font-variant-emoji:text]", pieceClass(g.myColor))}>{PIECE[p]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <PlayerBar name={t("breakroom.chess.you")} color={g.myColor} active={g.myTurn} />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">{t("breakroom.chess.hint")}</p>
              {(g.status === "playing" || (g.status === "invited" && g.invitedByMe)) && (
                <Button size="sm" variant="ghost" className="text-destructive" disabled={resign.isPending} onClick={() => resign.mutate()}>
                  <Flag className="size-3.5" /> {t(g.status === "invited" ? "breakroom.chess.cancel" : "breakroom.chess.resign")}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlayerBar({ name, color, active }: { name: string; color: Color; active: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm transition-colors",
        active && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10",
      )}
    >
      <span className={cn("text-xl leading-none [font-variant-emoji:text]", pieceClass(color))}>{PIECE.k}</span>
      <span className="font-medium">{name}</span>
      {active && <span className="ml-auto size-2 animate-pulse rounded-full bg-primary" />}
    </div>
  );
}

// ── Orbi the Alien ──
function useOrbi() {
  return useQuery({ queryKey: [...KEY, "orbi"], queryFn: () => api.get<{ channel: string; videos: Video[] }>("/breakroom/videos"), staleTime: 10 * 60_000 });
}
const thumb = (id: string, size: "mq" | "hq" = "mq") => `https://i.ytimg.com/vi/${id}/${size}default.jpg`;
const day = (iso: string) =>
  iso ? new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "";

function OrbiTile({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useOrbi();
  const latest = data?.videos[0];
  return (
    <section className="glass relative flex flex-col overflow-hidden rounded-3xl border">
      <button type="button" onClick={onOpen} disabled={!latest} className="group relative block aspect-[4/3] w-full overflow-hidden text-left">
        {isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : latest ? (
          <img
            src={thumb(latest.id, "hq")}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">{t("breakroom.orbi.none")}</span>
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-[#0a0a0b] via-[#0a0a0b]/40 to-transparent" />
        {latest && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-grad-gold text-[#1a1204] shadow-[0_10px_40px_-8px_rgba(255,206,26,0.7)] transition-transform group-hover:scale-110">
              <Play className="ml-1 size-7 fill-current" />
            </span>
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 p-5">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300">{t("breakroom.orbi.kicker")}</span>
          <span className="block font-display text-2xl font-semibold text-white">{t("breakroom.orbi.title")}</span>
          {latest && <span className="mt-0.5 line-clamp-1 block text-sm text-white/80">{latest.title}</span>}
        </span>
      </button>
      <div className="flex items-center justify-between gap-2 p-4">
        <span className="text-xs text-muted-foreground">{t("breakroom.orbi.count", { count: data?.videos.length ?? 0 })}</span>
        <Button size="sm" variant="outline" onClick={onOpen} disabled={!latest}>
          <Play className="size-3.5" /> {t("breakroom.orbi.watch")}
        </Button>
      </div>
    </section>
  );
}

function OrbiDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useOrbi();
  const videos = data?.videos ?? [];
  const [i, setI] = useState(0);
  const v = videos[i];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-5 text-emerald-300" /> {t("breakroom.orbi.title")}
          </DialogTitle>
          <DialogDescription>{v ? `${v.title} · ${day(v.published)}` : t("breakroom.orbi.none")}</DialogDescription>
        </DialogHeader>
        {v ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="space-y-2">
              <div className="overflow-hidden rounded-xl border bg-black">
                <iframe
                  key={v.id}
                  title={v.title}
                  src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?autoplay=1&rel=0`}
                  className="aspect-video w-full"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => setI(i - 1)}>
                  <ChevronLeft className="size-4" /> {t("breakroom.orbi.previous")}
                </Button>
                <a
                  href={data?.channel}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  @orbithealien <ExternalLink className="size-3" />
                </a>
                <Button variant="ghost" size="sm" disabled={i >= videos.length - 1} onClick={() => setI(i + 1)}>
                  {t("breakroom.orbi.next")} <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
            <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
              {videos.map((x, j) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => setI(j)}
                    className={cn(
                      "flex w-full gap-2 rounded-lg border p-1.5 text-left text-xs hover:bg-accent/50",
                      j === i ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "border-transparent",
                    )}
                  >
                    <img src={thumb(x.id)} alt="" className="aspect-video w-24 shrink-0 rounded object-cover" loading="lazy" referrerPolicy="no-referrer" />
                    <span className="min-w-0">
                      <span className="line-clamp-2 font-medium">{x.title}</span>
                      <span className="text-[10px] text-muted-foreground">{day(x.published)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        )}
      </DialogContent>
    </Dialog>
  );
}
