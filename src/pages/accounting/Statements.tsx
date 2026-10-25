import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, Download, ExternalLink, Eye, FileText, Loader2, Mail, Search, Send } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Statement = {
  client: { id: string; name: string; email: string | null };
  date: string;
  count: number;
  totalDueCents: number;
  overdueCents: number;
  buckets: { current: number; d30: number; d60: number; d90: number; over90: number };
  items: { id: string; number: string; issuedOn: string; dueOn: string | null; totalCents: number; balanceCents: number; daysLate: number; poNumber: string | null }[];
};
type Target = { id: string; name: string; email: string | null; count: number; totalDueCents: number; overdueCents: number; maxDaysLate: number };

/** The reason an email did not go, in words */
export function mailError(t: (k: string) => string, e: unknown) {
  const code = e instanceof ApiError ? e.code : "";
  return code.startsWith("invoice_mail_") && code !== "invoice_mail_mail_failed" ? t(`statements.error.${code.slice("invoice_mail_".length)}`) : code === "rate_limited" ? t("statements.error.rate_limited") : t("statements.error.mail_failed");
}

/** One client's account statement: what is unpaid, how late, and the way to email it. */
export function ClientStatementDialog({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const m = (c: number) => money(c, i18n.language);
  const { data, isLoading } = useQuery({ queryKey: ["crm", "client", clientId, "statement"], queryFn: () => api.get<Statement>(`/crm/clients/${clientId}/statement`) });
  const send = useMutation({
    mutationFn: () => api.post<{ to: string; count: number }>(`/crm/clients/${clientId}/statement/send`, {}),
    onSuccess: (r) => {
      toast.success(t("statements.sentTo", { to: r.to }));
      onClose();
    },
    onError: (e) => toast.error(mailError(t, e)),
  });
  const B = data?.buckets;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5 text-primary" /> {t("statements.title")}
          </DialogTitle>
          <DialogDescription>{data ? `${data.client.name} — ${shortDate(data.date)}` : ""}</DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <Fig label={t("statements.totalDue")} value={m(data.totalDueCents)} />
              <Fig label={t("statements.overdue")} value={m(data.overdueCents)} tone={data.overdueCents ? "text-red-300" : undefined} />
              <Fig label={t("statements.invoices")} value={String(data.count)} />
            </div>
            {B && (
              <div className="grid grid-cols-5 gap-1 text-center text-[11px]">
                {(["current", "d30", "d60", "d90", "over90"] as const).map((k) => (
                  <div key={k} className="rounded-lg border px-1 py-1.5">
                    <p className="text-muted-foreground">{t(`statements.bucket.${k}`)}</p>
                    <p className="font-mono text-xs font-semibold">{m(B[k])}</p>
                  </div>
                ))}
              </div>
            )}
            {data.items.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-muted-foreground">{t("statements.nothing")}</p>
            ) : (
              <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border">
                {data.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 py-2 text-xs">
                    <span className="w-24 font-mono">{i.number}</span>
                    <span className="text-muted-foreground">{shortDate(i.issuedOn)}</span>
                    <span className={cn("min-w-0 flex-1", i.daysLate > 0 ? "font-medium text-red-300" : "text-muted-foreground")}>
                      {i.dueOn ? shortDate(i.dueOn) : "—"}
                      {i.daysLate > 0 && ` · ${t("crm.invoices.late", { count: i.daysLate })}`}
                    </span>
                    <span className="font-mono">{m(i.balanceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="size-3.5" /> {data.client.email ?? t("statements.noEmail")}
              </span>
              {can("accounting.manage") && (
                <Button disabled={send.isPending || !data.count || !data.client.email} onClick={() => send.mutate()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                  {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("statements.send")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-lg font-bold", tone)}>{value}</p>
    </div>
  );
}

/** Statements for every client that owes something, or only the ones ticked. */
export function StatementsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const m = (c: number) => money(c, i18n.language);
  const { data, isLoading } = useQuery({ queryKey: ["crm", "statements", "targets"], queryFn: () => api.get<Target[]>("/crm/statements/targets") });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ sent: number; results: { id: string; name: string; status: string }[] } | null>(null);
  const shown = useMemo(() => (data ?? []).filter((x) => x.name.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const canSend = (x: Target) => Boolean(x.email);
  const chosen = (data ?? []).filter((x) => picked.has(x.id) && canSend(x));
  const send = useMutation({
    mutationFn: (ids: string[] | null) => api.post<{ sent: number; results: { id: string; name: string; status: string }[] }>("/crm/statements/send", ids ? { clientIds: ids } : {}),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(mailError(t, e)),
  });
  const allShown = shown.filter(canSend);
  const toggle = (id: string, on: boolean) => setPicked((s) => new Set(on ? [...s, id] : [...s].filter((x) => x !== id)));
  const ask = async (ids: string[] | null, count: number) => {
    if (await confirm({ title: t("statements.bulkConfirm", { count }), description: t("statements.bulkText") })) send.mutate(ids);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5 text-primary" /> {t("statements.bulkTitle")}
          </DialogTitle>
          <DialogDescription>{t("statements.bulkSubtitle")}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 text-sm">
            <p className="font-medium">{t("statements.bulkDone", { count: result.sent })}</p>
            {result.results.filter((r) => r.status !== "sent").length > 0 && (
              <ul className="divide-y divide-border/50 rounded-lg border">
                {result.results
                  .filter((r) => r.status !== "sent")
                  .map((r) => (
                    <li key={r.id} className="flex justify-between px-3 py-1.5 text-xs">
                      <span>{r.name}</span>
                      <span className="text-amber-300">{t(`statements.result.${r.status}`)}</span>
                    </li>
                  ))}
              </ul>
            )}
            <Button variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        ) : isLoading || !data ? (
          <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-52 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="h-8 pl-8" />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setPicked(new Set([...picked, ...allShown.map((x) => x.id)]))}>
                {t("statements.selectShown")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>
                {t("statements.clear")}
              </Button>
            </div>
            <ul className="max-h-[22rem] divide-y divide-border/50 overflow-y-auto rounded-xl border scrollbar-thin">
              {shown.map((x) => (
                <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox checked={picked.has(x.id)} disabled={!canSend(x)} onCheckedChange={(v) => toggle(x.id, Boolean(v))} aria-label={x.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{x.name}</span>
                    <span className={cn("block truncate text-[11px]", x.email ? "text-muted-foreground" : "text-amber-300")}>{x.email ?? t("statements.noEmail")}</span>
                  </span>
                  <span className="text-right text-xs">
                    <span className="block font-mono font-semibold">{m(x.totalDueCents)}</span>
                    {x.overdueCents > 0 && <span className="block text-[11px] text-red-300">{t("statements.lateOf", { amount: m(x.overdueCents), days: x.maxDaysLate })}</span>}
                  </span>
                </li>
              ))}
              {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">{t("statements.none")}</li>}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("statements.picked", { count: chosen.length, total: data.length })}</span>
              <span className="flex gap-2">
                <Button disabled={!chosen.length || send.isPending} onClick={() => void ask(chosen.map((x) => x.id), chosen.length)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                  {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("statements.sendPicked", { count: chosen.length })}
                </Button>
                <Button variant="outline" disabled={!data.filter(canSend).length || send.isPending} onClick={() => void ask(null, data.filter(canSend).length)}>
                  {t("statements.sendAll", { count: data.filter(canSend).length })}
                </Button>
              </span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The two emails of an invoice: the invoice itself, and (when it is past due) a reminder that follows how late it is. */
export function InvoiceMailButtons({ invoice, compact }: { invoice: { id: string; number: string; late: boolean; balanceCents: number; status: string }; compact?: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const confirm = useConfirm();
  const send = useMutation({
    mutationFn: (kind: "sent" | "reminder") => api.post<{ to: string }>(`/crm/invoices/${invoice.id}/mail`, { kind }),
    onSuccess: (r) => toast.success(t("statements.sentTo", { to: r.to })),
    onError: (e) => toast.error(mailError(t, e)),
  });
  if (!can("accounting.manage") || invoice.status === "voided") return null;
  const ask = async (kind: "sent" | "reminder") => {
    if (await confirm({ title: t(kind === "sent" ? "statements.invoiceConfirm" : "statements.reminderConfirm", { number: invoice.number }) })) send.mutate(kind);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Button type="button" size={compact ? "icon" : "sm"} variant="ghost" className={compact ? "size-7" : "h-7 text-xs"} disabled={send.isPending} onClick={() => void ask("sent")} title={t("statements.sendInvoice")}>
        <Mail className="size-3.5" /> {!compact && t("statements.sendInvoice")}
      </Button>
      {invoice.late && invoice.balanceCents > 0 && (
        <Button type="button" size={compact ? "icon" : "sm"} variant="ghost" className={compact ? "size-7 text-red-300" : "h-7 text-xs text-red-300"} disabled={send.isPending} onClick={() => void ask("reminder")} title={t("statements.sendReminder")}>
          <BellRing className="size-3.5" /> {!compact && t("statements.sendReminder")}
        </Button>
      )}
    </span>
  );
}

/** The invoice as a PDF in a window over the page (opened where it is, or in a tab, or downloaded). */
export function InvoicePdfDialog({ invoice, onClose }: { invoice: { id: string; number: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const src = `/api/crm/invoices/${invoice.id}/pdf`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-h-[90vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <FileText className="size-5 text-primary" /> {t("statements.pdfTitle", { number: invoice.number })}
            <span className="ml-auto flex gap-1.5">
              <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                <a href={src} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" /> {t("statements.pdfOpen")}
                </a>
              </Button>
              <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                <a href={`${src}?download=1`}>
                  <Download className="size-3.5" /> {t("statements.pdfDownload")}
                </a>
              </Button>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">{t("statements.pdfTitle", { number: invoice.number })}</DialogDescription>
        </DialogHeader>
        <iframe src={src} title={invoice.number} className="min-h-0 w-full flex-1 rounded-lg border bg-white" />
      </DialogContent>
    </Dialog>
  );
}

/** The button that shows an invoice's PDF in a window (a small icon, or with its name). */
export function InvoicePdfButton({ invoice, compact }: { invoice: { id: string; number: string }; compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={compact ? "icon" : "sm"} variant="ghost" className={compact ? "size-7" : "h-7 text-xs"} onClick={() => setOpen(true)} title={t("statements.pdfPreview")}>
        <Eye className="size-3.5" /> {!compact && t("statements.pdfPreview")}
      </Button>
      {open && <InvoicePdfDialog invoice={invoice} onClose={() => setOpen(false)} />}
    </>
  );
}
