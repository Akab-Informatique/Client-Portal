import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Monitor,
  RefreshCw,
  Search,
  Wifi,
  WifiOff,
  AlertCircle,
  Laptop,
  Server,
} from "lucide-react";
import { useSelectedClient } from "@/context/SelectedClientContext";
import {
  fetchDattoRmmDevices,
  fetchDattoRmmStatus,
  formatDeviceLastSeen,
  type DattoRmmDevice,
} from "@/lib/datto-rmm";
import { WebRemoteButton } from "@/components/WebRemoteButton";
import { EmptyState } from "@/components/EmptyState";
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";
import { NumberTicker } from "@/components/ui/number-ticker";

function deviceIcon(d: DattoRmmDevice) {
  const t = `${d.deviceType || ""} ${d.deviceClass || ""} ${d.operatingSystem || ""}`.toLowerCase();
  if (t.includes("server")) return Server;
  return Laptop;
}

export function DevicesPage() {
  const { t, locale } = useLocale();
  const {
    selectedClient,
    clients,
    loading: clientsLoading,
  } = useSelectedClient();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DattoRmmDevice[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [offlineCount, setOfflineCount] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [rmmOk, setRmmOk] = useState<"unknown" | "ok" | "fail" | "off">(
    "unknown",
  );
  const [query, setQuery] = useState("");

  const siteUid = (selectedClient?.datto_rmm_site_uid || "").trim();
  const siteName =
    (selectedClient?.datto_rmm_site_name || "").trim() || siteUid || null;

  useEffect(() => {
    fetchDattoRmmStatus(false)
      .then((s) => {
        if (!s.configured) setRmmOk("off");
        else setRmmOk(s.ok ? "ok" : "fail");
        setConfigured(s.configured);
      })
      .catch(() => setRmmOk("fail"));
  }, []);

  const loadDevices = useCallback(async () => {
    if (!siteUid) {
      setDevices([]);
      setOnlineCount(0);
      setOfflineCount(0);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDattoRmmDevices(siteUid);
      setConfigured(res.configured);
      setDevices(res.devices);
      setOnlineCount(res.onlineCount);
      setOfflineCount(res.offlineCount);
      if (res.error) setError(res.error);
      if (!res.configured) setRmmOk("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("devices.loadFailed"));
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [siteUid, t]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) => {
      const hay = [
        d.hostname,
        d.operatingSystem,
        d.internalIp,
        d.externalIp,
        d.lastUser,
        d.deviceType,
        d.deviceClass,
        d.serialNumber,
        d.manufacturer,
        d.model,
        d.description,
        d.domain,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [devices, query]);

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">
                {t("devices.title")}
              </h2>
              {selectedClient && (
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-primary"
                >
                  {selectedClient.name}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("devices.subtitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("devices.usesSidebarClient")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                rmmOk === "ok" &&
                  "border-primary/40 bg-primary/10 text-primary",
                rmmOk === "off" && "text-muted-foreground",
                rmmOk === "fail" &&
                  "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {rmmOk === "ok"
                ? t("devices.rmmConnected")
                : rmmOk === "off"
                  ? t("devices.rmmOff")
                  : rmmOk === "fail"
                    ? t("devices.rmmFail")
                    : t("common.loading")}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={loading || !siteUid}
              onClick={() => void loadDevices()}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              {t("common.refresh")}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/clients">{t("devices.goToClients")}</Link>
            </Button>
          </div>
        </div>
      </BlurFade>

      <BlurFade delay={0.1}>
        {clientsLoading ? (
          <div className="h-64 animate-pulse rounded-2xl bg-muted" />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={<Monitor className="size-5" />}
            title={t("nav.noClients")}
            description={t("billing.noClientsDesc")}
            actionLabel={t("nav.clients")}
            onAction={() => {
              window.location.href = "/admin/clients";
            }}
          />
        ) : !selectedClient ? (
          <EmptyState
            icon={<Monitor className="size-5" />}
            title={t("devices.pickClient")}
            description={t("devices.pickClientSidebar")}
          />
        ) : !configured || rmmOk === "off" ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={<AlertCircle className="size-5" />}
                title={t("devices.notConfiguredTitle")}
                description={t("devices.notConfiguredDesc")}
                actionLabel={t("nav.settings")}
                onAction={() => {
                  window.location.href = "/admin/settings";
                }}
              />
            </CardContent>
          </Card>
        ) : !siteUid ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={<Monitor className="size-5" />}
                title={t("devices.noSiteTitle")}
                description={t("devices.noSiteDesc")}
                actionLabel={t("devices.linkSite")}
                onAction={() => {
                  window.location.href = "/admin/clients";
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>{t("devices.statTotal")}</CardDescription>
                  <CardTitle className="text-3xl tabular-nums">
                    <NumberTicker value={devices.length} />
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <Wifi className="size-3.5 text-emerald-600" />
                    {t("devices.statOnline")}
                  </CardDescription>
                  <CardTitle className="text-3xl tabular-nums text-emerald-700 dark:text-emerald-400">
                    <NumberTicker value={onlineCount} />
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <WifiOff className="size-3.5 text-muted-foreground" />
                    {t("devices.statOffline")}
                  </CardDescription>
                  <CardTitle className="text-3xl tabular-nums text-muted-foreground">
                    <NumberTicker value={offlineCount} />
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card className="border-border/80 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {t("devices.listTitle")}
                    </CardTitle>
                    <CardDescription>
                      {siteName
                        ? `${t("devices.siteLabel")} ${siteName}`
                        : t("devices.listDesc")}
                    </CardDescription>
                  </div>
                  <div className="relative w-full sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("devices.searchPh")}
                      className="h-9 pl-8"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {error && (
                  <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                )}
                {loading ? (
                  <div className="space-y-2 py-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-10 animate-pulse rounded-md bg-muted"
                      />
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="py-10">
                    <EmptyState
                      icon={<Monitor className="size-5" />}
                      title={
                        devices.length === 0
                          ? t("devices.emptyTitle")
                          : t("devices.noMatchTitle")
                      }
                      description={
                        devices.length === 0
                          ? t("devices.emptyDesc")
                          : t("devices.noMatchDesc")
                      }
                    />
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("devices.colDevice")}</TableHead>
                          <TableHead>{t("devices.colStatus")}</TableHead>
                          <TableHead className="hidden md:table-cell">
                            {t("devices.colOs")}
                          </TableHead>
                          <TableHead className="hidden lg:table-cell">
                            {t("devices.colIp")}
                          </TableHead>
                          <TableHead className="hidden xl:table-cell">
                            {t("devices.colUser")}
                          </TableHead>
                          <TableHead className="hidden sm:table-cell">
                            {t("devices.colLastSeen")}
                          </TableHead>
                          <TableHead className="text-right">
                            {t("devices.colActions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map((d) => {
                          const Icon = deviceIcon(d);
                          return (
                            <TableRow key={d.uid}>
                              <TableCell>
                                <div className="flex items-start gap-2.5">
                                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                                    <Icon className="size-4 text-foreground/80" />
                                  </span>
                                  <div className="min-w-0">
                                    <p className="truncate font-medium">
                                      {d.hostname}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {[d.deviceType, d.deviceClass, d.model]
                                        .filter(Boolean)
                                        .join(" · ") || d.uid.slice(0, 8)}
                                    </p>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                {d.online === true ? (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  >
                                    {t("devices.online")}
                                  </Badge>
                                ) : d.online === false ? (
                                  <Badge
                                    variant="outline"
                                    className="text-muted-foreground"
                                  >
                                    {t("devices.offline")}
                                  </Badge>
                                ) : (
                                  <Badge variant="outline">—</Badge>
                                )}
                                {d.rebootRequired ? (
                                  <Badge
                                    variant="outline"
                                    className="ml-1 border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                                  >
                                    {t("devices.reboot")}
                                  </Badge>
                                ) : null}
                              </TableCell>
                              <TableCell className="hidden max-w-[14rem] truncate text-sm text-muted-foreground md:table-cell">
                                {d.operatingSystem || "—"}
                              </TableCell>
                              <TableCell className="hidden font-mono text-xs lg:table-cell">
                                {d.internalIp || d.externalIp || "—"}
                              </TableCell>
                              <TableCell className="hidden max-w-[10rem] truncate text-sm xl:table-cell">
                                {d.lastUser || "—"}
                              </TableCell>
                              <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">
                                {formatDeviceLastSeen(d.lastSeen, locale)}
                              </TableCell>
                              <TableCell className="text-right">
                                <WebRemoteButton
                                  url={d.webRemoteUrl}
                                  online={d.online}
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </BlurFade>
    </div>
  );
}
