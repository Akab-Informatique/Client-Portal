import { cn } from "@/lib/utils";

type AkabLoaderProps = {
  /** Visual size of the mark */
  size?: "sm" | "md" | "lg" | "xl";
  /** Optional caption under the logo */
  label?: string;
  /** Fill the viewport (auth/boot screens) */
  fullScreen?: boolean;
  /** Soft translucent overlay for in-app route changes */
  overlay?: boolean;
  className?: string;
};

const sizeClass = {
  sm: "h-10 w-10",
  md: "h-14 w-14",
  lg: "h-20 w-20",
  xl: "h-28 w-28",
} as const;

/**
 * Animated AKAB brand loader — speed-streak mark used for boot,
 * auth restore, and page-to-page navigation.
 */
export function AkabLoader({
  size = "lg",
  label,
  fullScreen = false,
  overlay = false,
  className,
}: AkabLoaderProps) {
  const body = (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className={cn(
          "akab-loader relative overflow-hidden rounded-2xl",
          sizeClass[size],
        )}
      >
        {/* Soft glow pulse behind the mark */}
        <div
          aria-hidden
          className="akab-loader-glow absolute inset-[-18%] rounded-full bg-primary/25"
        />
        <img
          src="/akab-loader.png"
          alt=""
          draggable={false}
          className="akab-loader-mark relative z-10 h-full w-full select-none rounded-2xl object-cover drop-shadow-[0_0_18px_rgba(245,197,24,0.35)]"
        />
      </div>
      {label ? (
        <p className="akab-loader-label text-sm font-medium text-muted-foreground">
          {label}
        </p>
      ) : (
        <span className="sr-only">Loading</span>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        {body}
      </div>
    );
  }

  if (overlay) {
    return (
      <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-background/55 backdrop-blur-[2px]">
        {body}
      </div>
    );
  }

  return body;
}
