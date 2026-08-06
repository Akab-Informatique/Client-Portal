import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Headphones,
  Loader2,
  Siren,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  createSosRequest,
  ensureClientPortalHref,
  fetchClientSosRequests,
  navigatePendingSosWindow,
  openClientPortalLink,
  openPendingSosWindow,
  type SosRequest,
} from "@/lib/sos";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Client header SOS control — creates a Splashtop attended session and
 * opens the support portal link so the end user can run the SOS applet.
 */
export function SosButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SosRequest | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [copied, setCopied] = useState(false);
  const [openHint, setOpenHint] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id) return;
      try {
        await dbReady;
        const rows = await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, user.company_id))
          .limit(1);
        if (!cancelled && rows[0]) setCompanyName(String(rows[0].name ?? ""));
      } catch {
        /* optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.company_id]);

  const refreshActive = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await fetchClientSosRequests(user.id);
      const first = res.requests[0] ?? null;
      setActive(first);
    } catch {
      /* ignore */
    }
  }, [user?.id]);

  useEffect(() => {
    if (!open) return;
    void refreshActive();
    const tmr = window.setInterval(() => void refreshActive(), 8000);
    return () => window.clearInterval(tmr);
  }, [open, refreshActive]);

  const portalHref = useMemo(
    () => ensureClientPortalHref(active?.supportPortalLink),
    [active?.supportPortalLink],
  );

  if (!user || user.role !== "client") return null;

  const openPortal = (href: string | null | undefined) => {
    const url = ensureClientPortalHref(href);
    if (!url) {
      setError(t("sos.noLink"));
      return false;
    }
    const ok = openClientPortalLink(url);
    setOpenHint(true);
    if (!ok) {
      setError(t("sos.openBlocked"));
    }
    return ok;
  };

  const copyPortal = async () => {
    if (!portalHref) return;
    try {
      await navigator.clipboard.writeText(portalHref);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for restricted clipboard
      try {
        const ta = document.createElement("textarea");
        ta.value = portalHref;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        setError(t("sos.copyFailed"));
      }
    }
  };

  const startSos = async () => {
    if (!user.company_id) {
      setError(t("sos.noCompany"));
      return;
    }
    setBusy(true);
    setError(null);
    setOpenHint(false);

    // Open the tab NOW (still inside the click gesture) so the browser allows
    // navigation after the async API call. That tab loads the session page,
    // which auto-starts the SOS download for this support session.
    let pending: Window | null = null;
    const reuseExisting =
      active &&
      portalHref &&
      ["open", "waiting", "ready", "connected"].includes(String(active.status));

    if (reuseExisting) {
      openPortal(portalHref);
      setBusy(false);
      return;
    }

    pending = openPendingSosWindow();

    try {
      const res = await createSosRequest({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        companyId: user.company_id,
        companyName: companyName || t("common.company"),
        issue: issue.trim() || null,
      });
      if (res.request) {
        setActive(res.request);
        const href = ensureClientPortalHref(res.request.supportPortalLink);
        if (href) {
          const ok = navigatePendingSosWindow(pending, href);
          pending = null;
          setOpenHint(true);
          if (!ok) setError(t("sos.openBlocked"));
        } else {
          try {
            pending?.close();
          } catch {
            /* ignore */
          }
          pending = null;
          if (!res.error) setError(t("sos.noLink"));
        }
      } else {
        try {
          pending?.close();
        } catch {
          /* ignore */
        }
        pending = null;
      }
      if (res.error && !res.request?.supportPortalLink) {
        setError(res.error);
      } else if (res.error) {
        // Soft warning — request exists
        setError(res.error);
      }
    } catch (e) {
      try {
        pending?.close();
      } catch {
        /* ignore */
      }
      setError(e instanceof Error ? e.message : t("sos.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (s: string) => {
    const key = `sos.status_${s}` as const;
    const translated = t(key);
    return translated === key ? s : translated;
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        className={cn(
          "gap-1.5 bg-red-600 font-bold tracking-wide text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500",
          className,
        )}
        onClick={() => {
          setError(null);
          setOpenHint(false);
          setOpen(true);
        }}
        title={t("sos.buttonTitle")}
      >
        <Siren className="size-3.5" />
        SOS
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Headphones className="size-5 text-red-600" />
              {t("sos.dialogTitle")}
            </DialogTitle>
            <DialogDescription>{t("sos.dialogDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {active && (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t("sos.activeRequest")}</span>
                  <Badge variant="outline">{statusLabel(String(active.status))}</Badge>
                </div>
                {portalHref ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("sos.downloadStarted")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 gap-1.5 bg-red-600 text-white hover:bg-red-700"
                        onClick={() => openPortal(portalHref)}
                      >
                        <ExternalLink className="size-3.5" />
                        {t("sos.openClientLink")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5"
                        onClick={() => void copyPortal()}
                      >
                        {copied ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        {copied ? t("sos.copied") : t("sos.copyLink")}
                      </Button>
                    </div>
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      {portalHref}
                    </p>
                    {openHint && (
                      <p className="text-xs text-muted-foreground">
                        {t("sos.openHint")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("sos.waitingLink")}
                  </p>
                )}
                {active.errorMessage && (
                  <p className="mt-1 text-xs text-destructive">
                    {active.errorMessage}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="sos-issue">{t("sos.issueLabel")}</Label>
              <Textarea
                id="sos-issue"
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
                placeholder={t("sos.issuePlaceholder")}
                rows={3}
                disabled={busy}
              />
            </div>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>{t("sos.step1")}</li>
              <li>{t("sos.step2")}</li>
              <li>{t("sos.step3")}</li>
            </ol>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {t("common.close")}
            </Button>
            <Button
              type="button"
              className="gap-1.5 bg-red-600 text-white hover:bg-red-700"
              disabled={busy}
              onClick={() => void startSos()}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Siren className="size-4" />
              )}
              {portalHref ? t("sos.openOrReuse") : t("sos.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
