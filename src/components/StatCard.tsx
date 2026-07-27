import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: number;
  icon: ReactNode;
  hint?: string;
  className?: string;
}

export function StatCard({ label, value, icon, hint, className }: StatCardProps) {
  return (
    <Card className={cn("overflow-hidden border-border/80", className)}>
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
            <NumberTicker value={value} />
          </div>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}
