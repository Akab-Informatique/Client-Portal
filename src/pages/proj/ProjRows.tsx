import { STALE_ROW } from "@/components/WatchReminder";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import type { ProjectRow, ProjStatus } from "./shared";

/** Which rows the Tickets list shows: both, tickets only, projects only. */
export type ProjKind = "all" | "tickets" | "projects";
export const PROJ_KINDS: ProjKind[] = ["all", "tickets", "projects"];

/** Lower case, accents removed: the word search of the list. */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * The projects that fit what the list is filtered on. `view` is the tickets' view
 * (mine = lead or team member, unassigned = no lead); `assignee` and `company` are
 * the tickets' own filters, read for projects too; `q` is a word search on the
 * number, the name and the client name.
 */
export function filterProjectRows(
  rows: ProjectRow[],
  o: { q: string; view: string; meId: string; assignee: string[]; company: string[]; companyNames: Map<string, string> },
): ProjectRow[] {
  const words = normalizeText(o.q).split(/\s+/).filter(Boolean);
  const companyNames = o.company.map((c) => normalizeText(o.companyNames.get(c) ?? ""));
  return rows.filter((p) => {
    const mine = p.lead?.id === o.meId || p.memberIds.includes(o.meId);
    if (o.view === "mine" && !mine) return false;
    if (o.view === "unassigned" && p.lead) return false;
    if (o.assignee.length && !o.assignee.some((a) => (a === "none" ? !p.lead : p.lead?.id === a || p.memberIds.includes(a)))) return false;
    if (o.company.length) {
      const ok = o.company.some((c, i) => p.client?.id === c || (Boolean(companyNames[i]) && p.client !== null && normalizeText(p.client.name) === companyNames[i]));
      if (!ok) return false;
    }
    if (words.length) {
      const hay = normalizeText([p.number, p.name, p.client?.name ?? ""].join(" "));
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Segmented switch Tout / Billets / Projets (kept in the address as `kind`). */
export function KindSwitch({ value, onChange }: { value: ProjKind; onChange: (k: ProjKind) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center rounded-xl border bg-background/40 p-0.5" role="group" aria-label={t("projList.kind.label")}>
      {PROJ_KINDS.map((k) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(k)}
            className={cn(
              "h-7 rounded-lg px-2.5 text-xs font-medium transition-colors",
              on ? (k === "projects" ? "bg-violet-500/20 text-violet-200" : k === "tickets" ? "bg-[color:var(--gold)]/15 text-primary" : "bg-white/10 text-foreground") : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`projList.kind.${k}`)}
          </button>
        );
      })}
    </div>
  );
}

/** T = ticket (amber), P = project (violet): what the two kinds of row look like. */
export function KindLegend() {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1" title={t("projList.legend.ticketHint")}>
        <span className="flex size-4 items-center justify-center rounded border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-mono text-[10px] font-semibold text-primary">T</span>
        {t("projList.legend.ticket")}
      </span>
      <span className="flex items-center gap-1" title={t("projList.legend.projectHint")}>
        <span className="flex size-4 items-center justify-center rounded border border-violet-400/60 bg-violet-500/15 font-mono text-[10px] font-semibold text-violet-200">P</span>
        {t("projList.legend.project")}
      </span>
    </span>
  );
}

const STATUS_TONE: Record<ProjStatus, string> = {
  planning: "border-violet-400/40 text-violet-300",
  active: "border-violet-400/70 bg-violet-500/20 text-violet-100",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  cancelled: "border-slate-500/40 text-slate-400",
};

const NUMBER_PILL = "shrink-0 rounded border border-violet-400/50 bg-violet-500/15 px-1.5 font-mono text-[11px] font-semibold text-violet-200";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isLate(p: ProjectRow) {
  return Boolean(p.dueDate) && p.dueDate! < todayIso() && p.status !== "done" && p.status !== "cancelled";
}

function hoursText(p: ProjectRow, t: (k: string, o?: Record<string, unknown>) => string) {
  if (p.soldHours == null) return null;
  const f = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return t("projList.hours", { worked: f(p.workedHours), sold: f(p.soldHours) });
}

/** A project as a row of the Tickets table: the same columns (`--o-*` order) as a ticket row, violet. */
export function ProjRow({ p, active, onOpen }: { p: ProjectRow; active?: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const others = p.memberIds.filter((id) => id !== p.lead?.id).length;
  const progress = p.taskTotal > 0 ? t("projList.tasks", { done: p.taskDone, total: p.taskTotal }) : null;
  const hours = hoursText(p, t);
  const late = isLate(p);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        aria-label={`${p.number} ${p.name}`}
        className={cn(
          "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400/60",
          // a violet tint and a violet left bar (border + 4px less padding keeps the columns aligned with the tickets)
          "group relative isolate grid w-full grid-cols-1 gap-x-3 gap-y-1.5 border-l-4 border-violet-500 bg-violet-500/[0.07] py-2.5 pl-9 pr-5 text-left transition-colors hover:bg-violet-500/[0.13] xl:min-w-[var(--tk-min)] xl:grid-cols-[var(--tk-cols)] xl:items-center",
          active && "bg-violet-500/[0.14]",
          p.stale && p.status !== "done" && p.status !== "cancelled" && STALE_ROW,
        )}
      >
        <span aria-hidden className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-violet-300">
          <FolderOpen className="size-3.5" />
        </span>
        <span className="min-w-0 xl:[order:var(--o-ticket)]">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={NUMBER_PILL}>{p.number}</span>
            <span className="min-w-0 break-words font-medium">{p.name}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {progress && <span>{progress}</span>}
            {hours && <span className="font-mono tabular-nums">{hours}</span>}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 xl:contents">
          <span className="min-w-0 xl:[order:var(--o-status)]">
            <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight", STATUS_TONE[p.status])}>{t(`projList.status.${p.status}`)}</span>
          </span>
          <span className="min-w-0 text-xs xl:[order:var(--o-company)]">
            {p.client ? <span className="block break-words leading-snug">{p.client.name}</span> : <span className="text-muted-foreground/60">—</span>}
          </span>
          <span className={cn("min-w-0 whitespace-nowrap font-mono text-[11px] tabular-nums xl:[order:var(--o-due)]", late ? "font-semibold text-red-300" : "text-muted-foreground/70")}>{p.dueDate ? shortDate(p.dueDate) : "—"}</span>
          <span className="min-w-0 text-muted-foreground/60 xl:[order:var(--o-priority)]">—</span>
          <span className="min-w-0 xl:[order:var(--o-assignee)]">
            {p.lead ? (
              <span className="flex min-w-0 items-center gap-2 pr-1 text-xs">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-violet-400/40 bg-violet-500/15 text-[10px] font-semibold text-violet-200">{initials(p.lead.name)}</span>
                <span className="min-w-0 truncate leading-snug" title={p.lead.name}>{p.lead.name}</span>
              </span>
            ) : (
              <span className="pl-1 text-xs italic text-muted-foreground">{t("projList.noLead")}</span>
            )}
          </span>
          <span className="flex min-w-0 items-center text-xs text-muted-foreground xl:[order:var(--o-secondary)]" title={t("projList.membersHint")}>
            {others > 0 ? t("projList.members", { count: others }) : "—"}
          </span>
        </span>
      </div>
    </li>
  );
}

/** A project as a line of the Compact view: the columns are the view's own (`order`, `gridStyle`). */
export function ProjCompactRow({ p, order, gridStyle, onOpen }: { p: ProjectRow; order: readonly string[]; gridStyle: CSSProperties; onOpen: () => void }) {
  const { t } = useTranslation();
  const late = isLate(p);
  const dash = <span className="text-xs text-muted-foreground/60">—</span>;
  const cells: Record<string, ReactNode> = {
    ticket: (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={NUMBER_PILL}>{p.number}</span>
        <span className="truncate font-medium" title={p.name}>
          {p.name}
        </span>
      </span>
    ),
    company: <span className="truncate text-xs text-muted-foreground">{p.client?.name ?? "—"}</span>,
    priority: dash,
    milestone: dash,
    assignee: <span className="truncate text-xs text-muted-foreground">{p.lead?.name ?? "—"}</span>,
    secondary: dash,
    due: <span className={cn("whitespace-nowrap font-mono text-[11px] tabular-nums", late ? "font-semibold text-red-300" : "text-muted-foreground/70")}>{p.dueDate ? shortDate(p.dueDate) : "—"}</span>,
    status: <span className={cn("inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight", STATUS_TONE[p.status])}>{t(`projList.status.${p.status}`)}</span>,
  };
  return (
    <li className="relative">
      <button type="button" onClick={onOpen} aria-label={`${p.number} ${p.name}`} style={gridStyle} className="relative grid w-full items-center gap-x-3 border-l-4 border-violet-500 bg-violet-500/[0.07] py-1 pl-3 pr-4 text-left text-sm transition-colors hover:bg-violet-500/[0.13]">
        {order.map((c) => (
          <div key={c} className="min-w-0">
            {cells[c] ?? null}
          </div>
        ))}
      </button>
    </li>
  );
}

/** Toggle: keep the projects grouped apart from the tickets (off = mixed, sorted by due date). */
export function GroupToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={value}
      title={t("projList.kind.groupHint")}
      onClick={() => onChange(!value)}
      className={cn("h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors", value ? "border-violet-400/50 bg-violet-500/20 text-violet-200" : "text-muted-foreground hover:text-foreground")}
    >
      {t("projList.kind.group")}
    </button>
  );
}

/**
 * Where each project goes among tickets sorted by due date: `before` maps a ticket id to the projects that come right before it,
 * `tail` is what goes after the last ticket. `lo` / `hi` (YYYY-MM-DD) keep only the projects due in [lo, hi) — for a page of a list.
 */
export function slotProjects(items: { id: number; dueAt: string }[], projects: ProjectRow[], lo?: string | null, hi?: string | null) {
  const sorted = [...projects]
    .filter((p) => (lo == null || (p.dueDate ?? "9999") >= lo) && (hi == null || (p.dueDate ?? "9999") < hi))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const before = new Map<number, ProjectRow[]>();
  const tail: ProjectRow[] = [];
  for (const p of sorted) {
    const day = p.dueDate ?? "9999";
    const at = items.find((tk) => tk.dueAt.slice(0, 10) > day);
    if (!at) tail.push(p);
    else before.set(at.id, [...(before.get(at.id) ?? []), p]);
  }
  return { before, tail };
}
