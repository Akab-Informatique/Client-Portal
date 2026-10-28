import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cloud, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

export type NewService = { id: string; name: string; kind: "recurring" | "recurring_yearly"; priceCents: number; costCents: number };

/**
 * A new service made right while a contract is being made or changed: a name, monthly or yearly, a price and a cost, then how many
 * and from which day. It is made in Inventory › Services (rights `services.manage`) and added to the contract at once.
 */
export function NewServiceDialog({ term, defaultDay, onClose, onCreated }: { term: { start: string; end: string } | null; defaultDay: string; onClose: () => void; onCreated: (s: NewService, quantity: number, addedOn: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", kind: "recurring" as "recurring" | "recurring_yearly", price: "", cost: "", taxable: true, quantity: "1", addedOn: defaultDay, vendorId: "" });
  const { data: vendors = [] } = useQuery({ queryKey: ["services", "vendors"], queryFn: () => api.get<{ id: string; name: string }[]>("/services/vendors") });
  const cents = (v: string) => Math.round((Number(v.replace(",", ".")) || 0) * 100);
  const quantity = Math.max(1, Math.round(Number(f.quantity) || 1));
  const make = useMutation({
    mutationFn: () => api.post<NewService>("/services", { name: f.name.trim(), description: "", kind: f.kind, priceCents: cents(f.price), costCents: cents(f.cost), taxable: f.taxable, active: true, vendorId: f.vendorId || null }),
    onSuccess: (svc) => {
      void qc.invalidateQueries({ queryKey: ["crm", "services-catalog"] });
      void qc.invalidateQueries({ queryKey: ["services"] });
      toast.success(t("crm.contracts.newServiceMade", { name: svc.name }));
      onCreated(svc, quantity, f.addedOn);
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  const dayOk = !term || (f.addedOn >= term.start && f.addedOn <= term.end);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-primary" /> {t("crm.contracts.newServiceTitle")}
          </DialogTitle>
          <DialogDescription>{t("crm.contracts.newServiceText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (f.name.trim() && dayOk) make.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ns-name">{t("services.name")}</Label>
            <Input id="ns-name" autoFocus required maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t("services.kindLabel")}</Label>
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "recurring" | "recurring_yearly" })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
                <option value="recurring">{t("services.kind.recurring")}</option>
                <option value="recurring_yearly">{t("services.kind.recurring_yearly")}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("services.cost")}</Label>
              <Input value={f.cost} inputMode="decimal" placeholder="0" onChange={(e) => setF({ ...f, cost: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("services.price")}</Label>
              <Input value={f.price} inputMode="decimal" placeholder="0" onChange={(e) => setF({ ...f, price: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
            <div className="space-y-1.5">
              <Label>{t("crm.contracts.window.quantity")}</Label>
              <Input value={f.quantity} inputMode="numeric" className="text-right font-mono" onChange={(e) => setF({ ...f, quantity: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("crm.contracts.startsOn")}</Label>
              <Input type="date" value={f.addedOn} min={term?.start} max={term?.end} onChange={(e) => setF({ ...f, addedOn: e.target.value })} aria-invalid={!dayOk} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("services.vendor")}</Label>
            <select value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
              <option value="">{t("services.noVendor")}</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{t("services.vendorHint")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={f.taxable} onCheckedChange={(v) => setF({ ...f, taxable: v })} /> {t("services.taxable")}
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!f.name.trim() || !dayOk || make.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {make.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.contracts.newServiceCreate")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
