import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { contractEventIcon, contractEventText, type Event } from "@/pages/crm/ContractDialog";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Contract = {
  id: string;
  clientId: string;
  client: string;
  name: string;
  type: string | null;
  active: boolean;
  billingMode: string;
  billingPeriod: "monthly" | "yearly";
  monthlyCents: number | null;
  startDate: string | null;
  endDate: string | null;
  lastChange: string | null;
};
type Feed = Event & { contractId: string; contract: string; clientId: string; client: string };
type Data = {
  from: string;
  to: string;
  summary: { running: number; recurring: number; mrrCents: number; created: number; stopped: number; changes: number; events: number };
  events: Feed[];
  contracts: Contract[];
};

/** Ventes › Contrats: the contracts of the clients, and every one made or adjusted in the period (from their own activity). */
export function ContractsTab({ period, day }: { period: string; day: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [q, setQ] = useState("");
  const [showStopped, setShowStopped] = useState(false);
  const data = useQuery({
    queryKey: ["sales", "contracts", period, day],
    queryFn: () => api.get<Data>(`/sales/contracts?period=${period}&day=${day}`),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const d = data.data;
  const words = q.trim().toLowerCase();
  const contracts = useMemo(
    () => (d?.contracts ?? []).filter((k) => (showStopped || k.active) && (!words || `${k.client} ${k.name} ${k.type ?? ""}`.toLowerCase().includes(words))),
    [d, words, showStopped],
  );
  const events = (d?.events ?? []).filter((e) => !words || `${e.client} ${e.contract}`.toLowerCase().includes(words));

  const tiles = [
    { key: "running", value: String(d?.summary.running ?? 0), tone: "" },
    { key: "mrr", value: money(d?.summary.mrrCents ?? 0, lang), tone: "text-primary" },
    { key: "created", value: String(d?.summary.created ?? 0), tone: "text-emerald-300" },
    { key: "changes", value: String(d?.summary.changes ?? 0), tone: "text-sky-300" },
    { key: "stopped", value: String(d?.summary.stopped ?? 0), tone: "text-amber-300" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {tiles.map((x) => (
          <div key={x.key} className="glass rounded-2xl border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t(`sales.contracts.tiles.${x.key}`)}</p>
            {d ? <p className={cn("mt-1 text-2xl font-bold tabular-nums", x.tone)}>{x.value}</p> : <Skeleton className="mt-1 h-8 w-24" />}
            {x.key === "mrr" && d && <p className="text-xs text-muted-foreground">{t("sales.contracts.mrrOf", { count: d.summary.recurring })}</p>}
          </div>
        ))}
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-9 bg-background/40 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sales.contracts.search")} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <section className="glass overflow-hidden rounded-2xl border">
          <h3 className="border-b px-4 py-2.5 text-sm font-semibold">{t("sales.contracts.activity", { count: events.length })}</h3>
          {!d ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t("sales.contracts.noActivity")}</p>
          ) : (
            <ol className="max-h-[36rem] divide-y overflow-y-auto">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background/60">{contractEventIcon(e.kind)}</span>
                  <span className="min-w-0 flex-1">
                    <Link to={`/crm/${e.clientId}?tab=contracts`} className="font-medium hover:text-primary hover:underline">
                      {e.client} · {e.contract}
                    </Link>
                    <span className="block">{contractEventText(t, e, lang)}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {new Date(e.at).toLocaleString(lang)} · {e.source === "itcloud" ? "ITCloud" : (e.actor ?? "—")}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="glass overflow-hidden rounded-2xl border">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
            <h3 className="text-sm font-semibold">{t("sales.contracts.list", { count: contracts.length })}</h3>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} /> {t("sales.contracts.showStopped")}
            </label>
          </div>
          {!d ? (
            <Skeleton className="m-3 h-48" />
          ) : contracts.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t("sales.contracts.none")}</p>
          ) : (
            <div className="max-h-[36rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background/80 text-left text-xs uppercase text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2">{t("sales.contracts.contract")}</th>
                    <th className="px-3 py-2">{t("sales.contracts.term")}</th>
                    <th className="px-3 py-2 text-right">{t("sales.contracts.monthly")}</th>
                    <th className="px-3 py-2">{t("sales.contracts.lastChange")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {contracts.map((k) => (
                    <tr key={k.id} className={cn(!k.active && "opacity-50")}>
                      <td className="px-3 py-1.5">
                        <Link to={`/crm/${k.clientId}?tab=contracts`} className="font-medium hover:text-primary hover:underline">
                          {k.client}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {k.name}
                          {k.type ? ` · ${k.type}` : ""}
                          {!k.active && ` · ${t("sales.contracts.stopped")}`}
                        </p>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{k.startDate ? `${shortDate(k.startDate)}${k.endDate ? ` → ${shortDate(k.endDate)}` : ""}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{k.monthlyCents === null ? "—" : money(k.monthlyCents, lang)}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{k.lastChange ? shortDate(k.lastChange) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
