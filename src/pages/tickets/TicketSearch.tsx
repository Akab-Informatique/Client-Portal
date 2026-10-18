import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { TicketSummary } from "./shared";

/** Find a ticket (global search). */
export function TicketSearch({ onPick, autoFocus = true }: { onPick: (t: { id: number; number: string; title: string }) => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "search", q, false],
    queryFn: () => api.get<{ items: TicketSummary[] }>(`/tickets/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus={autoFocus} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("planning.searchTicket")} className="pl-9" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {q.length >= 2 && data && (
        <ul className="max-h-44 overflow-y-auto rounded-lg border">
          {data.items.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{t("tickets.global.none")}</li>}
          {data.items.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => onPick({ id: x.id, number: x.number, title: x.title })}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{x.number}</span>
                <span className="truncate">{x.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
