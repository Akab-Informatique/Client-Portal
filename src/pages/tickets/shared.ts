import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";

export type Status = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete";
export const STATUS_LIST: Status[] = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete"];
export type Priority = "critical" | "high" | "medium" | "low";
export type Viewer = { userId: string; name: string };
export type TicketSummary = {
  id: number;
  number: string;
  title: string;
  company: { id: number; name: string };
  contact: string;
  status: Status;
  priority: Priority;
  queue: string;
  assignee: { id: string; name: string } | null;
  createdAt: string;
  dueAt: string;
  updatedAt: string;
  startDate: string | null;
  viewers: Viewer[];
};
export type TicketDetail = TicketSummary & {
  description: string;
  source: "email" | "phone" | "portal" | "monitoring";
  hours: number;
  notes: { id: string; author: string; at: string; text: string; internal: boolean }[];
  /** AI assistant available to me */
  ai: boolean;
  options: { statuses: Status[]; priorities: Priority[]; queues: string[]; technicians: { id: string; name: string }[] };
};
export type AiAnalysis = {
  id: string;
  author: string | null;
  createdAt: string;
  content: { summary: string; nextSteps: string[]; risks: string[]; questions: string[]; suggestedPriority?: Priority | null };
};
export type TicketList = {
  demo: boolean;
  ai: boolean;
  metrics: { mine: number; unassigned: number; attention: number; statusAttention: number; attentionBreakdown: { overdue: number; dueToday: number; critical: number } };
  items: TicketSummary[];
  counts: Record<View, number>;
  facets: { queues: string[]; companies: { id: number; name: string }[]; statuses: Status[]; priorities: Priority[]; technicians: { id: string; name: string; open: number }[] };
};
export type View = "mine" | "unassigned" | "due" | "all";
export const VIEWS: View[] = ["mine", "unassigned", "due", "all"];

/** Filters kept in the address bar (shareable, survive a refresh). */
export const FILTER_KEYS = ["q", "assignee", "attention", "due", "created", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "sort"] as const;

export const PRIORITY_STYLE: Record<Priority, { bar: string; text: string; dot: string }> = {
  critical: { bar: "bg-red-500", text: "text-red-400", dot: "bg-red-500" },
  high: { bar: "bg-orange-500", text: "text-orange-400", dot: "bg-orange-500" },
  medium: { bar: "bg-[#ffce1a]", text: "text-primary", dot: "bg-[#ffce1a]" },
  low: { bar: "bg-slate-500", text: "text-muted-foreground", dot: "bg-slate-500" },
};
export const STATUS_STYLE: Record<Status, string> = {
  new: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  needsAttention: "border-red-500/50 bg-red-500/15 text-red-300",
  inProgress: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  waitingCustomer: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  waitingVendor: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  scheduled: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  complete: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
};

const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
export const shortDate = (iso: string) => new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" }).format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));
export const longDateTime = (iso: string) => new Intl.DateTimeFormat(loc(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** "overdue" | "today" | "soon" (≤ 2 days) | "later" */
export function dueState(iso: string, status: Status) {
  if (status === "complete") return "later";
  const due = new Date(iso);
  const now = new Date();
  if (due < now) return "overdue";
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  if (due <= end) return "today";
  return due.getTime() - now.getTime() < 2 * 86_400_000 ? "soon" : "later";
}

export function useTickets(view: View, filters: URLSearchParams) {
  const qs = new URLSearchParams({ view });
  for (const k of FILTER_KEYS) {
    const v = filters.get(k);
    if (v) qs.set(k, v);
  }
  return useQuery({
    queryKey: ["tickets", qs.toString()],
    queryFn: () => api.get<TicketList>(`/tickets?${qs}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
}

/**
 * While a ticket is open: tell the server every 10 s and get who else has it
 * open. Leaving (or closing the tab) removes me right away.
 */
export function usePresence(ticketId: number | null) {
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  useEffect(() => {
    if (!ticketId) return;
    let alive = true;
    setViewers(null);
    const beat = () =>
      api
        .post<{ viewers: Viewer[] }>(`/tickets/${ticketId}/presence`)
        .then((r) => alive && setViewers(r.viewers))
        .catch(() => undefined);
    void beat();
    const id = setInterval(beat, 10_000);
    const leave = () =>
      fetch(`/api/tickets/${ticketId}/presence`, { method: "DELETE", keepalive: true, headers: { "content-type": "application/json" } }).catch(() => undefined);
    window.addEventListener("pagehide", leave);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("pagehide", leave);
      void leave();
    };
  }, [ticketId]);
  return viewers;
}
