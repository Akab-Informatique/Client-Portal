import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Folder, FolderOpen, Plus, Users } from "lucide-react";
import { CalendarClock, Check, CheckCircle2, Columns3, Eye, ListChecks, Lock, Paperclip, Repeat, Rows3, Search, Ticket as TicketIcon, UserRound, Workflow } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PRIORITY_STYLE, STATUSES, STATUS_STYLE, dayLabel, hm, todayYmd, type TaskCard, type TaskStatus } from "./shared";
import { taskError, usePeople } from "./TaskDialog";
import { ListBadge, ManageLists, inSpace, rememberList, useTaskLists } from "./lists";
import { TaskQuickAdd } from "./TaskQuickAdd";

type Scope = "all" | "mine" | "none";
/** "Every task" as a folder of its own (a real list id otherwise; empty = the page of all the lists) */
const ALL_LISTS = "all";

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

/**
 * The team's list: every task, shared. Filter by person, open or done, search; as a list or as a board by status.
 * A person and a status change in place; a click opens the whole task.
 */
export function TeamList({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const people = usePeople();
  const [scope, setScope] = useState<Scope>("all");
  const [person, setPerson] = useState("");
  const [done, setDone] = useState(false);
  const [q, setQ] = useState("");
  const lists = useTaskLists();
  const [list, setList] = useState(() => {
    try {
      return sessionStorage.getItem("akab.pipeline.todoList") ?? "";
    } catch {
      return "";
    }
  });
  const [manage, setManage] = useState(false);
  const [view, setView] = useState<"list" | "board">(() => (localStorage.getItem("akab.pipeline.view") === "board" ? "board" : "list"));
  const params = new URLSearchParams({ status: done ? "done" : "open", space: "tasks" });
  if (scope === "mine") params.set("scope", "mine");
  if (scope === "none") params.set("assignee", "none");
  if (person) params.set("assignee", person);
  if (q.trim()) params.set("q", q.trim());
  if (list && lists.data?.some((l) => l.id === list)) params.set("list", list);
  const { data, isLoading } = useQuery({ queryKey: ["pipeline", "tasks", params.toString()], queryFn: () => api.get<TaskCard[]>(`/pipeline/tasks?${params}`), refetchInterval: 30_000, placeholderData: (p) => p });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
  const patch = useMutation({
    mutationFn: (p: { id: string; patch: Record<string, unknown> }) => api.patch(`/pipeline/tasks/${p.id}`, p.patch),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(taskError(t, e));
      refresh();
    },
  });
  const editable = can("pipeline.edit");
  const setViewKeep = (v: "list" | "board") => {
    setView(v);
    try {
      localStorage.setItem("akab.pipeline.view", v);
    } catch {
      /* the choice lasts until the page is reloaded */
    }
  };
  const byStatus = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, (data ?? []).filter((x) => x.status === s)])) as Record<TaskStatus, TaskCard[]>, [data]);
  const everyTask = list === ALL_LISTS;
  const byDue = (a: TaskCard, b: TaskCard) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") || (a.dueTime ?? "").localeCompare(b.dueTime ?? "") || a.title.localeCompare(b.title);
  const rows = (data ?? []).filter((x) => !x.parentId || (data ?? []).every((p) => p.id !== x.parentId) || done).sort(everyTask ? byDue : () => 0);

  const Row = ({ task, child }: { task: TaskCard; child?: boolean }) => <TaskRow task={task} child={child} wide={everyTask} editable={editable} onOpen={() => onOpenTask(task.id)} onPatch={(p) => patch.mutate({ id: task.id, patch: p })} people={people.data ?? []} />;

  const pick = (id: string) => {
    setList(id);
    if (id) rememberList(id);
    try {
      sessionStorage.setItem("akab.pipeline.todoList", id);
    } catch {
      /* kept for this page only */
    }
  };
  const current = lists.data?.find((l) => l.id === list);
  // nothing picked yet: every list, one per line, with a filter (all lists / mine / the team's) and the page of every task
  if (!list || (list !== ALL_LISTS && lists.data && !current)) {
    const shown = inSpace(lists.data, "tasks");
    return (
      <div className="space-y-3">
        {manage && <ManageLists space="tasks" onClose={() => setManage(false)} onCreated={(id) => pick(id)} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => pick(ALL_LISTS)} className="flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ListChecks className="size-3.5" /> {t("pipeline.lists.everyTask")}
            <span className="font-mono opacity-70">{shown.reduce((n, l) => n + l.open, 0)}</span>
          </button>
          {editable && (
            <button type="button" onClick={() => setManage(true)} className="ml-auto flex h-9 items-center gap-1.5 rounded-xl bg-grad-gold px-4 text-sm font-semibold text-[#1a1204]">
              <Plus className="size-4" /> {t("pipeline.lists.new")}
            </button>
          )}
        </div>
        {lists.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="glass flex flex-col items-center gap-2 rounded-2xl border px-6 py-12 text-center text-sm text-muted-foreground">
            <Folder className="size-8 opacity-50" />
            {t("pipeline.lists.none")}
          </div>
        ) : (
          <ul className="glass divide-y divide-[color:var(--glass-border)] overflow-hidden rounded-2xl border">
            {shown.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => pick(l.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.06),transparent_60%)]">
                  <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border", l.shared ? "border-sky-400/40 bg-sky-500/10 text-sky-300" : "border-violet-400/40 bg-violet-500/10 text-violet-300")}>{l.shared ? <Folder className="size-4.5" /> : <Lock className="size-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{l.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{l.shared ? t("pipeline.lists.shared") : l.owner && !l.mine ? t("pipeline.lists.personalOf", { name: l.owner }) : t("pipeline.lists.personal")}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t("pipeline.lists.open", { count: l.open })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {manage && <ManageLists space="tasks" onClose={() => setManage(false)} onCreated={(id) => pick(id)} />}
      {/* an opened list: a little arrow goes back to all the lists */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => pick("")} aria-label={t("pipeline.lists.back")} title={t("pipeline.lists.back")} className="flex size-9 items-center justify-center rounded-xl border text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground">
          <ArrowLeft className="size-4" />
        </button>
        <FolderOpen className={cn("size-5", !current || current.shared ? "text-sky-300" : "text-violet-300")} />
        <h2 className="text-lg font-semibold">{current ? current.name : t("pipeline.lists.everyTask")}</h2>
        {current && (
          <span className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
            {current.shared ? <Users className="size-3" /> : <Lock className="size-3" />} {t(current.shared ? "pipeline.lists.shared" : "pipeline.lists.personal")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-xl border bg-background/40 p-0.5">
          {(
            [
              ["all", t("pipeline.team.all")],
              ["mine", t("pipeline.team.mine")],
              ["none", t("pipeline.team.unassigned")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setScope(k);
                setPerson("");
              }}
              className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors", scope === k && !person ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={person} onChange={(e) => (setPerson(e.target.value), setScope("all"))} className="h-9 rounded-md border bg-transparent px-2 text-sm" aria-label={t("pipeline.team.person")}>
          <option value="">{t("pipeline.team.anyone")}</option>
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me.id ? t("pipeline.team.me", { name: p.name }) : p.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setManage(true)} className="h-9 rounded-xl border px-3 text-xs font-medium text-muted-foreground hover:text-foreground">
          {t("pipeline.lists.manage")}
        </button>
        <button type="button" onClick={() => setDone(!done)} className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium", done ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "text-muted-foreground hover:text-foreground")}>
          <CheckCircle2 className="size-3.5" /> {t("pipeline.team.doneToggle")}
        </button>
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pipeline.team.search")} className="h-9 pl-8" />
        </div>
        <div className="ml-auto flex rounded-xl border bg-background/40 p-0.5">
          {(
            [
              ["list", Rows3],
              ["board", Columns3],
            ] as const
          ).map(([k, Icon]) => (
            <button key={k} type="button" onClick={() => setViewKeep(k)} aria-label={t(`pipeline.team.view.${k}`)} title={t(`pipeline.team.view.${k}`)} className={cn("rounded-lg px-2.5 py-1.5", view === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <div className="glass flex flex-col items-center gap-2 rounded-2xl border px-6 py-16 text-center text-sm text-muted-foreground">
          <Workflow className="size-8 opacity-50" />
          {done ? t("pipeline.team.noneDone") : t("pipeline.team.none")}
        </div>
      ) : view === "list" ? (
        <ul className="glass divide-y divide-[color:var(--glass-border)] overflow-hidden rounded-2xl border">
          {rows.map((task) => (
            <li key={task.id}>
              <Row task={task} />
              {/* its subtasks, indented */}
              {!done &&
                (data ?? [])
                  .filter((c) => c.parentId === task.id)
                  .map((c) => (
                    <div key={c.id} className="border-t border-dashed border-[color:var(--glass-border)] bg-white/[0.015] pl-8">
                      <Row task={c} child />
                    </div>
                  ))}
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STATUSES.filter((s) => !done || s === "done").map((s) => (
            <section key={s} className="glass min-h-40 rounded-2xl border p-2.5">
              <h3 className={cn("mb-2 flex items-center justify-between rounded-lg border px-2.5 py-1 text-xs font-semibold", STATUS_STYLE[s])}>
                {t(`pipeline.status.${s}`)} <span className="font-mono opacity-70">{byStatus[s].length}</span>
              </h3>
              <ul className="space-y-2">
                {byStatus[s].map((task) => (
                  <li key={task.id}>
                    <Card task={task} editable={editable} onOpen={() => onOpenTask(task.id)} onStatus={(st) => patch.mutate({ id: task.id, patch: { status: st } })} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editable && <TaskQuickAdd space="tasks" listId={current?.id} />}
    </div>
  );
}

function Meta({ task, plain }: { task: TaskCard; /** the list and the due day are columns of their own */ plain?: boolean }) {
  const { t } = useTranslation();
  const late = task.dueDate && task.dueDate < todayYmd() && task.status !== "done";
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {!plain && <ListBadge name={task.listShared === false && task.listOwner ? t("pipeline.lists.personalOf", { name: task.listOwner }) : task.listName} shared={task.listShared} />}
      {!plain && task.dueDate && (
        <span className={cn("flex items-center gap-1", late && "text-red-300")}>
          <CalendarClock className="size-3" /> {dayLabel(task.dueDate)}
          {task.dueTime ? ` ${task.dueTime}` : ""}
        </span>
      )}
      {task.startDate && task.startDate > todayYmd() && <span>{t("pipeline.startsOn", { date: dayLabel(task.startDate) })}</span>}
      {task.recurrence && (
        <span className="flex items-center gap-1" title={t("pipeline.recurring")}>
          <Repeat className="size-3" />
        </span>
      )}
      {task.visibility !== "team" && (
        <span className="flex items-center gap-1" title={t(`pipeline.visibility.${task.visibility}`)}>
          {task.visibility === "private" ? <Lock className="size-3" /> : <Eye className="size-3" />}
        </span>
      )}
      {task.files > 0 && (
        <span className="flex items-center gap-1">
          <Paperclip className="size-3" /> {task.files}
        </span>
      )}
      {task.tags.slice(0, 3).map((tag) => (
        <span key={tag} className="rounded-full bg-[color:var(--gold)]/10 px-1.5 text-primary">
          {tag}
        </span>
      ))}
      {task.estimateMinutes ? <span className="font-mono">{hm(task.estimateMinutes)}</span> : null}
      {task.checklist.total > 0 && (
        <span className="flex items-center gap-1">
          <ListChecks className="size-3" /> {task.checklist.done}/{task.checklist.total}
        </span>
      )}
      {task.subtasks.total > 0 && (
        <span className="flex items-center gap-1">
          <Workflow className="size-3" /> {task.subtasks.done}/{task.subtasks.total}
        </span>
      )}
      {task.ticketNumber && (
        <span className="flex items-center gap-1 font-mono text-primary">
          <TicketIcon className="size-3" /> {task.ticketNumber}
        </span>
      )}
      {task.waiting && (
        <span className="flex items-center gap-1 text-fuchsia-300" title={t("pipeline.waitingFor", { title: task.blockedByTitle ?? "" })}>
          <Lock className="size-3" /> {t("pipeline.waiting")}
        </span>
      )}
      {task.parentTitle && <span className="truncate">↳ {task.parentTitle}</span>}
    </span>
  );
}

export function TaskRow({ task, child, wide, todo, editable, onOpen, onPatch, people }: { task: TaskCard; child?: boolean; wide?: boolean; /** a private to-do: nobody else has it */ todo?: boolean; editable: boolean; onOpen: () => void; onPatch: (p: Record<string, unknown>) => void; people: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  return (
    <div className={cn("group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.06),transparent_60%)]", child && "py-2")}>
      <Checkbox checked={task.status === "done"} disabled={!editable} onCheckedChange={(v) => onPatch({ status: v === true ? "done" : "todo" })} aria-label={t("pipeline.complete")} />
      <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[task.priority].dot)} title={t(`pipeline.priority.${task.priority}`)} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 space-y-0.5 text-left">
        <span className={cn("block truncate text-sm font-medium", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</span>
        <Meta task={task} plain={wide} />
      </button>
      {wide && (
        <>
          <span className="hidden w-44 shrink-0 md:block">
            <ListBadge name={task.listShared === false && task.listOwner ? t("pipeline.lists.personalOf", { name: task.listOwner }) : task.listName} shared={task.listShared} />
          </span>
          <span className={cn("hidden w-28 shrink-0 font-mono text-xs sm:block", task.dueDate && task.dueDate < todayYmd() && task.status !== "done" ? "text-red-300" : "text-muted-foreground")}>
            {task.dueDate ? `${dayLabel(task.dueDate)}${task.dueTime ? ` ${task.dueTime}` : ""}` : "—"}
          </span>
        </>
      )}
      <span className={cn("hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline", STATUS_STYLE[task.status])}>{t(`pipeline.status.${task.status}`)}</span>
      {!todo && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!editable}>
          <button type="button" className="flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-1 py-0.5 hover:border-[color:var(--gold)]/40" aria-label={t("pipeline.assignee")}>
            {task.assignees.length > 0 ? (
              <>
                <span className="flex -space-x-1.5">
                  {task.assignees.slice(0, 3).map((x) => (
                    <span key={x.id} title={x.name} className="flex size-6 items-center justify-center rounded-full bg-grad-gold text-[10px] font-bold text-[#1a1204] ring-2 ring-background">
                      {initials(x.name)}
                    </span>
                  ))}
                  {task.assignees.length > 3 && <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-bold ring-2 ring-background">+{task.assignees.length - 3}</span>}
                </span>
                <span className="hidden max-w-28 truncate text-xs text-muted-foreground md:inline">{task.assignees.length > 1 ? `${task.assignees[0]!.name.split(/\s+/)[0]} +${task.assignees.length - 1}` : task.assignees[0]!.name.split(/\s+/)[0]}</span>
              </>
            ) : (
              <span className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
                <UserRound className="size-3" /> {t("pipeline.unassigned")}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 min-w-44 overflow-y-auto">
          {people.map((p) => {
            const on = task.assignees.some((x) => x.id === p.id);
            // a tick toggles the person; the menu stays open to pick several
            return (
              <DropdownMenuItem
                key={p.id}
                onSelect={(e) => {
                  e.preventDefault();
                  const ids = task.assignees.map((x) => x.id);
                  onPatch({ assigneeIds: on ? ids.filter((x) => x !== p.id) : [...ids, p.id] });
                }}
              >
                <span className="flex w-4 justify-center">{on && <Check className="size-3.5 text-primary" />}</span>
                {p.name}
              </DropdownMenuItem>
            );
          })}
          {task.assignees.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onPatch({ assigneeIds: [] })}>{t("pipeline.unassigned")}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </div>
  );
}

function Card({ task, editable, onOpen, onStatus }: { task: TaskCard; editable: boolean; onOpen: () => void; onStatus: (s: TaskStatus) => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border bg-background/50 p-2.5 transition-colors hover:border-[color:var(--gold)]/40">
      <button type="button" onClick={onOpen} className="block w-full space-y-1 text-left">
        <span className="flex items-start gap-1.5">
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", PRIORITY_STYLE[task.priority].dot)} />
          <span className={cn("text-sm font-medium leading-snug", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</span>
        </span>
        <Meta task={task} />
      </button>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{task.assignees.length ? task.assignees.map((x) => x.name.split(/\s+/)[0]).join(", ") : t("pipeline.unassigned")}</span>
        {editable && (
          <select value={task.status} onChange={(e) => onStatus(e.target.value as TaskStatus)} className="h-7 rounded-md border bg-transparent px-1 text-[11px]" aria-label={t("pipeline.statusLabel")}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`pipeline.status.${s}`)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
