import type { ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Client portal page title: small section label, title, one line of help, actions on the right. */
export function PageHeader({ icon: Icon, eyebrow, title, subtitle, actions }: { icon: LucideIcon; eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="pane gold-edge flex size-12 shrink-0 items-center justify-center rounded-2xl text-primary">
          <Icon className="size-[22px]" />
        </span>
        <div className="min-w-0">
          {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/80">{eyebrow}</p>}
          <h1 className="truncate text-2xl font-bold sm:text-[1.7rem]">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions}
    </header>
  );
}

/** Glass pane. */
export function Pane({ className, edge, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { edge?: boolean }) {
  return (
    <div className={cn("pane rounded-2xl", edge && "gold-edge", className)} {...rest}>
      {children}
    </div>
  );
}

/** Glass segmented control; the selected option slides under a soft gold light. */
export function Segmented<T extends string>({ id, value, options, onChange, className }: { id: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn("flex rounded-xl border border-[color:var(--glass-border)] bg-background/30 p-1", className)} role="group">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn("relative flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors sm:flex-none", on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-lg border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/12 shadow-[0_0_18px_-8px_var(--gold)]"
                transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
              />
            )}
            <span className="relative flex items-center gap-2">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
