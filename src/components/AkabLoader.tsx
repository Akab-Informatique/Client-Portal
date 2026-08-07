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

const stageClass = {
  sm: "h-28 w-40",
  md: "h-36 w-52",
  lg: "h-44 w-64",
  xl: "h-56 w-80",
} as const;

/**
 * Animated AKAB brand loader — logo buzzes like a bee with a glowing trail.
 * Used for boot, auth restore, and page-to-page navigation.
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
        "flex flex-col items-center justify-center gap-5",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* Flight stage — logo buzzes around inside this area */}
      <div
        className={cn(
          "akab-bee-stage relative",
          stageClass[size],
        )}
      >
        {/* Soft ambient glow under the flight path */}
        <div
          aria-hidden
          className="akab-bee-ambient pointer-events-none absolute inset-[12%] rounded-full bg-primary/15 blur-2xl"
        />

        {/* Bee trail ghost marks (lagged copies) */}
        <div
          aria-hidden
          className={cn(
            "akab-bee-trail akab-bee-trail-3 absolute left-1/2 top-1/2",
            sizeClass[size],
          )}
        >
          <img
            src="/akab-loader.png"
            alt=""
            draggable={false}
            className="h-full w-full select-none rounded-2xl object-cover opacity-25"
          />
        </div>
        <div
          aria-hidden
          className={cn(
            "akab-bee-trail akab-bee-trail-2 absolute left-1/2 top-1/2",
            sizeClass[size],
          )}
        >
          <img
            src="/akab-loader.png"
            alt=""
            draggable={false}
            className="h-full w-full select-none rounded-2xl object-cover opacity-40"
          />
        </div>
        <div
          aria-hidden
          className={cn(
            "akab-bee-trail akab-bee-trail-1 absolute left-1/2 top-1/2",
            sizeClass[size],
          )}
        >
          <img
            src="/akab-loader.png"
            alt=""
            draggable={false}
            className="h-full w-full select-none rounded-2xl object-cover opacity-55"
          />
        </div>

        {/* Motion streaks behind the bee */}
        <div
          aria-hidden
          className="akab-bee-streaks pointer-events-none absolute left-1/2 top-1/2"
        >
          <span className="akab-bee-streak akab-bee-streak-a" />
          <span className="akab-bee-streak akab-bee-streak-b" />
          <span className="akab-bee-streak akab-bee-streak-c" />
        </div>

        {/* Main flying logo */}
        <div
          className={cn(
            "akab-bee absolute left-1/2 top-1/2 z-10",
            sizeClass[size],
          )}
        >
          <div className="akab-bee-wiggle h-full w-full">
            <img
              src="/akab-loader.png"
              alt=""
              draggable={false}
              className="akab-bee-mark h-full w-full select-none rounded-2xl object-cover drop-shadow-[0_0_16px_rgba(245,197,24,0.45)]"
            />
          </div>
        </div>
      </div>

      {label ? (
        <p className="akab-bee-label text-sm font-medium text-muted-foreground">
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
