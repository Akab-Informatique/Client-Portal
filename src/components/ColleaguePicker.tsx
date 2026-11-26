import { useTranslation } from "react-i18next";
import { BellRing, Check, ChevronDown, Mail, MessagesSquare } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { usePeople } from "@/pages/pipeline/TaskDialog";

export type TellHow = { bell: boolean; email: boolean; chat: boolean };
export const DEFAULT_TELL: TellHow = { bell: true, email: true, chat: false };

/**
 * "Notify colleagues…" under an internal note: a drop-down of the active technicians and the Bell / Email / Teams toggles,
 * the same look as the ticket's note box (`tickets.noteTell.*`).
 */
export function ColleaguePicker({ value, onChange, how, onHow }: { value: string[]; onChange: (ids: string[]) => void; how: TellHow; onHow: (h: TellHow) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const people = usePeople();
  const colleagues = (people.data ?? []).filter((p) => p.id !== me.id);
  if (!colleagues.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", value.length ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
            <BellRing className="size-3" />
            {value.length ? t("tickets.noteTell.count", { count: value.length }) : t("tickets.noteTell.pick")}
            <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <ul className="max-h-64 overflow-y-auto">
            {colleagues.map((p) => {
              const on = value.includes(p.id);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onChange(on ? value.filter((i) => i !== p.id) : [...value, p.id])} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                    <span className={cn("flex size-4 items-center justify-center rounded border", on ? "border-violet-400 bg-violet-500/30" : "border-muted-foreground/40")}>{on && <Check className="size-3" />}</span>
                    {p.name}
                  </button>
                </li>
              );
            })}
          </ul>
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
              {t("tickets.noteTell.clear")}
            </button>
          )}
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex items-center gap-1" role="group" aria-label={t("tickets.noteTell.how")}>
          {([["bell", BellRing, "tickets.noteTell.bell"], ["email", Mail, "tickets.noteTell.email"], ["chat", MessagesSquare, "tickets.noteTell.chat"]] as const).map(([k, Icon, label]) => (
            <button key={k} type="button" aria-pressed={how[k]} onClick={() => onHow({ ...how, [k]: !how[k] })} className={cn("flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]", how[k] ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-3" /> {t(label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
