import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** The gold star on the Sales section header while opportunities wait to be taken (pulses gently, not with reduced motion). */
export function NewOppsStar({ count, collapsed }: { count: number; collapsed?: boolean }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <Star
      role="img"
      aria-label={t("sidebar.oppsNewStar", { count })}
      className={cn("size-3.5 shrink-0 fill-current text-[color:var(--gold)] motion-safe:animate-pulse", collapsed && "mx-auto mb-2")}
    >
      <title>{t("sidebar.oppsNewStar", { count })}</title>
    </Star>
  );
}

/** The number of new opportunities on an entry of the menu (a dot with the number when the menu is collapsed). */
export function OppsCount({ count, collapsed }: { count: number; collapsed: boolean }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  const label = t("sidebar.oppsNew", { count });
  if (collapsed) {
    return (
      <span aria-label={label} title={label} className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-grad-gold px-1 text-[10px] font-bold leading-4 text-black tabular-nums">
        {count}
      </span>
    );
  }
  return (
    <span aria-label={label} title={label} className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-grad-gold px-1.5 text-[11px] font-bold leading-5 text-black tabular-nums">
      {count}
    </span>
  );
}
