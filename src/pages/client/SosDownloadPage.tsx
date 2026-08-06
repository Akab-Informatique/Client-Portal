import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Apple,
  Check,
  Copy,
  Download,
  ExternalLink,
  Headphones,
  Loader2,
  Monitor,
  RefreshCw,
  Siren,
  Smartphone,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  createSosRequest,
  detectClientOs,
  ensureClientPortalHref,
  fetchSosPackageConfig,
  fetchSosRequestById,
  pickSosDownloadUrl,
  triggerSosDownload,
  type SosPackageConfig,
  type SosRequest,
} from "@/lib/sos";
import { BrandLogo } from "@/components/BrandLogo";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Branded in-portal SOS download page.
 *
 * Flow:
 *  1. Create / load SOS session (API)
 *  2. Auto-start download (session portal link and/or custom package URL)
 *  3. Client runs the app — no code to share
 */
export function SosDownloadPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestIdParam = Number(params.get("id") || 0);

  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SosRequest | null>(null);
  const [pkg, setPkg] = useState<SosPackageConfig | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const autoStarted = useRef(false);

  const portalHref = useMemo(
    () => ensureClientPortalHref(request?.supportPortalLink),
    [request?.supportPortalLink],
  );

  const os = detectClientOs();

  const primaryUrl = useMemo(
    () =>
      pickSosDownloadUrl({
        supportPortalLink: request?.supportPortalLink,
        packageConfig: pkg,
      }),
    [request?.supportPortalLink, pkg],
  );

  const loadPackage = useCallback(async () => {
    const cfg = await fetchSosPackageConfig();
    setPkg(cfg);
    return cfg;
  }, []);

  const loadRequest = useCallback(
    async (id: number) => {
      const res = await fetchSosRequestById(id, "client");
      if (res.request) setRequest(res.request);
      if (res.error) setError(res.error);
      return res.request;
    },
    [],
  );

  // Bootstrap: package config + existing request id
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadPackage();
        if (user?.company_id) {
          try {
            await dbReady;
            const rows = await db
              .select()
              .from(schema.companies)
              .where(eq(schema.companies.id, user.company_id))
              .limit(1);
            if (!cancelled && rows[0]) {
              setCompanyName(String(rows[0].name ?? ""));
            }
          } catch {
            /* optional */
          }
        }
        if (requestIdParam > 0) {
          await loadRequest(requestIdParam);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : t("sos.createFailed"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPackage, loadRequest, requestIdParam, t, user?.company_id]);

  // Poll active request status
  useEffect(() => {
    if (!request?.id) return;
    if (["closed", "expired", "error"].includes(String(request.status))) return;
    const tmr = window.setInterval(() => {
      void loadRequest(request.id);
    }, 8000);
    return () => window.clearInterval(tmr);
  }, [loadRequest, request?.id, request?.status]);

  const startDownload = useCallback(
    (url?: string | null) => {
      const href = url || primaryUrl;
      if (!href) {
        setError(t("sos.noLink"));
        return false;
      }
      const ok = triggerSosDownload(href);
      setDownloaded(true);
      if (!ok) setError(t("sos.openBlocked"));
      return ok;
    },
    [primaryUrl, t],
  );

  // Auto-start once we have a URL
  useEffect(() => {
    if (loading || autoStarted.current) return;
    if (!primaryUrl) return;
    if (pkg && pkg.autoDownload === false) return;
    autoStarted.current = true;
    // Short delay so the branded UI paints first
    const tmr = window.setTimeout(() => {
      startDownload(primaryUrl);
    }, 400);
    return () => window.clearTimeout(tmr);
  }, [loading, primaryUrl, pkg, startDownload]);

  const ensureSession = async () => {
    if (!user?.id || !user.company_id) {
      setError(t("sos.noCompany"));
      return null;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await createSosRequest({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        companyId: user.company_id,
        companyName: companyName || t("common.company"),
        issue: null,
      });
      if (res.request) {
        setRequest(res.request);
        // Keep id in URL for refresh / reopen
        navigate(`/client/sos?id=${res.request.id}`, { replace: true });
        const href = ensureClientPortalHref(res.request.supportPortalLink);
        if (href) {
          autoStarted.current = true;
          window.setTimeout(() => startDownload(href), 200);
        } else if (!res.error) {
          setError(t("sos.noLink"));
        }
        if (res.error) setError(res.error);
        return res.request;
      }
      setError(res.error || t("sos.createFailed"));
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sos.createFailed"));
      return null;
    } finally {
      setStarting(false);
    }
  };

  // If landed without id, create session once
  useEffect(() => {
    if (loading) return;
    if (requestIdParam > 0) return;
    if (request) return;
    if (!user?.id) return;
    void ensureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, requestIdParam, user?.id]);

  const copyLink = async () => {
    if (!primaryUrl) return;
    try {
      await navigator.clipboard.writeText(primaryUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("sos.copyFailed"));
    }
  };

  const statusLabel = (s: string) => {
    const key = `sos.status_${s}`;
    const translated = t(key);
    return translated === key ? s : translated;
  };

  const packageName = pkg?.packageName || t("sos.packageDefaultName");

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-red-500/10 via-background to-background"
      />
      <div className="relative mx-auto flex max-w-lg flex-col gap-6 px-4 py-8 sm:py-12">
        <BlurFade delay={0.04}>
          <div className="flex flex-col items-center text-center">
            <BrandLogo size="lg" className="mb-4" />
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-red-600 text-white shadow-lg shadow-red-600/30">
                <Siren className="size-5" />
              </span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {packageName}
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {t("sos.downloadPageDesc")}
            </p>
          </div>
        </BlurFade>

        <BlurFade delay={0.08}>
          <Card className="border-border/80 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="size-4 text-red-600" />
                {t("sos.downloadTitle")}
              </CardTitle>
              <CardDescription>{t("sos.downloadSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(loading || starting) && !request && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("sos.preparingDownload")}
                </div>
              )}

              {request && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                  <Headphones className="size-4 text-muted-foreground" />
                  <span className="font-medium">{t("sos.activeRequest")}</span>
                  <Badge variant="outline">
                    {statusLabel(String(request.status))}
                  </Badge>
                  {downloaded && (
                    <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                      {t("sos.downloadTriggered")}
                    </Badge>
                  )}
                </div>
              )}

              {error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  type="button"
                  className="gap-1.5 bg-red-600 text-white hover:bg-red-700"
                  disabled={!primaryUrl || starting}
                  onClick={() => startDownload(primaryUrl)}
                >
                  {starting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  {t("sos.downloadAgain")}
                </Button>
                {portalHref && portalHref !== primaryUrl && (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => startDownload(portalHref)}
                  >
                    <ExternalLink className="size-4" />
                    {t("sos.openSessionLink")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  disabled={!primaryUrl}
                  onClick={() => void copyLink()}
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? t("sos.copied") : t("sos.copyLink")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  title={t("common.refresh")}
                  onClick={() => {
                    if (request?.id) void loadRequest(request.id);
                    else void ensureSession();
                  }}
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>

              {/* OS-specific custom package buttons */}
              {pkg?.hasCustomPackage && (
                <div className="space-y-2 border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("sos.directPackageTitle")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {pkg.packageUrls.windows && (
                      <Button
                        type="button"
                        size="sm"
                        variant={os === "windows" ? "default" : "outline"}
                        className={cn(
                          "gap-1.5",
                          os === "windows" && "bg-red-600 hover:bg-red-700",
                        )}
                        onClick={() => startDownload(pkg.packageUrls.windows)}
                      >
                        <Monitor className="size-3.5" />
                        Windows
                      </Button>
                    )}
                    {pkg.packageUrls.mac && (
                      <Button
                        type="button"
                        size="sm"
                        variant={os === "mac" ? "default" : "outline"}
                        className={cn(
                          "gap-1.5",
                          os === "mac" && "bg-red-600 hover:bg-red-700",
                        )}
                        onClick={() => startDownload(pkg.packageUrls.mac)}
                      >
                        <Apple className="size-3.5" />
                        Mac
                      </Button>
                    )}
                    {pkg.packageUrls.linux && (
                      <Button
                        type="button"
                        size="sm"
                        variant={os === "linux" ? "default" : "outline"}
                        className="gap-1.5"
                        onClick={() => startDownload(pkg.packageUrls.linux)}
                      >
                        <Monitor className="size-3.5" />
                        Linux
                      </Button>
                    )}
                    {pkg.packageUrls.android && (
                      <Button
                        type="button"
                        size="sm"
                        variant={os === "android" ? "default" : "outline"}
                        className="gap-1.5"
                        onClick={() => startDownload(pkg.packageUrls.android)}
                      >
                        <Smartphone className="size-3.5" />
                        Android
                      </Button>
                    )}
                    {pkg.packageUrls.share && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => startDownload(pkg.packageUrls.share)}
                      >
                        <ExternalLink className="size-3.5" />
                        {t("sos.packageShareLink")}
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t("sos.directPackageHint")}
                  </p>
                </div>
              )}

              {primaryUrl && (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {primaryUrl}
                </p>
              )}

              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>{t("sos.downloadStep1")}</li>
                <li>{t("sos.downloadStep2")}</li>
                <li>{t("sos.downloadStep3")}</li>
              </ol>
            </CardContent>
          </Card>
        </BlurFade>

        <BlurFade delay={0.12}>
          <p className="text-center text-xs text-muted-foreground">
            <Link to="/client" className="underline-offset-2 hover:underline">
              {t("sos.backToPortal")}
            </Link>
          </p>
        </BlurFade>
      </div>
    </div>
  );
}
