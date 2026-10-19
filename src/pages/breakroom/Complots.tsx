import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Anchor,
  Axe,
  Check,
  ChevronRight,
  Coins,
  Crown,
  Eye,
  Flag,
  HandCoins,
  Landmark,
  Loader2,
  Play,
  Plus,
  Scale,
  ScrollText,
  ShieldCheck,
  Skull,
  Sparkles,
  Swords,
  Trophy,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LogoMark } from "@/components/brand/Logo";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";

/**
 * Complots in the coffee break: a table of 2 to 6 colleagues. The server
 * holds the game (each one sees only their own cards); this page shows it
 * and sends the moves. Custom cards: each character in its clan's colour.
 */

type CharKey = "duchesse" | "assassin" | "comtesse" | "capitaine" | "ambassadeur" | "inquisiteur" | "bourreau" | "justicier";
type Clan = "perceptrices" | "assassins" | "intouchables" | "voleurs" | "negociateurs";
type ActionKind = "income" | "aid" | "coup" | "tax" | "assassinate" | "steal" | "exchange" | "inquire" | "execute" | "justice";
type Seat = { id: string; name: string; answer: "yes" | "no" | null };
type Card = { c: CharKey | null; up: boolean };
type View = {
  chars: CharKey[];
  court: number;
  players: { id: string; name: string; coins: number; alive: boolean; cards: Card[] }[];
  turn: string | null;
  act: { kind: ActionKind; actor: string; target?: string; claim?: CharKey } | null;
  block: { by: string; claim: CharKey } | null;
  phase: {
    k: "draft" | "turn" | "respond" | "lose" | "exchange" | "show" | "judge" | "over" | "busy";
    who: string | null;
    stage: "action" | "blockOnly" | "block" | null;
    waiting: string[];
    leftMs: number;
    options: CharKey[] | null;
    keep: number | null;
    picked: boolean | null;
    shown: { target: string; c: CharKey } | null;
  };
  you: { canAct: boolean; mustCoup: boolean; canPass: boolean; canChallenge: boolean; blockWith: CharKey[] } | null;
  winner: string | null;
  log: { k: string; p?: string; t?: string; c?: CharKey; n?: number; at: number }[];
};
type Table = { id: string; status: "lobby" | "playing" | "done" | "cancelled"; isHost: boolean; seats: Seat[]; chars: CharKey[]; winnerId: string | null; game: View | null };
type Summary = { id: string; status: Table["status"]; isHost: boolean; host: string; seats: Seat[]; invited: boolean; myMove: boolean; winnerId: string | null };

const KEY = ["breakroom", "complots"] as const;

export const CHAR: Record<CharKey, { clan: Clan; icon: ComponentType<{ className?: string }> }> = {
  duchesse: { clan: "perceptrices", icon: Crown },
  assassin: { clan: "assassins", icon: Skull },
  bourreau: { clan: "assassins", icon: Axe },
  comtesse: { clan: "intouchables", icon: ShieldCheck },
  capitaine: { clan: "voleurs", icon: Anchor },
  justicier: { clan: "voleurs", icon: Scale },
  ambassadeur: { clan: "negociateurs", icon: ScrollText },
  inquisiteur: { clan: "negociateurs", icon: Eye },
};
const CLANS: Clan[] = ["perceptrices", "assassins", "intouchables", "voleurs", "negociateurs"];
const CLAN_CHARS: Record<Clan, CharKey[]> = {
  perceptrices: ["duchesse"],
  assassins: ["assassin", "bourreau"],
  intouchables: ["comtesse"],
  voleurs: ["capitaine", "justicier"],
  negociateurs: ["ambassadeur", "inquisiteur"],
};
/** The clans' colours (those of the game): face, edge, glow */
const CLAN_STYLE: Record<Clan, { face: string; edge: string; text: string; glow: string }> = {
  perceptrices: { face: "from-pink-500/35 via-pink-900/40 to-[#160b12]", edge: "border-pink-400/60", text: "text-pink-200", glow: "shadow-[0_10px_30px_-12px_rgba(236,72,153,0.7)]" },
  assassins: { face: "from-emerald-500/35 via-emerald-900/40 to-[#08130e]", edge: "border-emerald-400/60", text: "text-emerald-200", glow: "shadow-[0_10px_30px_-12px_rgba(16,185,129,0.7)]" },
  intouchables: { face: "from-amber-400/40 via-amber-900/40 to-[#161006]", edge: "border-amber-300/70", text: "text-amber-100", glow: "shadow-[0_10px_30px_-12px_rgba(251,191,36,0.7)]" },
  voleurs: { face: "from-sky-500/35 via-sky-900/40 to-[#07101a]", edge: "border-sky-400/60", text: "text-sky-200", glow: "shadow-[0_10px_30px_-12px_rgba(56,189,248,0.7)]" },
  negociateurs: { face: "from-red-500/35 via-red-900/40 to-[#170809]", edge: "border-red-400/60", text: "text-red-200", glow: "shadow-[0_10px_30px_-12px_rgba(239,68,68,0.7)]" },
};
/** The action each character announces */
const ACTION_OF: Partial<Record<CharKey, ActionKind[]>> = {
  duchesse: ["tax"],
  assassin: ["assassinate"],
  capitaine: ["steal"],
  ambassadeur: ["exchange"],
  inquisiteur: ["exchange", "inquire"],
  bourreau: ["execute"],
  justicier: ["justice"],
};
const TARGETED: ActionKind[] = ["coup", "assassinate", "steal", "inquire", "execute", "justice"];
const COST: Partial<Record<ActionKind, number>> = { coup: 7, assassinate: 3, execute: 3 };
const PRESETS: { key: string; chars: CharKey[] }[] = [
  { key: "classic", chars: ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"] },
  { key: "inquisitor", chars: ["duchesse", "assassin", "comtesse", "capitaine", "inquisiteur"] },
  { key: "v2", chars: ["duchesse", "bourreau", "comtesse", "justicier", "ambassadeur"] },
];

const errorText = (t: (k: string, o?: Record<string, unknown>) => string, e: unknown) => {
  const code = e instanceof ApiError ? e.code : "";
  return t(`breakroom.complots.errors.${code}`, { defaultValue: t("common.error") });
};

// ── The tile ──
export function ComplotsTile({ onOpen, online }: { onOpen: (id: string) => void; online: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const tables = useQuery({ queryKey: KEY, queryFn: () => api.get<Summary[]>("/breakroom/complots"), refetchInterval: 5_000 });
  const respond = useMutation({
    mutationFn: (p: { id: string; accept: boolean }) => api.post<Table>(`/breakroom/complots/${p.id}/respond`, { accept: p.accept }),
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: KEY });
      if (p.accept) onOpen(r.id);
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const list = tables.data ?? [];
  const invitations = list.filter((x) => x.invited);
  const mine = list.filter((x) => !x.invited);
  return (
    <section className="glass relative flex flex-col overflow-hidden rounded-3xl border lg:col-span-2">
      <span aria-hidden className="pointer-events-none absolute -right-24 -top-16 h-72 w-72 bg-[radial-gradient(circle,rgba(236,72,153,0.14),transparent_70%)]" />
      <div className="relative grid flex-1 gap-6 p-6 md:grid-cols-[minmax(0,240px)_1fr]">
        {/* a fan of the five clans */}
        <div className="relative mx-auto h-48 w-60 self-start" aria-hidden>
          {(["perceptrices", "voleurs", "assassins", "negociateurs", "intouchables"] as Clan[]).map((clan, i) => {
            const char = CLAN_CHARS[clan][0];
            return (
              <div key={clan} className="absolute left-1/2 top-2 origin-bottom" style={{ transform: `translateX(calc(-50% + ${(i - 2) * 34}px)) translateY(${Math.abs(i - 2) * 8}px) rotate(${(i - 2) * 9}deg)` }}>
                <CharCard c={char} size="sm" />
              </div>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-pink-300">{t("breakroom.complots.kicker")}</p>
            <h2 className="font-display text-2xl font-semibold">{t("breakroom.complots.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("breakroom.complots.text")}</p>
          </div>
          {invitations.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-2xl border border-pink-400/50 bg-pink-500/10 px-3 py-2.5 text-sm">
              <Sparkles className="size-4 shrink-0 text-pink-300" />
              <span className="min-w-0 flex-1 truncate">{t("breakroom.complots.invitedBy", { name: g.host })}</span>
              <Button size="sm" className="h-8 bg-grad-gold font-semibold text-[#1a1204]" disabled={respond.isPending} onClick={() => respond.mutate({ id: g.id, accept: true })}>
                <Check className="size-3.5" /> {t("breakroom.complots.join")}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" disabled={respond.isPending} onClick={() => respond.mutate({ id: g.id, accept: false })} aria-label={t("breakroom.complots.decline")}>
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          {mine.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {mine.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onOpen(g.id)}
                  className={cn("flex items-center gap-2.5 rounded-2xl border px-3 py-2 text-left text-sm transition-colors hover:border-pink-400/50 hover:bg-accent/40", g.myMove && "border-pink-400/60")}
                >
                  <Users className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{g.seats.filter((s) => s.answer !== "no").map((s) => s.name.split(" ")[0]).join(", ")}</span>
                    <span className={cn("block text-[11px]", g.myMove ? "font-semibold text-pink-300" : "text-muted-foreground")}>
                      {g.status === "lobby" ? t("breakroom.complots.lobby") : g.status === "done" ? t("breakroom.complots.finished") : g.myMove ? t("breakroom.complots.yourMove") : t("breakroom.complots.playing")}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
          <div>
            <Button className="gap-1.5 bg-grad-gold font-semibold text-[#1a1204]" onClick={() => setCreating(true)} disabled={!online.length}>
              <Plus className="size-4" /> {t("breakroom.complots.new")}
            </Button>
            {!online.length && <p className="mt-1.5 text-xs text-muted-foreground">{t("breakroom.complots.nobody")}</p>}
          </div>
        </div>
      </div>
      {creating && (
        <NewTable
          online={online}
          onClose={() => setCreating(false)}
          onMade={(id) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: KEY });
            onOpen(id);
          }}
        />
      )}
    </section>
  );
}

/** Who plays, and which character of each clan */
function NewTable({ online, onClose, onMade }: { online: { id: string; name: string }[]; onClose: () => void; onMade: (id: string) => void }) {
  const { t } = useTranslation();
  const [invite, setInvite] = useState<string[]>([]);
  const [chars, setChars] = useState<CharKey[]>(PRESETS[0].chars);
  const make = useMutation({
    mutationFn: () => api.post<Table>("/breakroom/complots", { invite, chars }),
    onSuccess: (r) => onMade(r.id),
    onError: (e) => toast.error(errorText(t, e)),
  });
  const pick = (clan: Clan, c: CharKey) => setChars((cur) => [...cur.filter((x) => CHAR[x].clan !== clan), c]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Swords className="size-5 text-primary" /> {t("breakroom.complots.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("breakroom.complots.newText")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.complots.players", { count: invite.length + 1 })}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {online.map((p) => {
                const on = invite.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!on && invite.length >= 5}
                    onClick={() => setInvite((l) => (on ? l.filter((x) => x !== p.id) : [...l, p.id]))}
                    className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm disabled:opacity-40", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "hover:bg-accent/40")}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(p.name)}</span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {on ? <Check className="size-4 text-primary" /> : <UserPlus className="size-4 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.complots.characters")}</p>
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setChars(p.chars)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px]",
                    p.chars.every((c) => chars.includes(c)) ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`breakroom.complots.preset.${p.key}`)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {CLANS.map((clan) => (
                <div key={clan} className="space-y-1.5 text-center">
                  {CLAN_CHARS[clan].map((c) => (
                    <button key={c} type="button" onClick={() => pick(clan, c)} className={cn("mx-auto block transition", chars.includes(c) ? "scale-100 opacity-100" : "scale-95 opacity-40 hover:opacity-80")} aria-pressed={chars.includes(c)}>
                      <CharCard c={c} size="sm" />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!invite.length || make.isPending} onClick={() => make.mutate()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {make.isPending ? <Loader2 className="size-4 animate-spin" /> : <Swords className="size-4" />} {t("breakroom.complots.send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── The cards ──
const SIZES = { xs: "h-14 w-10", sm: "h-[96px] w-[70px]", md: "h-[132px] w-[94px]", lg: "h-[176px] w-[126px]" } as const;

/** A character card (face), in its clan's colours */
export function CharCard({ c, size = "md", lost, selected, className }: { c: CharKey; size?: keyof typeof SIZES; lost?: boolean; selected?: boolean; className?: string }) {
  const { t } = useTranslation();
  const { clan, icon: Icon } = CHAR[c];
  const st = CLAN_STYLE[clan];
  const big = size === "md" || size === "lg";
  return (
    <div
      className={cn(
        "relative flex shrink-0 flex-col items-center justify-between overflow-hidden rounded-xl border-2 bg-gradient-to-b p-1.5 text-center",
        SIZES[size],
        st.face,
        st.edge,
        !lost && st.glow,
        lost && "opacity-45 grayscale",
        selected && "ring-2 ring-[color:var(--gold)] ring-offset-2 ring-offset-background",
        className,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,0.18),transparent_60%)]" />
      <span className={cn("relative font-semibold uppercase tracking-wider", big ? "text-[9px]" : "text-[7px]", st.text)}>{t(`breakroom.complots.clan.${clan}`)}</span>
      <span className={cn("relative flex items-center justify-center rounded-full border border-white/20 bg-black/30", big ? "size-12" : size === "sm" ? "size-8" : "size-6")}>
        <Icon className={cn(st.text, big ? "size-6" : size === "sm" ? "size-4" : "size-3")} />
      </span>
      <span className={cn("relative max-w-full font-display font-semibold leading-tight tracking-tight text-white", big ? "text-sm" : size === "sm" ? "text-[9px]" : "text-[7px]")}>{t(`breakroom.complots.char.${c}.name`)}</span>
      {size === "lg" && <span className="relative text-[9px] leading-snug text-white/75">{t(`breakroom.complots.char.${c}.power`)}</span>}
      {lost && <Skull className="absolute right-1 top-1 size-3.5 text-white/80" />}
    </div>
  );
}

/** The back of a card: hidden */
function CardBack({ size = "md" }: { size?: keyof typeof SIZES }) {
  return (
    <div className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-[color:var(--gold)]/40 bg-[#111114]", SIZES[size])}>
      <span aria-hidden className="absolute inset-1 rounded-lg border border-[color:var(--gold)]/20 bg-[repeating-linear-gradient(45deg,rgba(255,206,26,0.06)_0_6px,transparent_6px_12px)]" />
      <LogoMark className={cn("relative opacity-80", size === "xs" ? "h-4" : size === "sm" ? "h-6" : "h-9")} />
    </div>
  );
}

// ── The table ──
export function ComplotsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: [...KEY, id], queryFn: () => api.get<Table>(`/breakroom/complots/${id}`), refetchInterval: 1_500 });
  const put = (r: Table) => qc.setQueryData([...KEY, id], r);
  const send = useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<Table>(`/breakroom/complots/${id}/play`, { input }),
    onSuccess: put,
    onError: (e) => {
      toast.error(errorText(t, e));
      void q.refetch();
    },
  });
  const start = useMutation({ mutationFn: () => api.post<Table>(`/breakroom/complots/${id}/start`), onSuccess: put, onError: (e) => toast.error(errorText(t, e)) });
  const leave = useMutation({
    mutationFn: () => api.post<Table>(`/breakroom/complots/${id}/leave`),
    onSuccess: (r) => {
      put(r);
      void qc.invalidateQueries({ queryKey: KEY });
      if (r.status !== "playing" && r.status !== "done") onClose();
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const table = q.data;
  const g = table?.game ?? null;
  const name = (pid?: string | null) => g?.players.find((p) => p.id === pid)?.name ?? table?.seats.find((s) => s.id === pid)?.name ?? "";
  const [pending, setPending] = useState<{ kind: ActionKind; claim?: CharKey } | null>(null);
  useEffect(() => setPending(null), [g?.turn, g?.phase.k]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(94dvh,62rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-3">
          <Swords className="size-5 text-pink-300" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-display">{t("breakroom.complots.title")}</DialogTitle>
            <DialogDescription className="text-xs">{table ? table.chars.map((c) => t(`breakroom.complots.char.${c}.name`)).join(" · ") : "…"}</DialogDescription>
          </div>
          {table && (table.status === "playing" || table.status === "lobby") && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground hover:text-destructive"
              disabled={leave.isPending}
              onClick={() =>
                void confirm({ title: t(table.status === "lobby" && table.isHost ? "breakroom.complots.cancelConfirm" : "breakroom.complots.leaveConfirm"), destructive: true }).then((ok) => ok && leave.mutate())
              }
            >
              <Flag className="size-3.5" /> {t(table.status === "lobby" && table.isHost ? "breakroom.complots.cancel" : "breakroom.complots.leave")}
            </Button>
          )}
        </DialogHeader>
        {!table ? (
          <div className="flex flex-1 items-center justify-center p-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : table.status === "lobby" ? (
          <Lobby table={table} starting={start.isPending} onStart={() => start.mutate()} />
        ) : table.status === "cancelled" ? (
          <p className="p-10 text-center text-sm text-muted-foreground">{t("breakroom.complots.cancelled")}</p>
        ) : g ? (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_280px]">
            <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
              <Opponents
                g={g}
                me={me.id}
                pickTarget={pending && TARGETED.includes(pending.kind) ? (pid) => send.mutate({ t: "action", kind: pending.kind, target: pid, claim: pending.claim }) : null}
              />
              <Center g={g} name={name} me={me.id} />
              <Answer g={g} busy={send.isPending} send={(input) => send.mutate(input)} />
              <Mine g={g} me={me.id} busy={send.isPending} send={(input) => send.mutate(input)} pending={pending} setPending={setPending} />
            </div>
            <aside className="flex min-h-0 flex-col border-t bg-foreground/[0.02] lg:border-l lg:border-t-0">
              <Guide chars={g.chars} />
              <Log g={g} name={name} />
            </aside>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Lobby({ table, starting, onStart }: { table: Table; starting: boolean; onStart: () => void }) {
  const { t } = useTranslation();
  const yes = table.seats.filter((s) => s.answer === "yes").length;
  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap justify-center gap-2">
        {table.chars.map((c) => (
          <CharCard key={c} c={c} size="lg" />
        ))}
      </div>
      <ul className="mx-auto grid max-w-xl gap-2 sm:grid-cols-2">
        {table.seats.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
            <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(s.name)}</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className={cn("text-[11px]", s.answer === "yes" ? "text-emerald-300" : s.answer === "no" ? "text-red-300" : "text-muted-foreground")}>
              {t(`breakroom.complots.answer.${s.answer ?? "waiting"}`)}
            </span>
          </li>
        ))}
      </ul>
      <div className="text-center">
        {table.isHost ? (
          <Button disabled={yes < 2 || starting} onClick={onStart} className="gap-1.5 bg-grad-gold font-semibold text-[#1a1204]">
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {t("breakroom.complots.start", { count: yes })}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t("breakroom.complots.waitHost")}</p>
        )}
      </div>
    </div>
  );
}

/** The others: their gold, their cards (backs, or the ones lost) */
function Opponents({ g, me, pickTarget }: { g: View; me: string; pickTarget: ((id: string) => void) | null }) {
  const { t } = useTranslation();
  const others = g.players.filter((p) => p.id !== me);
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {others.map((p) => {
        const turn = g.turn === p.id && g.phase.k !== "over";
        const answering = g.phase.waiting.includes(p.id) || (g.phase.who === p.id && g.phase.k !== "turn");
        const can = pickTarget && p.alive;
        return (
          <button
            key={p.id}
            type="button"
            disabled={!can}
            onClick={() => can && pickTarget!(p.id)}
            className={cn(
              "relative flex min-w-44 flex-col items-center gap-2 rounded-2xl border bg-background/40 px-3 pb-3 pt-2 transition",
              turn && "border-[color:var(--gold)]/70 shadow-[0_0_24px_-8px_rgba(255,206,26,0.6)]",
              !p.alive && "opacity-50",
              can && "cursor-pointer border-pink-400/70 ring-2 ring-pink-400/40 hover:-translate-y-0.5",
            )}
          >
            <span className="flex w-full items-center gap-2 text-sm">
              <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(p.name)}</span>
              <span className="min-w-0 flex-1 truncate text-left font-medium">{p.name}</span>
              <span className="flex items-center gap-1 font-mono text-sm text-primary">
                <Coins className="size-3.5" /> {p.coins}
              </span>
            </span>
            <span className="flex gap-1.5">{p.cards.map((c, i) => (c.c ? <CharCard key={i} c={c.c} size="sm" lost={c.up} /> : <CardBack key={i} size="sm" />))}</span>
            {(turn || answering || !p.alive) && (
              <span className={cn("absolute -top-2 right-2 rounded-full border px-1.5 text-[10px]", !p.alive ? "bg-background text-muted-foreground" : "border-[color:var(--gold)]/50 bg-background text-primary")}>
                {!p.alive ? t("breakroom.complots.out") : turn && g.phase.k === "turn" ? t("breakroom.complots.theirTurn") : t("breakroom.complots.thinking")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** What is going on: the announcement, the block, the timer */
function Center({ g, name, me }: { g: View; name: (id?: string | null) => string; me: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const [base, setBase] = useState({ at: Date.now(), left: g.phase.leftMs });
  useEffect(() => setBase({ at: Date.now(), left: g.phase.leftMs }), [g.phase.leftMs, g.phase.k, g.phase.who, g.phase.stage]);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, []);
  const left = Math.max(0, base.left - (now - base.at));
  const total = g.phase.k === "respond" ? 15_000 : g.phase.k === "turn" ? 90_000 : g.phase.k === "exchange" || g.phase.k === "draft" ? 45_000 : 30_000;
  const a = g.act;
  if (g.phase.k === "over")
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 p-6 text-center">
        <Trophy className="size-8 text-primary" />
        <p className="font-display text-2xl font-semibold">{g.winner === me ? t("breakroom.complots.youWon") : t("breakroom.complots.won", { name: name(g.winner) })}</p>
      </div>
    );
  const whose = g.phase.k === "turn" ? g.turn : g.phase.who;
  return (
    <div className="space-y-2 rounded-2xl border bg-foreground/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Landmark className="size-3.5" /> {t("breakroom.complots.court", { count: g.court })}
        </span>
        <span className="flex-1" />
        {whose && (
          <span>
            {g.phase.k === "respond"
              ? t("breakroom.complots.waitingFor", { count: g.phase.waiting.length })
              : g.phase.k === "draft"
                ? t("breakroom.complots.drafting")
                : t(`breakroom.complots.phase.${g.phase.k}`, { name: whose === me ? t("breakroom.complots.you") : name(whose) })}
          </span>
        )}
      </div>
      {a && g.phase.k !== "turn" && g.phase.k !== "draft" ? (
        <p className="text-sm">
          <ActText a={a} name={name} />
          {g.block && (
            <span className="ml-1 text-pink-200">
              — {t("breakroom.complots.blockedBy", { name: name(g.block.by), char: t(`breakroom.complots.char.${g.block.claim}.name`) })}
            </span>
          )}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{g.phase.k === "draft" ? t("breakroom.complots.draftText") : t("breakroom.complots.turnText", { name: g.turn === me ? t("breakroom.complots.you") : name(g.turn) })}</p>
      )}
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-[width] duration-200", left / total < 0.25 ? "bg-red-400" : "bg-grad-gold")} style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
    </div>
  );
}

function ActText({ a, name }: { a: NonNullable<View["act"]>; name: (id?: string | null) => string }) {
  const { t } = useTranslation();
  return <span>{t(`breakroom.complots.log.act.${a.kind}`, { p: name(a.actor), t: name(a.target), c: a.claim ? t(`breakroom.complots.char.${a.claim}.name`) : "" })}</span>;
}

/** My answer to an announcement: let it go, call it, or block it */
function Answer({ g, busy, send }: { g: View; busy: boolean; send: (input: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const y = g.you;
  if (!y?.canPass) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-pink-400/50 bg-pink-500/10 px-4 py-3">
      <span className="mr-2 text-sm font-medium">{g.phase.stage === "block" ? t("breakroom.complots.answerBlock") : t("breakroom.complots.answerAct")}</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => send({ t: "pass" })}>
        <Check className="size-3.5" /> {t("breakroom.complots.pass")}
      </Button>
      {y.canChallenge && (
        <Button size="sm" disabled={busy} onClick={() => send({ t: "challenge" })} className="bg-red-600 text-white hover:bg-red-500">
          <Eye className="size-3.5" /> {t("breakroom.complots.challenge")}
        </Button>
      )}
      {y.blockWith.map((c) => (
        <Button key={c} size="sm" disabled={busy} onClick={() => send({ t: "block", claim: c })} className="bg-grad-gold font-semibold text-[#1a1204]">
          <ShieldCheck className="size-3.5" /> {t("breakroom.complots.blockWith", { char: t(`breakroom.complots.char.${c}.name`) })}
        </Button>
      ))}
    </div>
  );
}

/** My hand, my gold, and what I may do now */
function Mine({
  g,
  me,
  busy,
  send,
  pending,
  setPending,
}: {
  g: View;
  me: string;
  busy: boolean;
  send: (input: Record<string, unknown>) => void;
  pending: { kind: ActionKind; claim?: CharKey } | null;
  setPending: (p: { kind: ActionKind; claim?: CharKey } | null) => void;
}) {
  const { t } = useTranslation();
  const p = g.players.find((x) => x.id === me);
  const [keep, setKeep] = useState<number[]>([]);
  useEffect(() => setKeep([]), [g.phase.k, g.phase.options?.join()]);
  const ph = g.phase;
  if (!p) return null;
  const mine = (c: CharKey) => p.cards.some((x) => !x.up && x.c === c);
  const choosing = ph.who === me && (ph.k === "lose" || ph.k === "show");
  const actions: { kind: ActionKind; claim?: CharKey; label: string; cost?: number }[] = [
    { kind: "income", label: t("breakroom.complots.do.income") },
    { kind: "aid", label: t("breakroom.complots.do.aid") },
    { kind: "coup", label: t("breakroom.complots.do.coup"), cost: 7 },
    ...g.chars.flatMap((c) => (ACTION_OF[c] ?? []).map((kind) => ({ kind, claim: c, label: t(`breakroom.complots.do.${kind}`, { char: t(`breakroom.complots.char.${c}.name`) }), cost: COST[kind] }))),
  ];
  const act = (a: (typeof actions)[number]) => {
    if (TARGETED.includes(a.kind)) setPending({ kind: a.kind, claim: a.claim });
    else send({ t: "action", kind: a.kind, claim: a.claim });
  };
  return (
    <div className="space-y-3 rounded-2xl border bg-background/40 p-4">
      <div className="flex flex-wrap items-end justify-center gap-4">
        <div className="flex gap-3">
          {p.cards.map((c, i) => (
            <button
              key={i}
              type="button"
              disabled={!choosing || c.up || busy}
              onClick={() => send({ t: ph.k === "lose" ? "lose" : "show", index: i })}
              className={cn("transition", choosing && !c.up && "cursor-pointer hover:-translate-y-1")}
              aria-label={c.c ? t(`breakroom.complots.char.${c.c}.name`) : ""}
            >
              {c.c && <CharCard c={c.c} size="lg" lost={c.up} className={cn(choosing && !c.up && "ring-2 ring-pink-400/60")} />}
            </button>
          ))}
        </div>
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("breakroom.complots.yourGold")}</p>
          <p className="flex items-center gap-1.5 font-display text-3xl font-semibold text-primary">
            <Coins className="size-6" /> {p.coins}
          </p>
          {!p.alive && <p className="text-xs text-muted-foreground">{t("breakroom.complots.youAreOut")}</p>}
        </div>
      </div>

      {choosing && <p className="text-center text-sm font-medium text-pink-200">{t(ph.k === "lose" ? "breakroom.complots.chooseLose" : "breakroom.complots.chooseShow")}</p>}

      {/* 2 players: one card from the full set */}
      {ph.k === "draft" && ph.options && !ph.picked && (
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium">{t("breakroom.complots.draftPick")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {ph.options.map((c) => (
              <button key={c} type="button" disabled={busy} onClick={() => send({ t: "draft", char: c })} className="transition hover:-translate-y-1">
                <CharCard c={c} size="md" />
              </button>
            ))}
          </div>
        </div>
      )}

      {ph.k === "exchange" && ph.who === me && ph.options && (
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium">{t("breakroom.complots.exchangeText", { count: ph.keep ?? 0 })}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {ph.options.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setKeep((k) => (k.includes(i) ? k.filter((x) => x !== i) : k.length < (ph.keep ?? 0) ? [...k, i] : k))}
                className="transition hover:-translate-y-1"
              >
                <CharCard c={c} size="md" selected={keep.includes(i)} />
              </button>
            ))}
          </div>
          <Button disabled={keep.length !== ph.keep || busy} onClick={() => send({ t: "exchange", keep })} className="bg-grad-gold font-semibold text-[#1a1204]">
            <Check className="size-4" /> {t("breakroom.complots.keep")}
          </Button>
        </div>
      )}

      {ph.k === "judge" && ph.who === me && ph.shown && (
        <div className="space-y-2 text-center">
          <div className="flex justify-center">
            <CharCard c={ph.shown.c} size="md" />
          </div>
          <div className="flex justify-center gap-2">
            <Button variant="outline" disabled={busy} onClick={() => send({ t: "judge", replace: false })}>
              {t("breakroom.complots.giveBack")}
            </Button>
            <Button disabled={busy} onClick={() => send({ t: "judge", replace: true })} className="bg-grad-gold font-semibold text-[#1a1204]">
              {t("breakroom.complots.replace")}
            </Button>
          </div>
        </div>
      )}

      {g.you?.canAct && (
        <div className="space-y-2">
          {pending ? (
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="font-medium text-pink-200">{t("breakroom.complots.pickTarget")}</span>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-center gap-1.5">
              {actions.map((a) => {
                const short = (a.cost ?? 0) > p.coins;
                const locked = g.you!.mustCoup && a.kind !== "coup";
                const truth = a.claim ? mine(a.claim) : true;
                return (
                  <Button
                    key={`${a.kind}-${a.claim ?? ""}`}
                    size="sm"
                    variant="outline"
                    disabled={busy || short || locked}
                    onClick={() => act(a)}
                    className={cn("h-9 gap-1.5", a.claim && CLAN_STYLE[CHAR[a.claim].clan].edge, a.claim && !truth && "border-dashed")}
                    title={a.claim && !truth ? t("breakroom.complots.bluffHint") : undefined}
                  >
                    {a.kind === "income" ? <Coins className="size-3.5" /> : a.kind === "aid" ? <HandCoins className="size-3.5" /> : a.kind === "coup" ? <Swords className="size-3.5" /> : null}
                    {a.claim && (() => {
                      const I = CHAR[a.claim].icon;
                      return <I className={cn("size-3.5", CLAN_STYLE[CHAR[a.claim].clan].text)} />;
                    })()}
                    {a.label}
                    {a.claim && !truth && <span className="text-[10px] text-muted-foreground">({t("breakroom.complots.bluff")})</span>}
                  </Button>
                );
              })}
            </div>
          )}
          {g.you.mustCoup && <p className="text-center text-xs text-orange-300">{t("breakroom.complots.mustCoup")}</p>}
        </div>
      )}
    </div>
  );
}

/** The five characters of this game and what they do */
function Guide({ chars }: { chars: CharKey[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5 border-b p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.complots.guide")}</p>
      <ul className="space-y-1.5">
        {chars.map((c) => {
          const { clan, icon: I } = CHAR[c];
          return (
            <li key={c} className="flex gap-2 text-[11px] leading-snug">
              <I className={cn("mt-0.5 size-3.5 shrink-0", CLAN_STYLE[clan].text)} />
              <span>
                <span className="font-semibold">{t(`breakroom.complots.char.${c}.name`)}</span> — {t(`breakroom.complots.char.${c}.power`)}
                {t(`breakroom.complots.char.${c}.counter`, { defaultValue: "" }) && <span className="block text-muted-foreground">{t(`breakroom.complots.char.${c}.counter`)}</span>}
              </span>
            </li>
          );
        })}
        <li className="pt-1 text-[11px] text-muted-foreground">{t("breakroom.complots.guideBase")}</li>
      </ul>
    </div>
  );
}

function Log({ g, name }: { g: View; name: (id?: string | null) => string }) {
  const { t } = useTranslation();
  const items = useMemo(() => [...g.log].reverse(), [g.log]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("breakroom.complots.history")}</p>
      <ol className="space-y-1">
        {items.map((e, i) => (
          <li key={`${e.at}-${i}`} className={cn("text-[11px] leading-snug", i === 0 ? "text-foreground" : "text-muted-foreground")}>
            {t(`breakroom.complots.log.${e.k}`, { p: name(e.p), t: name(e.t), c: e.c ? t(`breakroom.complots.char.${e.c}.name`) : "", n: e.n ?? 0, defaultValue: e.k })}
          </li>
        ))}
      </ol>
    </div>
  );
}
