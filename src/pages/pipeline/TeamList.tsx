import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, CheckCircle2, Columns3, Eye, ListChecks, Lock, Paperclip, Repeat, Rows3, Search, Ticket as TicketIcon, UserRound, Workflow } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PRIORITY_STYLE, STATUSES, STATUS_STYLE, dayLabel, hm, todayYmd, type TaskCard, type TaskStatus } from "./shared";
import { taskError, usePeople } from "./TaskDialog";

type Scope = "all" | "mine" | "none";

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
  const [view, setView] = useState<"list" | "board">(() => (localStorage.getItem("akab.pipeline.view") === "board" ? "board" : "list"));
  const params = new URLSearchParams({ status: done ? "done" : "open" });
  if (scope === "mine") params.set("scope", "mine");
  if (scope === "none") params.set("assignee", "none");
  if (person) params.set("assignee", person);
  if (q.trim()) params.set("q", q.trim());
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
  const rows = (data ?? []).filter((x) => !x.parentId || (data ?? []).every((p) => p.id !== x.parentId) || done);

  const Row = ({ task, child }: { task: TaskCard; child?: boolean }) => <TaskRow task={task} child={child} editable={editable} onOpen={() => onOpenTask(task.id)} onPatch={(p) => patch.mutate({ id: task.id, patch: p })} people={people.data ?? []} />;

  return (
    <div className="space-y-3">
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
    </div>
  );
}

function Meta({ task }: { task: TaskCard }) {
  const { t } = useTranslation();
  const late = task.dueDate && task.dueDate < todayYmd() && task.status !== "done";
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {task.dueDate && (
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

function TaskRow({ task, child, editable, onOpen, onPatch, people }: { task: TaskCard; child?: boolean; editable: boolean; onOpen: () => void; onPatch: (p: Record<string, unknown>) => void; people: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  return (
    <div className={cn("group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.06),transparent_60%)]", child && "py-2")}>
      <Checkbox checked={task.status === "done"} disabled={!editable} onCheckedChange={(v) => onPatch({ status: v === true ? "done" : "todo" })} aria-label={t("pipeline.complete")} />
      <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[task.priority].dot)} title={t(`pipeline.priority.${task.priority}`)} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 space-y-0.5 text-left">
        <span className={cn("block truncate text-sm font-medium", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</span>
        <Meta task={task} />
      </button>
      <span className={cn("hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline", STATUS_STYLE[task.status])}>{t(`pipeline.status.${task.status}`)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!editable}>
          <button type="button" className="flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-1 py-0.5 hover:border-[color:var(--gold)]/40" aria-label={t("pipeline.assignee")}>
            {task.assignee ? (
              <>
                <span className="flex size-6 items-center justify-center rounded-full bg-grad-gold text-[10px] font-bold text-[#1a1204]">{initials(task.assignee)}</span>
                <span className="hidden max-w-24 truncate text-xs text-muted-foreground md:inline">{task.assignee.split(/\s+/)[0]}</span>
              </>
            ) : (
              <span className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
                <UserRound className="size-3" /> {t("pipeline.unassigned")}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 min-w-44 overflow-y-auto">
          {people.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onPatch({ assigneeId: p.id })}>
              {p.name}
            </DropdownMenuItem>
          ))}
          {task.assignee && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onPatch({ assigneeId: null })}>{t("pipeline.unassigned")}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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
        <span className="truncate text-xs text-muted-foreground">{task.assignee ?? t("pipeline.unassigned")}</span>
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
