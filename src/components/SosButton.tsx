import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
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
  fetchClientSosRequests,
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
 * Client header SOS control — creates a Default-channel session and sends
 * the user to /client/sos where the real session installer downloads.
 */
export function SosButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SosRequest | null>(null);
  const [companyName, setCompanyName] = useState("");

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

  if (!user || user.role !== "client") return null;

  const goDownloadPage = (id?: number | null) => {
    const q = id && id > 0 ? `?id=${id}` : "";
    navigate(`/client/sos${q}`);
    setOpen(false);
  };

  const startSos = async () => {
    if (!user.company_id) {
      setError(t("sos.noCompany"));
      return;
    }
    setBusy(true);
    setError(null);

    if (
      active &&
      ["open", "waiting", "ready", "connected"].includes(String(active.status))
    ) {
      goDownloadPage(active.id);
      setBusy(false);
      return;
    }

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
        goDownloadPage(res.request.id);
        if (res.error) setError(res.error);
      } else {
        setError(res.error || t("sos.createFailed"));
      }
    } catch (e) {
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
                  <Badge variant="outline">
                    {statusLabel(String(active.status))}
                  </Badge>
                </div>
                <div className="mt-2 space-y-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 bg-red-600 text-white hover:bg-red-700"
                    onClick={() => goDownloadPage(active.id)}
                  >
                    <ExternalLink className="size-3.5" />
                    {t("sos.openDownloadPage")}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t("sos.downloadPageHint")}
                  </p>
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
              {active ? t("sos.openOrReuse") : t("sos.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
