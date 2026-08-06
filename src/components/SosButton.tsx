import { useCallback, useEffect, useState } from "react";
import {
  Download,
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
  markSosAgentRunning,
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
 * Client header SOS — MeshCentral temporary agent.
 * Flow: Start SOS → open invite link → run agent → wait (no code/ID).
 */
export function SosButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
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
      setActive(res.requests[0] ?? null);
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

  const inviteUrl =
    active?.agentInviteUrl || active?.supportPortalLink || null;

  const openAgentLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const startSos = async () => {
    if (!user.company_id) {
      setError(t("sos.noCompany"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
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
        const link =
          res.request.agentInviteUrl || res.request.supportPortalLink;
        if (link) {
          openAgentLink(link);
          setInfo(t("sos.meshOpened"));
        }
      }
      if (res.error && !res.request?.supportPortalLink) {
        setError(res.error);
      } else if (res.error) {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sos.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onAgentRunning = async () => {
    if (!active?.id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await markSosAgentRunning(active.id);
      if (res.error) setError(res.error);
      else if (res.request) {
        setActive(res.request);
        setInfo(t("sos.meshWaitingTech"));
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
          setInfo(null);
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
            <DialogDescription>{t("sos.dialogDescMesh")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {active && (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t("sos.activeRequest")}</span>
                  <Badge variant="outline">
                    {statusLabel(String(active.status))}
                  </Badge>
                  <Badge variant="secondary">MeshCentral</Badge>
                </div>
                {inviteUrl && (
                  <Button
                    asChild
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto gap-1 px-0"
                  >
                    <a
                      href={inviteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="size-3.5" />
                      {t("sos.openAgentLink")}
                    </a>
                  </Button>
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
                rows={2}
                disabled={busy}
              />
            </div>

            {info && (
              <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                {info}
              </p>
            )}

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>{t("sos.meshStep1")}</li>
              <li>{t("sos.meshStep2")}</li>
              <li>{t("sos.meshStep3")}</li>
              <li>{t("sos.meshStep4")}</li>
            </ol>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {t("common.close")}
            </Button>
            {inviteUrl && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => openAgentLink(inviteUrl)}
                >
                  <ExternalLink className="size-4" />
                  {t("sos.openAgentLink")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => void onAgentRunning()}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {t("sos.iRanTheApp")}
                </Button>
              </>
            )}
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
              {active ? t("sos.restart") : t("sos.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
