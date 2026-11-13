import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Shapes of /api/proj (see the contract: they mirror server/routes/proj.ts) */
export type ProjStatus = "planning" | "active" | "done" | "cancelled";
export type ProjPriority = "low" | "medium" | "high" | "urgent";
export type ProjTaskStatus = "todo" | "doing" | "done";
export type PersonRef = { id: string; name: string };

export type ProjectRow = {
  id: string;
  number: string;
  name: string;
  status: ProjStatus;
  client: PersonRef | null;
  lead: PersonRef | null;
  startDate: string | null;
  dueDate: string | null;
  soldHours: number | null;
  workedHours: number;
  taskTotal: number;
  taskDone: number;
  memberIds: string[];
  updatedAt: string;
};

export type ProjTask = {
  id: string;
  title: string;
  description: string;
  priority: ProjPriority;
  status: ProjTaskStatus;
  assignee: PersonRef | null;
  dueDate: string | null;
  position: number;
  doneAt: string | null;
};

export type ProjNote = {
  id: string;
  text: string;
  internal: boolean;
  author: PersonRef | null;
  createdAt: string;
  emailedTo: string[];
  tasks: { id: string; title: string }[];
};

export type ProjTimer = { startedAt: string; baseSeconds: number; paused: boolean; seconds: number };

export type QuoteSnapshot = {
  number: string;
  title: string;
  status: string;
  totalCents: number;
  lines: { description: string; details?: string | null; quantityX100: number; unitPriceCents: number; recurrence?: "once" | "monthly" | "yearly"; optional?: boolean }[];
  notes?: string | null;
};

export type ProjDetail = ProjectRow & {
  description: string;
  salesNotes: string;
  contact: PersonRef | null;
  members: PersonRef[];
  quote: QuoteSnapshot | null;
  quoteId: string | null;
  tasks: ProjTask[];
  notes: ProjNote[];
  worked: { hours: number; byPerson: { userId: string; name: string; hours: number }[] };
  timer: ProjTimer | null;
  canManage: boolean;
};

export type ProjTimeEntry = { id: string; userId: string; name: string; date: string; hours: number; note: string; billable: boolean; taskIds: string[] };

/** Open projects (planning + active) for the tickets list; the page filters them further on screen */
export function useProjectRows(enabled: boolean, status: "open" | "done" | "all" = "open") {
  return useQuery({ queryKey: ["proj", "list", status], queryFn: () => api.get<ProjectRow[]>(`/proj?status=${status}`), enabled, refetchInterval: 60_000 });
}

export function useProject(id: string | null) {
  return useQuery({ queryKey: ["proj", "detail", id], queryFn: () => api.get<ProjDetail>(`/proj/${id}`), enabled: Boolean(id), refetchInterval: 30_000 });
}

export const PROJ_PRIORITY_ORDER: ProjPriority[] = ["urgent", "high", "medium", "low"];
