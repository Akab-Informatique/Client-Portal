import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Flag, ListTodo, Loader2, Lock, Mail, Minus, Play, Plus, Send, Square, StickyNote, Trash2, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import { RecipientInput } from "@/pages/outlook/RecipientInput";
import { shortDate, shortDateTime } from "@/pages/tickets/shared";
import { apiMessage, clock, hoursText, KEY, PRIORITIES, PRIORITY_DOT, TASK_STATUSES, TASK_STYLE, today, useProjectPeople, type ProjectDetail, type TaskDetail, type TaskStatus } from "./shared";

/** What a minimized task keeps to be shown in the dock */
export type DockedTask = { projectId: string; taskId: string; number: string; title: string; milestone: string; status: TaskStatus };

/** A text saved when you leave it (Enter too for a single line) */
function Saved({ value, onSave, multiline, className, ...rest }: { value: string; onSave: (v: string) => void; multiline?: boolean; className?: string; placeholder?: string; maxLength?: number; rows?: number; "aria-label"?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onSave(v.trim());
  return multiline ? (
    <Textarea value={v} className={className} onChange={(e) => setV(e.target.value)} onBlur={commit} {...rest} />
  ) : (
    <Input
      value={v}
      className={className}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
      {...rest}
    />
  );
}

const Panel = ({ title, children, className }: { title: string; children: ReactNode; className?: string }) => (
  <section className={cn("rounded-2xl border bg-card/40 p-4", className)}>
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
    {children}
  </section>
);

type Mode = "reply" | "internal" | "time";
type Filter = "all" | "reply" | "internal" | "time";

/**
 * A task of a milestone in a big window, like a ticket's but in violet and marked "task": description, a box to reply to
 * the client / write an internal note / enter time, the activity (client replies, internal notes, time), the details and a
 * timer. It can be minimized into the dock at the bottom of the page. Time is billable or included as the project says.
 */
export function TaskDialog({ projectId, taskId, onClose, onMinimize }: { projectId: string; taskId: string; onClose: () => void; onMinimize: (t: DockedTask) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: people = [] } = useProjectPeople();
  const { data: tk, isLoading, isError } = useQuery({ queryKey: [...KEY, "task", taskId], queryFn: () => api.get<TaskDetail>(`/projects/${projectId}/tasks/${taskId}`) });
  const { data: project } = useQuery({ queryKey: [...KEY, "detail", projectId], queryFn: () => api.get<ProjectDetail>(`/projects/${projectId}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: unknown) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t));
  const edit = can("projects.edit");
  const base = `/projects/${projectId}/tasks/${taskId}`;
  const patch = useMutation({ mutationFn: (v: Record<string, unknown>) => api.patch(base, v), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: () => api.del(base),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: fail,
  });
  const closed = tk ? tk.project.status === "done" || tk.project.status === "cancelled" : false;
  const hourly = tk?.project.billingMode === "hourly";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="flex h-[min(95dvh,66rem)] flex-col gap-0 overflow-hidden border-violet-400/30 p-0 sm:max-w-[min(96vw,96rem)]">
        <header className="space-y-2 border-b bg-gradient-to-b from-violet-500/[0.10] to-transparent px-5 pb-3 pt-4">
          <div className="flex items-start gap-3">
            <span className="mt-1 flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
              <ListTodo className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogDescription className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">{t("projects.taskBadge")}</span>
                {tk && (
                  <>
                    <span className="font-mono">{tk.project.number}</span>
                    <span className="truncate">{tk.project.name}</span>
                    <Flag className="size-3 text-primary" />
                    <span className="truncate">{tk.milestone.name}</span>
                  </>
                )}
              </DialogDescription>
              <DialogTitle asChild>
                <div>{tk ? <Saved value={tk.title} onSave={(v) => v && patch.mutate({ title: v })} maxLength={200} aria-label={t("projects.task")} className={cn("h-10 border-transparent bg-transparent px-2 text-xl font-semibold hover:border-border focus:border-border", !edit && "pointer-events-none")} /> : <span>{t("projects.loading")}</span>}</div>
              </DialogTitle>
            </div>
            {tk && (
              <>
                <Select disabled={!edit} value={tk.status} onValueChange={(v) => patch.mutate({ status: v as TaskStatus })}>
                  <SelectTrigger className={cn("h-9 w-40 border", TASK_STYLE[tk.status])}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`projects.taskStatus.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select disabled={!edit} value={tk.priority} onValueChange={(v) => patch.mutate({ priority: v })}>
                  <SelectTrigger className="h-9 w-36">
                    <span className={cn("size-2 rounded-full", PRIORITY_DOT[tk.priority])} />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`projects.priority.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={() => onMinimize({ projectId, taskId, number: tk.project.number, title: tk.title, milestone: tk.milestone.name, status: tk.status })}
                  aria-label={t("projects.minimize")}
                  title={t("projects.minimize")}
                  className="rounded-md p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <Minus className="size-5" />
                </button>
              </>
            )}
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-md p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
              <X className="size-5" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {isLoading && <Loader2 className="mx-auto my-16 size-6 animate-spin text-muted-foreground" />}
          {isError && <p className="py-16 text-center text-sm text-muted-foreground">{t("projects.notFound")}</p>}
          {tk && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_25rem]">
              {/* the work: what to do, the box to answer, then the activity */}
              <div className="space-y-4">
                <Panel title={t("projects.taskDescription")}>
                  <Saved multiline rows={5} value={tk.description} onSave={(v) => patch.mutate({ description: v })} placeholder={t("projects.taskDescriptionPlaceholder")} maxLength={8000} className={cn("min-h-28", !edit && "pointer-events-none")} />
                </Panel>
                <Composer tk={tk} projectId={projectId} edit={edit} canTime={edit && can("timesheets.use") && !closed} hourly={Boolean(hourly)} onChanged={refresh} fail={fail} />
                <Activity tk={tk} projectId={projectId} onChanged={refresh} fail={fail} />
              </div>

              {/* the details and the timer */}
              <div className="space-y-4">
                <Panel title={t("projects.details")}>
                  <div className="space-y-3 text-sm">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("projects.assignee")}</Label>
                      <Select disabled={!edit} value={tk.assigneeId ?? "none"} onValueChange={(v) => patch.mutate({ assigneeId: v === "none" ? null : v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t("projects.unassigned")}</SelectItem>
                          {people.map((x) => (
                            <SelectItem key={x.id} value={x.id}>
                              {x.id === me.id ? t("projects.filters.me", { name: x.name }) : x.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t("projects.f.due")}</Label>
                        <Input type="date" disabled={!edit} value={tk.dueDate ?? ""} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t("projects.estimate")}</Label>
                        <Saved
                          value={tk.estimateHours == null ? "" : hm(tk.estimateHours)}
                          onSave={(v) => {
                            if (!v) patch.mutate({ estimateHours: null });
                            else {
                              const h = parseHm(v);
                              if (h != null) patch.mutate({ estimateHours: h });
                              else toast.error(t("projects.durationInvalid"));
                            }
                          }}
                          placeholder="2:30"
                          aria-label={t("projects.estimate")}
                          className={cn(!edit && "pointer-events-none")}
                        />
                      </div>
                    </div>
                    {project && project.milestones.length > 1 && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t("projects.f.milestone")}</Label>
                        <Select disabled={!edit} value={tk.milestone.id} onValueChange={(v) => patch.mutate({ milestoneId: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {project.milestones.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t("projects.createdOn", { date: shortDate(tk.createdAt.slice(0, 10)) })}</p>
                  </div>
                </Panel>

                <TimerPanel tk={tk} projectId={projectId} canLog={edit && can("timesheets.use") && !closed} hourly={Boolean(hourly)} onChanged={refresh} fail={fail} />

                {edit && (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void confirm({ title: t("projects.removeTaskTitle", { name: tk.title }), description: t("projects.removeTaskText") }).then((ok) => ok && remove.mutate())}>
                    <Trash2 className="size-3.5" /> {t("projects.removeTask")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The box under the description: reply to the client (emailed), internal note, or a time entry — like a ticket's */
function Composer({ tk, projectId, edit, canTime, hourly, onChanged, fail }: { tk: TaskDetail; projectId: string; edit: boolean; canTime: boolean; hourly: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const hasClient = Boolean(tk.project.clientId);
  const [mode, setMode] = useState<Mode>(hasClient ? "reply" : "internal");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [others, setOthers] = useState<string[]>([]);
  const { data: contacts = [] } = useQuery({ queryKey: [...KEY, "contacts", projectId], queryFn: () => api.get<{ id: string; name: string; email: string }[]>(`/projects/${projectId}/contacts`), enabled: hasClient });
  // the first contact is ticked at first, like a ticket's contact
  const to = picked ?? (contacts[0] ? [contacts[0].email.toLowerCase()] : []);
  const recipients = [...new Set([...to, ...others.map((x) => x.toLowerCase())])];
  const toggle = (email: string) => setPicked(to.includes(email.toLowerCase()) ? to.filter((x) => x !== email.toLowerCase()) : [...to, email.toLowerCase()]);

  const send = useMutation({
    mutationFn: () => api.post<{ emailed: boolean | null; failed: string[] }>(`/projects/${projectId}/tasks/${tk.id}/notes`, { text: text.trim(), kind: mode === "reply" ? "reply" : "internal", ...(mode === "reply" ? { to: recipients } : {}) }),
    onSuccess: (r) => {
      setText("");
      onChanged();
      if (mode === "reply") (r.emailed ? toast.success : toast.warning)(r.emailed ? t("projects.replySent") : t("projects.replyNotSent", { to: r.failed.join(", ") }));
    },
    onError: fail,
  });
  const [f, setF] = useState({ date: today(), duration: "", note: "", billable: hourly });
  useEffect(() => setF((s) => ({ ...s, billable: hourly })), [hourly]);
  const hours = parseHm(f.duration);
  const add = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/time`, { date: f.date, hours, taskId: tk.id, note: f.note.trim() || undefined, billable: f.billable }),
    onSuccess: () => {
      setF((s) => ({ ...s, duration: "", note: "" }));
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t("projects.timeAdded"));
    },
    onError: fail,
  });
  if (!edit) return null;
  const tabs: { key: Mode; icon: typeof Mail; label: string; tone: string; off?: boolean }[] = [
    { key: "reply", icon: Mail, label: t("projects.composer.reply"), tone: "text-primary border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10" },
    { key: "internal", icon: Lock, label: t("projects.composer.internal"), tone: "text-violet-300 border-violet-400/50 bg-violet-500/10" },
    { key: "time", icon: Clock, label: t("projects.composer.time"), tone: "text-sky-300 border-sky-400/50 bg-sky-500/10", off: !canTime },
  ];
  return (
    <section className="rounded-2xl border bg-card/40">
      <div className="flex flex-wrap gap-1.5 border-b p-2" role="tablist">
        {tabs
          .filter((x) => !x.off)
          .map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={mode === x.key} onClick={() => setMode(x.key)} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors", mode === x.key ? x.tone : "border-transparent text-muted-foreground hover:text-foreground")}>
              <x.icon className="size-4" /> {x.label}
            </button>
          ))}
      </div>
      <div className="space-y-3 p-4">
        {mode !== "time" && (
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (text.trim() && (mode === "internal" || recipients.length)) send.mutate();
            }}
          >
            {mode === "reply" && !hasClient && <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("projects.composer.noClient")}</p>}
            {mode === "reply" && hasClient && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t("projects.composer.replyHint")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {contacts.length === 0 && <span className="text-xs text-muted-foreground">{t("projects.composer.noContacts")}</span>}
                  {contacts.map((c) => {
                    const on = to.includes(c.email.toLowerCase());
                    return (
                      <button key={c.id} type="button" aria-pressed={on} onClick={() => toggle(c.email)} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                        <Mail className="size-3" /> {c.name || c.email}
                        <span className="text-[10px] opacity-70">{c.email}</span>
                      </button>
                    );
                  })}
                </div>
                <RecipientInput value={others} onChange={setOthers} label={t("projects.composer.others")} />
              </div>
            )}
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} placeholder={mode === "reply" ? t("projects.composer.replyPlaceholder") : t("projects.taskNotePlaceholder")} className={cn(mode === "internal" && "border-violet-400/30 bg-violet-500/[0.04]")} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{mode === "internal" ? t("projects.composer.internalHint") : recipients.length ? t("projects.composer.willSend", { count: recipients.length }) : t("projects.composer.pickOne")}</p>
              <Button type="submit" disabled={!text.trim() || send.isPending || (mode === "reply" && (!hasClient || recipients.length === 0))} className={cn("font-semibold", mode === "reply" ? "bg-grad-gold text-[#1a1204] hover:brightness-105" : "bg-violet-500 text-white hover:bg-violet-400")}>
                {send.isPending ? <Loader2 className="size-4 animate-spin" /> : mode === "reply" ? <Send className="size-4" /> : <StickyNote className="size-4" />} {mode === "reply" ? t("projects.composer.sendReply") : t("projects.addNote")}
              </Button>
            </div>
          </form>
        )}
        {mode === "time" && (
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (hours && hours > 0) add.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[9rem_7rem_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.date")}</Label>
                <Input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.duration")}</Label>
                <Input value={f.duration} onChange={(e) => setF((s) => ({ ...s, duration: e.target.value }))} placeholder="1:30" aria-invalid={f.duration !== "" && hours == null} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.note")}</Label>
                <Input value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} maxLength={500} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={f.billable} onCheckedChange={(v) => setF((s) => ({ ...s, billable: v }))} /> {f.billable ? t("projects.billable") : t("projects.included")}
              </label>
              <Button type="submit" disabled={!hours || hours <= 0 || add.isPending} className="bg-sky-500 font-semibold text-white hover:bg-sky-400">
                {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("projects.addTime")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("projects.timeHint")}</p>
          </form>
        )}
      </div>
    </section>
  );
}

/** The activity of the task as a conversation, newest on top: replies to the client, internal notes and time entries. */
function Activity({ tk, projectId, onChanged, fail }: { tk: TaskDetail; projectId: string; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const base = `/projects/${projectId}`;
  const delNote = useMutation({ mutationFn: (id: string) => api.del(`${base}/tasks/${tk.id}/notes/${id}`), onSuccess: onChanged, onError: fail });
  const toggle = useMutation({ mutationFn: (v: { id: string; billable: boolean }) => api.patch(`${base}/time/${v.id}`, { billable: v.billable }), onSuccess: onChanged, onError: fail });
  const delTime = useMutation({
    mutationFn: (id: string) => api.del(`/time/entries/${id}`),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
    },
    onError: fail,
  });
  type Item = { kind: "reply" | "internal" | "time"; at: string; key: string };
  const items = useMemo(() => {
    const all: (Item & { note?: TaskDetail["notes"][number]; entry?: TaskDetail["time"][number] })[] = [
      ...tk.notes.map((n) => ({ kind: n.kind, at: n.createdAt, key: `n:${n.id}`, note: n })),
      ...tk.time.map((e) => ({ kind: "time" as const, at: e.createdAt, key: `t:${e.id}`, entry: e })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [tk.notes, tk.time]);
  const shown = items.filter((i) => filter === "all" || i.kind === filter);
  const count = (k: Filter) => items.filter((i) => k === "all" || i.kind === k).length;
  return (
    <section className="rounded-2xl border bg-card/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <h3 className="mr-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.activity")}</h3>
        {(["all", "reply", "internal", "time"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", filter === k ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {t(`projects.filterActivity.${k}`)} <span className="font-mono text-[10px] opacity-70">{count(k)}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("projects.noActivity")}</p>}
      <ul className="space-y-3">
        {shown.map((i) => {
          if (i.note && i.kind === "reply")
            return (
              <li key={i.key} className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.07] p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Mail className="size-3.5 text-primary" />
                  <span className="font-medium text-foreground">{i.note.author ?? "—"}</span>
                  <span>{shortDateTime(i.note.createdAt)}</span>
                  {(i.note.authorId === me.id || can("projects.manage")) && (
                    <button type="button" aria-label={t("common.delete")} onClick={() => delNote.mutate(i.note!.id)} className="ml-auto rounded p-1 hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{i.note.text}</p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{i.note.emailedTo.length ? t("projects.sentTo", { to: i.note.emailedTo.join(", ") }) : t("projects.notEmailed")}</p>
              </li>
            );
          if (i.note)
            return (
              <li key={i.key} className="mx-auto w-[92%] rounded-xl border border-violet-400/30 bg-violet-500/[0.07] p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Lock className="size-3.5 text-violet-300" />
                  <span className="font-medium text-violet-300">{t("projects.internalLabel")}</span>
                  <span className="font-medium text-foreground">{i.note.author ?? "—"}</span>
                  <span>{shortDateTime(i.note.createdAt)}</span>
                  {(i.note.authorId === me.id || can("projects.manage")) && (
                    <button type="button" aria-label={t("common.delete")} onClick={() => delNote.mutate(i.note!.id)} className="ml-auto rounded p-1 hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{i.note.text}</p>
              </li>
            );
          const e = i.entry!;
          const billable = e.billableHours > 0;
          const mine = e.userId === me.id || can("projects.manage");
          return (
            <li key={i.key} className="mx-auto flex w-[92%] items-center gap-3 rounded-xl border border-sky-400/30 bg-sky-500/[0.06] px-3 py-2 text-sm">
              <Clock className="size-4 shrink-0 text-sky-300" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{e.user}</span> <span className="text-muted-foreground">· {shortDate(e.date)}</span>
                {e.note && <span className="block truncate text-xs text-muted-foreground">{e.note}</span>}
              </span>
              <span className="font-mono font-semibold">{hm(e.hours)}</span>
              <button
                type="button"
                disabled={!mine}
                onClick={() => toggle.mutate({ id: e.id, billable: !billable })}
                title={t("projects.toggleBillable")}
                className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", billable ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-slate-500/40 bg-slate-500/10 text-slate-300", mine && "hover:brightness-125")}
              >
                {billable ? t("projects.billable") : t("projects.included")}
              </button>
              {mine ? (
                <button type="button" aria-label={t("common.delete")} onClick={() => delTime.mutate(e.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              ) : (
                <span className="w-6" />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The timer of the task and what it comes to. It keeps running when the window is minimized or closed. */
function TimerPanel({ tk, projectId, canLog, hourly, onChanged, fail }: { tk: TaskDetail; projectId: string; canLog: boolean; hourly: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const base = `/projects/${projectId}`;
  const started = tk.timer ? new Date(tk.timer.startedAt).getTime() : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (started == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [started]);
  const elapsed = started == null ? 0 : (now - started) / 1000;
  const start = useMutation({ mutationFn: () => api.post(`${base}/tasks/${tk.id}/timer/start`), onSuccess: onChanged, onError: fail });
  const [stopping, setStopping] = useState<{ duration: string; note: string; billable: boolean } | null>(null);
  const stop = useMutation({
    mutationFn: (v: { discard?: boolean; hours?: number; note?: string; billable?: boolean }) => api.post(`${base}/tasks/${tk.id}/timer/stop`, { ...v, date: today() }),
    onSuccess: (_r, v) => {
      setStopping(null);
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
      if (!v.discard) toast.success(t("projects.timeAdded"));
    },
    onError: fail,
  });
  const rate = tk.project.hourlyRate;
  return (
    <Panel title={t("projects.tabs.time")}>
      <div className="space-y-3 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-2xl font-semibold">{hoursText(tk.hours)}</span>
          {tk.estimateHours != null && <span className={cn("text-xs", tk.hours > tk.estimateHours ? "text-red-400" : "text-muted-foreground")}>{t("projects.ofEstimate", { time: hoursText(tk.estimateHours) })}</span>}
        </div>
        <p className="rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">{hourly ? t("projects.billingHourly", { rate: rate != null ? `${rate.toLocaleString("fr-CA", { style: "currency", currency: "CAD" })}/h` : t("projects.usualRate") }) : t("projects.billingFixed")}</p>
        {canLog &&
          (tk.timer ? (
            stopping ? (
              <form
                className="space-y-2 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.05] p-3"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  const h = parseHm(stopping.duration);
                  if (h && h > 0) stop.mutate({ hours: h, note: stopping.note.trim() || undefined, billable: stopping.billable });
                }}
              >
                <div className="grid grid-cols-[6rem_1fr] gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t("projects.duration")}</Label>
                    <Input autoFocus value={stopping.duration} onChange={(e) => setStopping({ ...stopping, duration: e.target.value })} aria-invalid={parseHm(stopping.duration) == null} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("projects.note")}</Label>
                    <Input value={stopping.note} maxLength={500} onChange={(e) => setStopping({ ...stopping, note: e.target.value })} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={stopping.billable} onCheckedChange={(v) => setStopping({ ...stopping, billable: v })} /> {stopping.billable ? t("projects.billable") : t("projects.included")}
                </label>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={!parseHm(stopping.duration) || stop.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                    {stop.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("projects.saveTime")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setStopping(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => stop.mutate({ discard: true })}>
                    {t("projects.discardTimer")}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.05] px-3 py-2">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-[color:var(--gold)] opacity-60" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-[color:var(--gold)]" />
                </span>
                <span className="font-mono text-xl font-semibold tabular-nums">{clock(elapsed)}</span>
                <Button size="sm" className="ml-auto" onClick={() => setStopping({ duration: hm(Math.max(0.05, Math.round((elapsed / 3600) * 100) / 100)), note: "", billable: hourly })}>
                  <Square className="size-3.5 fill-current" /> {t("projects.stopTimer")}
                </Button>
              </div>
            )
          ) : (
            <Button variant="outline" className="w-full" disabled={start.isPending} onClick={() => start.mutate()}>
              <Play className="size-4 fill-current text-primary" /> {t("projects.startTimer")}
            </Button>
          ))}
      </div>
    </Panel>
  );
}
