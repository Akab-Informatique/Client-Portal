import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A text that is saved when you leave it (Enter too), not at every key */
export function Text({ value, onSave, multiline, className, ...rest }: { value: string; onSave: (v: string) => void; multiline?: boolean; className?: string; placeholder?: string; maxLength?: number; "aria-label"?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onSave(v.trim());
  return multiline ? (
    <Textarea value={v} rows={4} className={className} onChange={(e) => setV(e.target.value)} onBlur={commit} {...rest} />
  ) : (
    <Input
      value={v}
      className={className}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
      {...rest}
    />
  );
}

export const Card = ({ title, children, className, action }: { title: string; children: ReactNode; className?: string; action?: ReactNode }) => (
  <section className={cn("rounded-2xl border bg-card/40 p-4", className)}>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);

export function Bar({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-2 overflow-hidden rounded-full bg-foreground/10">
      <span className={cn("block h-full rounded-full", over ? "bg-red-500" : "bg-grad-gold")} style={{ width: `${pct}%` }} />
    </span>
  );
}

export type GaugeTone = "ok" | "warn" | "bad" | "idle";
const TONE_STROKE: Record<GaugeTone, string> = { ok: "stroke-emerald-400", warn: "stroke-amber-300", bad: "stroke-red-500", idle: "stroke-muted-foreground/40" };

/** A ring that fills to `pct` (0–100, more than 100 stays full): the figure inside, a label and a line under it */
export function Gauge({ pct, tone, big, label, sub }: { pct: number | null; tone: GaugeTone; big: string; label: string; sub?: string }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const shown = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <div className="relative size-32">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-foreground/10" />
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100} className={cn("transition-all", TONE_STROKE[tone])} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-xl font-semibold">{big}</span>
      </div>
      <p className="text-sm font-medium">{label}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
