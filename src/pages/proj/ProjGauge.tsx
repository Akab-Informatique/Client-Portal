import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RADIUS = 34;
const CIRC = 2 * Math.PI * RADIUS;

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * Hours worked on the project against the hours sold, as a ring.
 * Violet, amber from 90 %, red over 100 %. Whoever can edit clicks the ring to set the sold hours.
 */
export function ProjGauge({ worked, sold, canEdit, onSaveSold }: { worked: number; sold: number | null; canEdit: boolean; onSaveSold: (hours: number | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const hasTarget = sold !== null && sold > 0;
  const pct = hasTarget ? (worked / sold) * 100 : null;
  const stroke = pct === null ? "#a78bfa" : pct >= 100 ? "#f87171" : pct >= 90 ? "#fbbf24" : "#a78bfa";
  const offset = CIRC * (1 - Math.min(pct ?? 0, 100) / 100);

  const ring = (
    <svg viewBox="0 0 84 84" className="size-20 -rotate-90" aria-hidden>
      <circle cx="42" cy="42" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="7" className="text-white/10" />
      {pct !== null && (
        <circle
          cx="42"
          cy="42"
          r={RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500"
        />
      )}
    </svg>
  );

  const center = (
    <span className="absolute inset-0 grid place-items-center text-sm font-semibold tabular-nums" style={{ color: pct === null ? undefined : stroke }}>
      {pct === null ? `${fmt(worked)} h` : `${Math.round(pct)} %`}
    </span>
  );

  const label = pct === null ? (sold !== null ? t("proj.gauge.noTarget") : t("proj.gauge.workedOnly", { hours: fmt(worked) })) : t("proj.gauge.ofSold", { worked: fmt(worked), sold: fmt(sold ?? 0) });

  const body = (
    <>
      <div className="relative grid size-20 shrink-0 place-items-center">
        {ring}
        {center}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.gauge.title")}</div>
        <div className="text-sm">{label}</div>
      </div>
    </>
  );

  const tileCls = "glass flex min-w-[12rem] items-center gap-3 rounded-2xl border border-violet-500/25 px-3 py-2 text-left";

  if (!canEdit) return <div className={tileCls}>{body}</div>;

  const save = () => {
    const v = draft.trim() === "" ? null : Number(draft.replace(",", "."));
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100000)) return;
    onSaveSold(v);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(sold !== null ? String(sold) : "");
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("proj.gauge.open")} title={t("proj.gauge.open")} className={cn(tileCls, "transition hover:bg-white/5")}>
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="start">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("proj.gauge.soldLabel")}</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            max={100000}
            step={0.25}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <span className="block text-[11px] text-muted-foreground">{t("proj.gauge.soldHint")}</span>
        </label>
        <div className="flex items-center justify-between gap-2">
          {sold !== null ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => { onSaveSold(null); setOpen(false); }}>
              {t("proj.gauge.clear")}
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" size="sm" onClick={save}>
            {t("proj.gauge.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
