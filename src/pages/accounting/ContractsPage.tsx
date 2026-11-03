import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { CardAutopays } from "./CardAutopays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Copy, CreditCard, FileText, Loader2, Search, Send, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCan } from "@/lib/session";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

type Row = {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  type: string | null;
  active: boolean;
  startDate: string | null;
  endDate: string | null;
  endedOn: string | null;
  billingPeriod: "monthly" | "yearly";
  rebateBps: number;
  serviceCount: number;
  bank: { left: number; available: number } | null;
  /** Automatic card payment: active, a link waiting for the client, or none */
  autopay: "active" | "pending" | null;
  summary: { perPeriodCents: number; yearlyExtraCents: number; revenueCents: number };
};
type Filter = "active" | "inactive" | "all";
type SendResult = { client: string; contracts: string[]; url: string | null; emailed: string | null; error: string | null };

const OPENED = "akab.acctContracts.opened";
const readOpened = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(OPENED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/** Accounting › Contrats: every contract of every client, a folder per client (folded at first). */
export function ContractsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["crm", "all-contracts"], queryFn: () => api.get<Row[]>("/crm/contracts") });
  // several contracts sent at once for automatic card payment: one link per client, to its billing email
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SendResult[] | null>(null);
  const pick = (ids: string[], on: boolean) => {
    const s = new Set(picked);
    for (const id of ids) {
      if (on) s.add(id);
      else s.delete(id);
    }
    setPicked(s);
  };
  const sendMany = useMutation({
    mutationFn: () => api.post<{ results: SendResult[] }>("/autopay/send-many", { contractIds: [...picked] }),
    onSuccess: (r) => {
      setResults(r.results);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "stripe_not_ready" ? t("autopay.error.stripe_not_ready") : t("common.error")),
  });
  const pickedClients = new Set(rows.filter((r) => picked.has(r.id)).map((r) => r.clientId)).size;
  const canSend = can("crm.billing");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [opened, setOpened] = useState<Set<string>>(readOpened);
  const save = (s: Set<string>) => {
    setOpened(s);
    try {
      sessionStorage.setItem(OPENED, JSON.stringify([...s]));
    } catch {
      /* no storage: the folders just start folded again */
    }
  };
  const toggle = (id: string) => {
    const s = new Set(opened);
    if (!s.delete(id)) s.add(id);
    save(s);
  };

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const by = new Map<string, { id: string; name: string; rows: Row[] }>();
    for (const r of rows) {
      if (filter === "active" ? !r.active : filter === "inactive" ? r.active : false) continue;
      if (!words.every((w) => `${r.clientName} ${r.name} ${r.type ?? ""}`.toLowerCase().includes(w))) continue;
      const g = by.get(r.clientId) ?? { id: r.clientId, name: r.clientName, rows: [] };
      g.rows.push(r);
      by.set(r.clientId, g);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, q, filter]);

  const counts = { active: rows.filter((r) => r.active).length, inactive: rows.filter((r) => !r.active).length, all: rows.length };
  const monthlyOf = (rs: Row[]) => rs.filter((r) => r.active).reduce((s, r) => s + (r.billingPeriod === "yearly" ? r.summary.perPeriodCents / 12 : r.summary.perPeriodCents) + r.summary.yearlyExtraCents / 12, 0);
  const lang = i18n.language;
  // two tabs: the contracts, and the automatic card payments (?tab=cards)
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "cards" ? "cards" : "list";
  const goTab = (k: "list" | "cards") =>
    setParams(
      (p) => {
        if (k === "cards") p.set("tab", "cards");
        else p.delete("tab");
        return p;
      },
      { replace: true },
    );

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <FileText className="size-6 text-primary" /> {t("acctContracts.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("acctContracts.subtitle")}</p>
        </div>
        {tab === "list" && (
          <>
            <Button variant="outline" size="sm" onClick={() => save(new Set(groups.map((g) => g.id)))}>
              {t("acctContracts.expandAll")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => save(new Set())}>
              {t("acctContracts.collapseAll")}
            </Button>
          </>
        )}
        {tab === "list" && canSend && (
          // every active contract shown (the search and filter apply), without one already paid by card
          <Button variant="outline" size="sm" onClick={() => pick(groups.flatMap((g) => g.rows.filter((r) => r.active && r.autopay !== "active").map((r) => r.id)), true)}>
            <CreditCard className="size-3.5" /> {t("acctContracts.pickAll")}
          </Button>
        )}
      </div>

      <div className="flex gap-1" role="tablist">
        {(["list", "cards"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => goTab(k)}
            className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors", tab === k ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
          >
            {k === "cards" ? <CreditCard className="size-4" /> : <FileText className="size-4" />} {t(k === "cards" ? "cardList.tab" : "acctContracts.tabList")}
          </button>
        ))}
      </div>

      {tab === "cards" ? (
        <CardAutopays />
      ) : (
        <>

      <div className="glass flex flex-wrap items-center gap-2 rounded-2xl border p-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("acctContracts.search")} className="h-9 rounded-xl border-[color:var(--glass-border)] bg-background/40 pl-9" />
        </div>
        <div className="flex gap-1">
          {(["active", "inactive", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors", filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
            >
              {t(`acctContracts.${f}`)} <span className="font-mono text-[11px] text-muted-foreground">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {canSend && picked.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--gold)]/40 bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <CreditCard className="size-4 text-primary" />
          <span className="text-sm">{t("acctContracts.picked", { count: picked.size, clients: pickedClients })}</span>
          <Button
            size="sm"
            disabled={sendMany.isPending}
            className="ml-auto bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
            onClick={() => void confirm({ title: t("acctContracts.sendTitle", { count: pickedClients }), description: t("acctContracts.sendText") }).then((ok) => ok && sendMany.mutate())}
          >
            {sendMany.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("acctContracts.send")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} aria-label={t("acctContracts.clearPick")}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && groups.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{t("acctContracts.none")}</p>}
      <div className="space-y-2">
        {groups.map((g) => {
          const open = opened.has(g.id);
          return (
            <div key={g.id} className="glass overflow-hidden rounded-2xl border">
              <div className="flex items-center">
              {canSend && <ClientPick ids={g.rows.filter((r) => r.active).map((r) => r.id)} picked={picked} onPick={pick} label={t("acctContracts.pickClient", { name: g.name })} />}
              <button type="button" onClick={() => toggle(g.id)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40">
                {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                <span className="text-xs text-muted-foreground">{t("acctContracts.contracts", { count: g.rows.length })}</span>
                <span className="w-36 text-right font-mono text-sm font-semibold">
                  {money(Math.round(monthlyOf(g.rows)), lang)} <span className="font-sans text-[11px] font-normal text-muted-foreground">{t("acctContracts.perMonth")}</span>
                </span>
              </button>
              </div>
              {open && (
                <ul className="divide-y divide-border/60 border-t">
                  {g.rows.map((r) => (
                    <li key={r.id} className="flex items-center">
                      {canSend && (
                        <span className="pl-11">
                          <Checkbox disabled={!r.active} checked={picked.has(r.id)} onCheckedChange={(v) => pick([r.id], v === true)} aria-label={r.name} />
                        </span>
                      )}
                      <Link to={`/crm/${r.clientId}?tab=contracts`} className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-accent/40", !r.active && "opacity-60")}>
                        <span className={cn("min-w-0 flex-1 truncate text-sm", !canSend && "pl-7")}>{r.name}</span>
                        {r.autopay === "active" && (
                          <span className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                            <CreditCard className="size-3" /> {t("acctContracts.autopayActive")}
                          </span>
                        )}
                        {r.autopay === "pending" && (
                          <span className="flex items-center gap-1 rounded-md border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                            <CreditCard className="size-3" /> {t("acctContracts.autopayPending")}
                          </span>
                        )}
                        {r.rebateBps > 0 && <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">−{r.rebateBps / 100} %</span>}
                        {!r.active && <span className="text-[11px] text-muted-foreground">{t("acctContracts.stopped")}</span>}
                        <span className="w-32 truncate text-xs text-muted-foreground">{r.type ?? "—"}</span>
                        <span className="w-44 text-xs text-muted-foreground">
                          {r.startDate ?? "…"} → {r.endDate ?? t("acctContracts.noEnd")}
                        </span>
                        <span className="w-44 text-right font-mono text-sm">
                          {money(r.summary.perPeriodCents, lang)} <span className="font-sans text-[11px] text-muted-foreground">{r.billingPeriod === "yearly" ? t("acctContracts.perYear") : t("acctContracts.perMonth")}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t("acctContracts.clients", { count: groups.length })}</p>
      {results && <SendResults results={results} onClose={() => setResults(null)} />}
        </>
      )}
    </div>
  );
}

/** The box on a client's folder: picks every active contract of the client (half-ticked when some are) */
function ClientPick({ ids, picked, onPick, label }: { ids: string[]; picked: Set<string>; onPick: (ids: string[], on: boolean) => void; label: string }) {
  const n = ids.filter((id) => picked.has(id)).length;
  return (
    <span className="pl-4">
      <Checkbox disabled={!ids.length} checked={n && n === ids.length ? true : n ? "indeterminate" : false} onCheckedChange={(v) => onPick(ids, v === true)} aria-label={label} />
    </span>
  );
}

/** What the bulk send did, client by client: sent to whom, or why not (a link to copy instead) */
function SendResults({ results, onClose }: { results: SendResult[]; onClose: () => void }) {
  const { t } = useTranslation();
  const sent = results.filter((r) => r.emailed).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("acctContracts.resultsTitle")}</DialogTitle>
          <DialogDescription>{t("acctContracts.resultsText", { sent, count: results.length })}</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border/60 rounded-xl border">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.client}</span>
                <span className="block truncate text-xs text-muted-foreground">{r.contracts.join(", ")}</span>
                {r.emailed ? (
                  <span className="block text-xs text-emerald-300">{t("acctContracts.sentTo", { to: r.emailed })}</span>
                ) : (
                  <span className="block text-xs text-amber-300">{t(`acctContracts.err.${r.error ?? "failed"}`, { defaultValue: t("acctContracts.err.failed") })}</span>
                )}
              </span>
              {!r.emailed && r.url && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void navigator.clipboard.writeText(r.url!).then(() => toast.success(t("autopay.copied")))}>
                  <Copy className="size-3" /> {t("autopay.copy")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
