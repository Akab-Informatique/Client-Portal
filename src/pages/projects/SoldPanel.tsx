import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Link2, Loader2, Receipt, Search, Ticket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { hoursText, type ProjectDetail } from "./shared";
import { Card } from "./ui";

const PALETTE = ["bg-sky-400/80", "bg-violet-400/80", "bg-emerald-400/80", "bg-amber-300/80", "bg-pink-400/80", "bg-teal-300/80", "bg-orange-400/80", "bg-indigo-400/80"];

/**
 * Sold against worked: the hours and the price sold (from the quote, or typed on the project) against every hour
 * logged — the project's tasks and its tied tickets —, by person and by phase, and the billing of the price sold.
 */
export function SoldPanel({ p, onChanged }: { p: ProjectDetail; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const confirm = useConfirm();
  const m = (c: number) => money(c, i18n.language);
  const s = p.sold;
  const [by, setBy] = useState<"person" | "phase">("person");
  const bill = useMutation({
    mutationFn: () => api.post<{ lines: number; totalCents: number; deposit: { number: string } | null }>(`/projects/${p.id}/bill`, {}),
    onSuccess: (r) => {
      toast.success(t("projects.sold.billed", { total: m(r.totalCents) }), { description: r.deposit ? t("projects.sold.billedDeposit", { number: r.deposit.number }) : undefined });
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`projects.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });

  if (s.hours == null && s.priceCents == null) return null;
  const sold = s.hours ?? 0;
  const worked = s.workedHours;
  const scale = Math.max(sold, worked, 0.01);
  const over = sold > 0 && worked > sold;
  const parts =
    by === "person"
      ? p.time.byPerson.map((x) => ({ label: x.name, hours: x.hours }))
      : [
          ...p.milestones.filter((ms) => ms.hours > 0).map((ms) => ({ label: ms.name, hours: ms.hours })),
          ...(s.ticketHours > 0 ? [{ label: t("projects.sold.tickets"), hours: s.ticketHours }] : []),
          ...(() => {
            const rest = Math.round((worked - p.milestones.reduce((n, ms) => n + ms.hours, 0) - s.ticketHours) * 100) / 100;
            return rest > 0.009 ? [{ label: t("projects.sold.noPhase"), hours: rest }] : [];
          })(),
        ];
  const canBill = can("accounting.manage") && p.billingMode === "fixed" && !p.billing.invoicedAt && (s.priceCents ?? 0) > 0;

  return (
    <Card
      title={t("projects.sold.title")}
      action={
        p.quote ? (
          <a href={`/accounting/quotes/${p.quote.id}`} className="text-xs text-primary hover:underline">
            {t("projects.sold.fromQuote", { number: p.quote.number })}
          </a>
        ) : null
      }
    >
      <div className="space-y-4 text-sm">
        {/* the figures */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure label={t("projects.sold.sold")} big={s.hours != null ? hoursText(s.hours) : "—"} sub={s.priceCents != null ? `${m(s.priceCents)}${s.rateCents ? ` · ${m(s.rateCents)}/h` : ""}` : ""} />
          <Figure label={t("projects.sold.worked")} big={hoursText(worked)} sub={s.ticketHours > 0 ? t("projects.sold.ofTickets", { time: hoursText(s.ticketHours) }) : s.workedValueCents != null ? m(s.workedValueCents) : ""} />
          {s.diffHours != null && (
            <Figure
              tone={s.diffHours < 0 ? "bad" : "ok"}
              label={s.diffHours < 0 ? t("projects.sold.over") : t("projects.sold.under")}
              big={`${s.diffHours < 0 ? "+" : ""}${hoursText(Math.abs(s.diffHours))}`}
              sub={s.diffCents != null ? `${s.diffCents < 0 ? "−" : "+"}${m(Math.abs(s.diffCents))}` : ""}
            />
          )}
        </div>

        {/* the bar: what was sold (the mark) and what was worked, by person or by phase */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={cn("flex items-center gap-1.5 text-xs font-medium", over ? "text-red-400" : "text-emerald-300")}>
              {over ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {over ? t("projects.sold.verdictOver", { time: hoursText(worked - sold) }) : sold > 0 ? t("projects.sold.verdictUnder", { pct: Math.round((worked / sold) * 100) }) : t("projects.sold.verdictNoHours")}
            </span>
            <div className="flex gap-1 text-xs">
              {(["person", "phase"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setBy(k)} className={cn("rounded-full border px-2.5 py-0.5", by === k ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                  {t(`projects.sold.by.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="relative h-6 overflow-hidden rounded-full border bg-background/40">
            <div className="absolute inset-y-0 left-0 flex" style={{ width: `${(worked / scale) * 100}%` }}>
              {parts.map((x, i) => (
                <div key={x.label + i} className={cn("h-full border-r border-background/40", PALETTE[i % PALETTE.length])} style={{ width: `${worked ? (x.hours / worked) * 100 : 0}%` }} title={`${x.label} · ${hoursText(x.hours)}`} />
              ))}
            </div>
            {over && <div className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,rgba(239,68,68,.55)_0_6px,transparent_6px_12px)]" style={{ left: `${(sold / scale) * 100}%`, right: 0 }} />}
            {sold > 0 && <div className="absolute inset-y-[-2px] w-0.5 bg-foreground" style={{ left: `calc(${(sold / scale) * 100}% - 1px)` }} title={t("projects.sold.mark", { time: hoursText(sold) })} />}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {parts.map((x, i) => (
              <span key={x.label + i} className="flex items-center gap-1.5">
                <span className={cn("size-2.5 rounded-sm", PALETTE[i % PALETTE.length])} /> {x.label} <span className="font-mono text-muted-foreground">{hoursText(x.hours)}</span>
              </span>
            ))}
            {parts.length === 0 && <span className="text-muted-foreground">{t("projects.sold.nothingYet")}</span>}
          </div>
        </div>

        {/* billing of the price sold */}
        {p.billingMode === "fixed" && (
          <div className="space-y-2 rounded-xl border bg-background/30 p-3">
            <p className="text-xs text-muted-foreground">{t("projects.sold.billingHelp", { name: `${p.number} — ${p.name}`, hours: s.hours != null ? hoursText(s.hours) : "—" })}</p>
            {p.billing.deposit && <p className="text-xs">{t("projects.sold.deposit", { number: p.billing.deposit.number, amount: m(p.billing.deposit.subtotalCents) })}</p>}
            {p.billing.lines.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {p.billing.lines.map((l) => (
                  <li key={l.id} className="flex items-center gap-2">
                    <Receipt className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{l.description}</span>
                    <span className="font-mono">{m(l.amountCents)}</span>
                    <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{l.number ? t("projects.sold.onInvoice", { number: l.number }) : t(`projects.sold.status.${l.status}`, { defaultValue: l.status })}</span>
                  </li>
                ))}
              </ul>
            ) : canBill ? (
              <Button
                size="sm"
                className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
                disabled={bill.isPending}
                onClick={() =>
                  void confirm({ title: t("projects.sold.billConfirm"), description: t("projects.sold.billText", { total: m(s.priceCents ?? 0) }), confirmLabel: t("projects.sold.bill") }).then((ok) => ok && bill.mutate())
                }
              >
                {bill.isPending ? <Loader2 className="size-4 animate-spin" /> : <Receipt className="size-4" />} {t("projects.sold.bill")}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t("projects.sold.notBilled")}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Figure({ label, big, sub, tone }: { label: string; big: string; sub?: string; tone?: "ok" | "bad" }) {
  return (
    <div className={cn("rounded-xl border px-3 py-2", tone === "bad" && "border-red-500/40 bg-red-500/10", tone === "ok" && "border-emerald-500/30 bg-emerald-500/5")}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-2xl font-semibold", tone === "bad" ? "text-red-300" : tone === "ok" ? "text-emerald-300" : "")}>{big}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** The tickets of the project (support tickets): their time counts in the project; added by number or picked */
export function LinkedTickets({ p, edit, onChanged }: { p: ProjectDetail; edit: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const candidates = useQuery({
    queryKey: ["projects", p.id, "ticket-candidates", q],
    queryFn: () => api.get<{ id: number; number: string; title: string; company: string; otherProject: boolean }[]>(`/projects/${p.id}/ticket-candidates?q=${encodeURIComponent(q)}`),
    enabled: adding,
  });
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? t(`projects.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error"));
  const add = useMutation({
    mutationFn: (ticket: number | string) => api.post(`/projects/${p.id}/tickets`, { ticket }),
    onSuccess: () => {
      setQ("");
      setAdding(false);
      onChanged();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/projects/${p.id}/tickets/${id}`), onSuccess: onChanged, onError: fail });

  return (
    <Card
      title={t("projects.tickets.title")}
      action={
        edit && !adding ? (
          <button type="button" className="flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => setAdding(true)}>
            <Link2 className="size-3.5" /> {t("projects.tickets.add")}
          </button>
        ) : null
      }
    >
      <div className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">{t("projects.tickets.help")}</p>
        {adding && (
          <div className="space-y-1.5 rounded-xl border p-2">
            <div className="flex items-center gap-2">
              <Search className="size-4 text-muted-foreground" />
              <Input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && q.trim()) add.mutate(q.trim());
                  if (e.key === "Escape") setAdding(false);
                }}
                placeholder={t("projects.tickets.search")}
                className="h-8"
              />
              <Button size="icon" variant="ghost" className="size-8" onClick={() => setAdding(false)} aria-label={t("common.cancel")}>
                <X className="size-4" />
              </Button>
            </div>
            <ul className="max-h-56 overflow-y-auto">
              {(candidates.data ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" disabled={add.isPending} onClick={() => add.mutate(c.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/40">
                    <span className="font-mono text-xs text-primary">{c.number}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.otherProject && <span className="text-[10px] text-amber-300">{t("projects.tickets.otherProject")}</span>}
                  </button>
                </li>
              ))}
              {candidates.data?.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("projects.tickets.none")}</li>}
            </ul>
          </div>
        )}
        {p.tickets.length > 0 ? (
          <ul className="divide-y divide-border/60 rounded-xl border">
            {p.tickets.map((k) => (
              <li key={k.id} className="flex items-center gap-2 px-3 py-1.5">
                <Ticket className={cn("size-3.5 shrink-0", k.done ? "text-muted-foreground" : "text-primary")} />
                <button type="button" onClick={() => ws.open(k.id)} className="min-w-0 flex-1 truncate text-left hover:underline">
                  <span className="font-mono text-xs text-primary">{k.number}</span> <span className={cn(k.done && "text-muted-foreground line-through")}>{k.title}</span>
                </button>
                <span className="font-mono text-xs text-muted-foreground">{hoursText(k.hours)}</span>
                {edit && (
                  <button type="button" className="text-muted-foreground hover:text-red-400" aria-label={t("projects.tickets.remove")} title={t("projects.tickets.remove")} onClick={() => remove.mutate(k.id)}>
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !adding && <p className="text-xs text-muted-foreground">{t("projects.tickets.empty")}</p>
        )}
      </div>
    </Card>
  );
}
