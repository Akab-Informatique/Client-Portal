import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_STYLE, shortDate, type StatusKind } from "./shared";
import { useTicketWorkspace } from "./workspace";

export type ContactOpen = {
  total: number;
  items: { id: number; number: string; title: string; statusLabel: string | null; statusKind: StatusKind; dueAt: string; createdAt: string }[];
};

/** The contact's other open tickets (the last five, newest first). */
export function useContactOpen(contactId: string | null, exclude: number) {
  return useQuery({
    queryKey: ["tickets", "contact-open", contactId, exclude],
    queryFn: () => api.get<ContactOpen>(`/tickets/contacts/${encodeURIComponent(contactId!)}/open?exclude=${exclude}`),
    enabled: Boolean(contactId),
    staleTime: 30_000,
  });
}

export function ContactTicketsList({ data, isLoading }: { data: ContactOpen | undefined; isLoading: boolean }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  return (
    <div className="space-y-2">
      {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">{t("tickets.contactOpen.none")}</p>}
      <ul className="space-y-1">
        {data?.items.map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => ws.open(x.id)} className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent">
              <span className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-primary">{x.number}</span>
                <span className={cn("rounded-full border px-1.5 py-px text-[10px]", STATUS_STYLE[x.statusKind])}>{x.statusLabel ?? t(`tickets.statusKind.${x.statusKind}`, { defaultValue: x.statusKind })}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{shortDate(x.createdAt)}</span>
              </span>
              <span className="truncate text-sm">{x.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {data && data.total > data.items.length && <p className="text-[11px] text-muted-foreground">{t("tickets.contactOpen.more", { count: data.total - data.items.length })}</p>}
    </div>
  );
}
