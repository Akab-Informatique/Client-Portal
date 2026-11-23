import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { OppCandidate } from "./shared";

/**
 * Pick colleagues to tell by email: a list with a tick per person and a chip for each chosen one.
 * Used by the new-opportunity window (the sales people are preselected by the parent).
 */
export function NotifyPicker({ people, value, onChange, disabled }: { people: OppCandidate[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chosen = people.filter((p) => value.includes(p.id));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60",
              value.length > 0 && "text-foreground",
            )}
          >
            {value.length > 0 ? t("opps.create.notifyPick") : t("opps.create.notifyNone")}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-72 overflow-y-auto p-1">
          {people.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("opps.create.notifyNone")}</p>}
          {people.map((p) => {
            const on = value.includes(p.id);
            return (
              <button key={p.id} type="button" onClick={() => toggle(p.id)} aria-pressed={on} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                <span className={cn("flex size-4 items-center justify-center rounded border", on && "border-[color:var(--gold)] bg-[color:var(--gold)]/20 text-[color:var(--gold)]")}>
                  {on && <Check className="size-3" />}
                </span>
                <span className="flex-1 truncate">{p.name}</span>
                {p.sales && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("opps.create.salesTag")}</span>}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {chosen.map((p) => (
            <li key={p.id} className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 py-0.5 pl-2.5 pr-1 text-xs">
              {p.name}
              <button type="button" onClick={() => toggle(p.id)} disabled={disabled} className="rounded-full p-0.5 hover:bg-accent" aria-label={`${t("opps.create.notifyRemove")} ${p.name}`}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
