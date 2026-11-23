import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_TONE, type OppReport as Report } from "./shared";

const TODAY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const YEAR_AGO = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
};

const money = (cents: number, lang: string) => new Intl.NumberFormat(lang, { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(cents / 100);

/** Rapport: totals, origins and technicians who flag, the closed opportunities and what they became. */
export function OppReport() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en-CA" : "fr-CA";
  const [sp, setSp] = useSearchParams();
  const from = sp.get("from") ?? YEAR_AGO();
  const to = sp.get("to") ?? TODAY();
  const setRange = (key: "from" | "to", v: string) => {
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set(key, v);
        return n;
      },
      { replace: true },
    );
  };
  const q = useQuery({ queryKey: ["opps", "report", from, to], queryFn: () => api.get<Report>(`/opps/report?from=${from}&to=${to}`), placeholderData: (p) => p });
  const r = q.data;
  const sources = Object.entries(r?.bySource ?? {}).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  const maxSource = Math.max(1, ...sources.map((x) => x.count));
  const maxTech = Math.max(1, ...(r?.byTechnician.map((x) => x.count) ?? [1]));
  // the money columns show only when the API gives money (the money right)
  const withMoney = Boolean(r?.money);
  const sourceLabel = (k: string) => {
    const key = `opps.sources.${k}`;
    const text = t(key);
    return text === key ? k : text;
  };

  return (
    <div className="space-y-5">
      <div className="glass flex flex-wrap items-end gap-3 rounded-xl border p-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("opps.report.from")}</span>
          <Input type="date" value={from} onChange={(e) => setRange("from", e.target.value)} className="h-9 w-auto" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("opps.report.to")}</span>
          <Input type="date" value={to} onChange={(e) => setRange("to", e.target.value)} className="h-9 w-auto" />
        </label>
      </div>

      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Tile label={t("opps.report.flagged")} value={r.totals.total} />
            <Tile label={t("opps.report.won")} value={r.totals.byStatus.won} tone={STATUS_TONE.won} />
            <Tile label={t("opps.report.lost")} value={r.totals.byStatus.lost} tone={STATUS_TONE.lost} />
            <Tile label={t("opps.report.canceled")} value={r.totals.byStatus.canceled} tone={STATUS_TONE.canceled} />
            <Tile label={t("opps.report.conversion")} value={r.totals.conversionPct == null ? t("opps.report.noData") : `${r.totals.conversionPct} %`} />
            <Tile label={t("opps.report.avgDays")} value={r.totals.avgDaysToClose == null ? t("opps.report.noData") : t("opps.report.days", { count: r.totals.avgDaysToClose })} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Bars title={t("opps.report.bySource")} rows={sources.map((x) => ({ key: x.key, label: sourceLabel(x.key), count: x.count }))} max={maxSource} />
            <Bars title={t("opps.report.byTech")} rows={r.byTechnician.map((x) => ({ key: x.name, label: x.name, count: x.count }))} max={maxTech} />
          </div>

          <section className="glass overflow-hidden rounded-xl border">
            <h3 className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("opps.report.closed")}</h3>
            {r.closed.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("opps.report.none")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-4 py-2 font-medium">{t("opps.report.outcome")}</th>
                      <th className="px-4 py-2 font-medium">{t("opps.create.client")}</th>
                      <th className="px-4 py-2 font-medium">{t("opps.report.closedAt")}</th>
                      <th className="px-4 py-2 font-medium">{t("opps.report.linked")}</th>
                      {withMoney && <th className="px-4 py-2 text-right font-medium">{t("opps.report.value")}</th>}
                      {withMoney && <th className="px-4 py-2 text-right font-medium">{t("opps.report.margin")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {r.closed.map((c) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <span className="font-mono text-xs text-[color:var(--gold)]">{c.number}</span>{" "}
                          <span className={cn("ml-1 rounded-full border px-2 py-0.5 text-[11px]", STATUS_TONE[c.status])}>{t(`opps.statuses.${c.status}`)}</span>
                        </td>
                        <td className="px-4 py-2">{c.client?.name || t("opps.unknownClient")}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{c.closedAt?.slice(0, 10) ?? "—"}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{c.links.map((l) => `${t(`opps.link.kinds.${l.kind}`)} : ${l.label}`).join(" · ") || "—"}</td>
                        {withMoney && <td className="px-4 py-2 text-right tabular-nums">{c.valueCents == null ? "—" : money(c.valueCents, lang)}</td>}
                        {withMoney && <td className="px-4 py-2 text-right tabular-nums">{c.marginCents == null ? "—" : money(c.marginCents, lang)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {withMoney && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("opps.report.moneyNote")}</p>}
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className={cn("glass rounded-xl border p-3", tone && "border-transparent")}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

/** A simple bar list: each row's width against the biggest count (no chart library). */
function Bars({ title, rows, max }: { title: string; rows: { key: string; label: string; count: number }[]; max: number }) {
  const { t } = useTranslation();
  return (
    <section className="glass space-y-3 rounded-xl border p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("opps.report.noData")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((x) => (
            <li key={x.key} className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="truncate">{x.label}</span>
                <span className="tabular-nums text-muted-foreground">{t("opps.report.flaggedCount", { count: x.count })}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-grad-gold" style={{ width: `${Math.round((x.count / max) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
