import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled block of the opportunity window. */
export function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("glass space-y-2 rounded-xl border p-4", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
