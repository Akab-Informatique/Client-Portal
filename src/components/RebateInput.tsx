import { useTranslation } from "react-i18next";
import { BadgePercent } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const fmt = (n: number, lang: string) => new Intl.NumberFormat(lang === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);
const parse = (s: string) => (s.trim() === "" ? null : Number(s.replace(/\s/g, "").replace(",", ".")));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The percent typed (0–100) or null when it is empty / not a number */
export const percentOf = (s: string) => {
  const n = parse(s);
  return n === null || !Number.isFinite(n) ? 0 : Math.max(0, Math.min(100, n));
};
/** A price after a rebate in percent, in dollars */
export const afterRebate = (regular: number, percent: number) => round2(regular * (1 - percent / 100));

/**
 * A rebate (rabais) on a price: the regular price stays what it is; the rebate is typed as a percentage or as the price after
 * it (each fills the other). When one is applied, it is shown: the regular price, the rebate and what is charged.
 */
export function RebateInput({ regular, percent, onPercent, unit, className, id }: { regular: number | null; percent: string; onPercent: (v: string) => void; unit?: string; className?: string; id?: string }) {
  const { t, i18n } = useTranslation();
  const pct = percentOf(percent);
  const final = regular != null ? afterRebate(regular, pct) : null;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={id}>{t("rebate.percent")}</Label>
          <Input id={id} inputMode="decimal" value={percent} placeholder="0" onChange={(e) => onPercent(e.target.value)} className="text-right font-mono" />
        </div>
        <div className="space-y-1.5">
          <Label>{t("rebate.final")}</Label>
          <Input
            inputMode="decimal"
            disabled={regular === null || regular <= 0}
            value={final === null ? "" : String(final)}
            onChange={(e) => {
              const v = parse(e.target.value);
              if (regular && regular > 0 && v !== null && Number.isFinite(v) && v >= 0 && v <= regular) onPercent(String(round2(((regular - v) / regular) * 100)));
            }}
            className="text-right font-mono"
          />
        </div>
      </div>
      {pct > 0 && regular != null && (
        <p className="flex flex-wrap items-center gap-x-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
          <BadgePercent className="size-3.5" />
          <span className="font-semibold">{t("rebate.applied", { pct: pct.toLocaleString(i18n.language, { maximumFractionDigits: 2 }) })}</span>
          <span className="text-muted-foreground line-through">{fmt(regular, i18n.language)}</span>
          <span className="font-mono font-semibold">
            {fmt(final ?? 0, i18n.language)}
            {unit ? ` ${unit}` : ""}
          </span>
        </p>
      )}
    </div>
  );
}
