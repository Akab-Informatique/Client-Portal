import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** The size picked in the address (10 when none or not one of the choices). */
export const pageSizeOf = (v: string | null) => (PAGE_SIZES as readonly number[]).includes(Number(v)) ? Number(v) : 10;

/**
 * The foot of a long list: which rows are shown, a choice of how many per page (10, 25, 50, 100) and the previous / next
 * page. `page` starts at 1.
 */
export function Pager({ total, page, size, onPage, onSize }: { total: number; page: number; size: number; onPage: (page: number) => void; onSize: (size: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(page, pages);
  const from = total === 0 ? 0 : (at - 1) * size + 1;
  const to = Math.min(total, at * size);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground">
      <span>{t("pager.range", { from, to, total })}</span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          {t("pager.perPage")}
          <select
            value={size}
            onChange={(e) => onSize(Number(e.target.value))}
            aria-label={t("pager.perPage")}
            className="h-8 rounded-md border bg-transparent px-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1">
          <Button type="button" size="icon" variant="outline" className="size-8" disabled={at <= 1} onClick={() => onPage(at - 1)} aria-label={t("pager.previous")}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-20 text-center">{t("pager.page", { page: at, pages })}</span>
          <Button type="button" size="icon" variant="outline" className="size-8" disabled={at >= pages} onClick={() => onPage(at + 1)} aria-label={t("pager.next")}>
            <ChevronRight className="size-4" />
          </Button>
        </span>
      </div>
    </div>
  );
}
