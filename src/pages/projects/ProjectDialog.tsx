import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, Clock, FileText, Flag, FolderOpen, Info, ListChecks, Loader2, MessageSquare, Plus, Star, Trash2, X } from "lucide-react";
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
import { useCrmClients } from "@/pages/crm/shared";
import { shortDate, shortDateTime } from "@/pages/tickets/shared";
import { useProjectWorkspace } from "./ProjectWorkspace";
import { apiMessage, dueTone, hoursText, KEY, MS_TONE, PRIORITY_DOT, STATUSES, STATUS_STYLE, TASK_STYLE, TONE_TEXT, today, useProjectPeople, type Milestone, type ProjectDetail, type Status } from "./shared";

const TABS = [
  { key: "overview", icon: Info },
  { key: "milestones", icon: ListChecks },
  { key: "time", icon: Clock },
  { key: "notes", icon: MessageSquare },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** A text that is saved when you leave it (Enter too), not at every key */
function Text({ value, onSave, multiline, className, ...rest }: { value: string; onSave: (v: string) => void; multiline?: boolean; className?: string; placeholder?: string; maxLength?: number; "aria-label"?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onSave(v.trim());
  return multiline ? (
    <Textarea value={v} rows={4} className={className} onChange={(e) => setV(e.target.value)} onBlur={commit} {...rest} />
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

/** The project as a folder: a header, then tabs — overview, milestones, time, notes. Everything is saved as it is changed. */
export function ProjectDialog({ id, onClose, tab, milestone, onTab }: { id: string; onClose: () => void; tab: string | null; milestone: string | null; onTab: (tab: string) => void }) {
  const ws = useProjectWorkspace();
  const onTask = (taskId: string | null) => taskId && ws.openTask(id, taskId);
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const current = (TABS.find((x) => x.key === tab)?.key ?? "overview") as TabKey;
  const { data: p, isLoading, isError } = useQuery({ queryKey: [...KEY, "detail", id], queryFn: () => api.get<ProjectDetail>(`/projects/${id}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: unknown) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t));
  const save = useMutation({ mutationFn: (patch: Record<string, unknown>) => api.patch(`/projects/${id}`, patch), onSuccess: refresh, onError: fail });
  const follow = useMutation({ mutationFn: () => api.put(`/projects/${id}/follow`, { follow: !p?.following }), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: () => api.del(`/projects/${id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: fail,
  });
  const edit = can("projects.edit");
  const counts: Record<TabKey, number | null> = { overview: null, milestones: p?.milestones.length ?? null, time: p?.time.entries.length ?? null, notes: p?.notes.length ?? null };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="flex h-[min(92dvh,58rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {/* the folder's header */}
        <header className="flex items-start gap-3 border-b bg-gradient-to-b from-[color:var(--gold)]/[0.07] to-transparent px-5 pb-0 pt-4">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
            <FolderOpen className="size-6 fill-[color:var(--gold)]/25" />
          </span>
          <div className="min-w-0 flex-1 pb-3">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <span className="font-mono text-xs font-normal text-muted-foreground">{p?.number}</span>
              <span className="truncate">{p?.name ?? t("projects.loading")}</span>
            </DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {p && (
                <>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[p.status])}>{t(`projects.status.${p.status}`)}</span>
                  {p.client && <span>{p.client.name}</span>}
                  {p.lead && <span>· {t("projects.ledBy", { name: p.lead.name })}</span>}
                  {p.attention.map((a) => (
                    <span key={a} className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">
                      {t(`projects.attention.${a}`)}
                    </span>
                  ))}
                </>
              )}
            </DialogDescription>
          </div>
          {p && (
            <button type="button" onClick={() => follow.mutate()} aria-label={p.following ? t("projects.unfollow") : t("projects.follow")} title={p.following ? t("projects.unfollow") : t("projects.follow")} className={cn("rounded-md p-2 hover:bg-foreground/[0.06]", p.following ? "text-amber-300" : "text-muted-foreground")}>
              <Star className={cn("size-5", p.following && "fill-current")} />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-md p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <X className="size-5" />
          </button>
        </header>
        {/* the folder's tabs */}
        <div className="flex flex-wrap items-end gap-1 border-b px-4 pt-2" role="tablist">
          {TABS.map((x) => {
            const active = x.key === current;
            return (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(x.key)}
                className={cn(
                  "relative -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 px-4 py-2 text-sm font-medium transition-colors",
                  active ? "z-10 border-border bg-background text-foreground" : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-grad-gold" />}
                <x.icon className={cn("size-4", active && "text-primary")} /> {t(`projects.tabs.${x.key}`)}
                {counts[x.key] ? <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px]">{counts[x.key]}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {isLoading && <Loader2 className="mx-auto my-16 size-6 animate-spin text-muted-foreground" />}
          {isError && <p className="py-16 text-center text-sm text-muted-foreground">{t("projects.notFound")}</p>}
          {p && current === "overview" && (
            <Overview
              p={p}
              edit={edit}
              save={(patch) => save.mutate(patch)}
              onDelete={
                can("projects.manage")
                  ? () => void confirm({ title: t("projects.deleteTitle", { number: p.number }), description: t("projects.deleteText") }).then((ok) => ok && remove.mutate())
                  : undefined
              }
            />
          )}
          {p && current === "milestones" && <Milestones p={p} edit={edit} focus={milestone} onChanged={refresh} fail={fail} onTask={onTask} />}
          {p && current === "time" && <TimeTab p={p} edit={edit} onChanged={refresh} fail={fail} />}
          {p && current === "notes" && <Notes p={p} edit={edit} onChanged={refresh} fail={fail} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const Card = ({ title, children, className }: { title: string; children: ReactNode; className?: string }) => (
  <section className={cn("rounded-2xl border bg-card/40 p-4", className)}>
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
    {children}
  </section>
);

function Bar({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-2 overflow-hidden rounded-full bg-foreground/10">
      <span className={cn("block h-full rounded-full", over ? "bg-red-500" : "bg-grad-gold")} style={{ width: `${pct}%` }} />
    </span>
  );
}

// ── Overview ──
function Overview({ p, edit, save, onDelete }: { p: ProjectDetail; edit: boolean; save: (patch: Record<string, unknown>) => void; onDelete?: () => void }) {
  const { t } = useTranslation();
  const { data: people = [] } = useProjectPeople();
  const { data: clients = [] } = useCrmClients();
  const memberIds = p.members.map((m) => m.id);
  const over = p.budgetHours != null && p.hours > p.budgetHours;
  const none = "none";
  const tone = dueTone(p.dueDate, p.status === "done" || p.status === "cancelled");
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title={t("projects.tabs.overview")}>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("projects.f.name")}</Label>
              <Text value={p.name} onSave={(v) => v && save({ name: v })} maxLength={200} aria-label={t("projects.f.name")} className={cn(!edit && "pointer-events-none")} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("projects.f.client")}</Label>
                <Select disabled={!edit} value={p.client?.id ?? none} onValueChange={(v) => save({ clientId: v === none ? null : v })}>
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
                <Text
                  value={p.budgetHours == null ? "" : String(p.budgetHours)}
                  onSave={(v) => {
                    const n = Number(v.replace(",", "."));
                    if (!v) save({ budgetHours: null });
                    else if (Number.isFinite(n) && n >= 0) save({ budgetHours: n });
                  }}
                  aria-label={t("projects.f.budget")}
                  className={cn(!edit && "pointer-events-none")}
                />
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
              <Label>{t("projects.f.description")}</Label>
              <Text multiline value={p.description} onSave={(v) => save({ description: v })} placeholder={t("projects.f.descriptionPlaceholder")} maxLength={8000} className={cn(!edit && "pointer-events-none")} />
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card title={t("projects.progress")}>
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span>{t("projects.milestonesDone")}</span>
                <span className="font-mono">
                  {p.progress.done} / {p.progress.total}
                </span>
              </div>
              <Bar value={p.progress.done} max={p.progress.total} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span>{t("projects.hoursLogged")}</span>
                <span className={cn("font-mono", over && "text-red-400")}>
                  {hoursText(p.hours)}
                  {p.budgetHours != null && <span className="text-muted-foreground"> / {hoursText(p.budgetHours)}</span>}
                </span>
              </div>
              {p.budgetHours != null ? <Bar value={p.hours} max={p.budgetHours} over={over} /> : <p className="text-xs text-muted-foreground">{t("projects.noBudget")}</p>}
            </div>
            {p.nextMilestone && (
              <div className="rounded-xl border bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("projects.nextMilestone")}</p>
                <p className="font-medium">{p.nextMilestone.name}</p>
                <p className={cn("text-xs", TONE_TEXT[dueTone(p.nextMilestone.dueDate, false)])}>{p.nextMilestone.dueDate ? shortDate(p.nextMilestone.dueDate) : t("projects.noDate")}</p>
              </div>
            )}
          </div>
        </Card>
        <Card title={t("projects.f.team")}>
          <div className="flex flex-wrap items-center gap-1.5">
            {p.members.map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1 rounded-full border bg-card/60 py-0.5 pl-2.5 pr-1.5 text-xs">
                {m.name}
                {m.id === p.lead?.id ? <span className="text-[10px] text-primary">★</span> : edit && (
                  <button type="button" aria-label={t("common.delete")} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => save({ memberIds: memberIds.filter((x) => x !== m.id && x !== p.lead?.id) })}>
                    <X className="size-3" />
                  </button>
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
        </Card>
        <Card title={t("projects.billing")}>
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <Label>{t("projects.billingMode")}</Label>
              <Select disabled={!edit} value={p.billingMode} onValueChange={(v) => save({ billingMode: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">{t("projects.mode.hourly")}</SelectItem>
                  <SelectItem value="fixed">{t("projects.mode.fixed")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{p.billingMode === "hourly" ? t("projects.modeHintHourly") : t("projects.modeHintFixed")}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.hourlyRate")}</Label>
                <Text
                  value={p.hourlyRate == null ? "" : String(p.hourlyRate)}
                  onSave={(v) => {
                    const n = Number(v.replace(",", "."));
                    if (!v) save({ hourlyRate: null });
                    else if (Number.isFinite(n) && n >= 0) save({ hourlyRate: n });
                  }}
                  aria-label={t("projects.hourlyRate")}
                  className={cn(!edit && "pointer-events-none")}
                />
              </div>
              {p.billingMode === "fixed" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("projects.fixedPrice")}</Label>
                  <Text
                    value={p.fixedPrice == null ? "" : String(p.fixedPrice)}
                    onSave={(v) => {
                      const n = Number(v.replace(",", "."));
                      if (!v) save({ fixedPrice: null });
                      else if (Number.isFinite(n) && n >= 0) save({ fixedPrice: n });
                    }}
                    aria-label={t("projects.fixedPrice")}
                    className={cn(!edit && "pointer-events-none")}
                  />
                </div>
              )}
            </div>
          </div>
        </Card>
        {onDelete && (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 className="size-3.5" /> {t("projects.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Milestones and their tasks ──
function Milestones({ p, edit, focus, onChanged, fail, onTask }: { p: ProjectDetail; edit: boolean; focus: string | null; onChanged: () => void; fail: (e: unknown) => void; onTask: (id: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set(focus ? [focus] : []));
  const [name, setName] = useState("");
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const add = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/milestones`, { name: name.trim() }),
    onSuccess: () => (setName(""), onChanged()),
    onError: fail,
  });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.post(`/projects/${p.id}/milestones/reorder`, { ids }), onSuccess: onChanged, onError: fail });
  const move = (i: number, d: -1 | 1) => {
    const ids = p.milestones.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder.mutate(ids);
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setOpen(open.size ? new Set() : new Set(p.milestones.map((m) => m.id)))}>
          {open.size ? t("projects.collapseAll") : t("projects.expandAll")}
        </Button>
      </div>
      {p.milestones.length === 0 && <p className="rounded-2xl border border-dashed py-10 text-center text-sm text-muted-foreground">{t("projects.noMilestones")}</p>}
      <ul className="space-y-2">
        {p.milestones.map((m, i) => (
          <MilestoneRow key={m.id} p={p} m={m} edit={edit} isOpen={open.has(m.id)} onToggle={() => toggle(m.id)} onChanged={onChanged} fail={fail} onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < p.milestones.length - 1 ? () => move(i, 1) : undefined} focus={focus === m.id} onTask={onTask} last={i === p.milestones.length - 1} />
        ))}
      </ul>
      {edit && (
        <form
          className="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <Plus className="size-4 text-muted-foreground" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects.addMilestone")} maxLength={200} className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
          <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
            {t("projects.add")}
          </Button>
        </form>
      )}
    </div>
  );
}

function MilestoneRow({ p, m, edit, isOpen, onToggle, onChanged, fail, onUp, onDown, focus, onTask, last }: { p: ProjectDetail; m: Milestone; edit: boolean; isOpen: boolean; onToggle: () => void; onChanged: () => void; fail: (e: unknown) => void; onUp?: () => void; onDown?: () => void; focus: boolean; onTask: (id: string | null) => void; last: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center" });
  }, [focus]);
  const patch = useMutation({ mutationFn: (v: Record<string, unknown>) => api.patch(`/projects/${p.id}/milestones/${m.id}`, v), onSuccess: onChanged, onError: fail });
  const del = useMutation({ mutationFn: () => api.del(`/projects/${p.id}/milestones/${m.id}`), onSuccess: onChanged, onError: fail });
  const [task, setTask] = useState("");
  const addTask = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/milestones/${m.id}/tasks`, { title: task.trim() }), onSuccess: () => (setTask(""), onChanged()), onError: fail });
  const tone = dueTone(m.dueDate, m.status === "done");
  const pct = m.tasksTotal ? Math.round((m.tasksDone / m.tasksTotal) * 100) : m.status === "done" ? 100 : 0;
  return (
    <li ref={ref} className="relative pl-12">
      {/* the line of the project, and this milestone's flag on it */}
      {!last && <span className="absolute bottom-[-0.5rem] left-[1.15rem] top-9 w-px bg-border" aria-hidden />}
      <span
        className={cn("absolute left-0 top-2 flex size-10 items-center justify-center rounded-xl border-2 bg-background", m.status === "done" ? "border-emerald-500/60" : m.status === "doing" ? "border-[color:var(--gold)]/60" : "border-border", m.late && "border-red-500/70")}
        title={t(`projects.ms.${m.status}`)}
      >
        <Flag className={cn("size-[18px]", m.late ? "text-red-400" : MS_TONE[m.status], m.status === "done" && "fill-emerald-400/30")} />
      </span>
      <div className={cn("rounded-2xl border bg-card/40 transition-colors", focus && "border-[color:var(--gold)]/50", m.status === "done" && "border-emerald-500/20")}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <button type="button" onClick={onToggle} aria-expanded={isOpen} aria-label={isOpen ? t("projects.collapse") : t("projects.expand")} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("size-4 transition-transform", !isOpen && "-rotate-90")} />
          </button>
          <div className="min-w-40 flex-1">
            <Text value={m.name} onSave={(v) => v && patch.mutate({ name: v })} maxLength={200} aria-label={t("projects.f.name")} className={cn("h-8 border-transparent bg-transparent px-2 font-semibold hover:border-border focus:border-border", !edit && "pointer-events-none")} />
          </div>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full border px-2 py-0.5 font-medium", m.status === "done" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : m.status === "doing" ? "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary" : "border-border")}>{t(`projects.ms.${m.status}`)}</span>
            <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-foreground/10 sm:block">
              <span className={cn("block h-full rounded-full", m.status === "done" ? "bg-emerald-400" : "bg-grad-gold")} style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono">{m.tasksTotal > 0 ? `${m.tasksDone}/${m.tasksTotal}` : "—"}</span>
            <span className="hidden font-mono sm:inline">
              {hoursText(m.hours)}
              {m.budgetHours != null && ` / ${hoursText(m.budgetHours)}`}
            </span>
          </span>
          <Input type="date" disabled={!edit} value={m.dueDate ?? ""} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} className={cn("h-8 w-36", TONE_TEXT[tone])} aria-label={t("projects.f.due")} />
          {edit && (
            <span className="flex items-center">
              <button type="button" disabled={!onUp} onClick={onUp} aria-label={t("projects.up")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                <ArrowUp className="size-3.5" />
              </button>
              <button type="button" disabled={!onDown} onClick={onDown} aria-label={t("projects.down")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={() => void confirm({ title: t("projects.removeMilestoneTitle", { name: m.name }), description: t("projects.removeMilestoneText") }).then((ok) => ok && del.mutate())}
                className="rounded p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          )}
        </div>
        {isOpen && (
          <div className="space-y-3 border-t px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <Text multiline value={m.notes} onSave={(v) => patch.mutate({ notes: v })} placeholder={t("projects.milestoneNotes")} maxLength={8000} className={cn("min-h-16", !edit && "pointer-events-none")} />
              <div className="space-y-1.5">
                <Label className="text-xs">{t("projects.f.budget")}</Label>
                <Text
                  value={m.budgetHours == null ? "" : String(m.budgetHours)}
                  onSave={(v) => {
                    const n = Number(v.replace(",", "."));
                    if (!v) patch.mutate({ budgetHours: null });
                    else if (Number.isFinite(n) && n >= 0) patch.mutate({ budgetHours: n });
                  }}
                  aria-label={t("projects.f.budget")}
                  className={cn("h-8", !edit && "pointer-events-none")}
                />
              </div>
            </div>
            {/* the tasks: each opens in its own window, like a ticket */}
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.tasks")}</p>
              {(m.tasks ?? []).length === 0 && <p className="py-1 text-xs text-muted-foreground">{t("projects.noTasks")}</p>}
              <ul className="space-y-1">
                {(m.tasks ?? []).map((k) => (
                  <li key={k.id}>
                    <button type="button" onClick={() => onTask(k.id)} className="flex w-full items-center gap-3 rounded-xl border bg-background/40 px-3 py-2 text-left text-sm transition-colors hover:border-[color:var(--gold)]/40">
                      <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[k.priority])} title={t(`projects.priority.${k.priority}`)} />
                      <span className={cn("min-w-0 flex-1 truncate", k.status === "done" && "text-muted-foreground line-through")}>{k.title}</span>
                      <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", TASK_STYLE[k.status])}>{t(`projects.taskStatus.${k.status}`)}</span>
                      <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground sm:block">{k.assigneeName ?? t("projects.unassigned")}</span>
                      <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:block">{k.hours ? hoursText(k.hours) : ""}</span>
                      <span className={cn("w-14 shrink-0 text-right text-xs", k.late ? "text-red-400" : "text-muted-foreground")}>{k.dueDate ? shortDate(k.dueDate) : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {edit && (
                <form
                  className="mt-2 flex items-center gap-2"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (task.trim()) addTask.mutate();
                  }}
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <input value={task} onChange={(e) => setTask(e.target.value)} placeholder={t("projects.addTask")} maxLength={200} className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
                </form>
              )}
            </div>
            {/* a milestone with no task is reached by hand; with tasks it is reached when they are done */}
            {edit && m.tasksTotal === 0 && (
              <Button variant="outline" size="sm" onClick={() => patch.mutate({ status: m.status === "done" ? "todo" : "done" })}>
                <Flag className="size-3.5" /> {m.status === "done" ? t("projects.reopenMilestone") : t("projects.markReached")}
              </Button>
            )}
            {m.tasksTotal > 0 && <p className="text-xs text-muted-foreground">{t("projects.followsTasks")}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

// ── Time ──
function TimeTab({ p, edit, onChanged, fail }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const closed = p.status === "done" || p.status === "cancelled";
  const hourly = p.billingMode === "hourly";
  const [f, setF] = useState({ date: today(), duration: "", milestoneId: "", taskId: "", note: "", billable: hourly });
  useEffect(() => setF((s) => ({ ...s, billable: hourly })), [hourly]);
  const hours = parseHm(f.duration);
  const tasks = p.milestones.flatMap((m) => (m.tasks ?? []).map((k) => ({ ...k, milestone: m.name })));
  const toggle = useMutation({ mutationFn: (v: { id: string; billable: boolean }) => api.patch(`/projects/${p.id}/time/${v.id}`, { billable: v.billable }), onSuccess: onChanged, onError: fail });
  const add = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/time`, { date: f.date, hours, ...(f.taskId ? { taskId: f.taskId } : { milestoneId: f.milestoneId || null }), note: f.note.trim() || undefined, billable: f.billable }),
    onSuccess: () => {
      setF((s) => ({ ...s, duration: "", note: "" }));
      onChanged();
      toast.success(t("projects.timeAdded"));
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/time/entries/${id}`),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ["time"] });
    },
    onError: fail,
  });
  const total = p.hours;
  const perMilestone = p.milestones.filter((m) => m.hours > 0 || m.budgetHours != null);
  const unfiled = Math.max(0, total - p.milestones.reduce((n, m) => n + m.hours, 0));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card title={t("projects.hoursLogged")}>
          <p className="font-mono text-2xl font-semibold">{hoursText(total)}</p>
          {p.budgetHours != null && <p className={cn("text-xs", total > p.budgetHours ? "text-red-400" : "text-muted-foreground")}>{total > p.budgetHours ? t("projects.over", { time: hoursText(total - p.budgetHours) }) : t("projects.left", { time: hoursText(p.budgetHours - total) })}</p>}
        </Card>
        <Card title={t("projects.byPerson")}>
          <ul className="space-y-1 text-sm">
            {p.time.byPerson.length === 0 && <li className="text-muted-foreground">—</li>}
            {p.time.byPerson.map((x) => (
              <li key={x.userId} className="flex justify-between">
                <span className="truncate">{x.name}</span>
                <span className="font-mono">{hoursText(x.hours)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("projects.byMilestone")}>
          <ul className="space-y-1 text-sm">
            {perMilestone.length === 0 && unfiled === 0 && <li className="text-muted-foreground">—</li>}
            {perMilestone.map((m) => (
              <li key={m.id} className="flex justify-between gap-2">
                <span className="truncate">{m.name}</span>
                <span className={cn("font-mono", m.budgetHours != null && m.hours > m.budgetHours && "text-red-400")}>
                  {hoursText(m.hours)}
                  {m.budgetHours != null && <span className="text-muted-foreground"> / {hoursText(m.budgetHours)}</span>}
                </span>
              </li>
            ))}
            {unfiled > 0 && (
              <li className="flex justify-between text-muted-foreground">
                <span>{t("projects.noMilestone")}</span>
                <span className="font-mono">{hoursText(unfiled)}</span>
              </li>
            )}
          </ul>
        </Card>
      </div>

      {edit && can("timesheets.use") && !closed && (
        <Card title={t("projects.addTime")}>
          <form
            className="grid gap-3 sm:grid-cols-[9rem_6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (hours && hours > 0) add.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.date")}</Label>
              <Input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.duration")}</Label>
              <Input value={f.duration} onChange={(e) => setF((s) => ({ ...s, duration: e.target.value }))} placeholder="1:30" inputMode="text" aria-invalid={f.duration !== "" && hours == null} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.f.milestone")}</Label>
              <Select value={f.milestoneId || "none"} onValueChange={(v) => setF((s) => ({ ...s, milestoneId: v === "none" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("projects.noMilestone")}</SelectItem>
                  {p.milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.task")}</Label>
              <Select value={f.taskId || "none"} onValueChange={(v) => setF((s) => ({ ...s, taskId: v === "none" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("projects.noTask")}</SelectItem>
                  {tasks.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.milestone} · {k.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("projects.note")}</Label>
              <Input value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} maxLength={500} />
            </div>
            <div className="flex items-end gap-3">
              <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={f.billable} onCheckedChange={(v) => setF((s) => ({ ...s, billable: v }))} /> {f.billable ? t("projects.billable") : t("projects.included")}
              </label>
              <Button type="submit" disabled={!hours || hours <= 0 || add.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("projects.add")}
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{t("projects.timeHint")}</p>
        </Card>
      )}
      {closed && <p className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("projects.errors.project_closed")}</p>}

      <Card title={t("projects.entries")}>
        {p.time.entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t("projects.noTime")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {p.time.entries.map((e) => (
              <li key={e.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem_auto_auto] items-center gap-3 py-2 text-sm md:grid-cols-[4.5rem_9rem_minmax(0,1fr)_minmax(0,1fr)_4rem_5.5rem_auto]">
                <span className="text-xs text-muted-foreground">{shortDate(e.date)}</span>
                <span className="hidden truncate md:block">{e.user}</span>
                <span className="truncate text-muted-foreground">{e.milestone ?? t("projects.noMilestone")}</span>
                <span className="hidden truncate text-muted-foreground md:block">{e.note}</span>
                <span className="text-right font-mono">{hm(e.hours)}</span>
                <button
                  type="button"
                  disabled={!(e.userId === me.id || can("projects.manage"))}
                  onClick={() => toggle.mutate({ id: e.id, billable: e.billableHours <= 0 })}
                  title={t("projects.toggleBillable")}
                  className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", e.billableHours > 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-slate-500/40 bg-slate-500/10 text-slate-300")}
                >
                  {e.billableHours > 0 ? t("projects.billable") : t("projects.included")}
                </button>
                <span className="w-7">
                  {(e.userId === me.id || can("projects.manage")) && (
                    <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(e.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Notes ──
function Notes({ p, edit, onChanged, fail }: { p: ProjectDetail; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const [text, setText] = useState("");
  const add = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/notes`, { text: text.trim() }), onSuccess: () => (setText(""), onChanged()), onError: fail });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/projects/${p.id}/notes/${id}`), onSuccess: onChanged, onError: fail });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {edit && (
        <form
          className="space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projects.notePlaceholder")} maxLength={8000} />
          <div className="flex justify-end">
            <Button type="submit" disabled={!text.trim() || add.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              <FileText className="size-4" /> {t("projects.addNote")}
            </Button>
          </div>
        </form>
      )}
      {p.notes.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t("projects.noNotes")}</p>}
      <ul className="space-y-3">
        {p.notes.map((n) => (
          <li key={n.id} className="rounded-2xl border bg-card/40 p-4">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{n.author ?? "—"}</span>
              <span>{shortDateTime(n.createdAt)}</span>
              {(n.authorId === me.id || can("projects.manage")) && (
                <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(n.id)} className="ml-auto rounded p-1 hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm">{n.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
