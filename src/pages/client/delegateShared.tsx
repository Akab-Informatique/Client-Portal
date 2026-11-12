import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What the server gives the delegate (see server/routes/delegate.ts). Nothing of AKAB's staff, billing or hours is in these types. */
export type DelegateStatus = { key: string; label: string; kind: string };
export type DelegatePriority = { key: string; label: string; kind: string };
export type DelegateContact = { id: string; name: string; email: string | null };
export type DelegateRef = { id: string; name: string };

export type DelegateOptions = {
  statuses: DelegateStatus[];
  priorities: DelegatePriority[];
  contacts: DelegateContact[];
};

export type DelegateListItem = {
  id: number;
  number: string;
  title: string;
  status: DelegateStatus;
  priority: DelegatePriority;
  contact: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  akabWorking: boolean;
  withClient?: boolean;
  delegate: DelegateRef | null;
};

export type DelegateList = {
  items: DelegateListItem[];
  total: number;
  page: number;
  pages: number;
  size: number;
};

/** One line of the conversation: a note the client's people or AKAB wrote, with the time noted on it when there is some */
export type DelegateActivity = {
  id: string;
  at: string;
  text: string;
  byDelegate: boolean;
  author: string;
  workedMinutes: number | null;
};

export type DelegateChecklistItem = {
  id: string;
  text: string;
  done: boolean;
  dependsOnId: string | null;
};

export type DelegateFile = { id: string; name: string; size: number; at: string };

export type DelegateTicket = {
  id: number;
  number: string;
  title: string;
  description: string;
  status: DelegateStatus;
  priority: DelegatePriority;
  /** The client's company name, when the server gives it */
  client?: string | null;
  contact: string | null;
  contactId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  akabWorking: boolean;
  team: { delegate: DelegateRef | null; delegates: DelegateRef[] };
  tags: string[];
  checklist: DelegateChecklistItem[];
  attachments: DelegateFile[];
  activity: DelegateActivity[];
};

/** Base of the delegate API as the api helper expects it (`/api` is added by the helper) */
export const DELEGATE_API = "/portal/delegate";

/** A maximum file size the server accepts (5 MB, checked before sending too) */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Status colours by the kind the server gives (the same palette as the client's ticket list) */
const STATUS_TONE: Record<string, string> = {
  new: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  inProgress: "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary",
  needsAttention: "border-orange-500/40 bg-orange-500/12 text-orange-600 dark:text-orange-300",
  waitingCustomer: "border-orange-500/40 bg-orange-500/12 text-orange-600 dark:text-orange-300",
  waitingVendor: "border-[color:var(--glass-border)] bg-foreground/[0.05] text-muted-foreground",
  scheduled: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
  complete: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
};
const STATUS_DOT: Record<string, string> = {
  new: "bg-sky-400",
  inProgress: "bg-[color:var(--gold)]",
  needsAttention: "bg-orange-400",
  waitingCustomer: "bg-orange-400",
  waitingVendor: "bg-muted-foreground/60",
  scheduled: "bg-violet-400",
  complete: "bg-emerald-400",
};
const PRIORITY_TONE: Record<string, string> = {
  critical: "border-red-500/40 bg-red-500/12 text-red-600 dark:text-red-300",
  high: "border-orange-500/40 bg-orange-500/12 text-orange-600 dark:text-orange-300",
  medium: "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary",
  low: "border-[color:var(--glass-border)] bg-foreground/[0.04] text-muted-foreground",
};

/** A status pill in the server's own label and the kind's colours */
export function StatusBadge({ status }: { status: DelegateStatus }) {
  return (
    <span className={cn("inline-flex max-w-full shrink-0 items-center gap-1.5 truncate rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_TONE[status.kind] ?? STATUS_TONE.inProgress)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status.kind] ?? "bg-[color:var(--gold)]")} />
      <span className="truncate">{status.label}</span>
    </span>
  );
}

/** A priority pill */
export function PriorityBadge({ priority }: { priority: DelegatePriority }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium", PRIORITY_TONE[priority.kind] ?? PRIORITY_TONE.medium)}>{priority.label}</span>;
}

/** The tone of a status or priority, for a chip that is also a select */
export function statusTone(kind: string): string {
  return STATUS_TONE[kind] ?? STATUS_TONE.inProgress;
}
export function priorityTone(kind: string): string {
  return PRIORITY_TONE[kind] ?? PRIORITY_TONE.medium;
}

/** A readable size, as the client portal writes it */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

/** Reads a file as base64 (the part after the data-URL comma) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The codes the delegate screens know a text for; any other merge_* code reads as a failed merge */
const KNOWN_CODES = new Set([
  "with_akab",
  "checklist_open",
  "item_blocked",
  "item_not_started",
  "invalid_value",
  "invalid_contact",
  "invalid_delegate",
  "rate_limited",
  "not_self_managed",
  "not_found",
  "not_linked",
  "forbidden",
  "file_too_big",
  "merge_same",
  "merge_already",
  "merge_target_merged",
  "merge_other_client",
]);

/** Turns a delegate API error into a text the person understands (the codes the server answers) */
export function useDelegateError() {
  const { t } = useTranslation();
  return (e: unknown): string => {
    const code = e instanceof ApiError ? e.code : "";
    if (KNOWN_CODES.has(code)) return t(`selfManaged.delegate.errors.${code}`);
    if (code.startsWith("merge_")) return t("selfManaged.delegate.errors.merge_failed");
    return t("selfManaged.delegate.errors.generic");
  };
}

/** True when the error is the company not being self-managed (the page shows one message for it) */
export const isNotSelfManaged = (e: unknown) => e instanceof ApiError && e.code === "not_self_managed";

/** The day of an ISO date (YYYY-MM-DD) for a date input, or "" */
export function dayOf(value: string | null | undefined): string {
  if (!value) return "";
  // a timestamp is read in Québec time (a due at 11 pm must not show as the next day); a plain day stays as it is
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}
