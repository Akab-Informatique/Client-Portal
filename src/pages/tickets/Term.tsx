import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type TicketTerm = "short" | "long";

/** The colour of a ticket's number: short term stays gold (as it always was), long term is orange. */
export const TERM_PILL: Record<TicketTerm, string> = {
  short: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  long: "border-orange-500/50 bg-orange-500/15 text-orange-400",
};
export const termPill = (term?: string | null) => TERM_PILL[term === "long" ? "long" : "short"];

/** Two buttons: short term / long term. Controlled (new ticket) or saved at once with `ticketId` (open ticket). */
export function TermPicker({ value, onChange, disabled, className }: { value: TicketTerm; onChange: (t: TicketTerm) => void; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("tickets.term.label")} className={cn("inline-flex rounded-md border p-0.5", className)}>
      {(["short", "long"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          disabled={disabled}
          title={t(`tickets.term.${k}Hint`)}
          onClick={() => value !== k && onChange(k)}
          className={cn("rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60", value === k ? `border ${TERM_PILL[k]}` : "border border-transparent text-muted-foreground hover:text-foreground")}
        >
          {t(`tickets.term.${k}`)}
        </button>
      ))}
    </div>
  );
}

/** The same picker on an existing ticket: a change is saved at once. */
export function TicketTermPicker({ ticketId, term, disabled }: { ticketId: number; term?: string | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: TicketTerm) => api.put(`/tickets/${ticketId}/term`, { term: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("tickets.term.saved"));
    },
    onError: () => toast.error(t("tickets.errors.generic", { defaultValue: "Erreur" })),
  });
  return <TermPicker value={term === "long" ? "long" : "short"} disabled={disabled || save.isPending} onChange={(v) => save.mutate(v)} />;
}

/** A small tag saying the type in words: "Court terme" / "Long terme" */
export function TermBadge({ term, className }: { term?: string | null; className?: string }) {
  const { t } = useTranslation();
  const k = term === "long" ? "long" : "short";
  return <span className={cn("shrink-0 rounded-full border px-1.5 text-[10px] font-semibold leading-4", TERM_PILL[k], className)}>{t(`tickets.term.${k}`)}</span>;
}
