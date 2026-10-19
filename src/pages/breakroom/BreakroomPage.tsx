import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Coffee, Crown, ExternalLink, Flag, Loader2, Play, Swords, UserPlus, Users, X } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn, initials } from "@/lib/utils";
import { countPieces, legalMoves, type Side } from "@shared/checkers";

type Person = { id: string; name: string };
type Game = {
  id: string;
  status: "invited" | "playing" | "done" | "declined";
  board: string;
  turn: Side;
  mustFrom: number | null;
  winner: Side | null;
  endedBy: "win" | "resign" | null;
  mySide: Side;
  myTurn: boolean;
  invitedByMe: boolean;
  opponent: Person;
  updatedAt: string;
};
type Video = { id: string; title: string; published: string };

const GAMES = ["breakroom", "checkers"] as const;

/** Team › Coffee break: tiles of things to do on a break. */
export function BreakroomPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [gameId, setGameId] = useState<string | null>(null);
  const [orbi, setOrbi] = useState(false);
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

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Coffee className="size-6 text-primary" /> {t("breakroom.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("breakroom.subtitle")}</p>
      </div>
      <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        <CheckersTile onOpen={setGameId} />
        <OrbiTile onOpen={() => setOrbi(true)} />
      </div>
      {gameId && <CheckersDialog id={gameId} onClose={() => setGameId(null)} />}
      {orbi && <OrbiDialog onClose={() => setOrbi(false)} />}
    </div>
  );
}

function Tile({ icon: Icon, title, text, children, accent }: { icon: typeof Coffee; title: string; text: string; children: React.ReactNode; accent: string }) {
  return (
    <section className="glass flex flex-col gap-4 overflow-hidden rounded-2xl border p-5">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl border", accent)}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{text}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

// ── Checkers ──
function CheckersTile({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const online = useQuery({ queryKey: [...GAMES, "online"], queryFn: () => api.get<Person[]>("/breakroom/online"), refetchInterval: 20_000 });
  const games = useQuery({ queryKey: [...GAMES, "list"], queryFn: () => api.get<Game[]>("/breakroom/checkers"), refetchInterval: 5_000 });
  const invite = useMutation({
    mutationFn: (opponentId: string) => api.post<Game>("/breakroom/checkers", { opponentId }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: GAMES });
      toast.success(t("breakroom.checkers.invited", { name: g.opponent.name }));
      onOpen(g.id);
    },
    onError: () => toast.error(t("common.error")),
  });
  const respond = useMutation({
    mutationFn: (p: { id: string; accept: boolean }) => api.post<Game>(`/breakroom/checkers/${p.id}/respond`, { accept: p.accept }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: GAMES });
      if (g.status === "playing") onOpen(g.id);
    },
    onError: () => toast.error(t("common.error")),
  });
  const list = games.data ?? [];
  const invitations = list.filter((g) => g.status === "invited" && !g.invitedByMe);
  const current = list.filter((g) => g.status === "playing" || (g.status === "invited" && g.invitedByMe));
  // already in a game or an invitation with them: no second invitation
  const busy = new Map([...invitations, ...current].map((g) => [g.opponent.id, g.id]));

  return (
    <Tile
      icon={Swords}
      title={t("breakroom.checkers.title")}
      text={t("breakroom.checkers.text")}
      accent="border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary"
    >
      {invitations.length > 0 && (
        <div className="space-y-2">
          {invitations.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-xl border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{t("breakroom.checkers.invitedBy", { name: g.opponent.name })}</span>
              <Button
                size="sm"
                className="h-7 bg-grad-gold font-semibold text-[#1a1204]"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: g.id, accept: true })}
              >
                <Check className="size-3.5" /> {t("breakroom.checkers.accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: g.id, accept: false })}
                aria-label={t("breakroom.checkers.decline")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {current.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.checkers.current")}</p>
          {current.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onOpen(g.id)}
              className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm hover:border-[color:var(--gold)]/50 hover:bg-accent/40"
            >
              <Avatar name={g.opponent.name} />
              <span className="min-w-0 flex-1 truncate">{g.opponent.name}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                  g.myTurn ? "bg-[color:var(--gold)]/20 font-semibold text-primary" : "text-muted-foreground",
                )}
              >
                {g.status === "invited" ? t("breakroom.checkers.waiting") : g.myTurn ? t("breakroom.checkers.yourTurn") : t("breakroom.checkers.theirTurn")}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Users className="size-3.5" /> {t("breakroom.checkers.online")}
        </p>
        {online.isLoading ? (
          <Skeleton className="h-10 rounded-xl" />
        ) : !(online.data ?? []).length ? (
          <p className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{t("breakroom.checkers.nobody")}</p>
        ) : (
          <ul className="space-y-1.5">
            {(online.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
                <span className="relative">
                  <Avatar name={p.name} />
                  <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-400" />
                </span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {busy.has(p.id) ? (
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => onOpen(busy.get(p.id)!)}>
                    {t("breakroom.checkers.resume")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7" disabled={invite.isPending} onClick={() => invite.mutate(p.id)}>
                    <UserPlus className="size-3.5" /> {t("breakroom.checkers.invite")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Tile>
  );
}

const Avatar = ({ name }: { name: string }) => (
  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(name)}</span>
);

function CheckersDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: g, isLoading } = useQuery({
    queryKey: [...GAMES, "game", id],
    queryFn: () => api.get<Game>(`/breakroom/checkers/${id}`),
    // the other player's move shows within a second or two
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "done" || q.state.data.status === "declined") ? false : 1500),
  });
  const [picked, setPicked] = useState<number | null>(null);
  const put = (next: Game) => {
    qc.setQueryData([...GAMES, "game", id], next);
    void qc.invalidateQueries({ queryKey: [...GAMES, "list"] });
  };
  const move = useMutation({
    mutationFn: (p: { from: number; to: number }) => api.post<Game>(`/breakroom/checkers/${id}/move`, p),
    onSuccess: (next) => {
      put(next);
      setPicked(next.myTurn && next.mustFrom !== null ? next.mustFrom : null);
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: [...GAMES, "game", id] });
      toast.error(e instanceof ApiError && e.code === "illegal_move" ? t("breakroom.checkers.illegal") : t("common.error"));
    },
  });
  const resign = useMutation({
    mutationFn: () => api.post<Game>(`/breakroom/checkers/${id}/resign`),
    onSuccess: put,
    onError: () => toast.error(t("common.error")),
  });

  const legal = useMemo(() => (g && g.myTurn ? legalMoves({ board: g.board, turn: g.turn, mustFrom: g.mustFrom }) : []), [g]);
  // a capture in progress: that piece is the one to play
  useEffect(() => {
    if (g?.myTurn && g.mustFrom !== null) setPicked(g.mustFrom);
  }, [g?.myTurn, g?.mustFrom]);
  const movable = new Set(legal.map((m) => m.from));
  const targets = new Set(legal.filter((m) => m.from === picked).map((m) => m.to));
  // my side at the bottom
  const order = g?.mySide === "b" ? Array.from({ length: 64 }, (_, i) => 63 - i) : Array.from({ length: 64 }, (_, i) => i);

  const status = !g
    ? ""
    : g.status === "invited"
      ? g.invitedByMe
        ? t("breakroom.checkers.waitingFor", { name: g.opponent.name })
        : t("breakroom.checkers.invitedBy", { name: g.opponent.name })
      : g.status === "declined"
        ? t("breakroom.checkers.declined")
        : g.status === "done"
          ? g.winner === g.mySide
            ? t(g.endedBy === "resign" ? "breakroom.checkers.wonResign" : "breakroom.checkers.won")
            : t(g.endedBy === "resign" ? "breakroom.checkers.lostResign" : "breakroom.checkers.lost", { name: g.opponent.name })
          : g.myTurn
            ? g.mustFrom !== null
              ? t("breakroom.checkers.again")
              : t("breakroom.checkers.yourTurn")
            : t("breakroom.checkers.theirTurnName", { name: g.opponent.name });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Swords className="size-5 text-primary" /> {t("breakroom.checkers.title")}
            {g && <span className="font-normal text-muted-foreground">· {g.opponent.name}</span>}
          </DialogTitle>
          <DialogDescription className={cn(g?.myTurn && "font-semibold text-primary")}>{status}</DialogDescription>
        </DialogHeader>
        {isLoading || !g ? (
          <Skeleton className="aspect-square w-full rounded-xl" />
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <Score side={g.mySide === "r" ? "b" : "r"} board={g.board} label={g.opponent.name} />
              <Score side={g.mySide} board={g.board} label={t("breakroom.checkers.you")} />
            </div>
            <div className="mx-auto grid aspect-square w-full max-w-[min(32rem,75vh)] grid-cols-8 overflow-hidden border-2 border-[color:var(--gold)]/40 shadow-[0_0_40px_-12px_rgba(255,206,26,0.4)]">
              {order.map((i) => {
                const dark = (Math.floor(i / 8) + (i % 8)) % 2 === 1;
                const cell = g.board[i];
                const mine = (g.mySide === "r" ? /[rR]/ : /[bB]/).test(cell);
                const canPick = g.myTurn && movable.has(i) && !move.isPending;
                const isTarget = targets.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!(canPick || isTarget)}
                    onClick={() =>
                      isTarget && picked !== null
                        ? move.mutate({ from: picked, to: i })
                        : canPick && g.mustFrom === null
                          ? setPicked(picked === i ? null : i)
                          : undefined
                    }
                    className={cn(
                      "relative flex aspect-square items-center justify-center",
                      dark ? "bg-[#3b2a17]" : "bg-[#e9dcc2]",
                      isTarget && "cursor-pointer bg-emerald-700/70",
                      canPick && "cursor-pointer",
                    )}
                    aria-label={`${Math.floor(i / 8) + 1}-${(i % 8) + 1}`}
                  >
                    {isTarget && <span className="size-1/4 rounded-full bg-emerald-300/80" />}
                    {cell !== "." && (
                      <span
                        className={cn(
                          "flex size-[78%] items-center justify-center rounded-full border-2 shadow-[inset_0_-4px_0_rgba(0,0,0,0.25)] transition-transform",
                          /[rR]/.test(cell) ? "border-[#f59410] bg-grad-gold text-[#1a1204]" : "border-zinc-500 bg-zinc-900 text-zinc-200",
                          picked === i && "scale-110 ring-4 ring-emerald-300/70",
                          canPick && mine && picked !== i && "ring-2 ring-[color:var(--gold)]/60",
                        )}
                      >
                        {/[RB]/.test(cell) && <Crown className="size-1/2" />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">{t("breakroom.checkers.rules")}</p>
              {(g.status === "playing" || (g.status === "invited" && g.invitedByMe)) && (
                <Button size="sm" variant="ghost" className="text-destructive" disabled={resign.isPending} onClick={() => resign.mutate()}>
                  <Flag className="size-3.5" /> {t(g.status === "invited" ? "breakroom.checkers.cancel" : "breakroom.checkers.resign")}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Score({ side, board, label }: { side: Side; board: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-3 rounded-full border", side === "r" ? "border-[#f59410] bg-grad-gold" : "border-zinc-500 bg-zinc-900")} />
      {label} · {countPieces(board, side)}
    </span>
  );
}

// ── Orbi the Alien ──
function useOrbi() {
  return useQuery({ queryKey: [...GAMES, "orbi"], queryFn: () => api.get<{ channel: string; videos: Video[] }>("/breakroom/videos"), staleTime: 10 * 60_000 });
}
const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const day = (iso: string) =>
  iso ? new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "";

function OrbiTile({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useOrbi();
  const latest = data?.videos[0];
  return (
    <Tile icon={Play} title={t("breakroom.orbi.title")} text={t("breakroom.orbi.text")} accent="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
      {isLoading ? (
        <Skeleton className="aspect-video w-full rounded-xl" />
      ) : latest ? (
        <button type="button" onClick={onOpen} className="group relative block overflow-hidden rounded-xl border text-left">
          <img
            src={thumb(latest.id)}
            alt=""
            className="aspect-video w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-90 transition-opacity group-hover:opacity-100">
            <span className="flex size-14 items-center justify-center rounded-full bg-grad-gold text-[#1a1204] shadow-lg">
              <Play className="ml-1 size-6 fill-current" />
            </span>
          </span>
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 text-sm font-medium text-white">
            {latest.title}
          </span>
        </button>
      ) : (
        <p className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{t("breakroom.orbi.none")}</p>
      )}
      <Button variant="outline" onClick={onOpen} disabled={!latest}>
        <Play className="size-4" /> {t("breakroom.orbi.watch", { count: data?.videos.length ?? 0 })}
      </Button>
    </Tile>
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
        {v && (
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
        )}
        {!v && <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />}
      </DialogContent>
    </Dialog>
  );
}
