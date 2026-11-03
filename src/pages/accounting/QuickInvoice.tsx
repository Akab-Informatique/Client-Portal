import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

type QuickClient = { id: string; name: string; email: string | null; exempt: boolean; payOnline: boolean | null };
type Line = { description: string; quantity: string; unitPrice: string; taxable: boolean };
const blank = (): Line => ({ description: "", quantity: "1", unitPrice: "", taxable: true });
const num = (s: string) => Number(s.replace(",", ".").replace(/\s/g, ""));

/**
 * An invoice typed by hand (Comptabilité › Factures › Nouvelle facture): a client, a few lines (what, how many, the price,
 * taxable or not), the date, the terms, a note, the Stripe pay link — and, ticked, emailed at once. The server makes the
 * usual invoice from it (numbering, taxes, QuickBooks, PDF).
 */
export function QuickInvoiceDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString("en-CA");
  const { data: clients = [] } = useQuery({ queryKey: ["billables", "quick-clients"], queryFn: () => api.get<QuickClient[]>("/billables/quick-clients") });
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [issuedOn, setIssuedOn] = useState(today);
  const [terms, setTerms] = useState<string>("client");
  const [notes, setNotes] = useState("");
  const [pay, setPay] = useState<boolean | null>(null);
  const [send, setSend] = useState(true);
  const client = clients.find((c) => c.id === clientId) ?? null;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? clients.filter((c) => c.name.toLowerCase().includes(s)) : clients).slice(0, 50);
  }, [clients, q]);
  const valid = lines.every((l) => l.description.trim() && num(l.quantity) > 0 && Number.isFinite(num(l.unitPrice)) && l.unitPrice.trim() !== "");
  const subtotal = lines.reduce((n, l) => n + (valid ? Math.round(num(l.quantity) * num(l.unitPrice) * 100) : 0), 0);
  const payOn = pay ?? client?.payOnline ?? true;
  const m = (c: number) => money(c, i18n.language);
  const set = (i: number, p: Partial<Line>) => setLines((x) => x.map((l, n) => (n === i ? { ...l, ...p } : l)));

  const create = useMutation({
    mutationFn: () =>
      api.post<{ number: string; emailed: string | null; mailError: string | null }>("/billables/quick-invoice", {
        clientId,
        issuedOn,
        ...(terms !== "client" ? { termsDays: Number(terms) } : {}),
        notes: notes.trim() || null,
        ...(pay !== null ? { payOnline: pay } : {}),
        send: send && Boolean(client?.email),
        lines: lines.map((l) => ({ description: l.description.trim(), quantity: num(l.quantity), unitPrice: num(l.unitPrice), taxable: l.taxable })),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.mailError) toast.warning(t("quickInvoice.madeNotSent", { number: r.number }));
      else toast.success(r.emailed ? t("quickInvoice.madeSent", { number: r.number, to: r.emailed }) : t("quickInvoice.made", { number: r.number }));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "invalid_input" ? t("quickInvoice.invalid") : t("common.error")),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("quickInvoice.title")}</DialogTitle>
          <DialogDescription>{t("quickInvoice.text")}</DialogDescription>
        </DialogHeader>

        {/* the client */}
        <section className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{t("quickInvoice.client")}</p>
          {client ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{client.name}</span>
                <span className="block text-xs text-muted-foreground">{client.email ?? t("quickInvoice.noEmail")}</span>
              </span>
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setClientId(null)}>
                {t("quickInvoice.change")}
              </button>
            </div>
          ) : (
            <>
              <Input autoFocus placeholder={t("quickInvoice.search")} value={q} onChange={(e) => setQ(e.target.value)} />
              <ul className="max-h-48 overflow-y-auto rounded-xl border">
                {shown.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setClientId(c.id)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent/40">
                      {c.name}
                    </button>
                  </li>
                ))}
                {!shown.length && <li className="px-3 py-2 text-xs text-muted-foreground">{t("quickInvoice.noClient")}</li>}
              </ul>
            </>
          )}
        </section>

        {/* the lines */}
        <section className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_auto_auto] gap-2 px-1 text-[11px] text-muted-foreground">
            <span>{t("quickInvoice.description")}</span>
            <span>{t("quickInvoice.quantity")}</span>
            <span>{t("quickInvoice.price")}</span>
            <span>{t("quickInvoice.taxable")}</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_auto_auto] items-center gap-2">
              <Input value={l.description} maxLength={500} placeholder={t("quickInvoice.descriptionHint")} onChange={(e) => set(i, { description: e.target.value })} />
              <Input inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} className="text-right" />
              <Input inputMode="decimal" value={l.unitPrice} placeholder="0,00" onChange={(e) => set(i, { unitPrice: e.target.value })} className="text-right" />
              <span className="flex justify-center">
                <Checkbox checked={l.taxable} onCheckedChange={(v) => set(i, { taxable: v === true })} aria-label={t("quickInvoice.taxable")} />
              </span>
              <Button type="button" size="icon" variant="ghost" className="size-8" disabled={lines.length === 1} onClick={() => setLines((x) => x.filter((_, n) => n !== i))} aria-label={t("quickInvoice.remove")}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button type="button" size="sm" variant="outline" disabled={lines.length >= 50} onClick={() => setLines((x) => [...x, blank()])}>
              <Plus className="size-3.5" /> {t("quickInvoice.addLine")}
            </Button>
            <p className="text-sm">
              {t("quickInvoice.subtotal")} <span className="font-mono font-semibold">{m(subtotal)}</span>
              <span className="block text-right text-[11px] text-muted-foreground">{client?.exempt ? t("quickInvoice.exempt") : t("quickInvoice.taxesAdded")}</span>
            </p>
          </div>
        </section>

        {/* the date, terms and note */}
        <section className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs">
            <span className="text-muted-foreground">{t("quickInvoice.date")}</span>
            <Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </label>
          <label className="space-y-1.5 text-xs">
            <span className="text-muted-foreground">{t("quickInvoice.terms")}</span>
            <select value={terms} onChange={(e) => setTerms(e.target.value)} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
              <option value="client">{t("quickInvoice.termsClient")}</option>
              <option value="0">{t("quickInvoice.onReceipt")}</option>
              {[15, 30, 45, 60].map((d) => (
                <option key={d} value={d}>
                  {t("quickInvoice.days", { days: d })}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-xs sm:col-span-2">
            <span className="text-muted-foreground">{t("quickInvoice.notes")}</span>
            <Input value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </section>

        {/* the pay link and the email */}
        <section className="space-y-2 text-sm">
          <button type="button" onClick={() => setPay(!payOn)} aria-pressed={payOn} className="flex items-center gap-2">
            <span className={cn("flex size-7 items-center justify-center rounded-full border", payOn ? "border-[#635bff] bg-[#635bff] text-white" : "text-muted-foreground/60")}>
              <CreditCard className="size-3.5" />
            </span>
            {payOn ? t("quickInvoice.payOn") : t("quickInvoice.payOff")}
          </button>
          <label className={cn("flex items-center gap-2", !client?.email && "opacity-50")}>
            <Checkbox checked={send && Boolean(client?.email)} disabled={!client?.email} onCheckedChange={(v) => setSend(v === true)} />
            {client?.email ? t("quickInvoice.send", { to: client.email }) : t("quickInvoice.sendNoEmail")}
          </label>
        </section>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!client || !valid || create.isPending} onClick={() => create.mutate()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("quickInvoice.create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
