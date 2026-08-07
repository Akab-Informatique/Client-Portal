import { ScreenShare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

/**
 * Opens Datto Web Remote in a new tab.
 * Real <a target="_blank"> only — never replaces the portal page.
 * Staff (admin/tech) always get this on Operations → Devices when a URL is present.
 * Client users only receive a URL for devices they were explicitly granted.
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
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ScreenShare className="size-3.5" />
        <span className="hidden sm:inline">{t("devices.webRemote")}</span>
      </a>
    </Button>
  );
}
