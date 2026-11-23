import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { NewOppDialog, type OppPrefill } from "./NewOppDialog";
import { STATUS_TONE, useOppsOfTicket } from "./shared";

/**
 * In the ticket window: flag the ticket as an opportunity (prefilled from the ticket), and show the opportunities
 * already flagged on it. Nothing is changed on the ticket itself.
 */
export function TicketOpps({ tk }: { tk: { id: number; number: string; company: { name: string }; contactId: string | null } }) {
  const { t } = useTranslation();
  const can = useCan();
  const list = useOppsOfTicket(tk.id);
  const [creating, setCreating] = useState(false);
  const rows = list.data ?? [];
  if (!can("opps.create") && rows.length === 0) return null;
  const prefill: OppPrefill = { ticketId: tk.id, number: tk.number, clientName: tk.company.name, contactId: tk.contactId };

  return (
    <>
      {can("opps.create") && (
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating(true)}>
          <Flag className="size-4 text-[color:var(--gold)]" /> {t("opps.ticket.create")}
        </Button>
      )}
      {rows.map((r) => (
        <Link
          key={r.id}
          to={`/opps?opp=${r.id}`}
          className={cn("inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs hover:brightness-110", STATUS_TONE[r.status])}
          title={t("opps.ticket.open")}
        >
          <span className="font-mono">{r.number}</span>
          <span>{t(`opps.statuses.${r.status}`)}</span>
        </Link>
      ))}
      {creating && <NewOppDialog prefill={prefill} onClose={() => setCreating(false)} onCreated={() => setCreating(false)} />}
    </>
  );
}
