import { useTranslation } from "react-i18next";
import { Link2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { SOURCE_ICON, STATUS_TONE, type OppRow } from "./shared";

/** The list of opportunities: one block per row, wraps on a narrow screen (never scrolls sideways). */
export function OppRows({ rows, archived, onOpen }: { rows: OppRow[]; archived: boolean; onOpen: (id: string) => void }) {
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.id}>
          <OppRow row={r} archived={archived} onOpen={() => onOpen(r.id)} />
        </li>
      ))}
    </ul>
  );
}

function OppRow({ row: r, archived, onOpen }: { row: OppRow; archived: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const SourceIcon = SOURCE_ICON[r.source];
  const needsCall = r.handling === "needs_call";
  return (
    <div className="group relative flex items-stretch gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
      {/* the whole row opens the window; the origin pill inside stops the click */}
      <button type="button" onClick={onOpen} aria-label={t("opps.detail.number", { number: r.number })} className="absolute inset-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--gold)]/50" />
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-md border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--gold)]">{r.number}</span>
          <span className="min-w-0 truncate font-medium">{r.client?.name ?? t("opps.unknownClient")}</span>
          <span className="min-w-0 truncate text-sm text-muted-foreground">· {r.contact?.name ?? t("opps.noContact")}</span>
          {archived && <Badge variant="outline" className={cn("ml-auto", STATUS_TONE[r.status])}>{t(`opps.statuses.${r.status}`)}</Badge>}
        </div>
        <p className="line-clamp-2 break-words text-sm text-muted-foreground">{r.description}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <SourceIcon className="size-3.5" /> {t(`opps.sources.${r.source}`)}
          </span>
          <span className={cn("rounded-full border px-2 py-0.5", needsCall ? "border-violet-400/40 bg-violet-400/10 text-violet-300" : "border-sky-400/30 bg-sky-400/10 text-sky-300")}>
            {t(`opps.handling.${r.handling}`)}
          </span>
          <span className="inline-flex items-center gap-1">
            <UserRound className="size-3.5" /> {r.owner?.name ?? t("opps.notAssigned")}
          </span>
          <span>{archived && r.closedAt ? t("opps.closedOn", { date: r.closedAt.slice(0, 10) }) : relativeTime(r.createdAt)}</span>
          {r.linkCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Link2 className="size-3.5" /> {t("opps.links", { count: r.linkCount })}
            </span>
          )}
          {r.ticket && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                ws.open(r.ticket!.id);
              }}
              className="pointer-events-auto relative z-10 inline-flex max-w-full items-center gap-1 truncate rounded-full border border-[color:var(--gold)]/30 px-2 py-0.5 text-[color:var(--gold)] hover:bg-[color:var(--gold)]/10"
              title={`${t("opps.origin")} ${r.ticket.number} · ${r.ticket.title}`}
            >
              <span className="font-mono">{r.ticket.number}</span>
              <span className="truncate">{r.ticket.title}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
