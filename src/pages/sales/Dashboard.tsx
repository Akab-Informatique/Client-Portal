import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CalendarCheck2, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { STAGE_TONE, shortMoney, type Opportunity, type SalesDashboard } from "./shared";

const monthLabel = (ym: string, lang: string) => new Intl.DateTimeFormat(lang === "en" ? "en-CA" : "fr-CA", { month: "short" }).format(new Date(`${ym}-15T12:00:00`));

/** Vente › Ventes › Tableau de bord: follow-ups late first, then results, pipeline, efficiency and activity. */
export function Dashboard({ data, isLoading, onOpen }: { data: SalesDashboard | undefined; isLoading: boolean; onOpen: (o: Opportunity) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (isLoading || !data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 rounded-2xl" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-36 rounded-2xl" />
          <Skeleton className="h-36 rounded-2xl" />
          <Skeleton className="h-36 rounded-2xl" />
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  const { results: r, pipeline: p, efficiency: e, activity: act } = data;
  const m = (c: number) => shortMoney(c, lang);

  return (
    <div className="space-y-4">
      {/* follow-ups late: what needs a call today, before any figure */}
      {act.overdue.length ? (
        <section className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
          <h2 className="flex items-center gap-2 font-semibold text-red-300">
            <AlertTriangle className="size-5" /> {t("sales.dash.overdue", { count: act.overdue.length })}
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {act.overdue.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => onOpen(o)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-background/60 px-3 py-2 text-left hover:border-red-400">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{o.companyName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t(`sales.stage.${o.stage}`)}
                      {o.ownerName && ` · ${o.ownerName}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    <span className="block font-semibold text-red-300">{shortDate(o.nextFollowUp!)}</span>
                    <span className="block tabular-nums text-muted-foreground">{o.kind === "recurring" ? `${m(o.monthlyCents)}${t("sales.perMonth")}` : m(o.oneTimeCents ?? 0)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="size-4" /> {t("sales.dash.noOverdue")}
          {act.dueToday > 0 && <span className="text-muted-foreground">· {t("sales.dash.dueToday", { count: act.dueToday })}</span>}
        </p>
      )}

      {/* results */}
      <section className="grid gap-4 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="glass rounded-2xl border border-[color:var(--gold)]/40 p-5">
          <p className="text-sm text-muted-foreground">{t("sales.dash.mrrAdded")}</p>
          <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">
            {m(r.mrrAddedCents)}
            <span className="text-lg font-normal text-muted-foreground">{t("sales.perMonth")}</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t("sales.dash.mrrAddedDeals", { count: r.mrrAddedDeals, year: m(r.mrrAddedCents * 12) })}</p>
        </div>
        <Tile label={t("sales.dash.mrrTotal")} value={m(r.mrrTotalCents)} suffix={t("sales.perMonth")} hint={t("sales.dash.users", { count: r.usersUnderContract })} />
        <Tile label={t("sales.dash.oneTime")} value={m(r.oneTimeWonCents)} hint={t("sales.dash.deals", { count: r.oneTimeWonDeals })} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="glass rounded-2xl border p-5">
          <h2 className="font-semibold">{t("sales.dash.mrrChart")}</h2>
          <p className="text-xs text-muted-foreground">{t("sales.dash.mrrChartHint")}</p>
          <Bars
            items={r.mrrSeries.map((s) => ({ key: s.month, label: monthLabel(s.month, lang), value: s.mrrCents, tip: `${m(s.mrrCents)}${t("sales.perMonth")} (+${m(s.addedCents)})` }))}
            height={180}
            emptyText={t("sales.dash.noMrr")}
          />
        </div>

        <div className="glass space-y-4 rounded-2xl border p-5">
          <h2 className="font-semibold">{t("sales.dash.pipeline")}</h2>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("sales.dash.openValue")}</dt>
              <dd className="text-xl font-bold tabular-nums">
                {m(p.openMrrCents)}
                <span className="whitespace-nowrap text-sm font-normal text-muted-foreground">{t("sales.perMonth")}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("sales.dash.weighted")}</dt>
              <dd className="text-xl font-bold tabular-nums text-[color:var(--gold)]">
                {m(p.weightedMrrCents)}
                <span className="whitespace-nowrap text-sm font-normal text-muted-foreground">{t("sales.perMonth")}</span>
              </dd>
            </div>
          </dl>
          {p.openOneTimeCents > 0 && <p className="text-xs text-muted-foreground">{t("sales.dash.openOneTime", { open: m(p.openOneTimeCents), weighted: m(p.weightedOneTimeCents) })}</p>}
          <ul className="space-y-2">
            {p.byStage.map((s) => {
              const max = Math.max(...p.byStage.map((x) => x.mrrCents), 1);
              return (
                <li key={s.stage} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 rounded-full", STAGE_TONE[s.stage])} />
                      {t(`sales.stage.${s.stage}`)} <span className="text-muted-foreground">({s.count})</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">{m(s.mrrCents)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-[color:var(--gold)]" style={{ width: `${Math.max((s.mrrCents / max) * 100, s.mrrCents ? 3 : 0)}%` }} />
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t("sales.dash.openDeals", { count: p.openDeals })}</p>
        </div>
      </section>

      {/* efficiency */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Tile label={t("sales.dash.conversion")} value={e.conversionPct == null ? "-" : `${String(e.conversionPct).replace(".", ",")} %`} hint={t("sales.dash.wonLost", { won: e.won, lost: e.lost })} />
        <Tile label={t("sales.dash.cycle")} value={e.avgCycleDays == null ? "-" : t("sales.dash.days", { count: e.avgCycleDays })} hint={t("sales.dash.cycleHint")} />
        <Breakdown title={t("sales.dash.bySource")} rows={e.bySource.map((s) => ({ key: s.key, label: t(`sales.source.${s.key}`), count: s.count, extra: s.mrrCents ? `${m(s.mrrCents)}${t("sales.perMonth")}` : s.oneTimeCents ? m(s.oneTimeCents) : "" }))} empty={t("sales.dash.noWins")} />
        <Breakdown title={t("sales.dash.lostReasons")} rows={e.lostReasons.map((s) => ({ key: s.key, label: t(`sales.lost.${s.key}`), count: s.count, extra: "" }))} empty={t("sales.dash.noLosses")} tone="bg-red-400" />
      </section>

      {/* activity */}
      <section className="glass rounded-2xl border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <CalendarCheck2 className="size-4 text-primary" /> {t(act.quotesSentBy === "week" ? "sales.dash.quotesWeek" : "sales.dash.quotesMonth")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("sales.dash.quotesTotal", { count: act.quotesSent })}</p>
        </div>
        <Bars
          items={act.quotesSentSeries.map((b) => ({ key: b.start, label: act.quotesSentBy === "week" ? shortDate(b.start) : monthLabel(b.start.slice(0, 7), lang), value: b.count, tip: t("sales.dash.quotesTip", { count: b.count }) }))}
          height={120}
          showValues
          emptyText={t("sales.dash.noQuotes")}
        />
      </section>
    </div>
  );
}

function Tile({ label, value, suffix, hint }: { label: string; value: string; suffix?: string; hint?: string }) {
  return (
    <div className="glass rounded-2xl border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">
        {value}
        {suffix && <span className="whitespace-nowrap text-sm font-normal text-muted-foreground">{suffix}</span>}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Breakdown({ title, rows, empty, tone = "bg-[color:var(--gold)]" }: { title: string; rows: { key: string; label: string; count: number; extra: string }[]; empty: string; tone?: string }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="glass rounded-2xl border p-5">
      <p className="text-sm text-muted-foreground">{title}</p>
      {rows.length ? (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {r.count}
                  {r.extra && ` · ${r.extra}`}
                </span>
              </div>
              <div className={cn("mt-1 h-1.5 rounded-full", tone)} style={{ width: `${(r.count / max) * 100}%` }} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

/** One series of vertical bars on a quiet baseline; the hovered bar shows its value. */
function Bars({ items, height, showValues, emptyText }: { items: { key: string; label: string; value: number; tip: string }[]; height: number; showValues?: boolean; emptyText: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(...items.map((i) => i.value), 0);
  if (!max) return <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>;
  const shown = items.find((i) => i.key === hover);
  return (
    <div className="mt-4">
      <p className="h-5 text-sm tabular-nums" aria-live="polite">
        {shown ? `${shown.label} : ${shown.tip}` : ""}
      </p>
      <div className="flex items-end gap-1 border-b border-border/60" style={{ height }} role="img" aria-label={items.map((i) => `${i.label} ${i.tip}`).join(", ")}>
        {items.map((i) => (
          <div key={i.key} className="group flex h-full flex-1 flex-col items-center justify-end" onMouseEnter={() => setHover(i.key)} onMouseLeave={() => setHover(null)}>
            {showValues && i.value > 0 && <span className="mb-1 text-[11px] tabular-nums text-muted-foreground">{i.value}</span>}
            <div className={cn("w-full max-w-10 rounded-t bg-[color:var(--gold)] transition-opacity", hover && hover !== i.key && "opacity-50")} style={{ height: `${(i.value / max) * 100}%`, minHeight: i.value ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {items.map((i) => (
          <span key={i.key} className="flex-1 truncate text-center text-[11px] text-muted-foreground">
            {i.label}
          </span>
        ))}
      </div>
    </div>
  );
}
