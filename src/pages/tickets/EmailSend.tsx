import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Mail } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { RecipientInput } from "@/pages/outlook/RecipientInput";
import { cn } from "@/lib/utils";
import { useContacts } from "./pickers";
import type { TicketDetail } from "./shared";

/**
 * Who gets a text by email from a ticket: the ticket's contact (the checkbox), and others — one click on one of
 * the client's contacts, or any address typed. Used by the time entry window and the reply box.
 */
export function EmailSend({
  ticket,
  contact,
  onContact,
  others,
  onOthers,
  contactLabel,
  idPrefix,
}: {
  ticket: TicketDetail | undefined;
  contact: boolean;
  onContact: (v: boolean) => void;
  others: string[];
  onOthers: (v: string[]) => void;
  /** The checkbox text, given who and which address */
  contactLabel: (who: string, email: string) => string;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const contactEmail = ticket?.contactInfo?.email ?? null;
  // the client's other contacts with an email address: one click adds them to the recipients
  const { data: companyContacts = [] } = useContacts(ticket?.company.id ?? null);
  const pickable = companyContacts.filter((c) => c.email && c.email.toLowerCase() !== contactEmail?.toLowerCase());
  const has = (email: string) => others.some((x) => x.toLowerCase() === email.toLowerCase());
  const toggle = (email: string) => onOthers(has(email) ? others.filter((x) => x.toLowerCase() !== email.toLowerCase()) : [...others, email]);
  return (
    <div className="space-y-2">
      <label className={cn("flex cursor-pointer items-center gap-2 text-sm", !contactEmail && "opacity-60")}>
        <Checkbox checked={contact} disabled={!contactEmail} onCheckedChange={(v) => onContact(v === true)} />
        <Mail className="size-4 text-primary" />
        {contactEmail ? contactLabel(ticket?.contact || contactEmail, contactEmail) : t("tickets.timer.notifyNoContact")}
      </label>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" aria-expanded={open}>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        {others.length ? t("tickets.timer.othersCount", { count: others.length }) : t("tickets.timer.others")}
      </button>
      {open && (
        <div className="space-y-1.5 rounded-xl border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.timer.sendTitle")}</p>
          {pickable.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">{t("tickets.timer.pickContacts")}</p>
              <div className="flex flex-wrap gap-1.5">
                {pickable.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={has(c.email!)}
                    title={c.email!}
                    onClick={() => toggle(c.email!)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      has(c.email!) ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/15 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <RecipientInput id={`${idPrefix}-others`} label={t("tickets.timer.othersLabel")} value={others} onChange={onOthers} />
          <p className="text-[11px] text-muted-foreground">{t("tickets.timer.sendHint")}</p>
        </div>
      )}
    </div>
  );
}
