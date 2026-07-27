import { cn } from "@/lib/utils";

type BrandLogoProps = {
  /** Visual size preset */
  size?: "sm" | "md" | "lg" | "xl";
  /** Show wordmark text next to the mark */
  showWordmark?: boolean;
  /** Optional subtitle under the wordmark */
  subtitle?: string;
  className?: string;
  imgClassName?: string;
};

const sizeMap = {
  sm: "h-8 w-auto",
  md: "h-9 w-auto",
  lg: "h-12 w-auto",
  xl: "h-16 w-auto",
} as const;

/**
 * AKAB brand mark. Prefer the official logo asset over letter avatars.
 */
export function BrandLogo({
  size = "md",
  showWordmark = false,
  subtitle,
  className,
  imgClassName,
}: BrandLogoProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <img
        src="/akab-logo.png"
        alt="AKAB"
        className={cn(
          "shrink-0 object-contain select-none",
          sizeMap[size],
          imgClassName,
        )}
        draggable={false}
      />
      {showWordmark && (
        <div className="min-w-0">
          <p className="truncate text-sm font-bold tracking-tight text-sidebar-foreground">
            AKAB
          </p>
          {subtitle ? (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
