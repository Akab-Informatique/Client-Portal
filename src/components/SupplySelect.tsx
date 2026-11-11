import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Where the goods of a charge stand: not ordered yet (none), ordered, or received at the office. */
export const SUPPLY_STATES = ["ordered", "received"] as const;
export type Supply = (typeof SUPPLY_STATES)[number];
const STYLE: Record<string, string> = { ordered: "border-amber-400/50 bg-amber-500/10 text-amber-300", received: "border-emerald-400/50 bg-emerald-500/10 text-emerald-300" };

export function SupplySelect({ value, onChange, disabled, className }: { value: string | null | undefined; onChange: (v: Supply | null) => void; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      aria-label={t("supply.label")}
      title={t("supply.label")}
      onChange={(e) => onChange((e.target.value || null) as Supply | null)}
      onClick={(e) => e.stopPropagation()}
      className={cn("h-6 shrink-0 rounded-full border bg-transparent px-1.5 text-[10px] disabled:opacity-70", value ? STYLE[value] : "border-border text-muted-foreground", className)}
    >
      <option value="">{t("supply.none")}</option>
      {SUPPLY_STATES.map((s) => (
        <option key={s} value={s}>
          {t(`supply.${s}`)}
        </option>
      ))}
    </select>
  );
}
