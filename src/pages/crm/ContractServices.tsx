import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { prorata } from "@shared/prorata";
import { shortDate, ticketErrorText } from "@/pages/tickets/shared";
import { money, type CrmContract } from "./shared";

type Line = {
  id: string;
  name: string;
  kind: "recurring" | "recurring_yearly";
  priceCents: number;
  costCents: number;
  addedOn: string;
  firstCents: number | null;
  totalCents: number | null;
  periods: { from: string; to: string; days: number; periodDays: number; full: boolean; amountCents: number }[];
};
type CatalogItem = { id: string; name: string; kind: "recurring" | "recurring_yearly"; priceCents: number; costCents: number };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/**
 * The recurring services of a contract, under it: each with the day it was added, its first charge (prorated
 * when it starts in the middle of a period) and its total over the contract's term. "Add a service" picks one
 * from the catalogue and a day, and shows the prorata worked out as it goes.
 */
export function ContractServices({ clientId, k, editable }: { clientId: string; k: CrmContract; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const key = ["crm", "client", clientId, "contract-services", k.id];
  const { data: lines = [] } = useQuery({ queryKey: key, queryFn: () => api.get<Line[]>(`/crm/clients/${clientId}/contracts/${k.id}/services`) });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/crm/clients/${clientId}/contracts/${k.id}/services/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const hasTerm = Boolean(k.startDate && k.endDate);
  const total = lines.reduce((n, l) => n + (l.totalCents ?? 0), 0);
  const first = lines.reduce((n, l) => n + (l.firstCents ?? 0), 0);
  return (
    <div className="w-full basis-full pl-7">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        <Wrench className="size-3.5 text-primary" /> {t("crm.contracts.services")} ({lines.length})
        {lines.length > 0 && <span className="font-mono text-[11px] text-foreground">{money(total, i18n.language)}</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {lines.length > 0 && (
            <ul className="divide-y divide-border/50 rounded-lg border bg-background/30 text-sm">
              {lines.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{l.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {money(l.priceCents, i18n.language)} {l.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")} · {t("crm.contracts.addedOn", { date: shortDate(l.addedOn) })}
                    </span>
                  </span>
                  {l.firstCents !== null && (
                    <span className="text-right text-[11px] text-muted-foreground">
                      <span className="block">
                        {t("crm.contracts.firstCharge")} <span className="font-mono text-sm text-foreground">{money(l.firstCents, i18n.language)}</span>
                        {l.periods[0] && !l.periods[0].full && <span className="ml-1 text-amber-300">({t("crm.contracts.prorata", { days: l.periods[0].days, of: l.periods[0].periodDays })})</span>}
                      </span>
                      <span className="block">
                        {t("crm.contracts.termTotal")} <span className="font-mono text-foreground">{money(l.totalCents ?? 0, i18n.language)}</span>
                      </span>
                    </span>
                  )}
                  {editable && (
                    <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" disabled={remove.isPending} onClick={() => remove.mutate(l.id)} aria-label={t("common.delete")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  {t("crm.contracts.dueNow")} <span className="font-mono text-foreground">{money(first, i18n.language)}</span>
                </span>
                <span className="font-semibold">
                  {t("crm.contracts.termTotal")} <span className="font-mono">{money(total, i18n.language)}</span>
                </span>
              </li>
            </ul>
          )}
          {editable && (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!hasTerm || !k.active} onClick={() => setAdding(true)} title={hasTerm ? undefined : t("crm.contracts.needTerm")}>
              <Plus className="size-3.5" /> {t("crm.contracts.addService")}
            </Button>
          )}
          {!hasTerm && <p className="text-[11px] text-amber-300">{t("crm.contracts.needTerm")}</p>}
        </div>
      )}
      {adding && <AddServiceDialog clientId={clientId} k={k} onClose={() => setAdding(false)} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
    </div>
  );
}

/** Picks a service and the day it starts on the contract; the prorata is worked out as the day or the price changes. */
function AddServiceDialog({ clientId, k, onClose, onDone }: { clientId: string; k: CrmContract; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { data: catalog = [] } = useQuery({ queryKey: ["crm", "services-catalog"], queryFn: () => api.get<CatalogItem[]>("/crm/services-catalog") });
  const start = k.startDate!;
  const end = k.endDate!;
  // today when it is inside the term, else the nearest day of it
  const inside = (d: string) => (d < start ? start : d > end ? end : d);
  const [serviceId, setServiceId] = useState("");
  const [addedOn, setAddedOn] = useState(() => inside(today()));
  const [price, setPrice] = useState<string | null>(null);
  const svc = catalog.find((x) => x.id === (serviceId || catalog[0]?.id));
  const priceCents = price !== null && price.trim() !== "" ? Math.round((Number(price.replace(",", ".")) || 0) * 100) : (svc?.priceCents ?? 0);
  const plan = useMemo(() => (svc ? prorata({ period: svc.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents, addedOn, start, end }) : null), [svc, priceCents, addedOn, start, end]);
  const add = useMutation({
    mutationFn: () => api.post(`/crm/clients/${clientId}/contracts/${k.id}/services`, { serviceId: svc!.id, addedOn, ...(price !== null && price.trim() !== "" ? { priceCents } : {}) }),
    onSuccess: () => {
      onDone();
      toast.success(t("crm.contracts.serviceAdded"));
      onClose();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const ok = svc && plan && typeof plan !== "string";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="size-5 text-primary" /> {t("crm.contracts.addService")}
          </DialogTitle>
          <DialogDescription>
            {k.name} · {shortDate(start)} → {shortDate(end)}
          </DialogDescription>
        </DialogHeader>
        {catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("crm.contracts.noServices")}</p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("crm.contracts.service")}</span>
              <select
                value={svc?.id ?? ""}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  setPrice(null);
                }}
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
              >
                {catalog.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {money(x.priceCents, i18n.language)} {x.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("crm.contracts.startsOn")}</span>
                <Input type="date" value={addedOn} min={start} max={end} onChange={(e) => setAddedOn(e.target.value)} />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("crm.contracts.priceFor")}</span>
                <Input value={price ?? (svc ? String(svc.priceCents / 100) : "")} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            {plan && typeof plan !== "string" ? (
              <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/[0.05] p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("crm.contracts.firstCharge")}</span>
                  <span className="font-mono text-base font-semibold text-emerald-300">{money(plan.firstCents, i18n.language)}</span>
                </div>
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                  {plan.periods.map((p) => (
                    <li key={p.from} className="flex items-center gap-2">
                      <span className="w-40 text-muted-foreground">
                        {shortDate(p.from)} → {shortDate(p.to)}
                      </span>
                      <span className="flex-1 text-muted-foreground">{p.full ? t("crm.contracts.fullPeriod") : t("crm.contracts.prorata", { days: p.days, of: p.periodDays })}</span>
                      <span className="font-mono">{money(p.amountCents, i18n.language)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center justify-between border-t pt-2 text-sm font-semibold">
                  <span>{t("crm.contracts.termTotal")}</span>
                  <span className="font-mono">{money(plan.totalCents, i18n.language)}</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-destructive">{t("crm.contracts.outsideTerm", { from: shortDate(start), to: shortDate(end) })}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="button" className="bg-grad-gold font-semibold text-[#1a1204]" disabled={!ok || add.isPending} onClick={() => add.mutate()}>
                {add.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.contracts.addService")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
