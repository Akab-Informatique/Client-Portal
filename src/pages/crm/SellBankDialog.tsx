import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PiggyBank } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "./shared";

/** The client's open tickets and projects a prepaid bank can be tied to */
export type BankTargets = { tickets: { id: number; number: string; title: string }[]; projects: { id: string; number: string; name: string }[] };
export type BankScope = { kind: "none" | "ticket" | "project"; id: string };

const field = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60";

/** The server's code, in words */
export const bankErrorText = (t: (k: string) => string, e: unknown) => (e instanceof ApiError && /^bank_|^contract_|^not_prepaid|^project_|^quote_/.test(e.code) ? t(`hourBank.errors.${e.code}`) : t("common.error"));

/** Where a bank is tied: none, one ticket or one project of the client (loaded for the client) */
export function ScopePicker({ clientId, value, onChange, disabled }: { clientId: string; value: BankScope; onChange: (v: BankScope) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ["hour-banks", "targets", clientId], queryFn: () => api.get<BankTargets>(`/hour-banks/targets?clientId=${clientId}`), enabled: Boolean(clientId), staleTime: 30_000 });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("hourBank.scope.title")}>
        {(["none", "ticket", "project"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value.kind === k}
            disabled={disabled}
            onClick={() => onChange({ kind: k, id: "" })}
            className={cn("rounded-full border px-3 py-1 text-xs transition-colors", value.kind === k ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent/40")}
          >
            {t(`hourBank.scope.${k}`)}
          </button>
        ))}
      </div>
      {value.kind === "ticket" && (
        <select className={field} value={value.id} disabled={disabled} onChange={(e) => onChange({ kind: "ticket", id: e.target.value })} aria-label={t("hourBank.scope.ticket")}>
          <option value="">{t("hourBank.scope.pickTicket")}</option>
          {(data?.tickets ?? []).map((x) => (
            <option key={x.id} value={String(x.id)}>
              {x.number} — {x.title}
            </option>
          ))}
        </select>
      )}
      {value.kind === "project" && (
        <select className={field} value={value.id} disabled={disabled} onChange={(e) => onChange({ kind: "project", id: e.target.value })} aria-label={t("hourBank.scope.project")}>
          <option value="">{t("hourBank.scope.pickProject")}</option>
          {(data?.projects ?? []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.number} — {x.name}
            </option>
          ))}
        </select>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">{t(`hourBank.scope.${value.kind}Hint`)}</p>
    </div>
  );
}

/** The body fields of the sale API from a scope */
export const scopeBody = (s: BankScope) => (s.kind === "ticket" && s.id ? { ticketId: Number(s.id) } : s.kind === "project" && s.id ? { projId: s.id } : {});

/**
 * Sell a prepaid hours bank (hours bought once, drawn down by the time worked on the client): hours, price of an hour, an expiry
 * day, and optionally one ticket or project it is tied to. From invoicing the bank always goes to the invoice; from the client's
 * page the switch says whether to bill it now (off: a bank given, or paid elsewhere).
 */
export function SellBankDialog({ clientId, onClose, onDone, billing = "ask" }: { clientId?: string; onClose: () => void; onDone?: () => void; billing?: "ask" | "always" }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [client, setClient] = useState(clientId ?? "");
  const clients = useQuery({ queryKey: ["billables", "quick-clients"], queryFn: () => api.get<{ id: string; name: string }[]>("/billables/quick-clients"), enabled: !clientId });
  const defaults = useQuery({ queryKey: ["hour-banks", "defaults", client], queryFn: () => api.get<{ rate: number }>(`/hour-banks/defaults?clientId=${client}`), enabled: Boolean(client), staleTime: 60_000 });
  const [f, setF] = useState({ name: "", hours: "", rate: "", expiresOn: "" });
  const [scope, setScope] = useState<BankScope>({ kind: "none", id: "" });
  const [invoice, setInvoice] = useState(true);
  const rate = f.rate !== "" ? f.rate : defaults.data ? String(defaults.data.rate) : "";
  const hours = Number(f.hours.replace(",", ".")) || 0;
  const rateN = Number(rate.replace(",", ".")) || 0;
  const scoped = scope.kind === "none" || Boolean(scope.id);
  const ok = Boolean(client) && hours > 0 && rateN >= 0 && rate !== "" && scoped;
  const bill = billing === "always" || invoice;
  const sell = useMutation({
    mutationFn: () => api.post<{ id: string; billingItemId: string | null }>("/hour-banks", { clientId: client, name: f.name.trim() || null, hours, rate: rateN, expiresOn: f.expiresOn || null, invoice: bill, ...scopeBody(scope) }),
    onSuccess: () => {
      toast.success(t(bill ? "hourBank.sold" : "hourBank.soldNoInvoice"));
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["billables"] });
      onDone?.();
      onClose();
    },
    onError: (e) => toast.error(bankErrorText(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PiggyBank className="size-4 text-primary" /> {t("hourBank.sell.title")}
          </DialogTitle>
          <DialogDescription>{t("hourBank.sell.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!clientId && (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("hourBank.sell.client")}</span>
              <select className={field} value={client} onChange={(e) => { setClient(e.target.value); setScope({ kind: "none", id: "" }); }}>
                <option value="">{t("hourBank.sell.pickClient")}</option>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("hourBank.sell.hours")}</span>
              <Input value={f.hours} onChange={(e) => setF((x) => ({ ...x, hours: e.target.value }))} inputMode="decimal" placeholder="h" className="text-right font-mono" autoFocus />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("hourBank.sell.rate")}</span>
              <Input value={rate} onChange={(e) => setF((x) => ({ ...x, rate: e.target.value }))} inputMode="decimal" placeholder="$" className="text-right font-mono" />
            </label>
            <p className="self-end pb-2 text-xs text-muted-foreground">
              {t("hourBank.sell.total")} <span className="block font-mono text-sm text-foreground">{money(Math.round(hours * rateN * 100), i18n.language)}</span>
            </p>
          </div>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("hourBank.sell.name")}</span>
            <Input value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder={t("hourBank.sell.namePlaceholder")} maxLength={200} />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("hourBank.sell.expires")}</span>
            <Input type="date" value={f.expiresOn} onChange={(e) => setF((x) => ({ ...x, expiresOn: e.target.value }))} className="w-48" />
            <span className="block text-[11px] text-muted-foreground">{t("hourBank.sell.expiresHint")}</span>
          </label>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t("hourBank.scope.title")}</p>
            {client ? <ScopePicker clientId={client} value={scope} onChange={setScope} /> : <p className="text-[11px] text-muted-foreground">{t("hourBank.sell.pickClientFirst")}</p>}
          </div>
          {billing === "ask" && (
            <label className="flex items-start gap-3 rounded-lg border bg-background/30 p-3 text-sm">
              <Switch checked={invoice} onCheckedChange={setInvoice} />
              <span>
                <span className="block font-medium">{t("hourBank.sell.invoiceNow")}</span>
                <span className="block text-[11px] text-muted-foreground">{t("hourBank.sell.invoiceNowHint")}</span>
              </span>
            </label>
          )}
          <Button type="button" disabled={!ok || sell.isPending} onClick={() => sell.mutate()} className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {sell.isPending && <Loader2 className="size-4 animate-spin" />} {t(bill ? "hourBank.sell.submit" : "hourBank.sell.submitNoInvoice")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A button that opens the sale window */
export function SellBankButton({ clientId, billing, size = "sm", className, onDone }: { clientId?: string; billing?: "ask" | "always"; size?: "sm" | "default"; className?: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant="outline" className={className} onClick={() => setOpen(true)}>
        <PiggyBank className="size-3.5" /> {t("hourBank.sell.button")}
      </Button>
      {open && <SellBankDialog clientId={clientId} billing={billing} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
