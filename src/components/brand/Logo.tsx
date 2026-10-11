import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Official AKAB mark (traced from the brand icon, public/akab-icon.png):
 * gold speed bars, hexagon with two network nodes, gold cursor.
 * The hexagon and nodes use currentColor — white on dark, ink on light.
 */
export function LogoMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  const grad = `akab-g-${id}`;
  const clip = `akab-c-${id}`;
  const mask = `akab-m-${id}`;
  return (
    <svg
      viewBox="66 150 378 212"
      className={cn("h-8 w-auto text-[#16171b] dark:text-white", className)}
      role="img"
      aria-label="AKAB"
    >
      <defs>
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="0" y1="157" x2="0" y2="340">
          <stop offset="0" stopColor="#ffff02" />
          <stop offset="0.5" stopColor="#fbce0e" />
          <stop offset="1" stopColor="#f8a31a" />
        </linearGradient>
        {/* bars stop at a constant gap from the hexagon's left edges */}
        <clipPath id={clip}>
          <polygon points="0,100 277,100 192,248 277,400 0,400" />
        </clipPath>
        {/* hollow node rings: hide the hexagon lines inside them */}
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="white" />
          <circle cx="291" cy="342" r="9" fill="black" />
          <circle cx="420.5" cy="268" r="9.5" fill="black" />
        </mask>
      </defs>

      <g fill={`url(#${grad})`} clipPath={`url(#${clip})`}>
        <rect x="125" y="158" width="69" height="20" rx="10" />
        <rect x="207" y="158" width="60" height="20" rx="10" />
        <rect x="125" y="197" width="130" height="20" rx="10" />
        <rect x="101" y="239" width="61" height="20" rx="10" />
        <rect x="175" y="239" width="60" height="20" rx="10" />
        <rect x="147" y="279" width="110" height="20" rx="10" />
        <rect x="72" y="318" width="122" height="21" rx="10.5" />
        <rect x="207" y="318" width="60" height="21" rx="10.5" />
      </g>

      <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="miter" mask={`url(#${mask})`}>
        <polyline points="272,342 216.5,248.4 268,160 379,160 433,255" />
        <polyline points="420.5,268 375,345 291,345" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="7">
        <circle cx="291" cy="342" r="12.5" />
        <circle cx="420.5" cy="268" r="13" />
      </g>

      <polygon
        points="296,198 398,278 354,283 368,306 352,316 338,291 313,331"
        fill={`url(#${grad})`}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5 select-none", className)}>
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
