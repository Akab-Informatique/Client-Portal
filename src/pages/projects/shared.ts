import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type BillingMode = "contract" | "hourly" | "special" | "fixed";
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
  checkpointDate: string | null;
  checkpointTime: string | null;
  contractId: string | null;
  dependsOnId: string | null;
  groupId: string | null;
  /** Waits for another task that is not done yet */
  waiting: boolean;
  late: boolean;
  estimateHours: number | null;
  hours: number;
};
export type TaskDetail = {
  id: string;
  projectId: string;
  project: { id: string; number: string; name: string; clientId: string | null; status: Status; billingMode: BillingMode; hourlyRate: number | null };
  milestone: { id: string; name: string };
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  checkpointDate: string | null;
  checkpointTime: string | null;
  contractId: string | null;
  dependsOnId: string | null;
  dependsOn: { id: string; title: string; done: boolean } | null;
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
  startDate: string | null;
  dueDate: string | null;
  late: boolean;
  /** Sent to Accounting › Approbation (a done milestone): its time is work to bill under Jalons */
  sentToApprovalAt: string | null;
  budgetHours: number | null;
  hours: number;
  tasksDone: number;
  tasksTotal: number;
  /** Simple groups of tasks inside the milestone */
  groups?: { id: string; name: string }[];
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
  billingMode: BillingMode;
  /** Dollars */
  hourlyRate: number | null;
  fixedPrice: number | null;
  /** The contract the time is billed under, with what an hour costs under it (null: the hours are included) */
  contract: { id: string; name: string; hourlyRate: number | null } | null;
  /** Follow up every N days; the next follow-up day and the last one done */
  checkpointEveryDays: number | null;
  checkpointDate: string | null;
  lastFollowupOn: string | null;
  hours: number;
  following: boolean;
  /** Checkpoint of the next open task (YYYY-MM-DD HH:MM), the list is sorted by it */
  nextCheckpoint?: string | null;
  /** One of my open tasks has its checkpoint or due day today */
  todayMine?: boolean;
  mine: boolean;
  progress: { done: number; total: number };
  attention: string[];
  nextMilestone: Milestone | null;
  milestones: Milestone[];
  updatedAt: string;
};
export type Reminder = { id: string; remindOn: string; text: string; done: boolean; userId: string | null; user: string | null };
export type ProjectDetail = Project & {
  reminders: Reminder[];
  notes: { id: string; text: string; internal: boolean; fromClient: boolean; createdAt: string; authorId: string | null; author: string | null }[];
  time: {
    byPerson: { userId: string; name: string; hours: number }[];
    entries: { id: string; date: string; hours: number; billableHours: number; note: string | null; milestoneId: string | null; milestone: string | null; task: string | null; ticket: { number: string | null; title: string | null } | null; userId: string; user: string }[];
  };
  /** The quote it was made from */
  quote: { id: string; number: string } | null;
  /** Sold against worked (hours and money); the hours of its tied tickets included */
  sold: { hours: number | null; priceCents: number | null; rateCents: number | null; workedHours: number; ticketHours: number; diffHours: number | null; workedValueCents: number | null; diffCents: number | null };
  /** The tickets tied to the project (their time counts in it) */
  tickets: { id: number; number: string; title: string; status: string; done: boolean; hours: number }[];
  /** The price sold sent to Approbation (once), and the quote's deposit taken off it */
  billing: { invoicedAt: string | null; lines: { id: string; description: string; amountCents: number; status: string; invoiceId: string | null; number: string | null }[]; deposit: { number: string; invoiceId: string; subtotalCents: number } | null };
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

export const apiMessage = (code: string | undefined, t: (k: string) => string) => (code && ["project_open_milestones", "project_dates", "person_invalid", "project_closed", "timesheet_locked", "client_unknown", "milestone_has_tasks", "timer_not_running", "time_billed", "project_no_client", "reply_needs_recipient", "contract_required", "contract_invalid", "contract_needs_client", "rate_required", "no_followup", "task_blocked", "task_cycle", "task_invalid"].includes(code) ? t(`projects.errors.${code}`) : t("common.error"));
