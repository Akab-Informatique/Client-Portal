import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, Check, ChevronDown, Clock, Loader2, Lock, Mail, MessagesSquare, Minus, Pause, Play, Send, StickyNote, Square, Trash2, X } from "lucide-react";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import { shortDateTime } from "@/pages/tickets/shared";
import { RecipientInput } from "@/pages/outlook/RecipientInput";
import { clock, KEY, useProjectPeople, TASK_STATUSES, TASK_STYLE, today, type Milestone, type ProjectDetail, type TaskStatus } from "./shared";

type Activity = {
  notes: { id: string; kind: "internal" | "reply"; text: string; createdAt: string; authorId: string | null; author: string | null; emailedTo: string[]; task: string | null; phase: boolean }[];
  time: { id: string; date: string; createdAt: string; hours: number; billableHours: number; note: string | null; userId: string; user: string; tasks: { id: string; title: string; status: TaskStatus }[]; task: string | null }[];
  timer: { startedAt: string; baseSeconds: number; paused: boolean; seconds: number } | null;
};
type Filter = "all" | "reply" | "internal" | "time";

/**
 * An open phase works like a ticket: its timer starts the moment it is opened, and under its tasks come the activity
 * (replies to the client, internal notes, time entries) and the box to answer or to enter time. A time entry says which
 * tasks it covered and the status each is left in (a partial step does not finish a task).
 */
export function PhasePanel({ p, m, edit, onChanged, fail, onCollapse }: { p: ProjectDetail; m: Milestone; edit: boolean; onChanged: () => void; fail: (e: unknown) => void; onCollapse: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const base = `/projects/${p.id}/milestones/${m.id}`;
  const key = [...KEY, "phase", m.id];
  const closed = p.status === "done" || p.status === "cancelled";
  const canTime = edit && can("timesheets.use") && !closed && m.status !== "done";
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<Activity>(`${base}/activity`), refetchInterval: 20_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["time"] });
    onChanged();
  };

  // opening the phase starts its timer (once)
  const started = useRef(false);
  const start = useMutation({ mutationFn: () => api.post(`${base}/timer/start`, {}), onSuccess: () => void qc.invalidateQueries({ queryKey: key }) });
  useEffect(() => {
    if (!data || started.current || !canTime || data.timer) return;
    started.current = true;
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, canTime]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!data?.timer || data.timer.paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data?.timer]);
  // the clock: what was counted before the last start, plus the run since (nothing while paused)
  const elapsed = data?.timer ? data.timer.baseSeconds + (data.timer.paused ? 0 : Math.max(0, Math.floor((now - new Date(data.timer.startedAt).getTime()) / 1000))) : 0;
  const pause = useMutation({
    mutationFn: (on: boolean) => api.post(`${base}/timer/${on ? "pause" : "resume"}`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: [...KEY, "timers"] });
    },
    onError: fail,
  });

  const [dialog, setDialog] = useState<null | { fromTimer: boolean }>(null);
  // "enter the time" from the project's closing question: ?time=<this phase> opens the time window once
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    if (search.get("time") !== m.id || !data) return;
    setDialog({ fromTimer: Boolean(data.timer) });
    setSearch((q) => (q.delete("time"), q), { replace: true });
  }, [search, m.id, data, setSearch]);
  // closing the section with the timer running asks what to do with the time
  const [closing, setClosing] = useState(false);
  const discard = useMutation({
    mutationFn: () => api.post(`${base}/timer/stop`, { discard: true }),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: [...KEY, "timers"] });
      onCollapse();
    },
    onError: fail,
  });
  // minimizing keeps the timer going (it shows in the drawer, like a minimized ticket)
  const minimize = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, "timers"] });
    onCollapse();
  };
  const [filter, setFilter] = useState<Filter>("all");
  const delNote = useMutation({ mutationFn: (id: string) => api.del(`${base}/notes/${id}`), onSuccess: refresh, onError: fail });
  const delTime = useMutation({ mutationFn: (id: string) => api.del(`/time/entries/${id}`), onSuccess: refresh, onError: fail });

  type Item = { at: string; k: string; kind: "reply" | "internal" | "time"; note?: Activity["notes"][number]; entry?: Activity["time"][number] };
  const items: Item[] = [
    ...(data?.notes ?? []).map((n): Item => ({ at: n.createdAt, k: `n${n.id}`, kind: n.kind, note: n })),
    ...(data?.time ?? []).map((e): Item => ({ at: e.createdAt, k: `t${e.id}`, kind: "time", entry: e })),
  ]
    .filter((x) => filter === "all" || x.kind === filter)
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="space-y-3 rounded-xl border bg-background/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.phase.activity")}</h4>
        {data?.timer && (
          <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs", data.timer.paused ? "border-amber-400/40 bg-amber-500/10 text-amber-300" : "border-emerald-400/40 bg-emerald-500/10 text-emerald-300")} title={t("projects.phase.timerHint")}>
            <span className={cn("size-1.5 rounded-full", data.timer.paused ? "bg-amber-400" : "animate-pulse bg-emerald-400")} /> {clock(elapsed)}
            {canTime && (
              <button type="button" onClick={() => pause.mutate(!data.timer!.paused)} disabled={pause.isPending} aria-label={t(data.timer.paused ? "projects.phase.resume" : "projects.phase.pause")} title={t(data.timer.paused ? "projects.phase.resume" : "projects.phase.pause")} className="-mr-1 rounded-full p-0.5 hover:bg-foreground/10">
                {data.timer.paused ? <Play className="size-3 fill-current" /> : <Pause className="size-3 fill-current" />}
              </button>
            )}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={minimize} aria-label={t("projects.phase.minimize")} title={t("projects.phase.minimize")} className="rounded-md p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => (data?.timer && canTime ? setClosing(true) : onCollapse())}
            aria-label={t("projects.phase.close")}
            title={t("projects.phase.close")}
            className="rounded-md p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          {(["all", "reply", "internal", "time"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t(`projects.phase.filter.${f}`)}
            </button>
          ))}
        </span>
      </div>

      <ul className="space-y-2">
        {items.length === 0 && <li className="py-4 text-center text-sm text-muted-foreground">{t("projects.phase.empty")}</li>}
        {items.map((i) => {
          if (i.entry) {
            const e = i.entry;
            return (
              <li key={i.k} className="mx-auto w-full rounded-xl border border-sky-400/30 bg-sky-500/[0.07] px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="size-3.5 text-sky-300" /> <span className="font-medium text-foreground">{e.user}</span> <span>{shortDateTime(e.createdAt)}</span>
                  <span className="rounded-full border border-sky-400/40 px-1.5 font-mono text-sky-200">{hm(e.hours)}</span>
                  <span className="rounded-full border px-1.5">{e.billableHours > 0 ? t("projects.billable") : t("projects.included")}</span>
                  {(e.userId === me.id || can("timesheets.manage")) && (
                    <button type="button" aria-label={t("common.delete")} onClick={() => delTime.mutate(e.id)} className="ml-auto rounded p-1 hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                {(e.tasks.length > 0 || e.task) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {e.tasks.map((x) => (
                      <span key={x.id} className={cn("rounded-full border px-2 py-0.5 text-[11px]", TASK_STYLE[x.status])}>
                        {x.title} → {t(`projects.taskStatus.${x.status}`)}
                      </span>
                    ))}
                    {e.tasks.length === 0 && e.task && <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{e.task}</span>}
                  </div>
                )}
                {e.note && <p className="mt-1.5 whitespace-pre-wrap">{e.note}</p>}
              </li>
            );
          }
          const n = i.note!;
          const reply = n.kind === "reply";
          return (
            <li key={i.k} className={cn("rounded-xl border px-3 py-2 text-sm", reply ? "ml-8 border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.08]" : "mx-4 border-violet-400/30 bg-violet-500/[0.07]")}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {reply ? <Mail className="size-3.5 text-primary" /> : <Lock className="size-3.5 text-violet-300" />}
                <span className="font-medium text-foreground">{n.author ?? "—"}</span>
                <span>{shortDateTime(n.createdAt)}</span>
                {n.task && <span className="rounded-full border px-1.5 text-[11px]">{n.task}</span>}
                {n.phase && (n.authorId === me.id || can("projects.manage")) && (
                  <button type="button" aria-label={t("common.delete")} onClick={() => delNote.mutate(n.id)} className="ml-auto rounded p-1 hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{n.text}</p>
              {reply && <p className="mt-1 text-[11px] text-muted-foreground">{n.emailedTo.length ? t("projects.sentTo", { to: n.emailedTo.join(", ") }) : t("projects.notEmailed")}</p>}
            </li>
          );
        })}
      </ul>

      {edit && <Composer p={p} base={base} canTime={canTime} running={Boolean(data?.timer)} onSaved={refresh} fail={fail} onTime={() => setDialog({ fromTimer: Boolean(data?.timer) })} />}
      {closing && (
        <Dialog open onOpenChange={(o) => !o && setClosing(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Clock className="size-5 text-emerald-300" /> {t("projects.phase.closeTitle", { time: clock(elapsed) })}
              </DialogTitle>
              <DialogDescription>{t("projects.phase.closeText")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Button className="justify-start gap-2 bg-sky-500 text-white hover:bg-sky-400" onClick={() => (setClosing(false), setDialog({ fromTimer: true }))}>
                <Square className="size-4 fill-current" /> {t("projects.phase.enterNow")}
              </Button>
              <Button variant="outline" className="justify-start gap-2" onClick={() => (setClosing(false), minimize())}>
                <Minus className="size-4" /> {t("projects.phase.later")}
              </Button>
              <Button variant="ghost" className="justify-start gap-2 text-muted-foreground hover:text-destructive" disabled={discard.isPending} onClick={() => (setClosing(false), discard.mutate())}>
                <Trash2 className="size-4" /> {t("projects.phase.closeNoTime")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {dialog && <TimeDialog p={p} m={m} base={base} fromTimer={dialog.fromTimer} elapsed={elapsed} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), refresh(), void qc.invalidateQueries({ queryKey: [...KEY, "timers"] }))} fail={fail} />}
    </section>
  );
}

/**
 * Reply to the client (emailed to the contacts ticked and the addresses added, or only kept in the portal) or internal note
 * (colleagues told through the bell, an email and Teams, picked from a list of technicians — like a ticket's), and the button
 * that opens the time entry.
 */
function Composer({ p, base, canTime, running, onSaved, fail, onTime }: { p: ProjectDetail; base: string; canTime: boolean; running: boolean; onSaved: () => void; fail: (e: unknown) => void; onTime: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const [mode, setMode] = useState<"reply" | "internal">("reply");
  const [text, setText] = useState("");
  // reply: the client's contacts ticked, other addresses, and whether it goes by email at all
  const [picked, setPicked] = useState<string[] | null>(null);
  const [others, setOthers] = useState<string[]>([]);
  const [emailOn, setEmailOn] = useState(true);
  const hasClient = Boolean(p.client);
  const { data: contacts = [] } = useQuery({ queryKey: [...KEY, "contacts", p.id], queryFn: () => api.get<{ id: string; name: string; email: string }[]>(`/projects/${p.id}/contacts`), enabled: hasClient });
  const to = picked ?? (contacts[0] ? [contacts[0].email.toLowerCase()] : []);
  const toggle = (email: string) => setPicked(to.includes(email.toLowerCase()) ? to.filter((x) => x !== email.toLowerCase()) : [...to, email.toLowerCase()]);
  const recipients = [...new Set([...to, ...others.map((x) => x.toLowerCase())])];
  // internal note: colleagues to tell, and how
  const { data: people = [] } = useProjectPeople();
  const colleagues = people.filter((x) => x.id !== me.id);
  const team = [...new Set([p.lead?.id, ...p.members.map((m) => m.id)].filter((x): x is string => Boolean(x) && x !== me.id))];
  const [tell, setTell] = useState<string[]>([]);
  const [how, setHow] = useState({ bell: true, email: true, chat: false });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ emailed: boolean | null; failed: string[]; notified?: number; chatNotReady?: boolean; notifyFailed?: number }>(
        `${base}/notes`,
        mode === "reply" ? { text: text.trim(), kind: "reply", email: emailOn, ...(emailOn ? { to: recipients } : {}) } : { text: text.trim(), kind: "internal", ...(tell.length ? { notifyUserIds: tell, notifyChannels: how } : {}) },
      ),
    onSuccess: (r) => {
      setText("");
      setOthers([]);
      setTell([]);
      onSaved();
      if (r.emailed !== null) (r.emailed ? toast.success : toast.warning)(r.emailed ? t("projects.replySent") : t("projects.replyNotSent", { to: r.failed.join(", ") }));
      if (r.notified) toast.success(t("projects.noteTell.done", { count: r.notified }));
      if (r.chatNotReady) toast.warning(t("tickets.noteTell.chatNotReady"));
      else if (r.notifyFailed) toast.warning(t("projects.noteTell.failed", { count: r.notifyFailed }));
    },
    onError: fail,
  });
  const ok = text.trim() && (mode === "internal" || !emailOn || (hasClient && recipients.length > 0));
  return (
    <form
      className="space-y-2 border-t pt-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ok) send.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setMode("reply")} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1 text-sm font-medium", mode === "reply" ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary" : "border-transparent text-muted-foreground")}>
          <Mail className="size-4" /> {t("projects.composer.reply")}
        </button>
        <button type="button" onClick={() => setMode("internal")} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1 text-sm font-medium", mode === "internal" ? "border-violet-400/50 bg-violet-500/10 text-violet-300" : "border-transparent text-muted-foreground")}>
          <Lock className="size-4" /> {t("projects.composer.internal")}
        </button>
        {canTime && (
          <Button type="button" size="sm" variant="outline" className="ml-auto h-8 gap-1.5 border-sky-400/40 text-sky-300" onClick={onTime}>
            {running ? <Square className="size-3.5 fill-current" /> : <Clock className="size-3.5" />} {t(running ? "projects.phase.stopEnter" : "projects.phase.enterTime")}
          </Button>
        )}
      </div>

      {mode === "reply" && (
        <>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={emailOn} onCheckedChange={setEmailOn} /> {t("projects.phase.emailReply")}
          </label>
          {emailOn && !hasClient && <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("projects.composer.noClient")}</p>}
          {emailOn && hasClient && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("projects.phase.contactsHint")}</p>
              <div className="flex flex-wrap gap-1.5">
                {contacts.length === 0 && <span className="text-xs text-muted-foreground">{t("projects.composer.noContacts")}</span>}
                {contacts.map((c) => {
                  const on = to.includes(c.email.toLowerCase());
                  return (
                    <button key={c.id} type="button" aria-pressed={on} onClick={() => toggle(c.email)} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground")}>
                      <Mail className="size-3" /> {c.name || c.email}
                      <span className="text-[10px] opacity-70">{c.email}</span>
                    </button>
                  );
                })}
              </div>
              <RecipientInput value={others} onChange={setOthers} label={t("projects.composer.others")} />
            </div>
          )}
        </>
      )}

      <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} placeholder={mode === "reply" ? t("projects.composer.replyPlaceholder") : t("projects.taskNotePlaceholder")} className={cn(mode === "internal" && "border-violet-400/30")} />

      {mode === "internal" && colleagues.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", tell.length ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
                <BellRing className="size-3" />
                {tell.length ? t("tickets.noteTell.count", { count: tell.length }) : t("tickets.noteTell.pick")}
                <ChevronDown className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              {team.length > 0 && (
                <button type="button" onClick={() => setTell((x) => [...new Set([...x, ...team])])} className="mb-1 w-full rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-accent">
                  {t("projects.noteTell.team")}
                </button>
              )}
              <ul className="max-h-64 overflow-y-auto">
                {colleagues.map((x) => {
                  const on = tell.includes(x.id);
                  return (
                    <li key={x.id}>
                      <button type="button" onClick={() => setTell((v) => (on ? v.filter((i) => i !== x.id) : [...v, x.id]))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                        <span className={cn("flex size-4 items-center justify-center rounded border", on ? "border-violet-400 bg-violet-500/30" : "border-muted-foreground/40")}>{on && <Check className="size-3" />}</span>
                        {x.name}
                        {team.includes(x.id) && <span className="ml-auto text-[10px] text-muted-foreground">{t("projects.noteTell.inTeam")}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {tell.length > 0 && (
                <button type="button" onClick={() => setTell([])} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
                  {t("tickets.noteTell.clear")}
                </button>
              )}
            </PopoverContent>
          </Popover>
          {tell.length > 0 && (
            <div className="flex items-center gap-1" role="group" aria-label={t("tickets.noteTell.how")}>
              {([["bell", BellRing, "tickets.noteTell.bell"], ["email", Mail, "tickets.noteTell.email"], ["chat", MessagesSquare, "tickets.noteTell.chat"]] as const).map(([k, Icon, label]) => (
                <button key={k} type="button" aria-pressed={how[k]} onClick={() => setHow((h) => ({ ...h, [k]: !h[k] }))} className={cn("flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]", how[k] ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground")}>
                  <Icon className="size-3" /> {t(label)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!ok || send.isPending} className={cn("font-semibold", mode === "reply" ? "bg-grad-gold text-[#1a1204] hover:brightness-105" : "bg-violet-500 text-white hover:bg-violet-400")}>
          {send.isPending ? <Loader2 className="size-4 animate-spin" /> : mode === "reply" ? <Send className="size-4" /> : <StickyNote className="size-4" />} {mode === "reply" ? t("projects.composer.sendReply") : t("projects.addNote")}
        </Button>
      </div>
    </form>
  );
}

/** The time entry: how long, what it covered (the tasks ticked, each with the status it is left in) and a note */
function TimeDialog({ p, m, base, fromTimer, elapsed, onClose, onSaved, fail }: { p: ProjectDetail; m: Milestone; base: string; fromTimer: boolean; elapsed: number; onClose: () => void; onSaved: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const tasks = m.tasks ?? [];
  const hourly = p.billingMode !== "fixed" && p.billingMode !== "bank";
  const [dur, setDur] = useState(() => (fromTimer ? hm(Math.max(0.05, Math.round((elapsed / 3600) * 100) / 100)) : ""));
  const [date, setDate] = useState(today());
  const [billable, setBillable] = useState(hourly);
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<Record<string, TaskStatus>>({});
  const [general, setGeneral] = useState(false);
  const [err, setErr] = useState("");
  const hours = parseHm(dur);
  const toggleTask = (id: string, status: TaskStatus, on: boolean) =>
    setSel((s) => {
      const n = { ...s };
      if (on) n[id] = status;
      else delete n[id];
      return n;
    });
  const save = useMutation({
    mutationFn: () => {
      const payload = { date, hours, note: note.trim() || undefined, billable, general, tasks: Object.entries(sel).map(([taskId, status]) => ({ taskId, status })) };
      return fromTimer ? api.post(`${base}/timer/stop`, payload) : api.post(`${base}/time`, payload);
    },
    onSuccess: () => {
      toast.success(t("projects.phase.saved"));
      onSaved();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "task_required") setErr(t("projects.phase.pickOne"));
      else fail(e);
    },
  });
  const discard = useMutation({ mutationFn: () => api.post(`${base}/timer/stop`, { discard: true }), onSuccess: onSaved, onError: fail });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!hours || hours <= 0) return setErr(t("projects.phase.durationFormat"));
    if (tasks.length && !Object.keys(sel).length && !general) return setErr(t("projects.phase.pickOne"));
    setErr("");
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5 text-sky-300" /> {t("projects.phase.timeTitle")}
          </DialogTitle>
          <DialogDescription>
            {p.number} · {m.name}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-[8rem_9rem_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.duration")}</Label>
              <Input autoFocus value={dur} onChange={(e) => (setDur(e.target.value), setErr(""))} placeholder="1:30" aria-invalid={dur !== "" && hours == null} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.date")}</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground">
              <Switch checked={billable} onCheckedChange={setBillable} /> {billable ? t("projects.billable") : t("projects.included")}
            </label>
          </div>

          {tasks.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.phase.covered")}</Label>
              <p className="text-xs text-muted-foreground">{t("projects.phase.coveredHint")}</p>
              <ul className="divide-y rounded-lg border">
                {tasks.map((x) => {
                  const on = sel[x.id] !== undefined;
                  return (
                    <li key={x.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                      <Checkbox checked={on} onCheckedChange={(v) => (toggleTask(x.id, x.status === "todo" ? "doing" : x.status, Boolean(v)), setErr(""))} aria-label={x.title} />
                      <span className={cn("min-w-0 flex-1 truncate", x.status === "done" && "text-muted-foreground line-through")}>{x.title}</span>
                      {on ? (
                        <select value={sel[x.id]} onChange={(e) => setSel((s) => ({ ...s, [x.id]: e.target.value as TaskStatus }))} className={cn("h-7 rounded-md border bg-transparent px-1.5 text-xs", TASK_STYLE[sel[x.id]])} aria-label={t("projects.phase.statusAfter")}>
                          {TASK_STATUSES.map((s) => (
                            <option key={s} value={s} className="text-foreground">
                              {t(`projects.taskStatus.${s}`)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", TASK_STYLE[x.status])}>{t(`projects.taskStatus.${x.status}`)}</span>
                      )}
                    </li>
                  );
                })}
                <li className="flex items-center gap-3 px-3 py-1.5 text-sm text-muted-foreground">
                  <Checkbox checked={general} onCheckedChange={(v) => (setGeneral(Boolean(v)), setErr(""))} aria-label={t("projects.phase.general")} />
                  {t("projects.phase.general")}
                </li>
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.note")}</Label>
            <AiTextarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-24" />
          </div>
          {err && <p className="text-xs text-red-300">{err}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {fromTimer && (
              <Button type="button" variant="ghost" className="mr-auto text-muted-foreground" disabled={discard.isPending} onClick={() => discard.mutate()}>
                {t("projects.phase.discardTimer")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending} className="bg-sky-500 font-semibold text-white hover:bg-sky-400">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("projects.addTime")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

