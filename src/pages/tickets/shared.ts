import { useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";

/**
 * Statuses, priorities and queues are the source's own lists (Autotask lets
 * every MSP rename them): a value, its label (null = use our translation of
 * the kind) and a kind used for colours and "open/closed".
 */
export type StatusKind = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete" | "other";
export type PriorityKind = "critical" | "high" | "medium" | "low";
export type Choice<K extends string = string> = { value: string; label: string | null; kind: K };
/** @deprecated kept for the AI suggestion (a kind) */
export type Priority = PriorityKind;
export type Status = StatusKind;
export type Viewer = { userId: string; name: string };
export type TicketSummary = {
  id: number;
  number: string;
  title: string;
  company: { id: number; name: string };
  contact: string;
  contactId: string | null;
  status: string;
  statusLabel: string | null;
  statusKind: StatusKind;
  priority: string;
  priorityLabel: string | null;
  priorityKind: PriorityKind;
  queue: string;
  queueLabel: string;
  assignee: { id: string; name: string } | null;
  secondary: { id: string; name: string }[];
  excerpt: string;
  createdAt: string;
  dueAt: string;
  updatedAt: string;
  startDate: string | null;
  /** Restriction: no work before the start date */
  startLocked?: boolean;
  viewers: Viewer[];
  /** This ticket is one of my priorities (given by an admin) */
  myPriority?: "day" | "week";
};
export type TicketDetail = TicketSummary & {
  description: string;
  source: string;
  hours: number;
  /** Notes and time entries (work done), oldest first */
  notes: { id: string; author: string; at: string; text: string; internal: boolean; kind?: "note" | "time"; hours?: number; internalText?: string; billable?: boolean; offsetHours?: number }[];
  /** AI assistant available to me */
  ai: boolean;
  /** Parts Autotask could not give (notes, time) */
  warnings?: { part: "notes" | "time"; detail: string }[];
  /** The ticket device (absent while the full ticket loads) */
  assetId?: string | null;
  asset?: AssetView | null;
  /** The contact phone and email (absent while the full ticket loads) */
  contactInfo?: { email: string | null; phone: string | null } | null;
  demo: boolean;
  options: {
    statuses: Choice<StatusKind>[];
    priorities: Choice<PriorityKind>[];
    queues: Choice[];
    technicians: { id: string; name: string }[];
  };
};
/** A client device (Autotask configuration item) with its RMM links. */
export type AssetView = {
  id: string;
  name: string;
  type: string | null;
  serial: string | null;
  companyId: number;
  contactId: string | null;
  contactName: string | null;
  hostname: string | null;
  ip: string | null;
  os: string | null;
  lastUser: string | null;
  lastSeen: string | null;
  warrantyEnd: string | null;
  rmm: { id: string | null; uid: string | null };
  /** RMM name and links; null when the RMM is not set up or an id is missing */
  links: { rmm: string | null; device: string | null; remote: string | null };
};
export type AiAnalysis = {
  id: string;
  author: string | null;
  createdAt: string;
  content: { summary: string; nextSteps: string[]; risks: string[]; questions: string[]; suggestedPriority?: Priority | null };
};
/** A tile's details: per category, the source's label (or the portal's wording for the kind) and how many */
export type Tally = { label: string | null; kind?: string; count: number }[];

export type TicketList = {
  demo: boolean;
  /** Autotask mode, and my portal account is not linked to an Autotask user */
  notLinked: boolean;
  ai: boolean;
  metrics: {
    mine: number;
    unassigned: number;
    attention: number;
    statusAttention: number;
    attentionBreakdown: { overdue: number; dueToday: number; critical: number };
    /** By category, for the tiles' details: mine by status, unassigned by priority, "needs attention" by technician */
    breakdown?: Record<"mine" | "unassigned" | "statusAttention", Tally>;
  };
  /** My saved filters shown as buttons, with their counts (by status) */
  buttons?: { id: string; name: string; query: string; count: number; breakdown?: Tally }[];
  items: TicketSummary[];
  counts: Record<View, number>;
  facets: {
    queues: Choice[];
    companies: { id: number; name: string }[];
    statuses: Choice<StatusKind>[];
    priorities: Choice<PriorityKind>[];
    technicians: { id: string; name: string; open: number }[];
  };
};
export type View = "mine" | "unassigned" | "due" | "all";
export const VIEWS: View[] = ["mine", "unassigned", "due", "all"];

/** Filters kept in the address bar (shareable, survive a refresh). */
export const FILTER_KEYS = ["q", "assignee", "attention", "statusKind", "due", "created", "status", "priority", "company", "queue", "dueFrom", "dueTo", "startFrom", "startTo", "sort"] as const;

export const PRIORITY_STYLE: Record<PriorityKind, { bar: string; text: string; dot: string }> = {
  critical: { bar: "bg-red-500", text: "text-red-400", dot: "bg-red-500" },
  high: { bar: "bg-orange-500", text: "text-orange-400", dot: "bg-orange-500" },
  medium: { bar: "bg-[#ffce1a]", text: "text-primary", dot: "bg-[#ffce1a]" },
  low: { bar: "bg-slate-500", text: "text-muted-foreground", dot: "bg-slate-500" },
};
/** Priority colour (r, g, b) for the glowing hue at the start of a ticket. */
const PRIORITY_RGB: Record<PriorityKind, string> = { critical: "239, 68, 68", high: "249, 115, 22", medium: "255, 206, 26", low: "100, 116, 139" };

/**
 * A hue that glows from the left edge and fades out behind the ticket number
 * and title (instead of a hard coloured bar). strength 1 = list row.
 */
export function priorityGlow(kind: PriorityKind, strength = 1): CSSProperties {
  return glow(PRIORITY_RGB[kind], strength);
}

/** Due-date colour: overdue, due today, within 2 days, on time, done. */
const DUE_RGB = { overdue: "239, 68, 68", today: "249, 115, 22", soon: "255, 206, 26", later: "16, 185, 129", done: "100, 116, 139" } as const;

/** The glowing hue from the due date (how urgent the ticket is now). */
export function dueGlow(dueAt: string, status: StatusKind, strength = 1): CSSProperties {
  return glow(DUE_RGB[status === "complete" ? "done" : dueState(dueAt, status)], strength * (status === "complete" ? 0.6 : 1));
}

function glow(c: string, strength: number): CSSProperties {
  const a = (x: number) => Math.min(1, x * strength).toFixed(2);
  return {
    backgroundImage: `radial-gradient(120% 90% at 0% 50%, rgba(${c}, ${a(0.34)}) 0%, rgba(${c}, ${a(0.12)}) 38%, transparent 72%), linear-gradient(90deg, rgba(${c}, ${a(0.55)}) 0, rgba(${c}, 0) 3px)`,
  };
}

export const STATUS_STYLE: Record<StatusKind, string> = {
  new: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  needsAttention: "border-red-500/50 bg-red-500/15 text-red-300",
  inProgress: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  waitingCustomer: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  waitingVendor: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  scheduled: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  complete: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  other: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

/** Display name of a status / priority: the source's label, else our translation of its kind. */
export function useChoiceText() {
  const { t } = useTranslation();
  return {
    status: (c: { label: string | null; kind: StatusKind }) => c.label ?? t(`tickets.status.${c.kind}`),
    priority: (c: { label: string | null; kind: PriorityKind }) => c.label ?? t(`tickets.priority.${c.kind}`),
  };
}

const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
export const shortDate = (iso: string) => new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" }).format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));
/** "16 oct. 17 h 00" / "Oct 16, 5:00 PM": the day and the time, short */
export const shortDateTime = (iso: string) => new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
export const longDateTime = (iso: string) => new Intl.DateTimeFormat(loc(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** "overdue" | "today" | "soon" (≤ 2 days) | "later" */
export function dueState(iso: string, status: StatusKind) {
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

/**
 * Message for a failed ticket action. Autotask's own reason (e.g. a required
 * field) is shown as is; "not linked" explains what to do.
 */
export function ticketErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "autotask_not_linked") return t("tickets.errors.notLinked");
    if (e.code === "ticket_not_started") return t("tickets.startLock.refused", { date: shortDate(e.fields?.find((f) => f.path === "startDate")?.message ?? "") });
    if (e.code === "autotask_permission") return t("tickets.errors.permission");
    if (e.code === "insufficient_stock") return t("tickets.errors.insufficient_stock");
    if (e.code === "serial_unavailable" || e.code === "serials_required") return t(`tickets.errors.${e.code}`);
    const detail = e.fields?.find((f) => f.path === "autotask")?.message;
    if (detail) return t("tickets.errors.autotask", { detail });
    if (e.code === "invalid_contact") return t("tickets.errors.invalidContact");
    if (e.code === "invalid_contract") return t("tickets.errors.invalidContract");
    if (e.code === "company_exists") return t("tickets.errors.companyExists");
    if (e.code.startsWith("autotask_")) return t(`integrations.errors.${e.code.slice(9)}`, { defaultValue: t("common.error") });
  }
  return t("common.error");
}
