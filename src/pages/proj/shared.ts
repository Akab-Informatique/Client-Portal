import { useCan, useMe } from "@/lib/session";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Shapes of /api/proj (see the contract: they mirror server/routes/proj.ts) */
export type ProjStatus = "planning" | "active" | "waiting_customer" | "waiting_vendor" | "delivered" | "done" | "cancelled";
export type ProjPriority = "low" | "medium" | "high" | "urgent";
export type ProjTaskStatus = "todo" | "doing" | "done";
export type PersonRef = { id: string; name: string };
export type ProjBillingMode = "hourly" | "contract" | "special" | "fixed" | "bank";
export type ProjFile = { id: string; name: string; size: number; contentType: string };

export type ProjectRow = {
  id: string;
  number: string;
  name: string;
  status: ProjStatus;
  client: PersonRef | null;
  lead: PersonRef | null;
  dueDate: string | null;
  stale?: boolean;
  watchDays?: number;
  watchOwn?: number | null;
  soldHours: number | null;
  billingMode: ProjBillingMode;
  deliveredAt?: string | null;
  workedHours: number;
  taskTotal: number;
  taskDone: number;
  taskOpen?: number;
  nextTaskDue?: string | null;
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
  files: ProjFile[];
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
  billing: { mode: ProjBillingMode; contractId: string | null; hourlyRate: number | null; fixedPrice: number | null; bankExpiresOn: string | null; billedAt: string | null; status: "none" | "pending" | "approved" | "posted"; invoiceNumber?: string; previewRate: number | null; prepaid: boolean };
  tasks: ProjTask[];
  notes: ProjNote[];
  worked: { hours: number; byPerson: { userId: string; name: string; hours: number }[] };
  timer: ProjTimer | null;
  canManage: boolean;
};

export type ProjTimeEntry = { id: string; userId: string; name: string; date: string; hours: number; note: string; billable: boolean; taskIds: string[] };

/** Open projects (planning + active) for the tickets list; the page filters them further on screen */
export function useProjectRows(enabled: boolean, status: "open" | "done" | "delivered" | "all" = "open", withDelivered = false) {
  const wd = withDelivered && status === "open";
  return useQuery({ queryKey: ["proj", "list", status, wd], queryFn: () => api.get<ProjectRow[]>(`/proj?status=${status}${wd ? "&withDelivered=1" : ""}`), enabled, refetchInterval: 60_000 });
}

/** Whether I check and bill projects (a manager or a picked reviewer): the server decides, the page only asks */
export function useIsReviewer(enabled: boolean): boolean {
  const q = useQuery({ queryKey: ["proj", "delivery-reviewers"], queryFn: () => api.get<{ mine?: boolean }>("/proj/delivery-reviewers"), enabled, staleTime: 5 * 60_000 });
  return Boolean(q.data?.mine);
}

/** How many open projects I lead or work on: added to the tickets count of the "Tickets / Projects" button */
export function useMyProjectCount(): number {
  const can = useCan();
  const me = useMe();
  const rows = useProjectRows(can("proj.view"));
  return (rows.data ?? []).filter((p) => p.lead?.id === me.id || p.memberIds.includes(me.id)).length;
}

export function useProject(id: string | null) {
  return useQuery({ queryKey: ["proj", "detail", id], queryFn: () => api.get<ProjDetail>(`/proj/${id}`), enabled: Boolean(id), refetchInterval: 30_000 });
}

export const PROJ_PRIORITY_ORDER: ProjPriority[] = ["urgent", "high", "medium", "low"];
