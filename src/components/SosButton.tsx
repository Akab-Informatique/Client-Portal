import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
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
  fetchClientSosRequests,
  fetchSosInstallerDownload,
  fetchSosRequestById,
  triggerSosDownload,
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

type Phase = "form" | "starting" | "waiting";

/**
 * Client SOS control.
 * Start SOS → create session → auto-download Win/Mac installer → waiting popup.
 * No separate download page; user can close the popup and keep using the portal.
 */
export function SosButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SosRequest | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);

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
      if (active?.id) {
        const one = await fetchSosRequestById(active.id, "client");
        if (one.request) {
          setActive(one.request);
          return;
        }
      }
      const res = await fetchClientSosRequests(user.id);
      setActive(res.requests[0] ?? null);
    } catch {
      /* ignore */
    }
  }, [active?.id, user?.id]);

  // Poll status while waiting popup is open
  useEffect(() => {
    if (!open || phase !== "waiting" || !active?.id) return;
    void refreshActive();
    const tmr = window.setInterval(() => void refreshActive(), 8000);
    return () => window.clearInterval(tmr);
  }, [open, phase, active?.id, refreshActive]);

  if (!user || user.role !== "client") return null;

  const statusLabel = (s: string) => {
    const key = `sos.status_${s}` as const;
    const translated = t(key);
    return translated === key ? s : translated;
  };

  const resetForm = () => {
    setPhase("form");
    setError(null);
    setDownloading(false);
    setDownloadStarted(false);
    setFileName(null);
    setBusy(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Closing is always allowed — user returns to the app
      resetForm();
    } else {
      setError(null);
      setPhase("form");
      void (async () => {
        if (!user.id) return;
        try {
          const res = await fetchClientSosRequests(user.id);
          const first = res.requests[0] ?? null;
          setActive(first);
          // If they already have an open session, jump straight to waiting
          if (
            first &&
            ["open", "waiting", "ready", "connected"].includes(
              String(first.status),
            )
          ) {
            setPhase("waiting");
          }
        } catch {
          /* ignore */
        }
      })();
    }
  };

  const startInstallerDownload = async (requestId: number) => {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetchSosInstallerDownload(requestId, "auto");
      if (!res.ok || !res.downloadUrl) {
        setError(res.error || t("sos.noLink"));
        setDownloadStarted(false);
        return false;
      }
      setFileName(res.fileName);
      // Same-origin file proxy → browser saves .exe/.dmg; never opens Splashtop HTML
      const ok = await triggerSosDownload(res.downloadUrl, res.fileName);
      setDownloadStarted(ok);
      if (!ok) setError(t("sos.openBlocked"));
      return ok;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sos.createFailed"));
      setDownloadStarted(false);
      return false;
    } finally {
      setDownloading(false);
    }
  };

  const startSos = async () => {
    if (!user.company_id) {
      setError(t("sos.noCompany"));
      return;
    }
    setBusy(true);
    setError(null);
    setPhase("starting");
    setDownloadStarted(false);
    setFileName(null);

    try {
      // Reuse open session if still active
      if (
        active &&
        ["open", "waiting", "ready", "connected"].includes(String(active.status))
      ) {
        setPhase("waiting");
        await startInstallerDownload(active.id);
        return;
      }

      const res = await createSosRequest({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        companyId: user.company_id,
        companyName: companyName || t("common.company"),
        issue: issue.trim() || null,
      });

      if (!res.request) {
        setError(res.error || t("sos.createFailed"));
        setPhase("form");
        return;
      }

      setActive(res.request);
      setPhase("waiting");
      if (res.error) setError(res.error);
      await startInstallerDownload(res.request.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sos.createFailed"));
      setPhase("form");
    } finally {
      setBusy(false);
    }
  };

  const isWaiting = phase === "waiting" || phase === "starting";
  const connected =
    active && ["ready", "connected"].includes(String(active.status));

  return (
    <>
      <Button
        type="button"
        size="sm"
        className={cn(
          "gap-1.5 bg-red-600 font-bold tracking-wide text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500",
          className,
        )}
        onClick={() => handleOpenChange(true)}
        title={t("sos.buttonTitle")}
      >
        <Siren className="size-3.5" />
        SOS
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md sm:max-w-lg">
          {!isWaiting ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Headphones className="size-5 text-red-600" />
                  {t("sos.dialogTitle")}
                </DialogTitle>
                <DialogDescription>{t("sos.dialogDesc")}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {active &&
                  ["open", "waiting", "ready", "connected"].includes(
                    String(active.status),
                  ) && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {t("sos.activeRequest")}
                        </span>
                        <Badge variant="outline">
                          {statusLabel(String(active.status))}
                        </Badge>
                      </div>
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
                  onClick={() => handleOpenChange(false)}
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
                  {active &&
                  ["open", "waiting", "ready", "connected"].includes(
                    String(active.status),
                  )
                    ? t("sos.openOrReuse")
                    : t("sos.start")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {connected ? (
                    <CheckCircle2 className="size-5 text-emerald-600" />
                  ) : (
                    <Headphones className="size-5 text-red-600" />
                  )}
                  {connected
                    ? t("sos.waitingConnectedTitle")
                    : t("sos.waitingTitle")}
                </DialogTitle>
                <DialogDescription>
                  {connected
                    ? t("sos.waitingConnectedDesc")
                    : t("sos.waitingDesc")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-6 text-center">
                  {phase === "starting" || downloading ? (
                    <Loader2 className="size-10 animate-spin text-red-600" />
                  ) : connected ? (
                    <CheckCircle2 className="size-10 text-emerald-600" />
                  ) : (
                    <span className="relative flex size-10">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400/40" />
                      <span className="relative inline-flex size-10 items-center justify-center rounded-full bg-red-600 text-white">
                        <Siren className="size-5" />
                      </span>
                    </span>
                  )}

                  <div className="space-y-1">
                    <p className="text-sm font-semibold">
                      {phase === "starting"
                        ? t("sos.startingSession")
                        : downloading
                          ? t("sos.preparingDownload")
                          : connected
                            ? t("sos.waitingConnectedTitle")
                            : t("sos.waitingForTech")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("sos.waitingCanClose")}
                    </p>
                  </div>

                  {active && (
                    <Badge variant="outline" className="mt-1">
                      {statusLabel(String(active.status))}
                    </Badge>
                  )}
                </div>

                {downloadStarted && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
                    <p className="font-medium">{t("sos.downloadTriggered")}</p>
                    {fileName && (
                      <p className="mt-0.5 truncate font-mono text-xs opacity-80">
                        {fileName}
                      </p>
                    )}
                    <p className="mt-1 text-xs opacity-90">
                      {t("sos.runInstallerHint")}
                    </p>
                  </div>
                )}

                {error && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                )}

                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>{t("sos.waitingStep1")}</li>
                  <li>{t("sos.waitingStep2")}</li>
                  <li>{t("sos.waitingStep3")}</li>
                </ol>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  disabled={downloading || busy || !active?.id}
                  onClick={() =>
                    active?.id && void startInstallerDownload(active.id)
                  }
                >
                  {downloading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  {t("sos.downloadAgain")}
                </Button>
                <Button
                  type="button"
                  className="gap-1.5"
                  onClick={() => handleOpenChange(false)}
                >
                  {t("sos.returnToApp")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
