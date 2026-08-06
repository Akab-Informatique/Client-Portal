import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Download,
  Headphones,
  Loader2,
  RefreshCw,
  Siren,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  createSosRequest,
  fetchSosInstallerDownload,
  fetchSosPackageConfig,
  fetchSosRequestById,
  triggerSosDownload,
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

/**
 * Branded SOS download page.
 *
 * Creates a Default-channel session, then downloads the real session-bound
 * installer (.exe / .dmg) via /api/sos/download — never opens Splashtop's
 * HTML page (that page shows "App not available" when the SPA fails or the
 * session was closed).
 */
export function SosDownloadPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestIdParam = Number(params.get("id") || 0);

  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SosRequest | null>(null);
  const [packageName, setPackageName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const loadRequest = useCallback(async (id: number) => {
    const res = await fetchSosRequestById(id, "client");
    if (res.request) setRequest(res.request);
    if (res.error) setError(res.error);
    return res.request;
  }, []);

  // Bootstrap branding + existing request
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const cfg = await fetchSosPackageConfig();
        if (!cancelled) {
          setPackageName(cfg.packageName || t("sos.packageDefaultName"));
        }
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
  }, [loadRequest, requestIdParam, t, user?.company_id]);

  // Poll request status (client online / connected)
  useEffect(() => {
    if (!request?.id) return;
    if (["closed", "expired", "error"].includes(String(request.status))) return;
    const tmr = window.setInterval(() => {
      void loadRequest(request.id);
    }, 8000);
    return () => window.clearInterval(tmr);
  }, [loadRequest, request?.id, request?.status]);

  const runInstallerDownload = useCallback(
    async (requestId: number) => {
      if (!requestId) return false;
      setDownloading(true);
      setError(null);
      try {
        const res = await fetchSosInstallerDownload(requestId, "auto");
        if (!res.ok || !res.downloadUrl) {
          setError(res.error || t("sos.noLink"));
          return false;
        }
        setFileName(res.fileName);
        const ok = triggerSosDownload(res.downloadUrl);
        setDownloaded(true);
        if (!ok) setError(t("sos.openBlocked"));
        return ok;
      } catch (e) {
        setError(e instanceof Error ? e.message : t("sos.createFailed"));
        return false;
      } finally {
        setDownloading(false);
      }
    },
    [t],
  );

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
        navigate(`/client/sos?id=${res.request.id}`, { replace: true });
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

  // Landed without id → create session once
  useEffect(() => {
    if (loading) return;
    if (requestIdParam > 0) return;
    if (request) return;
    if (!user?.id) return;
    void ensureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, requestIdParam, user?.id]);

  // Auto-start real installer download once we have a live request
  useEffect(() => {
    if (loading || autoStarted.current) return;
    if (!request?.id) return;
    if (["closed", "expired", "error"].includes(String(request.status))) {
      setError(t("sos.sessionGone"));
      return;
    }
    autoStarted.current = true;
    const tmr = window.setTimeout(() => {
      void runInstallerDownload(request.id);
    }, 350);
    return () => window.clearTimeout(tmr);
  }, [loading, request, runInstallerDownload, t]);

  const statusLabel = (s: string) => {
    const key = `sos.status_${s}`;
    const translated = t(key);
    return translated === key ? s : translated;
  };

  const title = packageName || t("sos.packageDefaultName");
  const busy = loading || starting || downloading;

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
              {title}
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
              {busy && !downloaded && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {downloading
                    ? t("sos.fetchingInstaller")
                    : t("sos.preparingDownload")}
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

              {downloaded && !error && (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
                  {t("sos.downloadStarted")}
                  {fileName ? (
                    <span className="mt-1 block font-mono text-xs opacity-80">
                      {fileName}
                    </span>
                  ) : null}
                </p>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  className="gap-1.5 bg-red-600 text-white hover:bg-red-700"
                  disabled={busy || !request?.id}
                  onClick={() => {
                    if (request?.id) void runInstallerDownload(request.id);
                    else void ensureSession().then((r) => {
                      if (r?.id) void runInstallerDownload(r.id);
                    });
                  }}
                >
                  {downloading || starting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  {t("sos.downloadAgain")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  title={t("common.refresh")}
                  disabled={busy}
                  onClick={() => {
                    autoStarted.current = false;
                    if (request?.id) {
                      void loadRequest(request.id).then((r) => {
                        if (r?.id) void runInstallerDownload(r.id);
                      });
                    } else {
                      void ensureSession().then((r) => {
                        if (r?.id) void runInstallerDownload(r.id);
                      });
                    }
                  }}
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>

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
