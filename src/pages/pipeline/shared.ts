import { currentLocale } from "@/i18n";

export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export const STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "done"];
export const PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];

export type Recurrence = { freq: "daily" | "weekly" | "monthly" | "yearly"; interval: number; weekdays?: number[]; until?: string | null };
export type Visibility = "team" | "private" | "selected";

export type TaskCard = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assignee: string | null;
  createdById: string | null;
  createdBy: string | null;
  parentId: string | null;
  parentTitle: string | null;
  blockedById: string | null;
  blockedByTitle: string | null;
  /** Cannot start or finish: the task it waits for is not done */
  waiting: boolean;
  dueDate: string | null;
  dueTime: string | null;
  startDate: string | null;
  startTime: string | null;
  estimateMinutes: number | null;
  tags: string[];
  visibility: Visibility;
  recurrence: Recurrence | null;
  seriesId: string | null;
  files: number;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  hasNotes: boolean;
  checklist: { done: number; total: number };
  subtasks: { done: number; total: number };
  completedAt: string | null;
  updatedAt: string;
};

export type TaskFull = TaskCard & {
  notes: string;
  checklistItems: { id: string; text: string; done: boolean; position: number }[];
  comments: { id: string; author: string; text: string; createdAt: string }[];
  subtaskList: TaskCard[];
  fileList: { id: string; name: string; size: number; contentType: string; createdAt: string; by: string | null }[];
  viewerIds: string[];
};

export type Block = {
  start: string;
  end: string;
  title: string;
  kind: "task" | "ticket" | "event" | "break";
  refId: string | null;
  ticketNumber?: string | null;
  priority?: string | null;
  note?: string | null;
  overflow?: boolean;
  /** A priority pinned for the technician (of the day / of the week) */
  pinned?: "day" | "week";
  /** An event of the technician's Microsoft 365 calendar */
  o365?: boolean;
  allDay?: boolean;
  masked?: boolean;
};

export type DayItem = {
  key: string;
  kind: "task" | "ticket";
  refId: string;
  title: string;
  priority: TaskPriority;
  due: string | null;
  overdue: boolean;
  minutes: number;
  ticketNumber?: string | null;
  client?: string | null;
  blocked?: boolean;
  dueTime?: string | null;
  masked?: boolean;
  pin?: "day" | "week";
  pinNote?: string | null;
};

export type DayData = {
  date: string;
  userId: string;
  plan: { summary: string; blocks: Block[]; capacityMinutes: number; plannedMinutes: number; source: "ai" | "rules"; smsSentAt: string | null; updatedAt: string; calendar: string; calendarEvents: number };
  items: DayItem[];
  /** The AI's plan is older than the list: something to do is not in it */
  stale: boolean;
  absent: boolean;
  holiday: boolean;
  events: number;
  doneToday: number;
  workHours: { start: string; end: string; lunchStart: string; lunchEnd: string };
  ai: boolean;
};

export type Person = { id: string; name: string };

/** 6 h 15 / 45 min */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
}
export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const PRIORITY_STYLE: Record<TaskPriority, { dot: string; chip: string }> = {
  urgent: { dot: "bg-red-500", chip: "border-red-500/40 bg-red-500/10 text-red-300" },
  high: { dot: "bg-orange-400", chip: "border-orange-400/40 bg-orange-400/10 text-orange-300" },
  normal: { dot: "bg-sky-400", chip: "border-sky-400/30 bg-sky-400/10 text-sky-300" },
  low: { dot: "bg-slate-400", chip: "border-slate-400/30 bg-slate-400/10 text-slate-300" },
};
export const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: "border-slate-400/30 bg-slate-400/10 text-slate-300",
  doing: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  blocked: "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-300",
  done: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
};

const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
/** "mar. 20 oct." */
export const dayLabel = (ymd: string) => new Intl.DateTimeFormat(loc(), { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${ymd}T12:00:00`));
export const longDay = (ymd: string) => new Intl.DateTimeFormat(loc(), { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${ymd}T12:00:00`));
export const todayYmd = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
export const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** "37 ko" / "1,2 Mo" */
export function fileSize(n: number): string {
  const [b, kb, mb] = currentLocale() === "en" ? ["B", "KB", "MB"] : ["o", "Ko", "Mo"];
  if (n < 1024) return `${n} ${b}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${kb}`;
  return `${(n / 1024 / 1024).toFixed(1)} ${mb}`;
}
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
export const MAX_FILE = 5 * 1024 * 1024;
