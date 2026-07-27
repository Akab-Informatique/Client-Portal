import { useState } from "react";
import { Bell, BellOff, BellRing, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  clearNotifyOptOut,
  notificationsSupported,
  requestNotifyPermission,
  setNotifyOptOut,
  type NotifyPreference,
} from "@/lib/notifications";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

interface NotificationBannerProps {
  permission: NotifyPreference;
  onPermissionChange: () => void;
  className?: string;
  compact?: boolean;
}

export function NotificationBanner({
  permission,
  onPermissionChange,
  className,
  compact = false,
}: NotificationBannerProps) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (permission === "unsupported") {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm",
          className,
        )}
      >
        <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">{t("notify.unsupported")}</p>
      </div>
    );
  }

  if (permission === "granted") {
    if (compact) {
      return (
        <div
          className={cn(
            "inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary",
            className,
          )}
        >
          <BellRing className="size-3.5" />
          {t("notify.onCompact")}
        </div>
      );
    }
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <BellRing className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-semibold">{t("notify.enabled")}</p>
            <p className="text-xs text-muted-foreground">
              {t("notify.enabledDesc")}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setNotifyOptOut();
            onPermissionChange();
          }}
        >
          <BellOff className="size-3.5" />
          {t("notify.mute")}
        </Button>
      </div>
    );
  }

  if (permission === "denied" || dismissed) {
    if (compact) return null;
    const browserBlocked =
      notificationsSupported() && Notification.permission === "denied";
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold">{t("notify.off")}</p>
            <p className="text-xs text-muted-foreground">
              {browserBlocked ? t("notify.blocked") : t("notify.turnOnHint")}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          disabled={busy || browserBlocked}
          onClick={async () => {
            setBusy(true);
            clearNotifyOptOut();
            if (
              notificationsSupported() &&
              Notification.permission === "granted"
            ) {
              onPermissionChange();
            } else {
              await requestNotifyPermission();
              onPermissionChange();
            }
            setBusy(false);
            setDismissed(false);
          }}
        >
          <Bell className="size-3.5" />
          {t("notify.turnOn")}
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-gradient-to-r from-primary/15 to-card px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start gap-3 pr-6">
        <Bell className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold">{t("notify.promptTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("notify.promptDesc")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setNotifyOptOut();
            setDismissed(true);
            onPermissionChange();
          }}
        >
          {t("notify.notNow")}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await requestNotifyPermission();
            onPermissionChange();
            setBusy(false);
          }}
        >
          <BellRing className="size-3.5" />
          {t("notify.enable")}
        </Button>
      </div>
      <button
        type="button"
        aria-label={t("notify.dismiss")}
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
