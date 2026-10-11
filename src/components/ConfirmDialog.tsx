import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * In-app confirmation (replaces window.confirm, which some browsers and
 * embedded views block silently — the action then never runs).
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: t("…"), destructive: true })) remove.mutate();
 */
type Options = { title: string; description?: string; confirmLabel?: string; destructive?: boolean };
type Pending = Options & { resolve: (ok: boolean) => void };

const ConfirmCtx = createContext<((o: Options) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);

  const confirm = useCallback(
    (o: Options) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        // Next tick: lets a menu that triggered it close first (focus / pointer-events)
        setTimeout(() => {
          const p = { ...o, resolve };
          current.current = p;
          setPending(p);
        }, 0);
      }),
    [],
  );

  const close = (ok: boolean) => {
    current.current?.resolve(ok);
    current.current = null;
    setPending(null);
  };

  const Icon = pending?.destructive ? AlertTriangle : HelpCircle;
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={Boolean(pending)} onOpenChange={(o) => !o && close(false)}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-start gap-3 text-base leading-snug">
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-xl",
                  pending?.destructive ? "bg-destructive/15 text-destructive" : "bg-[color:var(--gold)]/15 text-primary",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="pt-1.5">{pending?.title}</span>
            </DialogTitle>
            {pending?.description && <DialogDescription className="pl-12">{pending.description}</DialogDescription>}
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              autoFocus
              onClick={() => close(true)}
              className={cn(pending?.destructive ? "bg-destructive text-white hover:bg-destructive/90" : "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105")}
            >
              {pending?.confirmLabel ?? t("common.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error("useConfirm outside ConfirmProvider");
  return c;
}
