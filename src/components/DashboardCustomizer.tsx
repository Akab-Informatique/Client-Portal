import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  LayoutGrid,
  RotateCcw,
  Settings2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";
import type { DashboardDensity, StatsColumns } from "@/lib/dashboard-layout";

export interface DashboardWidgetMeta {
  id: string;
  label: string;
  description?: string;
}

interface DashboardCustomizerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widgets: DashboardWidgetMeta[];
  order: string[];
  hidden: string[];
  density: DashboardDensity;
  statsColumns: StatsColumns;
  onMove: (id: string, dir: -1 | 1) => void;
  onToggle: (id: string) => void;
  onDensity: (d: DashboardDensity) => void;
  onStatsColumns: (n: StatsColumns) => void;
  onReset: () => void;
  className?: string;
  /** Override panel title (e.g. admin company default editor). */
  title?: string;
  /** Override panel description. */
  description?: string;
  /** Override auto-save hint under the widget list. */
  autoSaveHint?: string;
  /** Override reset button label. */
  resetLabel?: string;
  /** Hide the close (X) button — useful inside a dialog with its own close. */
  hideClose?: boolean;
  /** Optional extra actions rendered next to Reset (e.g. Save for company). */
  footerActions?: ReactNode;
}

export function DashboardCustomizeButton({
  active,
  onClick,
  className,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useLocale();
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      className={cn("gap-2", className)}
    >
      <Settings2 className="size-4" />
      <span className="hidden sm:inline">
        {active ? t("dash.doneCustomize") : t("dash.customize")}
      </span>
      <span className="sm:hidden">
        {active ? t("common.close") : t("dash.customizeShort")}
      </span>
    </Button>
  );
}

export function DashboardCustomizer({
  open,
  onOpenChange,
  widgets,
  order,
  hidden,
  density,
  statsColumns,
  onMove,
  onToggle,
  onDensity,
  onStatsColumns,
  onReset,
  className,
  title,
  description,
  autoSaveHint,
  resetLabel,
  hideClose,
  footerActions,
}: DashboardCustomizerProps) {
  const { t } = useLocale();
  const [savedFlash, setSavedFlash] = useState(false);

  if (!open) return null;

  const meta = new Map(widgets.map((w) => [w.id, w]));

  return (
    <Card
      className={cn(
        "border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm",
        className,
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutGrid className="size-4 text-primary" />
            {title ?? t("dash.customizeTitle")}
          </CardTitle>
          <CardDescription className="mt-1">
            {description ?? t("dash.customizeDesc")}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {savedFlash && (
            <Badge
              variant="outline"
              className="border-primary/40 bg-primary/10 text-primary gap-1"
            >
              <Check className="size-3" />
              {t("dash.saved")}
            </Badge>
          )}
          {!hideClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onOpenChange(false)}
              aria-label={t("common.close")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("dash.density")}
            </Label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["comfortable", t("dash.comfortable")],
                  ["compact", t("dash.compact")],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={density === value ? "default" : "outline"}
                  onClick={() => {
                    onDensity(value);
                    flash(setSavedFlash);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("dash.statsColumns")}
            </Label>
            <div className="flex flex-wrap gap-2">
              {([2, 4] as const).map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={statsColumns === n ? "default" : "outline"}
                  onClick={() => {
                    onStatsColumns(n);
                    flash(setSavedFlash);
                  }}
                >
                  {n === 2 ? t("dash.cols2") : t("dash.cols4")}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            {t("dash.widgets")}
          </Label>
          <ul className="space-y-2">
            {order.map((id, index) => {
              const w = meta.get(id);
              if (!w) return null;
              const visible = !hidden.includes(id);
              return (
                <li
                  key={id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2.5",
                    !visible && "opacity-60",
                  )}
                >
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={index === 0}
                      onClick={() => {
                        onMove(id, -1);
                        flash(setSavedFlash);
                      }}
                      aria-label={t("dash.moveUp")}
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={index === order.length - 1}
                      onClick={() => {
                        onMove(id, 1);
                        flash(setSavedFlash);
                      }}
                      aria-label={t("dash.moveDown")}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{w.label}</p>
                    {w.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {w.description}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => {
                      onToggle(id);
                      flash(setSavedFlash);
                    }}
                  >
                    {visible ? (
                      <>
                        <Eye className="size-3.5" />
                        <span className="hidden sm:inline">{t("dash.visible")}</span>
                      </>
                    ) : (
                      <>
                        <EyeOff className="size-3.5" />
                        <span className="hidden sm:inline">{t("dash.hidden")}</span>
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {autoSaveHint ?? t("dash.autoSave")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => {
                onReset();
                flash(setSavedFlash);
              }}
            >
              <RotateCcw className="size-3.5" />
              {resetLabel ?? t("dash.reset")}
            </Button>
            {footerActions}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function flash(set: (v: boolean) => void) {
  set(true);
  window.setTimeout(() => set(false), 1200);
}

/** Wrapper that shows drag handles / dim when customizing */
export function DashboardWidgetFrame({
  editing,
  visible,
  label,
  children,
  onMoveUp,
  onMoveDown,
  onToggle,
  canUp,
  canDown,
  className,
}: {
  editing: boolean;
  visible: boolean;
  label: string;
  children: React.ReactNode;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onToggle?: () => void;
  canUp?: boolean;
  canDown?: boolean;
  className?: string;
}) {
  const { t } = useLocale();

  if (!editing && !visible) return null;

  return (
    <div
      className={cn(
        "relative",
        editing && "rounded-xl ring-2 ring-primary/25 ring-offset-2 ring-offset-background",
        editing && !visible && "opacity-50",
        className,
      )}
    >
      {editing && (
        <div className="absolute -top-3 left-3 z-10 flex items-center gap-1.5">
          <Badge className="bg-primary text-primary-foreground shadow-sm hover:bg-primary">
            {label}
          </Badge>
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!canUp}
              onClick={onMoveUp}
              aria-label={t("dash.moveUp")}
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!canDown}
              onClick={onMoveDown}
              aria-label={t("dash.moveDown")}
            >
              <ChevronDown className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onToggle}
              aria-label={visible ? t("dash.hide") : t("dash.show")}
            >
              {visible ? (
                <Eye className="size-3.5" />
              ) : (
                <EyeOff className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      )}
      <div className={cn(editing && "pt-2", !visible && editing && "pointer-events-none")}>
        {children}
      </div>
    </div>
  );
}
