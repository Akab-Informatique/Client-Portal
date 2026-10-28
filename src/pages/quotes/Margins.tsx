import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { lineAmount, QUOTE_RECURRENCES, recurrenceOf, type QuoteLineMoney, type QuotePart } from "@shared/quotes";
import type { QuoteTotals } from "./shared";

type MarginRow = QuoteLineMoney & { key: string; name: string };

/** Under 15 % the margin is thin (the same mark as the ITCloud prices); at 0 or less it is a loss. */
const tone = (pct: number | null) => (pct == null ? "text-muted-foreground" : pct <= 0 ? "text-red-400" : pct < 15 ? "text-amber-300" : "text-emerald-400");
const pctOf = (margin: number, sold: number) => (sold > 0 ? Math.round((margin / sold) * 1000) / 10 : null);

/**
 * Internal only (Interne mode): what each line costs AKAB and what it leaves, by kind
 * (implementation, monthly, yearly), with the first-year total. Never on the client's sheet.
 */
export function MarginsPanel({ rows, totals }: { rows: MarginRow[]; totals: QuoteTotals }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const fmtPct = (p: number | null) => (p == null ? "–" : `${String(p).replace(".", ",")} %`);
  const parts: { k: (typeof QUOTE_RECURRENCES)[number]; part: QuotePart }[] = [
    { k: "once", part: totals },
    { k: "monthly", part: totals.monthly },
    { k: "yearly", part: totals.yearly },
  ];
  // the first year: the implementation, 12 months of the monthly lines and one year of the yearly ones
  const year = {
    sold: totals.subtotalCents + 12 * totals.monthly.subtotalCents + totals.yearly.subtotalCents,
    margin: totals.marginCents + 12 * totals.monthly.marginCents + totals.yearly.marginCents,
  };
  const counted = rows.filter((r) => !r.optional);
  const options = rows.filter((r) => r.optional);

  if (!rows.length)
    return (
      <section className="glass rounded-2xl border border-dashed px-6 py-10 text-center">
        <p className="font-semibold">{t("quotes.margins.empty")}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("quotes.margins.emptyText")}</p>
      </section>
    );

  const line = (r: MarginRow) => {
    const sold = lineAmount(r);
    const cost = Math.round((r.quantityX100 * (r.unitCostCents ?? 0)) / 100);
    const margin = sold - cost;
    const pct = pctOf(margin, sold);
    return (
      <tr key={r.key} className="border-b border-border/60 align-top">
        <td className="py-2 pr-3">
          <span className="font-medium">{r.name || "-"}</span>
          {(r.discountX100 ?? 0) > 0 && <span className="ml-2 text-xs text-muted-foreground">{t("quotes.margins.discount", { pct: String((r.discountX100 ?? 0) / 100).replace(".", ",") })}</span>}
          {!r.unitCostCents && <span className="ml-2 text-xs text-amber-300">{t("quotes.margins.noCost")}</span>}
        </td>
        <td className="py-2 text-right tabular-nums">{money(sold, lang)}</td>
        <td className="py-2 text-right tabular-nums text-muted-foreground">{money(cost, lang)}</td>
        <td className={cn("py-2 text-right font-semibold tabular-nums", tone(pct))}>{money(margin, lang)}</td>
        <td className={cn("py-2 pl-3 text-right tabular-nums", tone(pct))}>{fmtPct(pct)}</td>
      </tr>
    );
  };

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {parts
          .filter(({ k, part }) => k === "once" || part.subtotalCents > 0)
          .map(({ k, part }) => {
            const pct = pctOf(part.marginCents, part.subtotalCents);
            return (
              <div key={k} className="glass rounded-2xl border p-4">
                <p className="text-sm text-muted-foreground">{t(`quotes.recurrence.total.${k}`)}</p>
                <p className={cn("mt-1 text-2xl font-bold tabular-nums", tone(pct))}>
                  {money(part.marginCents, lang)}
                  {k !== "once" && <span className="text-sm font-normal text-muted-foreground"> {t(`quotes.recurrence.per.${k}`)}</span>}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">{t("quotes.margins.onSales", { pct: fmtPct(pct), amount: money(part.subtotalCents, lang) })}</p>
              </div>
            );
          })}
        <div className="glass rounded-2xl border border-[color:var(--gold)]/40 p-4">
          <p className="text-sm text-muted-foreground">{t("quotes.margins.firstYear")}</p>
          <p className={cn("mt-1 text-2xl font-bold tabular-nums", tone(pctOf(year.margin, year.sold)))}>{money(year.margin, lang)}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{t("quotes.margins.onSales", { pct: fmtPct(pctOf(year.margin, year.sold)), amount: money(year.sold, lang) })}</p>
        </div>
      </section>

      <section className="glass overflow-x-auto rounded-2xl border p-5">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">{t("quotes.margins.line")}</th>
              <th className="pb-2 text-right font-medium">{t("quotes.margins.sold")}</th>
              <th className="pb-2 text-right font-medium">{t("quotes.margins.cost")}</th>
              <th className="pb-2 text-right font-medium">{t("quotes.margins.margin")}</th>
              <th className="pb-2 pl-3 text-right font-medium">%</th>
            </tr>
          </thead>
          {QUOTE_RECURRENCES.map((k) => {
            const list = counted.filter((r) => recurrenceOf(r) === k);
            if (!list.length) return null;
            const part = k === "once" ? totals : totals[k];
            const pct = pctOf(part.marginCents, part.subtotalCents);
            return (
              <tbody key={k}>
                <tr>
                  <td colSpan={5} className="pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`quotes.recurrence.group.${k}`)}
                  </td>
                </tr>
                {list.map(line)}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">{t(`quotes.recurrence.total.${k}`)}</td>
                  <td className="py-2 text-right tabular-nums">{money(part.subtotalCents, lang)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{money(part.costCents, lang)}</td>
                  <td className={cn("py-2 text-right tabular-nums", tone(pct))}>{money(part.marginCents, lang)}</td>
                  <td className={cn("py-2 pl-3 text-right tabular-nums", tone(pct))}>{fmtPct(pct)}</td>
                </tr>
              </tbody>
            );
          })}
          {options.length > 0 && (
            <tbody className="opacity-70">
              <tr>
                <td colSpan={5} className="pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("quotes.margins.options")}
                </td>
              </tr>
              {options.map(line)}
            </tbody>
          )}
        </table>
        <p className="mt-3 text-xs text-muted-foreground">{t("quotes.margins.note")}</p>
      </section>
    </div>
  );
}
