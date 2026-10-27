import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { ticketErrorText } from "@/pages/tickets/shared";
import { money, type CrmContract } from "./shared";

export type Unmapped = { serviceId: number; product: string; productGroup: string; quantity: number; billingCycle: string; registrationDate: string | null; costCents: number; serviceName: string; kind: "recurring" | "recurring_yearly"; priceCents: number };

/** The client's ITCloud services that are on no contract: tick the ones that go on this contract (their line is made at once). */
export function MapItcloudDialog({ clientId, k, rows, onClose, onDone }: { clientId: string; k: CrmContract; rows: Unmapped[]; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const map = useMutation({
    mutationFn: async () => {
      for (const id of picked) await api.post(`/crm/clients/${clientId}/contracts/${k.id}/itcloud-services`, { serviceId: id });
      return picked.size;
    },
    onSuccess: (n) => {
      toast.success(t("crm.contracts.mapItcloudDone", { count: n }));
      onDone();
      onClose();
    },
    onError: (e) => {
      onDone();
      toast.error(ticketErrorText(t, e));
    },
  });
  const all = picked.size === rows.length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-5 text-sky-300" /> {t("crm.contracts.mapItcloudTitle")}
          </DialogTitle>
          <DialogDescription>{t("crm.contracts.mapItcloudHint")}</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={all} onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.serviceId)) : new Set())} aria-label={t("integrations.itcloud.list.selectAll")} />
          {t("integrations.itcloud.list.selected", { count: picked.size })}
        </label>
        <ul className="max-h-[50vh] divide-y divide-border/60 overflow-y-auto rounded-lg border text-sm">
          {rows.map((r) => (
            <li key={r.serviceId} className="flex items-center gap-3 px-3 py-2">
              <Checkbox
                checked={picked.has(r.serviceId)}
                onCheckedChange={(v) =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (v) n.add(r.serviceId);
                    else n.delete(r.serviceId);
                    return n;
                  })
                }
                aria-label={r.product}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {r.product} <span className="font-mono text-xs text-muted-foreground">× {r.quantity}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.productGroup} · {money(r.priceCents, i18n.language)} {r.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button type="button" disabled={!picked.size || map.isPending} onClick={() => map.mutate()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {map.isPending ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />} {t("crm.contracts.mapItcloudDo", { count: picked.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
