import { useCallback, useEffect, useState } from "react";
import {
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
  attachSosCode,
  createSosRequest,
  DEFAULT_CLASSIC_SOS_URL,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Client header SOS control.
 *
 * - With Splashtop Open API: creates attended session + support portal link
 * - Without API: opens classic sos.splashtop.com and lets client paste the code
 *   so technicians can Connect from /admin/sos
 */
export function SosButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [sosCode, setSosCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [active, setActive] = useState<SosRequest | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [mode, setMode] = useState<"api" | "manual" | "unknown">("unknown");
  const [classicUrl, setClassicUrl] = useState(DEFAULT_CLASSIC_SOS_URL);

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
      if (first?.mode === "manual" || (!res.configured && first)) {
        setMode("manual");
      } else if (res.configured) {
        setMode("api");
      } else {
        setMode("manual");
      }
      if (first?.classicSosUrl) setClassicUrl(first.classicSosUrl);
      if (first?.sosCode && !sosCode) setSosCode(String(first.sosCode));
    } catch {
      /* ignore */
    }
  }, [user?.id, sosCode]);

  useEffect(() => {
    if (!open) return;
    void refreshActive();
    const tmr = window.setInterval(() => void refreshActive(), 8000);
    return () => window.clearInterval(tmr);
  }, [open, refreshActive]);

  if (!user || user.role !== "client") return null;

  const isManual =
    mode === "manual" ||
    active?.mode === "manual" ||
    (!active && mode !== "api");

  const openClassicSos = () => {
    window.open(classicUrl || DEFAULT_CLASSIC_SOS_URL, "_blank", "noopener,noreferrer");
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
      const code = sosCode.trim().replace(/\s+/g, "");
      const res = await createSosRequest({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        companyId: user.company_id,
        companyName: companyName || t("common.company"),
        issue: issue.trim() || null,
        sosCode: code || null,
      });
      if (res.classicSosUrl) setClassicUrl(res.classicSosUrl);
      if (res.mode === "manual" || res.configured === false) setMode("manual");
      else if (res.mode === "api" || res.configured) setMode("api");

      if (res.request) {
        setActive(res.request);
        // API mode: open the personalized support portal link
        if (res.request.supportPortalLink && res.mode !== "manual") {
          window.open(
            res.request.supportPortalLink,
            "_blank",
            "noopener,noreferrer",
          );
        } else if (res.mode === "manual" || res.needsCode) {
          // Manual: open classic SOS so client can get a code
          openClassicSos();
          if (!code) {
            setInfo(t("sos.manualNeedCode"));
          } else {
            setInfo(t("sos.manualCodeSent"));
          }
        }
      }
      if (res.warning) setInfo(res.warning);
      if (res.error && !res.request) {
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

  const submitCode = async () => {
    const code = sosCode.trim().replace(/\s+/g, "");
    if (!/^\d{6,12}$/.test(code)) {
      setError(t("sos.invalidCode"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (active?.id) {
        const res = await attachSosCode(active.id, code);
        if (res.error) {
          setError(res.error);
        } else if (res.request) {
          setActive(res.request);
          setInfo(t("sos.manualCodeSent"));
        }
      } else {
        // No active request yet — create with code in one step
        await startSos();
        return;
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
            <DialogDescription>
              {isManual ? t("sos.dialogDescManual") : t("sos.dialogDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {active && (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t("sos.activeRequest")}</span>
                  <Badge variant="outline">
                    {statusLabel(String(active.status))}
                  </Badge>
                  {active.mode === "manual" && (
                    <Badge variant="secondary">{t("sos.modeManual")}</Badge>
                  )}
                </div>
                {active.sosCode && (
                  <p className="mt-1 font-mono text-sm tabular-nums">
                    {t("sos.yourCode")}:{" "}
                    <span className="font-semibold tracking-wider">
                      {active.sosCode}
                    </span>
                  </p>
                )}
                {active.supportPortalLink && (
                  <Button
                    asChild
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto gap-1 px-0"
                  >
                    <a
                      href={active.supportPortalLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="size-3.5" />
                      {isManual
                        ? t("sos.openClassicSos")
                        : t("sos.openClientLink")}
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

            {/* Manual code entry — always available as backup; required without API */}
            {(isManual ||
              active?.mode === "manual" ||
              (active && !active.supportPortalLink)) && (
              <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                <Label htmlFor="sos-code">{t("sos.codeLabel")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="sos-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={t("sos.codePlaceholder")}
                    value={sosCode}
                    onChange={(e) =>
                      setSosCode(e.target.value.replace(/[^\d\s]/g, ""))
                    }
                    disabled={busy}
                    className="font-mono tracking-widest"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void submitCode()}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    <span className="ml-1.5">{t("sos.submitCode")}</span>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("sos.codeHelp")}
                </p>
              </div>
            )}

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
              {isManual ? (
                <>
                  <li>{t("sos.manualStep1")}</li>
                  <li>{t("sos.manualStep2")}</li>
                  <li>{t("sos.manualStep3")}</li>
                  <li>{t("sos.manualStep4")}</li>
                </>
              ) : (
                <>
                  <li>{t("sos.step1")}</li>
                  <li>{t("sos.step2")}</li>
                  <li>{t("sos.step3")}</li>
                </>
              )}
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
            {isManual && (
              <Button
                type="button"
                variant="secondary"
                className="gap-1.5"
                disabled={busy}
                onClick={openClassicSos}
              >
                <ExternalLink className="size-4" />
                {t("sos.openClassicSos")}
              </Button>
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
              {active
                ? isManual
                  ? t("sos.notifyAgain")
                  : t("sos.restart")
                : t("sos.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
