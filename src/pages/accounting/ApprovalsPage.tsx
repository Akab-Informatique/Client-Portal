import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Ban, Check, ClipboardCheck, Clock, DownloadCloud, FileText, Flag, Hammer, Loader2, Package, Pencil, Send, Undo2, Wallet, X, type LucideIcon } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Kind = "labour" | "charge" | "expense" | "contract" | "milestone";
type Status = "pending" | "approved" | "posted" | "excluded";
type Item = {
  id: string;
  clientId: string;
  clientName: string;
  kind: Kind;
  date: string;
  dateEnd: string | null;
  description: string;
  ticketNumber: string | null;
  contractName: string | null;
  resourceName: string | null;
  quantityX100: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  status: Status;
  edited: boolean;
  invoiceNumber: string | null;
};
type Summary = { state: { at: string | null; counts: Partial<Record<Kind, number>>; errors: Partial<Record<Kind, string>>; skipped: number }; counts: { kind: Kind; status: Status; n: number; cents: number }[] };
type Group = { client: { id: string; name: string }; count: number; subtotalCents: number; gstCents: number; qstCents: number; totalCents: number; exempt: boolean; termsDays: number; kinds: Kind[] };

const TABS: { key: Kind | "timesheets"; icon: LucideIcon }[] = [
  { key: "labour", icon: Hammer },
  { key: "charge", icon: Package },
  { key: "expense", icon: Wallet },
  { key: "contract", icon: FileText },
  { key: "milestone", icon: Flag },
  { key: "timesheets", icon: Clock },
];
const STATUSES: Status[] = ["pending", "approved", "posted", "excluded"];
const STATUS_STYLE: Record<Status, string> = {
  pending: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  posted: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  excluded: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};
const KEY = ["billables"];

/**
 * Accounting › Approve and post: the work to bill copied from Autotask (not
 * posted there yet), approved or excluded here, then posted as invoices —
 * one per client. Technicians' timesheets come later.
 */
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((x) => x.key === params.get("tab")) ? (params.get("tab") as Kind | "timesheets") : "labour";
  const [posting, setPosting] = useState(false);
  const { data: summary } = useQuery({ queryKey: [...KEY, "summary"], queryFn: () => api.get<Summary>("/billables/summary"), refetchInterval: 60_000 });
  const count = (kind: Kind, status: Status) => summary?.counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0;
  const approved = summary?.counts.filter((c) => c.status === "approved").reduce((x, c) => x + c.n, 0) ?? 0;
  const importNow = useMutation({
    mutationFn: () => api.post<Summary["state"]>("/billables/import"),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: KEY });
      const errors = Object.keys(s.errors);
      if (errors.length) toast.warning(t("approvals.importPartial", { kinds: errors.map((k) => t(`approvals.tabs.${k}`)).join(", ") }));
      else toast.success(t("approvals.imported"));
    },
    onError: () => toast.error(t("approvals.importFailed")),
  });
  const errors = Object.entries(summary?.state.errors ?? {});
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ClipboardCheck className="size-6 text-primary" /> {t("approvals.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("approvals.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{summary?.state.at ? t("approvals.lastImport", { when: relativeTime(summary.state.at) }) : t("approvals.neverImported")}</span>
          {can("accounting.manage") && (
            <>
              <Button variant="outline" disabled={importNow.isPending} onClick={() => importNow.mutate()}>
                {importNow.isPending ? <Loader2 className="size-4 animate-spin" /> : <DownloadCloud className="size-4" />} {t("approvals.import")}
              </Button>
              <Button disabled={!approved} onClick={() => setPosting(true)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                <Send className="size-4" /> {t("approvals.post", { count: approved })}
              </Button>
            </>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          {errors.map(([k, e]) => (
            <p key={k} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("approvals.kindError", { kind: t(`approvals.tabs.${k}`), error: e })}
            </p>
          ))}
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="h-auto flex-wrap justify-start">
          {TABS.map((x) => (
            <TabsTrigger key={x.key} value={x.key} className={x.key === "timesheets" ? "sm:ml-3" : undefined}>
              <x.icon className="size-4" /> {t(`approvals.tabs.${x.key}`)}
              {x.key !== "timesheets" && count(x.key, "pending") > 0 && <span className="rounded-full bg-sky-500/20 px-1.5 font-mono text-[10px] text-sky-300">{count(x.key, "pending")}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((x) => (
          <TabsContent key={x.key} value={x.key} className="mt-4">
            {x.key === "timesheets" ? <Placeholder /> : <KindTab kind={x.key} counts={(s) => count(x.key as Kind, s)} lang={i18n.language} />}
          </TabsContent>
        ))}
      </Tabs>
      {posting && <PostDialog onClose={() => setPosting(false)} />}
    </div>
  );
}

function Placeholder() {
  const { t } = useTranslation();
  return (
    <div className="glass flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
      <Clock className="size-8 text-primary" />
      <p className="font-semibold">{t("approvals.empty.timesheets.title")}</p>
      <p className="max-w-lg text-sm text-muted-foreground">{t("approvals.empty.timesheets.text")}</p>
      <span className="rounded-full border border-dashed px-2.5 py-0.5 text-[11px] text-muted-foreground">{t("common.comingSoon")}</span>
    </div>
  );
}

function KindTab({ kind, counts, lang }: { kind: Kind; counts: (s: Status) => number; lang: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("pending");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const { data: items = [], isLoading } = useQuery({ queryKey: [...KEY, kind, status], queryFn: () => api.get<Item[]>(`/billables?kind=${kind}&status=${status}`) });
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: Item[] }>();
    for (const i of items) m.set(i.clientId, { name: i.clientName, items: [...(m.get(i.clientId)?.items ?? []), i] });
    return [...m.entries()];
  }, [items]);
  const manage = can("accounting.manage") && status !== "posted";
  const setMany = (ids: string[], on: boolean) => setSel((s) => (on ? new Set([...s, ...ids]) : new Set([...s].filter((x) => !ids.includes(x)))));
  const move = useMutation({
    mutationFn: (to: "pending" | "approved" | "excluded") => api.post<{ changed: number }>("/billables/status", { ids: [...sel], status: to }),
    onSuccess: (r, to) => {
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t(`approvals.moved.${to}`, { count: r.changed }));
    },
  });
  const m = (c: number) => money(c, lang);
  const total = items.reduce((x, i) => x + i.amountCents, 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setSel(new Set());
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
              status === s ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {t(`approvals.status.${s}`)} <span className="font-mono text-[10px] text-muted-foreground">{counts(s)}</span>
          </button>
        ))}
        <span className="ml-auto font-mono text-sm">{m(total)}</span>
      </div>

      {manage && sel.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 bg-background/90 p-2 backdrop-blur">
          <span className="px-1 text-xs">{t("approvals.selected", { count: sel.size })}</span>
          {status !== "approved" && (
            <Button size="sm" disabled={move.isPending} onClick={() => move.mutate("approved")} className="bg-emerald-600 text-white hover:bg-emerald-500">
              <Check className="size-3.5" /> {t("approvals.approve")}
            </Button>
          )}
          {status !== "pending" && (
            <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate("pending")}>
              <Undo2 className="size-3.5" /> {t("approvals.backToPending")}
            </Button>
          )}
          {status !== "excluded" && (
            <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate("excluded")}>
              <Ban className="size-3.5" /> {t("approvals.exclude")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {isLoading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && items.length === 0 && <p className="glass rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">{t(`approvals.none.${status}`)}</p>}
      {groups.map(([clientId, g]) => {
        const ids = g.items.map((i) => i.id);
        const sub = g.items.reduce((x, i) => x + i.amountCents, 0);
        return (
          <section key={clientId} className="glass overflow-hidden rounded-2xl border">
            <div className="flex items-center gap-3 border-b bg-background/30 px-3 py-2">
              {manage && <Checkbox checked={ids.every((x) => sel.has(x)) ? true : ids.some((x) => sel.has(x)) ? "indeterminate" : false} onCheckedChange={(v) => setMany(ids, Boolean(v))} />}
              <span className="flex-1 text-sm font-semibold">{g.name}</span>
              <span className="text-xs text-muted-foreground">{t("approvals.items", { count: g.items.length })}</span>
              <span className="font-mono text-sm">{m(sub)}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {g.items.map((i) =>
                editing === i.id ? (
                  <li key={i.id}>
                    <EditRow item={i} onDone={() => setEditing(null)} lang={lang} />
                  </li>
                ) : (
                  <li key={i.id} className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-sm md:grid-cols-[auto_90px_minmax(0,1fr)_80px_100px_110px_auto]">
                    {manage ? <Checkbox className="mt-0.5" checked={sel.has(i.id)} onCheckedChange={(v) => setMany([i.id], Boolean(v))} /> : <span />}
                    <span className="hidden text-xs text-muted-foreground md:block">
                      {shortDate(i.date)}
                      {i.dateEnd && <span className="block">→ {shortDate(i.dateEnd)}</span>}
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words">{i.description}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {[i.ticketNumber && `${t("approvals.ticket")} ${i.ticketNumber}`, i.contractName, i.resourceName, i.edited && t("approvals.edited"), i.invoiceNumber && t("approvals.onInvoice", { number: i.invoiceNumber })].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="hidden text-right font-mono text-xs md:block">{(i.quantityX100 / 100).toLocaleString(lang === "en" ? "en-CA" : "fr-CA")}</span>
                    <span className="hidden text-right font-mono text-xs text-muted-foreground md:block">{m(i.unitPriceCents)}</span>
                    <span className="text-right font-mono">{m(i.amountCents)}</span>
                    <span className="flex items-center justify-end gap-1">
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", STATUS_STYLE[i.status])}>{t(`approvals.status.${i.status}`)}</span>
                      {manage && (
                        <button type="button" onClick={() => setEditing(i.id)} className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label={t("approvals.edit")}>
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function EditRow({ item: i, onDone, lang }: { item: Item; onDone: () => void; lang: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ quantity: String(i.quantityX100 / 100), rate: (i.unitPriceCents / 100).toFixed(2), description: i.description });
  const num = (s: string) => Number(s.replace(",", "."));
  const save = useMutation({
    mutationFn: () => api.patch(`/billables/${i.id}`, { quantity: num(f.quantity), unitPriceCents: Math.round(num(f.rate) * 100), description: f.description }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("approvals.saved"));
      onDone();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <form
      className="grid gap-2 bg-[color:var(--gold)]/[0.04] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_100px_110px_auto]"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="h-8" aria-label={t("approvals.description")} />
      <Input value={f.quantity} inputMode="decimal" onChange={(e) => setF({ ...f, quantity: e.target.value })} className="h-8 font-mono" aria-label={t(i.kind === "labour" ? "approvals.hours" : "approvals.quantity")} placeholder={t(i.kind === "labour" ? "approvals.hours" : "approvals.quantity")} />
      <Input value={f.rate} inputMode="decimal" onChange={(e) => setF({ ...f, rate: e.target.value })} className="h-8 font-mono" aria-label={t("approvals.rate")} />
      <div className="flex items-center gap-1">
        <span className="px-1 font-mono text-xs text-muted-foreground">{money(Math.round(num(f.quantity) * num(f.rate) * 100), lang)}</span>
        <Button type="submit" size="sm" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          <X className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}

/** What posting will make, client by client; then the invoices are made. */
function PostDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: groups = [], isLoading } = useQuery({ queryKey: [...KEY, "post"], queryFn: () => api.get<Group[]>("/billables/post"), gcTime: 0 });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const chosen = sel ?? new Set(groups.map((g) => g.client.id));
  const m = (c: number) => money(c, i18n.language);
  const post = useMutation({
    mutationFn: () => api.post<{ number: string; client: string }[]>("/billables/post", { clientIds: [...chosen] }),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("approvals.posted", { count: made.length, numbers: made.map((x) => x.number).join(", ") }));
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  const total = groups.filter((g) => chosen.has(g.client.id)).reduce((x, g) => x + g.totalCents, 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("approvals.postTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.postText")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          {isLoading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
            {groups.map((g) => (
              <li key={g.client.id}>
                <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 text-sm hover:bg-accent/30">
                  <Checkbox
                    className="mt-0.5"
                    checked={chosen.has(g.client.id)}
                    onCheckedChange={(v) => setSel(new Set(v ? [...chosen, g.client.id] : [...chosen].filter((x) => x !== g.client.id)))}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{g.client.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("approvals.lines", { count: g.count })} · {g.kinds.map((k) => t(`approvals.tabs.${k}`)).join(", ")} · {g.exempt ? t("approvals.exempt") : `TPS ${m(g.gstCents)} · TVQ ${m(g.qstCents)}`} · {t("approvals.terms", { days: g.termsDays })}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-mono">{m(g.totalCents)}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">{m(g.subtotalCents)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          <span className="mr-auto text-sm">
            {t("approvals.invoices", { count: chosen.size })} · <span className="font-mono">{m(total)}</span>
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!chosen.size || post.isPending} onClick={() => post.mutate()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {post.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("approvals.postConfirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
