import { useState } from "react";
import { useTranslation } from "react-i18next";
import { hm } from "@shared/duration";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Segmented } from "./ui";
import { AttachmentsPanel } from "./DelegateFiles";
import type { DelegateActivity, DelegateTicket } from "./delegateShared";

type PanelTab = "activity" | "files";
type Filter = "all" | "notes" | "time";

/**
 * The ticket's activity and attachments, in two tabs. The activity is a conversation, newest first:
 * the client's people on the left, AKAB on the right in gold. A note that carries time shows it.
 */
export function ActivityPanel({ ticket, onChanged }: { ticket: DelegateTicket; onChanged: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PanelTab>("activity");
  return (
    <div className="space-y-3">
      <Segmented
        id={`delegate-panel-${ticket.id}`}
        value={tab}
        options={[
          { value: "activity", label: t("selfManaged.delegate.ticket.activity.title") },
          { value: "files", label: `${t("selfManaged.delegate.ticket.attachments.title")} (${ticket.attachments.length})` },
        ]}
        onChange={setTab}
      />
      {tab === "activity" ? (
        <Conversation activity={ticket.activity} />
      ) : (
        <AttachmentsPanel ticketId={ticket.id} files={ticket.attachments} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Conversation, newest first, with the filters Tout / Notes / Temps. "Notes" = the notes without time, "Temps" = those with time. */
function Conversation({ activity }: { activity: DelegateActivity[] }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const items = [...activity].sort((a, b) => b.at.localeCompare(a.at));
  const shown = items.filter((a) => filter === "all" || (filter === "time" ? a.workedMinutes != null : a.workedMinutes == null));

  return (
    <div className="space-y-3">
      <Segmented
        id="delegate-activity-filter"
        value={filter}
        className="w-fit"
        options={[
          { value: "all", label: t("selfManaged.delegate.ticket.activity.all") },
          { value: "notes", label: t("selfManaged.delegate.ticket.activity.notes") },
          { value: "time", label: t("selfManaged.delegate.ticket.activity.time") },
        ]}
        onChange={setFilter}
      />
      {!items.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("selfManaged.delegate.ticket.activity.empty")}</p>}
      {items.length > 0 && !shown.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("selfManaged.delegate.ticket.activity.emptyFiltered")}</p>}
      <ul className="space-y-3">
        {shown.map((a) => {
          // AKAB's replies: the portal writes them as "AKAB" and they are not a delegate's words
          const fromAkab = !a.byDelegate && a.author === "AKAB";
          return (
            <li key={a.id} className={cn("flex", fromAkab ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl border p-3.5 sm:max-w-[70%]",
                  fromAkab ? "rounded-br-md border-[color:var(--gold)]/35 bg-[color:var(--gold)]/12" : "rounded-bl-md border-[color:var(--glass-border)] bg-background/40",
                )}
              >
                <p className={cn("flex flex-wrap items-center gap-2 text-xs font-semibold", fromAkab ? "text-primary" : "text-muted-foreground")}>
                  <span>{fromAkab ? t("selfManaged.delegate.ticket.akab") : a.author}</span>
                  <span className="font-normal">· {dateTime(a.at)}</span>
                  {a.workedMinutes != null && a.workedMinutes > 0 && (
                    <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] font-medium text-foreground">
                      {t("selfManaged.delegate.ticket.activity.timeTag", { time: hm(a.workedMinutes / 60) })}
                    </span>
                  )}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm">{a.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
