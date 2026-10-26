import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Status = "planning" | "active" | "on_hold" | "done" | "cancelled";
export type MsStatus = "todo" | "doing" | "done";
export const STATUSES: Status[] = ["planning", "active", "on_hold", "done", "cancelled"];
export const STATUS_STYLE: Record<Status, string> = {
  planning: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  on_hold: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  done: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  cancelled: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};
export const KEY = ["projects"];

export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type Priority = "low" | "normal" | "high" | "urgent";
export const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "done"];
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
export const TASK_STYLE: Record<TaskStatus, string> = {
  todo: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  doing: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  blocked: "border-red-500/40 bg-red-500/10 text-red-300",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
};
export const PRIORITY_DOT: Record<Priority, string> = { low: "bg-slate-400", normal: "bg-sky-400", high: "bg-amber-400", urgent: "bg-red-500" };
export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  done: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  late: boolean;
  estimateHours: number | null;
  hours: number;
};
export type TaskDetail = {
  id: string;
  projectId: string;
  project: { id: string; number: string; name: string; clientId: string | null; status: Status; billingMode: "hourly" | "fixed"; hourlyRate: number | null };
  milestone: { id: string; name: string };
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  doneAt: string | null;
  createdAt: string;
  notes: { id: string; text: string; kind: "internal" | "reply"; emailedTo: string[]; createdAt: string; authorId: string | null; author: string | null }[];
  time: { id: string; date: string; hours: number; billableHours: number; note: string | null; userId: string; user: string; createdAt: string }[];
  hours: number;
  timer: { startedAt: string } | null;
};
export type Milestone = {
  id: string;
  name: string;
  notes: string;
  status: MsStatus;
  dueDate: string | null;
  late: boolean;
  budgetHours: number | null;
  hours: number;
  tasksDone: number;
  tasksTotal: number;
  tasks?: Task[];
};
export type Person = { id: string; name: string };
export type Project = {
  id: string;
  number: string;
  name: string;
  description: string;
  status: Status;
  client: { id: string; name: string } | null;
  lead: Person | null;
  members: Person[];
  startDate: string | null;
  dueDate: string | null;
  budgetHours: number | null;
  billingMode: "hourly" | "fixed";
  /** Dollars */
  hourlyRate: number | null;
  fixedPrice: number | null;
  hours: number;
  following: boolean;
  mine: boolean;
  progress: { done: number; total: number };
  attention: string[];
  nextMilestone: Milestone | null;
  milestones: Milestone[];
  updatedAt: string;
};
export type ProjectDetail = Project & {
  notes: { id: string; text: string; createdAt: string; authorId: string | null; author: string | null }[];
  time: {
    byPerson: { userId: string; name: string; hours: number }[];
    entries: { id: string; date: string; hours: number; billableHours: number; note: string | null; milestoneId: string | null; milestone: string | null; userId: string; user: string }[];
  };
};
export type Summary = { open: number; mine: number; attention: number; watch: number };
export type WeekDay = { date: string; milestones: { id: string; name: string; status: string; projectId: string; number: string; project: string }[]; projects: { id: string; number: string; name: string }[]; hours: number };
export type Week = { from: string; to: string; days: WeekDay[] };

export const useProjectPeople = () => useQuery({ queryKey: [...KEY, "people"], queryFn: () => api.get<Person[]>("/projects/people"), staleTime: 60_000 });

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
export const today = todayQc;

/** "late" | "soon" (within 3 days) | "later" | "none" — for the colour of a day */
export function dueTone(date: string | null, finished: boolean): "late" | "soon" | "later" | "none" {
  if (!date || finished) return "none";
  const now = todayQc();
  if (date < now) return "late";
  const days = Math.round((Date.parse(date) - Date.parse(now)) / 86_400_000);
  return days <= 3 ? "soon" : "later";
}
export const TONE_TEXT: Record<ReturnType<typeof dueTone>, string> = {
  late: "text-red-400",
  soon: "text-amber-300",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
};

/** Hours for the screen: 3 → "3 h", 1.5 → "1 h 30" */
export function hoursText(h: number): string {
  const total = Math.round((h || 0) * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return mm ? `${hh} h ${String(mm).padStart(2, "0")}` : `${hh} h`;
}

/** A milestone is not ticked: its state follows its tasks (reached when they are all done) */
export const MS_TONE: Record<MsStatus, string> = { todo: "text-muted-foreground", doing: "text-primary", done: "text-emerald-400" };

/** Seconds as h:mm:ss, for a running timer */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const apiMessage = (code: string | undefined, t: (k: string) => string) => (code && ["project_open_milestones", "project_dates", "person_invalid", "project_closed", "timesheet_locked", "client_unknown", "milestone_has_tasks", "timer_not_running", "time_billed", "project_no_client", "reply_needs_recipient"].includes(code) ? t(`projects.errors.${code}`) : t("common.error"));
