import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDebounced, useOppClients, type OppClient } from "./shared";

/** A client picked by search (word by word, 20 at most): the opportunities scope, so a technician with only opps.create can use it. */
export function ClientPick({ value, onChange, disabled, label, placeholder, className }: { value: OppClient | null; onChange: (c: OppClient) => void; disabled?: boolean; label: string; placeholder: string; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const list = useOppClients(q, open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-left text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60", !value && "text-muted-foreground", className)}
        >
          <span className="truncate">{value ? value.name : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("opps.client.search")} aria-label={t("opps.client.search")} className="h-9" />
        <ul className="mt-2 max-h-64 overflow-y-auto">
          {(list.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                  setText("");
                }}
                className={cn("flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", value?.id === c.id && "text-[color:var(--gold)]")}
              >
                <span className="truncate">{c.name}</span>
              </button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">{t("opps.client.none")}</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
