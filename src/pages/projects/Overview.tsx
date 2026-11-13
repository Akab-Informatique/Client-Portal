import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, BellRing, CalendarCheck, CheckCircle2, Plus, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useCrmClients } from "@/pages/crm/shared";
import { shortDate, shortDateTime } from "@/pages/tickets/shared";
import { dueTone, hoursText, MS_TONE, PRIORITY_DOT, STATUSES, TASK_STATUSES, TASK_STYLE, TONE_TEXT, today, useProjectPeople, type BillingMode, type ProjectDetail, type Status } from "./shared";
import { Bar, Card, Gauge, Text, type GaugeTone } from "./ui";
import { LinkedTickets, SoldPanel } from "./SoldPanel";
import { ProjectTypeSelect } from "./ProjectTypeSelect";

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);

/**
 * What opens with a project: three gauges (hours against the plan, time against the dates, work done), the tasks at a
 * glance, the follow-up (checkpoint), reminders, the technicians' notes — then the project's settings.
 */
export function Overview({ p, edit, save, onDelete, onTask, onTab, onChanged, fail }: { p: ProjectDetail; edit: boolean; save: (patch: Record<string, unknown>) => void; onDelete?: () => void; onTask: (id: string | null) => void; onTab: (tab: string) => void; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const tasks = p.milestones.flatMap((m) => (m.tasks ?? []).map((k) => ({ ...k, milestone: m.name })));
  const open = p.status !== "done" && p.status !== "cancelled";

  // ── the gauges ──
  const doneTasks = tasks.filter((k) => k.done).length;
  const progress = tasks.length ? (doneTasks / tasks.length) * 100 : p.progress.total ? (p.progress.done / p.progress.total) * 100 : 0;
  const hoursPct = p.budgetHours ? (p.hours / p.budgetHours) * 100 : null;
  const now = today();
  const elapsed = p.startDate && p.dueDate && p.dueDate > p.startDate ? Math.max(0, ((dayNumber(now) - dayNumber(p.startDate)) / (dayNumber(p.dueDate) - dayNumber(p.startDate))) * 100) : null;
  const hoursTone: GaugeTone = hoursPct == null ? "idle" : hoursPct > 100 ? "bad" : hoursPct > progress + 15 ? "warn" : "ok";
  const timeTone: GaugeTone = elapsed == null ? "idle" : elapsed > 100 && open ? "bad" : elapsed > progress + 20 ? "warn" : "ok";
  const verdict: GaugeTone = hoursTone === "bad" || timeTone === "bad" ? "bad" : hoursTone === "warn" || timeTone === "warn" ? "warn" : "ok";
  const daysLeft = p.dueDate ? dayNumber(p.dueDate) - dayNumber(now) : null;

  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((k) => k.status === s).length])) as Record<(typeof TASK_STATUSES)[number], number>;
  const late = tasks.filter((k) => k.late);
  const perPerson = [...tasks.filter((k) => !k.done).reduce((m, k) => m.set(k.assigneeName ?? "", (m.get(k.assigneeName ?? "") ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const soon = tasks.filter((k) => !k.done && k.dueDate).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1)).slice(0, 6);

  return (
    <div className="space-y-4">
      {/* the verdict and the gauges */}
      <Card title={t("projects.ov.health")}>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium", verdict === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : verdict === "warn" ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-red-500/40 bg-red-500/10 text-red-300")}>
            {verdict === "ok" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />} {t(`projects.ov.verdict.${verdict}`)}
          </span>
          {daysLeft != null && open && <span className={cn("text-xs", daysLeft < 0 ? "text-red-400" : "text-muted-foreground")}>{daysLeft < 0 ? t("projects.ov.daysLate", { count: -daysLeft }) : t("projects.ov.daysLeft", { count: daysLeft })}</span>}
        </div>
        <div className="grid gap-6 sm:grid-cols-3">
          <Gauge
            pct={hoursPct}
            tone={hoursTone}
            big={hoursPct == null ? "—" : `${Math.round(hoursPct)}%`}
            label={t("projects.ov.hoursGauge")}
            sub={p.budgetHours != null ? `${hoursText(p.hours)} / ${hoursText(p.budgetHours)}${p.hours > p.budgetHours ? ` · +${hoursText(p.hours - p.budgetHours)}` : ` · ${t("projects.ov.hoursLeft", { time: hoursText(p.budgetHours - p.hours) })}`}` : t("projects.noBudget")}
          />
          <Gauge pct={elapsed} tone={timeTone} big={elapsed == null ? "—" : `${Math.round(elapsed)}%`} label={t("projects.ov.timeGauge")} sub={p.startDate && p.dueDate ? `${shortDate(p.startDate)} → ${shortDate(p.dueDate)}` : t("projects.ov.noDates")} />
          <Gauge pct={progress} tone={progress >= 100 ? "ok" : "idle"} big={`${Math.round(progress)}%`} label={t("projects.ov.workGauge")} sub={tasks.length ? t("projects.ov.tasksOf", { done: doneTasks, total: tasks.length }) : t("projects.ov.noTasksYet")} />
        </div>
      </Card>

      {/* sold against worked, and the billing of the price sold */}
      <SoldPanel p={p} onChanged={onChanged} />

      <div className="grid gap-4 lg:grid-cols-2">
        <LinkedTickets p={p} edit={edit} onChanged={onChanged} />
        {/* tasks at a glance */}
        <Card title={t("projects.ov.tasks")} action={<button type="button" className="text-xs text-primary hover:underline" onClick={() => onTab("milestones")}>{t("projects.ov.seePhases")}</button>}>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-4 gap-2">
              {TASK_STATUSES.map((s) => (
                <div key={s} className={cn("rounded-xl border px-2 py-2 text-center", TASK_STYLE[s])}>
                  <p className="font-mono text-xl font-semibold">{byStatus[s]}</p>
                  <p className="text-[10px] uppercase tracking-wide">{t(`projects.taskStatus.${s}`)}</p>
                </div>
              ))}
            </div>
            {late.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertTriangle className="size-3.5" /> {t("projects.ov.lateTasks", { count: late.length })}
              </p>
            )}
            {perPerson.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {perPerson.map(([name, n]) => (
                  <span key={name} className="rounded-full border bg-card/60 px-2.5 py-0.5 text-xs">
                    {name || t("projects.unassigned")} <span className="font-mono text-muted-foreground">{n}</span>
                  </span>
                ))}
              </div>
            )}
            {soon.length > 0 && (
              <ul className="divide-y divide-border/60 rounded-xl border">
                {soon.map((k) => (
                  <li key={k.id}>
                    <button type="button" onClick={() => onTask(k.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/30">
                      <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[k.priority])} />
                      <span className="min-w-0 flex-1 truncate">{k.title}</span>
                      <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">{k.milestone}</span>
                      <span className={cn("shrink-0 font-mono text-[11px]", k.late ? "text-red-400" : "text-muted-foreground")}>{shortDate(k.dueDate!)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tasks.length === 0 && <p className="text-xs text-muted-foreground">{t("projects.ov.noTasksYet")}</p>}
            {p.milestones.length > 0 && (
              <ul className="space-y-1 text-xs">
                {p.milestones.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <span className={cn("min-w-0 flex-1 truncate", MS_TONE[m.status])}>{m.name}</span>
                    <span className="w-20"><Bar value={m.tasksDone} max={m.tasksTotal || (m.status === "done" ? 1 : 0)} /></span>
                    <span className="w-10 text-right font-mono text-muted-foreground">{m.tasksTotal ? `${m.tasksDone}/${m.tasksTotal}` : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Followup p={p} edit={edit} save={save} onChanged={onChanged} fail={fail} />
        <Reminders p={p} edit={edit} onChanged={onChanged} fail={fail} />
        <TechNotes p={p} edit={edit} onChanged={onChanged} fail={fail} onTab={onTab} />
      </div>

      <Settings p={p} edit={edit} save={save} onDelete={onDelete} />
    </div>
  );
}

/** The follow-up: every N days, the next day, "done" moves it N days on and can leave a note */
function Followup({ p, edit, save, onChanged, fail }: { p: ProjectDetail; edit: boolean; save: (patch: Record<string, unknown>) => void; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const done = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/followup`, { note: note.trim() || undefined }),
    onSuccess: () => (setNote(""), setAsking(false), onChanged(), toast.success(t("projects.ov.followupDone"))),
    onError: fail,
  });
  const tone = dueTone(p.checkpointDate, p.status === "done" || p.status === "cancelled");
  return (
    <Card title={t("projects.ov.followup")}>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.ov.every")}</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={365} disabled={!edit} defaultValue={p.checkpointEveryDays ?? ""} key={p.checkpointEveryDays ?? "none"} placeholder="—" onBlur={(e) => {
                const n = Number(e.target.value);
                if (!e.target.value) p.checkpointEveryDays && save({ checkpointEveryDays: null });
                else if (Number.isInteger(n) && n >= 1 && n <= 365 && n !== p.checkpointEveryDays) save({ checkpointEveryDays: n });
              }} className="h-9 w-20" />
              <span className="text-xs text-muted-foreground">{t("projects.ov.days")}</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.ov.nextFollowup")}</Label>
            <Input type="date" disabled={!edit || !p.checkpointEveryDays} value={p.checkpointDate ?? ""} onChange={(e) => save({ checkpointDate: e.target.value || null })} className={cn("h-9", TONE_TEXT[tone])} />
          </div>
        </div>
        {p.checkpointEveryDays ? (
          <>
            <p className="text-xs text-muted-foreground">{p.lastFollowupOn ? t("projects.ov.lastFollowup", { date: shortDate(p.lastFollowupOn) }) : t("projects.ov.neverFollowed")}</p>
            {edit && !asking && (
              <Button variant="outline" size="sm" onClick={() => setAsking(true)} className={cn(tone === "late" && "border-red-500/50 text-red-300")}>
                <CalendarCheck className="size-4" /> {t("projects.ov.markFollowup")}
              </Button>
            )}
            {asking && (
              <div className="space-y-2">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("projects.ov.followupNote")} maxLength={4000} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => done.mutate()} disabled={done.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                    {t("projects.ov.followupSave", { count: p.checkpointEveryDays })}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t("projects.ov.followupHint")}</p>
        )}
      </div>
    </Card>
  );
}

/** Reminders: a day, a person (the bell rings that day), a few words */
function Reminders({ p, edit, onChanged, fail }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const { data: people = [] } = useProjectPeople();
  const [f, setF] = useState({ remindOn: "", text: "", userId: me.id });
  const add = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/reminders`, { remindOn: f.remindOn, text: f.text.trim(), userId: f.userId || null }), onSuccess: () => (setF((s) => ({ ...s, text: "", remindOn: "" })), onChanged()), onError: fail });
  const tick = useMutation({ mutationFn: (v: { id: string; done: boolean }) => api.patch(`/projects/${p.id}/reminders/${v.id}`, { done: v.done }), onSuccess: onChanged, onError: fail });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/projects/${p.id}/reminders/${id}`), onSuccess: onChanged, onError: fail });
  return (
    <Card title={t("projects.ov.reminders")}>
      <div className="space-y-3 text-sm">
        {p.reminders.length === 0 && <p className="text-xs text-muted-foreground">{t("projects.ov.noReminders")}</p>}
        <ul className="space-y-1">
          {p.reminders.map((r) => {
            const tone = dueTone(r.remindOn, r.done);
            return (
              <li key={r.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent/30">
                <Checkbox checked={r.done} disabled={!edit} onCheckedChange={(v) => tick.mutate({ id: r.id, done: v === true })} />
                <BellRing className="size-3.5 shrink-0 text-muted-foreground" />
                <span className={cn("min-w-0 flex-1 truncate", r.done && "text-muted-foreground line-through")}>{r.text}</span>
                {r.user && <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{r.user}</span>}
                <span className={cn("shrink-0 font-mono text-[11px]", TONE_TEXT[tone])}>{shortDate(r.remindOn)}</span>
                {edit && (
                  <button type="button" className="opacity-0 transition-opacity group-hover:opacity-100" onClick={() => del.mutate(r.id)} aria-label={t("common.delete")}>
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {edit && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (f.remindOn && f.text.trim()) add.mutate();
            }}
          >
            <Input type="date" value={f.remindOn} onChange={(e) => setF((s) => ({ ...s, remindOn: e.target.value }))} className="h-9 w-40" aria-label={t("projects.ov.remindOn")} />
            <Input value={f.text} onChange={(e) => setF((s) => ({ ...s, text: e.target.value }))} placeholder={t("projects.ov.reminderText")} maxLength={500} className="h-9 min-w-40 flex-1" />
            <Select value={f.userId || "none"} onValueChange={(v) => setF((s) => ({ ...s, userId: v === "none" ? "" : v }))}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("projects.ov.remindLead")}</SelectItem>
                {people.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id === me.id ? t("projects.ov.remindMe") : m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="icon" variant="outline" className="size-9" disabled={!f.remindOn || !f.text.trim() || add.isPending} aria-label={t("projects.add")}>
              <Plus className="size-4" />
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

/** The technicians' notes on the project (the latest; the Notes tab has them all) */
function TechNotes({ p, edit, onChanged, fail, onTab }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void; onTab: (tab: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const add = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/notes`, { text: text.trim() }), onSuccess: () => (setText(""), onChanged()), onError: fail });
  return (
    <Card title={t("projects.ov.techNotes")} action={p.notes.length > 5 ? <button type="button" className="text-xs text-primary hover:underline" onClick={() => onTab("notes")}>{t("projects.ov.allNotes", { count: p.notes.length })}</button> : undefined}>
      <div className="space-y-3 text-sm">
        {edit && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add.mutate();
            }}
          >
            <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projects.ov.noteHint")} maxLength={8000} />
            <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || add.isPending}>
              <StickyNote className="size-3.5" /> {t("projects.ov.addNote")}
            </Button>
          </form>
        )}
        {p.notes.length === 0 && <p className="text-xs text-muted-foreground">{t("projects.ov.noNotes")}</p>}
        <ul className="space-y-2">
          {p.notes.slice(0, 5).map((n) => (
            <li key={n.id} className="rounded-xl border bg-background/40 px-3 py-2">
              <p className="text-xs">
                <span className="font-semibold">{n.author ?? "—"}</span> <span className="text-muted-foreground">{shortDateTime(n.createdAt)}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** The project's own settings: who, when, hours, and how it is billed */
function Settings({ p, edit, save, onDelete }: { p: ProjectDetail; edit: boolean; save: (patch: Record<string, unknown>) => void; onDelete?: () => void }) {
  const { t } = useTranslation();
  const { data: people = [] } = useProjectPeople();
  const { data: clients = [] } = useCrmClients();
  const { data: defaults } = useQuery({ queryKey: ["projects", "defaults"], queryFn: () => api.get<{ hourlyRate: number }>("/projects/defaults"), staleTime: 60_000 });
  const clientId = p.client?.id ?? null;
  const { data: contracts = [] } = useQuery({ queryKey: ["projects", "client-contracts", clientId], queryFn: () => api.get<{ id: string; name: string; hourlyRate: number | null }[]>(`/projects/client-contracts/${clientId}`), enabled: Boolean(clientId), staleTime: 30_000 });
  const memberIds = p.members.map((m) => m.id);
  const none = "none";
  const tone = dueTone(p.dueDate, p.status === "done" || p.status === "cancelled");
  const modes: BillingMode[] = ["fixed", "bank", "hourly", "contract", "special"];
  const money = (v: string, key: string) => {
    const n = Number(v.replace(",", "."));
    if (!v) save({ [key]: null });
    else if (Number.isFinite(n) && n >= 0) save({ [key]: n });
  };
  const pickMode = (m: BillingMode) => {
    if (m === p.billingMode) return;
    if (m === "contract") save({ billingMode: m, contractId: p.contract?.id ?? contracts[0]?.id ?? null });
    else if (m === "special") save({ billingMode: m, hourlyRate: p.hourlyRate ?? defaults?.hourlyRate ?? null });
    else if (m === "hourly") save({ billingMode: m, hourlyRate: p.hourlyRate ?? defaults?.hourlyRate ?? null });
    else save({ billingMode: m });
  };
  return (
    <Card title={t("projects.ov.settings")}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("projects.f.name")}</Label>
            <Text value={p.name} onSave={(v) => v && save({ name: v })} maxLength={200} aria-label={t("projects.f.name")} className={cn(!edit && "pointer-events-none")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("projectType.label")}</Label>
            <ProjectTypeSelect disabled={!edit} value={p.type?.id ?? null} onChange={(id) => save({ typeId: id })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("projects.f.client")}</Label>
              <Select disabled={!edit} value={clientId ?? none} onValueChange={(v) => save({ clientId: v === none ? null : v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={none}>{t("projects.f.noClient")}</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.status")}</Label>
              <Select disabled={!edit} value={p.status} onValueChange={(v) => save({ status: v as Status })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`projects.status.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.lead")}</Label>
              <Select disabled={!edit} value={p.lead?.id ?? none} onValueChange={(v) => save({ leadId: v === none ? null : v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={none}>{t("projects.f.noLead")}</SelectItem>
                  {people.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.budget")}</Label>
              <Text value={p.budgetHours == null ? "" : String(p.budgetHours)} onSave={(v) => money(v, "budgetHours")} aria-label={t("projects.f.budget")} className={cn(!edit && "pointer-events-none")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.start")}</Label>
              <Input type="date" disabled={!edit} value={p.startDate ?? ""} onChange={(e) => save({ startDate: e.target.value || null })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.due")}</Label>
              <Input type="date" disabled={!edit} value={p.dueDate ?? ""} min={p.startDate ?? undefined} onChange={(e) => save({ dueDate: e.target.value || null })} className={TONE_TEXT[tone]} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("projects.f.team")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {p.members.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1 rounded-full border bg-card/60 py-0.5 pl-2.5 pr-1.5 text-xs">
                  {m.name}
                  {m.id === p.lead?.id ? (
                    <span className="text-[10px] text-primary">★</span>
                  ) : (
                    edit && (
                      <button type="button" aria-label={t("common.delete")} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => save({ memberIds: memberIds.filter((x) => x !== m.id && x !== p.lead?.id) })}>
                        <X className="size-3" />
                      </button>
                    )
                  )}
                </span>
              ))}
              {edit && (
                <Select value="" onValueChange={(v) => v && save({ memberIds: [...memberIds.filter((x) => x !== p.lead?.id), v] })}>
                  <SelectTrigger className="h-7 w-44 text-xs">
                    <SelectValue placeholder={t("projects.f.addMember")} />
                  </SelectTrigger>
                  <SelectContent>
                    {people.filter((m) => !memberIds.includes(m.id)).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("projects.f.description")}</Label>
            <Text multiline value={p.description} onSave={(v) => save({ description: v })} placeholder={t("projects.f.descriptionPlaceholder")} maxLength={8000} className={cn(!edit && "pointer-events-none")} />
          </div>
        </div>

        <div className="space-y-3">
          <Label>{t("projects.billingMode")}</Label>
          <div className="grid gap-2" role="radiogroup" aria-label={t("projects.billingMode")}>
            {modes.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={p.billingMode === m} disabled={!edit} onClick={() => pickMode(m)} className={cn("rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60", p.billingMode === m ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "bg-muted/30 hover:bg-accent/40")}>
                <span className="block text-sm font-medium">{t(`projects.mode.${m}`)}</span>
                <span className="block text-[11px] text-muted-foreground">{t(`projects.modeHint.${m}`)}</span>
              </button>
            ))}
          </div>
          {p.billingMode === "contract" && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.contract")}</Label>
              {!clientId ? (
                <p className="text-xs text-amber-300">{t("projects.errors.contract_needs_client")}</p>
              ) : contracts.length === 0 ? (
                <p className="text-xs text-amber-300">{t("projects.noContracts")}</p>
              ) : (
                <Select disabled={!edit} value={p.contract?.id ?? ""} onValueChange={(v) => save({ contractId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("projects.pickContract")} />
                  </SelectTrigger>
                  <SelectContent>
                    {contracts.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.name} — {k.hourlyRate == null ? t("projects.hoursIncluded") : `${k.hourlyRate} $/h`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {p.contract && <p className="text-xs text-muted-foreground">{p.contract.hourlyRate == null ? t("projects.hoursIncluded") : t("projects.contractRate", { rate: p.contract.hourlyRate })}</p>}
            </div>
          )}
          {(p.billingMode === "hourly" || p.billingMode === "special") && (
            <div className="space-y-1.5">
              <Label className="text-xs">{p.billingMode === "special" ? t("projects.specialRate") : t("projects.hourlyRate")}</Label>
              <Text value={p.hourlyRate == null ? "" : String(p.hourlyRate)} onSave={(v) => money(v, "hourlyRate")} aria-label={t("projects.hourlyRate")} className={cn(!edit && "pointer-events-none")} />
              {p.billingMode === "hourly" && defaults && <p className="text-xs text-muted-foreground">{t("projects.usualRateIs", { rate: defaults.hourlyRate })}</p>}
            </div>
          )}
          {(p.billingMode === "fixed" || p.billingMode === "bank") && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t(p.billingMode === "bank" ? "projects.bankPrice" : "projects.fixedPrice")}</Label>
              <Text value={p.fixedPrice == null ? "" : String(p.fixedPrice)} onSave={(v) => money(v, "fixedPrice")} aria-label={t("projects.fixedPrice")} className={cn(!edit && "pointer-events-none")} />
            </div>
          )}
          {p.billingMode === "bank" && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.bankExpires")}</Label>
              <Input type="date" disabled={!edit} value={p.bankExpiresOn ?? ""} onChange={(e) => save({ bankExpiresOn: e.target.value || null })} className={cn("h-9", p.bankExpiresOn && p.bankExpiresOn < today() && "border-red-500/60 text-red-400")} />
              {p.bankExpiresOn && p.bankExpiresOn < today() && <p className="text-xs text-red-400">{t("projects.bankExpired")}</p>}
            </div>
          )}
          {onDelete && (
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={onDelete}>
              <Trash2 className="size-3.5" /> {t("projects.delete")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
