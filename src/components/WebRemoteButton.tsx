import { ScreenShare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openDattoWebRemote } from "@/lib/datto-rmm";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

/**
 * Opens Datto Web Remote in a new tab.
 * Prefer a real <a> so middle-click / open-in-new-tab work and popup blockers are kinder.
 */
export function WebRemoteButton({
  url,
  online,
  disabled,
  className,
  size = "sm",
}: {
  url: string | null | undefined;
  online?: boolean | null;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
}) {
  const { t } = useLocale();
  const href = String(url ?? "").trim();
  const can = Boolean(href) && !disabled;

  if (!can) {
    return (
      <Button
        type="button"
        size={size}
        variant="outline"
        className={cn("h-8 gap-1.5", className)}
        disabled
        title={t("devices.webRemoteUnavailable")}
      >
        <ScreenShare className="size-3.5" />
        <span className="hidden sm:inline">{t("devices.webRemote")}</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size={size}
      variant={online ? "default" : "outline"}
      className={cn("h-8 gap-1.5", className)}
      title={t("devices.webRemoteHint")}
      asChild
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          // Keep a JS fallback if the browser blocks the default navigation
          // inside nested layouts / sandboxes.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
            return;
          }
          e.preventDefault();
          if (!openDattoWebRemote(href)) {
            // Last resort: navigate current tab
            window.location.assign(href);
          }
        }}
      >
        <ScreenShare className="size-3.5" />
        <span className="hidden sm:inline">{t("devices.webRemote")}</span>
      </a>
    </Button>
  );
}
