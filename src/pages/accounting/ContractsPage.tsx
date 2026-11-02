import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Loader2, Search } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
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
  summary: { perPeriodCents: number; yearlyExtraCents: number; revenueCents: number };
};
type Filter = "active" | "inactive" | "all";

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
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["crm", "all-contracts"], queryFn: () => api.get<Row[]>("/crm/contracts") });
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
        <Button variant="outline" size="sm" onClick={() => save(new Set(groups.map((g) => g.id)))}>
          {t("acctContracts.expandAll")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => save(new Set())}>
          {t("acctContracts.collapseAll")}
        </Button>
      </div>

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

      {isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && groups.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{t("acctContracts.none")}</p>}
      <div className="space-y-2">
        {groups.map((g) => {
          const open = opened.has(g.id);
          return (
            <div key={g.id} className="glass overflow-hidden rounded-2xl border">
              <button type="button" onClick={() => toggle(g.id)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40">
                {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                <span className="text-xs text-muted-foreground">{t("acctContracts.contracts", { count: g.rows.length })}</span>
                <span className="w-36 text-right font-mono text-sm font-semibold">
                  {money(Math.round(monthlyOf(g.rows)), lang)} <span className="font-sans text-[11px] font-normal text-muted-foreground">{t("acctContracts.perMonth")}</span>
                </span>
              </button>
              {open && (
                <ul className="divide-y divide-border/60 border-t">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <Link to={`/crm/${r.clientId}?tab=contracts`} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-accent/40", !r.active && "opacity-60")}>
                        <span className="min-w-0 flex-1 truncate pl-7 text-sm">{r.name}</span>
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
    </div>
  );
}
