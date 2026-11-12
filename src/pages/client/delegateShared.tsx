import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What the server gives the delegate (see server/routes/delegate.ts) */
export type DelegateStatus = { key: string; label: string; kind: string };
export type DelegatePriority = { key: string; label: string; kind: string };
export type DelegateContact = { id: string; name: string; email: string | null };

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
  withClient: boolean;
};

export type DelegateList = {
  items: DelegateListItem[];
  total: number;
  page: number;
  pages: number;
  size: number;
};

export type DelegateActivity = {
  id: string;
  at: string;
  text: string;
  internal: boolean;
  byDelegate: boolean;
  author: string;
};

export type DelegateTicket = {
  id: number;
  number: string;
  title: string;
  description: string;
  status: DelegateStatus;
  priority: DelegatePriority;
  contact: string | null;
  contactId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  withClient: boolean;
  withAkab: boolean;
  attachments: { id: string; name: string; size: number; at: string }[];
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

/** Turns a delegate API error into a text the person understands (the codes the server answers) */
export function useDelegateError() {
  const { t } = useTranslation();
  return (e: unknown): string => {
    const code = e instanceof ApiError ? e.code : "";
    const known = [
      "with_akab",
      "checklist_open",
      "invalid_value",
      "invalid_contact",
      "rate_limited",
      "not_self_managed",
      "not_found",
      "not_linked",
      "forbidden",
    ];
    return known.includes(code) ? t(`selfManaged.delegate.errors.${code}`) : t("selfManaged.delegate.errors.generic");
  };
}

/** True when the error is the company not being self-managed (the page shows one message for it) */
export const isNotSelfManaged = (e: unknown) => e instanceof ApiError && e.code === "not_self_managed";

/** The day of an ISO date (YYYY-MM-DD) for a date input, or "" */
export function dayOf(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : "";
}
