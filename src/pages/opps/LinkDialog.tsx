import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { OPP_LINK_KINDS, type OppLinkKind } from "@shared/opps";
import { oppError, useOppLinkables, useOppMutation, type OppDetail } from "./shared";

type Item = { id: string; label: string };

/** A charge is listed from the origin ticket (its Frais list); quotes, contracts and projects come from the client's linkables. */
function useCharges(o: OppDetail, enabled: boolean) {
  return useQuery({
    queryKey: ["opps", "charges", o.id],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<Item[]> => {
      const rows = await api.get<{ id: number | string; name?: string; description?: string }[]>(`/tickets/${o.ticket!.id}/charges`);
      return rows.map((r) => ({ id: String(r.id), label: r.name ?? r.description ?? String(r.id) }));
    },
  });
}

/** Link an existing quote, contract, project or charge of the client to the opportunity. */
export function LinkDialog({ o, onClose }: { o: OppDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const kinds = OPP_LINK_KINDS.filter((k) => k !== "charge" || Boolean(o.ticket));
  const [kind, setKind] = useState<OppLinkKind>(kinds[0] ?? "quote");
  const hasClient = Boolean(o.client);
  const isCharge = kind === "charge";
  const linkables = useOppLinkables(o.client?.id ?? null, isCharge ? "quote" : kind, !isCharge);
  const charges = useCharges(o, isCharge && Boolean(o.ticket));
  const items = isCharge ? charges : linkables;
  const enabled = isCharge ? Boolean(o.ticket) : hasClient;
  const linked = new Set(o.links.filter((l) => l.kind === kind).map((l) => l.refId));
  const add = useOppMutation(
    (refId: string) => api.post(`/opps/${o.id}/links`, { kind, refId }),
    () => toast.success(t("opps.detail.linkAdded")),
    (e) => toast.error(oppError(e, t)),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("opps.link.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("opps.link.title")}</DialogDescription>
        </DialogHeader>

        <Select value={kind} onValueChange={(v) => setKind(v as OppLinkKind)}>
          <SelectTrigger aria-label={t("opps.link.kind")} className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`opps.link.kinds.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!hasClient && !isCharge && <p className="text-sm text-muted-foreground">{t("opps.link.needClient")}</p>}
        {isCharge && !o.ticket && <p className="text-sm text-muted-foreground">{t("opps.link.needTicket")}</p>}

        {enabled && items.isLoading && <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />}
        {enabled && items.isSuccess && items.data.length === 0 && <p className="py-4 text-sm text-muted-foreground">{t("opps.link.empty")}</p>}
        {enabled && items.isSuccess && items.data.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {items.data.map((it) => {
              const done = linked.has(it.id);
              return (
                <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  <Button size="sm" variant={done ? "ghost" : "outline"} disabled={done || add.isPending} onClick={() => add.mutate(it.id)}>
                    {done ? t("opps.link.linked") : t("opps.link.add")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
