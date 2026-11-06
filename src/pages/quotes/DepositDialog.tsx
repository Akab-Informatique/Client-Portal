import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { depositOf } from "@shared/quotes";
import type { Quote } from "./shared";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/**
 * The deposit invoice of an accepted quote: a share of the implementation (50 % unless changed),
 * shown with its taxes before it is made, emailed to the client when asked.
 */
export function DepositDialog({ quote, onClose, onDone }: { quote: Quote; onClose: () => void; onDone: (q: Quote) => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const m = (c: number) => money(c, i18n.language);
  const [pct, setPct] = useState("50");
  const [day, setDay] = useState(today());
  const [send, setSend] = useState(true);
  const [pay, setPay] = useState(true);
  const percent = Number(pct.replace(",", "."));
  const valid = Number.isFinite(percent) && percent >= 1 && percent <= 100;
  const dep = depositOf(quote.lines, valid ? Math.round(percent * 100) : 0);
  const taxed = quote.taxes ? dep.taxableCents : 0;
  const gst = Math.round((taxed * quote.rates.gstRate) / 100);
  const qst = Math.round((taxed * quote.rates.qstRate) / 100);
  const base = quote.totals.subtotalCents;

  const make = useMutation({
    mutationFn: () => api.post<{ invoice: { number: string; totalCents: number }; payLink: boolean; emailed: string | null; mailError: string | null; quote: Quote }>(`/quotes/${quote.id}/deposit`, { percent, issuedOn: day, send, payOnline: pay }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("quotes.deposit.made", { number: r.invoice.number, total: m(r.invoice.totalCents) }), {
        description: [r.emailed ? t("quotes.deposit.emailed", { to: r.emailed }) : r.mailError ? t("quotes.deposit.mailFailed") : "", pay && !r.payLink ? t("quotes.deposit.payNotReady") : ""].filter(Boolean).join(" ") || undefined,
      });
      onDone(r.quote);
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`quotes.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="size-5 text-primary" /> {t("quotes.deposit.title", { number: quote.number })}
          </DialogTitle>
          <DialogDescription>{t("quotes.deposit.text", { client: quote.clientName ?? "" })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="dep-pct">{t("quotes.deposit.percent")}</Label>
            <div className="flex items-center gap-2">
              <div className="relative w-24">
                <Input id="dep-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="pr-7 text-right font-mono" />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
              </div>
              {[25, 30, 50, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPct(String(v))}
                  className={cn("rounded-full border px-2.5 py-1 text-xs transition", percent === v ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
                >
                  {v} %
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dep-day">{t("quotes.deposit.date")}</Label>
            <Input id="dep-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
          </div>

          <dl className="space-y-1.5 rounded-xl border bg-background/30 p-3 text-sm">
            <div className="flex justify-between gap-3 text-muted-foreground">
              <dt>{t("quotes.deposit.base")}</dt>
              <dd className="font-mono">{m(base)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>{t("quotes.deposit.amount", { pct: valid ? percent.toLocaleString(i18n.language === "en" ? "en-CA" : "fr-CA") : "—" })}</dt>
              <dd className="font-mono">{m(dep.subtotalCents)}</dd>
            </div>
            {gst > 0 && (
              <div className="flex justify-between gap-3 text-muted-foreground">
                <dt>{t("quotes.deposit.gst")}</dt>
                <dd className="font-mono">{m(gst)}</dd>
              </div>
            )}
            {qst > 0 && (
              <div className="flex justify-between gap-3 text-muted-foreground">
                <dt>{t("quotes.deposit.qst")}</dt>
                <dd className="font-mono">{m(qst)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3 border-t pt-1.5 font-semibold">
              <dt>{t("quotes.deposit.total")}</dt>
              <dd className="font-mono text-primary">{m(dep.subtotalCents + gst + qst)}</dd>
            </div>
          </dl>
          {(quote.totals.monthly.subtotalCents > 0 || quote.totals.yearly.subtotalCents > 0) && <p className="text-xs text-muted-foreground">{t("quotes.deposit.recurringLeft")}</p>}

          <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
            <span>{t("quotes.deposit.send")}</span>
            <Switch checked={send} onCheckedChange={setSend} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
            <span>
              {t("quotes.deposit.pay")}
              <span className="block text-xs text-muted-foreground">{t("quotes.deposit.payHelp")}</span>
            </span>
            <Switch checked={pay} onCheckedChange={setPay} />
          </label>
          <p className="text-xs text-muted-foreground">{t("quotes.deposit.qb")}</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("quotes.deposit.later")}
          </Button>
          <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || dep.subtotalCents <= 0 || make.isPending} onClick={() => make.mutate()}>
            {make.isPending ? <Loader2 className="size-4 animate-spin" /> : <Receipt className="size-4" />} {t("quotes.deposit.make")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
