import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * AKAB mark: hexagon + cursor with speed lines, gold gradient (after akab.ca).
 * Replace with the official SVG in /public when available.
 */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 64 48" className={cn("h-8 w-auto", className)} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe24a" />
          <stop offset="0.45" stopColor="#ffce1a" />
          <stop offset="1" stopColor="#f59410" />
        </linearGradient>
      </defs>
      <g stroke={`url(#g${id})`} strokeLinecap="round" fill="none">
        <path d="M3 17h11M1 24h13M5 31h9" strokeWidth="3" />
        <path d="M36 4 54 14.5v19L36 44 18 33.5v-19Z" strokeWidth="3.4" strokeLinejoin="round" />
      </g>
      <path
        d="M31 15.5 45 29l-6.4.9 3.8 7.6-3.2 1.6-3.8-7.7L31 35Z"
        fill={`url(#g${id})`}
        stroke="#0a0a0b"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 select-none", className)}>
      <LogoMark />
      {!compact && (
        <div className="leading-none">
          <div className="font-display text-[1.35rem] font-extrabold tracking-tight text-grad-gold">AKAB</div>
          <div className="font-display text-[0.52rem] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
            Informatique
          </div>
        </div>
      )}
    </div>
  );
}
