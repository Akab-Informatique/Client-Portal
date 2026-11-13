import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, ClipboardList, Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type BotState = "idle" | "working" | "needs_human";
type Bot = { id: string; name: string; key: string; sort: number; state: BotState; label: string | null; since: string };
type Overview = { displayKey: string; labels: string[]; bots: Bot[] };

const QK = ["tv", "bots"] as const;
const STATES: BotState[] = ["working", "idle", "needs_human"];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’-]{0,11}$/u;
const STATE_DOT: Record<BotState, string> = { idle: "bg-muted-foreground", working: "bg-emerald-500", needs_human: "bg-amber-500" };

type Confirm = { title: string; text: string; action: string; run: () => void };

/** Every bot's own links and what to do with them, in one text to paste into each bot's instructions */
function botInstructions(bots: Bot[], labels: string[], origin: string, t: (k: string, o?: Record<string, unknown>) => string) {
  const lines = [t("tv.instructions.head"), "", t("tv.instructions.secret"), "", t("tv.instructions.how"), `- ${t("tv.instructions.working")}`, `- ${t("tv.instructions.idle")}`, `- ${t("tv.instructions.help")}`, t("tv.instructions.answer"), t("tv.instructions.limits"), ""];
  if (labels.length) {
    lines.push(t("tv.instructions.labels"));
    labels.forEach((l, i) => lines.push(`  ${i} = ${l}`));
    lines.push("");
  }
  for (const b of bots) {
    const base = `${origin}/api/tv/r/${b.key}`;
    lines.push(`=== ${b.name} ===`, `${t("tv.instructions.start")} ${base}/working/0`, `${t("tv.instructions.done")} ${base}/idle`, `${t("tv.instructions.needHelp")} ${base}/needs_human`, "");
  }
  return lines.join("\n");
}

function copy(text: string, ok: string, bad: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(ok),
    () => toast.error(bad),
  );
}

export function TvManage({ xmasDay, onXmasDay }: { xmasDay: number; onXmasDay: (d: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [rename, setRename] = useState<Bot | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const q = useQuery({ queryKey: QK, queryFn: () => api.get<Overview>("/tv/bots"), refetchInterval: 15_000 });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
    onError: (e) => toast.error(e instanceof ApiError && e.code === "bot_limit" ? t("tv.limit") : t("tv.error")),
  });

  const origin = window.location.origin;
  const data = q.data;
  const bots = data ? [...data.bots].sort((a, b) => a.sort - b.sort) : [];
  const displayLink = data ? `${origin}/tv/index.html?key=${data.displayKey}` : "";

  const move = (i: number, dir: -1 | 1) => {
    const a = bots[i];
    const b = bots[i + dir];
    if (!a || !b) return;
    // renumber 0..n-1 after the swap (sort values may tie or have gaps)
    const next = bots.map((x) => (x.id === a.id ? b : x.id === b.id ? a : x));
    act.mutate(async () => {
      for (const [n, x] of next.entries()) if (x.sort !== n) await api.patch(`/tv/bots/${x.id}`, { sort: n });
    });
  };

  return (
    <section className="space-y-6 border-t border-border pt-6">
      <div>
        <h2 className="text-lg font-semibold">{t("tv.manage.title")}</h2>
        <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">{t("tv.manage.secret1")}</p>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t("tv.manage.secret2")}</p>
      </div>

      {q.isLoading || !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("tv.display.title")}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Input readOnly value={displayLink} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" aria-label={t("tv.display.title")} />
              <Button variant="outline" size="sm" onClick={() => copy(displayLink, t("tv.copied"), t("tv.error"))}>
                <Copy /> {t("tv.copy")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setConfirm({
                    title: t("tv.display.rotateTitle"),
                    text: t("tv.display.rotateText"),
                    action: t("tv.display.rotate"),
                    run: () => act.mutate(() => api.post("/tv/display-key/rotate")),
                  })
                }
              >
                <RefreshCw /> {t("tv.display.rotate")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("tv.display.hint")}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("tv.bots.title", { count: bots.length })}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={!bots.length} onClick={() => copy(botInstructions(bots, data.labels, origin, t), t("tv.instructions.copied"), t("tv.error"))}>
                  <ClipboardList /> {t("tv.instructions.button")}
                </Button>
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus /> {t("tv.bots.add")}
                </Button>
              </div>
            </div>
            {bots.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("tv.bots.empty")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {bots.map((b, i) => {
                  const isOpen = open === b.id;
                  return (
                    <li key={b.id}>
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <button type="button" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
                          <span className="font-medium">{b.name}</span>
                          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                            <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[b.state])} aria-hidden />
                            <span className="truncate">
                              {t(`tv.state.${b.state}`)}
                              {b.label ? `, ${b.label}` : ""}
                            </span>
                          </span>
                        </button>
                        <div className="flex items-center">
                          <Button variant="ghost" size="icon-sm" disabled={i === 0 || act.isPending} onClick={() => move(i, -1)} aria-label={t("tv.bots.up")}>
                            <ArrowUp />
                          </Button>
                          <Button variant="ghost" size="icon-sm" disabled={i === bots.length - 1 || act.isPending} onClick={() => move(i, 1)} aria-label={t("tv.bots.down")}>
                            <ArrowDown />
                          </Button>
                          <Button variant="ghost" size="icon-sm" onClick={() => setRename(b)} aria-label={t("tv.bots.rename")}>
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("tv.bots.remove")}
                            onClick={() =>
                              setConfirm({
                                title: t("tv.bots.removeTitle", { name: b.name }),
                                text: t("tv.bots.removeText"),
                                action: t("tv.bots.remove"),
                                run: () => act.mutate(() => api.del(`/tv/bots/${b.id}`)),
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                      {isOpen && (
                        <BotLinks
                          bot={b}
                          labels={data.labels}
                          origin={origin}
                          busy={act.isPending}
                          onStatus={(state, label) => act.mutate(() => api.post(`/tv/bots/${b.id}/status`, label ? { state, label } : { state }))}
                          onRotate={() =>
                            setConfirm({
                              title: t("tv.bots.rotateTitle", { name: b.name }),
                              text: t("tv.bots.rotateText"),
                              action: t("tv.bots.rotate"),
                              run: () => act.mutate(() => api.post(`/tv/bots/${b.id}/rotate-key`)),
                            })
                          }
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <XmasCard day={xmasDay} onDay={onXmasDay} />

      <HiddenConsole />

      <NameDialog
        open={adding}
        title={t("tv.bots.add")}
        initial=""
        onClose={() => setAdding(false)}
        onSave={(name) => {
          act.mutate(() => api.post("/tv/bots", { name }));
          setAdding(false);
        }}
      />
      <NameDialog
        open={!!rename}
        title={t("tv.bots.rename")}
        initial={rename?.name ?? ""}
        onClose={() => setRename(null)}
        onSave={(name) => {
          if (rename) act.mutate(() => api.patch(`/tv/bots/${rename.id}`, { name }));
          setRename(null);
        }}
      />
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t("tv.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              {confirm?.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function BotLinks({ bot, labels, origin, busy, onStatus, onRotate }: { bot: Bot; labels: string[]; origin: string; busy: boolean; onStatus: (s: BotState, label?: string) => void; onRotate: () => void }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(0);
  const [forced, setForced] = useState<BotState>("working");
  const base = `${origin}/api/tv/r/${bot.key}`;
  const links: { state: BotState; url: string }[] = [
    { state: "working", url: `${base}/working/${label}` },
    { state: "idle", url: `${base}/idle` },
    { state: "needs_human", url: `${base}/needs_human` },
  ];
  return (
    <div className="space-y-4 bg-muted/30 px-4 py-4 text-sm">
      <div className="space-y-2">
        <h4 className="font-medium">{t("tv.links.title")}</h4>
        {links.map((l) => (
          <div key={l.state} className="grid items-center gap-2 sm:grid-cols-[9rem_1fr_auto]">
            <span className="text-muted-foreground">{t(`tv.state.${l.state}`)}</span>
            <div className="flex min-w-0 items-center gap-2">
              {l.state === "working" && labels.length > 0 && (
                <select value={label} onChange={(e) => setLabel(Number(e.target.value))} aria-label={t("tv.links.label")} className="h-9 max-w-[14rem] shrink-0 rounded-md border border-input bg-background px-2 text-sm">
                  {labels.map((x, i) => (
                    <option key={x} value={i}>
                      {x}
                    </option>
                  ))}
                </select>
              )}
              <Input readOnly value={l.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 font-mono text-xs" aria-label={t(`tv.state.${l.state}`)} />
            </div>
            <Button variant="outline" size="sm" onClick={() => copy(l.url, t("tv.copied"), t("tv.error"))}>
              <Copy /> {t("tv.copy")}
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={onRotate}>
          <RefreshCw /> {t("tv.bots.rotate")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("tv.override.title")}</span>
        <select value={forced} onChange={(e) => setForced(e.target.value as BotState)} aria-label={t("tv.override.title")} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          {STATES.map((s) => (
            <option key={s} value={s}>
              {t(`tv.state.${s}`)}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={busy} onClick={() => onStatus(forced, forced === "working" ? labels[label] : undefined)}>
          {t("tv.override.apply")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("tv.override.hint")}</span>
      </div>
    </div>
  );
}

function NameDialog({ open, title, initial, onClose, onSave }: { open: boolean; title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if (open) setName(initial);
  }
  const clean = name.trim();
  const valid = NAME_RE.test(clean);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSave(clean);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t("tv.bots.nameRule")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="tv-bot-name" className="text-sm font-medium">
              {t("tv.bots.name")}
            </label>
            <Input id="tv-bot-name" value={name} maxLength={12} autoFocus onChange={(e) => setName(e.target.value)} aria-invalid={clean.length > 0 && !valid} />
            {clean.length > 0 && !valid && <p className="text-sm text-destructive">{t("tv.bots.nameRule")}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("tv.cancel")}
            </Button>
            <Button type="submit" disabled={!valid}>
              {t("tv.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A tiny terminal line at the very bottom: no label, no help. */
function HiddenConsole() {
  const { t } = useTranslation();
  const [line, setLine] = useState("");
  const [out, setOut] = useState("");
  const run = async () => {
    const cmd = line.trim().toLowerCase();
    setLine("");
    const m = /^([a-z]{1,40})\.exe$/.exec(cmd);
    if (!m || m[1] !== "camille") {
      setOut(t("tv.console.unknown"));
      return;
    }
    try {
      await api.post("/tv/easter", { name: m[1] });
      setOut(t("tv.console.ok"));
    } catch {
      setOut(t("tv.console.denied"));
    }
  };
  return (
    <div className="pt-6 font-mono text-xs">
      <input
        value={line}
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void run();
        }}
        placeholder="> _"
        spellCheck={false}
        autoComplete="off"
        aria-label=">"
        className="w-full bg-transparent text-muted-foreground outline-none placeholder:text-muted-foreground/40"
      />
      {out && <div className="text-muted-foreground/70">{out}</div>}
    </div>
  );
}

const DAYS = Array.from({ length: 25 }, (_, i) => i + 1);

/** The 25 aubaines of Octet's Christmas campaign, and a preview of any day on the screen above */
function XmasCard({ day, onDay }: { day: number; onDay: (d: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tv", "aubaines"], queryFn: () => api.get<{ aubaines: Record<string, string> }>("/tv/aubaines") });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const values = draft ?? q.data?.aubaines ?? {};
  const save = useMutation({
    mutationFn: () => api.put<{ aubaines: Record<string, string> }>("/tv/aubaines", { aubaines: values }),
    onSuccess: (r) => {
      qc.setQueryData(["tv", "aubaines"], r);
      setDraft(null);
      toast.success(t("tv.xmas.saved"));
    },
    onError: () => toast.error(t("tv.error")),
  });
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t("tv.xmas.title")}</h3>
        <p className="max-w-[65ch] text-xs text-muted-foreground">{t("tv.xmas.hint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="tv-xmas-day" className="text-sm">
          {t("tv.xmas.preview")}
        </label>
        <select id="tv-xmas-day" value={day} onChange={(e) => onDay(Number(e.target.value))} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          <option value={0}>{t("tv.xmas.previewOff")}</option>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {t("tv.xmas.previewDay", { day: d })}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {DAYS.map((d) => (
            <label key={d} className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("tv.xmas.day", { day: d })}</span>
              <Input value={values[String(d)] ?? ""} maxLength={80} placeholder={t("tv.xmas.placeholder")} onChange={(e) => setDraft({ ...values, [String(d)]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <Button size="sm" disabled={!draft || save.isPending} onClick={() => save.mutate()}>
        {t("tv.xmas.save")}
      </Button>
    </div>
  );
}
