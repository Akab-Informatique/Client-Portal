import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { currentLocale } from "@/i18n";

type Usage = {
  days: number;
  dailyLimitUsd: number | null;
  total: { costUsd: number; requests: number; inputTokens: number; outputTokens: number };
  today: { costUsd: number; requests: number };
  byDay: { day: string; costUsd: number; requests: number }[];
  byUser: { userId: string; name: string; todayUsd: number; periodUsd: number; requests: number; limitUsd: number | null }[];
  admin: { costUsd: number; requests: number };
  byFeature: { feature: string; costUsd: number; requests: number }[];
  byModel: { model: string; costUsd: number; requests: number; inputTokens: number; outputTokens: number }[];
};
export const AI_USAGE_KEY = ["admin", "integrations", "ai", "usage"];

/** "0,42 $", "12,30 $", "<0,01 $" (US dollars; the section title says so). */
export function money(usd: number) {
  const n = (v: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  if (usd > 0 && usd < 0.01) return currentLocale() === "en" ? "<$0.01" : "<0,01 $";
  return currentLocale() === "en" ? `$${n(usd)}` : `${n(usd)} $`;
}
const featureKey = (f: string) => f.replace(/\./g, "_");

/** Claude usage: today, the last 30 days per day, per person (with their limit), per part and per model. */
export function AiUsagePanel() {
  const { t } = useTranslation();
  const { data: u, isLoading } = useQuery({ queryKey: AI_USAGE_KEY, queryFn: () => api.get<Usage>("/admin/integrations/ai/usage?days=30"), refetchInterval: 60_000 });
  const [asTable, setAsTable] = useState(false);
  if (isLoading || !u) return <Skeleton className="h-64 rounded-2xl" />;
  return (
    <section className="space-y-5 rounded-2xl border bg-card/80 px-6 py-6">
      <h3 className="font-display text-lg font-semibold">{t("integrations.ai.usage.title")}</h3>

      {/* Headline numbers */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("integrations.ai.usage.today")} value={money(u.today.costUsd)} hint={t("integrations.ai.usage.requests", { count: u.today.requests })} />
        <Stat label={t("integrations.ai.usage.period", { count: u.days })} value={money(u.total.costUsd)} hint={t("integrations.ai.usage.requests", { count: u.total.requests })} />
        <Stat
          label={t("integrations.ai.usage.limit")}
          value={u.dailyLimitUsd === null ? t("integrations.ai.usage.noLimit") : money(u.dailyLimitUsd)}
          hint={t("integrations.ai.usage.perPerson")}
        />
      </div>

      {/* Cost per day */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("integrations.ai.usage.perDay")}</p>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            <Table2 className="size-3.5" /> {asTable ? t("integrations.ai.usage.chart") : t("integrations.ai.usage.table")}
          </Button>
        </div>
        {asTable ? <DayTable rows={u.byDay} /> : <DayBars rows={u.byDay} />}
      </div>

      <PeopleTable u={u} />

      <div className="grid gap-5 lg:grid-cols-2">
        <MiniTable
          title={t("integrations.ai.usage.byFeature")}
          rows={u.byFeature.map((f) => ({ key: f.feature, label: f.feature === "test" ? t("integrations.ai.usage.test") : t(`integrations.ai.features.${featureKey(f.feature)}`, { defaultValue: f.feature }), costUsd: f.costUsd, requests: f.requests }))}
        />
        <MiniTable
          title={t("integrations.ai.usage.byModel")}
          rows={u.byModel.map((m) => ({ key: m.model, label: t(`integrations.ai.models.${m.model}`, { defaultValue: m.model }), costUsd: m.costUsd, requests: m.requests }))}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("integrations.ai.usage.note")}</p>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border bg-background/40 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/** One column per day (thin, rounded tip, 2px apart), a tooltip on hover. */
function DayBars({ rows }: { rows: Usage["byDay"] }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => r.costUsd), 0);
  // a clean top value for the scale
  const top = max <= 0 ? 1 : niceCeil(max);
  const H = 120;
  const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(currentLocale() === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short" });
  return (
    <div className="relative">
      <div className="flex gap-2">
        {/* scale */}
        <div className="flex w-12 shrink-0 flex-col justify-between text-right font-mono text-[10px] text-muted-foreground" style={{ height: H }}>
          <span>{money(top)}</span>
          <span>{money(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          {/* recessive hairlines */}
          {[0, 0.5, 1].map((p) => (
            <span key={p} className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ top: H * p }} />
          ))}
          <div className="relative flex items-end gap-[2px]" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {rows.map((r, i) => (
              <div
                key={r.day}
                className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${day(r.day)} : ${money(r.costUsd)}, ${t("integrations.ai.usage.requests", { count: r.requests })}`}
              >
                <span
                  className={cn("block w-full max-w-6 rounded-t-[4px] bg-[#b86e08] transition-opacity dark:bg-[#c97a0a]", hover !== null && hover !== i && "opacity-50")}
                  style={{ height: r.costUsd > 0 ? Math.max(2, (r.costUsd / top) * H) : 0 }}
                />
              </div>
            ))}
          </div>
          {hover !== null && rows[hover] && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
              style={{ left: `${((hover + 0.5) / rows.length) * 100}%` }}
            >
              <p className="font-medium">{day(rows[hover].day)}</p>
              <p className="font-mono tabular-nums">{money(rows[hover].costUsd)}</p>
              <p className="text-muted-foreground">{t("integrations.ai.usage.requests", { count: rows[hover].requests })}</p>
            </div>
          )}
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{rows[0] && day(rows[0].day)}</span>
            <span>{rows.at(-1) && day(rows.at(-1)!.day)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function niceCeil(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function DayTable({ rows }: { rows: Usage["byDay"] }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-64 overflow-y-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t("integrations.ai.usage.day")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("integrations.ai.usage.cost")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("integrations.ai.usage.requestsCol")}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {[...rows].reverse().map((r) => (
            <tr key={r.day}>
              <td className="px-3 py-1.5 font-mono text-xs">{r.day}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{money(r.costUsd)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per person: today, the period, and their own daily limit (empty: the general one). */
function PeopleTable({ u }: { u: Usage }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("integrations.ai.usage.perPersonTitle")}</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-background/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t("integrations.ai.usage.person")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("integrations.ai.usage.today")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("integrations.ai.usage.period", { count: u.days })}</th>
              <th className="px-3 py-2 text-right font-medium">{t("integrations.ai.usage.requestsCol")}</th>
              <th className="px-3 py-2 font-medium">{t("integrations.ai.usage.ownLimit")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {u.byUser.map((p) => (
              <PersonRow key={p.userId} p={p} general={u.dailyLimitUsd} />
            ))}
            {u.admin.requests > 0 && (
              <tr className="text-muted-foreground">
                <td className="px-3 py-2">{t("integrations.ai.usage.test")}</td>
                <td />
                <td className="px-3 py-2 text-right font-mono tabular-nums">{money(u.admin.costUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{u.admin.requests}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersonRow({ p, general }: { p: Usage["byUser"][number]; general: number | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [value, setValue] = useState(p.limitUsd === null ? "" : String(p.limitUsd));
  const limit = p.limitUsd ?? general;
  const save = useMutation({
    mutationFn: () => api.put(`/admin/integrations/ai/limits/${p.userId}`, { limitUsd: value.trim() === "" ? null : Number(value.replace(",", ".")) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AI_USAGE_KEY });
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const changed = value !== (p.limitUsd === null ? "" : String(p.limitUsd));
  const reached = limit !== null && p.todayUsd >= limit;
  return (
    <tr>
      <td className="px-3 py-2 font-medium">{p.name}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">
        {money(p.todayUsd)}
        {reached && <span className="ml-1.5 rounded border border-orange-500/40 px-1 text-[10px] text-orange-300">{t("integrations.ai.usage.reached")}</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{money(p.periodUsd)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{p.requests}</td>
      <td className="px-3 py-1.5">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Input
            inputMode="decimal"
            className="h-7 w-24 text-xs"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={general === null ? t("integrations.ai.usage.noLimit") : money(general)}
            aria-label={t("integrations.ai.usage.ownLimitOf", { name: p.name })}
          />
          {changed && (
            <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={save.isPending || (value.trim() !== "" && !(Number(value.replace(",", ".")) >= 0))}>
              {save.isPending ? <Loader2 className="size-3 animate-spin" /> : t("common.save")}
            </Button>
          )}
        </form>
      </td>
    </tr>
  );
}

function MiniTable({ title, rows }: { title: string; rows: { key: string; label: string; costUsd: number; requests: number }[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">{t("integrations.ai.usage.none")}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="text-xs text-muted-foreground">{t("integrations.ai.usage.requests", { count: r.requests })}</span>
              <span className="w-20 text-right font-mono tabular-nums">{money(r.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
