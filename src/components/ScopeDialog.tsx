import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A question with two ways to go on, asked before a price change reaches further than the one place it was typed:
 * "everywhere" (the other running contracts / the service too) or "only here". Cancel leaves everything as it was.
 */
export function ScopeDialog({
  title,
  description,
  wideLabel,
  narrowLabel,
  busy,
  onWide,
  onNarrow,
  onCancel,
}: {
  title: string;
  description: string;
  wideLabel: string;
  narrowLabel: string;
  busy?: boolean;
  onWide: () => void;
  onNarrow: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-start gap-3 text-base leading-snug">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/15 text-primary">
              <HelpCircle className="size-4" />
            </span>
            <span className="pt-1.5">{title}</span>
          </DialogTitle>
          <DialogDescription className="pl-12">{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-2">
          <Button disabled={busy} onClick={onWide} className="h-auto justify-start whitespace-normal bg-grad-gold py-2.5 text-left font-semibold text-[#1a1204] hover:brightness-105">
            {wideLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={onNarrow} className="h-auto justify-start whitespace-normal py-2.5 text-left">
            {narrowLabel}
          </Button>
          <Button disabled={busy} variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
