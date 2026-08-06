import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Headphones,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Siren,
  XCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import {
  closeSosRequest,
  fetchStaffSosQueue,
  formatSosTime,
  type SosRequest,
} from "@/lib/sos";
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
import { EmptyState } from "@/components/EmptyState";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "ready" || status === "connected") return "default";
  if (status === "error" || status === "expired") return "destructive";
  if (status === "closed") return "secondary";
  return "outline";
}

export function SosQueuePage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<SosRequest[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchStaffSosQueue({ includeClosed });
      setRequests(res.requests);
      setOpenCount(res.openCount);
      setConfigured(res.configured);
      setConsoleUrl(res.connectUrl);
      if (res.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sos.queueLoadFailed"));
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [includeClosed, t]);

  useEffect(() => {
    void load();
    const tmr = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(tmr);
  }, [load]);

  const onConnect = (req: SosRequest) => {
    const url = req.connectUrl || consoleUrl;
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const onClose = async (req: SosRequest) => {
    setBusyId(req.id);
    try {
      await closeSosRequest(req.id, user?.id);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const statusLabel = (s: string) => {
    const key = `sos.status_${s}`;
    const translated = t(key);
    return translated === key ? s : translated;
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">
                {t("sos.queueTitle")}
              </h2>
              {openCount > 0 && (
                <Badge className="bg-red-600 text-white hover:bg-red-600">
                  {openCount}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("sos.queueDescMesh")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="sos-closed"
                checked={includeClosed}
                onCheckedChange={(v: boolean | "indeterminate") =>
                  setIncludeClosed(v === true)
                }
              />
              <Label
                htmlFor="sos-closed"
                className="text-xs text-muted-foreground"
              >
                {t("sos.showClosed")}
              </Label>
            </div>
            {consoleUrl && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1.5"
                asChild
              >
                <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
                  <MonitorSmartphone className="size-3.5" />
                  {t("sos.openMeshConsole")}
                </a>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("common.refresh")}
            </Button>
          </div>
        </div>
      </BlurFade>

      {!configured && (
        <BlurFade delay={0.05}>
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            {t("sos.notConfiguredMesh")}
          </p>
        </BlurFade>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Siren className="size-5 text-red-600" />
              {t("sos.incoming")}
            </CardTitle>
            <CardDescription>{t("sos.incomingHintMesh")}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading && requests.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : requests.length === 0 ? (
              <EmptyState
                icon={<Headphones className="size-5" />}
                title={t("sos.emptyTitle")}
                description={t("sos.emptyDescMesh")}
              />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("sos.colWhen")}</TableHead>
                      <TableHead>{t("sos.colClient")}</TableHead>
                      <TableHead>{t("sos.colUser")}</TableHead>
                      <TableHead>{t("sos.colIssue")}</TableHead>
                      <TableHead>{t("sos.colStatus")}</TableHead>
                      <TableHead className="text-right">
                        {t("billing.colActions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requests.map((req) => (
                      <TableRow key={req.id}>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {formatSosTime(req.createdAt)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {req.companyName}
                        </TableCell>
                        <TableCell>
                          <div className="min-w-0">
                            <p className="font-medium">{req.userName}</p>
                            <p className="text-xs text-muted-foreground">
                              {req.userEmail}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[14rem] truncate text-muted-foreground">
                          {req.issue || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(String(req.status))}>
                            {statusLabel(String(req.status))}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            {["open", "waiting", "ready", "connected"].includes(
                              String(req.status),
                            ) && (
                              <Button
                                type="button"
                                size="sm"
                                className="h-8 gap-1"
                                onClick={() => onConnect(req)}
                                title={t("sos.connectHintMesh")}
                              >
                                <MonitorSmartphone className="size-3.5" />
                                {t("sos.connect")}
                              </Button>
                            )}
                            {req.supportPortalLink && (
                              <Button
                                asChild
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1"
                              >
                                <a
                                  href={req.supportPortalLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <ExternalLink className="size-3.5" />
                                  <span className="hidden sm:inline">
                                    {t("sos.clientLink")}
                                  </span>
                                </a>
                              </Button>
                            )}
                            {[
                              "open",
                              "waiting",
                              "ready",
                              "connected",
                              "error",
                            ].includes(String(req.status)) && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1"
                                disabled={busyId === req.id}
                                onClick={() => void onClose(req)}
                              >
                                {busyId === req.id ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <XCircle className="size-3.5" />
                                )}
                                <span className="hidden sm:inline">
                                  {t("sos.closeRequest")}
                                </span>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
